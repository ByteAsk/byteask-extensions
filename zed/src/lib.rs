use zed::{Result, SlashCommand, SlashCommandArgumentCompletion, SlashCommandOutput};
use zed_extension_api as zed;

/// G1 (slash commands, Tier 2) + G2 (context-server extension wrapping
/// `byteask app-server`, Tier 3 -- Zed has no custom-panel/webview API, so
/// this reuses Zed's OWN Agent Panel to render the streaming/approval UX
/// instead of building one). See the connector roadmap for why this is the
/// achievable ceiling on Zed today.
struct ByteAskExtension;

impl zed::Extension for ByteAskExtension {
    fn new() -> Self {
        ByteAskExtension
    }

    fn complete_slash_command_argument(
        &self,
        command: SlashCommand,
        _args: Vec<String>,
    ) -> Result<Vec<SlashCommandArgumentCompletion>, String> {
        match command.name.as_str() {
            "byteask-exec" => Ok(vec![]), // free-text prompt, no fixed completions
            _ => Ok(vec![]),
        }
    }

    fn run_slash_command(
        &self,
        command: SlashCommand,
        args: Vec<String>,
        worktree: Option<&zed::Worktree>,
    ) -> Result<SlashCommandOutput, String> {
        // zed_extension_api's `process::Command` has no cwd control at all
        // (confirmed against the WIT interface -- `Command` is just
        // {command, args, env}), so unlike the other connectors' headless
        // commands, this can't pass an explicit working directory; it
        // relies on Zed's own sandboxed process spawn defaulting to the
        // project root.
        let byteask = worktree
            .and_then(|w| w.which("byteask"))
            .unwrap_or_else(|| "byteask".to_string());

        let mut argv: Vec<String> = vec![byteask];
        match command.name.as_str() {
            "byteask-exec" => {
                if args.is_empty() {
                    return Err("Usage: /byteask-exec <prompt>".to_string());
                }
                argv.push("exec".to_string());
                argv.push(args.join(" "));
            }
            "byteask-review" => {
                argv.push("review".to_string());
            }
            other => return Err(format!("Unknown slash command: {other}")),
        }

        let output = zed::process::Command::new(&argv[0])
            .args(&argv[1..])
            .output()
            .map_err(|e| format!("Failed to run byteask: {e}"))?;

        let text = if output.status == Some(0) {
            String::from_utf8_lossy(&output.stdout).to_string()
        } else {
            format!(
                "byteask exited with an error:\n{}",
                String::from_utf8_lossy(&output.stderr)
            )
        };
        let text_len = text.len() as u32;

        Ok(SlashCommandOutput {
            text,
            sections: vec![zed::SlashCommandOutputSection {
                range: (0..text_len).into(),
                label: command.name,
            }],
        })
    }

    fn context_server_command(
        &mut self,
        _context_server_id: &zed::ContextServerId,
        _project: &zed::Project,
    ) -> Result<zed::Command> {
        // `Project` only exposes `worktree_ids()` (confirmed against the WIT
        // interface -- no way to get an actual `Worktree` handle, and no
        // `which()`-equivalent on Project itself), unlike run_slash_command
        // above which does get a real `&Worktree`. Falls back to relying on
        // `byteask` being on PATH, same default every other connector uses.
        Ok(zed::Command {
            command: "byteask".to_string(),
            args: vec!["app-server".to_string()],
            env: vec![],
        })
    }
}

zed::register_extension!(ByteAskExtension);
