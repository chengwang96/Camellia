# 手机访问：桌面网关与 Android 控制

当前版本提供桌面网关、本地授权面板和[原生 Android 客户端](../android/README.md)。设备授权后即可查看和操作会话，无需区分只读或控制，支持已有会话中的文本发送、停止当前运行、单次允许/拒绝工具审批。不开放任意文件读取、终端或全局设置修改；手机只能在「设置 → 供应商与 Key → 配置迁移」中**读取**一次电脑端的 API Key 配置，导入后仅写入手机本地加密存储，不回写电脑端，也不开放其他全局设置。

Android 会话标题统一使用正文颜色，不再用标题颜色表示运行状态。远程输入框下方提供安全级别和模型选择浮层：左侧盾牌可选择手动批准、默认（常规自动、风险询问）或全自动；右侧可选择电脑端当前连接提供的模型及其思考等级。Codex、Kimi、Antigravity 会话会同时列出账号模型与共享 API 路由，并按「账号模型」「共享 API 路由」分组，与电脑端模型菜单的两个分组一致；当前连接的一组排在前面。选择另一组的模型会为该会话切换连接，两个方向都可切换，等同于在电脑端跨组选择。编辑框内部元素与本地会话保持一致：工具图标固定 48 dp、空闲时同为墨色，模型按钮显示模型缩写与本地化思考等级；电脑端上报的 `low`／`medium`／`high`／`xhigh` 等协议值在按钮和菜单中显示为「快速／标准／进阶／极限」，未知值按原样显示，`GET /v1/status` 返回的 `settings.thinking` 字段本身不变。设置沿用主机端的会话设置保存逻辑，从下一条消息生效，不切换引擎；连接只在跨组选择模型时改变。未登录账号时该组为空，列表只显示另一组。离线或有未确认操作时不可修改；运行中是否允许改下一轮的模型，按下述 next-turn-settings 能力判断；主机端设置发生变化后需重新选择，避免覆盖较新的设置。旧版电脑未提供设置能力时，入口保持禁用。全自动会取消工具操作确认，仅在信任当前任务时选择。

## Agent 讨论远程接口（beta）

Windows 主机提供讨论服务且设备具有全部工作区控制权限时，`GET /v1/status` 增加 `discussions` 和 `discussion-rich` capability。受限工作区设备不因此获得讨论访问权；Linux 和旧主机不宣告该能力。手机使用主机现有 `DiscussionService`、模型目录、自动验证和群存储。

统一导航：`GET /v1/conversations` 对上述设备附加 `discussionGroups`（前 100 个群）、`discussionsNextOffset` 和 `discussionVersion`；普通会话数组保持独立。列表 SSE 的 `listVersion` 同时覆盖讨论变化，电脑新建、重命名、置顶、删除群后，手机刷新该板块。受限或只读设备不返回讨论元数据。旧版讨论主机缺少这些附加字段时，APK 使用 `/v1/discussions` 读取群列表；回到列表或下拉刷新同步。

- `GET /v1/discussions?offset=N`：每页最多 100 群；`GET /v1/discussions/events`：首屏列表快照 SSE。
- `GET /v1/discussions/catalog`：六个 harness 的现有模型绑定；不含 accountRef、Key、原生目录，手机按返回的不透明 binding ID 添加成员。
- `GET /v1/discussions/:id?before=SEQ`：每页最多 80 条消息及约 512 KiB 消息内容；`GET /v1/discussions/:id/events`：当前群快照 SSE。返回 `instanceId/cursor`，群删除返回 `deleted: true`。
- `POST /v1/discussions/commands`：`{requestId, instanceId, action, id?, parameters}`。动作白名单为 create、rename、pin、delete、add-member、remove-member、set-identity、verify-member、cancel-member-verification、send、stop、retry、resolve-serial、set-permission、permission-response。create 无 id，其余使用群 id。身份 prompt 可选，最多 4096 字符；每群最多四位成员。发送参数为 text、participantIds、mode（parallel/serial）及可选 attachments。
- `GET /v1/discussions/commands/:requestId`：查询同一设备的持久化回执。状态为 pending、completed、failed 或 interrupted；completed 可包含 groupId。慢速连接验证不阻塞 HTTP 请求。网络故障先查回执；明确重试须沿用原 requestId 和原参数。重启中断的操作不自动重放。
- `GET /v1/discussions/:id/artifacts?offset=N` 和 `GET /v1/discussions/:id/artifacts/:artifactId`：使用普通会话相同的产物列表、64 位十六进制不透明 ID、流式下载及撤销检查；包含上传的附件、完成的工具生成文件和回复中引用的文件。用户正文中的路径不作为产物授权。

