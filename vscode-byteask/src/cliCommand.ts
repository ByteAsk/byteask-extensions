// Map the configured CLI command to something Node can actually spawn on
// Windows. CreateProcess (what child_process.spawn uses) does not consult
// PATHEXT and cannot execute a batch file, while every official Windows
// install of the CLI is a `byteask.cmd` with a `byteask.ps1` sibling.
// Batch files are routed through that .ps1 via powershell.exe because cmd.exe
// re-parses arguments (%, &, ^, newlines) and would corrupt exec prompts.

import * as fs from 'fs';
import * as path from 'path';

export interface CliSpawnSpec {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

function quoteForCmd(arg: string): string {
  if (arg === '') {
    return '""';
  }
  // Enclose in double quotes unless the argument consists entirely of safe characters.
  // This prevents cmd.exe from interpreting &, |, <, >, ^, %, !, spaces, or quotes
  // as shell commands or syntax when falling back to cmd.exe /d /s /c.
  return /^[A-Za-z0-9_./:\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

const POWERSHELL_FLAGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'];

const WINDOWS_EXECUTABLE_EXTENSIONS = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
  .split(';')
  .filter((ext) => ext.length > 0);

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveOnPath(command: string): string | undefined {
  const hasExtension = path.extname(command) !== '';
  for (let dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    dir = dir.replace(/^"|"$/g, '');
    const base = path.join(dir, command);
    if (hasExtension) {
      if (isFile(base)) {
        return base;
      }
      continue;
    }
    for (const ext of WINDOWS_EXECUTABLE_EXTENSIONS) {
      if (isFile(base + ext)) {
        return base + ext;
      }
    }
    if (isFile(base + '.ps1')) {
      return base + '.ps1';
    }
  }
  return undefined;
}

function resolveWindowsCommand(command: string): string | undefined {
  const cleaned = command.replace(/^"|"$/g, '').trim();
  if (!cleaned) {
    return undefined;
  }
  if (path.isAbsolute(cleaned) || cleaned.includes('\\') || cleaned.includes('/')) {
    if (isFile(cleaned)) {
      return path.resolve(cleaned);
    }
    const hasExtension = path.extname(cleaned) !== '';
    if (!hasExtension) {
      for (const ext of WINDOWS_EXECUTABLE_EXTENSIONS) {
        if (isFile(cleaned + ext)) {
          return path.resolve(cleaned + ext);
        }
      }
      if (isFile(cleaned + '.ps1')) {
        return path.resolve(cleaned + '.ps1');
      }
    }
    return undefined;
  }
  return resolveOnPath(cleaned);
}

export function cliSpawnSpec(command: string, args: string[]): CliSpawnSpec {
  if (process.platform !== 'win32') {
    return { command, args };
  }
  const resolved = resolveWindowsCommand(command);
  if (!resolved) {
    return { command, args };
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.ps1') {
    return { command: 'powershell.exe', args: [...POWERSHELL_FLAGS, resolved, ...args] };
  }
  if (ext === '.cmd' || ext === '.bat') {
    const sibling = resolved.slice(0, -ext.length) + '.ps1';
    if (isFile(sibling)) {
      return { command: 'powershell.exe', args: [...POWERSHELL_FLAGS, sibling, ...args] };
    }
    // Rare: a batch file with no .ps1 sibling that we did not write (e.g. a
    // hand-rolled wrapper). `cmd /s /c` strips the outer quotes of whatever
    // it receives, so a path with spaces must be pre-quoted and handed over
    // verbatim; letting Node quote it splits the path at the space.
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `""${resolved}" ${args.map(quoteForCmd).join(' ')}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: resolved, args };
}
