# Camellia iOS 客户端

在现有 Camellia 架构上新增原生 iOS 客户端。设计前提见桌面端的 `ios-client.md`：自用并分享给朋友、不上架、不购买开发者账号、内置 tsnet、本机聊天纳入第一版。

当前状态：**S1–S4 的代码主干已落地，S5 可生成未签名 IPA，但尚未完成与 Android 的真机端到端及逐页视觉验收。** Go 桥接已产出 xcframework；内置 tsnet 在模拟器里启动、连到控制面并拿到登录链接，但真实 `Open()` 到已配对网关仍待真机实操。外部系统 VPN 模式也已有受限 HTTP/SSE 通路，24 项无实网检查通过，真实 VPN 未验。协议/状态层有 1429 项可执行校验；首页、本机聊天、远程控制、电脑/配对、产物和设置界面已有实现。未签名 IPA 可用 TrollStore 安装，或经 Sideloadly/SideStore 重签后安装；当前进度、剩余验收见 `ios/WORKPLAN.md`，逐项对照见 `ios/PARITY.md`。

## 环境

需要完整 Xcode（包含 iPhoneOS 与 iPhoneSimulator SDK），用 `xcode-select` 或 `DEVELOPER_DIR` 选择安装路径，带版本号的 Xcode 路径也支持。Go 版本要求见 `android/tailnet/go.mod`；脚本使用 `PATH` 中的 Go，`gomobile`/`gobind` 固定在 `v0.0.0-20260908204917-8b95e45f8d3e` 并安装到 `ios/Frameworks/tools/`。

## CI

`.github/workflows/ios.yml` 在相关文件推送到 `main`、PR 和手动触发时运行。使用 macOS 15 arm64 runner、固定 Xcode 26.3，Go 版本从共享桥接模块的 `go.mod` 读取。

流水线先生成并检查本地化文案，再执行协议/本机聊天检查、外部 HTTP 传输桩检查、共享 Go 桥接测试，从源码生成包含真机和模拟器切片的 `tailnet.xcframework`，再按 iOS 15.0 目标检查客户端与诊断 App。输入框回车/粘贴回归在 runner 可用的 iPhone 模拟器中执行，不需要登录或连接真实电脑。

全部检查通过后构建两个未签名 IPA，上传到 `Camellia-ios-arm64-unsigned` artifact，附带 SHA-256 校验文件与桥接版本信息，保留 14 天。无需 Apple 签名证书；安装方式沿用下文的侧载流程。

`ios/Frameworks/` 和 `ios/dist/` 是忽略的生成物。提交 CI 时，需要同时提交 iOS 源码和共享 `android/tailnet` 的 iOS 平台桥接改动，确保干净 checkout 能重建。涉及共享桥接、Android 英文文案来源、第三方声明、图标或根 `package.json` 的修改，也会触发 iOS CI。

## 命令

| 命令 | 作用 | 需要 Xcode |
| --- | --- | --- |
| `./ios/check-protocol.sh` | 纯逻辑协议层校验，1429 项 | 否 |
| `./ios/check-external-http.sh` | 外部系统 VPN 的 URLSession 传输桩检查，24 项 | 是 |
| `./ios/build-tailnet-ios.sh` | 产出 `ios/Frameworks/tailnet.xcframework` | 是 |
| `./ios/check-network.sh` | 网络层对 xcframework 类型检查（iOS 模拟器目标） | 是 |
| `./ios/check-camera.sh` | 相机与位置层类型检查，按 iOS 15 目标，能拦住用高的新 API | 是 |
| `./ios/check-client.sh` | 客户端与诊断两个 App 按 iOS 15.0 目标整体类型检查（构建前的主闸门） | 是 |
| `./ios/check-composer.sh` | 模拟器中的输入框回车、粘贴与 UTF-16 长度回归 | 是 |
| `./ios/run-smoke.sh` | 在模拟器里真实启动节点，跑 S1 验收 | 是 |
| `./ios/build-ipa.sh` | 产出可侧载的未签名 `.ipa` 到 `ios/dist/`（`client` / `diagnostics`） | 是 |
| `./ios/run-app.sh` | 在模拟器里跑客户端或诊断 App（`client` / `diagnostics`） | 是 |

