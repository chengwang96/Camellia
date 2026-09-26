# Linux server development preview

这是可运行的 headless 开发入口，不是完整 Linux 发行版。Node 进程不加载 Electron；桌面与 CLI 现在复用同一个远程服务控制层。

## 当前可用范围

- 前台服务与本机 Unix socket 控制；同一数据目录只允许一个服务写入。
- CLI 的 Tailscale 启动、登录链接、状态、关闭和退出操作；沿用内置 helper，不调用系统 `tailscale`。
- 创建邀请、服务器本地批准、拒绝、撤销；对端仍通过现有 `/v1` 协议领取凭据。
- 持久化工作区与独立会话；本地创建/移除工作区、创建会话、列出会话。
- 已接线 DSH、Claude、Codex、Kimi 和 Antigravity API driver；按现有协议可以发送/停止/审批。运行时按需在服务器安装，未安装时明确拒绝请求。
- 默认权限为 `ask`。不自动恢复 Goal、不启动计划任务、不自动下载运行时、不发送模型请求。

已增加服务器本地订阅登录入口与原生 Linux 发行包构建器。已提供 systemd 用户服务配置生成器，安装和启用需用户明确执行；不自动提权。API 设置远程导入已接线，真实网络与模型执行仍待验收。现已提供独立的实时设置菜单 `menu`；原全屏设置设计预览仍保留，演示数据不会当作实时状态。

出站 Tailscale 通道、设备客户端与 GUI 开发预览已接线：

- helper 的 `connect`/`disconnect` 创建和关闭受随机 token 保护的 loopback 转发端点；远端连接只经 `tsnet.Server.Dial`，无需系统 Tailscale 路由。
- 每个连接固定到 `100.64.0.0/10` 中一个 IPv4 地址的 43127 端口；仅允许现有 `/v1` endpoint，拒绝任意 URL、浏览器 Origin、重定向和额外转发头。
- HTTP 与 SSE 不经过 helper 的串行 JSON 控制通道，支持实时流、背压和取消；helper 退出会关闭连接。并发连接、请求体及响应解析有上限。
- `src/main/remote/device-client.js` 管理人工确认的配对、系统安全存储加密的设备凭据、按设备读取会话及发送命令；不给调用者返回 token。忘记设备不等于撤销服务器授权。
- 写操作要求调用者提供稳定 request ID 与当前 instance ID，不自动重试或离线排队。GUI 提供分页、离线禁写、显式重连与目标确认；结果不明时要求检查状态，不自动重发。
- 需要重新构建 helper 才支持新协议；旧二进制不会自动获得出站能力。

## GUI 远程工作台

打开 **设置 → CLI 设备**（位于“手机访问”下面）。CLI 设备面板直接嵌在设置面板内，不再弹出独立窗口；首页的 `CLI devices` 快捷入口也会打开同一个设置页。本机工作台不切换、不合并历史。沿用 Camellia 猫咪、桌面主题与中英文设置。

CLI 设备就是一个普通设置页：与其它页面相同的 DOM 文档、滚动容器与两栏布局，没有覆盖层或内嵌浏览器视图。为避免与设置页其它控件冲突，设备页在设置宿主中使用 `cli-` 前缀的元素 ID，样式全部限定在 `.cli-devices` 作用域内，切换页面时会停止事件订阅并清理未发送附件。设备凭据与网络连接独立于页面：关闭设置窗口会断开订阅，但不会撤销服务器端授权，重新打开会重新连接。

1. 展开“本机 Tailscale 连接”，点击“启动 / 登录”，在浏览器授权后刷新。此控制端**与「手机访问」共用同一个内置 Tailscale 身份**（同一个节点、同一份加密状态和登录），只需登录一次；如果你已经在手机访问里登录，这里会直接显示已连接。仅启动网络不会开启本机入站网关，也不改变手机访问开关。
2. 服务器运行 `start`、`invite`。GUI 点击“添加 CLI 设备”，输入完整 `http://100.x.y.z:43127` 地址、配对码、设备显示名和本机名称。
3. 服务器运行 `state` 查看待审批请求，运行 `approve`。GUI 点击“检查授权”；不会自动批准。也可取消待配对请求。
4. 从设备下拉框选择服务器。查看工作区及独立会话；可创建/重命名/移除工作区、创建会话、附带文件发送、停止、处理可操作审批、重命名、置顶、归档/恢复、单个/批量删除，以及修改模型、思考级别与权限。
5. 状态断线或事件流结束时禁用写操作。用“连接 / 刷新”重新获取快照。所有删除确认包含目标设备，工作区移除不删除服务器文件。

