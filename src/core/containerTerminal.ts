import * as vscode from "vscode";

/**
 * Runs inside the container as a small POSIX wrapper. `/bin/sh` is often
 * dash on Debian/Ubuntu, which has no line editing or command history. Start
 * the user's login shell when it is capable, then fall back to common
 * interactive shells by preference.
 */
const SHELL_BOOTSTRAP = `
DEFAULT_SHELL="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f7 2>/dev/null || true)"
case "$DEFAULT_SHELL" in
  */bash|*/zsh|*/fish|*/ksh|*/ash)
    exec "$DEFAULT_SHELL" -l
    ;;
esac
for candidate in bash zsh fish ksh ash; do
  if command -v "$candidate" >/dev/null 2>&1; then
    exec "$candidate" -l
  fi
done
exec /bin/sh -l
`.trim();

export interface ContainerTerminalOptions {
  containerId: string;
  containerLabel: string;
  initialCommand?: string;
}

/**
 * Opens a real interactive terminal inside the container, optionally
 * executing an initial command in that shell. Keeping the shell alive after
 * the command gives users the same history, completion and job-control
 * behavior as a normal terminal.
 */
export function openContainerTerminal(
  options: ContainerTerminalOptions,
): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name: options.initialCommand
      ? `Run: ${options.containerLabel}`
      : `Shell: ${options.containerLabel}`,
    shellPath: "container",
    shellArgs: [
      "exec",
      "--interactive",
      "--tty",
      "--env",
      "TERM=xterm-256color",
      options.containerId,
      "/bin/sh",
      "-c",
      SHELL_BOOTSTRAP,
    ],
    iconPath: new vscode.ThemeIcon("terminal"),
  });

  terminal.show(true);
  if (options.initialCommand?.trim()) {
    terminal.sendText(options.initialCommand.trim(), true);
  }

  return terminal;
}
