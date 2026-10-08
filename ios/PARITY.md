# iOS ↔ Android 功能对照

目标：iOS 客户端与 Android APK（`android/app/build/outputs/apk/debug/app-debug.apk`，经 `aapt` 核实为 v0.4.0）**功能完整对齐**，最低 iOS 15。

此表记录代码对应关系，不代表功能已验收；历史说明中部分结论已失效。当前进度和验收门槛以 `ios/WORKPLAN.md` 为准；`android/README.md` 与实际 Android APK/源码是产品基准。

## 结论

**旧计划（`~/Desktop/ios-client.md` 的 S1–S5）不是逐条对齐的规格；当前执行计划是 `ios/WORKPLAN.md`。** 旧计划把两条产品线（远程控制、本机聊天）的主干写全了，但没有把 Android 的功能清单逐项列出，因此有 8 项 Android 功能从未进入旧计划：

| 缺失项 | Android 能力 | 计划 | 代码 |
| --- | --- | --- | --- |
| 查找文件 | `/find`、`/find inside: <terms>`、输入框「查找文件」按钮 | 无 | 已有（走 `send` 路径，电脑端拦截；按钮在 Android v0.4.0 已移除） |
| 上一条消息编辑重发 | `editSeq` 编辑并重新生成后续回复 | 无 | 已有（远程 `resend`+`editSeq`、本机截断重发；均只允许最新一条用户消息） |
| 会话列表搜索 | 按标题匹配并读取未加载分页 | 无 | 已有（底部搜索框 + 400 ms 防抖读取剩余分页） |
| 工作区分组折叠 | 折叠状态按电脑持久化 | 无 | 远程已有（`MobilePreferences` 按地址+工作区持久化）；本机列表仍是会话内状态 |
| 预加载 | 连接后预取列表首页 + 最近 10 个会话 + 空闲预取 | 无 | 代码已有：电脑状态检查成功后预取首屏列表到加密缓存，所有已配对电脑与当前列表的最近 10 个快照立即排队，较旧快照与后续页由空闲队列读取；在途取消代码已补，实网时序仍待验 |
| 会话列表加密缓存 | 1000 条/电脑、共 20 份、按地址与凭据隔离 | 无 | 已有（`RemoteListCache`，AES-GCM 密封，键为地址+令牌摘要） |
| 已读状态同步 | `POST /v1/conversations/{id}/read` | 无 | 已有（白名单已放开，`AppModel.syncRead` 上报） |
| 位置 | 一次性确认、大致位置、2 km 精度 | 无 | 已有（`LocationContext` 判相关 + `LocationService` 单次取点 + 两端发送前同意弹窗） |

另有 3 项**原计划明确不做**，需要分清两类：**平台限制**是后台长连接与内置 tsnet 的持续后台下载（iOS 没有前台服务的等价物），**取舍**是后台通知 —— 而且 Android 自己也不承诺它：`android/README.md` 的原话是「后台停止连接，不承诺后台通知，不在手机执行引擎或代码」。外部 VPN 模式虽是旧计划第 9 条的排除项，现已实现前台 HTTP/SSE 通路；真实系统 VPN 和后台 URLSession 仍待验证，不能将其算作平台不可能。

**iOS 15+ 已经是事实标准，但旧计划里没有这条；当前 `WORKPLAN.md` 已写明。** 三处脚本把它钉死了，见下节。

## 平台基线

最低 iOS **15.0**，三处强制，改任一处都会在构建或检查时报错：

| 位置 | 作用 |
| --- | --- |
| `ios/build-ipa.sh` | `MINIMUM_IOS="15.0"`，打进 `LC_BUILD_VERSION` |
| `ios/check-client.sh` | 类型检查目标钉在 15.0 而非已装 SDK，**用高于 15 的 API 会在这里报错**而不是在旧设备上崩 |
| `ios/check-camera.sh` | 相机与位置层按 iOS 15 目标检查 |

旧计划只在分发章节提到「iOS/iPadOS 14+」（SideStore 的要求）与「iOS 18/26 设备」，没有写客户端自身的版本下限；当前执行计划已补上 15.0。

## 对照表

状态：`✅` 已有 ｜ `⚠️` 部分（模型层有界面无，或被白名单挡住） ｜ `❌` 未做 ｜ `⛔` 计划不做（平台限制或明确取舍）

### 网络与配对

| Android | iOS | 证据 / 缺口 |
| --- | --- | --- |
| 内置 tsnet，无系统 VPN | ✅ | `CamelliaCore/Networking/EmbeddedNetwork.swift` |
| 首页远程入口连接／断网／登录／超时／失败与对应操作 | ⚠️（代码已对齐，故障实测待验） | `RemoteEntryGate` + `EntryGateTracker` 统一六态，连接最多等待 30 秒；首页按 Android 显示转圈、重试或前往「手机访问」。模拟器已实际点击未登录和外部模式可进入的两条路径；受控断网、初始化失败和超时的端到端路径仍待验。 |
| Tailscale 登录与授权链接校验 | ✅ | `LoginView`、`EmbeddedNetwork.loginUrl` |
| 接口枚举 | ✅ | `InterfaceSnapshot.swift`（`getifaddrs`，无需注入） |
| 外部 VPN 模式 | ⚠️ | `ExternalHTTP.swift` 在内置模式关闭后改走系统 VPN 路由，支持受限 HTTP 请求和 SSE；24 项无实网 stub 检查通过，模拟器入口/状态已核。真实 Tailscale VPN/电脑端到端仍待验证，不再把原计划排除项当平台限制。 |
| 短暂离开保持连接 | ⚠️ | 设置项在（`MobilePreferences.keepAlive`）。iOS 无前台服务，改用 `beginBackgroundTask`（`ClientDelegate`）把系统给的后台窗口开满（约半分钟）并在到期时回调 `AppModel.endBackground()` → `EmbeddedNetwork.endBackground()`，尽量延长隧道存活；这不是 Android 那种常驻服务，**属平台限制** |
| Wi-Fi／蜂窝切换恢复 | ⚠️（代码已有，真机待验） | `AppModel.watchNetwork()` 在 `boot`/`foreground` 接 `EmbeddedNetwork.setListener`、`background` 时清掉（对齐 Android 的 `onStart`/`onStop`）；`networkRouteChanged()` 重启首页入口探测，并且仅在远程页联网时重订阅：开着会话就重开它的流、否则重取列表并重挂列表流。`foreground()` 同样重订阅，并把 `resumeTick` 递增供电脑页重检；真实 Wi-Fi／蜂窝切换尚未运行验收。 |
| 配对：IP／端口／配对码分离输入 | ⚠️（规则与表单已核，真实电脑待验） | `ComputerScreens.swift` `PairingView`；请求获接收后清空一次性码，claim 因网络错误中断可从原请求继续等待，不会无谓重发配对请求；名称按 Android 的 Java `trim()` 和 UTF-16 80 单位上限校验，emoji/不换行空格边界有规则回归；暗色表单和返回/操作按钮已与 APK 空态对照。iPad 姓名字段不再误称手机，iPad mini 6 机型模拟器已见「This iPad's name」。真实电脑交互与 iPadOS 15 真机待验。 |
| 配对：二维码扫描 | ⚠️（拒权界面已验，真机取景待验） | `Camera/QRCodeScanner.swift`、`PairingScannerView`；按 APK 的居中标题、48pt 返回圆钮、深色圆角取景卡、280pt 上限的四角导引与底部状态提示绘制。相机启动/停止在同一串行队列执行，避免刚打开就返回时“停止先看见未运行、启动却迟到”；页面退后台也停止，回前台重新请求取景。iPhone 16e iOS 18.6 模拟器实际拒绝相机权限后核对英文说明、返回配对及再次进入；iPad mini 6 机型 iOS 18.6 模拟器的竖/横屏拒权态也已核无裁切。授权拍摄与扫码识别仍需真机验证。 |
| 多电脑：列表／切换／重命名／移除 | ⚠️（假条目操作已验，真实电脑待验） | `ComputersView`、`ComputerManagePanel`、`AppModel.rename/remove/select`；未配对时首页「远程控制」直达电脑列表，列表返回键、添加行及空态已按 APK 对齐。选已配对电脑转远程列表，选未配对电脑转预填地址的配对页；详情切电脑后退出旧详情。「管理」现用 APK 式底部动作面板，重命名限 80 字且空名就地报错，移除二次确认。iPad mini 模拟器用无令牌假条目点验了英文管理/重命名空名报错/保存后即时更新与重启保留/移除确认取消，并修正横屏软键盘遮挡及英文辅助功能标签；假条目已清除。真机触控、真实凭据、删除当前电脑后的缓存/导航仍待验。 |
| 多电脑：并发状态检查 | ✅ | `AppModel.refreshComputers()`：进入「电脑」页即检查、下拉重查；最多 4 并发；401 撤销该机缓存与预取。电脑行已有与 Android 一致的「管理」入口；运行时仍待真机验证。 |
| 连接失败原因分类与诊断码 | ✅ | `CamelliaCore/Sources/RemoteFailure.swift` |

