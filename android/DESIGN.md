# 设计 token

App 的取值集中在一个类里：`app/src/main/java/app/camellia/mobile/Palette.java`。

Design values and control behavior have shared owners. Before changing a reported screen, inventory all equivalent callers and update the shared owner. Current family coverage and remaining iOS gaps are recorded in [the mobile consistency audit](../docs/design/mobile-consistency-audit.md). Numeric tables below reflect the current Android Palette; the cross-platform guard checks shared iOS roles.

## Shared owners (2026-11-15)

- `ActionStyle`: page/dialog action appearance, enabled/disabled states and primary contrast. All eight action adapters delegate here; inline text actions and toolbar symbols retain their own roles.
- `ChatStyle.pageHeader` and `ChatDockLayout`: common local/remote/discussion header geometry, clipped viewport and composer tail clearance. Do not rebuild a fourth copy in another conversation type.
- `ScrollViews.plain/capped`: scrollbar policy for ordinary panels. Keep each panel's meaningful height/keyboard constraint and preserve specialized chat/refresh scrolling.
- `Palette`: theme, typography and shape roles. Shared iOS values and both iOS composer callers are guarded by `tests/mobile-ui-consistency.test.js`.
- Validate every caller in light/dark, Chinese/English, enabled/disabled and narrow layouts. Track unverified platform/device coverage explicitly.

## 为什么有这一层（历史背景）

在它之前，颜色写在两个构造函数里：五个在 `ChatStyle.java`（聊天页），九个在 `SettingsStyle.java`（设置、电脑、配对页）；圆角、字号、涟漪透明度则内联在各自的调用点。改一个颜色要动三个地方，页面上每处 `setTextSize(14)` 都要自己判断这是不是正文的 14。

已经漂了一处可以佐证：`SettingsStyle.toggle` 的开关轨道 on 态硬编码了浅色的 `#4176E6`，深色模式下也是这个值（而 accent 在深色下应是 `#679EFE`）；off 态则用 `background == #F5F5F5` 反推深浅色。现在两者都直接读 token。

## Changing shared values

Token extraction initially preserved the existing appearance. Subsequent design changes must update the shared family, its callers and documented values together. Changing a single page's copy of a value is not a completed consistency fix. Shared roles can retain distinct names when their semantics differ, even if their current numbers coincide.

## Desktop-aligned surfaces (2026-11-01)

Chat and settings share the desktop neutral base. Settings use outlined cards and filled controls; popups keep their mobile glass and larger radii.

The four bottom destinations use one 64dp navigation component. Keep its glass wash, neutral selected face, icon scale and soft shadow consistent across pages; only the active icon/label and selected position change. Underlying content may show softly through the glass without visibly changing the selected button's grey tone. Cap width to the actual viewport, leave 4dp below the bar for its shadow, and include that gap in scrolling tail padding. Retain rounded press feedback and the opaque power-save fallback.

| token | 用在哪 | 浅色 | 深色 |
| --- | --- | --- | --- |
| `background` | 聊天页底色 | `#F6F7F9` | `#151517` |
| `surface` | 聊天页通用块（用户气泡使用 `userBubble`） | `#F5F6F7` | `#232324` |
| `ink` | 聊天页正文 | `#14171A` | `#F0F2F4` |
| `muted` | 聊天页次要文字 | `#69717B` | `#A4AAB2` |
| `separator` | 悬浮栏的细边 | `#E8EBEF` | `#3B3B40` |
| `grouped` | 设置/配对页底色 | `#F6F7F9` | `#151517` |
| `card` | 那几页的卡片 | `#FFFFFF` | `#222326` |
| `secondary` | 那几页的次要文字 | `#69717B` | `#A4AAB2` |
| `divider` | 卡片内行间细线 | `#E8EBEF` | `#37373C` |
| `field` | 输入框底 | `#F5F6F7` | `#292A2D` |
| `fieldBorder` | 输入框边 | `#E2E6EA` | `#393B40` |
| `error` | 破坏性操作、错误文字 | `#C93645` | `#FF8791` |
| `userBubble` | 用户气泡 | `#EEF2FF` | `#283142` |
| `faint` | 三级文字 | `#858C95` | `#ADB2B8` |
| `caption` | 占位文字 | `#9AA1A9` | `#81858C` |
| `accent` | 两套共用 | `#4D6BFE` | `#8095FF` |
| `trackOff` | 开关关态轨道 | `#D9DCE0` | `#54575D` |

