# Claude Code GUI 功能复现计划

> 历史规划文档：常驻进程、工作区、目标模式等已在代码中实现；当前模块分工和验证方式见 [开发指南](../development.md)。以下保留最初设计依据。

> 目标：让 `src/renderer/chat/claude.html` 在交互与信息密度上对齐 DeepSeek Harness Web GUI，
> 复现三类核心能力 —— **运行状态指示（Deep diving…）**、**任务列表面板**、**Goal 模式**，
> 并列出顺带的协议升级项。本文只规划，不实现。

调研依据（均已在本机核实）：
- Claude Code `2.1.218`（`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code`），`--help` 实测
- `sdk-tools.d.ts` 工具 schema（TodoWrite / TaskCreate / TaskUpdate / TaskList / EnterPlanMode / ExitPlanMode）
- stream-json 事件流现状见 `src/main/main.js` 的 `spawnClaude()`
- DSH 源码：`dsh-client-ui-conversation`（"Deep diving…" 状态行、todo 面板文案）、`dsh-goal`（目标状态机）、`dsh-tool-todo`（last-wins 投影）、`dsh-client-ui-theme`（设计令牌）
- 会话存储：`~/.claude/projects/<cwd编码>/*.jsonl`

---

## 一、运行状态指示（"正在思考 / 执行工具 / Deep diving"）

### 1.1 信号来源（纯 stream-json 事件推导，无需额外通道）

| 时机 | 事件 | GUI 状态文案（建议） |
|---|---|---|
| 进程已起、会话就绪 | `system` / `subtype=init` | （就绪，不计时） |
| 一轮生成开始 | `stream_event` / `message_start` | 深度工作中…（Deep diving… 的中文对应） |
| 思考块开始/流式中 | `content_block_start{type:thinking}`、`thinking_delta` | 正在思考… |
| 正文块流式中 | `content_block_start{type:text}`、`text_delta` | 正在撰写回复… |
| 工具调用生成完毕 | `content_block_start{type:tool_use}` | 正在准备工具 {name}… |
| 工具执行中 | 上一事件为 tool_use 结束、尚未收到对应 `user`/`tool_result` | 正在执行 {name} {摘要}… |
| 权限/等待（可选） | 长时间无事件且无 stop | 文案后追加 "…" + 秒表 |
| 本轮结束 | `result` | 状态行归零为最终统计 |

要点：

- **计时器阈值对齐 DSH**：DSH 源码中 `showClock = elapsedMs >= 15e3` —— 运行 15 秒后才显示耗时，
  我们沿用同一阈值；状态行 `Deep diving… 3分18秒` 格式 = 文案 + 空格 + 灰色历时。
- **工具进行中文案**：优先取工具输入的语义字段：
  - `activeForm`（TaskCreate/TodoWrite 有）→ 直接用作现在进行时文案（DSH spinner 同款语义）
  - `description`（Bash/PowerShell 有）→ 例如 "Get current date and time"
  - `command` 首行 / `file_path` → 兜底
- **状态展示位置**：DSH 把它放在助手回合文字区域顶部（turn 内、正文前）。
  我们放在 turn 容器顶部，生成中的正文/思考/工具卡片照常在其下方流出。

### 1.2 界面元素

```
┌─ turn ────────────────────────────────┐
│ ● 正在执行 PowerShell "Get-Date"… · 12s│  ← 状态行（蓝点呼吸 + 灰历时）
│ ┌ 💭 思考过程 ──── 进行中… ┐           │
│ └──────────────────────────┘           │
│ <正文 markdown 流式>                    │
│ ┌ 💻 PowerShell · Get-Date… ──── ● ┐   │
│ └──────────────────────────────────┘   │
└────────────────────────────────────────┘
```

- 状态行在收到 `result` 后移除，替换为现有的结果 chip。
- 用户手动停止时状态行变 "已停止"。

---

## 二、任务列表面板（Todo）

### 2.1 信号来源

Claude Code 有两套任务工具，**都要监听**：

1. **TodoWrite**（旧版，仍广泛触发）
   `input.todos = [{ content, status: pending|in_progress|completed, activeForm }]`
   —— 全量替换语义（last-wins），与 DSH `dsh-tool-todo` 的投影规则完全一致。