`attachments` 使用 `{name, isImage, data}`，data 为原始文件字节的 Base64，不接受远程提供的本地路径。讨论最多 16 个附件；JPEG 每张最多 4 MiB、文档每个 10 MiB，解码合计 32 MiB；复用普通会话的扩展名和内容检查，HTTP JSON 限制 48 MiB。主机将附件导入所属群，再交给原有调度器。手机仅保留加密的本地草稿引用，上传请求在发送时读取本机文件。

`group.pendingApprovals` 包含 requestId、fingerprint、participantId、deliveryId、runId、toolName、details、reason、questions、options、responseSupported。questions 每项为 id/header/question/multiSelect/isSecret/options（label/description）；只允许一次批准或拒绝，原生永久授权选项不会投影。详情过长或无法表示的请求 responseSupported=false。回应 action=permission-response，parameters 为 `{deliveryId, runId, approvalId, fingerprint, allow, input?, optionId?}`，approvalId 指原生 requestId，与外层命令 requestId 分开。input 的键为问题 ID，单选/自由输入为字符串，多选为字符串数组；批准时每题必答，拒绝时不带 input。主机在原运行中再次核对指纹并调用原有权限响应，不创建新运行。回执日志只保存请求摘要，不落盘秘密回答。

每个回复的工具快照保留最近 24 项的名称、状态、最多 8,000 字符的输入和末尾 8,000 字符输出。整页执行详情共享 512 KiB 预算，优先保留最新回复，并通过 detailsTruncated/toolsTruncated 标明省略；已完成的回复不重复附带 partialText，避免长工具历史超过手机响应限制。手机工具详情和产物菜单沿用普通聊天组件。消息附件仍只投影公开元数据；主机原生存储路径和账号凭据不出现在配置目录中。

## 普通会话的新增远程字段

主机宣告 `interactive-approvals` 时，普通会话的 `live.approvals` 使用上述 question/responseSupported 格式。旧字段 actionable 在问答请求中仍为 false，避免旧客户端把回答问题误作直接授权。原有 approve 命令增加 input、optionId，其 instanceId/runId/approvalId/fingerprint 校验及幂等规则不变。

`next-turn-settings` 能力下，settings 增加 modelEditable、appliesNextTurn、fastMode、supportsFast 和 quickSwitch；models 按 `(id, connection)` 区分，不能按 id 去重。configure 的 settings 可发送 `{model, connection}` 明确选择，或 thinking、fastMode，或单独 `{quickSwitch:true}` 使用主机已配置的快捷默认。Fast 仅在 Codex 订阅目录声明对应模型支持时接受。运行中 editable=false 保持旧客户端行为，新客户端可根据 modelEditable 改模型/思考等级/Fast，响应 appliesNextTurn=true；连接和权限仍须空闲，所有操作继续校验 expectedSettings。

