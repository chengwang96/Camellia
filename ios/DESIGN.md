# 设计约定

取值集中在 `CamelliaApp/Sources/Shared/Palette.swift`。这份文档记录**约定**本身；取值表在 `Palette.swift` 的注释里。

## 颜色

两套色板，各有其值，不是一套的错版：

- **聊天页**（`background` / `surface` / `ink` / `muted` / `separator`）—— 白底细线
- **设置与配对页**（`grouped` / `card` / `secondary` / `divider` / `field` / `fieldBorder` / `error`）—— 灰底白卡

`accent` 两边共用。`raisedFace` / `raisedEdge` 是返回键圆盘自己的那一对，与 `separator` 看着像但不是一档：它圈的是凸起按钮，不是区域。

## 字号

`textTiny` 11 · `textSmall` 12 · `textNote` 13 · `textBody` 14 · `textInput` 15 · `textRow` 16 · `textRowStrong` 17 · `textDialog` 18 · `textCard` 19 · `textTitle` 20 · `textDisplay` 21 · `textTick` 22 · `textHero` 28

几处刻意的相邻档位：

- **14 / 16 / 17 三档**：设置行标题用 17，聊天页会话名用 16，视觉重量刻意不同。
- **19 与 20**：卡片标题比页面标题小一档，因为卡片在页面**之内**，用 20 会读成第二个标题。
- **13 与 15**：13 是注释级，15 是可交互文本。

**SF Symbol 的 `.font(.system(size:))` 不进这套阶梯** —— 那是图标尺寸不是字号。裸留着是对的。

## 圆角

按「圆的是什么」命名而不是按数值，这样两个 20 能被区分开。

`smallRadius` 8 · `radius` 12 · `trackRadius` 14 · `fieldRadius` 18 · `homeRadius` 20 · `dialogActionRadius` 20 · `groupRadius` 26 · `capsuleRadius` 28 · `sheetRadius` 30

`dialogActionRadius` 与 `homeRadius` 同值纯属巧合，是两样东西。

## 三种「没有东西可显示」，不要混用

| 形状 | 什么时候用 | 有什么动作 |
| --- | --- | --- |
| **空态** `EmptyStateView` | 一切就绪，只是**还没有内容** | 可选，且动作通常就是「创建第一项」 |
| **阻塞态** `BlockedStateView` | 页面**还做不了事**，缺的是前提条件 | 必须有，且动作是**去补那个前提** |
| **加载中／失败** | 状态在变 | 取消或重试 |

**空态不要装在分组卡片里。** 卡片在别处的含义是「这里面的东西可以点」，空态装进去就和真正的操作行同形，读者得点一下才知道它不做事。放在卡片外面，标题居中、无箭头。

**阻塞态的页面，照样要保留通往解法的那个操作。** 本机聊天页在没有 API 配置时，除了说明「还没有可用的模型」并给出「前往供应商与 Key」，**列表和「新建会话」入口必须照常渲染** —— `createConversation` 内部本来就有一道守卫把人送去设置页，那个按钮不是「注定失败的操作」，**它就是解法的一部分**。

> Android 端在这件事上先犯过一次：把阻塞态做成了提前 `return`，砍掉了唯一的前进路径，3 个测试当场挂（`LocalChatTest`）。判据是：**一个操作「当前会失败」不等于「不该显示」，要看它失败时有没有把人导向解决办法。**

## 空态组件的接口

`EmptyStateView` 的 `glyphSize` 是**图标自身**的尺寸，不是含 padding 的圆盘。Android 的三处空态曾是 30 / 34 / 36，那是同一个想法漂了六磅；现在默认值统一，出挑的那几处显式传自己的值，**不要在调用点做加减法补偿**。

图标带一层 `surface` 圆盘底 —— Android 的 `ChatEmptyState` 是这么画的，没有它字形就浮在页面上，读起来像装饰而不是标记。

实际 APK 的供应商与已归档空态没有图标，所以两页使用无图标的专用空态；`EmptyStateView` 的默认图标规则只适用于 Android 本来有图标的页面。

## 批量改代码的纪律

这一层的 Swift 没有 XML、没有 `lint` 兜底，正则改错只会表现为编译错误或更糟 —— **静默改错**。所以：

- 替换模式**必须锚定完整调用**（`.font(\.system\(size: (\d+)` 这类），漏掉开头的 `\.` 就会把方法名吃掉一部分。
- 替换后**用编译器定位**，不要用眼睛数括号。本轮有 27 处括号被改坏，全靠 `check-client.sh` 的行号一行行找。
- 修错误的脚本比不改更糟。本轮一个正则修复脚本先造出 `.font(.system(size: .font(.system(size: …`，又得再跑一遍清理 —— **改到编译通过为止，不要靠推测收敛**。
