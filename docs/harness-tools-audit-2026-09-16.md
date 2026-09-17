# 五个 harness 的工具调用核查（2026-09-16）

## 结论

本次核查确认了实际集成缺陷。此前 Codex 缺少原生 `apply_patch` 的问题之外，新增复现并修复了 Antigravity 的流式工具参数问题、Claude 的权限通道问题，以及跨引擎工具失败记录的遗漏。

修复后，五个真实 API 运行时和额外的 DSH 聊天入口通过了同一套核心工具测试。测试使用本机模拟模型和临时工作区，实际文件操作由各自的原生工具完成，没有调用付费模型。这些结果验证集成，不是模型跑分，也不能证明每个第三方扩展或远程服务都可用。

## 已确认的问题与修复

### 1. Antigravity SDK 0.1.16 丢失交错参数、破坏分段 Unicode

向原生 SDK 返回两个 `view_file` 调用，交错发送它们的 JSON 参数时，下一次模型请求只携带第一个调用，参数成为 `{}`，并收到 `AbsolutePath is a required parameter`。单个工具调用按字符分段时，跨分段的 emoji `🙂` 被写成 `��`。同一工具参数完整发送时，原生工具可以正确执行。

`src/api/buffered-tool-stream.js` 在 Antigravity 专用的本地路径 `/compat/antigravity/v1/chat/completions` 中合并完整工具参数。收到上游结束标记后，一次交付本条回复的全部工具调用。它保留调用 ID、工具名、参数、附加签名、结束原因和用量；普通文本继续流式显示。其他客户端保持原来的流式协议。

不完整的参数不会提交给原生工具执行。该适配不会增加模型请求或改变推理参数，但工具准备状态要等本条回复生成完成后才会出现。报告保存 `buffered-tool-arguments-v1`，用于区分修复前后的集成版本。

复现证据：`dist/tools-native-audit-before.json` 中 Antigravity 的第二次请求；`dist/tools-native-audit-antigravity-unicode-before.json` 中实际写入的 Unicode 差异。早期测试中另有 Bash/PowerShell 和 DSH 标题请求的测试夹具错误，已修正；它们不是产品缺陷。

### 2. Claude 的权限处理器未接入 CLI

`ClaudeSession` 已有 `can_use_tool` 回答逻辑，但启动参数没有 `--permission-prompt-tool stdio`。在默认权限模式下，真实 CLI 自动拒绝需要授权的写入，并报告“尚未授予权限”，Camellia 没有收到权限请求。

启动时现在接入 stdio 权限通道，沿用现有确认界面。实测允许时文件写入正确，拒绝时文件不存在且拒绝结果返回模型。benchmark 仍使用显式的无人值守权限配置。

DSH 的正常越界拒绝不是同一问题：它先由工作区沙箱拒绝，模型可按原生协议申请一次权限升级。核查分别验证了升级请求被允许和被拒绝的流程。

### 3. 工具错误记录不完整

此前 benchmark 只监听 `gui:tool`，会遗漏 Claude 的原生 `tool_result`、DSH headless 工具结果，以及一些原生工具在开始执行之前返回的参数或补丁错误。

现在也从该次 trial 的 API 请求历史中提取已经执行的工具结果，关联原始调用 ID、名称和参数，并与 UI 事件去重。保留最近十条失败的有界诊断；重复发送的历史不增加失败次数。模型成功恢复后仍按独立检查器计分，工具失败记录不额外扣分。

对没有结构化错误标记的命令，只识别已验证的原生退出码格式，不用泛化的“文本包含 error”判断。ACP 的部分更新会保留之前的工具名称、输入和输出；DSH `pwsh` 的非零退出码现在显示为失败。

原生 SDK 部分工具卡片仍只提供摘要，某些执行前错误也没有对应卡片。benchmark 的 API 结果证据补齐了这些情况，但不能把原生卡片数量当成完整工具调用次数。

### 4. Kimi 原生 ACP 把 API 错误报告为正常结束

在真实 Kimi 0.43.0 完成第一组读取之后，让模型端点返回 HTTP 400。它没有发出错误通知，`session/prompt` 返回 `stopReason: end_turn`。其余五个入口正确报告了错误。该问题发生在原生 ACP 的错误报告中，不是读取工具执行失败。