会话快照可包含 `context:{used,cap,source,compacting,compactionState}`，保留协议兼容；Android v0.4.4 不在会话区常驻显示 tokens 用量和容量。主机新增独立的 `compaction`（无状态时为 null），包括 state（running/completed/failed/cancelled）、native、engine、afterSeq，以及可选 stage、chunk、finalChunk、durationMs、seq；不依赖用量是否上报。afterSeq 定位当前状态行，seq 对应已保存的完成通知，客户端据此去重。历史 notice 的 compaction 只含展示字段，不附带摘要内容或 tokens 诊断。压缩状态事件触发 SSE 更新；终态保留到下一条用户消息，以免事件合并漏掉结束状态。旧主机可回退到 context.compacting/compactionState 和文本完成通知，状态缺失不能推断为压缩成功。已有 compact 操作继续复用。iOS 可按同一 capability 探测、审批字段、上传和回执协议实现；本轮未在 Windows 构建 iOS，也未给 Linux 主机开启讨论。

## 桌面使用

1. 电脑和 Android 均已内置 Tailscale，无需另装或手动运行 Tailscale 客户端。两端登录同一 Tailnet，确认策略允许 `camellia-android` 访问新增的 `camellia-desktop` 节点。
2. 启动新版 Camellia，进入 **设置 → 手机访问**，直接在页面内管理连接、配对和设备权限；“手机访问”位于“已归档”下方。也可使用 **Camellia → 手机访问…** 或托盘菜单快捷入口。
3. 点击 **开启手机访问**。首次使用点击 **登录 Tailscale / 打开浏览器授权**，在官方页面授权；返回后自动检测连接，若显示待审批则到 Tailscale 管理后台批准设备。连接成功后显示内置节点的 `100.x.x.x:43127` 地址，再生成配对码。登录状态加密保存，通常无需重复授权。
4. 直接生成五分钟有效的一次性配对码，无需选择工作区。授权即包含当前与今后新增的全部工作区及独立会话，归档会话仍不可访问。
5. 客户端提交配对申请后，在桌面确认设备名称，再点击 **授权设备**；设备即可查看和操作会话，仅授权可信设备。
6. 可随时撤销设备或关闭访问。撤销会关闭该设备的事件流，后续请求返回 401。

已有设备在新版桌面加载设备记录时自动统一为控制权限，无需重新设置。引擎会话自身的权限与工具审批规则保持不变。旧版 Android 配对校验仅接受只读响应，新配对请同步更新 Android 客户端。

新授权统一为全部访问，不再提供部分工作区选择。旧版部分授权设备保留原范围，可在设备卡片点击 **授权全部访问** 并确认，或撤销后重新配对。更新范围后当前连接会断开，手机重新连接时按新范围校验。

生成配对码时同时显示二维码，内容为版本化的 JSON（`{"v":1,"type":"camellia-pair","address":"…","code":"…"}`），只含地址和一次性配对码，不含电脑名称，因此本地化名称再长也不会撑破二维码容量。手机端「扫描二维码自动填写」读取后自动填入地址、端口和配对码并直接发起配对；也可继续手动输入。`/v1/pair/request` 仍会校验 `code` 与 `name`，二维码只是输入方式的替代，不改变配对协议。桌面端可在「手机访问 → 配对设备」修改本机名称，手机端也可在设置或配对页修改设备名称，两端各自保存、互相独立，电脑名称在手机设置中只能查看导入来源。Android 客户端使用 ZXing 解码取景框灰度帧，未引入 CameraX、ML Kit 或 Play Services。设置页直接展示所有手机访问选项，无需另开窗口，沿用桌面主题，支持中英文。菜单快捷入口仍可打开独立面板。打开设置或面板不会自动开启网络访问。

启动 Camellia 时，如果保存了已信任手机的有效配对凭据，会在后台自动开启手机访问，无需进入设置；没有已信任设备时保持关闭。自动启动仅恢复已有的 Tailscale 登录，不发起新的登录授权、不打开浏览器；登录失效时需在「手机访问」中手动授权。自动启动失败不会阻止应用打开，可在设置中重新开启。手动关闭后本次运行不会再次自动开启；下次启动仍按是否存在信任设备判断，撤销全部设备后不再自动开启。关闭面板不关闭网关。关闭主窗口能否保持服务取决于已有的“关闭到托盘”设置；完全退出或电脑休眠会断开连接。代码不会修改防火墙、Tailscale ACL、MagicDNS 或系统休眠设置。绑定失败（例如端口被占用）在面板显示错误，不会退回其他地址或公网监听。