`run-smoke.sh` 支持 `--reset`（丢弃已存节点身份）与两个环境变量转发进 App：`CAMELLIA_SMOKE_TARGET`、`CAMELLIA_SMOKE_TOKEN`，以及 `CAMELLIA_INJECT_INTERFACES=1` 强制走 Android 那套接口注入以做对照。

**改脚本时注意**：每个编译 `CamelliaCore` 的脚本都自己手列源文件分组，漏一个分组只有在跑那个脚本时才报错。已经踩过一次——`run-app.sh` 漏了 `CamelliaCore/Location/*.swift`，于是 `LocationService` 找不到，`run-app.sh client` 从 Location 落地起就一直编不过（`build-ipa.sh` 与 `check-client.sh` 都有这一组，所以 IPA 和主闸门一直是好的，只有模拟器试跑坏了）。新增 `CamelliaCore/*` 分组时，要同步 `build-ipa.sh`、`check-client.sh`、`run-app.sh`、`check-camera.sh`、`check-network.sh`、`run-smoke.sh`。

## 已验证

### tsnet 在 iOS 上确实可用 —— S1 最大风险点已排除

`ios-client.md` 把"tsnet 在 iOS 上的实际可用性"列为全流程关键路径。模拟器实测：

```
node-started in 0.30s
status state=NeedsLogin loginUrl=-
login-url=https://login.tailscale.com/a/11358c4701af7f
verdict=PASS node reached the control plane and wants a sign-in
```

用户态协议栈在 App 进程内启动，无需 VPN 描述文件、无需网络扩展，且真实打到了 Tailscale 控制面并换回授权链接。后台仅能使用 iOS 给予的短暂执行窗口，不能等同 Android 前台服务。

### 接口枚举不需要注入（原待确认项 2）

`setInterfaces` 在 iOS 侧留了开关但默认关闭，实测 `getifaddrs` 在沙箱内完全可用，一次枚举出 25 个接口，地址、前缀长度、MTU 都正确：

```
interfaces=[{"Addresses":["127.0.0.1/8","::1/128","fe80::1/64"],"Index":1,"Loopback":true,
             "MTU":16384,"Name":"lo0","Up":true}, ...]
```

结论：iOS 走 tsnet 自身的 `net.Interfaces()` 即可，Android 那套注入是为 Android 11 的 netlink 限制而存在，iOS 不需要。开关保留，便于真机上出现意外时对照。

### 进程环境不再被改写（原待确认项 3）

`bridge.go` 原先无条件执行 `os.Setenv("HOME"|"TMPDIR"|...)`。在 Android 上这是子进程的私有设置，但 iOS 上节点与 App **同进程**，改写 `HOME` 会改变 Foundation 解析 App 容器的方式，影响与网络无关的文件访问。

查证 tsnet 源码后确认这没有必要：`os.UserConfigDir()`（启动路径上唯一读 `HOME` 的地方）只在 `Server.Dir` 为空时被调用，而桥接层总是设置 `Dir`。现已按既有的平台条件编译模式拆成 `prepareStateDirectory`：Android 保留原行为，iOS 与桌面不动作。改动后节点启动与控制面往返依旧通过，经验上也印证了这一点。

### 修复：流结束时 Swift 侧读到的是异常而非结束

这是本次最值得记录的一处缺陷，它会**在每个正常结束的 SSE 流上触发**。

调用链：`ReadChunk` 在流结束时返回零长度切片 → gomobile 的 `fromSlice` 把**任何**零长度切片（nil 与否都一样）压成 `ptr: NULL` → `go_seq_to_objc_bytearray` 返回 NULL `NSData` → Swift 把该方法导入为非可选 `Data`，无法表达 NULL，于是抛出 `Foundation._GenericObjCError`。

后果：Swift 读流时无法区分"流正常结束"与"读取失败"，会把每一次正常结束都报成错误。

修法选择在 Go 侧补一个显式信号，因为改 Go 侧的返回值没有用（零长度在语言边界上一定会被压成 NULL），而让 Swift 去匹配 `_GenericObjCError` 这个私有错误域太脆：

