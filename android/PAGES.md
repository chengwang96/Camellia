# 逐页补齐：内容与操作

一次做一页，每页交两样：**这一页该有的内容**（缺什么、为什么缺）和**这一页能做的操作**（有没有、顺序对不对）。每页做完在模拟器上截图确认，再进下一页。

## 为什么先抽 token

补齐是逐页改视觉，如果颜色还散在两个 Style 类里，每改一页都要在两套之间来回对齐，越改越乱。所以第 0 步是把取值收进 `Palette.java`（见 `DESIGN.md`），这一层**只收拢、不改值**，改完观感必须一模一样。

## 页面清单

Android 侧共 4 个 Activity、11 个逻辑屏。`MainActivity` 用一个 String 字段 `screen` 驱动，切换时整棵视图树重建（没有 Fragment）。

| # | 页面 | 位置 | 复杂度 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 首页 | `MainActivity.homeScreen()` | 低 | ✅ 完成（`#26`） |
| 2 | 设置索引 | `MainActivity.settingsScreen()` | 低 | ✅ 完成（`#27`） |
| 3 | 供应商与 Key | `SettingsActivity.providers()` | 低 | ✅ 代码完成（`#29`，截图待补） |
| 4 | 通用 | `SettingsActivity.general()` | 低 | ✅ 完成（`#28`） |
| 5 | 已归档 | `SettingsActivity.archived()` | 低 | ✅ 代码完成（`#29`，截图待补） |
| 6 | 电脑列表 | `MainActivity.computersScreen()` | 中 | ✅ 代码完成（`#30`，截图待补） |
| 7 | 配对 | `MainActivity.pairScreen()` | 中 | ✅ 代码完成（`#30`，截图待补） |
| 8 | 手机访问（网络） | `MainActivity.showNetwork()` | 低 | ✅ 代码完成（`#31`） |
| 9 | 扫码 | `QrScanActivity` | 低 | ✅ 无需改动（`#31`） |
| 10 | 远程会话列表 | `MainActivity.listScreen()` | 中高 | ✅ 无缺口，仅 token 化（`#33`） |
| 11 | 本机会话列表 | `LocalChatActivity.list()` | 中 | ✅ 完成（`#33`） |
| 12 | 本机会话详情 | `LocalChatActivity.detail()` | 中高 | ✅ 无缺口，仅 token 化（`#33`） |
| 13 | 远程会话详情 | `MainActivity.detailScreen()` | 高 | ✅ 无缺口，仅 token 化（`#33`） |

**弹层**（被上面各页共用，本身也占内容）：`CamelliaDialog`（9 处）· `AttachSheet` · `ArtifactSheet` · `SettingsChoiceDialog` · `ComputerPickerPopup` · `ConversationMenu` · `ModelPickerPopup` · `RemoteSettingsPopup` · `ChatChoiceRow` · `ChatEmptyState`。→ **已完成（`#32`）**，详见下方第 8、9 页之后。

### 第 1 页做了什么

- **内容**：`SIGN_IN`／`TIMED_OUT` 两个状态原先文案让人去「设置 → 手机访问」却没有入口（卡片被禁用、重试按钮不显示）。新增「前往手机访问」直达按钮；`TIMED_OUT` 不再同时显示「重试连接」，避免同屏两个同名按钮。
- **设计**：设置入口的圆角从 12 改为与卡片一致的 20；字号全部走 token（新增 `TEXT_CARD` = 19）；出口按钮做成与卡片动作行同族（accent 文字、无底色），第一版用实心强调色被截图否掉。
- **回归**：`RemoteEntryGateTest` 6 项全过（新增 2 条断言）。
- **踩坑**：模拟器切中文失败（`setprop persist.sys.locale` 与 `cmd locale set-app-locales` 都无效，后者需 app 声明 `localeConfig`），截图仍是英文。中文排版未验。

### 第 2 页做了什么

- **内容**：「手机访问」行原先没有值，是本页唯一通向「状态看不见的地方」的入口。新增状态标签（`已连接`／`未连接`／`外部模式`），只取**同步可得**的 `EmbeddedNetwork.enabled()` 与 `online()` —— 刻意不查节点真实状态，那要起一次 Tailscale 连接，不该为了填标签就在每次打开设置时连一次网。
- **内容**：从「手机访问」返回时刷新该标签（`onStart` 原本直接 `return`），否则在那里切换开关后返回，索引仍宣称「已连接」。
- **设计**：修掉一个真 bug —— 设备名（上限 80 字符）换行成两行，把该行撑得比别行高、箭头悬在中间。原因是 `setMaxWidth` 只限宽不限行数。抽出 `valueView()` 加 `maxLines(1)` + 省略号，两处共用。
- **无障碍**：行的朗读标签是「标题 + 值」，所以更新值必须同步更新 `contentDescription`；为此给标题和值分别打了 `ROW_TITLE`／`ROW_VALUE` 标签，不靠「找第一个无 tag 的 TextView」这种依赖子 view 顺序的做法。
- **待议**：「已归档」被放在「数据与连接」组下，但它列的是会话、不是连接。属结构性调整，尚未决定。→ **用户决定不改**。