内置节点与系统 Tailscale 是不同设备，地址通常不同。已有手机连接需改用桌面新显示的地址，Camellia 设备授权仍保留。设置中的「CLI 设备」与这里共用同一个内置节点和登录，因此关闭访问会同时断开 CLI 设备连接；退出登录会让两边都需要重新授权。内置网络只服务于 Camellia，不安装系统 VPN、不接管其他软件流量。关闭面板不会结束辅助进程。退出 Tailscale 登录会断开网络，保留 Camellia 配对记录；如需撤销旧节点，请同时在 Tailscale 管理后台操作。

### 源码开发与打包

构建机需要 Go 1.26.3（或支持自动下载该工具链的 Go）。先运行 `npm run build:tailnet`，再启动桌面；可通过 `CAMELLIA_GO` 指定 Go 可执行文件绝对路径。安装包构建会自动编译对应平台的辅助程序，将二进制、版本信息和 `TAILNET-NOTICES.txt` 置于 `resources/runtime`；最终用户不需要 Go。Windows x64、macOS arm64 的 CI 均包含 Go 单元测试、原生辅助进程冒烟测试和打包资产检查。

本地验证：`node --test tests/embedded-network.test.js tests/remote-desktop.test.js tests/remote-access.test.js`、在 `integrations/tailnet` 下运行 `go test ./...`，以及 `node tests/embedded-network-electron.cjs`。可选设置 `TAILNET_TEST_LOGIN=1` 验证官方登录链接生成；该测试不会打开浏览器或替用户授权。登录后手机到桌面的真实 Tailnet 连通仍须使用用户账号验收。

若更新代码后设置页出现 `Local remote-access window required`，说明新页面正在连接尚未重启的旧桌面主进程。保存工作后完全退出 Camellia（包括托盘）再重新启动；刷新页面或只关闭设置窗口不会更新主进程。暂时不便重启时，可通过页面的「打开独立手机访问面板」或应用/托盘菜单管理连接。状态加载失败时页面保留说明并禁用操作，使用「重试」可重新加载；此时不能据空白列表判断设备授权已丢失。

## 安全边界

