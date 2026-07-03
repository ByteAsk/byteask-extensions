package ai.byteask.jetbrains.settings

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

class ByteAskConfigurable(private val project: Project) : Configurable {

    private val commandField = JBTextField()
    private val modelField = JBTextField()
    private val extraArgsField = JBTextField()
    private val autoApplyCheckBox = JBCheckBox("Automatically apply the diff after a successful exec")

    private var panel: JPanel? = null

    override fun getDisplayName(): String = "ByteAsk"

    override fun createComponent(): JComponent {
        val built = FormBuilder.createFormBuilder()
            .addLabeledComponent("Command:", commandField)
            .addTooltip("Path to the byteask executable, or just \"byteask\" if it's on PATH")
            .addLabeledComponent("Model:", modelField)
            .addTooltip("Leave empty to use byteask's own default model")
            .addLabeledComponent("Extra args:", extraArgsField)
            .addTooltip("Space-separated, e.g. -c key=value -c other=value")
            .addComponent(autoApplyCheckBox)
            .addComponentFillVertically(JPanel(), 0)
            .panel
        panel = built
        return built
    }

    override fun isModified(): Boolean {
        val settings = ByteAskSettings.getInstance(project)
        return commandField.text != settings.command ||
            modelField.text != settings.model ||
            extraArgsField.text != settings.extraArgs ||
            autoApplyCheckBox.isSelected != settings.autoApply
    }

    override fun apply() {
        val settings = ByteAskSettings.getInstance(project)
        settings.command = commandField.text
        settings.model = modelField.text
        settings.extraArgs = extraArgsField.text
        settings.autoApply = autoApplyCheckBox.isSelected
    }

    override fun reset() {
        val settings = ByteAskSettings.getInstance(project)
        commandField.text = settings.command
        modelField.text = settings.model
        extraArgsField.text = settings.extraArgs
        autoApplyCheckBox.isSelected = settings.autoApply
    }

    override fun disposeUIResources() {
        panel = null
    }
}
