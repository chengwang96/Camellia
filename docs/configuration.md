# Configuration

## Instructions during a response

While a response is running, Enter or the send button submits an immediate instruction to the current turn, without stopping it or starting another turn. The shared Codex connection uses native `turn/steer` with the expected turn ID. Acceptance means the engine received the instruction, not that an already-running command was interrupted or undone.

Other current engine connections, including Kimi over ACP, do not yet expose this capability; they report it as unsupported and retain the composer text and attachments. Rejected instructions also stay in the composer and are not automatically retried against another turn. Use Alt+Enter to explicitly queue a message for after the current work ends. An empty composer retains the Stop action.

On Windows, an opt-in paid integration check is available with `$env:CAMELLIA_LIVE_STEER='1'; node tests/codex-steer-live.cjs`. It uses the configured Codex API model and an already-running local API router, with isolated temporary conversation/history files. It verifies a correction after real streaming begins, same-turn identity, rejected stale instructions, and persisted history. This is not part of `npm test` and incurs provider usage; its JSON report is saved under the printed temporary directory. It tests the shared manager and native transport, not Electron UI automation. Steering may be consumed after the current model response finishes rather than interrupting its token stream.

[Back to Camellia](../README.md) · [Documentation index](README.md)

Camellia separates the engine that executes a task from the provider that supplies inference. Connections and routing are managed centrally; each engine retains its own history and native options.

## Display language

Open **Settings → General → Language**, choose **English** or **简体中文**, and click **Save preferences**. English is the default. The choice is saved on this device and updates open workbench pages and the embedded DSH settings panel without restarting conversations. It changes interface labels, not conversation content, model IDs, native configuration values, or an engine's response language.

## Providers and API keys

Open **Settings → Providers & Keys**.

The **Account sign-in** section opens the native account settings for Kimi Code, Antigravity (Google), or Codex CLI (ChatGPT). A shortcut selects account mode in the settings draft and brings the save/sign-in button into view. Save if shown, then click **Sign in** to begin official authorization. Opening a shortcut does not save settings, discard pending API edits, download a runtime, or begin authorization. Kimi and Gemini presets in **Add API provider** also offer account-setting shortcuts.

1. Choose a preset or enter a custom API endpoint.
2. Add keys individually or paste a batch. Give keys recognizable labels.
3. Fetch the provider's model catalog and select the models to expose. Enter models manually when no catalog is available.
4. Save, then validate each key against the models you intend to use.

Presets cover Google Gemini API, Ollama Cloud, DeepSeek, Kimi / Moonshot, Kimi Code (API key), MiMo (pay-as-you-go), MiMo Token Plan (China, Singapore, Europe), Command Code GOAT, OpenCode Go, and OpenCode Zen. These presets require API keys; they do not initiate OAuth. They provide connection defaults; access and quotas depend on the account.

### MiMo pay-as-you-go API

Select **MiMo (pay-as-you-go)** and add a regular MiMo API key, not a Token Plan `tp-…` key. The preset includes `mimo-v2.6-pro` and `mimo-v2.6-flash`, with OpenAI base URL `https://api.xiaomimimo.com/v1` and Anthropic base URL `https://api.xiaomimimo.com/anthropic/v1`. Save the provider, then choose a model in your engine's **API** connection settings. Requests consume your API account balance, not subscription Credits. If you also configure Token Plan for the same model, the router can fall back to this paid route when the subscription route is unavailable. UltraSpeed is not enabled by default; add it manually only if your account has access and you accept its separate pricing.

### MiMo Token Plan

Select the MiMo Token Plan preset matching the region displayed in your MiMo console and add the subscription's dedicated `tp-…` key, not a regular pay-as-you-go key. The presets include `mimo-v2.6-pro` and `mimo-v2.6-flash`; fetching a model catalog is optional. They support OpenAI Chat Completions and Anthropic Messages through the shared API router. Select **API** in your engine settings and choose one of these models.

The OpenAI base URL is `https://token-plan-{region}.xiaomimimo.com/v1`, where `{region}` is `cn`, `sgp`, or `ams`. Camellia's Anthropic base URL is `https://token-plan-{region}.xiaomimimo.com/anthropic/v1`: unlike an Anthropic SDK base URL, it includes `/v1` because the router appends `/messages` itself. Use the endpoints assigned to your subscription; changing a region does not grant access to it.

Token Plan is restricted to permitted coding-tool use, not general automation scripts or custom application backends. Check remaining Credits in the MiMo console; Camellia does not query subscription Credits or infer them from token counts. MiMo stops service when the subscription quota is exhausted, but Camellia can fail over to another configured route for the same model. Do not configure a pay-as-you-go route for these model IDs unless you explicitly want that paid fallback. The presets do not add speech models or the v2.5 language models scheduled for retirement on October 21, 2026, according to the supplied Token Plan documentation.

Model discovery and validation are separate operations. Validation sends a short inference request, may incur a charge, and is excluded from business usage statistics.

Context limits come from the provider's model catalog when it reports them; discovery does not scrape model documentation. Fetch the catalog and save to update previously added models. A manually configured context window takes precedence over the catalog limit for engine configuration. When several enabled routes expose the same model, Camellia uses the smallest known configured/catalog window. Codex API sessions receive this window, including for built-in model IDs, without changing subscription settings.

The chat context tooltip distinguishes the engine-reported window, a configured window, and the model maximum reported by the provider. Missing limits appear as unknown, not a guessed model maximum. An engine may still impose its own fallback window; that is not evidence of the model's actual maximum. If the provider does not publish a limit, set the context window manually using that endpoint's documented limit. Restart an existing native conversation after changing its engine window.

