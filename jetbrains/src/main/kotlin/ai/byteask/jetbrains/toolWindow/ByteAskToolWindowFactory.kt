package ai.byteask.jetbrains.toolWindow

import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.ui.ConsoleView
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.ContentFactory

/**
 * Tier-1/2 output surface: a plain console the headless runner streams
 * into, same role vscode-byteask's `vscode.OutputChannel` plays. This is
 * deliberately NOT the rich chat webview (that's Tier-3, a separate goal
 * once JCEF wiring lands) -- G1 only needs somewhere to see exec/review/
 * apply output and know whether the run succeeded.
 */
class ByteAskToolWindowFactory : ToolWindowFactory {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val console = getConsole(project)
        val content = ContentFactory.getInstance().createContent(console.component, null, false)
        toolWindow.contentManager.addContent(content)
    }

    override fun shouldBeAvailable(project: Project) = true

    companion object {
        fun getConsole(project: Project): ConsoleView = project.service<ByteAskConsoleHolder>().console

        fun show(project: Project) {
            ToolWindowManager.getInstance(project).getToolWindow("ByteAsk")?.show()
        }
    }
}

@Service(Service.Level.PROJECT)
private class ByteAskConsoleHolder(project: Project) {
    val console: ConsoleView = TextConsoleBuilderFactory.getInstance().createBuilder(project).console
}
