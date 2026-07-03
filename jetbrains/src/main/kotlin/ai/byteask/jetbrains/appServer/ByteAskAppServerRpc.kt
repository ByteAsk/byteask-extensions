package ai.byteask.jetbrains.appServer

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessListener
import com.intellij.execution.process.ProcessOutputTypes
import com.intellij.openapi.util.Key
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Kotlin port of vscode-byteask's src/appServer/rpc.ts -- same wire format
 * (newline-delimited JSON, both directions), same envelope disambiguation
 * rules, and critically the SAME crash-fix lesson learned there: a spawned
 * process's failure-to-start must be handled explicitly (Java's
 * ProcessBuilder throws synchronously on ENOENT rather than emitting an
 * unhandled async event the way Node's does, so the equivalent bug doesn't
 * reproduce here the same way -- but the "reject cleanly, don't hang" and
 * "surface real stderr, not just exit code" lessons still apply and are
 * carried over below).
 *
 * Uses Gson (bundled with the IntelliJ Platform, not a separate dependency)
 * for lightweight, dynamically-typed JSON handling rather than hand-porting
 * every one of vscode-byteask's generated TypeScript wire types into Kotlin
 * data classes -- the webview side (chat.js, unmodified) already expects
 * specific JSON shapes matching the wire format 1:1, so this layer mostly
 * needs to shuttle JsonObjects around, not deeply model them.
 */
class ByteAskAppServerRpc(command: String, cwd: String?) {

    class RpcException(val code: Int, message: String) : Exception(message)

    private val nextId = AtomicInteger(1)
    private val pending = ConcurrentHashMap<Int, CompletableFuture<JsonElement>>()
    private val notificationHandlers = ConcurrentHashMap<String, MutableList<(JsonElement) -> Unit>>()
    private val serverRequestHandlers = ConcurrentHashMap<String, (JsonElement) -> CompletableFuture<JsonElement>>()
    private var onStderrLine: ((String) -> Unit)? = null
    @Volatile private var disposed = false
    @Volatile private var writer: OutputStreamWriter? = null
    private val stderrBuffer = ArrayDeque<String>()

    private val handler: OSProcessHandler

    init {
        val commandLine = GeneralCommandLine(command).withParameters("app-server")
        if (cwd != null) commandLine.withWorkDirectory(cwd)
        handler = OSProcessHandler(commandLine)
        writer = OutputStreamWriter(handler.process.outputStream, StandardCharsets.UTF_8)

        val stdoutReader = BufferedReader(InputStreamReader(handler.process.inputStream, StandardCharsets.UTF_8))
        Thread({
            try {
                var line: String?
                while (stdoutReader.readLine().also { line = it } != null) {
                    handleLine(line!!)
                }
            } catch (_: Exception) {
                // stream closed on process exit; handled by processTerminated below
            }
        }, "byteask-appserver-stdout-reader").apply { isDaemon = true; start() }

        handler.addProcessListener(object : ProcessListener {
            override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
                if (outputType == ProcessOutputTypes.STDERR) {
                    for (line in event.text.split("\n")) {
                        if (line.isNotBlank()) {
                            synchronized(stderrBuffer) {
                                stderrBuffer.addLast(line)
                                if (stderrBuffer.size > 20) stderrBuffer.removeFirst()
                            }
                            onStderrLine?.invoke(line)
                        }
                    }
                }
            }

            override fun processTerminated(event: ProcessEvent) {
                disposed = true
                val detail = synchronized(stderrBuffer) { stderrBuffer.joinToString(" ") }
                val message = if (detail.isNotBlank()) {
                    "byteask app-server exited (code ${event.exitCode}): $detail"
                } else {
                    "byteask app-server exited (code ${event.exitCode})"
                }
                val err = Exception(message)
                pending.values.forEach { it.completeExceptionally(err) }
                pending.clear()
            }
        })
        handler.startNotify()
    }

    fun setStderrHandler(cb: (String) -> Unit) {
        onStderrLine = cb
    }

    private fun handleLine(line: String) {
        if (line.isBlank()) return
        val msg = try {
            JsonParser.parseString(line).asJsonObject
        } catch (_: Exception) {
            return // not JSON -- shouldn't happen on stdout
        }
        val hasId = msg.has("id")
        val hasMethod = msg.has("method")

        // Response to one of our own requests: id, no method.
        if (hasId && !hasMethod) {
            val id = msg.get("id").asInt
            val future = pending.remove(id) ?: return
            if (msg.has("error")) {
                val err = msg.getAsJsonObject("error")
                future.completeExceptionally(
                    RpcException(err.get("code").asInt, err.get("message").asString)
                )
            } else {
                future.complete(msg.get("result") ?: JsonObject())
            }
            return
        }

        // Notification: method, no id.
        if (hasMethod && !hasId) {
            val method = msg.get("method").asString
            val params = msg.get("params") ?: JsonObject()
            notificationHandlers[method]?.forEach { it(params) }
            return
        }

        // Server->client request: method + id, needs a reply.
        if (hasMethod && hasId) {
            val method = msg.get("method").asString
            val id = msg.get("id")
            val params = msg.get("params") ?: JsonObject()
            val h = serverRequestHandlers[method]
            if (h == null) {
                writeRaw(JsonObject().apply {
                    add("id", id)
                    add("error", JsonObject().apply { addProperty("code", -32601); addProperty("message", "No handler for $method") })
                })
                return
            }
            // Handlers are async (CompletableFuture) -- approvals and the
            // multi-choice question tool wait on real user interaction in
            // the webview, they cannot resolve synchronously the way a
            // plain function-call handler would assume.
            h(params).whenComplete { result, err ->
                if (err != null) {
                    writeRaw(JsonObject().apply {
                        add("id", id)
                        add("error", JsonObject().apply { addProperty("code", -32000); addProperty("message", err.message ?: err.toString()) })
                    })
                } else {
                    writeRaw(JsonObject().apply { add("id", id); add("result", result) })
                }
            }
        }
    }

    @Synchronized
    private fun writeRaw(envelope: JsonObject) {
        if (disposed) return
        val w = writer ?: return
        w.write(envelope.toString())
        w.write("\n")
        w.flush()
    }

    fun request(method: String, params: JsonElement?): CompletableFuture<JsonElement> {
        if (disposed) {
            val detail = synchronized(stderrBuffer) { stderrBuffer.joinToString(" ") }
            val future = CompletableFuture<JsonElement>()
            future.completeExceptionally(
                Exception(if (detail.isNotBlank()) "byteask app-server is not running: $detail" else "byteask app-server is not running")
            )
            return future
        }
        val id = nextId.getAndIncrement()
        val future = CompletableFuture<JsonElement>()
        pending[id] = future
        writeRaw(JsonObject().apply {
            addProperty("method", method)
            addProperty("id", id)
            if (params != null) add("params", params) else add("params", JsonObject())
        })
        return future
    }

    fun onNotification(method: String, handler: (JsonElement) -> Unit) {
        notificationHandlers.getOrPut(method) { mutableListOf() }.add(handler)
    }

    fun onServerRequest(method: String, handler: (JsonElement) -> CompletableFuture<JsonElement>) {
        serverRequestHandlers[method] = handler
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        handler.destroyProcess()
    }
}
