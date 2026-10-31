'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { codexTextSpec } = require('./codex-text-policy');
const { antigravitySpawnSpec } = require('../antigravity');
const { isolatedEnvironment } = require('../isolated-environment');
const { readAntigravityNativeInventory } = require('./antigravity-history-inventory');
const { ClaudeHistory } = require('../claude-history');
const { accountHome } = require('../subscription-accounts');
const { processJobs, SUPPORTED_PLATFORMS } = require('./process-jobs');
const { WindowsJobJournal } = require('./windows-job-journal');
const { CONNECTIONS, bindingFingerprint, evaluateCapability } = require('./capabilities');
const { readCodexNativeHistories } = require('./codex-history-inventory');
const { readJson, readRecoverableJson, writeJson } = require('../../shared/json-store');
const { kimiCredentialFile, googleDiscussionSpec, extraTextSpec, createTextSession, extraDiscussionDrivers } = require('./text-runtimes');
const { nativeToolSpec } = require('./tool-runtimes');

const UUID = /^[0-9a-f-]{36}$/;
const VERIFY_NOTICE = 'Verify this connection once with two short messages. This uses model quota.';
const RUNTIME_CHANGED = 'The harness runtime changed during verification. Refresh models and try again.';
function runtimeIdentity(runtime) {
  if (!runtime) return null;
  let stamp = null;
  if (runtime.file) {
    try { const stat = fs.statSync(runtime.file); stamp = [stat.size, stat.mtimeMs, stat.ctimeMs]; }
    catch { /* discovery and launch also check whether the executable exists */ }
  }
  return { version: runtime.version || 'unknown', file: runtime.file || null,
    dir: runtime.dir || null, packages: runtime.packages || null, stamp };
}
function managedDir(root, ...parts) {
  const dir = path.resolve(root, ...parts), relative = path.relative(root, dir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid discussion storage path');
  for (let cursor = dir; cursor !== path.dirname(root); cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Linked discussion directories are not supported');
  }
  fs.mkdirSync(dir, { recursive: true }); return dir;
}

// Production policies: managed native homes, exact model/account/route, and
// Platform-native stop confirmation. Verification runs two tiny real turns in a
// disposable member session. Successful exact-binding/runtime results survive
// restarts; reading them never sends verification or user input.
class DiscussionProduction {
  constructor({ dataDir, registry, codex, antigravity, runtimes, getRouter, getCatalog, refreshKimi, refreshGrok, getNativeConfig = () => ({}), log = () => {}, node = () => process.execPath, environment = () => process.env, platform = process.platform }) {
    Object.assign(this, { dataDir, registry, codex, antigravity, runtimes, getRouter, getCatalog, refreshKimi, refreshGrok, log, node, environment });
    this.getNativeConfig = getNativeConfig;
    this.platform = platform;
    this.jobs = SUPPORTED_PLATFORMS.includes(platform) ? processJobs(platform) : null;
    this.root = path.join(dataDir, 'discussions'); this.activities = new Map(); this.checks = new Map(); this.closing = false;
    this.verificationFile = path.join(this.root, 'verification-cache', 'connections.json');
    const saved = readRecoverableJson(this.verificationFile, null, error => this.log(error.message),
      value => value === null || value?.version === 1 && value.entries && typeof value.entries === 'object' && !Array.isArray(value.entries));
    this.verified = Object.fromEntries(Object.entries(saved?.entries || {}).filter(([key, row]) => row?.binding && row.evidence
      && Number.isFinite(row.verifiedAt) && key === bindingFingerprint(row.binding)).slice(-256));
    const Journal = this.jobs?.Journal || WindowsJobJournal;
    this.journal = new Journal({ dir: path.join(this.root, this.jobs?.directory || 'windows-jobs') });
    this.checkJournal = new Journal({ dir: path.join(this.root, 'verification-jobs') });
    this.extraDrivers = extraDiscussionDrivers({ root: this.root, runtimes, registry });
  }
  nativeHomes(engine = 'codex') {
    const dir = path.join(this.root, engine === 'codex' ? 'native' : 'native-' + engine);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map(name => {
      if (!UUID.test(name)) throw new Error('Invalid managed native directory');
      const home = path.join(dir, name); if (fs.lstatSync(home).isSymbolicLink()) throw new Error('Linked native directory');
      return home;
    });
  }
  inventory() {
    // Live homes are owned by the tracked launch, driver pool and ownership
    // lease. Re-reading their changing SQLite/WAL files would make another
    // member's parallel reply fail. Inactive homes are scanned in full before
    // reservation; stop confirmation precedes removing a live launch.
    const live = new Set([...this.activities.values()].map(row => row.home).filter(Boolean));
    const homes = this.nativeHomes().filter(home => !live.has(home));
    return { scope: 'managed-discussion-homes', histories: homes.length ? readCodexNativeHistories(homes) : [], activities: [],
      antigravity: this.nativeStorage() };
  }
  nativeStorage() {
    const live = [...this.activities.values()].filter(row => row.profile?.engine === 'antigravity' && row.home);
    const homes = this.nativeHomes('antigravity').filter(home => !live.some(row => row.home === home))
      .map(home => ({ home, cliDataDir: path.join(home, 'profile/.gemini/antigravity-cli') }));
    const result = readAntigravityNativeInventory({ homes, cliDataDirs: [], sdkSaveDirs: [] });
    // Verified after the native prepare handshake, before any model input.
    // The tool-free SDK cannot create/fork other native sessions during a turn.
    for (const row of live) if (row.storageSnapshot) {
      result.bridges.push(...row.storageSnapshot.bridges); result.histories.push(...row.storageSnapshot.histories);
    }
    return result;
  }
  ordinaryStorageSeparate({ nativeId, owners }) {
    if (!this.antigravity) return false;
    const storage = owners.map(owner => {
      const saved = owner.nativeStorage || owners.find(row => row.nativeId === owner.nativeId && row.nativeStorage)?.nativeStorage;
      if (saved) return saved;
      // During open(), the scoped process may know its bridge ID before the
      // scheduler commits nativeStorage. Its private launch directory is still
      // authoritative; never infer such a path for an untracked activity.
      const activity = [...this.activities.values()].find(row => row.identity.runtimeId === owner.runtimeId
        && row.profile?.engine === 'antigravity' && row.home);
      if (activity && activity.profile.connection === 'subscription' && /^agy-[0-9a-f-]{36}$/i.test(owner.nativeId))
        return { connection: 'subscription', storageDir: path.join(activity.home, 'profile/.gemini/antigravity-cli/conversations') };
      return activity && UUID.test(owner.nativeId) ? { connection: 'api', storageDir: path.join(activity.home, 'sessions', owner.nativeId, 'native') } : null;
    });
    if (storage.some(value => !value || !['api', 'subscription'].includes(value.connection))) return false;
    const connection = /^agy-[0-9a-f-]{36}$/i.test(nativeId) ? 'subscription' : UUID.test(nativeId) ? 'api' : null;
    if (!connection) return false;
    if (storage.every(value => value.connection !== connection)) return true;
    const canonical = dir => {
      dir = path.resolve(dir);
      for (let cursor = dir; ; cursor = path.dirname(cursor)) {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) return null;
        if (cursor === path.dirname(cursor)) break;
      }
      return dir.toLowerCase();
    };
    const ordinaryPath = this.antigravity.nativeStorageDirectory?.(nativeId)
      || (connection === 'api' ? path.join(this.antigravity.home, 'sessions', nativeId, 'native') : null);
    if (!ordinaryPath) return false;
    const ordinary = canonical(ordinaryPath);
    return Boolean(ordinary) && storage.every(value => {
      if (value.connection !== connection) return true;
      const protectedDir = canonical(value.storageDir);
      return protectedDir && ordinary !== protectedDir;
    });
  }
  runtimeInfo(binding) {
    const manager = this.runtimes();
    // An adapter serves every connection of its engine. Keep the same identity
    // for API/subscription callers and include missing installations explicitly.
    const installed = (CONNECTIONS[binding.engine] || []).map(connection => {
      try { return runtimeIdentity(manager.locate(binding.engine, connection)); }
      catch { return null; }
    });
    return { version: binding.engine === 'antigravity'
      ? 'sdk:' + (installed[0]?.version || 'unavailable') + '/cli:' + (installed[1]?.version || 'unavailable')
      : installed[0]?.version || 'unavailable',
      fingerprint: createHash('sha256').update(JSON.stringify(installed)).digest('hex'),
      policyVersion: binding.engine + (binding.engine === 'antigravity' ? '-discussion-interactive-v2' : '-discussion-tools-v1') };
  }
  mode(binding) {
    return 'native-tools';
  }
  canVerify(binding) {
    if (!CONNECTIONS[binding.engine]?.includes(binding.connection) || !this.registry.get(binding.engine)) return false;
    try { return Boolean(this.runtimes().locate(binding.engine, binding.connection)); }
    catch { return false; }
  }
  canInstall(binding) {
    if (!CONNECTIONS[binding.engine]?.includes(binding.connection) || !this.registry.get(binding.engine)) return false;
    try { return !this.runtimes().locate(binding.engine, binding.connection); }
    catch { return false; }
  }
  runtimeAvailability() {
    return Object.entries(CONNECTIONS).flatMap(([engine, connections]) => connections.map(connection => {
      const binding = { engine, connection };
      return { ...binding, canInstall: this.canInstall(binding) };
    }));
  }
  refresh() {
    if (!SUPPORTED_PLATFORMS.includes(this.platform || process.platform)) return;
    for (const [engine, driver] of Object.entries({ codex: this.codex, antigravity: this.antigravity, ...this.extraDrivers })) {
      const info = this.runtimeInfo({ engine });
      if (!driver) continue;
      if (this.registry.get(engine)) this.registry.updateRuntime(engine, info);
      else this.registry.register({ engine, driver: { ...driver, ensure: driver.ensureSession || driver.ensure }, runtime: info, policy: {
        prepare: input => this.prepare(input), verify: input => this.verifySession(input),
        confirmStopped: input => this.confirmStopped(input),
      } });
      const adapter = this.registry.get(engine);
      for (const row of Object.values(this.verified)) {
        if (row?.binding?.engine !== engine || !evaluateCapability(row.binding, info, row.evidence).available
          || adapter.evidence(row.binding)) continue;
        // Only this main-process cache is reusable, after the same binding,
        // executable and policy checks. Revoked adapters cannot be restored.
        try { this.registry.admit(row.binding, row.evidence); } catch { /* revoked */ }
      }
    }
  }
  reason(binding) {
    let runtime;
    try { runtime = this.runtimes().locate(binding.engine, binding.connection); }
    catch (error) { return error.message; }
    if (!runtime) return 'No harness runtime was found. Install it or set its executable path in Settings, then refresh models.';
    return VERIFY_NOTICE;
  }
  async current(profile) {
    const row = (await this.getCatalog()).find(row => bindingFingerprint(row.binding) === bindingFingerprint(profile));
    if (!row) throw new Error('This model or account changed. Refresh models and add the member again.');
    return row.binding;
  }
  async prepare({ identity, profile, cwd, signal, verification = false, permissionMode = 'ask' }) {
    const record = { identity, job: null, route: null, preparation: null, verification };
    this.activities.set(identity.deliveryId, record);
    record.preparation = (async () => {
      if (this.closing || signal?.aborted) throw new Error('Discussion cancelled');
      await this.current(profile);
      this.refresh();
      if (!this.canVerify(profile)) throw new Error(this.reason(profile));
      const runtime = this.runtimes().locate(profile.engine, profile.connection);
      const info = this.runtimeInfo(profile);
      const home = managedDir(this.root, profile.engine === 'codex' ? 'native' : 'native-' + profile.engine, identity.runtimeId);
      record.home = home; record.profile = profile;
      const expectedWork = path.relative(path.join(this.root, 'work'), cwd);
      if (!expectedWork || expectedWork.startsWith('..') || path.isAbsolute(expectedWork)) throw new Error('Discussion working directory is not managed');
      managedDir(this.root, 'work', expectedWork);
      if (profile.connection === 'subscription' && profile.engine === 'codex') {
        const source = accountHome({ userData: this.dataDir, engine: 'codex', id: profile.accountRef, root: path.join(this.dataDir, 'codex', 'subscription') });
        const file = path.join(source, 'auth.json');
        if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) throw new Error('Refresh this ChatGPT account in Settings before verifying the connection.');
        const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!auth.tokens?.access_token || !auth.tokens?.account_id) throw new Error('This ChatGPT account has no usable local credential. Refresh it in Settings.');
        record.accountId = auth.tokens.account_id;
        const bindingFile = path.join(home, 'discussion-binding.json');
        const expected = { binding: bindingFingerprint(profile), accountId: record.accountId };
        const previous = readJson(bindingFile, null);
        if (fs.existsSync(bindingFile) && !isDeepStrictEqual(previous, expected)) throw new Error('This member belongs to a different ChatGPT login. Add a new member for the current account.');
        if (!previous) writeJson(bindingFile, expected);
        // Use the selected account's current access token, without its refresh
        // credential. Parallel discussion homes must never race to rotate a
        // refresh token owned by ordinary chat. Refresh expired login in Settings.
        const claims = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url').toString());
        if (!Number.isFinite(claims.exp) || claims.exp * 1000 < Date.now() + 120000) throw new Error('Refresh this ChatGPT account in Settings before verifying the connection.');
        const credential = { ...auth, tokens: { ...auth.tokens, refresh_token: '' }, last_refresh: new Date().toISOString() };
        fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(credential), { mode: 0o600 });
      } else if (profile.connection === 'subscription' && profile.engine === 'kimi') {
        const source = accountHome({ userData: this.dataDir, engine: 'kimi', id: profile.accountRef, root: path.join(this.dataDir, 'kimi-subscription') });
        const managed = require('../kimi-session').managedKimiConfig(source);
        const credential = kimiCredentialFile(source, managed);
        let token = readJson(credential, null);
        const refreshBefore = value => Math.max(300, Number(value?.expires_in || 0) / 2) + 120;
        if (token?.expires_at * 1000 < Date.now() + refreshBefore(token) * 1000 && this.refreshKimi) {
          await this.refreshKimi(profile.accountRef); token = readJson(credential, null);
        }
        if (!token?.access_token || !Number.isFinite(token.expires_at) || token.expires_at * 1000 < Date.now() + refreshBefore(token) * 1000) throw new Error('Refresh this Kimi account in Settings before sending.');
        require('../../shared/json-store').writeText(path.join(home, 'config.toml'), require('smol-toml').stringify(managed));
        // Never race the ordinary account's rotating refresh credential.
        record.credential = kimiCredentialFile(home, managed);
        writeJson(record.credential, { ...token, refresh_token: '' });
      } else if (profile.connection === 'subscription' && profile.engine === 'grok') {
        if (this.refreshGrok) await this.refreshGrok(profile.accountRef);
        const source = accountHome({ userData: this.dataDir, engine: 'grok', id: profile.accountRef, root: path.join(this.dataDir, 'grok-subscription') });
        const file = path.join(source, 'auth.json');
        if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) throw new Error('Refresh this Grok account in Settings before verifying the connection.');
        const auth = readJson(file, null);
        if (!auth?.access_token && !auth?.key) throw new Error('This Grok account has no usable local credential. Refresh it in Settings.');
        if (Number.isFinite(auth.expires_at) && auth.expires_at * 1000 < Date.now() + 120000) throw new Error('Refresh this Grok account in Settings before verifying the connection.');
        record.accountId = auth.user_id || auth.userId || '';
        const bindingFile = path.join(home, 'discussion-binding.json');
        const expected = { binding: bindingFingerprint(profile), accountId: record.accountId };
        const previous = readJson(bindingFile, null);
        if (fs.existsSync(bindingFile) && !isDeepStrictEqual(previous, expected) && previous?.binding !== expected.binding) {
          throw new Error('This member belongs to a different Grok login or model. Add a new member for the current account.');
        }
        if (fs.existsSync(bindingFile) && previous?.accountId !== record.accountId) throw new Error('This member belongs to a different Grok login. Add a new member for the current account.');
        if (!previous) writeJson(bindingFile, expected);
        writeJson(path.join(home, 'auth.json'), { ...auth, refresh_token: '' }, { mode: 0o600 });
      } else if (profile.connection === 'api') {
        const account = JSON.parse(profile.accountRef);
        record.route = this.getRouter()?.createScope({ model: profile.model, providerId: account.providerId,
          routeFingerprint: account.route, maxRequests: verification ? 6 : 100, maxTokens: Math.max(4096, profile.contextWindow * (verification ? 2 : 16)),
          toolPolicy: verification && profile.engine === 'grok' ? 'none' : 'preserve' });
        if (!record.route) throw new Error('Enable the configured API route before verifying this connection.');
      }
      record.job = await this.jobs.prepare({ identity, journal: verification ? this.checkJournal : this.journal, signal });
      if (this.closing || signal?.aborted) throw new Error('Discussion cancelled');
      const settings = { model: profile.model, connection: profile.connection,
        permissionMode: profile.engine === 'codex' || profile.engine === 'antigravity' && profile.connection === 'api' ? 'plan' : 'ask', thinkingBudget: profile.thinking || '',
        contextWindow: profile.contextWindow, proxyUrl: '', ...(profile.connection === 'subscription' ? { subscriptionId: profile.accountRef } : {}) };
      let spec;
      if (!verification) {
        settings.permissionMode = permissionMode;
        const inherited = this.environment(), env = isolatedEnvironment(path.join(home, 'profile'), this.node(), inherited);
        if (env.SystemRoot && env.SYSTEMROOT) delete env.SYSTEMROOT;
        // Subscription logins use the resolved subscription proxy rather than
        // the general bridge, whose direct-first attempt can stall Google auth.
        for (const [key, value] of Object.entries(inherited)) if (/^(https?_proxy|all_proxy|no_proxy|CAMELLIA_NETWORK_MODE|CAMELLIA_NETWORK_PROXY|CAMELLIA_SUBSCRIPTION_PROXY)$/i.test(key)) env[key] = value;
        const models = profile.engine === 'antigravity' && profile.connection === 'subscription' ? (await this.antigravity.handlers['account-state']()).models : [];
        spec = nativeToolSpec({ runtime, home, cwd, env, node: this.node(), profile, route: record.route, permissionMode,
          native: this.getNativeConfig(profile.engine, profile.connection), models });
      } else if (profile.engine === 'codex') spec = codexTextSpec({ runtime, home, cwd, ...settings, route: record.route, inherited: this.environment() });
      else {
        const inherited = this.environment(), env = isolatedEnvironment(path.join(home, 'profile'), this.node(), inherited);
        if (env.SystemRoot && env.SYSTEMROOT) delete env.SYSTEMROOT;
        for (const [key, value] of Object.entries(inherited)) if (/^(https?_proxy|all_proxy|no_proxy|CAMELLIA_NETWORK_MODE|CAMELLIA_NETWORK_PROXY|CAMELLIA_SUBSCRIPTION_PROXY)$/i.test(key)) env[key] = value;
        if (profile.engine === 'antigravity') {
          if (profile.connection === 'subscription') {
            const account = await this.antigravity.handlers['account-state']();
            spec = googleDiscussionSpec({ runtime, home, cwd, env, node: this.node(), profile, models: account.models });
            settings.permissionMode = 'default';
          } else spec = { ...antigravitySpawnSpec({ runtime, home, route: record.route, env, executionPolicy: 'tool-free-v1' }), exe: runtime.file, cwd };
        } else spec = extraTextSpec({ runtime, home, cwd, env, node: this.node(), profile, route: record.route });
      }
      spec.env.CAMELLIA_DISCUSSION_HOME = home;
      record.settings = settings;
      return { settings, launch: { spawn: record.job.spawn, buildSpec: ({ runtime: actual }) => {
        if (!actual || actual.file !== runtime.file || actual.version !== runtime.version
          || !isDeepStrictEqual(info, this.runtimeInfo(profile))) throw new Error('Discussion runtime changed');
        return spec;
      } } };
    })();
    return record.preparation;
  }
  async verifySession({ session, profile }) {
    const home = session.spec.env.CAMELLIA_DISCUSSION_HOME;
    const record = [...this.activities.values()].find(item => item.home === home);
    if (!record || !isDeepStrictEqual(record.profile, profile) || session.settings.model !== profile.model
      || session.settings.connection !== profile.connection || session.settings.permissionMode !== record.settings.permissionMode) return false;
    if (profile.engine === 'antigravity') record.storageSnapshot = readAntigravityNativeInventory({
      homes: [{ home, cliDataDir: path.join(home, 'profile/.gemini/antigravity-cli') }], cliDataDirs: [], sdkSaveDirs: [] });
    if (profile.connection === 'subscription' && profile.engine === 'codex') {
      const auth = JSON.parse(fs.readFileSync(path.join(record.home, 'auth.json'), 'utf8'));
      if (auth.tokens?.account_id !== record.accountId) return false;
      const account = await session.client.request('account/read', { refreshToken: false });
      if (account.account?.type !== 'chatgpt') return false;
    }
    if (profile.connection === 'subscription' && profile.engine === 'grok') {
      const auth = readJson(path.join(record.home, 'auth.json'), null);
      if (!auth || (auth.user_id || auth.userId || '') !== record.accountId || session.spec.env.GROK_HOME !== record.home) return false;
    }
    return true;
  }
  async confirmStopped({ identity }) {
    const record = this.activities.get(identity.deliveryId);
    if (!record) return this.jobs.recover({ identity, journal: this.journal });
    try { await record.preparation; } catch { /* partial preparation must drain */ }
    let proof;
    if (record.job) proof = await record.job.stop();
    else {
      const journal = record.verification ? this.checkJournal : this.journal;
      proof = fs.existsSync(journal.paths(identity).recordFile) ? await this.jobs.recover({ identity, journal }) : { ...identity, stopped: true };
    }
    await record.route?.close();
    if (record.profile?.connection === 'subscription' && ['codex', 'grok'].includes(record.profile.engine) && record.home) fs.rmSync(path.join(record.home, 'auth.json'), { force: true });
    if (record.credential) fs.rmSync(record.credential, { force: true });
    this.activities.delete(identity.deliveryId); return proof;
  }
  verify(binding) {
    const key = bindingFingerprint(binding);
    if (this.checks.has(key)) return this.checks.get(key).promise;
    if (this.closing) return Promise.reject(new Error('Discussion cancelled'));
    this.refresh();
    if (!this.canVerify(binding)) return Promise.reject(new Error(this.reason(binding)));
    const adapter = this.registry.get(binding.engine);
    if (evaluateCapability(binding, adapter?.runtime, adapter?.evidence(binding)).available) return Promise.resolve();
    const controller = new AbortController();
    const promise = this.check(binding, controller.signal).finally(() => this.checks.delete(key));
    this.checks.set(key, { promise, controller }); return promise;
  }
  async check(profile, signal) {
    profile = await this.current(profile);
    const info = this.runtimeInfo(profile);
    const assertRuntime = () => { if (!isDeepStrictEqual(info, this.runtimeInfo(profile))) throw new Error(RUNTIME_CHANGED); };
    const runtimeId = randomUUID(), cwd = managedDir(this.root, 'work', runtimeId);
    const code = 'DISCUSSION_' + randomUUID().replaceAll('-', '').slice(0, 12);
    let nativeId = null, supportsImages = ['claude', 'codex', 'grok'].includes(profile.engine);
    for (const prompt of ['Remember this verification code and reply only with it: ' + code, 'Repeat the verification code from the preceding message. Output only the code.']) {
      const identity = { runtimeId, deliveryId: randomUUID(), generation: 1 };
      let session, timer;
      try {
        assertRuntime();
        const prepared = await this.prepare({ identity, profile, cwd, signal, verification: true });
        const spec = prepared.launch.buildSpec({ runtime: this.runtimes().locate(profile.engine, profile.connection) });
        let resolve, reject;
        const result = new Promise((yes, no) => { resolve = yes; reject = no; }); result.catch(() => {});
        session = createTextSession(profile.engine, { gen: 1, name: profile.engine, exe: spec.exe, settings: { ...prepared.settings, cwd }, opts: { sessionId: nativeId }, spec,
          spawn: prepared.launch.spawn, history: new ClaudeHistory(path.join(this.root, 'verification-history')), log: this.log, onSessionId() {},
          onEvent: event => { if (event.type === 'gui:tool' && !(profile.engine === 'antigravity' && profile.connection === 'subscription') || event.type === 'gui:permission') { session.interrupt(); reject(new Error('Unexpected tool activity in connection verification')); } },
          onResult: resolve });
        timer = setTimeout(() => { session.interrupt(); reject(new Error('Connection verification timed out. Refresh the account or check its network connection.')); },
          profile.engine === 'antigravity' && profile.connection === 'subscription' ? 120000 : 60000);
        const abort = () => { session.interrupt(); reject(new Error('Discussion cancelled')); };
        signal.addEventListener('abort', abort, { once: true });
        try {
          session.start(); await (session.ready ||= session.open());
          if (session.promptCapabilities?.image === true) supportsImages = true;
          if (profile.engine === 'antigravity') await session.prepareNativeStorage();
          if (profile.engine === 'antigravity' && profile.connection === 'subscription') {
            // The text-only probe and the production interactive bridge share
            // the native model catalog, not their transport capabilities.
            const capabilities = await session.request('session/camellia_model_capabilities', { sessionId: session.sessionId });
            supportsImages = capabilities.image === true;
          }
          if (!await this.verifySession({ session, profile })) throw new Error('Discussion connection binding could not be verified');
          if (nativeId && session.sessionId !== nativeId) throw new Error('Discussion continuation changed');
          nativeId = session.sessionId;
          if (signal.aborted) throw new Error('Discussion cancelled');
          session.sendUserMessage(prompt, []);
          const reply = await result;
          if (reply.subtype !== 'success' || !String(reply.result).includes(code)) throw new Error(reply.result || 'Connection verification did not preserve the previous message.');
        } finally { signal.removeEventListener('abort', abort); }
      } finally { clearTimeout(timer); try { await session?.shutdown(); } finally { await this.confirmStopped({ identity }); } }
      assertRuntime();
    }
    await this.current(profile);
    assertRuntime();
    this.refresh();
    const evidence = { kind: 'real', reference: 'online-two-turns/' + new Date().toISOString(), bindingFingerprint: bindingFingerprint(profile),
      runtimeVersion: info.version, runtimeFingerprint: info.fingerprint, policyVersion: info.policyVersion, mode: this.mode(profile), supportsImages, checks: Object.fromEntries([
        'isolatedSession', 'pinnedBinding', 'continuation', 'stopConfirmed', 'permissionsRouted', 'workspaceQueue'].map(key => [key, true])) };
    this.registry.admit(profile, evidence);
    this.verified[bindingFingerprint(profile)] = { binding: structuredClone(profile), evidence, verifiedAt: Date.now() };
    this.verified = Object.fromEntries(Object.entries(this.verified).sort((a, b) => b[1].verifiedAt - a[1].verifiedAt).slice(0, 256));
    try { writeJson(this.verificationFile, { version: 1, entries: this.verified }); }
    catch (error) { this.log('Could not save discussion connection verification: ' + error.message); }
  }
  cancel(key) { this.checks.get(key)?.controller.abort(); }
  async shutdown() {
    this.closing = true;
    for (const check of this.checks.values()) check.controller.abort();
    await Promise.allSettled([...this.checks.values()].map(check => check.promise));
  }
}

module.exports = { DiscussionProduction };
