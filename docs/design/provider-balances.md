# Provider balances and local usage

This adapter inventory was reviewed on 2026-09-15. **Usage** counts business requests routed by Camellia; **Balances & Quotas** reads account endpoints. The figures have different units and must not be added. Upstream endpoints and entitlements can change, so verify an adapter against current provider documentation before extending it.

| Provider | Account data shown | Source or limitation at review time |
| --- | --- | --- |
| DeepSeek | Available balance and returned cash/bonus components | Official `GET /user/balance`. |
| Moonshot/Kimi API | Available, cash, and voucher balances | Official `GET /v1/users/me/balance`; China and international keys are distinct. |
| Kimi Code subscription | Reported quota windows and reset times | Native Kimi Code usage endpoint; separate from Moonshot prepaid balance. |
| OpenCode Go | Five-hour, weekly, and monthly usage windows | Official service implementation of `/zen/go/v1/usage`; requires the relevant plan. |
| OpenCode Zen pay-as-you-go | No cash-balance API established in this review | Local routed usage is still available. |
| Command Code / GOAT | Credits and returned subscription/model limits | Official CLI account endpoints; Credits are not treated as US dollars. |
| Ollama Cloud | Reported subscription-window usage and per-model request counts | `/api/usage` returned 200 in a local read test but was not a documented public account API. |
| Local Ollama and custom relays | Camellia's own routed usage | A similar provider name does not authorize sending a relay key to an official provider domain. |

Configure keys in **Settings → Providers & Keys**, read the model catalog, then validate a selected model with a short request. A catalog entry alone does not establish entitlement. Usage can be filtered by provider, key, model, and date, and exported as CSV. Daily records are retained for about 90 days; the model total remains cumulative. An account balance may be shared by several keys, so the UI does not sum cards into a supposed total.

Automatic account refresh defaults to 15 minutes and queries enabled providers/keys. The app stores observed trend points for about 30 days; it cannot reconstruct earlier account history. A failed refresh retains the last success with its timestamp. Missing balance, reset time, or unit is left unknown rather than inferred. Provider usage may include cached input; cached reads are a subset of input, not an extra amount to add. Failed requests with upstream-reported tokens remain attributable to the key that was charged.

Implementation: `src/api/api-usage.js` stores routed usage; `provider-accounts.js` selects adapters by real endpoint; `provider-insights.js` schedules and caches account observations without storing raw keys in its trend file. New adapters need verified authentication, units, reset semantics, and representative response tests. The Camellia brand assets live under `assets/`; `npm run build:icons` regenerates platform icon sizes from the main artwork.
