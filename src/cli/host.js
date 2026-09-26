'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson } = require('../shared/json-store');
const { SharedConversations, ENGINES } = require('../engines/shared-conversations');
const { createRemoteService } = require('../main/remote/service');
const { EmbeddedNetwork } = require('../main/remote/embedded-network');
const { RemoteReadModel } = require('../main/remote/read-model');
const { acquireLock, privateDirectory, networkKey } = require('./private-storage');

function createHeadlessHost({ dataDir, executable, keyFile, hostname = 'camellia-server', networkFactory, driverFactory, root = path.resolve(__dirname, '../..') }) {
  if (typeof hostname !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) throw new Error('Invalid Tailscale hostname');
  const release = acquireLock(dataDir);
  let manager, remote, engines, drivers = {}, router = null, closing = false, commandBusy = false, idleResolve, closePromise;
  const file = path.join(dataDir, 'config.json');
  const routeFile = path.join(dataDir, 'api-routes.json');
  const loadConfig = () => readJson(file, { language: 'zh-CN' });
  const saveConfig = patch => { const config = { ...loadConfig(), ...patch }; writeJson(file, config); return config; };
  const onEvent = (engine, event) => manager?.capture(engine, event);
  const installs = new Map();
  const nativeLogins = new Map();
  const shutdown = async () => {
    manager?.pauseGoals(); manager?.closeGoalTools();
    await remote?.close();
    await Promise.allSettled([...installs.values()].map(entry => entry.promise));
    for (const id of manager?.items.keys() || []) if (manager.busy(id)) await manager.cancel({ sessionId: id });
    const results = await Promise.allSettled(Object.values(drivers).map(driver => driver.shutdown?.()));
    if (results.some(result => result.status === 'rejected')) throw new Error('Engine shutdown failed; data lock retained');
    await router?.stop();
    release();
  };
  try {
    privateDirectory(path.join(dataDir, 'remote'));
    privateDirectory(path.join(dataDir, 'conversations'));
    const config = require('../api/api-router-config');
    const routes = () => config.loadConfig(routeFile);
    const nativeSettings = require('./native-settings').createNativeSettings({ dataDir,
      isBusy: engine => closing || Boolean(manager?.isBusy(engine)) || nativeLogins.has(engine) || installs.get(engine)?.state === 'installing' || engines?.accountBusy?.(engine) === true,
      publish: () => remote?.publish() });
    let supported;
    if (driverFactory) {
      drivers = driverFactory({ dataDir, loadConfig, saveConfig, onEvent });
      supported = Object.keys(drivers);
    } else {
      engines = require('./engine-drivers').createEngineDrivers({ root, dataDir, loadConfig, saveConfig, onEvent, router: routes, nativeSettings,
        isBusy: engine => Boolean(manager?.isBusy(engine)),
        getRoute: () => {
          if (!router?.getState().running) throw new Error('Configure API routes on this server before sending');
          return { baseUrl: router.url, authToken: 'proxy-managed' };
        } });
      drivers = engines.drivers;
      supported = Object.keys(drivers);
    }
    for (const engine of ENGINES) {
      drivers[engine] ||= { settings: () => ({ connection: 'api', permissionMode: 'ask', model: '' }),
        saveSettings: () => { throw new Error(`${engine} is not yet enabled in the server preview`); },
        ensure: () => { throw new Error(`${engine} is not yet enabled in the server preview`); } };
    }
    manager = new SharedConversations({ dir: path.join(dataDir, 'conversations'), loadConfig, saveConfig, drivers,
      prepare: async (engine, settings) => {
        if (closing) throw new Error('Camellia is closing');
        if (!supported.includes(engine)) throw new Error(`${engine} is not yet enabled in the server preview`);
        if (nativeLogins.has(engine)) throw new Error('Finish the native account login before starting this engine');
        if (installs.get(engine)?.state === 'installing') throw new Error('Wait for runtime installation to finish');
        if (!driverFactory) {
          engines.prepare(engine, settings);
          if (settings?.connection === 'subscription') return;
          if (!config.hasRoutes(routes())) throw new Error('Configure API routes in the server data directory before sending');
          if (!router) {
            router = require('../api/api-router').startApiRouter({ configPath: routeFile, quotaCheck: { enabled: false } });
          }
          try { await router.ready; }
          catch (error) { const failed = router; router = null; await failed?.stop(); throw error; }
        }
        if (closing) throw new Error('Camellia is closing');
      },
      conversationModels: (engine, settings) => engines ? engines.models(engine, settings) : config.publicState(routes()).models.map(id => ({ id, name: id, thinking: [] })),
      createGoalBridge: options => require('../engines/goal-tool-bridge').createGoalToolBridge({ ...options, node: process.execPath }),
      onEvent: () => remote?.publish(),
    });
    const create = manager.create.bind(manager);
    manager.remoteEngines = supported;
    manager.create = (engine, ...args) => {
      if (!supported.includes(engine)) throw new Error(`${engine} is not yet enabled in the server preview`);
      return create(engine, ...args);
    };
    const apiImport = require('../main/remote/api-import').createApiImport({ configFile: routeFile,
      journalFile: path.join(dataDir, 'remote', 'api-imports.json'), isBusy: () => closing || commandBusy || manager.isBusy() || Boolean(router?.getState().activeRequests),
      reload: () => router?.reload(), publish: () => remote?.publish() });
    remote = createRemoteService({ dataDir, manager, apiImport, nativeSettings: {
      get: engine => nativeSettings.get(engine),
      save: payload => { if (commandBusy) throw Object.assign(new Error('Local server operation in progress'), { status: 409 }); return nativeSettings.save(payload); },
    },
      preferences: () => ({ product: 'Camellia', host: 'cli-preview', hostname, engines: supported }),
      networkFactory: networkFactory || (options => new EmbeddedNetwork({ ...options,
        directory: path.join(dataDir, 'remote', 'tailnet'), hostname, executable: executable || path.join(root, 'build/runtime-assets/camellia-tailnet'),
        keyProvider: directory => networkKey(directory, { keyFile }),
        openExternal: async () => { throw new Error('Open the login URL shown by network.state in a trusted browser'); } })),
    });
    const reader = new RemoteReadModel(manager);
    return {
      async startTrustedDevices() {
        if (closing || commandBusy) throw new Error('Camellia is busy or closing');
        commandBusy = true;
        try { await remote.startTrustedDevices(); }
        finally { commandBusy = false; idleResolve?.(); idleResolve = null; }
      },
      async command(action, payload = {}) {
        if (closing) return { ok: false, error: 'Camellia is closing' };
        if (commandBusy) return { ok: false, error: 'Please wait for the current operation' };
        commandBusy = true;
        try {
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected an object payload');
          if (action === 'native-settings-get') return { ok: true, result: nativeSettings.get(payload.engine) };
          if (action === 'native-settings-save') return { ok: true, result: nativeSettings.save(payload) };
          if (action === 'runtime-state') return { ok: true, result: engines ? engines.runtimes.state().filter(entry => supported.includes(entry.id)).map(entry => ({ ...entry,
            ...(installs.has(entry.id) ? { operation: installs.get(entry.id).state, error: installs.get(entry.id).error || null } : {}) })) : [] };
          if (action === 'runtime-install') {
            if (!engines || !supported.includes(payload.engine)) throw new Error('Unsupported engine');
            if (manager.isBusy(payload.engine) || nativeLogins.has(payload.engine)) throw new Error('Stop this engine and finish account login before installing its runtime');
            if (payload.connection !== undefined && !['api', 'subscription'].includes(payload.connection)) throw new Error('Invalid runtime connection');
            if (installs.get(payload.engine)?.state === 'installing') return { ok: true, result: { state: 'installing' } };
            const entry = { state: 'installing' };
            installs.set(payload.engine, entry);
            entry.promise = engines.runtimes.ensure(payload.engine, payload.connection || 'api').then(() => { entry.state = 'ready'; }, () => { entry.state = 'failed'; entry.error = 'Runtime installation failed; check network and retry'; });
            return { ok: true, result: { state: 'installing' } };
          }
          if (action === 'account') {
            if (!engines) throw new Error('Account service unavailable');
            if (nativeLogins.has(payload.engine)) throw new Error('Finish native account login first');
            return { ok: true, result: await engines.account(payload.engine, payload.action) };
          }
          if (action === 'native-login') {
            if (!engines) throw new Error('Account service unavailable');
            if (nativeLogins.has(payload.engine) || installs.get(payload.engine)?.state === 'installing') throw new Error('Native login or runtime installation is already in progress');
            const spec = engines.nativeLogin(payload.engine, payload.action || 'login');
            const token = require('node:crypto').randomUUID();
            nativeLogins.set(payload.engine, token);
            return { ok: true, result: { ...spec, token } };
          }
          if (action === 'native-login-release') {
            if (!nativeLogins.has(payload.engine) || nativeLogins.get(payload.engine) !== payload.token) throw new Error('Invalid native login reservation');
            nativeLogins.delete(payload.engine); return { ok: true };
          }
          if (action === 'engine-settings') {
            if (!supported.includes(payload.engine)) throw new Error('Unsupported engine');
            if (manager.isBusy(payload.engine) || nativeLogins.has(payload.engine)) throw new Error('Stop this engine and finish account login before changing defaults');
            if (!['api', 'subscription'].includes(payload.connection) || payload.engine === 'dsh' && payload.connection !== 'api') throw new Error('Unsupported connection');
            if (typeof payload.model !== 'string' || !payload.model.trim() || payload.model.length > 200) throw new Error('Model is required');
            if (payload.connection === 'api' && !config.publicState(routes()).models.includes(payload.model)) throw new Error('Select a configured API model');
            return { ok: true, result: manager.saveSettings(payload.engine, { connection: payload.connection, model: payload.model, permissionMode: 'ask' }) };
          }
          if (action === 'settings') {
            const cfg = routes();
            const state = await remote.command('state');
            if (!state.ok) return state;
            return { ok: true, result: { ...state.result, language: loadConfig().language || 'zh-CN', dataDir,
              api: { enabled: cfg.enabled, providers: cfg.providers.length, keys: cfg.providers.reduce((total, provider) => total + provider.keys.length, 0),
                models: config.publicState(cfg).models },
              engines: supported.map(id => ({ id, model: manager.settings(id).model || '', connection: manager.settings(id).connection || 'api', permissionMode: manager.settings(id).permissionMode || 'ask' })),
              conversationCount: manager.items.size, busy: manager.isBusy(),
              nativeLogins: [...nativeLogins.keys()],
            } };
          }
          if (action === 'set-language') {
            if (!['zh-CN', 'en'].includes(payload.language)) throw new Error('Unsupported language');
            saveConfig({ language: payload.language });
            return { ok: true };
          }
          if (action === 'set-api-enabled') {
            if (typeof payload.enabled !== 'boolean') throw new Error('Expected a boolean enabled state');
            if (manager.isBusy() || router?.getState().activeRequests) throw new Error('Stop running conversations before changing API routing');
            const previous = routes();
            const next = config.normalizeConfig({ ...previous, enabled: payload.enabled }, previous);
            try { writeJson(routeFile, next); router?.reload(); }
            catch {
              try { writeJson(routeFile, previous); router?.reload(); }
              catch { throw new Error('API routing rollback failed; inspect server configuration'); }
              throw new Error('API routing update failed; previous settings restored');
            }
            remote.publish(); return { ok: true, result: { enabled: next.enabled } };
          }
          if (['state', 'start', 'login', 'stop', 'logout', 'invite', 'approve', 'reject', 'revoke'].includes(action)) return await remote.command(action, payload);
          if (action === 'workspaces') return { ok: true, result: manager.workspaces.sessionMeta().workspaces };
          if (action === 'conversations') return { ok: true, result: [...manager.items.values()].map(item => reader.summary(item)) };
          if (action === 'create-workspace' || action === 'delete-workspace') {
            if (action === 'create-workspace' && (typeof payload.path !== 'string' || !path.isAbsolute(payload.path))) throw new Error('Workspace path must be an absolute server path');
            const result = await manager.command(supported[0], 'meta-op', { ...payload, op: action });
            remote.publish(); return result;
          }
          if (action === 'create-conversation') return { ok: true, result: reader.summary(manager.create(payload.engine || supported[0], payload.workspaceId)) };
          if (action === 'set-model') {
            const engine = payload.engine || supported[0];
            if (!supported.includes(engine) || typeof payload.model !== 'string' || !config.publicState(routes()).models.includes(payload.model)) throw new Error('Select a supported engine and configured API model');
            if (manager.isBusy()) throw new Error('Stop running conversations before changing defaults');
            return { ok: true, result: manager.saveSettings(engine, { model: payload.model, permissionMode: 'ask' }) };
          }
          throw new Error('Unsupported local server command');
        } catch (error) { return { ok: false, error: error.message }; }
        finally { commandBusy = false; idleResolve?.(); idleResolve = null; }
      },
      close() {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = (async () => {
          if (commandBusy) await new Promise(resolve => { idleResolve = resolve; });
          await shutdown();
        })();
        return closePromise;
      },
    };
  } catch (error) {
    manager?.pauseGoals(); manager?.closeGoalTools(); release(); throw error;
  }
}

module.exports = { createHeadlessHost };
