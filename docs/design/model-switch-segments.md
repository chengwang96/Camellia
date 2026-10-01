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

TTL 与容量是用户设置（设置 → 通用 → 共享会话），经 `preferences()` 钳制；桥接的两个字符
阈值不暴露。

## 主/副模型：双击切换

`src/renderer/chat/claude.js` 用 `localStorage` 的 `modelSwap:<engine>` 记一对模型。
**左键**选主模型并关菜单；**右键**设副模型，菜单不关、当前模型不变；**双击**模型按钮在
两者间切换（配对不可用时退回打开菜单）。

不变式：主、副必须不同，主模型始终是当前正在使用的模型，派生副模型时只取存储里不等于当前
模型的那个。左键点到副模型、或右键当前副模型，都会清除副模型。副模型圆点与主模型对勾共用
一个右侧列，标题用 `i18n` 文案。

## 非目标

- 不承诺跨模型续写与单模型等效；原生段的内部推理不可跨模型迁移。
- 不让原生段跨引擎、跨账号转移。
- 缓存命中与段复用的度量、跨模型等价性 UI 提示仍未做。

## 验证

- 单测 `tests/shared-conversations.test.js`：绑定稳定性、停车/恢复、TTL、容量淘汰、fork、
  桥接、compact 前缀只领衔一次。
- 界面 `tests/shared-chat-ui.py`：主/副模型与双击切换。
- 可选真实路由冒烟（消耗额度）：`node tests/model-switch-router-smoke.cjs <model-a> <model-b>`。
