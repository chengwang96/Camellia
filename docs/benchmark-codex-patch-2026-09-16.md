# Codex 在 Kimi K3 预览中的补丁重试超时

## 结论

本次超时的直接原因是文件编辑工具连续失败：Codex 把有效的多行补丁交给 Windows 的 `apply_patch.bat`，转发时发生参数截断。模型不断换格式重试，消耗了剩余时间。没有证据表明这一轮主要是推理强度过高；也不是检查器把已完成的代码判成超时。

## 原始记录

报告 `9d64f4e6-bb4a-4307-863b-fb947e9e18eb`，2026-09-16 17:12:51（UTC+8），`kimi-k3` / `kimi-k3:cloud`，Ollama Cloud，Codex CLI 0.147.0。五个引擎并行；每个引擎的三道题共用 270 秒。

| Codex 题目 | 时间 | API 请求 | 已报告 token | 结果 |
| --- | ---: | ---: | ---: | --- |
| slug | 93.001 秒 | 11 | 163,726 | 11/12 检查 |
| reconcile | 57.355 秒 | 5 | 71,145 | 2/2 检查 |
| invoice | 119.725 秒 | 15 | 229,808 | 超时，未修改文件 |

invoice 开始时只剩 119.404 秒。15 次 API 请求的记录耗时合计 103.238 秒，单次约 2.9–16.4 秒；其间多次不到一秒的工具调用返回补丁格式错误。超时瞬间正在执行 `commandExecution`，没有 API 请求在途。

日志反复出现 `Invalid patch: The last line of the patch must be '*** End Patch'`，也有补丁起始行和缺失 UTF-8 参数错误。保存的 `changes` 为空。模型已经识别了计算问题，却一直未能写入修复。

累计 token 包含重复发送及缓存的上下文，不等于思考 token。本轮没有足够的独立推理 token 数据用于判断“思考过度”。

## 实现原因及修复

Codex 对不在模型目录中的名称使用[备用模型配置](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/models-manager/src/model_info.rs)，其中 `apply_patch_tool_type` 为 `None`。[工具注册](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/core/src/tools/spec_plan.rs)因此没有加入原生补丁工具，但备用指令仍要求使用 `apply_patch`。Windows 上的[命令行转发器](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/arg0/src/lib.rs)通过批处理 `%*` 转发参数，多行补丁在这条路径中可能被截断。

Camellia 现在为未知的第三方 API 模型生成 `model_catalog_json`，使用固定版本的备用配置，并启用 Codex 自带的补丁工具。原有模型指令、推理默认值、shell 类型、上下文和截断设置保留；本地 smoke 验证除补丁工具外的工具列表相同，原生指令文本相同（平台换行除外）。已知原生模型、账户模式和用户显式配置的模型目录不受此自动补全影响。

补丁仍由 Codex 原生代码解析、执行和检查权限。Responses 转接层只把完整补丁装入一个 JSON 字符串并还原，不经过 PowerShell 或批处理参数解析。已有 custom-tool 描述也按函数形式说明输入，避免同时要求 JSON 参数和“不要包装 JSON”。

另外，任务详情现在保留工具失败次数、时间及有限长度的输入/错误输出；命令非零退出和原生拒绝权限均显示为工具失败。历史分数和本次计时规则不变。新导出记录标明 `native-apply-patch-v1` 以区分工具配置版本。

## 验证

- Codex 固定原生二进制 + 本地假 API：复现旧批处理路径失败；验证修复后带中文、引号、反引号、美元符号、空格路径的多文件补丁，以及分段流式参数。拒绝原生编辑权限时文件不会创建。还验证了续接、分支、取消、用量和账户隔离。
- Codex/跑分单元测试 32 项、API 路由测试 35 项通过。首次合并执行遇到一项不稳定的请求限额测试并挂起；单独重跑该项及完整 API 测试均通过。
- 无界面的 benchmark UI 测试通过，包括失败次数、错误原文、HTML 按文本显示、窄窗口布局。未控制用户桌面。

## 同一真实模型的诊断复跑

命令：

```powershell
node scripts/benchmark-live-audit.cjs --use-configured-api --preview --codex-only --model=kimi-k3
```

报告 `54312eae-4ba7-4916-bb1c-c5e40a63ec68`，2026-09-16 18:10:07–18:11:53（UTC+8），仍为 `kimi-k3:cloud` / Ollama Cloud / Codex 0.147.0。保持相同题目、检查、三题共享 270 秒、每题 250K token 和 40 次请求；这次只执行 Codex，未重新测其他引擎。

| 题目 | 时间 | API 请求 | 原生补丁完成事件 | 检查 |
| --- | ---: | ---: | ---: | --- |
| slug | 28.477 秒 | 5 | 1 | 12/12 |
| reconcile | 41.200 秒 | 6 | 1 | 2/2 |
| invoice | 36.298 秒 | 5 | 2 | 11/11 |

三题共约 **106 秒**，检查分 **100**，0 次工具失败、0 次超时、0 次运行错误；已报告 **229,752 token**。原始报告位于 `dist/benchmark-audit/live-1789553407422/`，没有替换用户历史记录。

这是单引擎诊断，提供方并发负载与原来的五引擎运行不同，生成本身也有随机性，因此时间差不能全部归因于此修复，也不能用它宣布 Codex 胜过其他引擎。修复的确定性证据是：相同有效补丁在旧调用路径失败，而通过原生补丁工具成功且遵守权限；真实任务也成功使用该工具完成了改动。