首页卡片的描边（浅色 `#E2E6EA` / 深色 `#393B40`），走 `Palette.homeCardEdge()`。

## 圆角

| token | 值 | 用在哪 |
| --- | --- | --- |
| `RADIUS_CARD` | 12 | 通用块 |
| `RADIUS_USER_BUBBLE` | 16 | 用户气泡 |
| `RADIUS_SETTINGS_CARD` | 14 | 设置卡片 |
| `RADIUS_SETTINGS_CONTROL` | 10 | 设置输入框 |
| `RADIUS_CAPSULE` | 18 | 悬浮栏、输入胶囊（不是真胶囊，是大圆角矩形） |
| `RADIUS_GROUP` | 16 | 弹层面板 |
| `RADIUS_SHEET` | 22 | 底部 sheet 的面板 |
| `RADIUS_FIELD` | 12 | 输入框、选项行 |
| `RADIUS_CODE` | 8 | Markdown 里的代码块 |
| `RADIUS_TRACK` | 14 | 开关轨道 |
| `RADIUS_GRIP` | 3 | sheet 顶部的抓手、进度条 |
| `RADIUS_HOME_CARD` | 14 | 首页卡片 |

另有一个不是圆角：**`BUBBLE_INSET` = 36**，是「自己的消息」离屏幕右边缘的距离，也是气泡允许到的最大宽度。两个方向同值，短回复和长回复才会起于同一处、止于同一处。

## 字号

`TEXT_TINY` 11 · `TEXT_SMALL` 12 · `TEXT_NOTE` 13 · `TEXT_BODY` 14 · `TEXT_INPUT` 15 · `TEXT_ROW` 16 · `TEXT_ROW_STRONG` 16 · `TEXT_DIALOG` 18 · `TEXT_CARD` 18 · `TEXT_TITLE` 21 · `TEXT_DISPLAY` 22 · `TEXT_HERO` 28

Use the semantic role rather than copying the number. Conversation headers share `TEXT_CARD`; page titles use `TEXT_TITLE`, while the main Workbench destinations use `TEXT_HERO`. Compact metadata remains below interactive row text.

## 首页的层级

首页是「在几种进入方式里选一个」，不是「叫用户去做某件事」。这条决定了它的视觉规则：

