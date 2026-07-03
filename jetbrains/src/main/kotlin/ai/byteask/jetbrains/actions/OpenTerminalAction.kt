package ai.byteask.jetbrains.actions

import ai.byteask.jetbrains.ByteAskRunner
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import org.jetbrains.plugins.terminal.ShellTerminalWidget
import org.jetbrains.plugins.terminal.TerminalToolWindowManager

/**
 * Tier-1 (interactive TUI in a terminal), the JetBrains equivalent of
 * vscode-byteask's `openTerminal()`. `extra` lets ResumeLastAction/
 * ResumeAction reuse this for `byteask resume [--last]`.
 *
 * Verified API surface: `TerminalToolWindowManager.createShellWidget` is
 * the current (non-deprecated) entry point, confirmed against the
 * intellij-community source. Its return type is the newer `TerminalWidget`
 * abstraction, which -- on the classic terminal engine -- is actually a
 * `ShellTerminalWidget` underneath and exposes `executeCommand`; on the
 * newer "Reworked Terminal" engine that cast can fail. The safe fallback
 * (just leaving the shell open without auto-running the command) still
 * gets the user 90% of the way there, so this never hard-fails either way.
 * TODO: confirm against a real `runIde` sandbox once the platform JDK is
 * available, and revisit for the Reworked Terminal engine if needed.
 */
open class OpenTerminalAction(private val extra: List<String> = emptyList()) : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val argv = ByteAskRunner.terminalArgv(project, extra)
        val command = argv.joinToString(" ") { shellQuote(it) }

        val widget = TerminalToolWindowManager.getInstance(project)
            .createShellWidget(project.basePath, "ByteAsk", true, true)
        (widget as? ShellTerminalWidget)?.executeCommand(command)
    }

    private fun shellQuote(arg: String): String {
        if (Regex("^[A-Za-z0-9_./:@%+=-]+$").matches(arg)) {
            return arg
        }
        return "'" + arg.replace("'", "'\\''") + "'"
    }
}

class ResumeLastAction : OpenTerminalAction(listOf("resume", "--last"))
class ResumeAction : OpenTerminalAction(listOf("resume"))