- `bridge.go` 的 `Response` 增加 `finished`，只在 `io.EOF` 或 body 缺失时置位；读取超时、连接中断**不置位**。
- 新增 `Finished()` 供 Swift 判定。
- Swift 侧 `TailnetResponse+Stream.swift` 提供 `nextChunk()`：抛出时先问 `finished()`，是则返回 `nil` 表示流正常结束，否则原样再抛。

Android 不受影响：它仍旧读零长度分块，`Finished()` 只是新增方法。已补三个 Go 测试锁住这个契约（正常结束置位、读取失败不置位、未执行的响应视为已结束）。

### 桥接层追加了只读诊断字段

`Status()` 原先只回 `state` 与 `loginUrl`。真机上排查"手机到底在不在 tailnet 里"时只有这两个字段要绕一大圈，因此追加了 `tailnetIPs`、`hostName`、`tailnet`、`online`。

这是纯追加变更：Android 用 `JSONObject.optString` 按名取字段，多出来的键对它没有影响；`tailnetIPs` 用 `make([]string, 0, n)` 构造，空列表序列化成 `[]` 而不是 `null`，调用方不必区分"还没地址"与"字段不存在"。两个 Go 测试锁住了这两个契约（字段名与类型、空列表形状）。

### gomobile 生成的 Swift 签名规则（备查）

实测结论，与直觉不同，值得记下来：

| ObjC 形态 | Swift 导入 |
| --- | --- |
| 返回 `BOOL` + `NSError**` | `throws`（如 `write`、`login`、`execute`） |
| 返回可空对象 + `NSError**` | `throws -> T` 非可选（如 `open`、`prepare`、`readChunk`） |
| 返回非空 `NSString*` + `NSError**` | **保留显式 `NSErrorPointer`**（如 `read`、`snapshot`、`status`） |
| 顶层 C 函数 + `NSError**` | 不变，显式错误指针（如 `TailnetNewNode`） |

另：gomobile 会为协议和同名类生成相同的 ObjC 名字，Swift 把**协议**重命名为 `TailnetStorageProtocol` / `TailnetInterfacesProtocol`，类保留原名。

导出的完整接口可用下面这条命令查看，比逐个试错快得多：

```bash
swift-api-digester -dump-sdk -module Tailnet -o /tmp/tailnet-api.json \
  -target arm64-apple-ios18.5-simulator \
  -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
  -F ios/Frameworks/tailnet.xcframework/ios-arm64_x86_64-simulator
```

### 两处对设计文档的更正

- **ATS 例外随网络模式不同。** 内置 tsnet 走 Go `net/http`，ATS 看不到，所以 `SmokeTest/Info.plist` 仍不需要例外。外部系统 VPN 模式走 `URLSession` 的明文 `http://100.64.0.0/10` 地址，需要 `CamelliaApp/Info.plist` 与诊断 App 的 `NSAllowsArbitraryLoads`；ATS 不支持只为这一段 IP 写域名例外。即使 ATS 允许 HTTP，目标仍由 `Endpoint` 限制为 Tailscale IPv4 字面地址、指定端口与路径白名单，且不跟随重定向。
- **Keychain 需要签名，未签名的包用不了。** Keychain 检查 `application-identifier` 权限；未签名包没有该权限，沙箱返回 `errSecMissingEntitlement (-34018)`。而**冒称**该权限的未签名包，模拟器会拒绝启动（`denied by service delegate SBMainWorkspace`）——受限权限必须有配置文件。本机没有任何签名身份，所以测试夹具只能不带权限运行，也就够不到 Keychain。

  正式构建不受影响：Xcode 给每个签名 App 自动加上该权限，免费 Apple ID 与付费账号一样。为此 `EmbeddedNetwork.makeStore` 留了一个可替换的工厂，生产默认是 Keychain，夹具注入文件后端（`Support/FileNodeStateStore.swift`）。**只有键值后端不同，被测的 tsnet 启动路径是同一份代码。**

## 凭据存储与配对

这是 S3 的第一部分：把"手机怎么记住一台电脑"做完。全部逻辑在 `CamelliaCore/Remote/`（宿主可编译、可执行校验）与 `CamelliaCore/Networking/`（Keychain、只 iOS）里，诊断 App 的"配对"页只是它的一层界面。

### 凭据怎么存

