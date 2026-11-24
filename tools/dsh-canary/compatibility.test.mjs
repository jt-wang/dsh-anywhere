import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bundleCatalog, canonical, channelMetadata, compareRuntimes, ownerConfigs, remoteContracts, reviewChanges } from './compatibility.mjs';

// Reduced literals from official 0.2.2-rc.1 SessionController/commands descriptors.
// They exercise wire semantics; they are not a replacement for comparing actual packages.
function descriptor({ endpoint = 'session/list', name = '_request', mode = '', schema = { type: 'object', properties: { cursor: { type: 'string' } }, required: [] }, result = { type: 'object' }, optional = false } = {}) {
  return `export const TYPERT_REMOTE = createTypertRemoteInfo({
    package: '@deepseek-ai/dsh-api-session-controller', methods: {
      '${endpoint}': { service: 'sessionController', ${mode ? `mode: '${mode}',` : ''}
        invocation: { kind: 'direct' }, parameters: [{ name: '${name}', source: 'json',
          acceptsUndefined: ${optional}, codec: { jsonSchema: ${JSON.stringify(schema)} },
          strictCodec: { jsonSchema: ${JSON.stringify(schema)} } }],
        result: { jsonSchema: ${JSON.stringify(result)} }
      }
    }
  }, z)`;
}
const runtime = (source, declarations = { 'lib/types/types.d.ts': 'same' }) => ({ packages: { 'dsh-api-session-controller': { remote: remoteContracts(source), declarations } } });
const changed = (a, b) => compareRuntimes(runtime(a), runtime(b));