### 远程控制

| Android | iOS | 证据 / 缺口 |
| --- | --- | --- |
| 会话列表、分页、工作区分组 | ✅（代码） | 首屏一页、底部「加载更多会话」；搜索 400 ms 后读尽剩余页；事件流刷新保持已见条数；不再有 20 页静默截断。无会话时先保留工作区/独立会话标题，再显示 APK 空态提示及可能的下一页入口，不因已有空工作区而只剩标题。`ProtocolChecks` 覆盖 25 页。真机视觉与网络时序待验。 |
| 工作区分组折叠 | ✅ | `ConversationListView.header` 折叠控件 + `AppModel.toggleCollapsed`；状态按电脑地址与工作区写入 `MobilePreferences.setWorkspaceCollapsed`（`collapsed:<address>/<workspace>`），与 Android 的 `collapsed:` 键一致，搜索时强制展开 |
| 会话列表搜索 | ✅（代码） | 底部搜索框绑定 `AppModel.search`；按 Android 的 Java `trim()` 判断空白，再按标题不区分大小写匹配，400 ms 防抖读取剩余分页。 |
| 标题栏切换电脑 | ⚠️（代码对齐，操作待验） | `ComputerPickerPopupView` 供远程列表和详情共用：当前电脑排首、其余按名称排序，显示状态、勾选、添加/管理入口；选待批准电脑进入配对页。电脑状态固定标签与失败提示按语言显示；真实电脑、小屏定位与返回路径待验。 |
| 长按菜单：重命名／多选／置顶／归档／删除 | ⚠️（本机模拟器部分验收；远端待验） | `ConversationMenuPopup.swift` 为本机和远程列表共用 224pt、五个 56pt 操作行及会话行锚点，替代系统 `contextMenu`；重命名/删除后的底部面板也已按 APK 分型。远程批量删除仅在电脑确认成功后清掉多选。iPhone 16 Pro、iPad mini (A17 Pro) 模拟器均已打开本机菜单；iPhone 点验外部关闭、置顶／取消、多选、归档／恢复、重命名预填与空值错误、单条/多选删除确认并取消。实际删除、真机长按、远端权限与小屏边缘位置仍待验。 |
| 新建会话：选择执行引擎（Pi 等） | ⚠️（代码对齐，操作待验） | `RemoteEngine.available(advertised:)` + `AppModel.availableEngines`（来自列表页 `/v1/conversations` 的 `engines`，旧电脑端没有则退回 `/v1/status`，都没有则用 Android 的五个默认）。`beginCreateConversation` 总是打开 APK 式底部选择面板，包括只有一个引擎时；选中后 `createConversation(workspaceId:engine:)` 发 `create` 带 `engine` 字段，独立会话明确发送 `workspaceId: null`。**关键点**：nil（电脑端没说）与空数组（说不提供）含义不同——前者退回五个默认、后者一个都不给，与 Android `RemoteEngines.available` 一致；无独立会话范围时独立入口说明权限不足。空列表的主按钮依 Android 直接用首个可用工作区，没有工作区但允许独立时才用独立范围；两者都不允许时改显示「刷新列表」，不再多弹系统工作区选择器。真实电脑交互未验。 |
| 新建工作区（名称 + 电脑文件夹路径） | ⚠️（代码对齐，操作待验） | `AppModel.createWorkspace(name:path:)` 发 `create-workspace`（带 `instanceId`／`name`／`path`），成功后 `refreshList()`。权限同 Android：`control` + 电脑端广告了该能力（`RemoteCapability.createWorkspace`，`canCreateWorkspace`）。入口是列表页工具栏「新建工作区」和 APK 式底部表单，名称 ≤200、路径 ≤1024 个 UTF-16 单位，按 Java `trim()` 处理空白，空值在字段下就地报错。**关键点**：路径是**电脑上**的绝对路径 —— 手机上不可能有指向隧道另一侧的路径。真实电脑交互未验。 |
| 会话行未读标记 | ✅ | `AppModel.isUnread` → `RemoteReadState.unread`；`ConversationRowView(unread:)` 加粗标题并显示「新消息」 |
| 会话详情、SSE 快照替换 | ⚠️（代码对齐，实网待验） | `ConversationDetailView`、`RemoteSession`、`RemoteTranscript`；同一会话前后台重连保留已加载历史和更早页，失联时关闭操作，直到实时快照确认权限。预取及主动 GET 快照可绘制但不能单独授权操作；首个流快照先应用再报连接，失联时禁用详情控制，其他会话 ID 的快照会被拒绝。远端 SSE 行/事件上限按 Android 的 UTF-16 单位计算，超限或无效 JSON 会关闭流并重连，不再静默跳过；其他会话 ID 的有效快照不交给本页，但计入本轮已收到事件。429 长退避可由切页立即中断；收到快照后断流按 1 秒重连，首次空流断开按 2 秒重连，不热循环。列表事件端点未送快照的 404 才降级轮询；已建立的列表流/详情流 404 终止，401/403 终止，400/409 退避重试。事件触发的列表 GET 失败现在会使流关闭并退避重连；成功应用列表后才报连接，切页会唤醒等待中的流。缺失消息数组不会清空已有历史、队列或目标，但仍会撤销过期设置；完整快照缺设置/自动化则清旧状态，过期快照不再触发已读或缓存写回。权限相关布尔值按 Android `optBoolean` 处理，数字 `1` 不授予设置或审批操作。工具历史行不单独成气泡；过程步骤只附到下一条助手消息或流式回复，尾部孤立步骤另成过程块。过程块按 APK 提供折叠摘要、工具次数、状态与完整输入/输出；流式/历史非空正文共用 48pt 复制与时间操作栏，被截断的正文有尾段提示；生产消息视图的模拟器夹具已核 iPad mini 6 机型竖/横屏与 iPhone 小屏的静态排版及过程展开；真实电脑下的切页、弱网、完整详情页和 Android 像素级对照仍待验。 |
| 详情 403/404 与状态全文 | ⚠️（代码与模拟器界面已核，实网待验） | 详情流、主动快照、旧分页或命令遭拒时，撤下历史/过程/实时回复与旧分页，先取消在途预取再清缓存；404 释放无法确认的命令并恢复草稿，403 保留待确认气泡的内存状态供后续有效快照核对，但拒绝期间不画旧气泡。一次性请求拒绝不伪造流断开。详情状态行按 APK 为单行灰字，403/404 原因优先于重连文案；点按打开同款底部说明面板，可滚动、选取或一键复制全文。iPad mini 6 机型与 iPhone 16 Pro iOS 18.6 模拟器已点按短/长说明、关闭/复制，并核长文竖横屏按钮可见；真实电脑的授权变化、命令与快照竞态仍未验。 |
| 流式快照跟随（向上阅读时保留位置） | ✅ | 同上 `ScrollFollowTracker`。`ConversationDetailView` 在新行、实时正文或工具步骤增长时按「是否贴近底部」决定是否滚底；打开会话与发送强制跟随，对齐 Android `applySnapshot` 的 `initialMessageScroll` 与 `pendingScrollPosition == INT_MAX` 两条强制分支。**差异**：Android 每 120 ms 合并快照后再判断，iOS 由 `@Published` 变更驱动，判断频率随快照到达 |
| 历史消息向后分页（加载更早） | ✅ | `AppModel.loadOlder()` 走 `RemoteSession.snapshot(before:)` → `RemoteTranscript.mergeOlder`。关键点：**不能走 `apply`** —— 更早页的首 seq 比缓存里任何一行都小，supersede 规则会把正在阅读的较新行全删掉；`mergeOlder` 改为按 seq 直接保留（同 Android `retainHistory`），只推进 `nextBefore` 与裁剪。`hasOlder`（`nextBefore != nil && !historyLimited`）决定入口显隐，本地裁剪后自动收起（避免向已丢弃的行取页）。界面顶部「加载更早消息」按钮 + 加载中转圈，加载后按 anchor 恢复阅读位置（`.onChange(of: olderTick)`），自动滚底改用「最后一条 id 变化」触发以免插入更早行时被拉到底。**差异**：iOS 15 的 `ScrollView` 没有下拉刷新（`refreshable` 在此目标只作用于 `List`），因此 Android 的「顶部下拉」在这里由它并列保留的按钮承担 |
| 发送／停止／审批 | ⚠️（代码对齐，实网待验） | `Composer`、`ApprovalCard`；详情操作权限取自最新实时流快照的 `permission`，并要求当前流已连接，与 Android 的 `connected && controlAllowed` 一致；断线、预取及主动 GET 尚未获流确认时禁用。队列和自动化命令也共用此门槛。远端发送保留原稿首尾空格/换行，纯空白带附件时按界面语言代入提示；未确认日志/失败恢复保留原稿。不支持的裸斜杠命令仅在无附件时禁发。`ComposerText` 规则回归通过，控制权限下逐条显示所有审批（不可回答项保留完整详情和电脑处理说明、无按钮）；只读权限下只显示待审批总提示，不展示请求卡。真实电脑权限变更、审批弹层视觉/触控及命令结果待验。 |
| 未确认命令重试与后台恢复 | ⚠️（代码对齐，实网待验） | 发送回显只按同电脑实例及回执 `userSeq`，或 `expectedSeq + 1` 与完整线上提示词相同的用户行确认，不会被历史相同文字误清；未确认时若回显已出现，只保留状态行而不重复画气泡，失败时原稿/时间与状态行仍留在详情。终态拒绝时显示 APK 式确认弹窗（标题、先核对会话的提示和错误详情），不再把详细原因常驻输入栏；传输失败另弹无标题警告，说明操作可能已执行、只能重试同一请求，电脑 `pending` 超时/`unknown` 不误弹。两种生产弹窗已在 iPad mini 6 机型模拟器夹具点按、关闭并核失败气泡/未确认重试入口，真实命令未发送。模拟器夹具还点按了未确认状态行的重试入口。状态行的重试按钮仅在前台、流已连接且实时许可为控制时启用，命令入口再核同样条件；定时查询 `pending` 回执之前也核当前页面、session 与权限，失效时保留同一请求 ID 供下次核对。退后台释放临时占用，避免回前台因旧 spinner 无法重连；列表重试只在前台列表页执行。新建会话和工作区提交前复核范围/能力。HTTP 4xx 次级错误提示和真实电脑断线/权限变化/后台时序仍待验。 |
| 远程模型／思考等级／权限弹层 | ⚠️（代码对齐，操作待验） | `RemoteSettingsPopupView` 从工具按钮上方弹出，沿电脑返回顺序列模型并仅在首次遇到类别时插标题；思考等级在同一浮层内可返回模型，权限三项单独弹出；共用 `PopupChoiceRow`、玻璃质感背景。旧电脑模型缺 `connection` 时按 APK 归入 API，缺 `name` 时显示模型 ID；两项解析回归通过。iOS 15 类型检查通过，尚未有已配对电脑的真实交互。 |
| 远程附件入口与底部面板 | ⚠️（代码对齐，操作待验） | 输入栏「+」始终存在并随控制权禁用；底部面板含拍照/照片/文件、能力说明、安全级别及产物入口，选择后关闭面板再打开对应选择器；不能添加图片时按 Android 的能力／上限／连接规则说明原因。小屏、键盘、真机未验。 |
| 消息队列（50/会话、200/电脑、暂停继续、移出） | ⚠️（代码对齐，实网待验） | `RemoteStatusBars.QueueCard`（`RemoteSnapshot.canQueue` 判定能力，`queueVersion` 只增不减）；`AppModel.resumeQueue`／`removeQueued` → `queue-resume`／`queue-remove`；忙碌时发送按钮变「加入队列」（`send()` 带 `queue: true`）。滚动区上限 200pt、移除按钮 48pt 触控区及错误正文点按区已按 Android 调整；命令要求实时控制权限，真实队列/弱网与实际触控未验。 |
| 自动化状态（目标／定时任务 暂停恢复） | ⚠️（代码对齐，实网待验） | `RemoteStatusBars.GoalCard`／`TaskCard`；`RemoteGoalVisibility` 移植了「完成后被更新的一条消息顶掉」的消隐规则；`AppModel.controlGoal`／`controlTask` → `goal-control`／`task-control`。两个操作至少 40pt 高且要求实时控制权限；真实状态变化、弱网和有数据界面未验。 |
| 编辑上一条消息重发（`editSeq`） | ⚠️（代码对齐，实网待验） | `AppModel.beginEdit`/`cancelEdit` + `send()` 走 `action: "resend"` + `editSeq`；像 APK 一样直接点按最新完整用户气泡进入编辑，被截断/旧消息无编辑入口；编辑目标按会话保存，真实电脑与真机触控未验 |
| 草稿（按会话保存） | ✅（代码） | 草稿文字、编辑目标及附件选择按电脑/会话写入加密配置；重启恢复。 |
| 会话被删除后发送 404 恢复（v0.3.58） | ✅（代码） | `pendingCommand` 现在持久化；404 会释放无法确认的请求并恢复草稿与附件，不能再以“iOS 未持久化”作为免做理由。 |
| 远程消息队列（50/会话、200/电脑、暂停继续） | ⚠️（实网待验） | 见上：队列区 + 能力判定 + 加入队列/继续/移出 |
| 自动化状态（目标／定时任务 暂停恢复） | ⚠️（实网待验） | 见上：状态区 + 消隐规则 + 暂停恢复 |
| 附件：20 个/条、图片 3072/90/4 MiB、文档 10 MiB、合计 32 MiB | ⚠️（代码/边界及本地 Files 六格式通过，其余待验） | `AttachmentPickers` 的 Files 选择与 Android 一样按类型分流：图片压缩、文档限量读取；混合选择整批校验并回滚。照片顺序读取临时文件、用 ImageIO 下采样再编码，不同时驻留多张完整原图；读取失败不再静默丢项，选择器完成/取消会明确收起。iPad mini 6 机型 iOS 18.6 模拟器已从本地 Files 选入 JPG、TXT、1.3 KB 文本及约 1.9 MB 图像 PDF、DOCX、XLSX、PPTX，显示缩略图/文档卡片且发送启用；JPG+TXT 与三种 Office 各自混选均成功。移除后禁用且密封目录无残留；含 ZIP 混选整批拒绝。失败后重新选入有效 TXT 时不再保留过期错误提示。先前误把系统多选空心圈当成加载圈，PDF 初次不能提交是键盘焦点仍在侧栏；生产设置仍为 `asCopy: true`。其他文件提供器、远端聊天与真机待验。 |
| 产物列表 | ⚠️（代码对齐，操作待验） | `ArtifactScreens.swift`、`RemoteApi.artifacts`：按 APK 的宽底部面板、分组文件卡片/全宽下载、固定完成按钮与状态/重试/加载更多重整；重开清旧页，关闭后忽略旧响应，失败重试保留页游标。真实电脑与小屏视觉尚未验收。 |
| 产物下载到手机（流式、进度、取消） | ⚠️ | `RemoteApi.artifact(...to:)` 在内置/外部两种模式下均边收边写私有临时文件，校验 Content-Type、声明大小并交给系统 Files 导出，不再误用 8 MiB JSON 限额或整份留内存；前台有字节进度与取消，下载单独排队且错误/切换电脑时清理。与 Android 的「先选保存位置、后台服务直接写入」仍不同，真实大文件/弱网未验。 |
| 后台下载 + 通知进度 | ⚠️ | Android 是 `dataSync` 前台服务直写用户选定位置 + 通知栏进度（带取消）；iOS 无前台服务，现实现为「流式下载到私有临时文件 → 系统 Files 导出」，离开前台不保证继续、中断需重下。内置 tsnet 的用户态接口不能由后台 `nsurlsessiond` 使用。外部系统 VPN 可使用后台 `URLSession`，但[Apple 文档](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background)明确其总是跟随重定向、无法通过 delegate 拒绝；现有 Android 和 iOS 前台下载均禁止重定向以守住带 bearer 的 100.x 地址白名单。因此不能安全地直接替换，需先设计无设备 bearer 的后台下载协议并真机验收；不是「iOS 一律不可能」。 |
| 后台通知（连接常驻、下载进度） | ⛔ | 取舍，且 Android 同样不承诺（`android/README.md`：「后台停止连接，不承诺后台通知」）。**连接常驻条** iOS 无对应形态且无意义：iOS 后台无常驻进程可「断开」，Live Activity 是 16.1+、与 15.0 下限冲突。**下载进度通知**技术上可做（纯本地通知，零 entitlement、不需付费账号、不需服务端），但只在 App 存活时发得出来，而 App 一挂起就收不到快照——**命中窗口只有离开前台后的约 30 秒**，长任务数分钟后才完成，届时已无从知晓。要覆盖锁屏只有 APNs（付费账号 + 电脑端公网可达 + 中继服务 + 令牌回传）或 `BGAppRefreshTask`（节流到 15 分钟起、每次唤醒重建隧道），均不划算 |
| 预加载 | ⚠️（代码已对齐，实网待验） | 电脑状态页探测成功后预取列表首屏到 `RemoteListCache`，并为所有已配对电脑排最近 10 条快照；当前列表也排同样的立即任务。`RemotePrefetchPlan` 把旧快照和后续列表页放到最后交互约 2 秒后的单线程空闲队列，页链逐页推进、60 秒去重；`RemotePrefetch` 缓存仍按版本/时效/内存上限约束。缺消息数组的快照不写入预取缓存；重开只展示历史，不回放过期的审批、运行状态、队列或设置。预取独立于用户命令串行队列；切电脑/退后台/进详情关闭在途预取请求，远程列表/详情切换时关闭旧普通请求并复用传输，session 彻底结束时永久关闭传输；排队命令不会再发往旧电脑。取消竞态有确定性检查，真实网络点击延迟和关闭时序仍待验。 |
| 会话列表加密缓存 | ✅ | `CamelliaCore/Remote/RemoteListCache.swift`：1000 条/电脑、共 20 份，AES-GCM 密封（上下文 `camellia.remote.cache.v1`，与凭据文件不通用），键为地址+令牌摘要（令牌不落盘）；启动先画缓存再等实时列表，失败时保留缓存列表 |
| 已读状态同步 | ✅ | `RemoteApi.markRead` → `POST /v1/conversations/{id}/read`；`Endpoint` 白名单已含 `/read`；`AppModel.syncRead` 在快照到达时上报（前台才发） |
| 查找文件 `/find` | ✅ | 与 Android v0.4.0 一致：输入框手动输入 `/find`（裸 `/find` 也可发送），由电脑端 `commands.js` 拦截并本地搜索。Android 在该版本已移除独立按钮，iOS 同样不设按钮，无需新端点 |
| 位置 | ⚠️（代码规则齐，真机与实网待验） | `CamelliaCore/Remote/LocationContext.swift`（相关性正则：代码块／翻译／引用／明确拒绝先否决，再匹配地点词，无地点词的天气问法排除）+ `CamelliaCore/Location/LocationService.swift`（`requestLocation()` 单次、`kCLLocationAccuracyKilometer`、10 秒放弃、取点须在 120 秒内、精度取 2 km 下限）。发送前弹 `LocationConsentSheet` 询问「允许本次／不提供／取消」，同意后复核原稿、会话、电脑地址及服务实例，避免重连到新实例时发送旧内容。**差异**：iOS 14 起无粗略/精确定位权限之分，只用一次性授权；远程把位置注记拼进提示词，本机只拼进出站请求历史、不写入本机会话正文。真实定位权限与重启竞态未运行验收。 |
| 配置迁移「从电脑导入」 | ✅ | `RemoteApi.apiKeys()` → `GET /v1/api-keys` |
| 已归档（恢复／永久删除） | ⚠️（假资料恢复与删除确认已点验） | `LocalChatSettingsScreens.swift` `LocalChatArchiveView`：列出**本机**已归档会话，卡片内直接有「恢复」与「永久删除」按钮（删除前二次确认），不是滑动/长按。iPhone 模拟器用一条空假会话核过有数据卡片、删除确认取消、恢复后空态和设置计数归零，未执行永久删除。页注与 Android `SettingsActivity.archived()` 一致。**澄清**：Android 的「已归档」页同样**只列本机会话**，远程归档由电脑端管理，**不存在远程归档列表**；远程侧无需新界面，远程归档命令 iOS 已有（`AppModel.archiveConversation`）。 |
| 语言／外观／回车三模式 | ⚠️（选项面板已对齐并模拟器点验） | 偏好与外观、回车行为已有；通用页三组选择现共用与 Android `SettingsChoiceDialog` 对应的底部面板（标题、单选勾、取消），不再用系统 `confirmationDialog`。语言/外观环境已放到 `RootView` 全屏展示器外侧，修复设置页打开时切换语言不即时更新；iPhone 模拟器已核三组选项英文、已选标记、取消、中文深色及中文→系统英文即时切换，并恢复系统外观；iPad 模拟器已核回车面板宽度与底部位置。共用输入控件已修复尾随换行粘贴误发，以及与 Android `LengthFilter` 不一致的字符计数/插入位置截断；模拟器 delegate 回归覆盖 Return、粘贴、仅按钮发送与 UTF-16 边界，完整键盘交互仍待验。iOS 不支持所有键盘通用的长按回车手势，选项文案按实际能力调整；真机/iOS 15、其他动态文案仍待验。 |
| 本机名称 | ✅ | `SettingsView` 内就地编辑弹窗（与 Android 相同；最多 80 字符、空名阻止保存） |