Android 是一份 JSON 凭据外加 AndroidKeyStore 里的 AES-GCM 密钥；iOS 拆成两半，因为 Keychain 与文件系统在这里的保护方式不同：

| 部分 | 位置 | 保护 |
| --- | --- | --- |
| 密钥 | Keychain 项，`kSecAttrAccessibleWhenUnlockedThisDeviceOnly` | 设备密钥加密，不进备份、不跟着迁移到别的设备；设备锁定时读不到 |
| 密文 | Application Support 下的文件，写完再设 `NSFileProtection.complete` | 文件本身脱离 Keychain 项后无法解开 |

信封沿用 Android 的形状：AES-GCM，`iv` 与 `data`（密文+GCM tag）各自 base64，密钥别名作为附加认证数据——换个别名就解不开。**没有 Secure Enclave 参与**：它不做任意数据的对称加密，Keychain 项已经是最接近的等价物。

侧载构建拿不到 `application-identifier` 权限时（Keychain 一律回 `errSecMissingEntitlement (-34018)`），密钥退到密文旁边的另一个文件里。这是**明确的降级，界面与日志都会写明**，不会让人以为侧载包与签名包一样受保护。

此降级只在**缺少 entitlement** 时选择；设备锁定或 Keychain 暂时出错时仍坚持原 Keychain 密钥，不会改用一把新文件密钥。已有文件密钥损坏或暂时读不到时也拒绝重建；本机聊天状态读不到时保留原件并禁止本轮写入，避免误把旧聊天覆盖。签名真机上的 Keychain 故障恢复仍待实际验证。

### 电脑列表

`ComputerStore` 逐条照搬 Android 的两条容易写错的规则：

- 存的对象把"当前电脑"放在顶层，所有已知电脑放在 `computers` 里按地址索引。老版本单电脑安装根本没有 `computers` 映射，所以读的时候把顶层的、已经带令牌的条目并进映射，而不是丢掉。
- **没批完的配对不算一台电脑。** 它会存下来以便续接，但只有在拿到令牌、或地址本来就已知且不是只在等批准时，才进列表——否则每次放弃的请求都会留下一条要手动删的条目。

一个 JSON 对象没有顺序，所以 `all()` 按名称再按地址排序，列表不会在两次启动之间重排。

### 配对流程

`PairingController` 是 `MainActivity` 里 `requestPairing`/`waitForApproval`/`pollPair` 三件套的移植。中间那段是重点：请求发出后手机只握着一个 claim 句柄和截止时间，然后每 5 秒问一次电脑端，直到批准。每一次轮询都必须可以重复，因为等待期间 App 会被挂起、恢复、杀掉重启、换网络——这也是 claim 要落盘而不留在内存的原因：重启后接着同一个请求，而不是要一个新码。

几处刻意的判断：

- **到期与 401 都只清 claim，不清地址。** 二者都意味着"这个申请已经不能用了"，而地址与名称是用户还要再填一遍的东西。
- **凭据不合格就不存。** 令牌不是 43 位 base64url、或权限不是 `control`/`read`，一律拒绝并报错，而不是存下来让之后的每个请求都以 401 失败——那会被读成"电脑把你撤了"。
- **轮询通过注入的调度器，不是 Timer。** 5 秒这条规则因此能在不睡 5 秒的前提下被校验。
- 表单校验在主线程同步抛错，指向具体字段；请求本身走工作队列，因为它会阻塞在隧道上。

### 二维码

`CamelliaCore/Camera/` 用 AVFoundation 读 QR，不引第三方库，只认 `.qr` 一种码型（否则取景时扫到别的条码也会触发）。扫到第一个就停并重填表单，因为配对码是一次性的，提交之后再重扫同一个码会重启一个已经在等电脑确认的流程。

## 诊断 App 与 IPA

`ios/CamelliaTestApp` 是同一份网络层之上的界面，用途是**在真机上把剩下的验证做完**：启动节点、登录、把请求打到电脑端网关、走通一次配对。它不是第一版客户端的界面（那属于 S3 的界面部分），现在有四页：

