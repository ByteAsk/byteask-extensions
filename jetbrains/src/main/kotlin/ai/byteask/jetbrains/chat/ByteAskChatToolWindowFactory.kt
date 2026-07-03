package ai.byteask.jetbrains.chat

import ai.byteask.jetbrains.appServer.ByteAskAppServerClient
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefJSQuery
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import java.awt.BorderLayout
import java.io.File
import java.nio.file.Files
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingConstants

/**
 * Tier-3: the rich chat sidebar, JCEF-hosted. Reuses vscode-byteask's
 * chat.html/chat.css/chat.js UNCHANGED (verified: chat.js only ever calls
 * `acquireVsCodeApi().postMessage(...)` and listens on
 * `window.addEventListener('message', ...)`) -- the only thing that
 * differs from the VS Code webview is what implements that contract
 * underneath: a JBCefJSQuery bridge here instead of VS Code's native
 * webview messaging.
 */
class ByteAskChatToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = JPanel(BorderLayout())
        if (!JBCefApp.isSupported()) {
            panel.add(JLabel("JCEF is not available in this IDE build.", SwingConstants.CENTER), BorderLayout.CENTER)
        } else {
            val session = project.service<ByteAskChatSession>()
            panel.add(session.component, BorderLayout.CENTER)
        }
        val content = ContentFactory.getInstance().createContent(panel, null, false)
        toolWindow.contentManager.addContent(content)
    }

    override fun shouldBeAvailable(project: Project) = true
}

/**
 * Project-scoped owner of the browser + bridge + extracted webview assets,
 * so re-opening the tool window doesn't respawn a second app-server
 * connection or a second copy of the extracted files.
 */
@Service(Service.Level.PROJECT)
class ByteAskChatSession(private val project: Project) {
    private val log = Logger.getInstance(ByteAskChatSession::class.java)

    private val browser: JBCefBrowser = JBCefBrowser()
    private lateinit var bridge: ByteAskChatBridge
    private var started = false

    val component get() = browser.component

    init {
        val assetsDir = extractWebviewAssets()
        val htmlFile = File(assetsDir, "chat.html")

        // The JBCefBrowser overload of create() is deprecated/scheduled for
        // removal in favor of this JBCefBrowserBase one (confirmed against
        // intellij-community source) -- JBCefBrowser already implements
        // JBCefBrowserBase, so this is just selecting the right overload.
        val toKotlin = JBCefJSQuery.create(browser as com.intellij.ui.jcef.JBCefBrowserBase)
        toKotlin.addHandler { message ->
            handleFromWebview(message)
            null
        }

        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadEnd(cefBrowser: CefBrowser, frame: CefFrame?, httpStatusCode: Int) {
                if (frame != null && !frame.isMain) return
                if (started) return
                started = true
                bridge = ByteAskChatBridge(project) { msg -> postToWebview(msg) }
                ApplicationManager.getApplication().executeOnPooledThread {
                    bridge.autoResumeLatest()
                }
            }
        }, browser.cefBrowser)

        val bridgeScript = """
            window.acquireVsCodeApi = function () {
              return {
                postMessage: function (msg) {
                  ${toKotlin.inject("JSON.stringify(msg)")}
                },
                getState: function () { return undefined; },
                setState: function () {},
              };
            };
        """.trimIndent()
        val html = htmlFile.readText().replace(
            "<!-- BRIDGE_SCRIPT_PLACEHOLDER: ByteAskChatToolWindowFactory.kt replaces\n         this comment with the acquireVsCodeApi() shim, injected here so it\n         runs before chat.js (loaded next) calls it. -->",
            "<script>$bridgeScript</script>",
        )
        File(assetsDir, "chat.html").writeText(html)

        browser.loadURL(htmlFile.toURI().toString())
    }

    private fun handleFromWebview(rawJson: String) {
        val msg = try {
            JsonParser.parseString(rawJson).asJsonObject
        } catch (e: Exception) {
            log.warn("Malformed message from webview: $rawJson", e)
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            bridge.handleWebviewMessage(msg) { extra -> openTerminal(extra) }
        }
    }

    private fun postToWebview(msg: JsonObject) {
        ApplicationManager.getApplication().invokeLater {
            val json = msg.toString().replace("\\", "\\\\").replace("`", "\\`").replace("\$", "\\$")
            browser.cefBrowser.executeJavaScript(
                "window.postMessage($json, '*');",
                browser.cefBrowser.url,
                0,
            )
        }
    }

    private fun openTerminal(extra: List<String>) {
        ApplicationManager.getApplication().invokeLater {
            try {
                val settings = ai.byteask.jetbrains.settings.ByteAskSettings.getInstance(project)
                val command = settings.command
                val argv = listOf(command) + extra
                val widget = org.jetbrains.plugins.terminal.TerminalToolWindowManager.getInstance(project)
                    .createShellWidget(project.basePath, "ByteAsk", true, true)
                (widget as? org.jetbrains.plugins.terminal.ShellTerminalWidget)?.executeCommand(argv.joinToString(" "))
            } catch (e: Exception) {
                log.warn("Could not open ByteAsk terminal", e)
            }
        }
    }

    /** Extract the bundled webview/ resources (chat.html/css/js) to a real
     * temp directory -- JCEF loads file:// URLs, not classpath resources, so
     * this mirrors VS Code's own model of serving webview assets from disk
     * rather than requiring a custom CEF scheme handler. */
    private fun extractWebviewAssets(): File {
        val dir = Files.createTempDirectory("byteask-webview").toFile()
        dir.deleteOnExit()
        for (name in listOf("chat.html", "chat.css", "chat.js")) {
            val resource = javaClass.classLoader.getResourceAsStream("webview/$name")
                ?: error("Missing bundled webview resource: $name")
            val out = File(dir, name)
            resource.use { input -> out.outputStream().use { input.copyTo(it) } }
            out.deleteOnExit()
        }
        return dir
    }

    fun dispose() {
        if (::bridge.isInitialized) bridge.dispose()
        browser.dispose()
    }
}
