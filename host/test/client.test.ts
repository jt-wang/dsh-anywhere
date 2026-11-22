// The companion's DSH Desktop half (client/index.js): the show_interface card and the slots it registers, built as
// tools/build-host.mjs builds it, with a stand-in React that records elements instead of rendering.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const { build } = createRequire(join(root, 'host', 'package.json'))('esbuild');

async function load() {
  const react = 'export default { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }), useState: (v) => [v, () => {}], useCallback: (f) => f, useEffect: () => {} }';
  const out = await build({ entryPoints: [join(root, 'client', 'index.js')], bundle: true, write: false, format: 'esm', platform: 'neutral',
    plugins: [{ name: 'react', setup(b) { b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: react })); } }] });
  return import(`data:text/javascript,${encodeURIComponent(out.outputFiles[0].text)}`);
}
const text = (node: any): string => typeof node === 'string' ? node : (node?.children ?? []).map(text).join(' ');

test('the show_interface card names the interface and says where it opens', async () => {
  const { InterfaceCard } = await load();
  const ready = InterfaceCard({ phase: 'result', block: { kind: 'result', isError: false, call: { argsRaw: JSON.stringify({ title: 'Tip calculator', source: 'import …' }) } } });
  assert.match(text(ready), /Tip calculator/); assert.match(text(ready), /DSH Anywhere/);
  assert.doesNotMatch(text(ready), /import/, 'the module source is not shown');
  const building = InterfaceCard({ phase: 'start', block: { argsRaw: '{"title":"Tip calc' } });
  assert.match(text(building), /Building/);
  const failed = InterfaceCard({ phase: 'result', block: { kind: 'result', isError: true, call: { argsRaw: '{"title":"Tip"}' } } });
  assert.match(text(failed), /did not build/);
});

test('the client registers the DSH Anywhere settings page with its icon, the plugin page, and the show_interface card', async () => {
  const { apply } = await load();
  const registered: { name: string; key?: string; id?: string; label?: () => string }[] = [];
  apply({ effect: (f: () => unknown) => f(), slots: { inject: (_name: string, f: () => unknown) => f(), register: (entry: { name: string }) => { registered.push(entry); return () => {}; } } });
  assert.deepEqual(registered.map(r => [r.name, r.id ?? r.key]), [['settings.section', 'dsh-anywhere'], ['settings.section.icon', 'dsh-anywhere'],
    ['plugins.bundle.config', '@jt-wang/dsh-anywhere'], ['tool.call.toolview', 'show_interface']]);
  assert.equal(registered[0]!.label!(), 'DSH Anywhere');
});

test('phone counts use each language\'s plural forms, and every language has every key', async () => {
  const { pairedPhones } = await load();
  assert.deepEqual([0, 1, 2].map(count => pairedPhones(count, 'en')), ['0 paired phones', '1 paired phone', '2 paired phones']);
  const out = await build({ entryPoints: [join(root, 'client', 'strings.js')], bundle: true, write: false, format: 'esm', platform: 'neutral' });
  const { DICTIONARIES } = await import(`data:text/javascript,${encodeURIComponent(out.outputFiles[0].text)}`);
  assert.deepEqual(Object.keys(DICTIONARIES).sort(), ['en', 'es', 'fr', 'ja', 'ko', 'ru', 'zh', 'zh-Hant']);
  for (const [language, dict] of Object.entries(DICTIONARIES) as [string, Record<string, string>][]) {
    const plurals = new Set(new Intl.PluralRules(language).resolvedOptions().pluralCategories);
    for (const key of Object.keys(DICTIONARIES.en).filter(key => !key.startsWith('phones.'))) assert.ok(dict[key], `${language} has ${key}`);
    for (const category of plurals) assert.ok(dict[`phones.${category}`], `${language} has phones.${category}`);
    for (const text of Object.values(dict)) assert.doesNotMatch(text, /\bDSH\b(?! (Anywhere|Desktop))/, `${language}: "${text}" names the product DSH Anywhere and the app DSH Desktop`);
  }
});

