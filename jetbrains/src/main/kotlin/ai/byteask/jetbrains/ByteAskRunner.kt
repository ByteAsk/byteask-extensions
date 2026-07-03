package ai.byteask.jetbrains

import ai.byteask.jetbrains.settings.ByteAskSettings
import ai.byteask.jetbrains.toolWindow.ByteAskToolWindowFactory
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessListener
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessOutputTypes
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Kotlin port of vscode-byteask's runHeadless()/openTerminal() -- same
 * command shape (`-m <model>` + extraArgs appended after the subcommand,
 * `apply` deliberately excluded from those since it rejects them), same
 * "only one headless run at a time" guard, streamed into the same kind of
 * output surface (a console view here instead of an OutputChannel).
 */
object ByteAskRunner {

    private val running = AtomicBoolean(false)

    private fun notify(project: Project, content: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("ByteAsk")
            .createNotification(content, type)
            .notify(project)
    }

    private fun commonFlags(settings: ByteAskSettings): List<String> {
        val flags = mutableListOf<String>()
        if (settings.model.isNotBlank()) {
            flags += listOf("-m", settings.model)
        }
        flags += settings.extraArgsList()
        return flags
    }

    /**
     * @param sub subcommand + its own args, e.g. ["exec", prompt] or ["review"]
     * @param title short label used in notifications
     * @param withCommon include model/extraArgs (false for `apply`, which rejects them)
     * @param applyAfter run `apply` again once this finishes successfully (0 exit)
     */
    fun runHeadless(
        project: Project,
        sub: List<String>,
        title: String,
        withCommon: Boolean = true,
        applyAfter: Boolean = false,
    ) {
        if (!running.compareAndSet(false, true)) {
            notify(project, ByteAskBundle.message("notification.headlessRunning"), NotificationType.WARNING)
            return
        }

        val settings = ByteAskSettings.getInstance(project)
        val head = sub.first()
        val rest = sub.drop(1)
        val argv = if (withCommon) listOf(head) + commonFlags(settings) + rest else listOf(head) + rest

        val console = ByteAskToolWindowFactory.getConsole(project)
        console.print("$ ${settings.command} ${argv.joinToString(" ")}\n\n", com.intellij.execution.ui.ConsoleViewContentType.SYSTEM_OUTPUT)
        ByteAskToolWindowFactory.show(project)

        val commandLine = GeneralCommandLine(settings.command)
            .withParameters(argv)
            .withWorkDirectory(project.basePath)

        val handler: OSProcessHandler
        try {
            handler = OSProcessHandler(commandLine)
        } catch (err: Exception) {
            running.set(false)
            console.print(
                "\n[byteask $title failed to start: ${err.message}]\n",
                com.intellij.execution.ui.ConsoleViewContentType.ERROR_OUTPUT,
            )
            notify(
                project,
                "Could not run '${settings.command}'. Is it installed and on PATH? (pip install --upgrade byteask)",
                NotificationType.ERROR,
            )
            return
        }

        handler.addProcessListener(object : ProcessListener {
            override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
                val contentType = if (outputType == ProcessOutputTypes.STDERR) {
                    com.intellij.execution.ui.ConsoleViewContentType.ERROR_OUTPUT
                } else {
                    com.intellij.execution.ui.ConsoleViewContentType.NORMAL_OUTPUT
                }
                console.print(event.text, contentType)
            }

            override fun processTerminated(event: ProcessEvent) {
                running.set(false)
                val code = event.exitCode
                console.print("\n[byteask $title exited: $code]\n", com.intellij.execution.ui.ConsoleViewContentType.SYSTEM_OUTPUT)
                ApplicationManager.getApplication().invokeLater {
                    when {
                        code == 0 && applyAfter -> applyDiff(project)
                        code == 0 -> notify(project, "ByteAsk $title finished.", NotificationType.INFORMATION)
                        else -> notify(project, "ByteAsk $title exited with code $code.", NotificationType.WARNING)
                    }
                }
            }
        })
        handler.startNotify()
    }

    fun applyDiff(project: Project) {
        runHeadless(project, listOf("apply"), "apply", withCommon = false)
    }

    /** Builds the argv for the interactive/terminal tier (no streaming --
     * the terminal widget itself owns stdio). */
    fun terminalArgv(project: Project, extra: List<String> = emptyList()): List<String> {
        val settings = ByteAskSettings.getInstance(project)
        return listOf(settings.command) + commonFlags(settings) + extra
    }
}
