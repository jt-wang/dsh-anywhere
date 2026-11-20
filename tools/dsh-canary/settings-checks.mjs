import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Exercise the official profile editor, not a settings-provider mock. All paths belong to the canary run. */
export async function settingsChecks({ runtimeRoot, directories }) {
  const load = async name => {
    const base = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', name);
    const module = await import(pathToFileURL(path.join(base, 'lib/index.js')));
    return module.default ?? module;
  };
  const bootModule = await import(pathToFileURL(path.join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')));
  const { boot, initProfile, readProfilePatches } = bootModule;
  const home = path.join(directories.home, 'settings-contract');
  const dir = path.join(home, 'profiles', 'synthetic');
  await mkdir(home, { recursive: true });
  initProfile(dir, ['synthetic-settings-bundle']);
  const bundle = path.join(dir, 'node_modules', 'synthetic-settings-bundle');
  await mkdir(bundle, { recursive: true });
  await writeFile(path.join(home, 'package.json'), '{"private":true}');
  await writeFile(path.join(bundle, 'package.json'), JSON.stringify({ name: 'synthetic-settings-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }));
  const names = {
    editor: 'dsh-config-editor', settings: 'dsh-settings', model: 'dsh-agent-default-model',
    registry: 'dsh-typert-registry', access: 'dsh-api-remote-access', gateway: 'dsh-api-gateway',
    controller: 'dsh-api-settings-controller', credentials: 'dsh-credentials-local',
    speech: 'dsh-experimental-speech-to-text', speechApi: 'dsh-experimental-api-speech-to-text',
    subprocess: 'dsh-subprocess', sensevoice: 'dsh-experimental-speech-to-text-sensevoice',
  };
  const configs = { model: { provider: 'synthetic', model: 'original' }, credentials: { path: path.join(home, '.credentials.yaml'), watch: false }, speech: { defaultProvider: 'sensevoice-local' }, sensevoice: { dataRoot: path.join(home, 'speech') } };
  await writeFile(path.join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: Object.keys(names).map(id => ({ id, name: `cordis:${id}`, ...configs[id] ? { config: configs[id] } : {} })) }]));
  await writeFile(path.join(dir, 'cordis.yml'), '[]\n');
  const profile = { name: 'synthetic', startedBundles: ['synthetic-settings-bundle'], dir, patchPath: path.join(dir, 'cordis.patch.yml'), installAnchor: path.join(home, 'package.json'), cwd: directories.workspace, home, overlays: [], telemetryDisabledEnv: undefined };
  const builtins = Object.fromEntries(await Promise.all(Object.entries(names).map(async ([key, name]) => [key, await load(name)])));
  let ctx;
  const checks = [];
  try {
    ctx = await boot('synthetic', path.join(dir, 'cordis.yml'), readProfilePatches('synthetic', profile), context => {
      context.provide('profileContext', profile);
      context.provide('appReady', { onReady: listener => { listener(); return () => {}; } });
      Object.assign(context.loader.builtins, builtins);
    });
    const signal = new AbortController().signal;
    const peer = { id: 'synthetic-owner', ctx, principal: { kind: 'owner' }, signal, interactions: 'none', dispose: async () => {} };
    const invoke = (namespace, method, args) => ctx.typertGateway.invoke({ namespace, method, args, signal, peer });
    let settings = await invoke('settings', 'describe', {});
    const model = settings.namespaces.find(n => n.ns === 'model');
    assert.ok(settings.writable && model);
    assert.equal(model.value.model, 'original');
    assert.equal(model.autoGenerate, false);
    checks.push('official-profile-describe-includes-custom-desktop-page-namespace');
    await invoke('settings', 'mutate', { ns: 'model', expectedRevision: model.revision, ops: [{ op: 'set', path: ['model'], value: 'replacement' }] });
    settings = await invoke('settings', 'describe', {});
    assert.equal(settings.namespaces.find(n => n.ns === 'model').value.model, 'replacement');
    assert.equal(ctx.agentDefaultModel.currentSelection().model, 'replacement');
    assert.match(await readFile(profile.patchPath, 'utf8'), /replacement/);
    checks.push('official-gateway-path-write-persists-and-updates-live-consumer');
    await assert.rejects(invoke('settings', 'mutate', { ns: 'model', expectedRevision: model.revision, ops: [{ op: 'set', path: ['model'], value: 'stale' }] }), e => e.code === 'settings/conflict');
    checks.push('stale-revision-rejected-without-overwrite');
    const replacement = settings.namespaces.find(n => n.ns === 'model');
    await invoke('settings', 'mutate', { ns: 'model', expectedRevision: replacement.revision, ops: [{ op: 'unset', path: ['model'] }] });
    const reset = (await invoke('settings', 'describe', {})).namespaces.find(n => n.ns === 'model');
    assert.equal(reset.value.model, 'original');
    assert.equal(reset.value.model, reset.base.model);
    assert.equal(ctx.agentDefaultModel.currentSelection().model, 'original');
    checks.push('unset-restores-inherited-effective-value-not-user-field-absence');
    await invoke('credentials', 'set', { ref: 'SYNTHETIC_API_KEY', value: 'synthetic-not-a-real-key' });
    const credential = await invoke('credentials', 'describe', { refs: ['SYNTHETIC_API_KEY'] });
    assert.equal(credential.SYNTHETIC_API_KEY.configured, true);
    assert.ok(!JSON.stringify(credential).includes('synthetic-not-a-real-key'));
    await invoke('credentials', 'unset', { ref: 'SYNTHETIC_API_KEY' });
    assert.equal((await invoke('credentials', 'describe', { refs: ['SYNTHETIC_API_KEY'] })).SYNTHETIC_API_KEY.configured, false);
    checks.push('real-credential-store-write-redacted-read-remove');
    await invoke('speech', 'configure', { patch: { language: 'en' } });
    const catalog = await invoke('speech', 'catalog', {});
    assert.equal(catalog.selection.language, 'en');
    assert.equal(catalog.selection.providerId, 'sensevoice-local');
    const speechSettings = (await invoke('settings', 'describe', {})).namespaces.find(n => n.ns === 'speech');
    assert.equal(speechSettings.value.language, 'en');
    checks.push('speech-configure-persists-through-settings-and-catalog');
    return { phase: 'settings-profile-gateway', checks, namespaces: settings.namespaces.map(n => n.ns) };
  } finally { await ctx?.fiber.dispose(); }
}