### 第 3、5 页做了什么（供应商与 Key、已归档）

- **内容**：空态原本是「分组卡片 + 标题 + 描述 + 右侧箭头」，和上方真正可点的卡片几乎同形 —— 用户分不清「这是操作」还是「这是状态」，得点了才知道。供应商页还把同一件事说了三遍（组标题「My providers」+「No providers yet」+ 说明）。
- 新增 `SettingsStyle.emptyState()`：**无卡片、无箭头、居中**，因为它报告状态而非提供去向；可选动作仍以按钮提供 —— 供应商页空态带「添加供应商」（点了直接进表单），已归档页不带（没有可做的事，长按会话才是路径，已在说明里）。
- **待办**：已归档页**有内容时**每条会话各建一张卡片（N 条 = N 张卡），应该是一张列表。尚未验证效果。

### 第 6、7 页做了什么（电脑列表、配对）

- **内容**：电脑列表的空态把 `ChatEmptyState` **塞进卡片里**，于是它和下方「添加电脑」行共用一张卡、读起来像又一个可点的东西；组标题「My computers」对空列表什么也没说。移到卡外（与供应商页同一处理）。
- **内容**：配对页的 Tailscale 行原本写死值「登录 / 设置」—— **那是它要打开的那个页面的名字，不是状态**。读者在配对页看不出自己登录了没有，而这一页恰恰是「网络不解决就配不了对」的地方。改为显示真实状态。
- 由此**合并了两个同义方法**（`mobileAccessState()` 与新写的 `tailnetRowState()`）—— 同一个问题的同一三行，两份拷贝就是将来其中一个跑偏的起点。`networkRouteChanged()` 增加 `settings` / `pair` 两个分支，网络变了但页面没重建时刷新对应那一行。
- **token 收尾**：`ComputerRow` 的在线绿点与 `MainActivity` 的权限图标色改读 `Palette`（#25 建好但漏接的）。介绍文字、扫码标题与提示等裸字号全部走 token。
- **测试同步**：`ComputerSelectionTest` 原本用 `chatEmptyState` 这个 tag 锁死了空态的实现。它断言的**意图**（空态可见／添加电脑唯一／点它到配对页）仍然成立，所以改测试而非回退代码；换 tag 之外**加了一条新断言**「空态不得在 `computerList` 卡片内」，把这次的决定锁住防回退。

### 第 8、9 页做了什么（手机访问、扫码）

- **内容**：这一页是「这台手机进网络了吗」的问句入口，答案原先只写进共享的 `status` —— 而那个控件在三个分组、五行之后，且它的 `TextWatcher` 只对 `list`/`detail` 过滤，**`network` 屏根本不在白名单里**。新增页面顶部自己的状态条（`SettingsStyle.statusBanner`）+ `reportNetwork()` 同时写两处；该页 6 处反馈全部改走它。
- 扫码页结构简单、已走 token，**无需改动**。只给取景框那处硬编码的深色补了注释，说明它**故意不跟 palette 变**（跟随调色板会在浅色下变成近白、二维码对比度全毁）—— 有意不 token 化的场合，补注释比改成 token 更有价值。

## 当前状态

**13 个页面 + 10 个弹层全部完成**（`#26`–`#33`）。全项目颜色、圆角、字号已完全走 `Palette` —— `text(…, N, …)` 与 `setTextSize(N)` 归零，只剩两处**有意不 token 化**并已写注释：扫码取景框的固定深色（跟随调色板会毁掉二维码对比度）、`SettingsChoiceDialog` 里对勾圆的几何半径 13（= 26/2，token 化它等于给「那个的一半」起名字）。

### 逐页结果里值得记住的三件事

1. **同一模式复发三次才被认出来**：空态被塞进分组卡片，在供应商页、已归档页、电脑列表各出现一次 —— 我做完第一个页面后，第二个页面仍然是照着旧代码改的。「一次一页」的价值在这里。
2. **两个 Dialog 的 `text()` 刻意没合并**（原本无 lineSpacing，与 `SettingsStyle.label()` 不同）—— 换过去会改变所有现存对话框的渲染，那是视觉决定不是去重。
3. **测试用 tag 锁死实现时，改测试而不是回退代码**：`ComputerSelectionTest` 因我换掉空态实现而失败，但它断言的**意图**仍然成立 —— 改 tag 之外还加了一条新断言，把「空态不得在卡片内」这个决定锁住。

### 仍未验证

**只有首页、设置索引、通用三页拿到过截图**，其余 10 页的视觉**未在模拟器上验证**。原因：`am start` 对 `exported=false` 的 Activity 无效、`input tap` 的坐标在 headless 模拟器上反复偏。代码正确性目前只保证到「编译 + 测试」这一层。