### 本机聊天

后端 12 个文件全部落地（`CamelliaCore/LocalChat/`），界面也已补齐：首页是 Android 那样的「本机聊天 / 远程控制」两张卡片（`HomeScreen.swift`），本机侧有会话列表（工作区分组折叠、长按菜单、多选）、聊天页（Markdown、附件、进程折叠）、供应商与 Key 设置页（`LocalChatSettingsScreens.swift`）和已归档页。

| Android | iOS | 证据 / 缺口 |
| --- | --- | --- |
| 供应商与 Key 管理（多 Key 轮换、`别名=上游模型`、OpenAI/Anthropic/Dual） | ⚠️（界面重做，完整数据验收待做） | `LocalChatConfiguration.swift` + `ProviderSettingsView`（按供应商分组、导入/导出/从电脑导入）；编辑页有滚动表单与底部保存/取消，密钥在单个描边区域内逐行安全输入，协议/导入/导出/移除使用 APK 风格底部面板。导入和手动编辑现按 Java `trim()` 保留 Key 两端的不换行空格，模型 ID 按 Android UTF-16/ASCII 控制字符规则校验；`enabled` 按 Android `optBoolean` 仅接受布尔值及 `"true"/"false"` 字符串，数字取默认启用。14 项新增纯规则回归通过，真实 Key 仍未试用。模拟器已核英文空表单错误、两条假 Key 保存/再编辑/移除、空 JSON 导入错误；iPad mini 6 机型 QA 模拟器另经界面导入完整假 v2 JSON，显示一个模型，并以该模型收到本机流式回复。多电脑来源、真实配置/真机/小屏仍待验。编辑已有模型时保留原协议字段，不再改成 `auto`。 |
| JSON 配置导入导出（`camellia-api-routes` v2） | ⚠️（异常配置恢复已在模拟器点验，真机待验） | `LocalChatConfiguration.parse/export`、`ConfigImportView`；导入页已改为底部表单，无效 JSON 错误就地显示而不关闭。已保存配置若路由解析失败，iOS 现按 Android 列表错误路径显示原因、保留旧会话并允许进入，不再误报「没有模型」或把新建引向供应商页；专用 iPhone 16e 模拟器注入无效协议名并实测错误提示、会话保留、新建再提示，随后经界面导入纯假有效 v2 配置，显示一个模型且旧会话仍在，证据见 `dist/screenshots/client-iphone-config-error-20261004.png` 和 `client-iphone-config-error-list-20261004.png`。导入 JSON 与模型行改用关闭智能引号/破折号的轻量 UIKit 输入框，保留既有面板外观；iPhone 模拟器实测逐字键入 ASCII JSON 后得到 v2 格式错误而非 JSON 语法错误，模型双连字符原样保留，截图 `dist/screenshots/client-iphone-json-plain-input-20261004.png`。[Apple DTS 确认](https://developer.apple.com/forums/thread/824922)没有 Android `FLAG_SECURE` 的公开等价 API，不能保证阻止用户截图；`ClientDelegate` 已在 scene 退活动/入后台时加不透明遮罩来保护任务切换器快照；iPad mini (A17 Pro) 模拟器带键盘切换器缩略图已核为纯色，返回正常；真机及系统权限弹层待验。真机剪贴板与真实配置往返待验。 |
| 从电脑导入 | ✅ | `AppModel.importApiKeys(into:)` → `RemoteSession.apiKeys()` → `GET /v1/api-keys` |
| 模型／思考等级按会话保存 | ⚠️（平板与 iPhone 假数据已点击，真 API 待验） | `LocalChatThinking.swift`、`LocalChatStore`、`LocalChatModelPicker`；不再用系统整页列表，改为输入框上方的两层浮窗，含「管理 API 配置」入口；iPad mini (A17 Pro) 与 iPhone 16 Pro 模拟器已实际打开浮层、进入思考子层、选「标准」并看到输入栏标签更新。未知服务商等级的显示现按 Android Java `trim()` 保留非 ASCII 边界空格；不支持模型时的禁用和真 API 请求仍待验。 |
| 流式回复、停止、Markdown | ⚠️（流式与停止假接口实测；真 API 未验） | `LocalChatClient.swift`、`Shared/MarkdownView.swift`、`LocalChatDetailView`；iPad mini 6 机型 QA 模拟器从真实输入栏发送，经 127.0.0.1 上的 OpenAI SSE 假接口收到两段回复并持久化，重启后仍可打开会话。原先首段很快到达时被 80 ms 节流压住，现与 Android 一样首段立即更新；保持流打开的协议回归先失败后通过，慢流模拟器实见首段「Camellia 」后点停止，首段留在会话中。慢流请求点「停止」或退后台后，`URLSessionChatTransport.cancel()` 主动关闭连接，服务端记录客户端断开。长中文回复、SSE 行/事件/累计文字与服务商错误现按 Android UTF-16 字符上限处理，静默错误正文有可中断的 5 秒截止；已通过假传输回归，尚未验证真实服务商、Markdown 复杂渲染与 iPadOS 15 真机。 |
| 流式输出跟随（向上阅读时保留位置） | ✅ | Android 的规则是 `content.bottom - viewport.bottom < dp(120)`，只在贴近底部时跟随、向上阅读时不动（`LocalChatActivity.renderLiveBody`）。iOS 15 无滚动偏移 API（`scrollPosition` 为 iOS 17、`onScrollGeometryChange` 为 iOS 18），改为两个 `GeometryReader` 探针分别读视口与内容的下边缘全局坐标，其差值正是 Android 比较的那一段；规则本体在 `CamelliaCore/Sources/ScrollFollow.swift`（脱离 Xcode 可校验，12 项），SwiftUI 胶水在 `CamelliaApp/Sources/Shared/ScrollFollowViews.swift`。打开会话与发送是 Android 的两处无条件滚底，因此强制跟随；流式分片仅在贴近底部时跟随 |
| 图片（最长边 3072、质量 90→60、4 MiB/张、20 个附件/条） | ⚠️（照片及本地 Files 单图实选；真机待验） | `Shared/AttachmentImage.swift`、`LocalChatAttachmentTray`；iPad mini 6 机型模拟器从系统照片选择器加入一张内置示例图，退出再打开会话仍显示草稿缩略图，随后移除，密封附件与 `.thumb` 均被回收。改为顺序获取并下采样后，单选与花图/瀑布图双选均重新实测成功，双选缩略图顺序正确，测试附件随后移除；本机预览随附件加密保存。另从本地 Files 选入 JPG，按图片而非文档处理，缩略图、发送状态和移除均正常；历史图片条目组装请求时按 Android `getString` 转换 JSON 值，不再静默丢项；真机照片/相机、其他 Files 提供器、极大图与远程模式仍待验。 |
| 文档：Office 文本提取、PDF 原生输入 | ⚠️（解析检查及本地 Files 入口实选通过，真 API 待验） | `ChatDocument.swift`（Word／SharedStrings／Sheet 三个 parser + `ZipArchive`）；文件拷贝先查大小、再按块限量读取，10 MiB 边界有确定性检查；文件名/文本/Office 的 UTF-16 单位长度与 Java `trim()` 已对齐 APK，表格共享字符串按每条分别限长，极长真实 Office 文件仍待运行验收；读取和解析失败显示错误并撤销本轮附件。iPad mini 6 机型模拟器的 Files TXT、1 页文本 PDF、约 1.9 MB 图像 PDF、DOCX、XLSX、PPTX 均已选入草稿并显示对应卡片、发送启用，移除后禁用；Office 三种格式一次多选后返回重开仍在。请求组装会拒绝非对象文档及缺文件名/数据的 PDF，不再送出残缺附件，错误提示可读；附件未发送，Office 提取内容及 PDF 原始字节进入真实服务商请求尚未做端到端验收。 |
| 受限联网工具 `web_search`／`web_fetch` | ⚠️（逻辑回归通过，真实服务商待验） | `LocalWebTools.swift`（含 `RSSParser`）、`LocalWebExecutor.swift`、`LocalToolLoop.swift` 与输入框工具开关；上下文/结果长度和参数空白规则已按 Android UTF-16/Java `trim()` 对齐，假传输已核两轮工具调用与大段中文，真实搜索、抓取和提供方工具协议仍待验。 |
| 发送前附件丢失 | ⚠️（iPhone 模拟器已核，真机待验） | 本机 `LocalChatModel.sizes()` 和共用 `AttachmentRules.validate()` 不再把读不到大小的附件当作 0 字节；与 APK 一样在请求组装前显示“附件已丢失，请重新添加 / Attachment is missing; select it again”，保留草稿供重选。3 项新增规则检查先复现旧实现失败；专用 iPhone 16e 模拟器从不存在的图片引用实际点发送、重启再开均见旧草稿，无新消息。截图 `dist/screenshots/client-iphone-missing-attachment-20261004.png`；真实设备文件提供器与真实服务商仍待验。 |
| 附件错误正文 | ⚠️（规则已核，逐类设备触发待验） | `AttachmentError` 的 12 类现有错误正文按 APK 对齐；数量、大小、旧电脑能力限制为中英双语，两类图片编码错误为英文。表驱动回归先复现 10 项旧文案不符，现 12 项均通过；这不等于相机和文件提供器的真实触发验收。 |
| 草稿 | ✅ | `LocalChatDraft.swift`、`LocalChatStore`、`LocalChatModel.stashDraft`；发送前按 Android Java `trim()` 处理正文，定位同意期间以原稿（含空格）复核是否仍为同一草稿。 |
| 本机会话搜索 | ⚠️（搜索与清除按钮已在模拟器点验，真机待验） | 与远端搜索不同，Android 本机列表保留输入的首尾空格，只显示有匹配标题的工作区/独立会话分组；iOS 用原始查询匹配并隐藏无匹配分组，保留全局工作区入口与无结果引导。空格查询有 2 项规则回归；iPhone 16 Pro iOS 18.6 模拟器对现有假会话实际输入 `New` 命中、` New ` 无结果，触摸「Clear search」恢复列表。无结果说明原把清除按钮并入同一辅助功能容器，现把说明与操作拆开；iPad mini 6 机型 iOS 18.6 模拟器的辅助功能树已分别暴露说明和 `Clear search` 按钮，点按后测试会话恢复。搜索标记现按 APK `LineIcon.search` 线条路径无底圆绘制，按钮按 `ChatEmptyState` 的 48pt 胶囊底色绘制，横屏截图 `dist/screenshots/client-ipad-search-empty-landscape-20261004.png`。iPadOS 15 真机 VoiceOver 仍待复测。 |
| 仅附件新会话标题 | ⚠️（规则检查通过，界面未验） | `ComposerText.localTitle` 按当前语言生成「附件／Attachments」，并先取最多 60 个 UTF-16 单位、再把换行换成空格。5 项纯规则回归通过；本轮 iPad QA 模拟器的 Files 选择器无法被自动化可靠选中，所以没有发送附件，不把标题运行态标为通过。 |
| 工作区／会话管理（增删改、归档、置顶） | ⚠️（代码齐，本机部分实测） | `LocalChatStore.swift`、`LocalChatListView`；会话菜单用共用五项锚定浮层，工作区两项操作列表、名称/标题输入、单条与多选删除确认均为 APK 式底部面板。本机写入失败时输入不被清掉；共用文字面板的键盘「完成」只收起键盘，提交仍须点「保存」，与 Android 同步。iPhone 模拟器已点验空工作区新建/重命名/重启保留/移除、键盘「完成」不提交、会话标题预填/空值错误、删除确认取消、中文深色工作区表单/单条删除确认，以及置顶、多选、归档/恢复；iPad mini (6th generation) iOS 18.6 模拟器核首页、本机列表与工作区输入面板竖/横屏及键盘，iPad mini (A17 Pro) 核同类面板和会话菜单。实际删除会话、工作区移除后会话保留、真机长按及 iOS 15 真机仍待验。Android `README.md` 明确当前长按不再拖动、排序或移动；iOS 无需添加这套旧交互，存储层兼容方法也不算 UI 功能。 |
| 编辑上一条消息重发 | ✅ | `LocalChatModel.beginEdit` + `send()` 按 `editingIndex` 截断重发，界面有铅笔与编辑横幅 |
| 本机详情页头与返回 | ⚠️（iPad 竖横屏、iPhone 小屏 100 单位标题已点验，真机待验） | Android `LocalChatActivity.shell()` 在列表/详情都用 48dp 圆形返回键和左侧标题＋设备副标题。iOS 详情原为系统蓝箭头和居中单行标题，现改为内容区自绘页头；iPad mini 6 机型 iOS 18.6 模拟器的 “On this iPad · Direct API” 未截断，圆键返回恢复列表，竖屏截图 `dist/screenshots/client-ipad-local-detail-portrait-20261004.png`。iPhone 16e 模拟器另用纯假配置进入空会话，确认 “On this phone · Direct API”、圆键返回与输入聚焦，截图 `dist/screenshots/client-iphone16e-local-detail-20261004.png`；重命名为长标题和恰好 100 个 UTF-16 单位的上限标题后均是标题省略但副标题与返回键保留，完整标题仍可由辅助功能读取，点返回后列表保留该标题，截图 `dist/screenshots/client-iphone16e-local-long-title-20261004.png`、`dist/screenshots/client-iphone16e-local-title100-20261004.png`。模拟器鼠标拖动连系统主屏翻页也未触发，不能作为真机触屏返回手势证据；iPadOS 15 真机仍待验。 |
| 界面（首页两卡片、列表、聊天页、供应商设置页） | ⚠️（平板与 iPhone 小屏部分交互已验，逐页验收未完） | `HomeScreen.swift`、`LocalChatScreens.swift`、`LocalChatSettingsScreens.swift`。本机详情零消息引导、模型/思考、附件、联网面板已在 iPad mini (A17 Pro) 与 iPhone 16 Pro 模拟器点击；平板上的联网取消/保存、草稿/返回恢复通过；iPhone 键盘 Send 标签和输入栏不遮挡已点验。iPad mini 6 机型模拟器已完成假 v2 配置导入→选择模型→SSE 回复→会话列表→重启后恢复，供应商说明及相关页面设备称谓按 iPad 适配。本机零消息引导现从包内松散 PNG 明确加载 APK 同源猫图，横屏实见、`Write a message` 点按后键盘出现；远端同样共用此品牌图与按钮但没有真实配对电脑的详情验收。假 API 失败曾暴露 Swift 错误类型名，现已在 iPhone 模拟器复测为纯英文的可读提示。实际输入暴露过导航目标缺失 `AppModel` 的崩溃，现已复测无崩溃。附件来源、真 API、多行、深色中文仍待验。 |

## 历史真机反馈修复（三个；不是当前包的端到端验收）

装到真机后报回三个问题，都是真机上才暴露、类型检查与协议检查都看不到的：

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 主屏图标外面一圈很粗的黑边 | 共享画稿 `assets/icon-1024.png` 是「透明画布里的圆角方块」——给会自己衬底的启动器用的。iOS 把图标当不透明方块画，透明像素一律填黑，于是那圈留白变成黑边 | 打包时先衬底再缩放：新增 `tools/flatten-icon.swift`，取画稿边缘内侧四点采出底色（得 `#E3EAF6`，与 Android 自适应图标 `launcher_background` 的 `#E6EDF6` 相差无几），用 CoreGraphics 把画稿合成到该底色上并输出无 alpha 的 PNG，`build-ipa.sh` 再从这张图缩三种尺寸。模拟器脚本 `run-app.sh` 也改用相同流程，否则 iPad 会因缺 152 px 图标而显示灰色占位；iPad mini 6 机型模拟器重装后主屏已核品牌图标，包内对应 PNG 与模拟器构建的 SHA-256 相同。衬底失败时打包现在直接失败，不再发布已知黑边图标。见辅助文件头部「试过并否掉的两种做法」 |
| Tailscale 登录成功后左上角只有「取消」，应该是「完成」 | `LoginPresenter` 用的是 `ASWebAuthenticationSession`，它把这件事建模成「只能放弃」，那颗按钮的字面就是 Cancel，改不了 | 换成 `SFSafariViewController`：同样在 App 内、同样不把 App 推后台（`LoginPresenter` 存在的理由不变），但关闭按钮由 `dismissButtonStyle` 决定，默认 `.done`，中文即「完成」。present 前要先找到最上层 VC，否则登录 sheet 在屏时从 window 根 VC present 会失败 |
| 点「请求配对」没有任何反应 | 两处叠加：最初客户端没有把表单地址交给传输，请求打到空地址；同时 `worker`／`notify` 被覆写为同步执行，隧道拨号冻结主线程，瞬间失败又没有可见状态 | `PairingTransport` 的请求/轮询接口现在各自显式携带验证过的 origin，无需共享可变地址；`PairingController` 使用后台 worker 与主队列 notify，轮询放在串行后台队列。配对页状态行直接读 `model.pairingPhase`，失败不会被隐藏在根视图 alert 后面 |
| 当前包真机复验 | 未完成 | 需按 `WORKPLAN.md` 的真机条件复验；下文仅为确定性代码回归 |

> 第 3 条顺带说明为什么类型检查抓不到：空地址与同步拨号都不违反类型约束，只在运行时暴露。2026-10-03 复审又把代际检查扩展到排队的 UI 通知和草稿清理，写入与 `begin()` 互斥；旧轮询清理 claim 时必须匹配原请求。确定性回归已纳入协议检查。

## 历史真机反馈修复（第四个；不是当前包的端到端验收）

装上新包后再报回一条：**配对成功了——电脑端能看见手机、iOS 端也提示成功，但只有「电脑」列表里是成功的，进不去「远程控制」**。附的两张截图正好把矛盾摆在一起：电脑列表里 `HP / http://100.110.66.59:43127` 带蓝勾、绿点、「已连接」；而远程控制页标题栏已经是 `http://100.110.66.59:43127`（说明 `current` 有值），正文却是 WelcomeView 的「还没有连接电脑」。

| 现象 | 根因 | 修法 |
| --- | --- | --- |
| 配对成功，`电脑` 列表显示「已连接」，但 `远程控制` 仍停在「还没有连接电脑」 | 两处叠加，可复现。<br>**其一（写入时机）**：`PairingController` 的 generation 票据只在 `request()`／`claim()` 的**入口**比较一次，而这两个调用都会阻塞在隧道上。连点两次「请求配对」（或第一次看起来没反应又点了一次）就有两个请求在飞，电脑端只批准其中一个；另一个的拨号晚于批准返回时，入口那次检查早已通过，于是它**照样写入**自己的 claim，而且落在**当前电脑**上。<br>**其二（不对称的守卫）**：`ComputerStore.save` 写列表时有守卫——没有 token 的「请求」不进列表（否则每个被放弃的请求都要用户手动删）；但写顶层（= 当前电脑）是无条件的。于是迟到的请求把凭据从**当前电脑**上抹掉，却留在了列表里 —— 列表说「已连接」，当前电脑说「没配对」。`CamelliaClient` 的远程控制页只问 `current?.isPaired`，两处就此分叉 | 三层都改：<br>① `request()`／`claim()` 在**阻塞调用返回之后**重新核对票据（`isCurrent`），被顶替的那一轮既不写库也不报错——报错同样会把新一轮的状态行覆盖掉；票据本身改用 `NSLock` 保护（它由调用方线程写、worker／poll 队列读）。<br>② `save` 不再「降级」：同一地址上已有的 token／deviceId／permission／computerName，如果这次传进来的对象没有，就带过去 —— 一个在飞的配对请求没有理由把已经在用的配对解绑。列表守卫改看**传进来的对象自己**有没有凭据，所以迟到的请求既改不动列表，也拿不掉顶层的 token。<br>③ `current()` 改为按记录读：顶层是指针、列表才是记录，当列表里同一地址已有一条**已配对**记录、而顶层只有一个 claim 时，读列表。这同时**修复了已经装在手机上的那份坏状态**——光靠前两条只能防止以后再写坏，改不了已经写坏的存档 |
| `远程控制` 在「已配对但没有选中」时是死路 | 该页只有「添加电脑」一个出口。把电脑指针移开（例如添加第二台）后，页面既不提示已有配对，也不给选中的入口 | `WelcomeView` 分两种情况：没有配对时照旧「还没有连接电脑／添加电脑」；已有配对但当前没选中时改为「还没有选好电脑／选择电脑」并说明原因 |
| 当前包真机复验 | 未完成 | 需按 `WORKPLAN.md` 的真机条件复验；下文仅为确定性代码回归 |

证据与回归：先用一段脱离 Xcode 的复现程序把时序摆出来——让第一个 `pairRequest` 在「拨号中」回调里跑完第二次 `start` 与它的批准，再让第一个拨号返回。修复前该程序输出 `top level: token=false claim=true` / `list row: token=true`（正是截图里的两处矛盾）；修复后两处都 `token=true` 且一致。这段时序已收进检查套件（`DiallingStub` + `queueingHarness`，worker 队列被捕获而不是直接执行，所以是确定性的、不是有时能撞上的竞态），连同「读回一份坏存档」与「在飞的请求不解绑」共 12 项，套件 951 → 963 项全过。

> 同样地，类型检查抓不到：`generation` 的比较位置、以及「顶层无条件写、列表有条件写」都是逻辑问题，不违反任何类型。

## 聊天页观感对齐（`shell()` 那一层）

这一批把聊天相关的页面按 Android 的**观感**重整了一遍，代码在 `CamelliaApp/Sources/Shared/` 下三个新文件里。功能此前已对齐，这一批改的是「两个 app 摆在同一张桌上时看起来是不是同一个 app」。

| 改动 | Android 依据 | iOS 落点 |
| --- | --- | --- |
| 换掉整套系统语义色 | `ChatStyle` 硬编码的五色 + `SettingsStyle` 另有一套 | `Palette` 改为 Android 的实际色值（强调色 `#4176E6` 而非系统 `#007AFF`），仍按浅色／深色两个外观分别解析，设置／电脑／配对页用第二个 `grouped` 底色 |
| 页面左右留白与底部间距 | `shell()` 的 `dp(18) + insets`、内容 `dp(16)`、dock `dp(8)` | `PageGutter` 三个常量，行是 `ScrollView` 的子视图，所以留白同时管到输入框 |
| 行不画在 `List` 自带的底上 | Android 的行直接坐在页面色上，卡片感来自行自己的圆角背景 | `plainPageRow()` 去掉行内缩进／分隔线／底色；`TableBackgroundClearer` 让表格透明（iOS 15 没有 `scrollContentBackground`，而改 appearance 会连带把设置页 `Form` 的灰底清掉，所以从列表**内部**向上走树找那张表） |
| 标题与副标题 | `shell()` 对 list 与 detail 只画同样三样东西：返回键、标题、电脑名 | `RemotePageHeading` 把两个页面原本各写一套、已经漂移的标题收成一处 |
| 圆形返回键 | `ChatStyle.backButton()`：48dp 白圆盘 + 细边 + 4dp 投影 | `RoundBackButton`（系统 chevron 颜色、大小、位置都不对） |

**顺带修掉的两个问题**：

1. **`RemoteConnectionNote` 丢关联值**。`switch` 写的是 `case .reconnecting:`，而该 case 带 `(TimeInterval, Error?)`。Swift 允许省略模式匹配任意关联值，**能编译通过**，但倒计时的秒数被丢掉了 —— 与 Android `headerConnection` 的「正在重连（N 秒）」不一致。改成 `case .reconnecting(let delay, _)` 并把秒数显示出来。
2. **这段逻辑此前无法被检查**。它原本在 `CamelliaApp`（SwiftUI 层），而 `check-protocol.sh` 只编 `CamelliaCore`，`check-client.sh` 只做类型检查、不做断言 —— 也就是说丢关联值这类错误两套闸门都拦不住。按 `ScrollFollow` 的先例把它移进 `CamelliaCore/Remote/RemoteConnectionNote.swift`，加 7 项断言（含「丢掉关联值就编不过」的那条边界：`.reconnecting(1.6, nil)` → `正在重连（1 秒）`）。

> 可见性上要跟 `RemoteStreamState` 一致：两者同为 `internal`（同模块编译），`public` 方法配 internal 参数类型**编不过**（`error: method cannot be declared public because its parameter uses an internal type`）。

## 旧计划缺项的处理记录

以下记录旧计划的遗漏与当时的判断；当前状态和后续任务以 `WORKPLAN.md` 为准。

1. **版本基线**：写明最低 iOS 15.0，并说明它由 `build-ipa.sh` / `check-client.sh` / `check-camera.sh` 三处强制。
2. **「功能完整」的定义**：把 `android/README.md` 的功能清单作为对齐基准引用进来，而不是只写 S3／S4 的功能分组 —— 否则每轮实现都靠记忆判断「齐了没有」。
3. **上表 8 项缺失功能**：逐项写明是纳入范围还是明确放弃。其中「已读状态同步」与「配置迁移」都要动 `Endpoint` 白名单，必须注明两端一起改。
4. **本机聊天界面的工作量**：计划说 S4 只剩「约 2.1k 行专属逻辑」，因为共享组件在 S3 一次写好。实测共享层（`MarkdownView`／`Palette`／`AttachmentImage`）只有 3 个文件，Android 那批共享组件（输入框、附件面板、弹窗、设置样式）在 iOS 侧对应的是各页自己实现 —— 本机聊天缺的正是这层界面，不是「2.1k 行逻辑」。
5. **平台限制的措辞**：「不做后台通知」是取舍，但「后台不保持长连接」是 iOS 没有前台服务等价物，属平台限制。两者在旧计划当时写成了同一类。

## 结论与下一步

主流程代码已落地，但**不能宣布完全对齐**。已发现并修复远程命令确认/持久化、配对跨电脑竞态、附件编码、列表分页、旧版事件流轮询、外部 VPN 开关空转、大文件下载、本机停止后底层连接未关闭及首段 SSE 被节流压住等实际缺陷；远程页生命周期和首页入口六态也已按 APK 收拢，失效 session 的排队命令不会再发往电脑，在途预取与普通 JSON 请求也会关闭；同一详情重连保留历史，预取及主动 GET 不单独授予操作权，断流即撤销详情控制资格，权限以实时流快照为准；切页会中断旧流的长退避，短流收到快照后隔 1 秒、首次空流断开后隔 2 秒重连；404 轮询降级与 400/409 重试按 Android 的事件流条件分类。

本轮协议检查通过 1423 项，外部 HTTP 检查通过 24 项（含鉴权请求拒绝重定向）、输入控件模拟器回归、网络/相机层及 iOS 15 两目标类型检查；当前客户端 iOS 15 arm64 未签名 IPA 已重建并验包。403/404 终态在流、主动快照、旧分页、列表和命令失败路径均先取消在途预取再清对应缓存，并在详情撤下旧消息与流式回复；一次性请求失败不冒充流断开，普通断流重连仍保留历史；损坏配对条目不再静默丢弃或被下一次保存覆盖，未使用的平行发送状态机已删。名称/标题表单与供应商 Key/模型校验现按 Android 的 Java `trim()` 与 UTF-16 边界处理，导入配置的 `enabled` 布尔转换也对齐平台 `optBoolean`；本机搜索保留原始空格并隐藏无匹配分组，区别于远端搜索；表单光标中途插入仍需真机输入法对照。本机聊天的长中文回复与错误正文长度、SSE 裁剪及静默错误正文超时已按 APK 修正；工具上下文/结果长度与参数裁剪也按 APK 对齐；远端大中文快照和解析失败的断流重连、列表事件重取失败后的退避重连已按 APK 修正；一个客户端 IPA 声明同时支持 iPhone/iPad；iPad mini (6th generation) iOS 18.6 模拟器已核首页、本机列表与工作区表单竖/横屏键盘，还通过本机假 SSE 接口完成配置导入、发送、首段流式显示、停止并保留部分回复、退后台断开及重启持久化。系统照片与本地 Files JPG/TXT/小型及约 1.9 MB PDF/DOCX/XLSX/PPTX 已实选，含 ZIP 混选时整批拒绝；新的逐张下采样路径也已复测。iPad mini (A17 Pro) 模拟器已查看首页竖/横屏及横屏设置/供应商/导入面板，还以无令牌假电脑点验了管理/重命名/移除确认并清理测试条目。这些不能代替 iPad mini 6/iOS 15 真机、真实服务商或真实配对电脑的验收。

模拟器与实际 Android 0.4.0 APK 的部分中英文/明暗首屏已逐张核对，电脑/配对/手机访问的基本往返、供应商编辑/密钥/弹层、导入错误也已实际点击；本机模型/思考、附件和联网浮层已在 iPad 模拟器用假数据点击通过，并修复了输入时缺失环境对象的崩溃与空态聚焦；会话产物底部面板和切电脑浮层仍仅完成编译和审查，不能算交互通过。13 个逻辑页面、10 类弹层的完整视觉与真实交互、带真实电脑的配对/远程操作、系统 VPN 和真机蜂窝/Keychain 路径仍需验收。详见 `ios/WORKPLAN.md`。

> 曾列为「缺远程归档列表界面」的一项是误判，已撤回：Android 的「已归档」页只列本机会话，远程归档由电脑端管理，两端本就一致（本机侧 `LocalChatArchiveView` 已对齐）。
>
> `⚠️` 是待核对或平台限制，不能统称“已完成”。iOS 的后台长连接/后台下载不能等同 Android 前台服务；其他差异必须逐项验证或修复。