benchmark 现在在清理完请求后检查最后一次带工具的模型请求。未恢复的 API 错误优先于原生运行时的“成功”，不会进入评分检查器；稍后成功的标题请求也不能掩盖错误。同模型重试成功后的正常结果不受影响。证据在 `dist/tools-native-upstream-error.json`。这是 benchmark 的兜底修复，并未修改 Kimi 运行时；普通聊天（API 或订阅）的错误反馈仍依赖原生接口，不能据此宣称该原生缺陷已在所有模式中解决。

### 5. 之前修复的 Codex 问题

第三方模型使用 Codex 的回退能力描述时未获得原生 `apply_patch`，转而调用 Windows 批处理包装器，导致多行补丁报错和重试。参见 [Codex timeout 调查](benchmark-codex-patch-2026-09-16.md)。本次重新验证原生补丁、错误回传和权限拒绝，回归通过。

## 实测覆盖

| 入口与版本 | 读取和搜索 | 原生创建/编辑 | 分段及交错工具调用 | 命令/编辑错误回传 | 权限与取消 |
| --- | --- | --- | --- | --- | --- |
| Claude Code 2.1.270 | 通过 | 通过 | 通过 | 通过 | 允许、拒绝、取消通过 |
| Codex CLI 0.147.0 | 通过，读取/搜索使用原生 shell | 原生 `apply_patch` 通过 | 通过 | 通过 | 补丁拒绝、取消通过 |
| DSH 0.1.5-rc.1 headless | 通过 | 通过 | 通过 | 通过 | 无人值守执行、取消通过 |
| DSH 0.1.5-rc.1 ACP 聊天 | 通过 | 通过 | 通过 | 通过 | 权限升级的允许与拒绝通过 |
| Kimi Code 0.43.0 | 通过 | 通过 | 通过 | 通过 | 允许、拒绝、取消通过 |
| Antigravity SDK 0.1.16 | 通过 | 通过 | 修复后通过 | 通过 | 允许、拒绝、计划模式、取消通过 |

`tools-native-audit.cjs` 的完整模式每个入口执行九次工具调用，共 54 次：两次读取、创建、回读、编辑、命令失败、编辑失败、文件名搜索、内容搜索。验证真实文件内容、空格路径、中文、emoji、引号、反引号、美元符号、换行、调用 ID 和错误证据。CRLF/LF 按各工具的文本文件约定比较，其他字符须一致。

额外覆盖：Antigravity 的本地 MCP echo、Kimi/Codex/Antigravity 的会话恢复与分叉、全部五个跑分进程的上游取消，以及 OpenAI/Anthropic/Responses 路由、签名、用量、同模型故障转移和作用域关闭。

## 重跑命令与范围

```powershell
npm test
npm run test:tools
node tests/tools-native-audit.cjs --permissions
node tests/tools-native-audit.cjs --permissions --allow
node tests/tools-native-audit.cjs --upstream-error
npm run test:codex
npm run test:kimi
npm run test:antigravity
npm run test:benchmark
```

最新工具往返证据保存在 `dist/tools-native-audit.json`，权限证据在 `dist/tools-native-permissions-allow.json` 与 `dist/tools-native-permissions-deny.json`。其中只使用本地假凭证，临时工作区在进程结束后清理。这些测试要求相应原生运行时已安装，不应通过缺少运行时就跳过来宣称验证成功。

本次没有执行真实 Google/Kimi/ChatGPT 账户登录、付费网络搜索、任意用户 MCP 服务、定时任务或子代理委派。它们的账户、网络和扩展权限需要独立验证；本次通过的是已列明的核心调用链。已有账户适配单元测试不等于真实订阅服务验证。完整单元与本地集成测试 219 项通过，以上原生运行时测试也全部通过。

## 对历史 benchmark 的影响

历史结果保留原始分数与诊断。本次没有重新运行付费模型，也没有重算旧成绩。旧结果可能混有集成错误，应在新版中用相同模型、题目、限制和并发模式重跑，再讨论模型或 harness 的强弱。几个引擎同分仍可能来自模型策略或题目边界，不能仅凭同分或超时归因。

## 构建

修复版位于 `dist/harness-tools-audit-20260916/win-unpacked/Camellia.exe`。在线打包下载超时后，使用本机 Electron 39.8.10 重新构建成功；`verify-package.cjs` 确认 110 个打包源文件与工作区一致，运行时安装清单及 Node/npm 校验通过。核查结束时运行中的旧实例尚未切换到此版本。