**下一步该做的是把剩下的页面截到图**，而不是继续改代码 —— 现在每改一页都缺「改完看一眼」这个环节。


**已完成 9 页**（第一批 1–5、第二批 6–9 全部代码完成）。改动都已编译通过，但**只有首页、设置索引、通用三页拿到了截图**；供应商页、已归档页、电脑列表、配对、手机访问五页的视觉**未在模拟器上验证**（`am start` 对 `exported=false` 的 Activity 无效，`input tap` 坐标在 headless 模拟器上反复偏）。

下一批：弹层统一（`CamelliaDialog` / `AttachSheet` / `ArtifactSheet` / `SettingsChoiceDialog` / 4 个 Popup），它们被所有页复用，统一一次全场受益。




### 第 4 页做了什么（通用）

- **内容**：偏好项的值被截断成 `Enter sends; h…` —— 三个选项标签是完整句子，而值列只有 100dp 单行。新增 `SettingsStyle.preference()`：标题一行、当前选项一行，右侧只留 chevron。
- **内容**：删掉与选项标签重复的说明（原来那段 6 行把三种模式又讲了一遍），但保留标签承载不了的信息（哪些输入法真的有长按手势：搜狗 vs Gboard）。6 行 → 4 行。底部说明同样从 7 行收到 4 行。




## 顺序

分三批，每批做完一批再进下一批。

**第一批 · 静态页（1–5、8–9）**
无异步状态，改坏了立刻看出来。它们先把 token 层用熟，也定下标题、行、分组、空态这几种复用形状的基准。

**第二批 · 列表与弹层（6、7、10、11 + 全部弹层）**
弹层放这批是因为**它被所有页复用**，统一一次全场受益。列表页开始引入折叠头、多选、空态三种形态。

**第三批 · 详情页（12、13）**
最复杂，两个都最后做。远程详情比本机详情多三个区块（授权、目标、队列），本机详情可以先做，远程的再在它之上加。

## 每页的检查项

改完一页，逐条过：

- **内容**：这一屏该显示的信息都在吗？有没有该给却空着的地方（空态文案、加载中、失败）？信息层级对吗（标题／副标题／分组标签／正文／注释）？
- **操作**：能做的都做得到吗？入口找得到吗？破坏性操作有确认吗？禁用态和进行中态都对吗？
- **一致性**：间距、圆角、字号是不是都走 token？和同一批里已定稿的页面对得上吗？
- **深色模式**：每个页面都要看一眼。现有 bug 多在深色模式下（开关轨道就是一处）。
- **小屏**：宽度不够时截断对吗？长文本、长标题、中英混排呢？
- **截图**：模拟器上截一张浅色、一张深色。

## 已知要处理的问题

补齐时顺手修掉已发现的：

1. **开关轨道 on 态在深色模式下是浅色值** —— 已在 token 层修掉（`SettingsStyle.toggle` 现读 `palette.accent`）。
2. **首页卡片描边**走的是内联 `Color.parseColor` —— 已收进 `Palette.homeCardEdge()`。
3. **`MainActivity` 3034 行**承载 7 个屏，是最大的耦合面。本轮**不拆**（拆分会动到每一页，与「一次一页」冲突），但每改一页要记下顺手理清的依赖。
4. `Palette` 之后要检查的漂移点：`ConversationDrag.java` 里还有两处按外观硬编码的颜色（拖拽指示线 `#4176E6`、拖拽卡片底色），下一批处理。

## 环境

已在本机搭好，改完能立刻验证：

```bash
export JAVA_HOME=~/sdk/jdk17/Contents/Home
export ANDROID_HOME=~/Library/Android/sdk
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

sh android/gradlew compileDebugJavaWithJavac        # 快速验证编译
sh android/gradlew assembleDebug                    # 出 APK
sh android/gradlew connectedDebugAndroidTest        # 136 个测试，需模拟器已启动

emulator -avd camellia35 -no-window -no-audio -no-snapshot -gpu swiftshader_indirect &
adb wait-for-device
adb exec-out screencap -p > /tmp/shot.png
adb shell "cmd uimode night yes"                    # 切深色，截完记得切回
```

`gradlew` 用 `sh` 调（仓库里那份没有执行权限）。模拟器**必须 headless 启动**，带窗口会静默退出。

**每次操作都要重新起模拟器**：agent shell 会在一条命令结束时回收它启动的后台进程（`setsid` 在 macOS 不存在，`launchctl` 在沙箱里不可用）。把「启动 → 等 boot → 装 APK → 启动 App → 截图」写进同一条命令，冷启动约 60–70 秒。

**截图默认是英文**：`tr(zh, en)` 按系统语言选文案，而 `setprop persist.sys.locale` 和 `cmd locale set-app-locales` 在这个 AVD 上都不生效（后者需要 app 声明 `localeConfig`）。要截中文图得在 AVD 的系统设置里改语言。英文排版已验证正常，中文未验。