- 桌面使用固定版本 `tsnet` 1.98.6 的 Go 辅助程序，随安装包分发。Tailnet 监听由用户态网络提供，不要求系统网卡有 `100.x` 地址，不调用外部 `tailscale.exe`。Node 网关只监听随机 `127.0.0.1` 端口；每次运行使用独立 256 位传输密钥验证来自辅助进程的请求，之后仍校验原有设备令牌、Host、Origin 和授权范围。局域网/公网接口没有 HTTP 监听。此隔离不防御同用户恶意进程或管理员。
- 节点状态使用 AES-256-GCM 加密，密钥由 Electron `safeStorage` 经系统安全存储保护，保存在用户数据目录 `remote/tailnet`；没有安全存储时拒绝启动，不降级为明文。密钥仅经子进程 stdin 传递，不进入命令行、URL 或日志。登录只允许打开官方 `https://login.tailscale.com` 链接，不支持自定义控制服务器。
- 应用层使用 HTTP，链路保护依赖 Tailscale 隧道，并非 HTTPS 服务；仅用于上述 Tailscale 直连。Android 客户端仅接受 Tailnet IPv4 与端口，禁止 HTTP 重定向及系统 HTTP 代理，不把令牌发送到其他地址。
- 不开放浏览器跨域访问；携带 `Origin`、跨站 fetch 或不匹配 `Host` 的请求被拒绝。当前协议面向原生客户端或命令行测试，不是可直接浏览的手机网页。
- 配对码只能提交一次；提交后仍需桌面确认。设备访问令牌为 256 位随机数，仅保存 SHA-256 摘要到用户数据目录的 `remote/devices.json`。令牌不放进 URL、事件 ID 或日志。
- 客户端可持有配对领取凭据，在五分钟窗口内重试领取同一个令牌。首次使用设备令牌成功后，领取凭据立即失效。重新生成配对码或关闭网关会清除未完成配对。
- 设备只可读取授权范围内的非归档会话。固定授权按当前工作区归属检查；独立会话需明确勾选或动态全部授权。全部授权会自动包含未来工作区，但不会绕过归档限制，也不访问仍指向不存在工作区的会话。会话移出授权范围或归档后，下一次读取拒绝；现有事件流在事件刷新或最多十秒的心跳检查时关闭。撤销设备立即关闭事件流。
- 返回数据使用显式字段选择，不返回设置、API 密钥字段、原生线程标识、附件路径或任意文件内容。但**用户和模型写进正文的秘密、路径仍属于正文，会被授权设备读取**，这不是内容脱敏工具。
- 产物下载与桌面同源：只列举会话已引用的现有文件，相对路径按会话工作区、本轮命令实际所在的目录和回答点名的绝对路径文件夹解析，因此在其他目录生成的产物也可下载。不提供任意磁盘浏览，不返回电脑绝对路径；授权设备因此能读取这些产物文件的内容。
- 配对每个来源地址每分钟最多 30 次请求，其余请求最多 300 次。事件连接最多 16 个、每设备最多 4 个；背压期间只保留待刷新标记，不无限排队快照。连接长时间无网络进展时关闭，客户端重连拉取最新快照。

## 协议 v1

手机会话列表长按提供重命名、多选、置顶及删除，需要服务端公布 `conversation-actions` 能力。通过 `POST /v1/commands` 发送 `rename`、`pin` 或 `delete`，公共字段为 `requestId`、`instanceId` 和 `targets: [{id, seq}]`；重命名另带 `title`，置顶另带布尔值 `pinned`，两者仅接受一个目标，删除最多接受 100 个目标。操作要求控制权限，并预检所有目标的授权、版本及忙碌状态。批量删除不是跨会话事务，失败后须刷新核对；同一请求 ID 只执行一次，删除后的重试仍校验原工作区授权。删除移除会话历史及元数据，不删除工作区文件。会话摘要新增 `pinned` 布尔字段，置顶与桌面共用元数据。

根地址以桌面显示值为准，例如 `http://100.80.1.2:43127`。JSON 请求必须设置 `Content-Type: application/json`。

| 方法 | 路径 | 请求/行为 |
| --- | --- | --- |
| POST | `/v1/pair/request` | `{ "code": "桌面配对码", "name": "My Android" }`；返回 `id`、`claim`、`computerName`、`expiresAt`。`computerName` 来自生成配对码时的本机名称，可能为 `null` |
| POST | `/v1/pair/claim` | `{ "id": "申请ID", "claim": "领取凭据" }`；桌面确认前返回 `state: pending`，确认后返回 `token`、`deviceId`、`permission: control` |
| GET | `/v1/status` | 返回 `protocol`、`permission`、`instanceId`、`cursor` |
| GET | `/v1/api-keys` | 返回与桌面「导出 API 路由配置」相同的 `camellia-api-routes` v2 bundle（含明文密钥）；仅当设备持有控制权限且为全部访问授权时可用，`capabilities` 同时公布 `api-keys` |
| GET | `/v1/conversations?offset=0` | 最多 100 个会话及 `nextOffset`；仅限授权工作区 |
| GET | `/v1/conversations/{id}` | 当前历史页、运行中文本快照及游标 |
| GET | `/v1/conversations/{id}?before={seq}` | 向前读取历史，下一页使用 `nextBefore` |
| GET | `/v1/conversations/{id}/events` | SSE；连接时及状态改变时返回 `event: snapshot` |
| GET | `/v1/conversations/events` | SSE；连接时及授权可见的会话列表变化时返回 `event: snapshot`，包含 `listVersion`、`instanceId`、`cursor` |

