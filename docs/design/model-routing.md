# Model identity and API routing

Each configured model has a **routing model ID** (`id`) and a provider's **upstream model ID** (`upstream`). The picker, key failover, reasoning controls and context budgets use the routing ID. Requests always send the upstream ID unchanged.

Known model families normalize letter case and their own owner namespaces, including repeated namespaces. For example, `openai/openai/gpt-6-astra` becomes `gpt-6-astra`, `moonshotai/Kimi-K3` becomes `kimi-k3`, and `zai-org/GLM-5.3` becomes `glm-5.3`. This applies to existing configurations and incoming requests as well as newly fetched catalogs. Unknown and private namespaces remain intact. Versions, dates, tiers, preview names, quantization and moving aliases are never removed or equated by this normalization.

For provider-specific aliases that cannot be established from spelling, use **Settings → API Keys → provider → Map model aliases**. Assign the same routing ID only after establishing that the upstream models are equivalent. The routing field suggests IDs already configured on other providers and saves automatically. It can also assign a separate custom routing ID when a route should remain independent. Catalog selection follows the upstream ID, so fetching or selecting models preserves manual mappings. Distinct upstream entries may share one routing ID on the same provider; duplicate copies of the same route are rejected.

**Settings → Model Settings → API key routing** provides independent **Multi-key concurrency** and **Automatic key failover** switches. Both default to enabled for existing and new configurations. They save in the shared router configuration as `routing.multiKeyConcurrency` and `routing.multiKeyFailover`, apply to all API models and can change without interrupting active requests. Provider-only exports/imports retain the destination's routing preferences.

With concurrency enabled, requests choose the key with the fewest active requests across providers at the selected priority. Equal loads retain the active key and provider/key order. With concurrency disabled, requests retain that order even when the current key is busy; it does not serialize requests on a single key. A busy high-priority route still precedes an idle lower-priority route.

With failover enabled, selection skips unhealthy keys and failed requests can retry another route for the same model before output starts. With failover disabled, selection does not replace an unhealthy chosen key, and each request has at most one upstream attempt. Concurrency can still assign new overlapping requests to different keys. An unavailable selected key requires manual rotation/reset or enabling failover. Benchmarks and provider-bound discussions retain their explicit provider/key scopes with either setting.

Normalization merges historical API usage under the routing ID without changing lifetime totals, preserves the longest existing cooldown for equivalent names and migrates active-key preferences. Context limits include every enabled fallback route and use the smallest safe budget. Explicitly reported thinking controls are intersected across routes. Subscription model identities remain managed by their own accounts.

This balances requests that are already concurrent. Splitting an individual task into parallel agent work remains the responsibility of its execution engine.