| 页 | 内容 |
| --- | --- |
| 网络 | 节点状态（状态/主机名/tailnet 地址/在线）、登录链接与授权页、`getifaddrs` 接口快照、状态存储后端 |
| 网关 | 地址与令牌输入、`/v1/status` 与 `/v1/conversations`、3 秒事件流采样、每次请求的状态码与响应体 |
| 配对 | 地址/端口/配对码/本机名称、扫码、发起请求与 5 秒轮询、已保存电脑的切换与删除、凭据存储模式 |
| 日志 | 全过程记录，可一键复制 |

配对页用的是客户端将来用的同一套 `PairingController`、同一个保险库、同一个传输层，所以在这里配通的原因与在那里配通的原因相同。

节点在启动时就拉起，不等你切到网络页——否则冷启动时另外两页看起来像坏的。

### 为什么 IPA 是未签名的

本机 `security find-identity` 为 0、没有配置文件、Xcode 里没有 Apple ID，**签不出来**。而这恰好也是设计文档定下的两种分发方式需要的输入格式：

- **TrollStore**：直接装未签名包，不校验签名。
- **Sideloadly / SideStore**：用你自己的 Apple ID 重新签名后安装。

所以 `build-ipa.sh` 刻意不签名，也不加任何权限。反例有代价：**冒称受限权限的未签名包会在启动时被拒**（模拟器实测 `denied by service delegate SBMainWorkspace`），这与冒烟夹具一路不签名是同一个原因。

### 装法

```bash
./ios/build-ipa.sh          # 产出 ios/dist/Camellia-0.4.0.ipa
```

产物在 `ios/dist/`：`.ipa`、解包好的 `.app`、按目标分别更新的 `SHA256-client.txt` / `SHA256-diagnostics.txt`。

客户端这一个 IPA 同时包含 iPhone 与 iPad 设备族（`UIDeviceFamily = [1, 2]`），仅需为各自设备完成安装/签名，不另做 iPad 包；最低系统为 iOS/iPadOS 15.0。iPad mini 6 的真机安装与布局尚未验收，模拟器检查见 `ios/WORKPLAN.md`。

- **TrollStore**：把 `.ipa` 传进设备，用 TrollStore 打开。
- **Sideloadly**：Mac 或 Windows 版都一样，选 `.ipa` 加自己的 Apple ID。
- **SideStore**：先装 SideStore 本身，再用它导入 `.ipa`。
- **Xcode / devicectl**（只适合自己调试，7 天要重签）：

  ```bash
  xcrun devicectl device install app --device <UDID> ios/dist/CamelliaTestApp.app
  ```

### Keychain 与回退

Keychain 每次调用都检查 `application-identifier` 权限。Xcode 签名的包一定拿得到；**侧载的包不一定**，取决于装法。拿不到时 Keychain 一律返回 `errSecMissingEntitlement (-34018)`，节点读不到自己的状态，根本起不来。

`NodeStateStoreFactory` 因此在启动时探测一次这个权限，拿不到就换成文件后端，**并在网络页与日志里明说用的是哪一个**，结果不会被误读成"Keychain 正常"。这条回退路径已在模拟器实测生效（未签名包必然走它）：

```
node state: file fallback, this build has no application-identifier entitlement
```

**Xcode 签名的正式构建永远走 Keychain，不存在回退。**

## 目录结构