2. **TaskCreate / TaskUpdate**（新版 Task 系统，支持依赖关系）
   - `TaskCreate`: `subject`, `description`, `activeForm`, `metadata`
   - `TaskUpdate`: `taskId`, `status(pending|in_progress|completed|deleted)`, `addBlocks`, `addBlockedBy`
   - `TaskList` 输出形如 `[{ id, subject, status, owner, blockedBy }]`

解析时机：`content_block_stop` 时 `input_json_delta` 已完整 → `JSON.parse`；
`assistant` 最终消息到达时用 canonical `input` 兜底矫正（防流式丢包）。

### 2.2 面板行为（对齐 DSH 截图）

- 位置：对话列内、当前 turn 上方（或首个 TodoWrite 出现处），卡片式、默认折叠为
  一行摘要：**「📋 任务　1 进行中 · 3 待处理」**，点击展开全部条目。
- 摘要计数规则（DSH 文案）：`{done} 已完成 · {active} 进行中 · {pending} 待处理`，为 0 的段省略。
- 条目渲染：
  - 状态图标：pending=虚线圈 ○、in_progress=蓝色旋转/进度圈（activeForm 显示为进行中文案）、completed=✓ 划线
  - 文案用 `content`（TodoWrite）或 `subject`（Task 系）
- 同一会话内跨轮保留最新快照；点「新会话」清空。
- TodoWrite 工具卡片本身仍正常出现在消息流（它是工具调用），面板是聚合视图，两者不冲突。

### 2.3 数据结构

```js
sessionTodos = {
  source: 'todoWrite' | 'task',   // 最后一次写入的工具系
  items: [{ id?, content, activeForm?, status, blocks?, blockedBy? }],
  updatedAt: number,
};
```

---

## 三、Goal 模式

### 3.1 DSH 的 goal 是什么（调研结论）

DSH `dsh-goal` 是**事件溯源的同会话目标状态机**：
- 动词：create / edit / pause / resume / complete / block / clear
- 状态：objective、phase(active|paused|blocked|complete)、maxGoalRounds、roundsStarted
- 续行（continuation）是进程内的 armed/disarmed：armed 时一轮结束后驱动器自动追加一条
  `user/message`（source=goal）开启下一轮，直到模型调 `update_goal complete/blocked` 或预算耗尽。
- 阻塞条件：同一阻塞条件持续 ≥3 轮 → blocked。
- goal 状态本身**不进模型上下文**，续行提示词由驱动器渲染。

### 3.2 Claude Code 没有 goal —— GUI 层复刻方案

Claude Code CLI 只有 plan 模式（`--permission-mode plan` + EnterPlanMode/ExitPlanMode 工具），
没有自动续行。因此在 **GUI 层（claude.html + main.js）** 实现轻量 goal 循环：

**UI：**
- 输入卡上方加一条可开关的「目标条」：输入目标文本 → 「开始目标」按钮（对应 DSH 的目标输入）。
- 激活后主区顶部显示目标状态卡：`🎯 目标：<objective 摘要>　active · 第 3/10 轮　[暂停] [停止/完成]`。

**驱动（主进程 `src/main/main.js`）：**
```
runGoalRound(n):
  prompt = n === 1 ? objective
                   : 续行提示词模板:
                     "目标：<objective>。这是自动续行第 n 轮（预算 M 轮）。
                      继续推进目标；完成后输出独占行 <goal:complete> 总结；
                      无法推进输出 <goal:blocked> 原因。"
  spawnClaude(-p prompt --resume sessionId …)
  result 到达后:
    - 文本含 <goal:complete> → phase=complete
    - 文本含 <goal:blocked> → phase=blocked
    - 连续 3 轮 result 出错/空输出 → blocked（对齐 DSH 的 3 轮规则）
    - n < M → 间隔 ~1s 后 runGoalRound(n+1)
    - n == M → blocked(reason=rounds-exhausted)
```

**完成判定两个备选：**
- A. 标记词启发式（上面方案）：零额外开销，依赖提示词约束
- B. 判定器：`claude -p "评估目标是否完成…" --json-schema {...}` 独立调用做结构化裁决
  （`--json-schema` 已在 2.1.218 确认存在）—— 更可靠但每轮多一次调用
- 计划里先 A，B 作为第二阶段增强。

**持久化**：goal 状态存 `desktop-config.json`（或独立 `claude-goal.json`），
应用重启后可「恢复续行」——对齐 DSH “resume 需要显式重武装”的语义：重启后默认不自动续跑，
需要用户点「继续」。