除两个配对接口外，每个请求必须带 `Authorization: Bearer <token>`。配对轮询间隔至少五秒。Android 客户端使用 Android Keystore AES-GCM 加密存储令牌，后台关闭网络连接、回前台重新同步。

`GET /v1/api-keys` 不接受查询参数，授权范围不足时返回 403。响应顶层是导出 bundle，另附 `instanceId` 和 `cursor`；列表页、详情页仍不返回任何密钥。Android 在「设置 → 供应商与 Key → 配置迁移」中提供「从电脑导入」，未配对时提示先在主界面连接电脑，配对后显示电脑名称；配对多台电脑时先在列表中选择要读取的一台，再于应用统一风格的确认弹层中核对来源电脑、将被替换的本机供应商数量与「聊天记录保留」，确认后才发起读取，取消不改动本机配置。读取失败沿用统一的本地化错误提示（例如旧版电脑返回 404 时提示更新电脑端）并保留原配置，导入成功后替换手机上已有的供应商与密钥配置，聊天记录不受影响。

会话快照包括 `conversation`、`messages`、`live`、`permission`、`nextBefore`、`instanceId`、`cursor`。`conversation.seq` 用于发送前校验。`live` 包含当前 `runId`、`eventSeq`、`userSeq`、正文和待审批数量；控制设备额外获得审批详情、内容指纹、单次审批选项。超过 32,000 字符的详情不允许手机审批；问答是否可回传以 responseSupported 为准。消息附件返回名称和类型，图片预览与文件下载通过产物接口读取，不在快照中嵌入原始字节。消息数量最多 200，页面正文与执行过程预算约 1 Mi 字符，单条正文最多保留末尾 256 Ki 字符并标记 `textTruncated`。

### 控制接口

声明 `message-queue` 能力的电脑在会话快照中附带 `queue` 和单调递增的 `queueVersion`，条目仅包含 ID、显示正文、附件名称／类型、状态与时间，不暴露本地文件路径或设备凭据。队列正文及附件引用保存在电脑用户目录 `remote/message-queue.json`，执行不依赖手机或桌面聊天窗口保持打开。每会话最多 50 条、总计最多 200 条。停止任务、失败、主机重启或远程授权变化后暂停，需明确继续；启动前再次校验授权。目标模式仍活动时继续等待。命令回执不保存整个队列，重试返回当前队列版本，客户端忽略较旧的版本。桌面原有的页面草稿队列保留原行为，与手机队列分别显示。

`POST /v1/conversations/{id}/commands`，需要 `control` 权限和原有工作区授权。JSON 共同字段为 `requestId`（UUID）、`instanceId`、`action`：

- `send`：`prompt`（1–16,000 字符）、`expectedSeq`，可选 `queue: true`（需 `message-queue` 能力）。默认仅允许空闲的已有会话；指定入队时允许运行中添加消息，返回 `state: queued`、`queueId`、`queue` 和 `queueVersion`。入队允许正文版本向前推进，仍校验会话、实例及工作区授权；编辑重发不允许入队。电脑共用桌面会话启动预留，避免双端同时启动。
- `queue-remove`：`queueId`，移除当前会话尚未启动的消息；`queue-resume`：继续该会话暂停的手机队列。两者沿用请求去重和控制权限校验。
- `send` 中的 `/find …`：以 `/find` 开头的普通消息由电脑本地作答，不启动任何引擎、不消耗模型额度，用于在手机上按描述查找电脑文件并下载。
- `find`：`query`（1–500 字符）、`expectedSeq`。与 `/find` 同义的专用动作，需要新版客户端；旧版手机直接发送 `/find …` 文本即可。返回文件名称、类型与大小，不含服务端路径。
会话详情页在输入框上方显示自动化状态：目标（进行中／已暂停／受阻／已完成）带上目标文字与轮次，定时任务列出状态、说明和间隔。处于活动或受阻的目标可一键暂停／恢复，运行中或已暂停的任务同样可切换；按钮复用既有的 goal-control、	ask-control 命令，因此请求去重与重试规则不变。恢复目标会像电脑端一样排定下一轮执行，而不是立刻发送。旧版手机忽略该字段，界面不变。
- `stop`：`runId`，必须匹配当前运行，不误停下一轮。沿用桌面停止行为，包括相关自动任务暂停。
- `approve`：`runId`、`approvalId`、`fingerprint`、`allow`（布尔），只允许单次许可或拒绝。不接受修改工具输入、永久授权或改变引擎权限。