```
ios/
  check-protocol.sh                 纯逻辑校验（swiftc 直接编译，无需 Xcode）
  build-tailnet-ios.sh              产出 tailnet.xcframework
  check-network.sh                  网络层类型检查（iOS 目标）
  run-smoke.sh                      模拟器 S1 验收
  build-ipa.sh                      产出未签名 .ipa 到 dist/
  run-app.sh                        在模拟器里跑诊断 App
  Frameworks/                       xcframework 与工具落点，生成物不提交
  CamelliaCore/
    Sources/                        纯逻辑，宿主可编译（Endpoint/PairingPayload/SseReader/ComputerStatus/…）
    Remote/                         协议层，宿主可编译且可执行校验
      RemoteModel.swift             会话/消息/执行过程/审批/产物/设置/模型/队列
      RemoteTranscript.swift        快照合并：单调丢弃、实例切换、分页裁剪
      RemoteCommand.swift           命令递送状态机与事件流退避
      ComputerStore.swift           电脑列表、PairedComputer、保险库协议
      CredentialEnvelope.swift      AES-GCM 信封，形状与 Android 一致
      SealedCredentialVault.swift   落盘保险库（纯 Foundation/CryptoKit，可测）
      MobilePreferences.swift       语言/外观/回车/本机名称/后台保持
      PairingController.swift       配对状态机：请求 → 轮询 → 批准
      RemoteListCache.swift         会话列表加密缓存，按地址+令牌摘要隔离
      RemotePrefetch.swift          会话快照预取（内存 LRU、预算与新鲜度）
      LocationContext.swift         定位相关性判定与位置注记格式（纯逻辑）
    Camera/                         AVFoundation 扫码 + SwiftUI 预览，仅 iOS
    Location/                       CoreLocation 单次取点，仅 iOS
      LocationService.swift         requestLocation + 10 秒放弃，取 2 km 精度
    Networking/                     依赖 Tailnet 框架或 Keychain，仅 iOS
      KeychainTailnetStore.swift    NodeStateStore 的 Keychain 实现
      KeychainCredentialVault.swift 凭据密钥的 Keychain 实现与工厂
      RemoteApi.swift               经隧道的远程 API，含两个无需令牌的配对调用
      InterfaceSnapshot.swift       getifaddrs 接口快照
      EmbeddedNetwork.swift         节点生命周期、路径切换、状态目录、登录 URL 校验
      TailnetResponse+Stream.swift  流结束语义的修复
  Support/
    FileNodeStateStore.swift        不需要权限的文件后端，夹具与侧载构建共用
    AppStores.swift                 单例：凭据保险库、附件存储、本机聊天、列表缓存落点
  CamelliaApp/                      正式客户端 App（远程 + 本机两条链路共用界面层）
    Info.plist                      定位用途说明、ATS 例外等
    Sources/
      AppModel.swift                远程侧共享状态：电脑、会话、发送、位置、并发状态检查
      LocalChatModel.swift          本机侧共享状态：会话、发送、位置、编辑重发
      ComputerScreens.swift         电脑列表（含状态点）、配对与二维码
      ConversationScreens.swift     会话列表、会话详情、输入框
      LocalChatScreens.swift        本机会话列表与聊天页
      LocalChatSettingsScreens.swift 供应商与 Key、已归档页
      ArtifactScreens.swift         产物列表与下载
      LocationConsentSheet.swift    定位授权弹窗（两条链路共用）
      Shared/                       Palette、MarkdownView、AttachmentImage 等共享界面件
  CamelliaTestApp/
    Info.plist                      未签名包用散装 PNG 图标，不依赖 Assets.car
    CamelliaTestApp.entitlements    记录 Xcode 签名时会自动获得的权限
    Sources/                        四页界面、节点动作、状态存储与凭据保险库工厂
  SmokeTest/
    Sources/                        最小可运行 App
    CamelliaSmoke.entitlements      记录正式构建自动获得的权限
```

`CamelliaCore/Sources`、`Remote` 与 `Networking` 分开是刻意的：前两者用宿主 `swiftc` 编译并直接跑校验，后者只能对 iOS 目标做类型检查，合在一起会让 `check-protocol.sh` 失效。`Camera` 不需要 Tailnet 框架，但需要 AVFoundation 与 SwiftUI，因此单独一个脚本按 iOS 15 目标检查。

## 移植说明

`CamelliaCore` 的目标是**接受与拒绝的集合与 Android 完全一致**，而不是仅文案相似。以下几点是刻意的差异，都朝更严格的方向：

- 路径白名单用 `[0-9]` 代替 Java 的 `\d`。ICU 的 `\d` 默认匹配非 ASCII 十进制数字，Java 的不匹配。
- `\uXXXX` 转义要求恰好四位十六进制、且是合法 Unicode 标量。Java 的 `Integer.parseInt` 接受 `+`／`-` 前缀，也会为孤立代理项生成半个字符。
- 数字字面量只接受 `-` 与 ASCII 数字。Java 的 `Character.isDigit` 覆盖全部 Unicode 十进制数字。
- 端口与八位组的解析顺序对齐了 Java 正则的形状规则，因此"形状不合法"与"取值越界"两条错误文案的选择与 Android 一致（例如 `100.200.0.1` 与 `100.199.0.1` 会给出不同的错误）。

整体上是行为收紧：不会接受 Android 拒绝的输入。

