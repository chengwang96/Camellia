# Conversation control / 会话控制

Camellia exposes eight conversation-scoped tools through its existing authenticated local MCP bridge: `camellia_conversation_list`, `models`, `create`, `fork`, `configure`, `send`, `read`, and `cancel` (each with the `camellia_conversation_` prefix). They operate on the current conversation and its directly owned children, not unrelated conversations.

## Examples / 示例

- “新建一个会话，先列出可用模型，选择其中一个模型和思维强度，让它检查测试覆盖率；不要修改文件，完成后读取结果。”
- “Fork 当前对话，让子会话检查另一种实现方案。我们共享工作目录，不要同时修改同一个文件。”
- “Create a child conversation, choose an available model and thinking level, ask it to review the tests, and read its result.”
- “停止刚才创建的子会话。” / “Cancel the child response.”

The model first discovers the configured catalog, creates or forks a child, optionally configures its model/thinking level, then sends a prompt. Creation alone does not start inference. Send returns immediately; poll `read` for bounded messages and request states, including startup errors. A run ID may not exist until startup completes. If the parent turn finishes first, a later user turn can inspect its children again.

模型先查询可用目录，再创建或分叉会话、设置模型和思维强度、发送消息。创建本身不会调用模型。发送是异步的；通过 `read` 查看最近消息、请求状态和启动错误，不要反复发送相同任务。父会话结束后，后续用户回合仍可读取它创建的子会话。

## Boundaries / 边界

- Children inherit workspace, engine, connection and permission mode. Model and thinking changes are child-local; global defaults, accounts, keys and permissions are not editable through these tools. Configuration requires an idle child. API thinking choices match the existing UI policy; subscription choices come only from account catalog metadata. An empty thinking string selects the engine default.
- Fork copies committed visible history, including the current user request, but excludes in-flight assistant output, tools, internal summaries, native session identity, goals and scheduled tasks. It is **not** a worktree or filesystem copy. Children share files; coordinate writes explicitly.
- Children run independently and may consume provider quota. Stopping the parent does not stop its children; cancel unwanted child work explicitly. Existing approval prompts still apply. Tool-created children cannot recursively control conversations or create/modify Goals or scheduled tasks. Scheduled checks cannot control children either.
- Requests require the current turn token. Reuse a stable `request_id` when retrying create/fork/send; changing its arguments is rejected. Limits: 8 retained children per parent, 32 new sends per parent turn, 256 recorded sends per child. Reads return at most 8 messages (4,000 characters each) and the 8 most recent request states. The UI retains the full conversation history.
- Startup is reserved before preparation/compaction, preventing overlapping sends, configuration and deletion. Cancellation or shutdown prevents delayed dispatch. On restart, unfinished request records become `interrupted`; work is not automatically resent.
- Supported: Claude, Codex, DSH, Kimi, and Antigravity shared API routes. Antigravity Google subscription does not expose these tools because its CLI lacks safe per-session MCP configuration.

子会话继承工作区、引擎、连接和权限，仅可局部修改模型及思维强度。分叉不隔离文件；子任务独立运行并可能计费，停止父会话不会连带停止子任务。禁止递归会话控制及子会话自行创建 Goal/定时任务。重启后未完成请求标记为中断，不自动重发。Antigravity Google 订阅暂不支持。