因为两边共用同一节点，手机访问页面的“关闭”会同时断开 CLI 设备连接，“退出 Tailscale 登录”会让两边都需要重新授权；重新登录仍复用同一身份，不需要重建配对。CLI 设备面板因此不再提供“断开网络”按钮，改由手机访问页面统一管理。

服务器声明 `engines` 和 capability，GUI 不假定五种引擎均可用。旧服务器未声明引擎时仍可浏览，但新建会话禁用，需要更新服务端。

当前 GUI 是设置面板内的远程工作台：支持加载更早历史、模型支持的思考级别、附件上传、产物下载、会话多选删除及归档恢复。聊天内容支持 Markdown 标题、强调、行内代码、围栏代码、表格、列表和引用；代码可复制和换行。原始 HTML 作为文字显示，不加载远程图片；外部链接必须确认后才交给本机浏览器。未改变的消息节点会保留，流更新不会反复清除其代码换行或过程折叠状态。订阅登录只在服务器执行。

### 服务器原生设置

在线选择 CLI 设备后点击“服务器原生设置”，选择引擎和文档。此处直接修改**服务器专属 native 配置**，不修改本机 GUI 配置，也不是任意服务器文件编辑器。

| 引擎 | 可编辑文档 |
| --- | --- |
| Claude | 原生 JSON 设置、`CLAUDE.md`、独立 MCP JSON |
| Codex | `config.toml`、`AGENTS.md` |
| Kimi | 原生 TOML 偏好、MCP JSON，分别合并进 API 或订阅进程配置 |
| DSH | 原生 YAML 偏好；每个进程仍强制使用 Camellia 管理的路由及会话权限 |
| Antigravity | SDK JSON 设置、Google CLI JSON 设置，以及 Google MCP/skills/plugins 配置文档 |

- 必须拥有全设备控制权限；引擎运行、账号登录、运行时安装或本机设置操作期间拒绝保存。
- 单文档最多 256 KiB，JSON/TOML/YAML 先解析，拒绝原型污染字段及循环/过深结构。未知 native 选项是否被实际引擎支持仍由该引擎决定；语法正确不等于供应商承诺支持每个字段。
- 只允许固定文档 ID，不接受路径；拒绝符号链接及硬链接文件。返回编辑器的文档不含服务器文件路径。
- 已知的 API 路由、模型路由和登录凭据字段不会显示，也不能经此覆盖；已有受保护字段在保存时保留。Kimi 不编辑订阅凭据目录，Google 不编辑 OAuth 文件。
- MCP 环境、hooks、技能指令等可能包含自定义秘密，也可能执行服务器代码，因此此编辑器只面向可信的全设备管理员。保存前必须勾选明确警告；不要把订阅 token 或 API keys 手工粘进 native 文档，应使用专门的账号/API 流程。
- 原子写入**当前选中的单个文档**，使用 revision 拒绝陈旧保存，不悄悄覆盖外部编辑。网络结果不明时应重新打开并检查内容，不自动重试写入。
- 编辑在下一次引擎进程启动时生效；已存在的可复用进程在下一次发送时根据 native 指纹重建。会话连接、模型和权限覆盖仍由会话设置控制，不被全局配置编辑擅自替换。
- 文档编辑窗口打开时暂停消息自动刷新；可切换文档保留本次草稿。点击保存只保存当前文档并关闭窗口，其他未保存草稿不落盘。

### CLI 中编辑原生文档