命令结果先记录到用户目录 `remote/commands.json`，重复请求返回同一结果。记录只有请求指纹和结果，不记录消息正文；每个请求 ID 不可更换参数。历史上限 10,000 条，达到后拒绝新操作而非淘汰去重信息。遇到进程在执行前后崩溃，缺乏结果的记录返回 `state: unknown`，绝不盲目重复执行。HTTP 200 仍须检查 `ok`，`accepted` 只表示引擎已接收，不代表任务完成。撤销不回滚已开始的工具执行；尚在准备中的手机发送会被取消。

### 断线恢复

Android v0.3.39 的产物下载由用户在前台发起 `dataSync` 前台服务，独立于会话页面生命周期；切后台仍继续并显示进度通知，通知和下载面板均可取消。活动下载保留内置网络节点，不受五分钟闲置释放影响，结束后恢复释放策略。下载凭据仅存在进程内，不放入 Intent 或持久任务；服务不自动重启重发。断网、进程终止或系统服务限额中断后需手动重新下载。产物列表和进度面板使用设置页样式，系统保存位置选择器保持原样。

Android 在电脑状态检查成功后预取会话列表首页，并以独立串行队列优先只读预取最近活跃的十个会话最新历史页；用户两秒无触摸或按键操作后，每隔至少半秒继续加载其余会话及后续列表分页。用户操作延后后续空闲请求，列表同步后也可触发，未变化的内容及已取列表分页一分钟内不重复请求。预加载不发送已读或控制命令，切页／切网／后台取消，详情重新连接成功后恢复空闲队列。正文仅在当前 Activity 内存按电脑与配对凭据隔离，不落盘；不设会话数量上限，单份约两百万字符，总缓存按设备堆上限的 1/16 设置为八百万至三千二百万字符，超限按最近最少使用淘汰。打开会话先显示明确标注的预加载正文，实时快照成功后才启用操作和标记已读；缓存不含审批、控制授权、设置或运行中快照。撤销授权或会话不可用时清理相应内容，不自动下载完整历史、图片及产物。

Android v0.3.36 将内置网络失败转换为白名单诊断码，并在电脑状态、列表失败、实时重连及网络设置失败时给出本地化建议。原生层根据实际网络状态区分登录／设备审批／启动问题，根据 TCP 是否建立区分建连和响应头超时；外部网络超时无法定位阶段时不做推断。HTTP 错误单独标记状态码。本机聊天与远程控制共用可点按的底部状态详情入口，详情保留异常链路，并支持选择和复制；远程 HTTP 失败会附带经令牌、Bearer 与密钥脱敏的服务端响应正文，原始请求地址、令牌和原生错误文本仍不显示。未知失败仍明确标为未知，不自动建议删除配对。

