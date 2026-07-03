package ai.byteask.jetbrains.appServer

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/**
 * Kotlin port of vscode-byteask's src/appServer/client.ts -- the typed
 * convenience wrapper over the raw RPC channel, minus the fully-typed
 * generated bindings (see ByteAskAppServerRpc's doc comment for why Gson
 * JsonObjects stand in for those here).
 */
class ByteAskAppServerClient private constructor(val rpc: ByteAskAppServerRpc) {

    companion object {
        /**
         * Java's `ProcessBuilder` (which `GeneralCommandLine`/
         * `OSProcessHandler` wrap) throws synchronously on ENOENT -- unlike
         * Node's async 'error' event, which was the actual crash bug fixed
         * in vscode-byteask (see rpc.ts's history). That means the
         * "not installed" case here surfaces as a thrown IOException from
         * the constructor, not a rejected Promise -- callers must wrap
         * `connect()` in try/catch, which ChatToolWindowFactory does.
         */
        fun isCliNotFoundError(err: Throwable): Boolean {
            if (err is IOException) {
                val msg = err.message ?: return false
                // Java's IOException for a missing executable: "Cannot run
                // program \"byteask\": error=2, No such file or directory"
                return msg.contains("error=2") || msg.contains("No such file or directory") || msg.contains("cannot find the file", ignoreCase = true)
            }
            return false
        }

        /** Same "byteask app-server refuses to start when nobody's logged
         * in" detection as vscode-byteask's client.ts, verified live against
         * the real binary: it prints "You're not signed in to ByteAsk. Run:
         * byteask login ..." to stderr and exits before any handshake. */
        fun isNotLoggedInError(err: Throwable): Boolean {
            val msg = err.message ?: return false
            return Regex("not signed in|byteask login", RegexOption.IGNORE_CASE).containsMatchIn(msg)
        }

        /**
         * @throws IOException if the binary doesn't exist (check with
         *   isCliNotFoundError)
         * @throws java.util.concurrent.ExecutionException wrapping the real
         *   cause if the handshake fails/times out (check with
         *   isNotLoggedInError on the cause)
         */
        fun connect(command: String, cwd: String?): ByteAskAppServerClient {
            val rpc = ByteAskAppServerRpc(command, cwd) // throws IOException synchronously on ENOENT
            val client = ByteAskAppServerClient(rpc)
            val initParams = JsonObject().apply {
                add("clientInfo", JsonObject().apply {
                    addProperty("name", "byteask-jetbrains")
                    addProperty("title", "ByteAsk")
                    addProperty("version", "0.1.0")
                })
                add("capabilities", JsonObject().apply {
                    addProperty("experimentalApi", true)
                    addProperty("requestAttestation", false)
                })
            }
            try {
                rpc.request("initialize", initParams).get(10, TimeUnit.SECONDS)
            } catch (e: TimeoutException) {
                rpc.dispose()
                throw Exception("Timed out waiting for byteask app-server to respond to initialize.", e)
            } catch (e: Exception) {
                rpc.dispose()
                throw e
            }
            return client
        }
    }

    fun threadStart(params: JsonObject): CompletableFuture<JsonElement> = rpc.request("thread/start", params)
    fun threadResume(params: JsonObject): CompletableFuture<JsonElement> = rpc.request("thread/resume", params)
    fun threadList(params: JsonObject): CompletableFuture<JsonElement> = rpc.request("thread/list", params)
    fun modelList(params: JsonObject): CompletableFuture<JsonElement> = rpc.request("model/list", params)
    fun turnStart(params: JsonObject): CompletableFuture<JsonElement> = rpc.request("turn/start", params)
    fun turnInterrupt(params: JsonObject): CompletableFuture<JsonElement> = rpc.request("turn/interrupt", params)
    fun getAccountUsage(): CompletableFuture<JsonElement> = rpc.request("account/usage/read", null)
    fun getAccountRateLimits(): CompletableFuture<JsonElement> = rpc.request("account/rateLimits/read", null)
    fun skillsList(params: JsonObject): CompletableFuture<JsonElement> = rpc.request("skills/list", params)

    fun setStderrHandler(cb: (String) -> Unit) = rpc.setStderrHandler(cb)

    fun dispose() = rpc.dispose()
}