菜单“引擎与账号”新增“编辑原生配置”入口，列出文档并显示本地编辑命令。服务在运行时执行：

```sh
./camellia native-edit --payload '{"engine":"codex","id":"settings"}'
./camellia native-edit --payload '{"engine":"claude","id":"instructions"}' --editor /usr/bin/nano
```

源码方式用 `node scripts/camellia-server.cjs` 替代 `./camellia`。默认编辑器为 `/usr/bin/vi`；`--editor` 只接受绝对可执行文件路径，不拼接 shell 命令或参数。临时文档权限 0600，编辑后输入 `YES` 才向正在运行的服务保存，退出时清除临时目录；不会启动第二个会话仓库。自动化可使用 `native-settings-get` 和 `native-settings-save`，同样需要 revision 与 `confirmed: true`。

需要升级服务器及桌面 helper 才能路由新的 native-settings endpoint；旧服务器未声明 capability 时入口禁用。

### 附件与产物

- 在会话输入区点击“附件 / Attach”，使用本机原生文件选择器选取文件。每次发送最多 9 个，转换后总计不超过 8 MiB；单个原文件也不能超过 8 MiB。
- PNG/JPEG/WebP/GIF/BMP 在主进程解码为 JPEG，最长边不超过 2048 像素；动画图片按解码后的单张图像处理。普通文本、代码、文档等作为文件保存，不保证每个引擎都能直接理解所有格式；模型可使用服务器工具读取附件。
- renderer 只持有绑定“设备 + 会话”的随机附件 ID 和名称/大小，不能指定本机读取路径。文件内容暂存在主进程内存，30 分钟失效；切换会话、设备或关闭窗口会清除待发送附件。
- 服务端严格校验整个附件批次，再写入受限的 `remote/device-attachments` 目录，文件名由服务端生成，不采用客户端路径。累计上传存储上限 256 MiB，满后明确拒绝；不自动删除已有会话附件。
- 普通文件通过受控路径加入引擎上下文，历史界面仅显示原始消息和安全文件名，不返回上传目录路径。图片是否可用仍取决于引擎能力。
- 发送失败/结果不明时不自动重复上传或发送，先检查会话结果；重复同一请求 ID 仍走原有命令去重。
- 展开“产物文件 / Artifacts”并刷新，可分页查看该会话工作区内的已识别产物，不是任意服务器文件浏览器。点击下载后用本机原生保存对话框选目标，确认覆盖由原生对话框处理。
- 每个文件最高 512 MiB，同一窗口最多 2 个下载；下载采用流式临时文件，核对实际字节数后原子替换目标，失败或取消保留旧文件并清理 `.part`。不自动打开/执行下载文件。
- 进度区可随时取消；关闭窗口、断开网络或撤销服务器授权会终止传输。对话框建议名称经过安全处理；远端文件名不能变成本机路径。

### 多选与归档

“多选 / Select”显示当前已加载会话的复选框，最多选 100 个；批量删除确认会列出目标设备和会话标题，发送选定会话 ID 与各自序列号。服务端先检查授权、序列号及忙碌状态，再执行删除；断线或中途失败可能部分完成，需刷新核实，不自动重发。

“已归档 / Archived”单独分页显示授权范围内的归档会话，并可确认恢复。归档隐藏会话，但不是删除；恢复仍保留原工作目录和历史。归档会话恢复前不会经普通聊天接口暴露。原生设置按前述固定文档编辑，仍不会开放任意服务器路径或订阅凭据文件。

附件与归档恢复需要更新服务器及桌面 helper；旧服务器未声明 capability 时相关写入口禁用。

### 从本机导入 API 设置

选择在线且声明 `api-import` capability 的 CLI 设备，点击“导入本机 API 设置”。来源固定为 GUI 所在电脑的 API 路由配置，切换设备不会改变来源。

确认对话框显示目标设备、服务商数、密钥数和跳过的本地服务商数；原始密钥仅在主进程和受配对鉴权的传输中使用，不进入 renderer。预览保留五分钟，绑定目标设备与服务器配置版本。

首版使用保守的**仅新增、保留服务器**策略：

