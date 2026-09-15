# 供应商余额与用量

核查日期：2026-09-15。界面分为「调用用量」与「余额与额度」：前者是经过本机统一路由的业务请求，后者来自供应商账户接口，两者不相加。

## 当前支持范围

| 供应商 | 可查询内容 | 接口依据与边界 |
|---|---|---|
| DeepSeek 官方 | 可用余额、充值与赠送部分，按返回币种展示 | 正式公开接口 [`GET /user/balance`](https://api-docs.deepseek.com/api/get-user-balance/) |
| Kimi / Moonshot 开放平台 | 可用余额、现金、代金券 | 正式公开接口 [`GET /v1/users/me/balance`](https://platform.kimi.com/docs/api/balance)；中国站 CNY，国际站 [USD](https://platform.kimi.ai/docs/api/balance)，两个平台的 Key 独立 |
| Kimi Code 订阅 | 周额度及接口返回的其他时间窗口、重置时间 | 官方 [Kimi Code 源码](https://github.com/MoonshotAI/kimi-code)及随应用附带的 `@moonshot-ai/kimi-code@0.43.0`，`GET /coding/v1/usages`；与 Moonshot 充值余额分开 |
| OpenCode Go | 5 小时、每周、每月使用比例及重置时间 | 官方服务[源代码](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts)的 `GET /zen/go/v1/usage`；Key 必须开通相应订阅 |
| OpenCode Zen 按量付费 | 暂不提供账户余额查询 | 本次在[公开文档](https://opencode.ai/docs/zen/)与当前开源服务路由中未找到可用 API Key 查询现金余额的接口；仍支持本机调用统计 |
| Command Code / GOAT | 剩余 Credits、订阅时间窗口及返回的模型/组织限额 | 官方 `command-code@1.54.0` CLI 的 `/usage` 实现：`GET /alpha/whoami?limits=1` → `GET /alpha/billing/credits?orgId=…`；相关[额度说明](https://commandcode.ai/docs/resources/usage-limits)和 [Provider Key 文档](https://commandcode.ai/docs/provider)。Credits 不当作现金美元 |
| Ollama Cloud | 返回的订阅窗口使用比例、按模型请求数 | `GET https://ollama.com/api/usage` 已用现有 Key 实测 HTTP 200。此接口尚未列入公开 API 文档；公开的 [Usage 文档](https://docs.ollama.com/api/usage)只描述单次调用 Token。页面明确标记未文档化接口 |
| 本机 Ollama / 自定义中转 | 本机调用统计；余额按后续适配提供 | 不因供应商名称相似而将中转 Key 发给官方域名 |

DeepSeek 与 Kimi 使用正式 API；Kimi Code、OpenCode Go 与 Command Code 采用官方客户端或服务源代码中的接口，可能随上游版本调整。除了已有 Ollama Key 的只读实测，其余适配使用官方响应结构进行本地测试，尚未用真实订阅逐一验证。

## 配置与阅读方式

1. 在「供应商与 Key」中选择供应商，粘贴一个或批量导入多个 Key，可给每个 Key 命名。
2. 点击「读取模型列表」，搜索并勾选所需模型。目录可访问不代表此 Key 对每个模型都有调用权限。
3. 保存后选择验证模型，点击 Key 旁的「验证」。它会发送一条简短请求，可能产生少量费用；不计入业务调用统计。其余模型可分别验证。
4. 「调用用量」可按日期、供应商、Key、模型筛选，并导出 CSV。按日数据保留近 90 天，按模型累计持续保存；旧版本仅有的汇总显示在「累计」中，不虚构历史模型归属。
5. 「余额与额度」按账户卡片显示，可筛选供应商、名称或 Key 掩码。现金、Credits、订阅百分比各用自己的指标和曲线。多个 Key 可能共享同一账户余额，不计算卡片总和。

账户余额查询本身不发送模型生成请求。自动刷新默认每 15 分钟一次，只查询启用的供应商和 Key，可在「通用」关闭。点击「刷新此 Key」可以手动查询停用的 Key。

曲线是启用后在本机采集的观测值：每 15 分钟保留一个点，保留近 30 天；无法补取此前历史。查询失败保留上次成功值及其时间，界面显示错误。缺少额度、绝对金额或重置时间时不推算。Ollama 的 `activity.cost` 是已计量用量，不作为余额。

Token 来自供应商响应。输入包含缓存读取/写入的 Token；缓存读取列为其中一部分，不能再与输入相加。供应商没有返回 Token 时明确记录为未提供。成功、失败与取消分开记录，失败线路已经消耗且有上游报告的 Token 也会计入对应 Key。Token 计数接口和连接验证不属于业务请求。

## 实现与新增供应商

- `src/api/api-usage.js`：按 Key、模型、日期累计路由用量。
- `src/api/provider-accounts.js`：按实际 API 域名/路径选择适配器，统一输出 `balances`、`windows`、`modelUsage`。新增供应商只需增加适配器与必要的配置预设。
- `src/api/provider-insights.js`：查询调度、状态及曲线缓存。数据写入应用目录的 `provider-insights.json`，不保存原始 Key；更换凭据或接口后不沿用旧账户曲线。
- `src/renderer/settings/`：统一设置界面、筛选、图表与 CSV 导出。

新增适配时以供应商正式文档或官方代码确认鉴权、金额单位、百分比单位和重置时间；为真实响应结构补上样例测试。不要把不同模型版本合并为同一条故障转移线路。

## 名称与图标

产品名为 **Camellia**，应用标题、打包名与快捷方式统一使用此名称。图标为优雅的侧身小猫，主图在 `assets/icon-1024.png`，同时提供 Windows ICO 和 256px PNG。运行 `npm run build:icons` 可从主图重新生成各尺寸图标。