test('active phones come first, newest first; revoked phones are folded apart', async () => {
  const { sortDevices } = await load();
  const device = (deviceId: string, createdAt: number, revokedAt: number | null) => ({ deviceId, createdAt, revokedAt });
  const { active, revoked } = sortDevices([device('old-revoked', 1, 5), device('old', 2, null), device('new-revoked', 3, 9), device('new', 4, null)]);
  assert.deepEqual(active.map((d: { deviceId: string }) => d.deviceId), ['new', 'old']);
  assert.deepEqual(revoked.map((d: { deviceId: string }) => d.deviceId), ['new-revoked', 'old-revoked']);
});

// Seen in review (2026-11-21): the card said "Turned on dsh-experimental-voice-input-bundle", "Changed settings: model
// default.reasoningEffort" and "Saved the key deepseek". It names what changed as DSH Desktop does.
test('the phone changes card names plugins, providers and settings as DSH Desktop does, never by their ids', async () => {
  const { changeText } = await load();
  const voice = '@deepseek-ai/dsh-experimental-voice-input-bundle';
  const lines = [
    changeText({ method: 'pluginManager/setBundleEnabled', target: `${voice} on`, label: { title: { en: 'Voice input', zh: '语音输入' } } }),
    changeText({ method: 'pluginManager/setBundleEnabled', target: '@deepseek-ai/dsh-cua-bundle off', label: { title: 'Computer use' } }),
    changeText({ method: 'pluginManager/installBundle', target: '@deepseek-ai/dsh-experimental-auto-review', label: { title: { en: 'Auto authorization review' } } }),
    changeText({ method: 'settings/mutate', target: 'llm providers.deepseek.reasoningEffort', label: { provider: 'DeepSeek', field: 'reasoningEffort' } }),
    changeText({ method: 'settings/mutate', target: 'agent-preset-registry selectedDefault', label: { defaultAgent: true } }),
    changeText({ method: 'settings/mutate', target: 'session maxTurnSteps' }),
    changeText({ method: 'credentials/set', target: 'DEEPSEEK_API_KEY', label: { provider: 'DeepSeek' } }),
    changeText({ method: 'credentials/unset', target: 'OPEN_ROUTER_API_KEY' }),
    changeText({ method: 'speech/configure', target: 'language' }),
  ];
  assert.deepEqual(lines, [
    'Turned on Voice input', 'Turned off Computer use', 'Installed Auto authorization review',
    'Changed a DeepSeek setting: Reasoning effort', 'Changed the default agent', 'Changed the setting “Max turn steps”',
    'Saved the DeepSeek API key', 'Removed the Open router API key', 'Changed the voice input language',
  ]);
  assert.ok(lines.every(l => !/@|dsh-|_API_KEY|\.|agent-preset|selectedDefault|reasoningEffort/.test(l)), 'no package, key or setting id shows');
});

// A phone that turned DSH Anywhere off cut every phone off; this page could not say so while it was off. Once DSH
// Anywhere runs again it names the phone, only when that change is the newest one.
test('the page names the phone that turned DSH Anywhere off or removed it, once it runs again', async () => {
  const { selfOffNotice } = await load();
  const at = Date.UTC(2026, 10, 22, 3, 4);
  assert.match(selfOffNotice([{ method: 'pluginManager/setBundleEnabled', target: '@jt-wang/dsh-anywhere off', deviceName: 'Pixel 9', at }]) ?? '', /^Pixel 9 turned off DSH Anywhere .*It is on again now/);
  assert.match(selfOffNotice([{ method: 'pluginManager/removeBundle', target: '@jt-wang/dsh-anywhere', deviceName: 'iPhone', at }]) ?? '', /^iPhone uninstalled DSH Anywhere/);
  assert.equal(selfOffNotice([{ method: 'pluginManager/setBundleEnabled', target: '@jt-wang/dsh-anywhere on', deviceName: 'iPhone', at }]), undefined);
  assert.equal(selfOffNotice([{ method: 'pluginManager/setBundleEnabled', target: '@deepseek-ai/dsh-cua-bundle off', deviceName: 'iPhone', at }]), undefined);
  assert.equal(selfOffNotice([{ method: 'settings/mutate', target: 'ui-theme preference', at }, { method: 'pluginManager/removeBundle', target: '@jt-wang/dsh-anywhere', at }]), undefined, 'only the newest change');
  assert.equal(selfOffNotice([]), undefined);
});