- 传输明确列出的服务商端点、模型映射、API 密钥、优先级及启用状态；不读取或传输订阅账号目录、Cookie、订阅 token、本机端口、用量或会话。
- 跳过 QClaw 和 loopback/HTTP 本地服务。服务器只接受 HTTPS API 端点。
- 若服务商 ID、端点或密钥 ID 与服务器现有项冲突，跳过整个输入服务商，不更新其中的密钥或模型。**这不是逐字段合并或覆盖导入**；重复导入不会替换服务器配置。
- 保留服务器的 router 端口、全局启用状态、用量和活动路由。服务器路由禁用时回执会提示，导入不会偷偷启用。
- 全设备控制权限必需。配置版本变化、模型请求正在运行或应用配置忙碌时拒绝应用；撤销授权后拒绝读写。
- 配置通过原子写入替换；重载失败时恢复旧配置。日志只保存请求摘要、来源设备、时间与计数，不保存请求正文或密钥。
- 同一请求 ID 重试返回已有回执。崩溃留下未完成回执时返回“结果待核实”，不重复执行。UI 不自动重试；对话框保留期间手动再次确认沿用同一请求 ID。
- 回滚本身失败时明确报错，需在服务器检查配置后再操作；不能将这种情况视为安全成功。

导入完成后可在会话“模型与权限”中选择服务器模型，或用 `set-model` 设置新会话默认模型。不会自动启动引擎或消耗 API 额度。

GUI 主进程 IPC 限定设备窗口主 frame，安全存储中的 token 不进入 renderer；网络代理禁止浏览器直接访问。SSE 只发出带设备和视图 ID 的刷新通知，避免旧设备结果覆盖当前视图。关闭设备窗口会取消订阅及待配对流程；已保存凭据保留。

## 从源码运行

需要 Linux、仓库支持版本的 Node.js，以及安装好的生产依赖。已有源码依赖安装按仓库开发流程进行；服务自身不需要 Electron 或显示服务器。

```sh
node scripts/camellia-server.cjs --help
node scripts/camellia-server.cjs serve
```

默认数据目录是 `$XDG_DATA_HOME/camellia-server`，未设置时为 `~/.local/share/camellia-server`。可使用绝对路径 `--data-dir /home/me/.local/share/camellia-server`；所有客户端命令必须使用同一个目录。Unix socket 路径不能超过 100 字节。

**不要对已有 Electron 数据目录启动此预览。** 使用全新、当前用户拥有的独立目录。预览拒绝权限过宽的目录，不会擅自 chmod 用户原目录，也不支持符号链接数据目录。

`serve` 保持前台运行；在另一个 SSH 终端操作：

```sh
node scripts/camellia-server.cjs state
node scripts/camellia-server.cjs workspaces
node scripts/camellia-server.cjs create-workspace --payload '{"name":"Project","path":"/srv/project"}'
node scripts/camellia-server.cjs create-conversation --payload '{"engine":"dsh"}'
node scripts/camellia-server.cjs conversations
node scripts/camellia-server.cjs delete-workspace --payload '{"id":"WORKSPACE_ID"}'
```

## 使用 systemd 用户服务

先完成源码依赖和 helper 的准备，把源码与 Node 放在稳定路径；不要从临时目录安装服务。`service-unit` **只打印配置**，不会写入系统目录、启动服务、开启网络或修改 linger：

```sh
node scripts/camellia-server.cjs service-unit \
  --data-dir "$HOME/.local/share/camellia-server" \
  --hostname gpu-lab-01
```

输出使用当前 Node 和仓库脚本的绝对路径，可以带 `--helper` 和 `--key-file` 指向外部 helper/密钥。路径中的空格、引号、反斜杠以及 systemd 的 `$`、`%` 展开均经过转义，不调用 shell。配置不包含 API 密钥或网络密钥内容。

审核后保存成用户 unit。以下命令会安装/启用服务，需由用户主动执行；若已有同名 unit，应先比较内容，不要直接覆盖：

