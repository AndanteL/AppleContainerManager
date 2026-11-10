import * as net from "node:net";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import * as vscode from "vscode";

import {
  ContainerAttachInfo,
  ContainerCli,
} from "../cli/containerCli";
import { AppleContainerError, ErrorCode } from "../core/errors";
import { logInfo } from "../core/logger";
import { SshManager } from "../devcontainer/sshManager";

const execFileAsync = promisify(execFile);

const REMOTE_SSH_EXTENSION = "ms-vscode-remote.remote-ssh";

interface ContainerUser {
  username: string;
}

const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Connects an arbitrary running container to a new VS Code window through
 * Remote-SSH. Apple containers do not expose a VS Code remote agent directly,
 * so the container needs an SSH server, an injected public key and a host
 * entry in ~/.ssh/config.
 */
export class ContainerAttachManager {
  private readonly sshManager = new SshManager();

  constructor(private readonly cli: ContainerCli) {}

  async attach(containerId: string, containerLabel: string): Promise<void> {
    if (!(await this.ensureRemoteSshExtension())) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Preparing remote connection to ${containerLabel}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Reading container configuration..." });
        const attachInfo = await this.cli.getContainerAttachInfo(containerId);
        const user = await this.resolveUser(containerId);

        const sshReady = await this.ensureSshServer(
          containerId,
          containerLabel,
          user,
          progress,
        );
        if (!sshReady) {
          return;
        }

        progress.report({ message: "Installing SSH key..." });
        const publicKey = await this.sshManager.ensureSshKey();
        await this.injectAuthorizedKey(containerId, publicKey);

        const hostName =
          attachInfo.publishedSshHost ?? attachInfo.ipAddress;
        if (!hostName) {
          throw new AppleContainerError(
            `Unable to determine an SSH address for ${containerLabel}. Publish port 22 or connect the container to the default network.`,
            ErrorCode.CommandFailed,
          );
        }

        const port = attachInfo.publishedSshPort ?? "22";
        if (!/^\d+$/.test(port)) {
          throw new AppleContainerError(
            `Invalid SSH port for ${containerLabel}: ${port}`,
            ErrorCode.CommandFailed,
          );
        }

        progress.report({
          message: `Waiting for SSH at ${hostName}:${port}...`,
        });
        await waitForTcp(hostName, Number(port));

        const aliasSuffix = this.createAliasSuffix(
          containerLabel,
          containerId,
        );
        const alias = `acm-${aliasSuffix}`;
        await this.sshManager.updateConfig(
          aliasSuffix,
          port,
          user.username,
          hostName,
        );

        progress.report({ message: "Verifying SSH authentication..." });
        await this.verifySshAuthentication(
          hostName,
          Number(port),
          user.username,
        );

        const remoteFolder = this.chooseRemoteFolder(attachInfo);
        logInfo(
          `Opening remote window ${alias} (${hostName}:${port}, user=${user.username}, folder=${remoteFolder})`,
        );

        const uri = vscode.Uri.from({
          scheme: "vscode-remote",
          authority: `ssh-remote+${alias}`,
          path: remoteFolder,
        });
        await vscode.commands.executeCommand("vscode.openFolder", uri, {
          forceNewWindow: true,
        });
      },
    );
  }

  private async ensureRemoteSshExtension(): Promise<boolean> {
    if (vscode.extensions.getExtension(REMOTE_SSH_EXTENSION)) {
      return true;
    }

    const install = "Install Remote - SSH";
    const selection = await vscode.window.showErrorMessage(
      "Attaching to a container requires the Microsoft Remote - SSH extension.",
      install,
    );
    if (selection === install) {
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        REMOTE_SSH_EXTENSION,
      );
      void vscode.window.showInformationMessage(
        "Remote - SSH is being installed. Reload VS Code and run Attach to Container again.",
      );
    }
    return false;
  }

  private async resolveUser(containerId: string): Promise<ContainerUser> {
    const script = [
      `printf '%s\\n' "$(id -un 2>/dev/null || id -u)"`,
      `printf '%s\\n' "$HOME"`,
      `getent passwd "$(id -u)" 2>/dev/null | cut -d: -f7 2>/dev/null || true`,
    ].join("\n");

    let stdout: string;
    try {
      ({ stdout } = await this.cli.execInContainer(
        containerId,
        ["/bin/sh", "-c", script],
        { tty: false, interactive: false, timeout: 15_000 },
      ));
    } catch (error) {
      throw new AppleContainerError(
        "Unable to determine the container user. Attach requires a working /bin/sh.",
        ErrorCode.CommandFailed,
        error,
      );
    }

    const [username = "", home = "", loginShell = ""] = stdout
      .split(/\r?\n/)
      .map((line) => line.trim());
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(username)) {
      throw new AppleContainerError(
        `Container reported an unsupported login user: ${username || "<empty>"}`,
        ErrorCode.CommandFailed,
      );
    }
    if (!home.startsWith("/")) {
      throw new AppleContainerError(
        `Unable to determine the home directory for container user ${username}.`,
        ErrorCode.CommandFailed,
      );
    }
    if (
      loginShell.endsWith("/nologin") ||
      loginShell.endsWith("/false")
    ) {
      throw new AppleContainerError(
        `Container user ${username} has no interactive login shell (${loginShell}).`,
        ErrorCode.CommandFailed,
      );
    }

    return { username };
  }

  private async ensureSshServer(
    containerId: string,
    containerLabel: string,
    user: ContainerUser,
    progress: vscode.Progress<{ message?: string }>,
  ): Promise<boolean> {
    progress.report({ message: "Looking for an SSH server..." });
    let sshdPath = await this.findSshd(containerId);

    if (!sshdPath) {
      const packageManager = await this.findPackageManager(containerId);
      if (!packageManager) {
        throw new AppleContainerError(
          `Container ${containerLabel} does not have an SSH server, and no supported package manager was found. Install openssh-server in the image, then try again.`,
          ErrorCode.CommandFailed,
        );
      }

      const install = "Install OpenSSH Server";
      const selection = await vscode.window.showWarningMessage(
        `Container "${containerLabel}" does not have an SSH server. Attach requires OpenSSH. Install it in the running container with ${packageManager}? This modifies the container and requires network access.`,
        { modal: true },
        install,
      );
      if (selection !== install) {
        logInfo(`Attach to ${containerLabel} cancelled before SSH installation`);
        return false;
      }

      progress.report({
        message: `Installing OpenSSH Server with ${packageManager}...`,
      });
      try {
        await this.execRoot(
          containerId,
          this.getInstallCommand(packageManager),
          600_000,
        );
      } catch (error) {
        throw new AppleContainerError(
          `Failed to install OpenSSH Server in ${containerLabel}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          ErrorCode.CommandFailed,
          error,
        );
      }

      sshdPath = await this.findSshd(containerId);
      if (!sshdPath) {
        throw new AppleContainerError(
          `OpenSSH Server was installed in ${containerLabel}, but sshd could not be found.`,
          ErrorCode.CommandFailed,
        );
      }
    }

    progress.report({ message: "Starting SSH server..." });
    await this.startSshd(containerId, sshdPath, user.username);
    return true;
  }

  private async findSshd(containerId: string): Promise<string | undefined> {
    const script = [
      "if command -v sshd >/dev/null 2>&1; then",
      "  command -v sshd",
      "elif [ -x /usr/sbin/sshd ]; then",
      "  printf '%s\\n' /usr/sbin/sshd",
      "fi",
    ].join("\n");
    const stdout = await this.execRoot(containerId, script, 15_000);
    const candidate = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("/"));
    return candidate;
  }

  private async findPackageManager(
    containerId: string,
  ): Promise<string | undefined> {
    const script = [
      "for pm in apt-get apk dnf microdnf yum; do",
      '  if command -v "$pm" >/dev/null 2>&1; then',
      '    printf "%s\\n" "$pm"',
      "    break",
      "  fi",
      "done",
    ].join("\n");
    const stdout = await this.execRoot(containerId, script, 15_000);
    const candidate = stdout.trim();
    return candidate || undefined;
  }

  private getInstallCommand(packageManager: string): string {
    switch (packageManager) {
      case "apt-get":
        return "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server";
      case "apk":
        return "apk add --no-cache openssh-server";
      case "dnf":
        return "dnf install -y openssh-server";
      case "microdnf":
        return "microdnf install -y openssh-server";
      case "yum":
        return "yum install -y openssh-server";
      default:
        throw new AppleContainerError(
          `Unsupported package manager: ${packageManager}`,
          ErrorCode.CommandFailed,
        );
    }
  }

  private async startSshd(
    containerId: string,
    sshdPath: string,
    username: string,
  ): Promise<void> {
    const script = [
      "set -e",
      "mkdir -p /run/sshd",
      "if command -v ssh-keygen >/dev/null 2>&1; then",
      "  ssh-keygen -A >/dev/null 2>&1 || true",
      "fi",
      "if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -Eq '[:.]22[[:space:]]'; then",
      "  exit 0",
      "fi",
      "if command -v netstat >/dev/null 2>&1 && netstat -ltn 2>/dev/null | grep -Eq '[:.]22[[:space:]]'; then",
      "  exit 0",
      "fi",
      `${shellQuote(sshdPath)} -p 22 -o PermitRootLogin=prohibit-password -o PubkeyAuthentication=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o AllowUsers=${username}`,
    ].join("\n");

    try {
      await this.execRoot(containerId, script, 30_000);
    } catch (error) {
      throw new AppleContainerError(
        `Failed to start sshd in the container: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ErrorCode.CommandFailed,
        error,
      );
    }
  }

  private async injectAuthorizedKey(
    containerId: string,
    publicKey: string,
  ): Promise<void> {
    const command = [
      "mkdir -p ~/.ssh",
      "chmod 700 ~/.ssh",
      "touch ~/.ssh/authorized_keys",
      `(grep -qxF ${shellQuote(publicKey)} ~/.ssh/authorized_keys || printf '%s\\n' ${shellQuote(publicKey)} >> ~/.ssh/authorized_keys)`,
      "chmod 600 ~/.ssh/authorized_keys",
    ].join(" && ");

    try {
      await this.cli.execInContainer(
        containerId,
        ["/bin/sh", "-c", command],
        { tty: false, interactive: false, timeout: 15_000 },
      );
    } catch (error) {
      throw new AppleContainerError(
        "Failed to install the SSH public key in the container.",
        ErrorCode.CommandFailed,
        error,
      );
    }
  }

  private execRoot(
    containerId: string,
    script: string,
    timeout: number,
  ): Promise<string> {
    return this.cli
      .execInContainer(containerId, ["/bin/sh", "-c", script], {
        uid: 0,
        tty: false,
        interactive: false,
        timeout,
      })
      .then(({ stdout }) => stdout);
  }

  private async verifySshAuthentication(
    hostName: string,
    port: number,
    username: string,
  ): Promise<void> {
    try {
      await execFileAsync(
        "ssh",
        [
          "-i",
          this.sshManager.getIdentityFile(),
          "-p",
          String(port),
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          "-o",
          "ConnectTimeout=8",
          "-o",
          "LogLevel=ERROR",
          `${username}@${hostName}`,
          "true",
        ],
        { timeout: 15_000 },
      );
    } catch (error) {
      const details =
        error instanceof Error ? error.message : String(error);
      throw new AppleContainerError(
        `SSH authentication failed for ${username}@${hostName}:${port}. ${details}`,
        ErrorCode.CommandFailed,
        error,
      );
    }
  }

  private chooseRemoteFolder(attachInfo: ContainerAttachInfo): string {
    const localFolders = vscode.workspace.workspaceFolders ?? [];
    for (const localFolder of localFolders) {
      const localPath = path.resolve(localFolder.uri.fsPath);
      const matchingMount = attachInfo.mounts.find(
        (mount) => path.resolve(mount.source) === localPath,
      );
      if (matchingMount) {
        return matchingMount.target;
      }
    }

    return attachInfo.workingDirectory.startsWith("/")
      ? attachInfo.workingDirectory
      : "/";
  }

  private createAliasSuffix(label: string, containerId: string): string {
    const raw = (label.trim() || containerId).trim();
    let safe = raw
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);

    if (!safe || safe !== raw) {
      const hash = createHash("sha1")
        .update(`${label}:${containerId}`)
        .digest("hex")
        .slice(0, 8);
      safe = `${safe || "container"}-${hash}`;
    }

    logInfo(`SSH host alias suffix for ${raw}: ${safe}`);
    return safe;
  }
}

async function waitForTcp(
  hostName: string,
  port: number,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await probeTcp(hostName, port);
      return;
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  throw new AppleContainerError(
    `SSH server did not become reachable at ${hostName}:${port}. ${
      lastError instanceof Error ? lastError.message : ""
    }`.trim(),
    ErrorCode.NetworkError,
    lastError,
  );
}

function probeTcp(hostName: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: hostName, port });
    const finish = (error?: Error): void => {
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    socket.setTimeout(1_000);
    socket.once("connect", () => finish());
    socket.once("timeout", () =>
      finish(new Error("connection timed out")),
    );
    socket.once("error", (error) => finish(error));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