Android 在后台立即断开页面请求及 SSE，未切网时保留内置网络节点最多五分钟；不保证系统不会回收进程。v0.3.35 监听默认网络和链路属性变化，合并通知后异步关闭旧节点，下次请求以原加密身份重建；回前台时若保留窗口已过而进程未被系统回收，同样先关闭旧节点再重建，避免继续复用一个在后台被冻结、已失效的用户态节点。前台页面自动同步，后台不主动重连，回前台再次核对网络。内置 HTTP 请求在发起前注册可取消句柄，等待建连和响应头最多 30 秒，底层单次拨号最多 25 秒，取消页面可中断未返回响应的请求；已建立 SSE 不使用整体建连截止时间。切网不自动重发发送／停止／审批命令。会话列表响应额外携带与 `/v1/status` 相同的授权元数据，手机可一次完成首次同步，旧网关仍回退查询状态。订阅首个快照的 `instanceId` 和 `cursor` 与成功加载的列表一致时跳过重复查询，游标变化或实例重启仍同步，不使用缓存推断在线状态。

命令准备超过一秒时返回 HTTP 200 和 `state: pending`，而非让手机、代理一直等待响应直到超时。该状态不是成功或失败，不清除请求记录；手机保留正文、附件及原请求 ID，手动重试查询同一操作。操作最终结果仍持久化并去重，不能通过更换 ID 来重发。手机命令使用独立线程，避免排在长期事件流或历史加载请求之后；快照的“已连接”状态不会覆盖未确认操作提示。

第一版采用**快照替换**，而不是客户端增量拼接。SSE 初次订阅同步读取快照并注册连接，期间没有异步间隙；后续更新合并到约 250 ms 一次。每个 snapshot 替换当前最新页与 live 状态，不能当作新消息追加。历史翻页缓存单独维护；恢复最新视图时重新读取快照。

断线后用退避重新连接；服务总是提供新快照，不依赖 `Last-Event-ID` 重放。`cursor` 是当前网关实例的全局事件版本，不保证连续；`instanceId` 在网关重新开启时变化，客户端必须丢弃旧游标。此方案恢复最终正文和当前运行状态，但不保证交付断线期间每个瞬时状态或 token 事件。手机停留在会话列表时订阅列表事件，电脑新建、删除会话后自动重新同步已加载的列表页，无需手动刷新；短时间内的连续变化合并到约 250 ms 一次。列表版本覆盖全部授权会话（包括尚未加载的页），不包含未授权会话，重复通知不会触发同步。后台暂停连接，回前台或断线重连时重新同步，仍可手动下拉刷新。

## 验证

```powershell
node --test tests/remote-access.test.js tests/remote-desktop.test.js
python tests/remote-ui.py
node tests/electron-smoke.cjs
# 以下三项要求已构建 APK/测试 APK，并显式选择可丢弃的 root 模拟器：
# $env:ADB = '<Android SDK>/platform-tools/adb.exe'
# $env:ANDROID_SERIAL = 'emulator-5586'
node tests/android-pairing-smoke.cjs
node tests/android-gateway-smoke.cjs
node tests/android-discussions-smoke.cjs
```

测试使用临时数据目录、假引擎和回环地址，不读取真实会话、不执行模型请求，也不会打开本机 Tailscale 监听。Android Keystore 和原生界面已通过 Android 15 模拟器测试；`tests/android-gateway-smoke.cjs` 通过模拟器专用网络转发验证客户端与真实网关的配对、历史、SSE 更新、撤销，以及目标/定时任务控制、内容搜索、下载和重复请求去重。目标计时器由夹具控制，不启动模型；定时任务只检查控制状态，不等待真实周期。`android-pairing-smoke.cjs` 覆盖二维码扫描、失败重试和授权，`android-discussions-smoke.cjs` 覆盖讨论群、附件、问答和丢失回执恢复。真实手机的 Tailnet 互通仍需单独验收。

macOS 主机和 iOS 客户端应另行验证实际 Tailnet 配对、Wi-Fi/蜂窝切换、休眠/后台恢复，以及旧主机的能力协商。iOS 沿用 `protocol: 1` 和 `capabilities`，保持 `requestId` 重试语义、`instanceId`/`runId`/审批指纹校验，并用快照替换更新状态；不能用请求超时推断操作未执行，也不能因显示缓存而授予控制权限。