test('stable descriptors ignore whitespace and object key ordering without dropping schema data', () => {
  assert.deepEqual(changed(descriptor(), `\n/* generated */\n${descriptor()}\n`), []);
  assert.deepEqual(canonical({ type: 'object', description: 'annotation', properties: { description: { type: 'string' } } }), { description: 'annotation', properties: { description: { type: 'string' } }, type: 'object' });
  assert.deepEqual(canonical({ const: { description: 'actual wire data' } }), { const: { description: 'actual wire data' } });
});
test('detects the exact _request wire key and call/stream changes', () => {
  assert.equal(changed(descriptor(), descriptor({ name: 'request' }))[0].change, 'changed');
  assert.equal(changed(descriptor(), descriptor({ mode: 'stream' }))[0].change, 'changed');
  assert.equal(changed(descriptor(), descriptor({ optional: true }))[0].change, 'changed');
});
test('detects model input capability and command attachment/result changes', () => {
  for (const endpoint of ['session/modelCatalog', 'commands/execute']) {
    const a = descriptor({ endpoint, result: { type: 'object', properties: { inputModalities: { enum: ['text'] } } } });
    const b = descriptor({ endpoint, result: { type: 'object', properties: { inputModalities: { enum: ['text', 'image'] }, submittedAttachments: { type: 'array' } } } });
    assert.equal(changed(a, b)[0].change, 'changed');
  }
});
test('detects schedule/delete removal and new official team mode remote', () => {
  const changes = changed(descriptor({ endpoint: 'schedule/delete' }), descriptor({ endpoint: 'agentTeams/setEnabled' }));
  assert.deepEqual(changes.map(item => [item.contract, item.change]), [['schedule/delete', 'removed'], ['agentTeams/setEnabled', 'added']]);
});
test('detects the released subagents/prompt removal of parentSessionId and mode', () => {
  const old = { type: 'object', properties: { requestId: { type: 'string' }, parentSessionId: { type: 'string' }, childSessionId: { type: 'string' }, mode: { const: 'continuable' } }, required: ['requestId', 'parentSessionId', 'childSessionId', 'mode'] };
  const current = { type: 'object', properties: { requestId: { type: 'string' }, childSessionId: { type: 'string' } }, required: ['requestId', 'childSessionId'] };
  assert.equal(changed(descriptor({ endpoint: 'subagents/prompt', schema: old }), descriptor({ endpoint: 'subagents/prompt', schema: current }))[0].change, 'changed');
});
test('official experimental catalog need not use the experimental package prefix', () => {
  const source = `const OPTIONAL_BUNDLES = ['@deepseek-ai/dsh-deepseek-chat-import'];
    const ON_DEMAND_BUNDLES = []; const RETIRED_BUNDLES = new Set([]);
    const EXPERIMENTAL_BUNDLES = new Set(['@deepseek-ai/dsh-deepseek-chat-import']);`;
  const catalog = bundleCatalog(source);
  assert.equal(catalog.EXPERIMENTAL_BUNDLES[0], '@deepseek-ai/dsh-deepseek-chat-import');
  assert.throws(() => bundleCatalog(source.replace('new Set([])', 'loadCatalog()')), /Non-literal/);
  const changes = compareRuntimes({ packages: {}, bundleCatalog: catalog }, { packages: {}, bundleCatalog: { ...catalog, EXPERIMENTAL_BUNDLES: [] } });
  assert.equal(changes[0].area, 'bundle-catalog');
});
test('detects declaration drift even for opaque event/projection/tool shapes', () => {
  const before = runtime(descriptor(), { 'lib/types/types.d.ts': 'tool-call-v1' });
  const after = runtime(descriptor(), { 'lib/types/types.d.ts': 'tool-call-v2' });
  assert.deepEqual(compareRuntimes(before, after), [{ package: 'dsh-api-session-controller', area: 'declarations', contract: 'lib/types/types.d.ts', change: 'changed' }]);
});
test('known official schema-generation errors stay explicit, not empty success schemas', () => {
  const source = descriptor().replace('result: { jsonSchema: {"type":"object"} }', "result: { jsonSchemaError: 'selected dictionaries require string keys' }");
  assert.equal(remoteContracts(source)['session/list'].result.schemaUnavailable, 'selected dictionaries require string keys');
  assert.throws(() => remoteContracts(source.replace("jsonSchemaError: 'selected dictionaries require string keys'", '')), /Missing schema/);
});
test('never evaluates upstream expressions; unsupported generator shapes fail closed', () => {
  const source = descriptor().replace('"type":"object"', '"type": (() => { throw new Error("executed") })()');
  assert.throws(() => remoteContracts(source), /Non-literal upstream contract/);
  assert.throws(() => remoteContracts('export const TYPERT_REMOTE = arbitrary()'), /createTypertRemoteInfo/);
  assert.throws(() => remoteContracts('export const TYPERT_REMOTE = {'), /Invalid generated descriptor syntax/);
});
test('channel resolution compares baseline, latest, next and alpha without upgrading or trusting shell input', () => {
  const packument = {
    'dist-tags': { latest: '0.2.2-rc.1', next: '0.2.2-rc.5', alpha: '0.2.3-alpha.2' },
    versions: Object.fromEntries(['0.2.2-rc.1', '0.2.2-rc.5', '0.2.3-alpha.2'].map(version => [version, { dist: { integrity: 'sha512-synthetic', tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz` } }])),
  };
  const metadata = channelMetadata(packument, '0.2.2-rc.1', 'next');
  assert.equal(metadata.selected, '0.2.2-rc.5');
  assert.equal(Object.keys(metadata.versions).length, 3);
  assert.equal(metadata.releaseKey, channelMetadata(packument, '0.2.2-rc.1', '0.2.2-rc.5').releaseKey);
  const alpha = channelMetadata(packument, '0.2.2-rc.1', 'alpha');
  assert.equal(alpha.selected, '0.2.3-alpha.2');
  assert.equal(alpha.releaseKey, channelMetadata(packument, '0.2.2-rc.1', alpha.selected).releaseKey);
  for (const requested of ['alpha', '0.2.3-alpha.2']) {
    assert.equal(channelMetadata(packument, '0.2.2-rc.1', requested).baseline, '0.2.2-rc.5');
  }
  assert.equal(channelMetadata(packument, '0.2.2-rc.1', 'next').baseline, '0.2.2-rc.1');
  const later = { ...packument, 'dist-tags': { ...packument['dist-tags'], alpha: '0.2.3-alpha.3' },
    versions: { ...packument.versions, '0.2.3-alpha.3': packument.versions['0.2.3-alpha.2'] } };
  assert.equal(channelMetadata(later, '0.2.2-rc.1', 'alpha').baseline, '0.2.2-rc.1');
  const withoutAlpha = { ...packument, 'dist-tags': { latest: '0.2.2-rc.1', next: '0.2.2-rc.5' } };
  assert.equal(channelMetadata(withoutAlpha, '0.2.2-rc.1', 'latest').selected, '0.2.2-rc.1');
  for (const requested of ['next', '0.2.2-rc.5']) {
    assert.equal(channelMetadata(withoutAlpha, '0.2.2-rc.1', requested).selected, '0.2.2-rc.5');
  }
  assert.throws(() => channelMetadata(withoutAlpha, '0.2.2-rc.1', 'alpha'), /Missing official release metadata: alpha/);
  assert.throws(() => channelMetadata(packument, 'latest', 'next'), /Baseline must be an exact/);
  for (const requested of ['next;echo bad', '../runtime', '"}]', 'https://example.invalid/dsh.tgz', '0.2.3']) assert.throws(() => channelMetadata(packument, '0.2.2-rc.1', requested));
});

test('an invalid review file does not block metadata and produces a static inspection failure', async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'dsh-canary-compatibility-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const review = path.join(output, 'review.json');
  await writeFile(review, '{');
  const dist = { integrity: 'sha512-synthetic', tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh.tgz' };
  const packument = {
    'dist-tags': { latest: '0.2.2-rc.5', next: '0.2.2-rc.5', alpha: '0.2.3-alpha.2' },
    versions: { '0.2.2-rc.5': { dist }, '0.2.3-alpha.2': { dist } },
  };
  const mockFetch = `globalThis.fetch = async url => Response.json(String(url).startsWith('https://registry.npmjs.org/') ? ${JSON.stringify(packument)} : {})`;
  const script = fileURLToPath(new URL('./compatibility.mjs', import.meta.url));
  const common = ['--output-dir', output, '--review-baseline', review];
  const metadata = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(mockFetch)}`, script, 'metadata', '--baseline-version', '0.2.2-rc.1', '--requested', 'alpha', ...common], { encoding: 'utf8' });
  assert.equal(metadata.status, 0, metadata.stderr);
  const channels = JSON.parse(await readFile(path.join(output, 'channels.json'), 'utf8'));
  assert.equal(channels.selected, '0.2.3-alpha.2');
  assert.equal(channels.baseline, '0.2.2-rc.5');
  const compare = spawnSync(process.execPath, [script, 'compare', '--baseline-root', output, '--runtime-root', output, ...common], { encoding: 'utf8' });
  assert.equal(compare.status, 1, compare.stderr);
  const report = JSON.parse(await readFile(path.join(output, 'compatibility.json'), 'utf8'));
  assert.equal(report.status, 'inspection-failed');
  assert.match(report.error, /JSON/);
});

test('review baseline accepts only the exact reviewed before/after contract on its release pair', () => {
  const a = { ...runtime(descriptor()), version: '0.2.2-rc.1' };
  const b = { ...runtime(descriptor({ optional: true })), version: '0.2.2-rc.5' };
  const fingerprint = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
  const entry = { ...compareRuntimes(a, b)[0], before: fingerprint(a.packages['dsh-api-session-controller'].remote['session/list']), after: fingerprint(b.packages['dsh-api-session-controller'].remote['session/list']), decision: 'accepted', reason: 'Reviewed optional request compatibility' };
  const review = { schemaVersion: 1, baseline: a.version, candidate: b.version, entries: [entry] };
  assert.equal(reviewChanges(a, b, review).acceptedChanges.length, 1);
  assert.equal(reviewChanges(a, b, review).pendingChanges.length, 0);
  assert.equal(reviewChanges(a, b).pendingChanges.length, 1);
  // Neither the same release string nor a matching endpoint is a blanket exception.
  for (const [before, after] of [
    [a, { ...b, version: '0.2.2-rc.6' }],
    [{ ...a, version: '0.2.2-rc.2' }, b],
    [{ ...runtime(descriptor({ mode: 'stream' })), version: a.version }, b],
    [a, { ...runtime(descriptor({ optional: true, result: { type: 'string' } })), version: b.version }],
    [a, { ...runtime(descriptor({ endpoint: 'session/newMethod' })), version: b.version }],
    [a, { packages: {}, version: b.version }],
  ]) {
    const result = reviewChanges(before, after, review);
    assert.equal(result.acceptedChanges.length, 0);
    assert.ok(result.pendingChanges.length > 0);
  }
  const required = reviewChanges(a, b, { ...review, entries: [{ ...entry, decision: 'mobile-change-required' }] });
  assert.equal(required.acceptedChanges.length, 0);
  assert.equal(required.pendingChanges[0].reason, entry.reason);
  assert.throws(() => reviewChanges(a, b, { ...review, entries: [entry, entry] }), /Duplicate/);
  assert.throws(() => reviewChanges(a, b, { ...review, entries: [{ ...entry, before: undefined }] }), /fingerprint/);
});

test('review baseline also binds added declarations, removed remotes and bundle catalogs', () => {
  const fingerprint = value => value === undefined ? null : createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
  const a = { version: '0.2.2-rc.1', packages: { sdk: { declarations: {}, remote: { removed: { service: 'old' } } } }, bundleCatalog: { OPTIONAL_BUNDLES: ['old'] } };
  const b = { version: '0.2.2-rc.5', packages: { sdk: { declarations: { 'new.d.ts': 'new-type-hash' }, remote: {} } }, bundleCatalog: { OPTIONAL_BUNDLES: ['new'] } };
  const value = (runtime, change) => change.area === 'bundle-catalog' ? runtime.bundleCatalog[change.contract] : runtime.packages[change.package]?.[change.area][change.contract];
  const review = { schemaVersion: 1, baseline: a.version, candidate: b.version, entries: compareRuntimes(a, b).map(change => ({ ...change, before: fingerprint(value(a, change)), after: fingerprint(value(b, change)), decision: 'accepted', reason: 'Reviewed exact catalog/type/removal' })) };
  assert.equal(reviewChanges(a, b, review).acceptedChanges.length, 3);
  const altered = structuredClone(b);
  altered.packages.sdk.declarations['new.d.ts'] = 'different-type-hash';
  altered.bundleCatalog.OPTIONAL_BUNDLES.push('unreviewed');
  assert.equal(reviewChanges(a, altered, review).pendingChanges.length, 2);
  assert.deepEqual(reviewChanges(b, b, review), { acceptedChanges: [], pendingChanges: [] });
});

test('owner configuration changes are reviewed even when settings RPC declarations stay identical', () => {
  const source = `class Speech { static Config = z.object({ language: z.string().default('auto').volatile(), maxAudioBytes: z.natural().default(4096) }); transcribe() { return 'unchanged contract'; } }`;
  const runtime = source => ({ version: '0.2.2-rc.5', packages: { speech: { declarations: { 'types.d.ts': 'same' }, remote: {}, ownerConfig: ownerConfigs(source) } } });
  const baseline = runtime(source);
  assert.deepEqual(baseline.packages.speech.ownerConfig['Speech.Config'].fields, ['language', 'maxAudioBytes']);
  // Implementation-only changes and comments do not manufacture settings drift.
  assert.deepEqual(compareRuntimes(baseline, runtime(source.replace('unchanged contract', 'new implementation') + '\n// comment')), []);
  for (const current of [source.replace("'auto'", "'en'"), source.replace('.volatile()', ''), source.replace('4096', '8192'), source.replace('language:', 'hotwords:')]) {
    assert.deepEqual(compareRuntimes(baseline, runtime(current)), [{ package: 'speech', area: 'ownerConfig', contract: 'Speech.Config', change: 'changed' }]);
  }
  const added = runtime(source.replace('language:', "enabled: z.boolean().default(true), language:"));
  assert.ok(added.packages.speech.ownerConfig['Speech.Config'].fields.includes('enabled'));
  assert.equal(reviewChanges(baseline, added).pendingChanges.length, 1);
  assert.equal(compareRuntimes(baseline, runtime(''))[0].change, 'removed');
  const variable = ownerConfigs(`const Config = z.object({ precision: z.union(['int8', 'fp32']).default('int8') });`);
  assert.deepEqual(variable.Config.fields, ['precision']);
  assert.throws(() => ownerConfigs(`const Config = z.object({ ...dynamicFields });`), /dynamic fields/);
  assert.throws(() => ownerConfigs(`const Config = loadConfig();`), /no longer an inline object/);
  // Merely fingerprint executable-looking defaults. Never call upstream code during inspection.
  assert.deepEqual(ownerConfigs(`const Config = z.object({ language: z.string().default((() => { throw Error('must not execute'); })()) });`).Config.fields, ['language']);
});
