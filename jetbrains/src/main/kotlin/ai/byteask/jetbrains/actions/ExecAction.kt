package ai.byteask.jetbrains.actions

import ai.byteask.jetbrains.ByteAskBundle
import ai.byteask.jetbrains.ByteAskRunner
import ai.byteask.jetbrains.settings.ByteAskSettings
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.guessProjectDir
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VfsUtilCore

/** Tier-2: `byteask exec <prompt>`, same shape as vscode-byteask's execPrompt(). */
class ExecAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val instruction = Messages.showInputDialog(
            project,
            "e.g. Add bounds checks and a unit test for parse_header()",
            ByteAskBundle.message("notification.execPromptTitle"),
            Messages.getQuestionIcon(),
        ) ?: return
        if (instruction.isBlank()) return
        ByteAskRunner.runHeadless(
            project,
            listOf("exec", instruction),
            "exec",
            applyAfter = ByteAskSettings.getInstance(project).autoApply,
        )
    }
}

/** Tier-2: `byteask exec` with the active selection appended as context,
 * same shape as vscode-byteask's execSelection(). */
class ExecSelectionAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        e.presentation.isEnabled = editor?.selectionModel?.hasSelection() == true
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR)
        val selection = editor?.selectionModel?.selectedText
        if (selection.isNullOrEmpty()) {
            Messages.showWarningDialog(project, ByteAskBundle.message("notification.noSelection"), "ByteAsk")
            return
        }
        val instruction = Messages.showInputDialog(
            project,
            ByteAskBundle.message("notification.execSelectionTitle"),
            ByteAskBundle.message("notification.execSelectionTitle"),
            Messages.getQuestionIcon(),
            "Improve this code.",
            null,
        ) ?: return
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        val projectDir = project.guessProjectDir()
        val relPath = file?.let {
            (projectDir?.let { dir -> VfsUtilCore.getRelativePath(it, dir) }) ?: it.name
        } ?: "(unknown file)"
        val prompt = "$instruction (from $relPath)\n\n```\n$selection\n```"
        ByteAskRunner.runHeadless(
            project,
            listOf("exec", prompt),
            "exec",
            applyAfter = ByteAskSettings.getInstance(project).autoApply,
        )
    }
}

/** Tier-2: `byteask review`. */
class ReviewAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ByteAskRunner.runHeadless(project, listOf("review"), "review")
    }
}

/** Tier-2: `byteask apply` -- no `-m`/`-c` flags, it rejects them (same
 * caveat documented in the repo's connector contract). */
class ApplyAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ByteAskRunner.applyDiff(project)
    }
}
