package ai.byteask.jetbrains.chat

import ai.byteask.jetbrains.appServer.ByteAskAppServerClient
import ai.byteask.jetbrains.settings.ByteAskSettings
import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Kotlin port of vscode-byteask's chatViewProvider.ts orchestration logic --
 * owns the AppServerClient connection and thread/turn state, wires RPC
 * notifications into webview `postMessage`-shaped JSON (sent on to
 * `postToWebview`, which ByteAskChatToolWindowFactory wires to the real
 * JCEF browser), and handles the webview->host message contract
 * (sendMessage, approvalDecision, userInputAnswer, retryConnect, etc.).
 *
 * `postToWebview` is a callback rather than a direct browser reference so
 * this class has no JCEF/Swing dependency and can be unit-tested or reused
 * independent of the tool window.
 */
class ByteAskChatBridge(
    private val project: Project,
    private val postToWebview: (JsonObject) -> Unit,
) {
    private val log = Logger.getInstance(ByteAskChatBridge::class.java)

    private var client: ByteAskAppServerClient? = null
    private var threadId: String? = null
    private var currentTurnId: String? = null
    private var turnInProgress = false

    private val pendingApprovals = ConcurrentHashMap<Int, (String) -> Unit>()
    private val pendingUserInputs = ConcurrentHashMap<Int, (JsonObject) -> Unit>()
    private var nextApprovalId = AtomicInteger(1)
    private var nextUserInputId = AtomicInteger(1)

    private fun post(type: String, build: JsonObject.() -> Unit = {}) {
        val obj = JsonObject()
        obj.addProperty("type", type)
        obj.build()
        postToWebview(obj)
    }

    private fun settings() = ByteAskSettings.getInstance(project)
    private fun workspaceCwd(): String? = project.basePath

    private val cachedItems = ConcurrentHashMap<String, JsonObject>()

    private fun ensureClient(): ByteAskAppServerClient {
        client?.let { return it }
        val command = settings().command
        val c = ByteAskAppServerClient.connect(command, workspaceCwd())
        c.setStderrHandler { line -> log.info("[app-server] $line") }
        wireCallbacks(c)
        client = c
        return c
    }

    /** Kotlin equivalent of vscode-byteask's ensureClient() AppServerClient
     * callback wiring -- translates raw JSON-RPC notifications/server
     * requests into the onXxx()/approval methods below. */
    private fun wireCallbacks(c: ByteAskAppServerClient) {
        c.rpc.onNotification("item/started") { p ->
            val item = p.asJsonObject.getAsJsonObject("item")
            cachedItems[item.get("id").asString] = item
            onItemStarted(item)
        }
        c.rpc.onNotification("item/completed") { p ->
            val item = p.asJsonObject.getAsJsonObject("item")
            cachedItems[item.get("id").asString] = item
            onItemCompleted(item)
        }
        c.rpc.onNotification("item/agentMessage/delta") { p ->
            val o = p.asJsonObject
            onAgentMessageDelta(o.get("itemId").asString, o.get("delta").asString)
        }
        c.rpc.onNotification("item/reasoning/textDelta") { p ->
            val o = p.asJsonObject
            onReasoningTextDelta(o.get("itemId").asString, o.get("delta").asString)
        }
        c.rpc.onNotification("turn/started") { p ->
            onTurnStarted(p.asJsonObject.getAsJsonObject("turn").get("id").asString)
        }
        c.rpc.onNotification("turn/completed") { p ->
            onTurnCompleted(p.asJsonObject.getAsJsonObject("turn").get("status").asString)
        }
        c.rpc.onNotification("error") { p ->
            onErrorNotification(p.asJsonObject.getAsJsonObject("error").get("message").asString)
        }

        c.rpc.onServerRequest("item/fileChange/requestApproval") { p ->
            val itemId = p.asJsonObject.get("itemId").asString
            onFileChangeApprovalRequest(itemId, buildFileChangeDiffText(itemId), buildFileChangeSummary(itemId))
                .thenApply { decision -> JsonObject().apply { addProperty("decision", decision) } }
        }
        c.rpc.onServerRequest("item/commandExecution/requestApproval") { p ->
            val o = p.asJsonObject
            val command = o.get("command")?.takeIf { !it.isJsonNull }?.asString
            val cwd = o.get("cwd")?.takeIf { !it.isJsonNull }?.asString
            onCommandExecutionApprovalRequest(command, cwd)
                .thenApply { decision -> JsonObject().apply { addProperty("decision", decision) } }
        }
        c.rpc.onServerRequest("item/tool/requestUserInput") { p ->
            val questions = p.asJsonObject.getAsJsonArray("questions")
            onToolRequestUserInput(questions).thenApply { it as com.google.gson.JsonElement }
        }
    }

    private fun buildFileChangeDiffText(itemId: String): String {
        val item = cachedItems[itemId] ?: return "(diff not available)"
        if (item.get("type")?.asString != "fileChange") return "(diff not available)"
        return item.getAsJsonArray("changes").joinToString("\n\n") { c ->
            val co = c.asJsonObject
            val path = co.get("path").asString
            "--- $path\n+++ $path\n${co.get("diff")?.asString ?: ""}"
        }
    }

    private fun buildFileChangeSummary(itemId: String): String {
        val item = cachedItems[itemId] ?: return "Proposed file change"
        if (item.get("type")?.asString != "fileChange") return "Proposed file change"
        return item.getAsJsonArray("changes").joinToString(", ") { c ->
            val co = c.asJsonObject
            val kind = co.getAsJsonObject("kind")?.get("type")?.asString ?: "change"
            val name = File(co.get("path").asString).name
            "$kind $name"
        }
    }

    /**
     * Every call site that talks to app-server funnels its failure through
     * here, same reasoning as vscode-byteask's reportUnreachable(): "the CLI
     * isn't installed" and "nobody's logged in" always get the same
     * dedicated onboarding card, not N different raw error strings.
     */
    private fun reportUnreachable(err: Throwable, context: String) {
        val cause = if (err is java.util.concurrent.ExecutionException) err.cause ?: err else err
        when {
            ByteAskAppServerClient.isCliNotFoundError(cause) -> post("cliNotFound")
            ByteAskAppServerClient.isNotLoggedInError(cause) -> post("notLoggedIn")
            else -> post("error") { addProperty("message", "$context: ${cause.message}") }
        }
    }

    /** Silent for startup auto-resume UNLESS it's one of the two onboarding
     * cases, matching vscode-byteask's autoResumeLatest() reasoning: a
     * first-time (or logged-out) user needs to see that card proactively,
     * not just a quietly-logged line. */
    fun autoResumeLatest() {
        try {
            val c = ensureClient()
            val params = JsonObject().apply {
                addProperty("cwd", workspaceCwd())
                addProperty("sortKey", "updated_at")
                addProperty("sortDirection", "desc")
                addProperty("limit", 1)
                addProperty("archived", false)
                add("sourceKinds", JsonArray().apply { listOf("cli", "vscode", "exec", "appServer").forEach { add(it) } })
            }
            c.threadList(params).whenComplete { result, err ->
                if (err != null) {
                    handleStartupError(err)
                    return@whenComplete
                }
                val data = result.asJsonObject.getAsJsonArray("data")
                if (data.size() > 0) {
                    val id = data[0].asJsonObject.get("id").asString
                    resumeThreadById(id)
                }
            }
        } catch (err: Exception) {
            handleStartupError(err)
        }
    }

    private fun handleStartupError(err: Throwable) {
        val cause = if (err is java.util.concurrent.ExecutionException) err.cause ?: err else err
        when {
            ByteAskAppServerClient.isCliNotFoundError(cause) -> post("cliNotFound")
            ByteAskAppServerClient.isNotLoggedInError(cause) -> post("notLoggedIn")
            else -> log.info("[chat] auto-resume skipped: ${cause.message}")
        }
    }

    fun installCli() {
        // Handled entirely by the caller (ByteAskChatToolWindowFactory opens
        // a terminal) -- kept as a no-op entry point here for symmetry with
        // the webview message contract; see handleWebviewMessage().
    }

    fun retryConnect(openTerminal: () -> Unit, onCliInstall: (() -> Unit)? = null) {
        client = null
        try {
            ensureClient()
            post("connected")
            autoResumeLatest()
        } catch (err: Exception) {
            reportUnreachable(err, "Still could not reach byteask")
        }
    }

    fun startNewThread() {
        val c = client
        if (c != null && threadId != null && currentTurnId != null && turnInProgress) {
            try {
                c.turnInterrupt(JsonObject().apply {
                    addProperty("threadId", threadId)
                    addProperty("turnId", currentTurnId)
                }).get()
            } catch (_: Exception) { /* best-effort */ }
        }
        pendingApprovals.values.forEach { it("decline") }
        pendingApprovals.clear()
        pendingUserInputs.values.forEach { it(JsonObject().apply { add("answers", JsonObject()) }) }
        pendingUserInputs.clear()
        threadId = null
        currentTurnId = null
        turnInProgress = false
        post("cleared")
    }

    fun resumeThreadById(id: String) {
        if (id.isBlank()) return
        startNewThread()
        try {
            val c = ensureClient()
            c.threadResume(JsonObject().apply {
                addProperty("threadId", id)
                addProperty("approvalPolicy", "on-request")
            }).whenComplete { result, err ->
                if (err != null) {
                    reportUnreachable(err, "Failed to resume session")
                    return@whenComplete
                }
                val thread = result.asJsonObject.getAsJsonObject("thread")
                threadId = thread.get("id").asString
                replayTranscript(thread.getAsJsonArray("turns"))
            }
        } catch (err: Exception) {
            reportUnreachable(err, "Failed to resume session")
        }
    }

    private fun replayTranscript(turns: JsonArray) {
        for (turnEl in turns) {
            val items = turnEl.asJsonObject.getAsJsonArray("items")
            for (itemEl in items) {
                val item = itemEl.asJsonObject
                if (item.get("type")?.asString == "userMessage") {
                    val text = item.getAsJsonArray("content")
                        ?.mapNotNull { c -> c.asJsonObject.takeIf { it.get("type")?.asString == "text" }?.get("text")?.asString }
                        ?.joinToString("\n") ?: ""
                    post("userMessage") { addProperty("text", text) }
                } else {
                    post("itemCompleted") { add("item", item) }
                }
            }
        }
    }

    fun listSessions() {
        try {
            val c = ensureClient()
            val params = JsonObject().apply {
                addProperty("sortKey", "updated_at")
                addProperty("sortDirection", "desc")
                addProperty("limit", 100)
                addProperty("archived", false)
                add("sourceKinds", JsonArray().apply { listOf("cli", "vscode", "exec", "appServer").forEach { add(it) } })
            }
            c.threadList(params).whenComplete { result, err ->
                if (err != null) { reportUnreachable(err, "Failed to list sessions"); return@whenComplete }
                val sessions = JsonArray()
                for (t in result.asJsonObject.getAsJsonArray("data")) {
                    val to = t.asJsonObject
                    sessions.add(JsonObject().apply {
                        addProperty("id", to.get("id").asString)
                        addProperty("title", to.get("name")?.takeIf { !it.isJsonNull }?.asString
                            ?: to.get("preview")?.takeIf { !it.isJsonNull }?.asString ?: "(no message yet)")
                        addProperty("updatedAt", to.get("updatedAt")?.asString)
                        addProperty("cwd", to.get("cwd")?.takeIf { !it.isJsonNull }?.asString)
                    })
                }
                post("sessionList") { add("sessions", sessions) }
            }
        } catch (err: Exception) {
            reportUnreachable(err, "Failed to list sessions")
        }
    }

    fun sendMessage(text: String) {
        if (text.isBlank()) return
        post("userMessage") { addProperty("text", text) }
        try {
            val c = ensureClient()
            val startTurn = {
                val input = JsonArray().apply {
                    add(JsonObject().apply {
                        addProperty("type", "text")
                        addProperty("text", text)
                        add("text_elements", JsonArray())
                    })
                }
                c.turnStart(JsonObject().apply {
                    addProperty("threadId", threadId)
                    add("input", input)
                    settings().model.takeIf { it.isNotBlank() }?.let { addProperty("model", it) }
                    // Re-asserted on every turn, not just at thread creation --
                    // same lesson vscode-byteask's sendMessage() learned: a
                    // thread resumed/started without this can silently apply
                    // edits without asking.
                    addProperty("approvalPolicy", "on-request")
                }).whenComplete { _, err ->
                    if (err != null) reportUnreachable(err, "Failed to reach byteask")
                }
            }
            if (threadId == null) {
                c.threadStart(JsonObject().apply {
                    addProperty("cwd", workspaceCwd())
                    settings().model.takeIf { it.isNotBlank() }?.let { addProperty("model", it) }
                    addProperty("approvalPolicy", "on-request")
                }).whenComplete { result, err ->
                    if (err != null) { reportUnreachable(err, "Failed to reach byteask"); return@whenComplete }
                    threadId = result.asJsonObject.getAsJsonObject("thread").get("id").asString
                    startTurn()
                }
            } else {
                startTurn()
            }
        } catch (err: Exception) {
            reportUnreachable(err, "Failed to reach byteask")
        }
    }

    fun interrupt() {
        val c = client ?: return
        val tid = threadId ?: return
        val turnId = currentTurnId ?: return
        if (!turnInProgress) return
        c.turnInterrupt(JsonObject().apply { addProperty("threadId", tid); addProperty("turnId", turnId) })
    }

    fun openFile(rawPath: String) {
        if (rawPath.isBlank()) return
        val resolved = if (File(rawPath).isAbsolute) rawPath else "${workspaceCwd()}/$rawPath"
        val vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(resolved) ?: return
        ApplicationManager.getApplication().invokeLater {
            FileEditorManager.getInstance(project).openFile(vf, true)
        }
    }

    // ── Wiring for AppServerCallbacks (called by ByteAskChatToolWindowFactory
    //    when it constructs the underlying rpc/client) ──────────────────────

    fun onItemStarted(item: JsonObject) = post("itemStarted") { add("item", item) }
    fun onItemCompleted(item: JsonObject) = post("itemCompleted") { add("item", item) }
    fun onAgentMessageDelta(itemId: String, delta: String) =
        post("agentMessageDelta") { addProperty("itemId", itemId); addProperty("delta", delta) }
    fun onReasoningTextDelta(itemId: String, delta: String) =
        post("reasoningDelta") { addProperty("itemId", itemId); addProperty("delta", delta) }
    fun onTurnStarted(turnId: String) {
        currentTurnId = turnId
        turnInProgress = true
        post("turnStarted")
    }
    fun onTurnCompleted(status: String) {
        turnInProgress = false
        post("turnCompleted") { addProperty("status", status) }
    }
    fun onErrorNotification(message: String) = post("error") { addProperty("message", message) }

    fun onFileChangeApprovalRequest(itemId: String, diffText: String, summary: String): CompletableFuture<String> {
        val id = nextApprovalId.getAndIncrement()
        val future = CompletableFuture<String>()
        pendingApprovals[id] = { decision -> future.complete(decision) }
        post("approvalRequest") {
            addProperty("requestId", id)
            addProperty("kind", "fileChange")
            addProperty("title", summary)
            addProperty("body", diffText)
        }
        return future
    }

    fun onCommandExecutionApprovalRequest(command: String?, cwd: String?): CompletableFuture<String> {
        val id = nextApprovalId.getAndIncrement()
        val future = CompletableFuture<String>()
        pendingApprovals[id] = { decision -> future.complete(decision) }
        post("approvalRequest") {
            addProperty("requestId", id)
            addProperty("kind", "command")
            addProperty("title", command ?: "(unknown command)")
            addProperty("body", cwd?.let { "cwd: $it" } ?: "")
        }
        return future
    }

    fun onToolRequestUserInput(questions: JsonArray): CompletableFuture<JsonObject> {
        val id = nextUserInputId.getAndIncrement()
        val future = CompletableFuture<JsonObject>()
        pendingUserInputs[id] = { response -> future.complete(response) }
        post("userInputRequest") {
            addProperty("requestId", id)
            add("questions", questions)
        }
        return future
    }

    // ── Webview -> host message handling ────────────────────────────────────

    fun handleWebviewMessage(msg: JsonObject, openTerminal: (List<String>) -> Unit) {
        when (msg.get("type")?.asString) {
            "sendMessage" -> sendMessage(msg.get("text")?.asString ?: "")
            "approvalDecision" -> {
                val id = msg.get("requestId").asInt
                val decision = msg.get("decision").asString
                pendingApprovals.remove(id)?.invoke(decision)
            }
            "userInputAnswer" -> {
                val id = msg.get("requestId").asInt
                val answers = msg.getAsJsonObject("answers") ?: JsonObject()
                pendingUserInputs.remove(id)?.invoke(JsonObject().apply { add("answers", answers) })
            }
            "userInputCancel" -> {
                val id = msg.get("requestId").asInt
                pendingUserInputs.remove(id)?.invoke(JsonObject().apply { add("answers", JsonObject()) })
            }
            "openFile" -> openFile(msg.get("path")?.asString ?: "")
            "interrupt" -> interrupt()
            "newThread" -> startNewThread()
            "listSessions" -> listSessions()
            "resumeThread" -> resumeThreadById(msg.get("threadId")?.asString ?: "")
            "retryConnect" -> retryConnect(openTerminal = { openTerminal(emptyList()) })
            "installCli" -> installCli()
            "login" -> openTerminal(listOf("login"))
            "logout" -> openTerminal(listOf("logout"))
            else -> { /* mentionFile/uploadFile/switchModel/showStatus/showUsage/showDiff/showSkills:
                        not yet ported -- see jetbrains/README.md's G2 scope note. */ }
        }
    }

    fun dispose() {
        client?.dispose()
    }
}