- 入口是**卡片**（`RADIUS_HOME_CARD` = 14），底部设置入口也是同一圆角。同一屏不该出现两种圆角的同级元素。
- 卡片的动作行是 **accent 色文字、无底色**；它属于卡片内部的说明性动作，不是独立按钮。
- 首页不再放重复的电脑连接横条；配对电脑和连接状态在会话页/电脑页呈现。首页打开的会话返回首页，会话列表打开的会话返回列表。
- 首页快捷区只保留“本地聊天 / 设置”，以整行作为点击目标，右侧只保留一个箭头；不要再加重复的“打开”文字胶囊。“电脑与连接”从底部“电脑”进入，不在首页重复，也不保留该条目附带的连接状态和重试按钮。
- 四个底部目的地之间切换时不做左右推页：底栏位置和尺寸保持不变，只替换内容区。左右滑动只用于进入/退出会话详情等层级导航。
- 工作台、会话、电脑是同级一级页面，不是父子栈。会话使用当前电脑的上下文，顶部提供切换电脑；电脑页只管理配对与连接，打开电脑后切换回会话一级页。一级页不显示返回箭头；系统返回从会话回工作台，而不是回电脑。
- 工作台顶部只列运行中会话，默认显示前三项；超过三项时在“运行中”标题右侧提供展开/收起，展开后仍不进入“最近”。下面的“最近”固定排除所有运行中、待审批和后台仍在工作的会话，避免同一会话出现两次。
- “工作区”标题右侧的新建入口是 48dp 裸加号符号，不再额外加浅色圆底；它和搜索、切换电脑等工具栏动作保持同一层级。
- 会话筛选固定为“全部 / 运行中 / 等待处理 / 已归档”四项，不再提供“有文件”；旧状态如果残留 `files`，读取时回退到“全部”。
- 工作台、会话和电脑一级页使用 28sp 大标题，分组标题 18sp，列表行标题 16sp；不要再让“会话”与普通行标题同一字号。设置索引保留自己的居中页头语义。Apple 的沉浸式背景和仪表盘卡片结构不进入 Camellia。
- 顶部相邻的搜索和切换电脑动作合并进同一个中性胶囊工具组；只有一个动作时仍保持裸符号。不要恢复成每个图标一张白卡。
- 底部导航是居中的悬浮胶囊，宽度约为窗口的 `78%`（`300–440dp` 夹取），不再横跨整页；外层无描边，只有选中项获得稳定的中性灰色填充，不能给选中项再加轮廓。
- 平板横屏且窗口至少 `840×600dp` 时，远程会话详情使用左栏会话、右栏聊天。左栏 `300–360dp`，行内保留引擎、状态、时间和未读；切会话只替换右栏，不退出当前页面。手机仍锁定竖屏。
- 语言、主题只覆盖对应配置，不能复制整份 `Configuration` 固定屏幕尺寸或方向。横竖屏回归要通过系统实际旋转，确认左栏显示、草稿和连接对象保留；手动修改资源并调用回调不能代替这项检查。
- 宽屏分栏左侧的标题拥有独立不透明背景并绘制在滚动层之上，滚动区从标题下方开始并裁剪到栏内，不能把列表内容画到标题或状态栏上。
- 宽屏分栏中点击会话只切换右侧内容，不调用自动滚动把选中项顶到第一条；左侧栏重建时恢复点击前的 `scrollY`，保持用户当前浏览位置。
- 平板旋转时 `MainActivity` 自行处理 `orientation/screenSize/smallestScreenSize/screenLayout` 变化，不销毁重建 Activity。详情页只重建视图层，保留现有 `RemoteApi`、事件流、连接代次、历史、草稿和消息滚动位置；会话列表只重排筛选与卡片。不要用重连来换取布局更新。

## 轻量立体层级

移动端不再依赖平台默认按钮的立体感。可交互元素的层次固定为：

