# Agent 讨论 P0：连接与能力核实

当前状态（2026-10-02 后续开发）：六条 API 与三条已有订阅路径已开放原生工具和文件协作，Codex/Kimi/Antigravity 订阅的图片输入另有真实证据，Antigravity 订阅已实测群内人工审批回传。最新能力边界、验证方式见[工具及输入实现记录](group-chat-rich-interaction-plan.md)。本文后续 P0 描述及探针结果是早期纯文本阶段的历史记录，不代表当前仍禁用 CLI 订阅或一般工具。

更新：2026-10-02（真实连接接入）。对应[实施计划](group-chat-implementation-plan.md) P0；首版以其中的 v1 冻结范围、V1-01–08 和 P2 退出条件为准。生产服务已接入 Codex 0.154.0 API/订阅及 Antigravity SDK 0.1.17 API，选定绑定经真实两次短消息和停止核实后在本次运行中启用。三条路径已分别通过真实双成员串行、续聊和停止；CLI 订阅仍未启用，完整 v1 未验收。较早模块/清理/普通回归数量及下方探针记录保留为历史结果，不能与本次真实网络证据混为一谈。

## v1 连接验证边界

只在 Windows 10+ 验证下列四条路径，按每条一个已配置绑定及同 harness 双模型样例推进，不穷举所有模型/账号。每群最多 4 名未移除成员，API、订阅与混合都是首版范围；其他 harness 和平台延期。

| 路径 | 当前证据所用运行时 | 仍需完成的首版证据 |
| --- | --- | --- |
| Codex API | CLI 0.154.0；deepseek-flash 真实 API | 已接入固定 key、零工具策略、双成员真实往返/续聊/停止；摘要和异常恢复待验 |
| Codex 订阅 | CLI 0.154.0；GPT-6-Astra 真实订阅 | 固定选中账号、独立状态、双成员真实往返/续聊/停止通过；仅订阅摘要与异常恢复待验 |
| Antigravity API | SDK 0.1.17；deepseek-flash 真实 API | tool-free、固定 key、专属状态、双成员真实往返/续聊/停止已接入；摘要和异常恢复待验 |
| Antigravity 订阅 | CLI 1.2.3 | 解决已复现的 MCP 启动/残留工具问题，验证固定订阅账号、真实往返、停止及摘要；SDK API 证据不能代替 |

首版限定应用专属运行配置与状态目录，只新建成员和恢复其自有会话，不导入旧原生历史，不支持外部自定义 home、数据库重定向或共享讨论状态目录。冻结范围并不自动满足现有“完整来源”检查：需要后续实现证明所选进程只能访问范围内状态；如运行时仍触达共享配置/历史或扩展，必须隔离或拒绝，不伪造 complete，不修改用户全局权限。

当前核心双订阅仍有明确阻塞。优先提供最小复现与受限启动路径的正反对照，复用已有 Job/归属/调度模块；不继续以其他平台、所有外部目录和旧缓存格式的发现为首版前置条件。两个连续开发回合无验收进展时按实施计划记录阻塞并转做独立的上下文/页面工作，不能把 API 版本或模拟结果报为首版完成。

## 完整产品驱动清单（不等于 v1 范围）

目标同时包括 API、订阅，以及二者混合的群。connection 是成员属性，不是全群设置。订阅验证指检查该驱动在群聊场景下的行为，不是新增订阅购买、凭据转换或 API 替代功能。

以下为当前 Camellia 全部驱动的盘点，不是厂商产品能力声明或首版必做列表；v1 仅开放上表核实通过的绑定：

