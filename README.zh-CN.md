# Apple Container Manager for VS Code

[English](README.md) | **简体中文**

**在 VS Code 中将 Apple Container 用作 Dev Container。**

本扩展为 macOS 原生 `container` 环境带来完整的 **DevContainer 体验**。SSH 密钥注入、配置管理和容器生命周期等复杂细节都由扩展处理，你只需要打开项目并开始编码，就像使用 Docker 一样。

> [!TIP]
> 如果遇到容器卡死或 SSH 连接反复中断，请先尝试增加容器的内存和 CPU 资源。

> [!WARNING]
> Apple Container 目前仍在积极开发中。你可能会遇到 SSH 连接中断或容器无响应，严重时可能导致**数据丢失**。这不是扩展本身的问题，我们正在持续解决。如果你有绕过方法或改进建议，请[提交 issue](https://github.com/AndanteL/AppleContainerManager/issues)。

---

## 核心功能：Dev Containers

通过简单的 `.appcontainer/devcontainer.json`，将任意文件夹转换为原生 Apple Container 环境。

- **无缝体验**：“Reopen in Container” 开箱即用。
- **配置灵活**：支持 `image`、`forwardPorts`、`cpus`、`memory`、`postCreateCommand` 等配置。
- **快速**：使用原生 macOS 虚拟化和 SSH 多路复用，获得接近原生的性能。
- **零配置**：自动生成 SSH 密钥并管理连接配置。

## 其他功能

- 活动栏视图：管理系统、镜像和容器
- **状态栏**：快速访问 “Reopen in Container”
- 镜像视图展示仓库和标签信息，便于快速检查版本，并支持删除未使用的镜像
- 容器视图支持内联启动、停止和删除操作，悬停时可查看镜像、CPU、内存和端口摘要
- 交互式容器终端会优先使用可用的登录 Shell（bash、zsh、fish、ksh 或 ash），支持命令历史、Tab 补全、作业控制和颜色显示。“Run Command in Container” 会在同一个终端中执行命令，并在执行后保留 Shell，方便继续输入命令
- **Attach to Container**：右键运行中的容器，在新的 VS Code Remote-SSH 窗口中打开。扩展会自动准备 SSH 访问；如果容器缺少 OpenSSH Server，会在确认后安装
- 可按容器选择性开启日志流，支持时间戳、严重级别过滤和 Output 面板中的关键字高亮
- 独立的 System 视图，支持启动、停止和更新状态提示
- 点击工具栏的 “+” 按钮可启动两步式容器创建向导（先选择镜像和资源，再配置端口、卷和额外参数）
- 实时视图会清理过期数据，并在系统服务离线时提示启动
- **自动更新**：检测新的 CLI 版本，提供交互式 “停止 → 卸载 → 安装” 流程，并支持 “跳过此版本”
- 可选的工作区级系统服务自动启动
- **自动停止**：可配置超时时间，在 SSH 会话断开后自动停止容器，节省资源
- **DNS 集成**：初始化本地 DNS 域名（默认 `container.acm`），可通过容器名称访问，例如 `my-app.container.acm`
- **重建容器**：右键停止、删除并重新创建容器，同时在 DNS 中重新注册

## 系统要求

- macOS 26+（Apple Silicon）
- 已安装 Apple `container` CLI，并可在 PATH 中访问
- VS Code 1.95+
- 已安装 **Remote - SSH** 扩展

## 安装

1. 从打包的 `.vsix` 文件安装扩展，或在 Marketplace 上安装（开放后）。
2. 确保 Apple `container` CLI 已安装且可执行（`container --version`）。

## 快速开始

1. 打开 VS Code，活动栏中会出现 “Apple Containers” 视图。
2. 如果系统服务未运行，请在 System 视图中启动它。
3. 通过右键菜单或命令面板管理容器。

## DevContainer 支持（在容器中打开）

本扩展使用 Apple 原生容器提供接近完整 DevContainer 的体验。

### 前置条件

- 项目中存在 `.appcontainer/devcontainer.json` 文件。
- VS Code 中已安装 **Remote - SSH** 扩展。

### 配置（`devcontainer.json`）

配置示例：

```json
{
  "name": "NodeJS-Dev",
  "image": "docker.io/library/node:18",
  "remoteUser": "root",
  "workspaceFolder": "/root/workspace",
  "forwardPorts": [8080, "2222:22"],
  "postCreateCommand": "apt-get update && apt-get install -y openssh-server && mkdir -p /run/sshd",
  "postStartCommand": "/usr/sbin/sshd",
  "hostRequirements": {
    "cpus": 4,
    "memory": "8GB"
  }
}
```

> **注意：** 标准镜像（例如 `node:18`）通常需要自行安装并启动 SSH。你还必须将某个端口转发到容器的 `22` 端口（例如 `2222:22`），宿主机才能连接。

### 使用方法

1. 在 VS Code 中打开项目文件夹。
2. 运行命令 **Apple Container: Reopen Folder in Container**。
3. 扩展会自动执行以下操作：
   - 正确创建并配置容器。
   - 注入专用 SSH 密钥。
   - 更新本机 `~/.ssh/config`（包含多路复用等优化）。
   - 通过注入 `sleep infinity` 保活，确保容器持续运行。
   - 打开一个通过 SSH 连接的新 VS Code 窗口。

### 功能特点

- **快速连接：** 使用 SSH ControlMaster（多路复用）降低终端延迟。
- **端口转发：** 遵循 `forwardPorts` 配置（例如将本机 `2222` 映射到容器 `22`，同时转发应用端口）。
- **自动配置：** 自动处理 SSH 密钥和连接配置，无需手动设置。
- **弹性恢复：** 配置变化时重建容器，并稳健管理生命周期状态。

## 配置项

可在用户设置或工作区设置中添加以下配置：

```jsonc
{
  "appleContainer.update.mode": "notify",
  "appleContainer.update.checkIntervalHours": 24,
  "appleContainer.update.autoUpdate": false,
  "appleContainer.update.keepData": true,
  "appleContainer.system.autoStartOnWorkspaceOpen": false,
  "appleContainer.pollIntervalMs": 5000,
  "appleContainer.logs.showTimestamps": true,
  "appleContainer.logs.highlightKeywords": true,
  "appleContainer.logs.minimumLevel": "info",
  "appleContainer.autoStop.enabled": false,
  "appleContainer.autoStop.timeout": 5,
  "appleContainer.resources.defaultCpus": 4,
  "appleContainer.resources.defaultMemory": "8GB"
}
```

## 命令

- `appleContainer.system.start`：启动容器系统服务
- `appleContainer.system.stop`：停止容器系统服务
- `appleContainer.system.refresh`：刷新服务状态和版本信息
- `appleContainer.container.create`：启动容器创建向导
- `appleContainer.container.start`：启动选中的容器
- `appleContainer.container.stop`：停止选中的容器
- `appleContainer.container.logs.start`：开始将运行中容器的日志流式输出到 Output 面板
- `appleContainer.container.logs.stop`：停止运行中容器的日志流
- `appleContainer.container.attach`：在新的 VS Code Remote-SSH 窗口中附加到运行中的容器
- `appleContainer.container.remove`：删除已停止的容器
- `appleContainer.image.remove`：删除未使用的镜像
- `appleContainer.containers.refresh`：刷新容器列表（服务停止时不可用）
- `appleContainer.images.refresh`：刷新镜像列表（服务停止时不可用）
- `appleContainer.refresh`：刷新所有视图（System、Images、Containers）
- `appleContainer.system.upgrade`：打开容器 CLI 的最新 GitHub Release
- `appleContainer.update.check`：检查 CLI 新版本
- `appleContainer.devcontainer.build`：构建 `.appcontainer/devcontainer.json` 中定义的镜像
- `appleContainer.devcontainer.apply`：应用工作区的 `devcontainer.json` 并重新创建容器
- `appleContainer.devcontainer.rebuild`：强制重建由 devcontainer 管理的容器
- `appleContainer.devcontainer.runPostCommands`：在容器内重新执行 `postCreateCommand` 和 `postStartCommand`
- `appleContainer.devcontainer.open`：显示根据 `forwardPorts` 推断的 Remote-SSH 连接说明
- `appleContainer.system.dns.init`：初始化用于容器名称解析的本地 DNS 域名
- `appleContainer.container.rebuild`：重建容器（停止、删除并重新创建）

## 路线图（高层）

- M0：CLI 接口验证和系统控制 — 进行中
- M1：TreeView、状态栏和自动启动 — 进行中
- M2：版本检测和下载提示 — 计划中
- M3：完整容器操作和 Marketplace 发布 — 计划中

## 故障排查

- 找不到 CLI：确认 `container` 已安装并位于 PATH 中，然后重启 VS Code。
- 服务未运行：使用 System 视图中的启动操作，并检查 Output 面板中的日志。
- 权限提示：提权操作需要用户通过 macOS 明确批准。

## 参与贡献

欢迎提交 issue 和 pull request。本项目的目标是让 macOS 原生容器的管理像使用 Docker Desktop 一样方便，并且可以直接在 VS Code 中完成。

## 发布说明

版本变更记录请参阅 `CHANGELOG.md`。

## 许可证

MIT License © 2025 Apple Container。详情请参阅 `LICENSE`。

本仓库源自 [sumaho-live/AppleContainerManager](https://github.com/sumaho-live/AppleContainerManager)，原始 MIT 版权声明已保留在 `LICENSE` 中。
