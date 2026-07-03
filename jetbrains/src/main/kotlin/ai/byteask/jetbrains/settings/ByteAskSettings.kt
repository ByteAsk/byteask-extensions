package ai.byteask.jetbrains.settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project

/**
 * Mirrors vscode-byteask's `byteask.*` settings (command/model/extraArgs/
 * autoApply) -- same names, same defaults -- so the connector contract in
 * the repo README stays consistent across editors.
 */
@State(name = "ByteAskSettings", storages = [Storage("byteask.xml")])
@Service(Service.Level.PROJECT)
class ByteAskSettings : PersistentStateComponent<ByteAskSettings.State> {

    data class State(
        var command: String = "byteask",
        var model: String = "",
        var extraArgs: String = "",
        var autoApply: Boolean = false,
    )

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    var command: String
        get() = state.command
        set(value) { state.command = value }

    var model: String
        get() = state.model
        set(value) { state.model = value }

    /** Space-separated, same shape as VS Code's `extraArgs` array setting. */
    var extraArgs: String
        get() = state.extraArgs
        set(value) { state.extraArgs = value }

    var autoApply: Boolean
        get() = state.autoApply
        set(value) { state.autoApply = value }

    fun extraArgsList(): List<String> = extraArgs.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }

    companion object {
        fun getInstance(project: Project): ByteAskSettings = project.service()
    }
}