- **页面按钮**：1dp 描边 + 1dp 轻阴影；按下时 `translationZ` 下沉 1dp。
- **主操作**：accent 实心面 + 2dp 阴影；禁止同时出现第二个同级强调按钮。
- **卡片与列表行**：1dp 描边 + 1dp 阴影，保持白/深色面之间的分离。
- **浮层与 sheet**：保留更高的 elevation 和独立描边，继续保持玻璃语义。模型选择器是较窄的浮动菜单，宽度为可见宽度的 `82%`、上限 `340dp`（最小 `280dp`）；权限选择器仍可使用 `420dp` 宽度。两者都水平对准输入区的触发按钮，并带短距离上移动画；不要按整条模型行的左边缘定位。通用 `CamelliaDialog` 在首帧显示前锁定最终宽度，显示后只按可见区域调整高度；不要先显示、再改宽度，否则居中面板会横向跳一下。
- **状态标签和正文中的动作文字**：不加投影，避免状态色变成装饰。
- **选择控件**：单选用 `ChoiceRow` 的圆形标记，多选用方形标记；整行都有 1dp 描边、轻阴影和选中色面，禁止直接露出平台 `RadioButton` / `CheckBox`。
- **开关**：`SettingsToggle` 自绘 1dp 轨道描边和带阴影的滑块；按下时滑块内收，不使用平台默认轨道。
- **输入框**：对话框和设置页统一用 `SettingsField` 的圆角描边面，不使用系统下划线。
- **聊天输入区**：外层只有一个输入面板。附件、联网和权限是输入区内的小工具区，模型名是纯文字选择器；只有发送/停止按钮使用强调色实心面。权限始终有独立入口：手机只显示盾牌图标，平板 `600dp` 以上显示盾牌加“需确认/默认/全自动”短标签；附件 sheet 不再重复安全级别。盾牌用 `LineGlyphView` 显式绘制在透明的 34dp 图标容器里，不带独立灰色圆盘；外层 48dp 点击区仅保留交互涟漪。颜色必须是不透明值；“全自动”的琥珀色尤其不能再写成缺 alpha 的六位整数。
- **工具栏与发送键**：返回、搜索、切换电脑等导航动作只画 48dp 触控区里的线性符号，不加白卡、描边、阴影或圆盘；发送/停止是 48dp 热区内的 38dp 实心圆，不再使用带边框的圆角方卡。会话筛选只给当前项一层浅 accent 胶囊，未选项是无底文字。
- **模型选择器**：控件的可见宽度由当前模型名和思考等级决定，不再占满输入区；过长名称以输入框宽度的 `58%` 为上限，同时受工具行剩余宽度约束。平板和横屏因此可以自然显示更长名称，但不会挤掉发送按钮。
- **模型/设置菜单尺寸**：模型菜单根据模型名、行内边距和预留选中标记列决定宽度，最小 `220dp`、最大 `340dp`，并受窗口两侧留白约束；说明文字在菜单内换行，切换选中项不改变宽度。菜单在输入区触发按钮上方展开，保留按钮以便再次点击关闭。手机最多使用可见高度的 `56%`（上限 `420dp`），平板最多 `72%`（上限 `720dp`），同时受触发按钮上方的实际空间约束；键盘打开时使用实时可见区域。其余内容在面板内滚动；权限菜单内容更短时仍按内容收缩。列表尚未滚到底时，底部用 30dp 渐隐提示还有内容；滚到底后渐隐自动消失。模型/设置行采用 54dp 紧凑触控高度。
- **行内动作**：消息复制、产物查看、电脑管理、队列管理、目标和任务的暂停/恢复使用无描边的图标或浅色文字块；描边只留给页面级按钮、对话框按钮和输入框。
- **附件 sheet**：拍照、照片、文件三个来源动作共享一个分组面，只用等宽列、图标和短标签分区；不要给每个来源再套描边圆角卡、图标圆底或独立阴影。关闭按钮是工具栏纯符号，只有 48dp 触控区，不加圆框。能力选项继续使用带发丝分隔线的分组行。
- **队列 sheet**：队列卡片只使用平面浅色面和 1dp 细边，不叠加 elevation；只有最外层 sheet 有浮层感。插入是唯一轻强调动作，编辑和移出使用文字动作，移出用错误色。
- **图片预览**：分享和保存是右下角 48dp 圆形图标按钮，使用白色线性图标和半透明深色底；不要恢复成横跨底部的文字按钮。两个按钮都保留各自的无障碍说明。

页面背景使用 `Palette.pageBackground()` 的极轻渐变，顶部颜色与系统栏一致。该规则来自 2026-11-14 对 DSH Go Remote 与 Happier 的参考复核：采用其描边、低阴影、按压反馈和胶囊控件节奏，不复制品牌或组件外观。

2026-11-14 的第二次移动端细化，以 Apple 官方 Files、Pages 截图和 Human Interface Guidelines 的 sheet / toolbar 结构为参照：工具栏优先纯符号，分组列表共享外层面，行与行靠发丝线分隔而不是各自做成浮动按钮，触控区不小于 44–48dp。Camellia 仍保留桌面端的配色、强调色、字号层级和组件语义，不复制 Apple 品牌视觉。

