# 按绑定分段的模型切换

更新：2026-10-01。状态：已实现。

## 问题

`c.segments` 的键是引擎，不是模型。用户在同一个会话里来回切模型（`A → B → A`）时，
只有一个原生会话承载所有模型：旧线程被拿去续新模型，Codex 会警告
"This session was recorded with model … but is resuming with …"，跨模型的前缀缓存失效、
首轮重新 prefill。换引擎、换通道、换账号、新纪要、编辑重发都会作废旧段，只有模型切换没有。

## 设计

绑定 = 引擎 + 通道 + 模型 + 账号。每个绑定各留一个原生会话，互不干扰；转录仍是唯一的
追加式 JSONL 真相，绑定段只是它的视图/缓存。切到某个绑定时，若它已有停车段就恢复，
只重放游标之后的公开历史；该模型缺席期间别的模型产生的轮次，用一份纪要搭桥注入。

```
bindingKey = [engine, connection||'api', model||'', subscriptionId||null]
```

`contextWindow`、路由策略等刻意不进 key：它们只影响重放多少历史，不改变原生会话。

## 实现

`src/engines/shared-conversations.js`：

- **停车 / 恢复**：`switchBinding` 把当前段存进 `c.modelSessions`，恢复目标绑定已停车的段
  （`restoreParked`）；恢复的段沿用自身游标。
- **TTL**：停车段超过 `sessionTtlMinutes`（默认 30，1–1440）未用，以
  `retiredReason:'expired'` 退休，改走冷启动重放。
- **容量**：每个引擎最多保留 `sessionLimit` 个（默认 4，1–20）停车段，超出者按最近使用
  以 `retiredReason:'capacity'` 退休。
- **桥接**：恢复停车段后，把它缺席期间的公开轮次交给它。缺席内容超过 `BRIDGE_MIN_CHARS`
  （4000 字符）且路由可用时生成摘要（不超过 `BRIDGE_MAX_CHARS`，1024 输出 token），否则原文重放；
  两种形态都写入 `bridges/`，段上的 `bridgeToSeq` 记录覆盖范围，原生线程追平后清理。
- **fork**：深拷贝 `c.modelSessions`，派生会话保留各绑定的停车段。
- **排序**：`context()` 让稳定可共享的前缀（compact 文件）在前，桥接与重放行在后，重复前缀
  可命中缓存；compact 前缀仅在无原生线程时领衔，避免每轮重复。

TTL 与容量是用户设置（设置 → 模型设置 → 模型会话），经 `preferences()` 钳制；桥接的两个字符
阈值不暴露。

## 默认模型与推理强度：双击快速切换

在设置 → 模型设置中为每个引擎选择快速切换默认模型与推理强度，分别保存到工作台
`quickSwitchModels` 与 `quickSwitchLevels` 配置。设置页用一张三列表格（引擎、模型、
推理强度）对齐所有引擎行；模型列表来自 API 线路与该引擎订阅账号之和，推理强度按所选模型
推断（Claude Code 固定为 off/low/medium/high/max，订阅账号优先使用其上报的等级）。
单击模型菜单打开模型与推理等级选项，双击切到该引擎的默认模型与推理强度；两者都已匹配时
不重复保存，推理强度仅在当前模型支持时才应用。未设置或模型不可用时显示提示。每次双击读取
最新设置，设置修改无需重载聊天页。模型列表不提供右键配对功能或副模型圆点，仅保留当前
选项的对勾。

## 运行中切换

模型与推理等级的修改在轮次运行中也能保存，从下一条消息生效：正在运行的轮次固定在启动时
快照的 settings（`send()` 把它记在 run 上，`this.settings()` 的后续变化不影响它），因此
运行中改模型不会把当前线程切走，也不会让本轮触发的高压压缩换用新模型。

排队消息按“发送时”的选择执行：`drainMessageQueue` 依次调用 `send()`，每次都重新读取当前
会话设置，所以某条消息入队后又改了模型，该条及其后的消息都用修改后的模型。切引擎、连接或
权限模式会改变引擎进程本身，仍需等轮次结束。

## 非目标

- 不承诺跨模型续写与单模型等效；原生段的内部推理不可跨模型迁移。
- 不让原生段跨引擎、跨账号转移。
- 缓存命中与段复用的度量、跨模型等价性 UI 提示仍未做。

## 验证

- 单测 `tests/shared-conversations.test.js`：绑定稳定性、停车/恢复、TTL、容量淘汰、fork、
  桥接、compact 前缀只领衔一次。
- 界面 `tests/shared-chat-ui.py`：默认模型双击切换。
- 可选真实路由冒烟（消耗额度）：`node tests/model-switch-router-smoke.cjs <model-a> <model-b>`。
