# Camellia 统一设置与自动运行时

实现日期：2026-09-15。

首页、菜单、DSH、Claude 和 Kimi 的设置按钮均打开同一个设置窗口。
窗口包含供应商与 Key、调用用量、余额与额度、引擎设置、运行环境和通用。

## 引擎设置

| 引擎 | 集中管理的内容 | 默认全局文件 |
|---|---|---|
| DSH | 原生通用设置、插件、Agent 预设；完整 YAML；模型连接转至统一 Key 池 | `~/.dsh/settings.yaml` |
| Claude | 语言、默认权限、推理强度、输出风格、历史保留；完整 JSON（含工具、Hooks、插件等）、MCP、全局指令 | `~/.claude/settings.json`、`~/.claude.json` 的 `mcpServers`、`~/.claude/CLAUDE.md` |
| Kimi | 默认权限与规划、重试、后台任务、技能、遥测；完整 TOML、MCP、终端配置；工作台的目录与上下文窗口 | `~/.kimi-code/config.toml`、`mcp.json`、`tui.toml` |

遵循 `DSH_HOME`、`CLAUDE_CONFIG_DIR` 和 `KIMI_CODE_HOME` 指定的目录。
常用选项提供表单，其余原生配置可在高级编辑器中修改；并未逐个重做所有
命令行专属控件。项目内配置继续遵循各引擎的覆盖规则，不在这里改写。

页面明确提示会覆盖 CLI 全局设置，并列出实际路径。第一次覆盖已有文件前，
保留同目录下的 `.workbench.bak`；随后保存不覆盖这份原始备份。
Claude 的 MCP 保存只修改 `mcpServers`，保留登录信息和其他状态。
DSH 原生控件即时保存；其他编辑通过“保存引擎设置”提交。语法错误或文件已被
外部程序修改时不覆盖原文件，可使用“放弃并重新载入”刷新。

工作台不向原生配置复制供应商真实 Key，只写本机代理地址和占位凭据。
已同步的 CLI 需要工作台保持运行；变更路由端口会更新已接管的 CLI 连接。
Claude 会话通过命令行 overlay 固定当前模型。Kimi 每次启动从全局配置读取
工具、Hooks、MCP 等偏好，再注入当前会话模型；其历史数据继续放在工作台
数据目录，保留既有会话。没有跨模型自动回退。

## 从代码运行

Windows x64 上准备 Node.js 22.19+（推荐 24 LTS）和 Git for Windows，然后：

```powershell
npm install
npm start
```

`postinstall` 自动准备 `runtimes/` 下锁定的 DSH、Kimi 和官方 Claude CLI。
无需执行三个单独的全局安装命令。网络失败会提示，之后可进入
“设置 → 运行环境”重试；也可执行 `npm run setup:runtimes`。
`npm start` 会重新应用 DSH 源码集成，缺失运行时由桌面程序在进入对应引擎时安装。

DSH/Kimi 是 MIT 开源项目。Claude Code 核心不是开源项目；这里使用官方 CLI，
不把它描述为本项目修改过的开源核心，使用受其官方条款约束。

## 分发与打包

安装包携带 DSH、Kimi、Node.js、npm 和 DSH 插件管理所用 pnpm。
Claude CLI 不随安装包再分发，首次使用时从官方 npm 包安装到应用数据目录。
这不会添加全局 npm 包或覆盖系统 CLI 可执行文件。Windows 上的 Shell 工具
仍使用 Git for Windows 提供的 Bash；开发机通常已因拉取代码而具备它。

```powershell
npm run pack
npm run dist
```

构建前检查开源运行时、应用 DSH 设置源码集成并准备 Node/npm。
上游版本通过每个运行时自己的 lockfile 固定，升级需要重新验证。

## 验证

```powershell
npm test
python tests/engine-settings-ui.py
node tests/native-settings-electron.cjs
node tests/electron-smoke.cjs
node tests/kimi-cli-smoke.cjs
node tests/claude-cli-resume.cjs ./runtimes/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe
node tests/api-router-cli-smoke.cjs ./runtimes/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe
```

测试使用临时目录、隐藏窗口和本机模拟 API，不改写用户的 CLI 配置或消耗付费额度。
DSH 检查包含真实认证、设置面板、统一设置跳转和子视图销毁；Claude/Kimi
检查包含配置保留、MCP、续聊、工具调用及同模型线路切换。

官方依据：[DSH 源码](https://github.com/deepseek-ai/deepseek-harness)、
[Claude 设置](https://code.claude.com/docs/en/settings)、
[Claude 许可证](https://github.com/anthropics/claude-code/blob/main/LICENSE.md)、
[Kimi 配置](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/config-files.md)。