```sh
mkdir -p "$HOME/.config/systemd/user"
node scripts/camellia-server.cjs service-unit \
  --data-dir "$HOME/.local/share/camellia-server" \
  --hostname gpu-lab-01 > "$HOME/.config/systemd/user/camellia-server.service"
systemctl --user daemon-reload
systemctl --user enable --now camellia-server.service
systemctl --user status camellia-server.service
journalctl --user -u camellia-server.service -n 100 --no-pager
```

安装前先停止使用同一数据目录的前台 `serve`。服务设置 `UMask=0077`、`KillMode=control-group` 和 60 秒停止超时，正常停止由 CLI 清理网关、引擎及锁；超时后 systemd 会终止剩余进程。unit **不设 `User=root`、不使用 sudo，也不会执行清锁命令**。

当前数据锁采取故障时保留策略，因此 unit 明确使用 **`Restart=no`**：崩溃后不能盲目自动重启并删除锁。先检查 journal、确认旧服务及引擎已退出，必要时再手工处理 `server.lock`。正常 SIGTERM 停止会释放锁，之后可 `systemctl --user start`。

```sh
systemctl --user stop camellia-server.service
systemctl --user start camellia-server.service
systemctl --user disable --now camellia-server.service
```

停止服务与菜单中的“关闭远程网络”不同：前者终止服务和引擎，后者只断开远程访问。重启可能中断当前响应，先检查实时设置里的忙碌状态并停止工作。

### 可选：重启时恢复已配对设备的网络

默认启动仍保持网络关闭。若希望用户服务启动后恢复已信任设备的连接，在生成 unit 时加 **`--restore-network`**，或前台运行 `serve --restore-network`：

```sh
node scripts/camellia-server.cjs service-unit \
  --data-dir "$HOME/.local/share/camellia-server" \
  --hostname gpu-lab-01 --restore-network
```

仅当数据目录已有有效的配对设备摘要时启动网络；新目录或撤销全部设备后不自动联网。不会生成邀请、批准设备或触发交互式登录；登录失效时通过菜单手动处理。网络恢复失败不退出本机控制服务，仍可运行 `state`/`menu` 排查；不会无限恢复重试。该参数表示下一次进程启动时允许恢复，不会覆盖本次运行中用户的 `stop` 操作。

用户服务能否在 SSH 断开后继续运行、是否在无人登录时启动，取决于发行版的用户会话及 linger 策略。使用 `loginctl show-user "$USER" -p Linger` 检查；如需启用，交给管理员决定，Camellia 不自行提权更改。WSL 等环境可能没有用户 systemd bus，此时保留前台运行方式。

## CLI 实时设置菜单

在服务运行时，另开 SSH 终端：

```sh
node scripts/camellia-server.cjs menu
node scripts/camellia-server.cjs menu --lang en --ascii
```

自定义数据目录时，`menu` 与 `serve` 都要传相同的 `--data-dir`。菜单只通过本机控制 socket 操作，不启动第二个会话仓库写入进程。找不到服务会提示先运行 `serve`，不回退到演示数据。

实时菜单保持 Camellia 名称、坐姿字符猫和蓝灰强调色，支持中文/英文、`NO_COLOR`、ASCII logo，使用适合 SSH 的数字选择和行输入，**不是前一版方向键全屏设计原型**。

- **网络与设备**：真实 Tailscale 状态与登录链接、配对邀请、待审批/已授权列表、批准、拒绝、撤销、关闭网络和退出账号。
- **服务商与密钥**：只显示服务商/密钥数量，不显示密钥内容；提供 GUI 导入指引、路由启停、服务器默认模型选择。
- **工作区与会话**：列出真实工作区和会话，添加已有服务器目录、移除记录、新建工作区会话或独立会话。
- **通用**：保存服务器语言偏好。`--lang` 指定本次菜单语言；在菜单中保存语言后使用新语言。
- **诊断与关于**：数据目录、可用引擎、会话数、忙碌状态、存储保护和当前限制，不进行外网诊断或请求模型。
- **引擎与账号**：五引擎运行时状态/安装、服务器账号登录入口、账号模型刷新、API/订阅连接选择；登录和下载必须显式发起。