随后复核用户提供的 iPhone Home、健康、查找、Apple Store 截图，只吸收与 Camellia 结构相符的三点：相邻工具栏动作合并、内容新增动作保持轻量、底部导航作为独立悬浮胶囊。没有采用大背景照片、渐变主视觉、统计仪表盘、购物英雄卡和 Apple 品牌色。


## 其余

- 涟漪：`RIPPLE_ON_PAGE`（页面上的行内按钮与工具栏符号）· `RIPPLE_ON_CARD`（卡片内的设置行）· `RIPPLE_HOME_CARD`（首页卡）· `RIPPLE_ON_ACCENT_LIGHT`（强调色实心按钮）。
- 状态色：`ONLINE`（电脑可达）· `PERMISSION_STRICT`（权限档位较严时的图标色）。
- `Palette.of(context)` 取当前外观的一套；`Palette.dark` 给「需要问是深是浅」的少数几处用。

## 约定

- **页面代码不再出现字面量颜色、圆角、字号。** 需要新的档位时，先想清楚它是不是现有某一档的别名 —— 是就复用，不是才往 `Palette` 加，并写清为什么不能是现有那档。
- Equivalent controls reuse the same semantic token. Different roles may share a current number without becoming the same control.
- 判断深浅色用 `palette.dark`，不要拿颜色和某个字面量比（那是 `toggle` 之前的老做法）。
- `PopupSurface` 是个例外：它浮在**别的页面**上，所以从采样到的颜色反推深浅，而不是问配置。

## 三种「没有东西可显示」，不要混用

界面上的「空」有三种，每一种对读者的含义不同，动作也不同：

| 形状 | 什么时候用 | 有什么动作 |
| --- | --- | --- |
| **空态** `emptyState()` | 一切就绪，只是**还没有内容**。也让读者动手做点什么 | 可选，且动作就是「创建第一项」 |
| **阻塞态** `blockedState()` | 页面**还做不了事**，缺的是前提条件 | 必须有，且动作是**去补那个前提** |
| **加载中 / 失败** | 状态在变 | 取消或重试 |

**空态不要装在分组卡片里。** 卡片在别处的含义是「这里面的东西可以点」，空态装进去就和真正的操作行同形，读者得点一下才知道它不做任何事。放在卡片外面，标题居中、没有箭头。

**阻塞态的页面，照样要保留通往解法的那个操作。** 本机聊天页在没有 API 配置时，除了说明「还没有可用的模型」并给出「前往供应商与 Key」，**列表和「新建会话」按钮必须照常渲染** —— 因为 `createConversation()` 内部本来就有一道守卫会把人送到设置页，那个按钮不是「注定失败的操作」，**它就是解法的一部分**。曾把这页改成提前 `return`，结果把唯一的前进路径砍掉了，3 个测试立刻挂（见 `LocalChatTest`）。

判据：**一个操作「当前会失败」不等于「不该显示」，要看它失败时有没有把人导向解决办法。**

## 行的右侧值

`SettingsStyle.row()` 的第三个参数是行右侧的值，`SettingsStyle.valueView()` 统一定义它的样子，**不要在别处另建一个**。

- **单行 + 省略号**。`setMaxWidth` 只限宽、不限文本行数：设备名上限 80 字符，会换行成两行，把这一行撑得比同组其他行高，右侧箭头悬在中间。
- **值要能就地更新**。`setRowValue(row, value)` 改值而不重建分组（重建会丢滚动位置）。传空串则移除该视图。
- **改值要同时改朗读标签**。行的 `contentDescription` 是「标题 + 值」，所以 `setRowValue` 一并更新它 —— 否则屏幕阅读器读的是旧状态而屏幕显示的是新状态。为此标题与值各自打了 `ROW_TITLE`／`ROW_VALUE` 标签，不要用「找第一个无 tag 的 TextView」这种依赖子 view 顺序的写法。
- **只显示同步可得的状态**。行的值要在页面构建时就有，所以不能是「起一次网络查询才知道的东西」。首页和设置索引里的网络状态因此只取 `EmbeddedNetwork.enabled()` 与 `online()`。

