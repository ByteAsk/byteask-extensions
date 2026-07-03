import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType

plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.intellij.platform")
    id("org.jetbrains.changelog")
}

dependencies {
    testImplementation("junit:junit:4.13.2")

    // IntelliJ Platform Gradle Plugin Dependencies Extension - read more: https://plugins.jetbrains.com/docs/intellij/tools-intellij-platform-gradle-plugin-dependencies-extension.html
    intellijPlatform {
        intellijIdea("2025.2.6.2")
        // Bundled with the IDE, not a Marketplace dependency -- required to
        // compile against org.jetbrains.plugins.terminal.* (OpenTerminalAction).
        bundledPlugin("org.jetbrains.plugins.terminal")
        testFramework(TestFrameworkType.Platform)
    }
}

intellijPlatform {
    pluginVerification {
        ides {
            // Scoped to the single version we build/compile against, not the
            // `recommended()` default (4 separate IDE releases) -- verifying
            // against all 4 hung for 30+ minutes with no progress and no
            // network activity in this environment (likely a resource
            // constraint running that many full IDE downloads/scans back to
            // back). Widen this before a real release if broader
            // compatibility assurance is needed.
            create(IntelliJPlatformType.IntellijIdea, "2025.2.6.2")
        }
    }
}