`Endpoint` 的手写解析与 Java 正则等价：接受集合恰好是 `100.64.0.0/10` 内的规范点分四段、十进制端口 1–65535、允许一个尾斜杠、允许首尾空白、端口允许前导零。

## 待办

1. **路径白名单不覆盖全部网关接口。** Android 的 `Endpoint.java` 白名单只包含 `status`、`commands`、`pair/request|claim`、`conversations…`、`api-keys`；网关实际还提供 `/read`、`/api-import`、`/native-settings/*`、`/server-management`。iOS 已放开 `/read`（已读状态同步要用，`Endpoint` 与 `ProtocolChecks` 同步更新），其余三个仍未开放：`/api-import` 与 `/native-settings/*`、`/server-management` 属电脑端完全控制接口，移动端不用。若 Android 也要标记已读，需同步改 `Endpoint.java` 与它的测试。
2. **Keychain 实现本身仍未在运行时验证过。** 权限探测与文件回退已在模拟器实测（未签名包必然走回退，日志与界面都会写明），但 `KeychainTailnetStore` 的读写只在类型层面通过——本机没有签名身份，跑不到那条分支。用 Apple ID 在 Xcode 里构建一次，或用 Sideloadly 把 `ios/dist` 里的 `.ipa` 装到真机（它会注入权限），网络页的"状态存储"显示 `Keychain` 即说明这条分支已经生效。
3. **`Finished()` 的说明会出现在 Java 与 ObjC 绑定里。** gomobile 原样复制 Go 的文档注释，Android 侧会看到一段为 Swift 写的说明，属可接受但需知悉。
4. **配对流程还没有对着真实电脑端跑过一次。** 信封、电脑列表规则、状态机、字段校验都有可执行校验，但 `pair/request` 与 `pair/claim` 只做到类型检查。要验的其实是两件事：请求能不能穿过隧道到达网关，以及等待期间 App 被挂起再回来时 claim 还活不活。用诊断 App 的配对页在真机上实操即可，日志会逐条打印。

## 距离 S1 验收还差的一步

"一次真实 `Open()` 打到电脑端网关"需要同一 tailnet 内有两个已登录节点。本机的 Tailscale 目前是停止且未登录状态。步骤如下：

1. 在 Mac 上启动并登录 Tailscale，记下它的 `100.x` 地址。
2. 跑 `./ios/run-smoke.sh`。会看到节点启动、`state=NeedsLogin`，随后打印：

   ```
   login-url=https://login.tailscale.com/a/...
   login-open xcrun simctl openurl booted https://login.tailscale.com/a/...
   login-wait the node stays up for 120s; sign in to finish
   login-waiting state=NeedsLogin elapsed=10s
   ...
   ```

   链接出现后，**节点会保持存活 120 秒并每 10 秒报告一次进度**，因为登录必须由活着的进程轮询才能完成。在这段时间内用上面那条 `xcrun simctl openurl` 在模拟器里打开并登录（节点名会是 `camellia-ios`），也可在任意浏览器里打开。窗口时长用 `CAMELLIA_SMOKE_LOGIN_WAIT` 调整。

   > 没有做"迟迟拿不到链接就提前退出"的优化：控制面应答时间不稳定，短的截断会把一次慢但正常的登录误判成失败。

3. 再跑一次 `./ios/run-smoke.sh`，此时应输出 `sign-in=already-signed-in`。
4. 在电脑端开启 Camellia 的手机访问，取得端口与设备令牌。
5. 带上目标复跑：

```bash
CAMELLIA_SMOKE_TARGET=http://100.x.x.x:43127/v1/status \
CAMELLIA_SMOKE_TOKEN=<43 位 base64url> \
./ios/run-smoke.sh
```

期望看到 `probe status=200` 与网关返回的 JSON。即便返回的是 `CAMELLIA_*` 错误码，也说明请求链路是通的——桥接层发出了请求并分类返回，而不是崩溃。

## 与桌面端的分工

- `ios/Frameworks/tailnet.xcframework` 由 macOS 本机与 iOS CI 从共享 Go 源码重建，不提交二进制生成物。
- Go 桥接的单一来源仍是 `android/tailnet`，两端靠 `//go:build` 区分，没有第二份 Go 代码。
