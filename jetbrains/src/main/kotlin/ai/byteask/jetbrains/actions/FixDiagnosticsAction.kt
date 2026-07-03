package ai.byteask.jetbrains.actions

import ai.byteask.jetbrains.ByteAskBundle
import ai.byteask.jetbrains.ByteAskRunner
import ai.byteask.jetbrains.settings.ByteAskSettings
import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerEx
import com.intellij.codeInsight.daemon.impl.HighlightInfo
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VfsUtilCore

/**
 * Tier-2: same idea as vscode-byteask's fixDiagnostics() -- format the
 * current file's compiler/inspection diagnostics into a prompt and run
 * `byteask exec` on them.
 *
 * Verified against intellij-community source: the platform's
 * `DaemonCodeAnalyzerEx` no longer exposes a plain "get list of highlights"
 * method (that shape is gone from the current source) -- the real,
 * currently-shipping API is the callback-based `processHighlights`, so this
 * collects into a list itself rather than assuming a getter exists.
 */
class FixDiagnosticsAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor: Editor = e.getData(CommonDataKeys.EDITOR) ?: run {
            Messages.showWarningDialog(project, ByteAskBundle.message("notification.noEditor"), "ByteAsk")
            return
        }
        val document = editor.document

        val infos = mutableListOf<HighlightInfo>()
        DaemonCodeAnalyzerEx.processHighlights(
            document,
            project,
            HighlightSeverity.WEAK_WARNING, // matches vscode-byteask's Hint..Error inclusive range
            0,
            document.textLength,
        ) { info -> infos.add(info); true }

        if (infos.isEmpty()) {
            Messages.showInfoMessage(project, ByteAskBundle.message("notification.noDiagnostics"), "ByteAsk")
            return
        }

        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        val projectDir = project.guessProjectDir()
        val relPath = file?.let {
            (projectDir?.let { dir -> VfsUtilCore.getRelativePath(it, dir) }) ?: it.name
        } ?: "(unknown file)"

        val block = infos.joinToString("\n") { info ->
            val line = document.getLineNumber(info.startOffset) + 1
            val col = info.startOffset - document.getLineStartOffset(line - 1) + 1
            val severity = severityLabel(info.severity)
            "$relPath:$line:$col: $severity: ${info.description?.replace("\n", " ") ?: ""}"
        }
        val prompt = "Fix the following compiler/linter diagnostics in $relPath. " +
            "Make the minimal correct change and keep the build green:\n\n```\n$block\n```"

        ByteAskRunner.runHeadless(
            project,
            listOf("exec", prompt),
            "exec",
            applyAfter = ByteAskSettings.getInstance(project).autoApply,
        )
    }

    private fun severityLabel(severity: HighlightSeverity): String = when {
        severity == HighlightSeverity.ERROR -> "ERROR"
        severity == HighlightSeverity.WARNING -> "WARN"
        severity == HighlightSeverity.WEAK_WARNING -> "HINT"
        severity >= HighlightSeverity.INFORMATION -> "INFO"
        else -> "HINT"
    }
}