### 3.3 与 plan 模式的关系（顺带并入）

plan 模式可作为独立功能加入头部标签（对应 DSH "标准模式" 标签）：
- `--permission-mode plan` 生效时头部胶囊变「计划模式」；
- 拦截 `ExitPlanMode` 工具调用时弹「批准计划并执行？」卡片（对应 GUI 已有 ask_user_question 场景）。

---

## 四、顺带的协议升级项（计划内单列，按收益排序)

1. **`--effort low|medium|high|xhigh|max`**（2.1.218 实测存在）
   比 `MAX_THINKING_TOKENS` 更贴近 DSH「推理等级」语义。迁移映射：
   Default→省略、Off→`MAX_THINKING_TOKENS=0`、Low→low、Medium→medium、High→high、Max→max。
   ⚠️ 待验证：ollama 云代理是否透传该参数（第三方模型可能忽略）。
2. **`--input-format stream-json` 常驻进程**（收益最大，改造量也最大）
   一个会话一个长驻 CLI 进程，后续消息写 stdin，配合 `--replay-user-messages`：
   - 免去每轮 spawn 开销与系统提示重建；
   - 可用 control_request 实现 GUI 原生权限问答弹窗（对齐 DSH ask_user_question 卡片）；
   - 停止按钮从 kill 进程变为发 interrupt 控制消息（更优雅）。
   ⚠️ 需要重写 `spawnClaude` 为 `ClaudeSession` 类（stdin 写入协议、消息 id 路由、心跳）。
3. **`--prompt-suggestions true`**：每轮结束 CLI 给出下一句建议 → 输入框下方灰色建议行，点击填入。
4. **真实会话历史侧栏**：扫 `~/.claude/projects/**/ *.jsonl`，取首条用户消息做标题、mtime 排序，
   点击后 `--resume <id>` 恢复（对应 DSH 侧栏工作区会话列表）。
5. **`--include-hook-events`**：若用户配了 hooks，消息流中可显示 hook 生命周期（低优先级）。
6. **上下文用量弹层精确化**：result 事件的 `usage` 有 `input_tokens/cache_read_input_tokens/
   cache_creation_input_tokens/output_tokens`，足够做「上一轮用量」；
   但 DSH 的「上下文已用 18%（系统提示词/工具/对话消息分段）」需要 `/context` 数据，
   headless 拿不到 —— 计划内标注为「不做或估算」。

---

## 五、实施阶段划分

| 阶段 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| P0 | 运行状态行（思考/工具/Deep diving + 15s 阈值历时） | 无，纯前端事件映射 | 小 |
| P0 | Todo/Task 面板（TodoWrite + TaskCreate/Update 双通道） | 无 | 中 |
| P1 | 推理等级迁移到 `--effort`（含 ollama 透传验证） | 需实测 | 小 |
| P1 | 侧栏真实会话历史 + resume | main.js 读 jsonl | 中 |
| P2 | Goal 模式（标记词判定 + 预算 + 状态卡 + 持久化） | main.js 驱动循环 | 中大 |
| P2 | Plan 模式标签 + ExitPlanMode 批准卡片 | 权限问答通道 | 中 |
| P3 | `--input-format stream-json` 常驻进程 + 权限弹窗 + prompt 建议 | 重写 spawnClaude | 大 |
| P3 | 判定器版 goal 完成判定（--json-schema） | P2 | 中 |

每阶段独立可发布；P0 不依赖任何 main.js 协议改动，可先做。

---

## 六、风险与待验证清单

- [ ] `--effort` 经 ollama 云（ANTHROPIC_BASE_URL=https://ollama.com）是否生效
- [ ] `--input-format stream-json` 在 Windows spawn + shell 模式下的 stdin 协议稳定性
- [ ] Task 系工具在 `-p` headless 下是否默认启用（可能需 `--allowedTools` 显式放行）
- [ ] TodoWrite 在非默认 permission-mode 下是否触发权限拦截（acceptEdits 已覆盖则无碍）
- [ ] goal 标记词在流式中的误判（正文提到 `<goal:complete>` 字面量时）——判定前去掉代码块内容再匹配
- [ ] `~/.claude/projects` jsonl 行结构版本差异（title 字段在 2.x 未必在首行）
