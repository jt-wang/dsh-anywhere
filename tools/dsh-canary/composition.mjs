import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDeterministicAdapter, ephemeralBrowserCredentials, PROVIDER, MODEL } from './deterministic.mts';

/** rc.3 ships the same session, workspace and service code as rc.2, and so do rc.4 and rc.5: only
 * versions differ. The daily canary (.github/workflows/dsh-canary.yml) runs each later 0.2.1 rc
 * and the 0.2.1 release with that service set, which is how it finds the one that changes. */
const RC2_LINE = /^0\.2\.1(?:-rc\.(?:[2-9]|[1-9]\d+))?$/;
export const rc2Family = version => RC2_LINE.test(version);
/** 0.2.2 release candidates and the release (inspected and run from rc.1). Their composition differs from rc.2's:
 * dsh-tools no longer takes `mode` (native execution is the separate dsh-tool-executor-native plugin, dsh-tools
 * README), and the SessionController also injects `typertGateway`, which dsh-api-gateway provides
 * (dsh-base/cordis.patch.yml mounts it). */
const LINE_022 = /^0\.2\.2(?:-rc\.(?:0|[1-9]\d*))?$/;
export const line022 = version => LINE_022.test(version);
export const canaryAccepts = version => ['0.2.0-rc.2', '0.2.1-alpha.1'].includes(version) || rc2Family(version) || line022(version);
const COMPONENTS = [
  ['cordis-plugin-timer', {}], ['dsh-typert-registry', {}],
  ['dsh-llm', {}], ['dsh-session', {}], ['dsh-session-projection', {}],
  ['dsh-session-query', {}], ['dsh-agent', {}], ['dsh-commands', {}],
  ['dsh-client-connection', {}], ['dsh-client-file-upload', {}],
  ['dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'Isolated synthetic DSH Mobile canary.' }],
  ['dsh-tools', { mode: 'native' }],
  ['dsh-agent-loop', { agents: [], maxParallelToolCalls: 1 }],
  ['dsh-agent-default-model', { provider: PROVIDER, model: MODEL }],
  ['dsh-storage', {}], ['dsh-storage-domain', { backend: 'json' }],
  ['dsh-workspace', {}], ['dsh-api-session-controller', { nativeOpen: false }],
];

export function officialLoader(runtimeRoot) {
  const require = createRequire(path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'));
  const evidence = [];
  let installedVersion;
  const allowed = new Set(['cordis', 'cordis-plugin-loader', 'cordis-plugin-include', 'dsh-app-boot', 'dsh-agent-preset-registry', 'dsh-agent-preset', 'dsh-api-workspace-controller', 'dsh-credentials', 'dsh-subagent', 'dsh-subagent-fork-in-process', 'dsh-subagent-spawn-in-process', ...COMPONENTS.map(([id]) => id), 'dsh-api-remote-access', 'dsh-working-directory', 'dsh-api-gateway', 'dsh-tool-executor-native', 'dsh-tool-todo', 'dsh-session-projection-cache', 'dsh-session-persistence-jsonl', 'dsh-storage-json', 'dsh-fs-local', 'dsh-attachment-local']);
  return {
    evidence,
    get installedVersion() { return installedVersion; },
    async load(id) {
      assert.ok(allowed.has(id), 'Official canary composition allowlist');
      const pkg = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', id, 'package.json');
      const manifest = JSON.parse(await readFile(pkg, 'utf8'));
      if (id.startsWith('dsh-')) assert.equal(manifest.version, installedVersion, `Installed ${id} version must match the verified DSH runtime`);
      const entry = require.resolve(`@deepseek-ai/${id}`);
      evidence.push({ package: manifest.name, version: manifest.version, sha256: createHash('sha256').update(await readFile(entry)).digest('hex') });
      return import(pathToFileURL(entry).href);
    },
    async version() {
      const manifest = JSON.parse(await readFile(path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
      assert.ok(canaryAccepts(manifest.version), `The canary runs 0.2.0-rc.2, 0.2.1-alpha.1, 0.2.1 from rc.2 on and 0.2.2 from rc.0 on, not ${manifest.version}`);
      installedVersion = manifest.version;
      return installedVersion;
    },
  };
}

/** Real official registries, factory/loop, query, projection, persistence and controller. */
export async function composeRuntime(loader, directories, { compression = 'none' } = {}) {
  const { Context } = await loader.load('cordis');
  const { CredentialProvider } = await loader.load('dsh-credentials');
  const { LlmAdapter } = await loader.load('dsh-llm');
  const deterministic = createDeterministicAdapter(LlmAdapter);
  const ctx = new Context();
  const fibers = [];
  const mounted = [];
  try {
    ctx.plugin(ephemeralBrowserCredentials(CredentialProvider));
    const version = loader.installedVersion ?? await loader.version();
    // 0.2.1-rc.2 adds required remote-access and working-directory services to the composition.
    const rc2Extras = [['dsh-api-remote-access', {}], ['dsh-working-directory', { defaultDirectory: directories.workspace }]];
    const components = line022(version)
      ? [...COMPONENTS.map(([id, config]) => [id, id === 'dsh-tools' ? {} : config]), ['dsh-tool-executor-native', {}], ...rc2Extras, ['dsh-api-gateway', {}]]
      : rc2Family(version) ? [...COMPONENTS, ...rc2Extras] : COMPONENTS;
    for (const [id, config] of [
      ...components,
      ['dsh-session-persistence-jsonl', { root: directories.sessions, compression }],
      ['dsh-storage-json', { root: directories.storages }],
      ['dsh-fs-local', { cwd: directories.workspace }],
      ['dsh-attachment-local', { dshHome: directories.home }],
    ]) {
      const module = await loader.load(id);
      const fiber = ctx.plugin(module.default ?? module, config);
      fibers.push(fiber);
      mounted.push(id);
    }
    const register = ctx.inject(['llm'], llmCtx => { llmCtx.llm.registerAdapter([PROVIDER], deterministic); });
    fibers.push(register);
    await Promise.all(fibers.map(fiber => fiber.await()));
    // 0.2.2 (Cordis 4.1): a fiber whose dependencies arrive late can still be activating right after await().
    for (let waited = 0; fibers.some(fiber => fiber.state !== 2) && waited < 2000; waited += 25) await new Promise(resolve => setTimeout(resolve, 25));
    for (const fiber of fibers) assert.equal(fiber.state, 2, `Inactive component ${fiber.name}`);
    for (const service of ['sessionController', 'agentLoop', 'sessionPersistence', 'workspaceRegistry', 'attachments', 'fileUploads']) assert.ok(ctx.get(service), `Required real service ${service}`);
    for (const service of ['settings', 'configEditor', 'profileContext', 'loader', 'webServer', 'subprocess', 'mcp', 'authorization', 'deepseekAccount', 'otel', 'productTelemetry']) {
      assert.equal(ctx.get(service), undefined, `Forbidden service ${service}`);
    }
    assert.deepEqual(ctx.llm.listProviders().map(provider => provider.id), [PROVIDER]);
    assert.deepEqual(ctx.llm.listConfigurableProviders(), []);
    assert.deepEqual(ctx.tools.schemas(), []);
    ctx.tools.guard(() => 'Tool execution is prohibited in the real DSH canary');
    const workspace = await ctx.workspaceRegistry.create(directories.workspace, 'Synthetic canary workspace');
    return { ctx, deterministic, mounted, workspace, version: loader.installedVersion, async dispose() {
      for (const agent of ctx.agents.list()) agent.cancel({ kind: 'disposed' });
      deterministic.releaseAll();
      await ctx.fiber.dispose();
      assert.equal(deterministic.active, 0, 'No model streams after disposal');
    } };
  } catch (error) {
    deterministic.releaseAll();
    await ctx.fiber.dispose();
    throw error;
  }
}