配对授权、撤销、网络关闭/退出、工作区增删、会话创建、API 路由与默认模型更改均要求输入 `YES`。回车或其他输入取消。EOF/Ctrl+C 不提交尚未确认的操作；已经确认并提交的请求不会因为关闭终端自动撤回。

输入 `q` 或 Ctrl+C 仅关闭菜单，服务继续运行。数字列表每次显式刷新，不在后台轮询。服务端提供的文本会过滤终端控制字符及双向文本覆盖符；菜单不打印 API 配置原文。

自动化可使用 JSON 命令（不需要 TTY）：

```sh
node scripts/camellia-server.cjs settings
node scripts/camellia-server.cjs set-language --payload '{"language":"en"}'
node scripts/camellia-server.cjs set-api-enabled --payload '{"enabled":true}'
```

`settings` 只返回 API 数量、可用模型与安全状态摘要。API 路由启停会检查运行中工作并在重载失败时尝试恢复配置。不会自动启动模型请求。

工作区路径必须是已有服务器目录。移除工作区仅移除记录，会话转为独立会话并保留 cwd；不删除项目文件。命令行写操作是显式操作，当前无额外交互确认；执行移除前先核对 ID。

## 内置 Tailscale

先在 Linux 构建现有 helper：

```sh
npm run build:tailnet
node scripts/camellia-server.cjs start
node scripts/camellia-server.cjs state
```

构建要求见 `integrations/tailnet/go.mod` 的 Go 版本。也可启动服务时提供 `--helper /absolute/path/camellia-tailnet`。没有 helper 时明确报错，不会回退到公网监听。

登录链接位于 `result.network.loginUrl`；在可信浏览器打开。`NeedsLogin` 时 `start` 发起登录；若链接未出现，运行 `login` 后再查询 `state`。网络与浏览器授权可能需要时间。

重新构建 helper 后，CLI 默认节点名称为 `camellia-server`；可用 `serve --hostname gpu-lab-01` 自定义。只允许小写字母、数字和内部连字符，最长 63 字符。桌面 helper 未传名称时仍保持 `camellia-desktop`。新名称不是新的认证身份；仍使用原有状态密钥，显示名称受 Tailscale 服务端命名规则影响。

```sh
node scripts/camellia-server.cjs invite
node scripts/camellia-server.cjs state
node scripts/camellia-server.cjs approve --payload '{"id":"PENDING_REQUEST_ID"}'
node scripts/camellia-server.cjs revoke --payload '{"id":"DEVICE_ID"}'
node scripts/camellia-server.cjs stop
```

`invite` 仅在线时可用。需对端通过 `/v1/pair/request` 提交请求后，CLI 才能批准；GUI 添加窗口会发起这一请求。只批准自己刚刚发起的配对。名称不是身份证明。

`stop` 只关闭网络与远程网关，不停止服务器或模型进程；`logout` 退出 Tailscale。终止服务用前台 Ctrl+C 或 SIGTERM。服务重启默认离线，需明确运行 `start`。

网关只监听随机 loopback 端口，Tailscale helper 携带私有 transport token 转发；应用配对 token 是另一层权限。不能直接把 loopback 网关映射到公网。

## 存储与密钥

- 数据目录 0700，本机 socket 0600；CLI 将 umask 设置为 0077，配置与凭据文件仅当前用户可读。
- 默认生成 `remote/tailnet/network.key`，用它加密 helper 的节点状态；拒绝错误格式、权限过宽、符号链接、硬链接密钥。
- **默认 keyfile 与加密状态保存在同一目录，不抵御整个目录被复制或同用户攻击。** 这不是系统 keychain。
- 可用 `serve --key-file /protected/path/key` 指定外部 base64 编码的 32 字节密钥文件，必须当前用户拥有且不可被其他用户读取；指定的文件缺失时不自动生成。
- 不自动重新生成损坏的密钥；先备份和调查，避免丢失网络身份。
- `server.lock` 排除第二个服务。异常退出留下锁时，先确认旧进程确实停止，再手工移除该文件；预览不凭 PID 猜测后自动抢锁。
- 配对 token 只在服务端存摘要；本机控制 socket 是当前用户的管理权限边界，不向远程暴露。

