# <img src="icon.png" width="64" height="64" alt="Chat History Saver 图标" align="left">&nbsp; Chat History Saver

[English](README.md) | **简体中文**

自动将 VS Code 中的 AI 聊天对话（GitHub Copilot 及自定义聊天提供方）保存为整洁的 Markdown 文件，存放在每个工作区根目录的 `chat-history/` 文件夹中。

为课堂和团队而生：每一段对话都会成为一份永久、可分享的记录——你问了什么、AI 回答了什么，以及**过程中创建或修改了哪些文件**。

> 源码与版本下载：[github.com/odetabadiagomez-art/chat-history-saver](https://github.com/odetabadiagomez-art/chat-history-saver)

## 为什么需要它？

VS Code 将聊天会话以内部 `.jsonl` 补丁格式存放在 `workspaceStorage` 中，很容易丢失，也几乎无法阅读。本扩展会重建每一个会话，并自动、持续地导出为人类可读的 Markdown。

## 功能特性

- 🔄 **全程自动保存** — 监听聊天会话存储，对话有任何活动后数秒内即重新导出，无需点击。
- 💬 **干净的对话导出** — 用户消息与 AI 回答以规范的 Markdown 呈现。
- 📁 **文件活动记录** — 每一轮对话都会列出当时创建 🆕、编辑 ✏️、读取 📖 的文件。
- 🎯 **技能与子代理追踪** — 记录使用了哪些技能（如 `/cinematic-prompt-builder`）和子代理（subagent）。
- 🛠️ **工具摘要**（可选）— 折叠的逐行工具调用日志（运行了什么命令、读取了哪些文件等）。
- 🧠 **思考块**（可选，默认关闭）。
- 📋 **会话总结** — 每份导出末尾包含轮数、模型、代理、token 用量以及全部涉及文件的完整清单。
- 🖥️ **状态栏指示器** — 显示已保存的聊天数量，点击即可打开文件夹。
- ⌨️ **命令**：
  - `Chat History Saver: Save Chat History Now`（立即保存聊天记录）
  - `Chat History Saver: Open Chat History Folder`（打开聊天记录文件夹）

## 输出格式

每段对话对应 `chat-history/` 中的一个 Markdown 文件：

```
chat-history/
  2026-09-20-frame-cinematography-lock-0de9b7bc.md
  2026-09-20-waylog-not-saving-conversations-1c514c4a.md
```

每个文件包含 YAML frontmatter（标题、会话 ID、日期、代理、模型、技能、涉及文件）、逐轮完整对话、每轮文件活动记录，以及会话总结。

## 安装（学生用）

1. 下载 `chat-history-saver-<版本号>.vsix` 文件。
2. 在 VS Code 中：**扩展视图 → `…` 菜单 → 从 VSIX 安装…**（或直接双击该文件）。
3. 重新加载 VS Code。完成——从现在起，每个工作区中的所有聊天都会自动保存到该工作区的 `chat-history/` 中。

## 用 Copilot 安装（粘贴一句话）

在 **Agent 模式**下打开 Copilot Chat，粘贴以下提示词——代理会自动为你下载并安装扩展：

> 请安装 "Chat History Saver" VS Code 扩展：下载
> `https://github.com/odetabadiagomez-art/chat-history-saver/raw/main/releases/chat-history-saver-0.1.0.vsix`
> 并使用 `code --install-extension <下载的文件>` 安装（如果 `code` 不在 PATH 中，请使用 VS Code CLI 可执行文件的完整路径），然后重新加载 VS Code。

代理请求批准终端命令时，点击同意即可。发布新版本后，链接中的文件名会变为新的版本号。

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `chatHistorySaver.enable` | `true` | 启用/禁用自动保存。 |
| `chatHistorySaver.outputFolder` | `chat-history` | Markdown 导出文件夹（相对于工作区根目录）。 |
| `chatHistorySaver.includeToolSummaries` | `true` | 包含每轮工具调用的一句话摘要。 |
| `chatHistorySaver.includeThinking` | `false` | 包含 AI 的思考/推理块。 |
| `chatHistorySaver.exportOnStartup` | `true` | VS Code 启动时导出全部已有会话。 |

> 💡 如果不想把聊天记录提交到 git，请将 `chat-history/` 加入 `.gitignore`。如果*想*与全班分享，那就提交它！

## 开发

```bash
npm install
npm run build        # 打包到 dist/
npm run typecheck    # 严格 TS 类型检查
npm run package      # 生成用于分发的 .vsix
```

不启动 VS Code 测试解析器/导出器：

```bash
node dist/cli.js "<path-to-workspaceStorage>/<hash>/chatSessions" /tmp/out [workspaceRoot]
```

## 工作原理

VS Code 将每个聊天会话写为增量补丁式的 `.jsonl` 文件（`kind:0` = 基础对象，`kind:1` = 设置某路径的值，`kind:2` = 向某路径的数组追加）。本扩展重放这些补丁以重建完整会话，然后提取消息、文件编辑（`textEditGroup` / `codeblockUri` 部分）、工具调用、技能与代理，并渲染为 Markdown。

## 许可证

MIT