| Harness | API | 订阅 | 群聊需补齐的边界 |
| --- | --- | --- | --- |
| Claude | 已有路径 | 当前统一目录未提供 | 工具白名单、外部 MCP 副作用与进程停止验证 |
| Codex | 已有路径 | 已有路径 | 文件 read-only 与外部工具限制分别验证；不能仅套用 plan 回答模式 |
| DSH | 已有路径 | 当前未接入 | read-only 预设仍包含审批语义，讨论必须禁止提升写权限 |
| Kimi | 已有路径 | 已有路径 | ACP 模式不能仅按名称判定安全，需要实际工具限制验证 |
| Antigravity | SDK 路径 | CLI 路径 | SDK 无工具入口已有本地证据；CLI action(*) 规则已拒绝 5 类调用，但 MCP 启动和残留工具未受完整隔离，生产绑定关闭 |
| Pi | 已有路径 | 当前未接入 | ask/auto/full 不是讨论工具白名单 |

来源：`src/engines/conversation-models.js`、各引擎 ensureSession、`permission-levels.js`。API 模型取已启用路由；订阅模型取所选账户目录，不应硬编码某一模型或把 API 目录当作订阅目录。相同配置的成员仍须不同运行 UUID。

## 已有 P0 验证证据

- Windows，本地 Node 测试：session-pool、conversation-models、codex、codex-compaction、antigravity、antigravity-subscription、antigravity-permission-notice、compaction-plan，共 83 项通过。
- `node --test tests/shared-conversations.test.js`：251 项通过。覆盖单聊分段、压缩、迁移及恢复；不能替代未来群聊并行测试。
- `node tests/codex-smoke.cjs`：原生 CLI + 本地模型服务通过。覆盖补丁、审批拒绝、续聊、fork、取消、线路切换和用量。仓库固定包版本为 0.154.0；这不是 ChatGPT OAuth 请求验证。
- `node tests/antigravity-subscription-smoke.cjs`：原生 CLI 1.2.3 + 本地 Gemini 协议服务通过。覆盖目录解析、流式输出、原生续聊、写入、明确规则拒绝、取消及恢复。测试使用独立临时 profile，不使用 Google 账号；没有验证真实订阅登录、配额或模型可用性。
- 新增可复现探针：`node tests/antigravity-subscription-smoke.cjs runtimes/antigravity --discussion-probe`。验证第二成员的新原生 ID 及输入不含前一成员历史，列出 plan 工具，并在独立临时目录尝试文件写入；日志明确报告是否执行，不能把探针退出成功理解为强制只读通过。

探针实测结果：`DISCUSSION PROBE plan write executed: true`。移除前一测试的显式审批规则后，plan 模式实际创建了临时工作区内的 `discussion-plan.txt`。因此当前 CLI plan 不能满足强制只读要求；此结论限于上述版本与测试配置。

CLI 1.2.3 的 plan 请求仍暴露 `run_command`、`write_to_file`、`replace_file_content`、`generate_image` 等工具。暴露不等于一定允许执行，但已经说明不能用“没有写工具”的假设实现群聊。`--help` 提供 plan 与 sandbox，未展示禁用全部工具的参数；这不证明其他配置接口不存在。不得修改用户全局 MCP/权限来实现成员隔离。

## P0/P2 执行限制补充（此前本地运行时证据）

SDK 增加显式 `executionPolicy='tool-free-v1'` 启动入口。它独立于普通 native settings 和 permissionMode；主进程及 Python 桥接均限制 SDK 0.1.17。空工具白名单、关闭子代理与执行前 deny-all 一起生效，拒绝原生 MCP/skills 配置、ACP MCP 注入及提升权限模式。普通聊天没有显式参数时维持原路径；没有注册生产策略或修改用户全局设置。

`node tests/discussion-antigravity-tool-free-smoke.cjs` 第 9 轮在 **SDK 0.1.17 通过**，本轮未修改 SDK 桥接或重跑该探针。先从普通原生请求核对写入、替换、命令、子代理的实际工具名，避免把 SDK 枚举名误作协议名；普通对照只接收本地文本。随后实际受限请求没有工具，强制返回这四种工具及原生 `call_mcp_tool` 会话控制调用，均得到明确拒绝，工作区文件未变化。重启续聊保持限制；`/compact` 以字面文本进入模型请求；MCP 注入和 3 种提升模式被拒绝，没有审批待办。证据：**advertisedTools=0、nativeToolNamesValidated=4、forcedCallsRejected=5、workspaceUnchanged=true、resumed=true、literalCommandPreserved=true、loopbackReplies=14、stoppedJobs=3、realModelCalls=0**。直接连接本地模拟模型，未通过 API 路由器过滤工具；3 个 Windows Job 均核实零活动。