## DSH 与 API 配置

运行时既可从发行目录读取，也可按需安装到服务器数据目录的 `runtimes/`。不要复制 Windows 或 macOS 上的引擎目录。

推荐使用 GUI 的“导入本机 API 设置”。也可在服务停止期间，使用现有 API router 原生配置 schema 准备数据目录中的 `api-routes.json`（不是带 `format/config` 外壳的桌面导出文件），确保 0600 权限。不要复制订阅凭据。配置的 router 端口是服务器本地端口，需要避免冲突；路由器首次发送时启动。

配置服务商与模型后：

```sh
node scripts/camellia-server.cjs set-model --payload '{"engine":"dsh","model":"YOUR_CONFIGURED_MODEL"}'
```

默认模型设置只影响新会话；已有会话通过协议中的会话设置单独管理。模型请求会消耗 API 额度，测试不应使用生产密钥。

## 五引擎与服务器账号

在实时菜单第 6 项“引擎与账号”里选择引擎，安装运行时、检查账号、选择连接和默认模型。运行时安装是显式操作，会联网下载；安装以后台任务执行，重复进入页面查看结果，不自动无限重试。

```sh
node scripts/camellia-server.cjs runtime-state
node scripts/camellia-server.cjs runtime-install --payload '{"engine":"codex"}'
node scripts/camellia-server.cjs runtime-install --payload '{"engine":"kimi"}'
node scripts/camellia-server.cjs runtime-install --payload '{"engine":"antigravity","connection":"api"}'
node scripts/camellia-server.cjs runtime-install --payload '{"engine":"antigravity","connection":"subscription"}'
```

DSH 只支持 API 连接。Claude、Codex、Kimi 可选择 API 或服务器订阅账号；Antigravity API 使用官方 Python SDK，Google 订阅使用官方 CLI。Linux SDK installer 使用来自 PyPI 的固定 uv URL 和 SHA256；Google CLI 使用官方安装脚本引用的 manifest 中的固定 URL 和 SHA512（Linux 固定 1.2.11，现有桌面清单不改版本）。Linux Python 路径面向 glibc；Alpine/musl 不作为本次发行目标。

### Claude / ChatGPT / Google：原生交互登录

服务运行时在另一个真实 SSH 终端执行，不能通过 GUI 远程调用这个本地管理命令：

```sh
node scripts/camellia-server.cjs native-login --payload '{"engine":"claude"}'
node scripts/camellia-server.cjs native-login --payload '{"engine":"codex"}'
node scripts/camellia-server.cjs native-login --payload '{"engine":"antigravity"}'
```

- Claude 运行原生 `auth login`，配置目录固定在服务器的 `claude-native`。
- Codex 运行原生 `login --device-auth`，使用服务器的隔离 `CODEX_HOME`。在可信浏览器完成设备码授权；若组织未启用 device auth，按官方登录文档处理，不迁移桌面 token。参考：<https://developers.openai.com/codex/auth/>。
- Google 打开官方 CLI 的交互界面完成登录，HOME/XDG 目录固定在服务器的 `google-native`，不使用桌面 Google 配置；退出账号也使用原生 CLI 菜单。
- 原生登录期间保留本地引擎预约，阻止该引擎启动或修改设置；正常退出自动释放。若登录终端遭 SIGKILL，先确认原生登录进程结束，再重启服务释放预约。
- Claude/Codex 可传 `"action":"status"` 或 `"action":"logout"`，均走原生命令。不得将终端登录输出复制到公开日志。

Codex/Google 登录完成后刷新模型：

```sh
node scripts/camellia-server.cjs account --payload '{"engine":"codex","action":"refresh"}'
node scripts/camellia-server.cjs account --payload '{"engine":"antigravity","action":"refresh"}'
```

### Kimi：服务器设备码登录

