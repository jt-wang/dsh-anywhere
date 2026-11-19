import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleCatalog, canonical, channelMetadata, compareRuntimes, remoteContracts } from './compatibility.mjs';

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
test('channel resolution compares baseline, latest and next without upgrading or trusting shell input', () => {
  const packument = {
    'dist-tags': { latest: '0.2.2-rc.1', next: '0.2.2-rc.5' },
    versions: Object.fromEntries(['0.2.2-rc.1', '0.2.2-rc.5'].map(version => [version, { dist: { integrity: 'sha512-synthetic', tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz` } }])),
  };
  const metadata = channelMetadata(packument, '0.2.2-rc.1', 'next');
  assert.equal(metadata.selected, '0.2.2-rc.5');
  assert.equal(Object.keys(metadata.versions).length, 2);
  assert.equal(metadata.releaseKey, channelMetadata(packument, '0.2.2-rc.1', '0.2.2-rc.5').releaseKey);
  assert.throws(() => channelMetadata(packument, 'latest', 'next'), /Baseline must be an exact/);
  for (const requested of ['next;echo bad', '../runtime', '"}]', 'https://example.invalid/dsh.tgz', '0.2.3']) assert.throws(() => channelMetadata(packument, '0.2.2-rc.1', requested));
});