Camellia's automatic compaction uses the latest native input-token usage (including cached input) and engine-reported window for the current session when available, with an 85% threshold. Missing or invalidated usage falls back to a character-based estimate; changing model, connection, or configured window invalidates the saved usage. Replayed history is estimated against the token window rather than a fixed 220,000-character cutoff. Individual new messages still have a separate 200,000-character size guard. Automatic compaction records its reason, usage source, window, and available estimates in the application log and saved compaction notice. Native engines may also compact independently.

DSH exposes the pool as the **API route pool** provider. Claude and the API modes of Codex, Kimi, and Antigravity read their model menus from the shared pool.

### Google Gemini API

Choose **Google Gemini API**, add an API key from [Google AI Studio](https://aistudio.google.com/apikey), fetch models, and validate the model you plan to use. The preset uses `https://generativelanguage.googleapis.com/v1beta/openai` with bearer-key authentication, as documented in Google's [OpenAI compatibility guide](https://ai.google.dev/gemini-api/docs/openai).

The Gemini API uses separately billed API keys. To use Google account subscription access with Antigravity, select the Google connection described below. Other engines can use the Gemini API provider when the model supports their tool and protocol requirements.

For Gemini tools, the router retains Google's opaque thought signatures alongside tool IDs so harnesses can resume even when they discard provider-specific extension fields. The signature cache lives next to the route configuration as `ollama-proxy.json.gemini-tools.jsonl`. Preserve it with conversation data when migrating a profile.

### Several accounts of one provider

Kimi and ChatGPT support **several signed-in accounts at the same time**. In **Settings → Engine Settings → Kimi Code** or **Codex CLI**, each account appears as a row in the engine's account list. **Add another account** fills in a new row and selects it, then **Sign in** connects that account; the other accounts keep their own credentials, models and quota. The radio button on a row makes that account the one new conversations start on, the label field names it (useful for several Kimi accounts), and **×** removes an added account together with its directory. The first account is only signed out, never deleted.

Quota steers the choice the same way it does for API keys. A Kimi window or Codex rate-limit window that is fully used marks that account as exhausted, and a **new conversation** then starts on another signed-in account that still has quota. A conversation that already ran on an account keeps it, because its native thread lives in that account's home; its quota error stays visible instead of switching mid-thread. The **Balances & Quotas** page lists one card per signed-in Kimi account.

The Google connection through Antigravity is the exception: the official CLI stores a single Google credential per operating-system user, so it appears as one account and has no **Add another account** action.

### ChatGPT subscription and API routes (Codex)

1. Download **Codex CLI** from Home or **Settings → Runtime**.
2. Open **Settings → Engine Settings → Codex CLI** and choose **API key / third-party API** or **ChatGPT account**. API mode is the initial default when API models are configured; an explicitly saved connection is retained.
3. For API mode, use **Configure API providers & keys** to add a supported endpoint, key and model, then save the connection. ChatGPT sign-in is unnecessary. Camellia adapts its supported API routes to Codex's Responses interface.
4. For account mode, click **Sign in with ChatGPT** and complete the official browser login. Account models and quota load after login; **Refresh account** checks them again. **Cancel sign-in** cancels a pending login, and **Sign out** removes this application's login. **Add another account** starts a second sign-in for the same provider without touching the first one.
5. Start a new Codex session and select a model. API and account models are remembered separately. Joining a shared conversation in API mode uses that conversation's saved API model.

Existing sessions keep their connection. Subscription requests go through the official CLI and use the account's eligible Codex access. They do not enter the shared Key pool or fall back to API billing. The settings page shows account quota windows and reset times when the official account API returns them; these are separate from provider balance charts. Subscription requests are not included in shared provider/key usage statistics.

Every ChatGPT account keeps its own application-owned `CODEX_HOME` under `<app-data>/subscription-accounts/codex/<account>`, so several sign-ins and their native threads stay separate. The first account keeps using the original single-account directory.

Camellia uses the official [app-server interface](https://developers.openai.com/codex/app-server) for authentication, models, approvals, streaming, native history, resume, fork, and cancellation. No personal Codex login or configuration is copied. The child process gets an application-owned `CODEX_HOME`; the parent environment and personal `~/.codex` remain unchanged.

Common settings include command approval policy, sandbox, reasoning effort, and subscription web search. The advanced TOML editor supports native options such as `[mcp_servers]`, and the instructions editor manages Camellia's Codex `AGENTS.md`. In the composer, **Default permissions** follows the saved approval/sandbox combination; **Auto-accept edits**, **Plan only**, and **Allow all** select explicit presets. New conversations use the saved defaults; existing shared conversations retain their selected permission and reasoning settings for each engine.

Shared API mode converts Codex's Responses requests to the router's Chat Completions or Messages endpoints, preserving text, images, streamed reasoning, and function/custom tool calls. OpenAI-hosted web search is disabled for this connection; configure a search MCP server for providers that do not expose that service. Stateful `previous_response_id` and other hosted Responses tools are not supported by the bridge. Tool and image support also depend on the selected model.

### Google subscription (Antigravity)

1. Open **Settings → Engine Settings → Antigravity**, select **Google subscription**, and save.
2. If needed, set **Google connection proxy** to your HTTP/HTTPS proxy and save. An empty value inherits the CLI's environment proxy. Engine downloads retain their separate connection prompt.
3. Click **Sign in with Google**. Camellia downloads the pinned official CLI if missing and opens its interactive sign-in in a terminal. The CLI owns browser authentication and credential storage.
4. Return to Camellia and click **Refresh account**, then choose an account model in the composer. To change accounts, open the sign-in terminal and use `/logout` first.

The official Antigravity CLI keeps one Google credential for the current operating-system user, so Camellia lists exactly one Google account and does not offer **Add another account** for it. Kimi and ChatGPT keep several accounts at once.

This uses the account's eligible Antigravity models and quota, including supported Google AI plans. Eligibility is determined by Google; see [Antigravity plans](https://antigravity.google/docs/plans/). OAuth credentials are never added to the shared Key pool. Authentication, quota, or model errors do not trigger fallback to API billing or another model.

Google sessions stream inside Camellia and support native continuation and cancellation. The official [headless interface](https://antigravity.google/docs/cli/headless/) does not support interactive approvals: actions requiring review are declined. **CLI defaults** follows native permissions, **Accept edits** selects the CLI's edit mode, **Planning** uses its planning mode, and **Allow all** explicitly enables the CLI's permission bypass. Planning is not a filesystem sandbox. Session forks and image input are unavailable in this connection.

Unified settings edit `~/.gemini/antigravity-cli/settings.json` and MCP/skills/plugin files under `~/.gemini/config`. They also affect external Antigravity CLI sessions. Connecting Google resets the CLI's API-provider override after retaining a backup; other native preferences are preserved. Camellia does not automatically enable extra AI credits. The **Use AI credits after the plan quota is exhausted** checkbox is an explicit choice.

Per-turn token counts appear in conversation results. These requests bypass the shared API router, so they do not appear in its provider/key usage charts. The official CLI's `/usage` shows account quota information. Existing API and Google sessions retain their original authentication source when the default connection changes.

### Kimi Code subscription

Kimi Code supports both **Kimi subscription** account sign-in and **Shared API routes**.

1. Open **Settings → Engine Settings → Kimi Code** and choose **Kimi subscription**.
2. Select the site where you registered: **China · kimi.com** or **Global · kimi.ai**, then save.
3. Click **Sign in with Kimi**. The official CLI opens its device authorization page in your browser. If needed, use **Open sign-in page** and the displayed authorization code. **Cancel sign-in** stops a pending attempt.
4. Finish authorization. Camellia verifies the account and loads its models automatically. Select an account model in the composer and start a new conversation. Use **Refresh account** to check access again, **Add another account** to sign in a second Kimi account, or **Sign out** to remove this app's native login.

No API key is needed for account sign-in. The official Kimi CLI manages tokens and token refresh under `<app-data>/kimi-subscription` for the first account and `<app-data>/subscription-accounts/kimi/<account>` for additional ones; Camellia stores public model metadata and quota observations separately. It does not import credentials from your personal `~/.kimi-code`. Existing native sessions keep their original connection, and API and subscription models are remembered separately, including when switching harnesses in a shared conversation. Account changes require idle Kimi work. Authentication, model, or quota failures do not fall back to API billing.

After signing in, a Kimi subscription card appears in **Providers & Keys** and **Usage**. Select it, or choose **View usage and quotas** in the engine settings, to see **Balances & Quotas**. Camellia queries the official CLI for available quota windows, remaining percentages, reset times, and any reported extra-usage wallet. Missing balances and limits are not shown as zero. Queries do not call a model or interrupt an active conversation. Automatic refresh follows **General → Refresh balances automatically** (every 15 minutes); manual refresh is also available. The 30-day chart records observations from this version onward, and failed queries retain the last successful result. Signing out removes the subscription card and its observations.

Subscription eligibility and available models are determined by Kimi. The account panel shows connection status and available models; it does not currently show OAuth quota usage. See the official [membership guide](https://www.kimi.com/help/kimi-code/membership-guide) and [CLI login reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command#kimi-login). Device-flow UI and state transitions are tested with simulated authorization, and authentication rejection/logout are checked against the pinned CLI. A live subscriber authorization has not been performed.

To use a subscription **API key** instead:

1. Open **Settings → Providers & Keys** and add the **Kimi Code subscription** preset.
2. Enter a key from the Kimi Code console. The preset uses `https://api.kimi.com/coding/v1`.
3. Select or enter `kimi-for-coding`, save, and validate the key before starting a session.

Choose **Shared API routes** for the Kimi engine when using this key. This endpoint uses eligible Kimi Code subscription quota. The separate **Kimi / Moonshot** preset connects to the pay-as-you-go platform. Benchmark runs always use the selected shared API route, including when chat uses a Kimi subscription login.

## Same-model failover

A canonical model ID groups routes serving the same model and version. Each route maps that ID to the provider's upstream model name.

- Keep different versions and variants, such as Pro and Flash, in separate groups. Treat moving aliases such as `latest` separately.
- Providers and keys are tried in configured order. A successful route remains active for subsequent requests.
- Quota exhaustion, rate limits, invalid credentials, and eligible transient errors can trigger another route in the group.
- Rate-limit cooldowns apply to the affected model. Invalid credentials block the key until it is replaced or reset.
- For providers with an account API, the router also reads reported quota windows and balances. A fully used window removes the key from rotation. For balance-only accounts, all returned available balances must be known and non-positive to skip the key; a missing amount is not zero, and an empty add-on wallet does not override an available subscription window. A successful recovery reading returns the key to eligibility and clears quota-specific cooldowns, not authentication or network blocks. The cadence follows **General → Balance and quota refresh interval**. Failed checks preserve the last successful timestamp; its routing verdict expires after three refresh intervals (at least 10 minutes). Replacing credentials or changing endpoints invalidates their readings. **Reset cooldown** overrides the verdict until the next refresh.
- Retry timing respects applicable upstream retry hints.
- Exhausting a group returns an error; it does not select another model.
- Once content has started, the request is not replayed automatically. Interrupted streams are reported as errors.

The router bridges OpenAI Chat Completions and Anthropic Messages for text, images, streaming, and common tool calls. Provider-specific content blocks and tools are not guaranteed to work across protocols.

## Benchmark

### Run modes

- **5-minute preview** is the default when opening the page. It always selects the built-in `quick` suite (three fixed coding tasks), one attempt per engine and 250K reported tokens per attempt. Each engine's three tasks share 270 seconds from run creation. A slower task can use more of this allowance; there is no shorter fixed per-task cutoff. At 270 seconds active agents stop and unstarted work is marked `skipped`, leaving 30 seconds for final checks and cleanup. The runner enforces these choices even if a caller supplies stale selections. Its whole-run deadline is 300 seconds from run creation, including startup and verification. At that deadline it aborts remaining work and API scopes; process cleanup can take a few extra seconds. Required engine downloads happen before a run can start. Slow API responses can leave insufficient evidence. It previews coding and tool use only.
- **Full library** selects all seven built-in tasks, all 1,000 DS-1000 problems, or all 65 SciCode test problems. It has no five-minute deadline. Time/check allowances and token ceilings appear before starting; these are not duration or cost predictions. Keep Camellia open and the computer awake. Every completed attempt is saved; closing Camellia cancels the run and does not resume billable work automatically.
- **Custom sample** retains the available sample sizes, repeats and manual limits. It has no whole-run time deadline.

The results update after each evaluated attempt. `observedCheckScore` and `observedPassRate` describe evaluated attempts only, and the UI labels them **Preliminary** with completed/expected counts until the entire engine queue finishes. `checkScore` and `score` remain final-only fields in exported reports. Pending, skipped and user-cancelled work have no score; started attempts that time out earn zero. A small number of completed tasks is not a reliable ranking, particularly when engines have reached different questions. Historical reports keep their original limits under **Run details**, while a new page defaults to the bounded preview. Expand **Limits & scoring** to adjust budgets and read the grading rules.

New trial details include the time allowance available when the engine starts, request durations, tool activity, and the last activity plus in-flight request count at timeout. The execution timeline retains the latest 80 events. Changed files and available partial agent output are captured before cleanup even after a timeout, so a slow provider response can be distinguished from unfinished tool work. These diagnostics do not change the grading rules. See the [preview timeout investigation](benchmark-preview-timeouts-2026-09-16.md) for the reproduced issue and live validation.

The [benchmark selection assessment](design/benchmark-modes.md) describes the separate capabilities and runtime requirements of OCRBench, MMMU-Pro Vision, BEAM (1M), and DeepSWE; these four are not yet selectable.

### Libraries and scoring

Open **Home → Benchmark** (also available in the Engine menu). Configure and validate a tool-capable API model in Providers & Keys, then select the model and provider on the benchmark page. All five API runtimes must be installed; missing runtimes have individual Download buttons. Antigravity uses its SDK here even if your chat connection uses a Google subscription.

Select a **Question library** before choosing the task set:

| Library | Available questions | Task sets |
| --- | --- | --- |
| Camellia built-in | 7 integration tasks | Quick check (3) or Standard (7) |
| [DS-1000](https://github.com/xlang-ai/DS-1000) | 1,000 official Python data-science problems | Fixed samples of 3, 6, 12, or all 1,000 |
| [SciCode](https://github.com/scicode-bench/SciCode) | 65 main problems from the official test split | Fixed samples of 3, 6, 12, or all 65 |

External libraries have a **Prepare library** button. Preparation uses the saved direct/proxy download settings, verifies the data's SHA-256 hashes, and installs Python 3.10.21 and locked dependencies under `<app-data>/benchmark-libraries/`. System Python and personal packages are not modified. SciCode downloads a 1.05 GB HDF5 file in addition to its questions and scientific packages; DS-1000 installs its seven libraries and supporting packages. A failed download can be retried, and preparation never calls a model API. Only prepared libraries can start a run. Windows x64 and macOS ARM64 have platform-specific Python installers; Windows execution is tested locally, while macOS execution still requires its native validation job.

Sample order is deterministic; smaller samples are prefixes of larger ones. DS-1000 uses `camellia-sample-1` and rotates through its seven library categories before selecting a second question from any category. SciCode uses `camellia-sample-2-known-issues-last`: #15 and #46 come last, outside the short samples. #15 omits the coefficient of a physical constant in its original prompt; #46 can reject mathematically equivalent Monte Carlo sampling rules. The full 65-question split keeps both, with the original checks, raw scores and explicit limitation notices. Every engine receives the same ordered questions. Old reports retain their question IDs and sample version. The complete DS-1000 split means 5,000 attempts with one repeat, so inspect the attempt count and token budget before running it. Large result tables show 25 tasks per page.

| Option | Behavior |
| --- | --- |
| 5-minute preview | Fixed Quick check, one repeat; each engine's three tasks share 270 seconds; 300-second whole-run deadline |
| Full library | Every question in the selected library; no whole-run time deadline |
| Quick check | 3 tasks: basic text formatting with public self-tests, transaction reconciliation, multi-file invoice calculation |
| Standard | 7 tasks: adds Unicode normalization, interval merging, retry logic, and configuration tracing |
| Attempts per task | 1 or 3 independent attempts; every attempt counts, with no best-of selection |
| Check score (primary) | Average each attempt's passed checks divided by its total checks, then multiply by 100; every task and repeat has equal weight |
| Full-task pass rate | Fully passed attempts divided by all completed attempts, multiplied by 100; a full task pass requires every check |
| Failure | Partially correct outputs earn check credit; runtime/API errors, per-task limits, and timeouts earn zero |
| Grader error | Test-environment failures invalidate the attempt and the engine's final scores; they are not counted as incorrect solutions |
| Stop / interruption | Unevaluated tasks remain pending; an incomplete engine has no final score |

A Quick check with one attempt executes 15 trials. Standard with three attempts executes 90. All five engines run in parallel, each processing its own task and repeat queue sequentially. A faster engine advances without waiting for slower engines. Every trial has a fresh temporary workspace and profile. They use Claude's stream-json interface, Codex app-server, DSH's shipped headless profile, Kimi ACP, and Antigravity SDK over ACP. Personal settings and external MCP servers are excluded. Native tool sets and reasoning defaults remain different, so this evaluates the shipped integrations with those defaults. Fresh directories are not an operating-system security sandbox.

The per-task token allowance and a model's **single-response output limit** are different. DSH uses its pinned native default of **32,768 output tokens per response**, including reasoning. The earlier Camellia adapter incorrectly imposed 8,192. A response can reach its output cap while the task still has time and tokens remaining. New reports record API stop reasons and distinguish **Output limit** from network errors and task timeouts. Auxiliary title generation is kept separate from the agent response when diagnosing the exit. Historical scores are retained; reports without stop metadata cannot be conclusively reclassified.

For example, an attempt passing 11 of 12 checks earns **91.7 check points** and displays **Partial**. With two other fully passed tasks, the engine's check score is **97.2**, and its full-task pass rate is **66.7%**. Aggregation uses the unrounded fractions; adding more checks to one task does not give it extra weight. Checks that could not execute stay in that task's denominator. Check scores describe success on the supplied checks, including required input preservation; they are not a measure of how important the remaining failures are.

Built-in code tasks use an independent Node checker with restricted filesystem access; output tasks are compared with expected JSON and required input files are checked for changes. External libraries use the official Python checks in fresh processes, after the agent finishes. Expected answers and test programs are not copied to the candidate workspace or included in model prompts. Python subprocesses and native agents run locally with the current user's permissions; fresh directories and isolated Python imports are not an OS sandbox.

Task instructions forbid looking up hidden benchmark tests, expected targets and reference solutions locally or online, including in Camellia's library cache. This instruction is not enforced by an OS filesystem or network sandbox. Inspect recorded artifacts for such access before treating a result as a valid comparison.

DS-1000 asks for a solution fragment in `solution.py`. The adapter runs the original `test_execution` loop in order, retaining shared setup and random state, then runs the official `test_string` constraint check where present. SciCode includes scientific background and every subproblem's public instructions; the agent implements all requested functions together in `solution.py`. Cases within each subproblem share a process and namespace in their official order; different subproblems start fresh. Failures are recorded per case so later checks can still earn partial credit. The official numerical targets and assertion tolerances stay unchanged. The three helper steps supplied by upstream are included as starter code and do not earn points. Each official test-case block earns one check; nested assertions are not counted separately. The SciCode validation split is used only by developer conformance tests, not included in the selectable 65-problem test split.

These **Camellia Bench v1** scores use file-editing agents, custom limits, fixed samples, and partial credit. They are not official DS-1000/SciCode leaderboard scores. Compare the same question IDs, suite hash, dataset and Python environment versions, provider, upstream model version, runtime versions, limits, and execution mode. Parallel runs share local resources and provider rate limits, which can affect latency and errors. Reports record the execution mode and concurrency; older reports without this field display as sequential. Per-engine durations sum that engine's trials and overlap with other engines' durations. Three attempts help expose variation but are not a statistical significance test.

In full-library and custom modes, the default **Recommended** time limit follows the selected library: **5 minutes** per trial for built-in tasks, **10 minutes** for DS-1000, and **30 minutes** for SciCode. A manual selection stays selected when switching libraries; the UI offers limits up to **60 minutes**. All engines use the same selected limit, and reports preserve the actual limit used, including for older runs. This gives multi-step research tasks more time to implement and self-test their solutions; it does not guarantee completion.

**Tokens per task attempt** is the primary token control: **250,000 for built-in tasks, 500,000 for DS-1000, and 1 million for SciCode** by default. It is adjustable up to **5 million**. Every engine, task and repeat receives a fresh allowance. Reaching the limit stops that attempt with **Limit reached** and allows the other engines and queued tasks to continue. Recommendations follow the selected library; manual choices stay selected when switching libraries or changing the number of tasks or repeats.

The **Optional whole-run token cap** is **off by default**. It can be explicitly enabled with a value from 1M to 1B in the UI. This shared cap stops the entire run when reached. The setup summary always shows the per-attempt cap and the sum of all independent task allowances, making the possible usage visible before starting. The sum is informational and is not an additional stop condition. These are usage ceilings, not consumption or cost estimates.

Each trial is still capped at 40 API requests. Increasing time does not change token or request limits. Requests already in flight may exceed a token limit; providers that omit usage are labeled as unreported, and only request/time limits constrain those calls. Input/output tokens are measured at the shared router, so concurrent chat traffic is excluded from benchmark totals. Benchmark requests still appear in the normal Usage page. Reports record `maxTokensPerTask` and `tokenBudget` (`null` when the whole-run cap is disabled). Existing reports keep their original limits. Neither changing limits nor restarting the app starts a benchmark.

Scientific verification has an additional 30-second limit per check and 2-minute limit per task after the agent finishes. Remaining checks after that limit are marked unevaluated and stay in the denominator. **Stop run** also terminates a running Python verifier. These limits may be too short for some expensive research computations and are recorded in the report.

The selected provider, model mapping, and endpoints are pinned. Key failover stays within that provider and model; it cannot switch to another provider. Stop a run before editing API routes. **Stop run** terminates every active harness and closes all its scoped API connections. When enabled, the optional whole-run token cap is shared across engines; reaching it stops all active trials and prevents queued trials from starting. A per-task limit affects only that trial. The run remains busy until all workers finish cleanup and usage accounting. Closing the application cancels the run; unfinished reports are marked interrupted after a restart and never resume automatically.

Reports are saved under the application's `benchmarks/` data directory after each trial. The latest 30 appear in Run history. **Export JSON** includes suite/version information, limits, per-engine scores, per-trial usage, errors, and bounded snippets of changed files and engine output, without provider API keys. Temporary trial workspaces are removed after grading; a cleanup failure is recorded in the report.

External reports also store `library` provenance (source URL, revision, split, data hashes, Python/environment version, adapter version, background setting and sampling method) and ordered public `tasks` metadata. This keeps historical task labels readable without downloading the library again. Reference solutions and complete checker code are excluded from report metadata. Licenses and adapter changes are recorded in `src/benchmark/licenses/NOTICE.md`.

### Investigating a failure

Click a task result to see its check score, independent check count, failed case number, arguments, expected value, and actual value. Non-ASCII characters are escaped, so differences such as `"a\u1ab0b"` remain visible. Function errors, changed input files, malformed JSON, and checks that could not execute have separate diagnostics. Counts such as **11/12 checks passed** earn partial check credit; the attempt counts as fully passed only when every check passes. The engine's own completion message is shown separately under **Engine reply and log**.

For code failures, reproduce the failed case from the saved files and improve the implementation or harness self-checking. For API errors, check model access, key permissions, quota, and connectivity. For a timeout, compare all five engines with the same revised limit in a new run. Keep the original report, and use the same tasks and configuration for subsequent comparisons; do not choose only successful retries as the score. Diagnostic results are not sent back to the agent during scored attempts.

Reports identify shared failed cases across at least three distinct engines and display known task limitations. Scientific failures distinguish assertion mismatches, exceptions, timeout and unevaluated cases, with bounded output and source locations. These notices do not award points or change historical scores. Every scientific attempt retains its complete `solution.py` (within the grader's 1 MiB limit), ahead of scratch files, for offline inspection and regrading. New snapshots also record a SHA-256 hash.

Scientific self-tests use the prepared interpreter with `-E -s -X utf8`, allowing workspace imports while ignoring Python environment overrides and user site packages. Numerical libraries use one thread per process. The separate grader still uses `-I`. Agents are instructed to solve from the supplied files and not retrieve external benchmark tests or reference solutions; this is a prompt rule, not an operating-system network restriction.

New reports record the checker version and check diagnostics. Check scores can also be calculated from older saved check counts without another model call. A historical full pass counts as 100; a historical failed attempt without check counts remains unknown, so its engine's check score is unavailable. The original full-task pass rate remains available. JSON exports include per-trial and per-engine `checkScore`, the original per-engine `score` (full-task pass rate), and `checkScoreMethod: "mean-trial-check-fraction-v1"`. The saved file changes can still be inspected or replayed offline. Compare checker versions and score methods along with the suite hash when reviewing runs.

SciCode checks imports used by the official tests and the required numerical-target keys before any engine starts. Its official comparison helpers are bundled with the checker. If trusted test preparation fails during grading, the result is **Grader error**, with no valid attempt score or final engine scores. Candidate-code errors and verification timeouts still count against the checks. Grader versions are tracked separately from installed environment versions, so a checker fix does not force a dataset download.

### Recheck saved answers

After a checker fix, run this command from a source checkout to evaluate captured external-library answers in a completed or stopped report without calling a model:

```sh
node scripts/regrade-benchmark.cjs "path/to/benchmarks/run-id.json" --write
```

Omit `--write` to preview the results. The original library revision, data hashes, and Python environment must still be installed next to the reports. Rechecking requires a complete saved `solution.py` for each previously graded attempt. It preserves prompts, model outputs, API usage, original run times, and unexecuted attempts. Before writing, it backs up the original report under `benchmarks/regrade-backups/` and records the previous verdicts, checker versions, and recheck time in the report. The results page labels rechecked reports. Reload the report or restart Camellia after updating a file externally.

## Settings pages

| Page | Purpose |
| --- | --- |
| Providers & Keys | Endpoints, credentials, model catalogs, validation, and route order |
| Usage | Request and token filters, trends, detailed records, and CSV export |
| Balances & Quotas | Account balances, subscription windows, reset times, and observed trends |
| Engine Settings | DSH's native panel, and common or advanced Claude/Codex/Kimi/Antigravity configuration |
| Runtime | Optional downloads for each engine, installed versions, paths, progress, and retries |
| General | Interface language, theme, automatic balance refresh, application data, and logs |

Common engine options have dedicated controls. Other native options are available through advanced configuration editors.

### Global CLI configuration

Saving DSH, Claude, or Kimi settings updates global CLI files and can affect other CLI sessions. The settings page displays the actual paths. Codex and Antigravity SDK settings stay inside the application data directory. Antigravity Google settings affect its global CLI configuration as described above.

| Engine | Managed global files by default |
| --- | --- |
| DSH | `~/.dsh/settings.yaml` |
| Claude | `~/.claude/settings.json`, the `mcpServers` section of `~/.claude.json`, and `~/.claude/CLAUDE.md` |
| Kimi | `~/.kimi-code/config.toml`, `mcp.json`, and `tui.toml` |

Before the first managed overwrite of an existing file, Camellia keeps a sibling `.workbench.bak` backup. Later saves preserve it. Claude MCP edits preserve account fields outside `mcpServers`.

DSH native controls save immediately. Claude and Kimi use **Save engine settings**. Project-level configuration continues to follow each engine's precedence rules.

### Optional engine downloads

The base installation contains the workbench and shared Node.js/npm installer tools. Claude, Codex, DSH, Kimi, and Antigravity are separate optional downloads. Use **Download & open** on the home screen or **Download** for the chosen engine under **Runtime**. The other engines remain uninstalled. Download failures can be retried from the same page.

Opening settings does not download an engine. DSH's native panel shows a download link until DSH is installed; the other engines' settings can be edited before installation. Engine downloads go to `<app-data>/runtimes` and are reused across launches. Antigravity downloads its CLI for Google mode, or dedicated Python and SDK for API mode. Initial downloads require a network connection; later launches reuse local files.

**Download connection.** Settings → Runtime stores the preferred connection and an optional HTTP/HTTPS proxy address for this device. There is no preset proxy address. Before every installation or retry, Camellia asks whether to download directly, use the saved proxy, or open proxy settings. Canceling leaves the engine uninstalled. The selected connection covers npm packages and Antigravity's Python installer, Python distribution, and SDK wheels. It does not change model API routing, system proxy settings, or global npm configuration. Direct downloads bypass proxy environment variables inherited by the app. Command-line setup continues to use the calling shell's `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` configuration.

### Antigravity SDK settings

**Engine Settings → Antigravity** provides permission and instruction controls plus a JSON editor for `mcpServers` and `skillsPaths`. The SDK uses `<app-data>/antigravity/settings.json`. Changes apply to the next message.

This SDK connection currently supports text and code, but does not forward image inputs. Camellia rejects image attachments before sending a request. The Gemini provider can still process images through other compatible engines.

- **Default permissions:** file inspection is allowed; modifications and other tools request approval.
- **Auto-accept edits:** file creation and editing are allowed; command execution still requests approval.
- **Plan only:** exposes inspection tools, disables commands, modifications, MCP servers, and subagents.
- **Allow everything:** allows the SDK's tools without individual confirmations.

For example, advanced settings can contain `"skillsPaths": ["/absolute/path/to/skills"]` and `"mcpServers": {"example": {"command": "node", "args": ["/absolute/path/to/server.js"]}}`. Remote MCP servers use `url` and optional `headers` instead of `command` and `args`.

Engine configurations receive a loopback router URL and placeholder credentials. Real provider keys stay in the central pool. CLI sessions using the managed route require Camellia to remain running. Codex uses a generated configuration inside its application-owned API profile; its personal CLI configuration is not changed.

## Usage statistics

Subscription quota (such as Kimi's account-wide windows) appears in **Balances & Quotas** and on the Providers & Keys account cards. It may include activity outside Camellia and is not added to local API totals or attributed to individual models. **API request history** covers business requests passing through the local router, with provider, key, model, and date filters.

- Daily records cover the most recent 90 days; cumulative model totals are retained. CSV export uses the selected filters.
- Successes, failures, and cancellations are recorded separately. Tokens reported by failed attempts remain attributed to the key that incurred them.
- Input tokens include cache reads/writes. Cache-read counts are a subset, not an additional total.
- Missing token counts remain unavailable rather than becoming zero.
- Legacy aggregates are retained without inventing historical model attribution.

Account queries, connection validation, and token-counting requests are not business usage.

## Balances and subscription quotas

Account APIs may include spending from other clients. Their values should not be equated with local request statistics.

| Provider | Information exposed by the account adapter |
| --- | --- |
| DeepSeek | Available balance and returned balance components |
| Kimi / Moonshot | Available balance, cash, and voucher components |
| Kimi Code | Subscription usage windows and reset times |
| OpenCode Go | Subscription usage windows and reset times |
| Command Code / GOAT | Credits and returned subscription, organization, or model limits |
| Ollama Cloud | Returned usage windows and model activity, through an undocumented endpoint |
| Google Gemini API | Local usage; account billing and quotas remain in [Google AI Studio](https://aistudio.google.com/usage) |
| OpenCode Zen and custom endpoints | Local usage only; no account-balance adapter currently implemented |

DeepSeek and Moonshot adapters use documented balance APIs. Kimi Code, OpenCode Go, and Command Code adapters are based on official client or service implementations. Apart from a prior read-only Ollama check, account adapters have been tested against response fixtures rather than individually validated with live subscriptions. Endpoint evidence is recorded in the [provider adapter reference](design/provider-balances.md) (Simplified Chinese).

Balances refresh automatically every 15 minutes by default; **General → Refresh balances automatically** turns the periodic queries off, and **Balance and quota refresh interval** changes the cadence (5, 15, 30 or 60 minutes) for every provider with an account API. One setting covers all of them, because balances and quota windows are read the same way regardless of provider. Manual refresh is also available. The route pool reads the same reported quota on the same cadence to keep exhausted keys out of rotation; turning the periodic queries off also stops that, leaving only failure-driven cooldowns.

Charts retain locally observed values for 30 days, starting when observations are collected. They do not reconstruct earlier history. Multiple keys may share an account, so balances are not summed across cards. Cash, credits, and percentages retain their own units. Failed refreshes preserve the last successful value and its timestamp.

## Workspaces and sessions

Page zoom is shared across the application and saved between launches. Use Ctrl/Cmd + `+` or `−`, Ctrl/Cmd + mouse wheel, or the View menu to adjust it; Ctrl/Cmd + `0` resets it. Home, conversations, settings and native DSH use the same saved scale; the embedded DSH settings panel renders one zoom step finer so its density matches the surrounding settings. The first upgrade adopts the last selected page's existing zoom when available.

All five engines share a sidebar with pinned sessions, folder workspaces, and standalone conversations. Adding a workspace registers a local folder. Its `+` action creates a conversation in that folder; the top-level action starts a standalone conversation. Shared conversations retain their execution directory across engine switches.

Archiving the open conversation continues at its neighbor in the same workspace, preferring the row below and then the row above. Once a workspace has no conversation left, its new-session page opens in that workspace; standalone conversations follow the same rule and fall back to a standalone draft. Archiving another conversation keeps the current one open. Restore or permanently delete archived conversations from Settings → Archived.

| Operation | Shared conversations |
| --- | --- |
| Workspace and standalone sessions | Supported across five engines |
| Concurrent conversations and goals | Supported, including multiple conversations on the same harness |
| Change harness while working | Stop the response or pause the goal first; other conversations keep working |
| Pin, rename, archive, fork, and resume | Supported; shared forks copy context into a new logical conversation |
| Change execution directory | Start a new conversation in the target folder |
| Remove a workspace | Conversations become standalone and retain their execution directory; files remain |

**General → Shared conversations** defaults to direct continuation, with switch reminders and origin labels disabled. Markdown mode asks the previous engine to generate a handoff file and automatically creates a native session in the target engine. **Switch options** overrides this per switch. Both modes keep the same shared conversation. Handoffs use model quota and can add latency, input tokens, or summary omissions. Native caches, internal reasoning and running tool processes cannot transfer. Permission and reasoning controls remain engine-specific.

The sidebar indicates background work and pending approvals. Opening another conversation restores its stream, draft, model and goal; stop and approval actions remain scoped to that conversation. Conversations in the same workspace still share its files, and concurrent API requests share provider limits.

New conversations are named automatically from their first message. Naming tries the conversation's own model first, then the workbench default model, then up to one other model with a configured route; account-only models are skipped because no route can reach them. The generated title is short, keeps the message's language, and appears in the header and sidebar as soon as it is ready; renaming a conversation always wins over the automatic title. Naming is advisory: it runs at the same time as the reply, never blocks or fails the first turn, shares no history with the conversation, and never starts a route cooldown or counts as a failed request in **Usage**. When every candidate is unavailable the conversation keeps `New session` and the reason is written to the log.

## Data locations

The application data directory is `%APPDATA%/dsh-desktop` on Windows and `~/Library/Application Support/dsh-desktop` on macOS. In the table below, `<app-data>` refers to that directory and `~` refers to the user's home directory (`%USERPROFILE%` on Windows).

| Default path | Contents |
| --- | --- |
| `<app-data>` | Application preferences, workspace metadata, observation cache, and logs |
| `<app-data>/conversations` | Shared metadata, full public conversation records, `goals/<id>.json` and `handoffs/*.md`; preserve native engine state too when migrating |
| `<app-data>/dsh-chat` | DSH ACP configuration and native shared-chat sessions; `dsh-chat-history` contains the display cache |
| `~/.dsh` | DSH configuration and history; `ollama-proxy.json` contains the shared route pool, keys, and usage records |
| `~/.claude` | Claude configuration and native history; MCP settings also use `~/.claude.json` |
| `~/.kimi-code` | Centrally managed Kimi global configuration |
| `<app-data>/codex` | Editable `config.toml`, `AGENTS.md`, and public account metadata; `api/` and `subscription/` contain separate generated configs and native thread/auth state |
| `<app-data>/codex-history` | Codex display history cache; preserve native thread directories too when migrating |
| `<app-data>/kimi-code` | Kimi API runtime configuration and native history; `kimi-history` is a sibling display-cache directory shared by both connections |
| `<app-data>/kimi-subscription` | Kimi subscription configuration, official CLI credentials and native history, plus public account/model metadata |
| `<app-data>/antigravity` | SDK settings and native conversation state; `antigravity-history` is a sibling display-cache directory |
| `<app-data>/runtimes` | Automatically installed runtimes; source runs prefer the repository's `runtimes/` |

`DSH_HOME`, `CLAUDE_CONFIG_DIR`, and `KIMI_CODE_HOME` can change engine configuration locations. The settings interface shows effective paths.

The `dsh-desktop` data directory and original application identity are retained for compatibility. Existing sessions, settings, and browser data remain available after renaming. Explicit application-data directories are preserved.

Provider keys are stored in local configuration files, not a system credential vault. The UI and status responses mask them. Exclude these files from public repositories and shared diagnostic bundles.

## Troubleshooting

**Runtime installation failed.** Retry in Settings → Runtime. From a source checkout, use `npm run setup:runtimes -- kimi` (replace `kimi` with the desired engine). Initial installation needs package-registry access; Antigravity additionally downloads managed Python from GitHub and SDK wheels from PyPI. `npm run setup:antigravity` prepares only that engine. Managed installation does not add global npm or Python packages.

**DSH takes longer to open.** Its web backend initializes plugins and assembles frontend resources before the page is ready. First use can also initialize runtime module links. Later visits in the same application process reuse the backend. Settings → General provides access to startup logs.

**Running the portable build.** Extract the entire ZIP before opening `Camellia.exe`, and keep the extracted files together. Later launches run directly from that folder.

**A catalog model fails to respond.** Validate the key against that model and check its upstream mapping, protocol, account entitlement, and quota. Catalog visibility alone does not guarantee inference access.