```sh
node scripts/camellia-server.cjs account --payload '{"engine":"kimi","action":"login"}'
node scripts/camellia-server.cjs account --payload '{"engine":"kimi","action":"state"}'
node scripts/camellia-server.cjs account --payload '{"engine":"kimi","action":"refresh"}'
```

`state` 返回临时验证网址和设备码，不返回 token；浏览器授权后刷新。可使用 `cancel` / `logout` 取消或退出。订阅凭据保留在服务器 `kimi-subscription`。

### 选择连接和模型

```sh
node scripts/camellia-server.cjs engine-settings --payload '{"engine":"codex","connection":"subscription","model":"MODEL_FROM_ACCOUNT"}'
node scripts/camellia-server.cjs engine-settings --payload '{"engine":"claude","connection":"api","model":"MODEL_FROM_API_ROUTES"}'
```

Claude 订阅模型由用户按本人账户填写，程序不猜测模型清单；其他订阅模型从原生账号刷新结果获取。默认仅影响新会话，权限初始化为 `ask`。API 路由导入与订阅目录完全隔离。

## Linux 发行包

在与目标一致的 Linux x64/arm64 主机运行（需要 Node/npm、Go、tar），不跨平台复制原生依赖：

```sh
npm run pack:server
```

构建器生成 `dist/Camellia-VERSION-linux-ARCH-server.tar.gz` 与 `.sha256`。包包含 Node/npm、生产依赖、Tailscale helper 与 notices、引擎安装清单和源码；不包含 Electron 二进制、用户配置、密钥或预装的模型引擎。若同名产物已存在，选择新输出目录而不是覆盖：`node scripts/pack-server.cjs /absolute/output`。

```sh
sha256sum -c Camellia-VERSION-linux-ARCH-server.tar.gz.sha256
tar -xzf Camellia-VERSION-linux-ARCH-server.tar.gz
cd camellia-server
./camellia serve --hostname gpu-lab-01
./camellia menu
./camellia service-unit --hostname gpu-lab-01 --restore-network
```

首次启动和打开菜单不会自动安装引擎。将包解压到稳定位置后再生成 systemd unit。引擎安装下载来自固定清单，Node 许可证和第三方 notices 随包保留。

## 测试与边界

```sh
node --test tests/headless-server.test.js tests/embedded-network.test.js tests/remote-desktop.test.js tests/remote-access.test.js
node --test tests/device-transport.test.js tests/device-client.test.js
node --test tests/device-files.test.js
python tests/devices-settings-ui.py
node --test tests/devices-desktop.test.js
node --test tests/api-import.test.js
node --test tests/settings-console.test.js
node --test tests/service-unit.test.js
node --test tests/server-engines.test.js tests/server-package.test.js
node --test tests/native-server-settings.test.js
python3 tests/server-package-smoke.py /absolute/path/Camellia-0.1.0-linux-x64-server.tar.gz
node tests/server-native-smoke.cjs /absolute/path/containing/runtimes dsh kimi codex claude antigravity
python3 tests/settings-console-pty.py --node /absolute/path/to/linux/node
python tests/devices-ui.py
go -C integrations/tailnet test ./...
```

测试使用独立临时目录、假网络和假 driver，不读取真实账号、不连接真实 tailnet、不调用模型。Linux 专用用例验证 0700/0600、symlink/hardlink 拒绝、本机 socket、前台进程与 SIGTERM。

`server-native-smoke.cjs` 则使用真实已安装引擎和本地 HTTP 模型夹具：完整经过 headless host、网关鉴权、远程命令、原生进程和会话持久化，但不调用付费模型、不使用真实订阅或登录 tailnet。此验证与真实供应商验收分开记录。

真实 Tailscale 登录、Linux DSH 模型执行、systemd 用户服务实际启停/登录退出、ARM64 和 GUI 两端互通仍须独立验收。unit 可用 `systemd-analyze verify --man=no /path/to/camellia-server.service` 静态检查，但静态检查不代替真正的用户服务测试；不能仅凭这些单元/集成测试宣称服务器版完成。