**第 10 轮更正旧 CLI 结论：撤销裸 `permissions.deny=["*"]` 的显式拒绝证明。** 旧探针的文件拒绝来自无界面默认审批，旧 `SafeToAutoRun` 命令参数会被当前工具 schema 拒绝，宽泛的 “not allowed” 匹配误把参数错误当成权限证据。现探针移除无效参数，必须收到 `Matches user-configured deny rule`，并核对文件和本地 URL 访问。规则语法依据官方[CLI 权限说明](https://www.antigravity.google/docs/permissions?tab=cli)的 `action(target)` 定义，再由固定运行时验证。

`node tests/discussion-antigravity-cli-policy-smoke.cjs` 第 10 轮在 **CLI 1.2.3 通过**。临时 profile 使用 `read_file(*)`、`write_file(*)`、`command(*)`、`unsandboxed(*)`、`read_url(*)`、`execute_url(*)`、`mcp(*)`；同时加入相同 Allow/Ask 规则及自动放行设置。原生写入、替换、命令、读取和 URL 五类调用均明确命中 Deny；重启续聊再次写入也被拒绝，无待处理审批。证据：**explicitRulesMatched=5、denyOverridesAllowAskAndProceed=true、resumedDenialVerified=true、workspaceUnchanged=true、urlReads=0、loopbackReplies=13、stoppedJobs=2、realModelCalls=0**。没有把未调用的其他类别计为通过。

反例 `node tests/discussion-antigravity-cli-policy-smoke.cjs bare-wildcard` 也通过预期检查：裸 `*` 与 Allow/自动放行组合下实际新建、替换并通过命令写了临时 canary 文件，本地 URL 被访问。证据：**explicitRulesMatched=0、workspaceUnchanged=false、urlReads=2、loopbackReplies=11、stoppedJobs=1、realModelCalls=0**。这是错误规则未产生隔离的反例，不是生产权限验收。

`subscriptionSpawnSpec` 新增显式 `literalInput=true`，限制 CLI 1.2.3，桥接传 `--disable-slash-commands`。继承环境不能选择它，普通聊天默认不启用。该原生参数会使 `--mode plan` 无效，因此桥接在启动 CLI 前拒绝 literalInput 与非 default 模式组合；工具限制必须由独立执行策略提供，不能把文字输入保护当作只读策略。

`node tests/discussion-antigravity-extension-smoke.cjs` 第 10 轮通过。依据官方 [MCP 配置来源](https://www.antigravity.google/docs/mcp/)、[skills](https://www.antigravity.google/docs/skills/) 和[自定义主 Agent](https://www.antigravity.google/docs/subagents/)设置隔离 canary。完整 Deny 规则仍会启动 profile 与工作区 MCP。正常对照确实展开 skill；literalInput 保留原文并阻止该展开，但不阻止 MCP 启动。选择带专属提示标记的主 Agent，配置 `tools: []`、`subagent: false`、`inheritCustomizations: false` 后，仍启动 MCP，并暴露 **call_mcp_tool、list_resources、read_resource、manage_task**。SDK tool-free 在相同文件配置下没有启动 MCP、没有展开 skill、请求无工具；此结论仅覆盖探针中的配置位置。证据：**loopbackReplies=7、stoppedJobs=4、realModelCalls=0**；所有 MCP canary 只执行启动/发现，没有工具调用。按官方 [hook 配置](https://www.antigravity.google/docs/hooks/)放置的 canary 未观察到运行，也没有有效正向对照，故 **hookCoverageVerified=false**，不能声称 hook 已受限。

以上均为隔离 profile、本地协议响应，没有真实账号、付费推理或讨论群。SDK 执行入口尚需与固定线路/账号、来源检查、监督/恢复及应用生命周期组成完整策略；CLI 的扩展启动、插件/hooks、残留工具和固定订阅账号仍未形成完整策略。两条连接均没有生产能力证据。`discussion-antigravity-policy.test.js` 现 **4 项测试**，新增 CLI 显式文字输入与版本固定；桥接新建/续聊的参数和模式冲突由下述握手测试覆盖。

## P1 当前记录格式与容量边界（本地文件测试）

新增 discussion-store 的 **18 项测试**，与 discussions 的 24 项及 scheduler 的 33 项共同验证当前 v1 schema、原子提交、公开日志/请求身份不可改写、幂等不写盘、损坏关联/存储身份、异步 callback、UTF-8 转义字节、读取中增长/替换/新增文件、硬链接、队列/历史/退休/库存数量上限及收尾空间。容量恢复不自动重投；超大固定输入不打开原生会话，超大最终回复先判失败再排空。模拟停止声明仍不能充当生产停止证明。

读/list/create/update 共用单群 **32 MiB**；公开消息/回复 **256 KiB**、固定输入 **1 MiB**（字符串均按含 JSON 引号与转义的 UTF-8 计量）。每群保留成员 64、未结束 Delivery 128、请求 10000、消息与 Delivery 各 20000；每成员退休 session 1024。库存最多 1024 群、4096 目录项、256 MiB。新准入要给活动留出提交/停止/恢复空间，超限保留旧记录并明确拒绝。这些是当前存储策略，不是模型 token 窗口；P3 预算、摘要和附件尚未交付，新增格式须同步调整校验和预留。

清理使用统一的有界讨论读取器；相关 **42 项清理回归通过**。主进程单写者和完整快照重写的限制保留，应用接入及大规模性能未验收。

## P2 适配层补充证据（模拟）

- `discussion-antigravity-policy`、`discussion-antigravity-prepare`、`discussion-native-storage`、`discussion-antigravity-inventory`、`discussion-codex-inventory`、`discussion-native-inventory`、`discussion-native-access`、`discussion-native-launch`、`discussion-adapter-registry`、`discussion-native-ownership`、`discussion-native-adapter`、`discussion-scheduler`、`discussions`、`discussion-store`、`discussion-capabilities`、`session-pool`、`conversation-models` 十七文件当前 **239 项通过**（4/9/19/20/28/17/9/12/6/6/26/33/24/18/3/2/3；取代前轮 218 项）。最后加入 storage-cleanup 一起执行，共 **281 项通过**。原生适配层继续使用仓库驱动类、应用边界、可信注册表与内存 JSON-RPC 服务验证重复绑定、API/订阅混合、续聊、公开文本和释放语义。实际数据库缺失、重定向和竞争回归保留；新增 P1 检查不能转化为生产能力证据。
- 已有 17 项应用归属清单测试，覆盖磁盘/内存并集、被普通加载器忽略的坏索引、当前/停放/退休段、live/dead/legacy 池项、外部记录、未提交镜像、孤立 journal、扫描变化、链接、数量/字节边界、异步来源和 Windows 大小写。准备期间出现的外部历史即使后来被新进程返回也不能认领；另有适配层回归确认发送次数为零。跨 VM 普通字典兼容，Map/类实例继续拒绝。
- 新增故障测试验证写盘失败仍取消且限制新派发、结果意图/最终提交失败可显式复查且不重发、串行后继等待提交核查、异步观察器拒绝及被驱动吞掉的事件保存失败。启动抛错且没有句柄仍需独立停止证明；同 runtimeId 的旧 Delivery 证明不能释放新一轮。以上停止证明均为合成声明。
- 已有归属测试覆盖普通会话当前/停放/退休段、已移除成员、外部原生记录、准备期间归属变化和失败读取；注册测试覆盖证据快照、撤销准备中的活动、等待停止才能替换以及跨注册旧事件。生命周期测试覆盖按账号停止且不影响其他账号、网络/运行时限制叠加、退出永久限制、读取失败仍取消及重启恢复。重启证明必须匹配实际中断 Delivery；不能复用同一原生会话旧回合证明，也不能按串行 retry 的数组位置推断执行顺序。
- 当前 12 项独立启动测试覆盖 Codex/Antigravity 各自 API 和订阅、完整显式设置、固定账户及续聊连接、不可伪造/转移/复用的启动凭据，以及整体 shutdown 保留讨论槽；新增两项验证池释放后的持久化归属检查。另有 9 项入口测试覆盖重启、移除/退休、跨引擎运行 ID、普通删除、损坏记录、异步检查拒绝、未持久化 tombstone、Windows 大小写及独立启动记录保护。使用本地合成账号缓存和内存传输，不证明真实账号、进程或执行限制。
- 本轮普通路径回归 `codex`、`acp-session`、`antigravity`、`antigravity-subscription`、`storage-cleanup` 五文件 **118 项通过**；清理 42 项与上组重合，不累加。前轮策略/握手等六文件 66 项及更早九文件 377 项通过/1 项 Linux 专项跳过保留为历史结果，本轮未整组重跑。服务端仍只有普通入口保护，没有讨论派发。
- 上述模块测试的正向门控与停止确认使用明确标为测试用途的合成数据。适配层要求可信 `prepare`、`verify`、`confirmStopped` 策略和共享归属注册表；`prepare` 接收本轮 identity，必须返回显式 settings 及同步 `launch.buildSpec`/受监督 `launch.spawn`。可信适配器注册模块已实现，但没有生产策略或证据条目。普通入口与原生删除的反向检查、讨论快照和启动记录的清理保护已接入；桌面已组合应用索引/内存/池/镜像清单、共享 tombstone、空注册表及事件分流。Codex 标准来源及显式重定向读取、Antigravity 存储映射/实际数据库核验已实现；存储身份准入/持久化/反向接口和无输入准备已有本地证据。全部配置层/历史重定向、完整外部目录/活动及生产来源回调仍待接通，不能把应用镜像或单个读取器当作完整覆盖。因此正向归属 reservation 仍拒绝，空注册表没有生产绑定。账号/网络/运行时/退出及启动恢复处理器仍待完成。模拟结果不证明真实子进程终止；独立的 Windows 本地实进程证据见下节，生产 CLI 验收仍缺失。
- 接线审查：此前发现的 `codex.js`、`antigravity.js` 全局 connection 回写已在讨论专用路径禁用，普通聊天行为保留；讨论设置与启动参数绕开普通全局默认值。显式 launcher 只是限制和监督接入点。整体会话池 shutdown 现在保留讨论句柄，仍不能作为完整后代停止证明。
- 当前能力门控已接调度和适配层，缺证据、绑定/运行时/策略不匹配或异步准备后撤回证据时均拒绝调用。不可用目标保存失败原因，证据恢复后不自动补发。此结果证明默认关闭和生命周期行为，不补齐 P0 的真实只读、账户固定或停止证据；所有真实连接继续未开放。

## P2 Codex 原生库存（原始索引与本地 CLI）

`codex-history-inventory.js` 当前有 **28 项 SQLite/文件测试**：全部 threads.id（包括归档、未命名、子会话和缺失 rollout 的记录）、活动/归档 rollout 元数据、WAL 未提交/并发提交、源文件只读、孤立账号/运行目录、跨 home 重复 ID、部分/未知/损坏记录、链接和数量/字节/深度上限。数据库只在独立临时副本上执行查询，Windows 活动 SHM 的锁区不读作内容。标准目录枚举使用原始账号配置，并包含磁盘孤立目录，外部/策略 home 须明确给出。

读取 home 的 config.toml、内嵌 profiles 和独立 *.config.toml，保留每个绝对 sqlite_home、默认目录和未选中的声明。可信调用方可用 `{ home, sqliteHomes, configFiles }` 传入已解析环境/命令行目录及额外配置层；相同 home 合并声明。配置相对/~ 路径、缺失显式配置、未知结构、链接、变化或超限均拒绝，不猜测原生 cwd、不读取宿主环境。官方[配置定义](https://learn.chatgpt.com/docs/config-file/config-reference)说明 sqlite_home 可指定数据库位置；[环境变量说明](https://learn.chatgpt.com/docs/config-file/environment-variables)说明配置优先于 CODEX_SQLITE_HOME，环境相对路径按 cwd 解析。官方文档可能领先固定运行时，相关行为另用下述探针核实。

此前运行 `node tests/discussion-codex-inventory-smoke.cjs`：**Codex CLI 0.154.0 通过**。只创建线程并停止时，原始库存尚不含该 ID（freshThreadOnlyModelRequests=0）；归档本地模拟回复后验证归档 ID。另用两个隔离 home 核实相对环境目录及配置覆盖环境目录，独立读取重定向数据库的线程身份：**relativeEnvironmentRedirectVerified=true、configOverridesEnvironmentVerified=true、redirectedDatabasesVerified=2、loopbackReplies=3、archivedNativeIdVerified=true、stoppedJobs=4、realModelCalls=0**。4 个 Job 均核实停止。本轮未重跑；不是生产账号、真实模型、强制无副作用或群聊验收，未创建真实讨论群。

此前另跑 `node --test tests/codex-desktop-import.test.js tests/subscription-accounts.test.js tests/codex.test.js`，**61 项通过、1 项跳过、0 失败**。跳过的是当前系统不支持创建目录符号链接的导入路径测试。此执行独立于当前模块、探针及普通回归，不累加次数。

Codex 全部配置层、相对配置路径、历史重定向、外部 home 与活动的完整发现仍待核实；显式读取接口和上述两种运行时行为不构成完整来源证明。Antigravity 的底层关系已有下节本地证据，现已接入准入与持久化/恢复读取接口，无输入准备已有本地证据，生产来源和执行策略仍未配置。不得根据表面 ID 或应用镜像推断完整原生归属；跨 harness 订阅仍是核心范围。

## P2 Antigravity 原生存储映射（SQLite 与本地运行时）

`antigravity-history-inventory.js` 当前有 **20 项测试**：SDK 副本、CLI 桥接别名、完整 conversation_summaries 及父级/获胜记录引用、孤立原生数据库与 brain/annotations/presence、未派发桥接/缺失文件、存储作用域歧义、CLI cascade/产品命名空间、WAL 未提交及并发提交、源文件只读、未知/损坏/部分记录、链接/硬链接、重定向和条目/字节限制。返回 bridges 与 histories，保留 storageDir 和 conversationId；SQL 在独立临时副本执行，源 SHM 的锁区不读作内容。不同存储目录不会因为底层 SDK ID 相同而被合并。新增 databaseVerified 仅在对应数据库通过身份核查时为 true；桥接/summary/父级或 cascade 引用只能保留归属，不能授权输入。

`node tests/discussion-antigravity-inventory-smoke.cjs` 在 **SDK 0.1.17 / CLI 1.2.3 通过**。SDK fork 的底层 ID 与原会话相同，但原目录续聊不含 fork 的新消息；复制 CLI 桥接并改为另一个 agy-* ID 后，仍恢复同一个原生历史。实际 CLI 文件以 conversationId/cascade_id 命名，内部 trajectory_id 不同；索引 app_data_dir 保存 antigravity-cli 产品命名空间。读取器核查得到 **mappedBridges=4、storageHistories=3、cliAliasAdmissionBlocked=true、sdkIndependentClaims=2、loopbackReplies=6、stoppedJobs=5、realModelCalls=0**。本地回复包括运行时的辅助请求；5 个 Windows Job 均核实活动计数归零。未创建真实讨论群、未登录真实账号，不构成生产只读、账号隔离或跨 harness 真实混合群验收。

更早相关回归 `node --test tests/antigravity.test.js tests/antigravity-subscription.test.js tests/acp-session.test.js tests/antigravity-permission-notice.test.js`：**41 项通过、0 跳过、0 失败**。其后已有九文件回归；本轮普通路径验证以本节前述五文件 118 项为准。

读取器要求显式的桥接 home、对应 CLI dataDir、外部 CLI 目录及 SDK save_dir，不读取凭据，不自动发现全部来源，也不返回 complete。旧缓存/protobuf 索引、非标准目录与外部活动来源尚未核实。存储身份已接入准入/tombstone、started 持久化、恢复读取和普通别名检查，并新增下述无输入准备握手。生产 external/反向来源回调及执行策略尚未完成，因此绑定继续关闭；不得把这些本地接口测试当作生产隔离验收。

## P2 存储身份准入与恢复记录

native-storage.js 当前有 **19 项测试**，覆盖 CLI 别名/未归属别名、SDK 独立存储、准备前/期间见过的外部存储、停止后 tombstone、重启和退休保留、映射改变、异步/不完整来源、坏字段及跨连接记录。数据库缺失时拒绝认领/发送、同时继续保护归属的回归继续通过；storageVerified 仅来自当前原始读取器的 databaseVerified=true，旧拓扑缺少此字段不能授权。三项适配器测试确认缺身份或启动确认拒绝时模型输入发送次数为零，旧续聊必须提供已保存身份。started 事务保存成员及 Delivery 的 nativeStorage，后续同 generation 不可换存储；混合 Codex/ACP 测试明确使用合成拓扑，并继续验证同绑定双成员与续聊。

普通入口已有可信同步 nativeStorage 回调接口：已保存身份在原桥接消失后仍能阻止新别名接管。存在受保护 Antigravity 历史时，无法核实映射则拒绝相关普通续聊/删除；新建普通会话仍可准入。主进程/CLI 的生产来源回调尚未配置。清理所有者集合纳入底层 conversationId，本轮 42 项清理测试通过。

此前 Antigravity 存储探针将实际临时数据库读出的 4 个桥接和 3 份存储投射进 NativeSessionOwnership，CLI 别名被拒绝、两份 SDK 存储可分别认领。这是原生布局与本地检查器的联合证据，没有通过生产策略启动真实讨论；本轮未重跑该存储探针。

## P2 Antigravity 无输入准备

SDK/CLI 桥接增加 session/camellia_prepare；AcpSession 校验回传的桥接/底层 ID，讨论适配器再与可信原始存储映射比对，started 同步保存后才发送用户输入。普通聊天未调用此握手时仍按原路径启动。准备后禁止切换模型、模式及会话；失败、取消或停止不自动重试。

SDK 0.1.17 的公开 conversation_id 在握手后仍为空，但独立 save_dir 已有数据库；桥接只接受唯一的合法数据库文件身份，主进程读取器另行核对 SQLite。LocalOpenAIAgentConfig 未透传 session_continuation_mode，本地尝试给定新 ID 会被按缺失续聊拒绝，因此没有使用该参数或修改安装包来伪造预分配证明。CLI 1.2.3 则在输入前发 init，桥接核查不可换 ID 并保存映射。

node tests/discussion-antigravity-prepare-smoke.cjs 第 10 轮在上述版本重跑通过，本轮未重跑：sdkIdentityBeforeInput=true、cliIdentityBeforeInput=true、resumedWithoutInput=2、persistedHistoriesBeforeInput=2、closedDuringPreparation=2、modelRequests=0、stoppedJobs=6、realModelCalls=0，继续核查实际数据库。临时 profile、无账号，唯一模型端点为拒绝所有请求的本地服务；6 个 Windows Job 均确认零活动。独立存储探针前文 6 次本地回复和 5 个 Job 也保留为此前结果，本轮未重跑。

9 项 CLI 模拟握手测试覆盖幂等、无输入、身份不符、错误续聊、取消、超时后的迟到 init、退出、失败后不重试，以及新增的新建/续聊文字输入保留和模式冲突拒绝；两项适配器测试验证准备取消或回传身份与原始映射不符时发送为零；ACP 两项校验请求不含 prompt，并拒绝错误身份和忙碌/已关闭/无关引擎。这些证据仍不代替只读限制、真实账号/路由、完整外部归属或应用生命周期验收。

## P2 Windows 监督基础（本地实进程）

`windows-job.js`/`windows-job.cs` 在 Windows 10+ 使用 Job 管理每轮进程树：创建目标时设置 Job 列表，不允许 breakaway；停止先禁止后续启动，再终止 Job 并查询活动进程数归零。该选择依据微软对[创建时 Job 属性](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)、[创建后再归入的空档](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812)和[进程计数](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)的说明。控制帧与目标 stdout/stderr 分离，证明匹配本轮 runtimeId/deliveryId/generation，监督器失联不返回正向证明。

`node --test tests/discussion-windows-job.test.js` 此前运行 **19 项通过**，独立于模块与驱动回归套件，本轮未修改监督器或重跑该套件。参数/中文/大输入、控制帧隔离、detached 子孙、取消、失败、输入堵塞、监督器/应用消失、驱动释放、准备被拒绝后排空、新实例恢复清理、迟到启动和初始化拒绝、未初始化记录恢复、错误身份及损坏/超长记录拒绝均通过。通过 OS 检查测试进程确实退出、心跳文件停止变化；Windows 辅助 conhost 可以增加累计进程数，最终必须活动计数为零。

新增 `WindowsJobJournal` 在监督器启动前独占保存身份记录；`recoverWindowsJob` 先在共用文件锁下持久化封闭本轮启动，再打开命名 Job 查询/终止，不能只看旧 PID 或磁盘 stopped 标记。封闭标记阻止尚未准备完的旧监督器后来启动。采用[全局内核对象命名空间](https://learn.microsoft.com/en-us/windows/win32/termserv/kernel-object-namespaces)避免 Windows 会话命名空间混淆；关于对象消失的判断依据[Job 生命周期](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw)，只有明确的不存在结果可作缺席证据，访问失败不能替代。记录缺失、损坏或身份不符时拒绝恢复；结果不包含会话池 released 声明。

测试对象是本地 Node 协议程序和仓库驱动类，不是模型 CLI；没有模型请求或额度消耗。Windows 停止恢复基础已测试，清理器已保护约定的 `discussions/windows-jobs/<deliveryId>/` 及其对应运行目录；主进程启动恢复、真实只读策略、其他平台支持和具体连接验收仍未实现。Job 生命周期约束不等于文件/网络沙箱，也不能代替对外部服务启动活动、MCP、shell、子代理或提权路径的独立限制。因此没有新增生产能力证据或开放任何连接。

## 上下文与摘要

已存在两条摘要路径：`src/api/compaction-summarizer.js` 通过 API 路由请求；`SharedConversations.summarizeViaEngine` 通过临时原生会话请求。现有选择逻辑对 subscription 使用引擎路径。因此仅订阅用户有可复用的实现基础，无须以 API 密钥作为前置条件。

P3 仍需独立实现成员署名、输入快照、覆盖区间、容量预算和取消关联。摘要引擎本身也要受无副作用策略限制；原生路径存在不等于此限制已完成。不得复用单聊自动切账号行为悄悄改变成员绑定。

## v1 P0 结论及后续门槛

已有存储、目录和原生协议基础继续复用。冻结的四条路径尚未通过无工具及真实讨论验收；不能将本次范围收敛当作生产可用声明。

P2 按实际绑定及运行时/策略版本判断能力。SDK 的本地无工具入口仍需与首版范围内可核实的专属状态、固定账号/线路和生命周期组合。CLI 的 Deny 规则不能阻止 MCP 启动，空工具 Agent 仍有残留工具，这是范围内阻塞，必须解决或明确报告不能支持。Codex 同样需要执行策略。所有未验证绑定保持 unavailable/unknown；独立的 P3 文本上下文和 P4 页面可以继续推进，无需等待全部运行时问题解决。

P5 按 V1-01–08 补齐真实 API/订阅/混合证据，记录运行时、模型、连接和用量，覆盖独立并发、停止、续聊、无工具与仅订阅摘要。本文件历史中的外部全量扫描、其他平台和更多 harness 待办均不自动成为首版发布条件。模型调用权限按已有用户授权与实际配置判断；确有缺项时报告具体缺项。
