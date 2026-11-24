// Read-only inspection: parse official declarations/descriptors, never import upstream code.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(project, 'host/package.json'));
const ts = require('typescript');
const hash = value => createHash('sha256').update(value).digest('hex');
const settingsPackages = ['dsh-api-settings-controller', 'dsh-settings', 'dsh-experimental-api-speech-to-text', 'dsh-experimental-speech-to-text', 'dsh-experimental-speech-to-text-sensevoice', 'dsh-experimental-client-ui-voice-input'];
const settingsDomains = ['dsh-agent-default-model', 'dsh-permission-presets', 'dsh-client-locale', 'dsh-client-ui-theme', 'dsh-client-ui-settings', 'dsh-client-ui-chat', 'dsh-client-ui-conversation', 'dsh-session-log-deepseek', 'dsh-llm-pi-ai', 'dsh-llm-deepseek-api-key', 'dsh-llm-deepseek-account', 'dsh-web', 'dsh-web-deepseek-api', 'dsh-web-search-deepseek', 'dsh-tool-subagent', 'dsh-bash-local', 'dsh-pwsh-local', 'dsh-agent-loop', 'dsh-api-workspace-controller', 'dsh-agent-preset-registry', 'dsh-cua', 'dsh-deepseek-account', 'dsh-host-plugin-inventory'];
const monitored = ['dsh-api-session-controller', 'dsh-commands', 'dsh-llm', 'dsh-session', 'dsh-subagent', 'dsh-agent-team', 'dsh-experimental-agent-team', 'dsh-user-questions', 'dsh-user-approval', 'dsh-schedule', 'dsh-tools', 'dsh-tool-ask-user', ...settingsPackages, ...settingsDomains];
const teamPackages = ['dsh-agent-team', 'dsh-experimental-agent-team'];
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const alphaReviewPair = { baseline: '0.2.2-rc.5', candidate: '0.2.3-alpha.2' };
const keyOf = node => node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : undefined;
function property(node, key) {
  assert.ok(node && ts.isObjectLiteralExpression(node), `Expected literal descriptor object for ${key}`);
  const matches = node.properties.filter(item => keyOf(item) === key);
  assert.ok(matches.length <= 1, `Duplicate descriptor field ${key}`);
  return matches[0]?.initializer;
}
// Only JSON literals are decoded. A changed generator using executable expressions fails closed.
function literal(node) {
  assert.ok(node, 'Missing contract literal');
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) {
    const result = Object.create(null);
    for (const item of node.properties) {
      const key = keyOf(item);
      assert.ok(key && ts.isPropertyAssignment(item) && !(key in result), 'Unsupported or duplicate contract field');
      result[key] = literal(item.initializer);
    }
    return result;
  }
  throw new Error(`Non-literal upstream contract: ${ts.SyntaxKind[node.kind]}`);
}
// Preserve every schema value (including enum/const data); only object key ordering is normalized.
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function remoteContracts(source) {
  const file = ts.createSourceFile('typert.remote-client.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(file.parseDiagnostics.length, 0, 'Invalid generated descriptor syntax');
  let descriptor;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'TYPERT_REMOTE') {
      assert.ok(!descriptor && node.initializer && ts.isCallExpression(node.initializer), 'Unsupported remote descriptor initializer');
      assert.equal(node.initializer.expression.getText(file), 'createTypertRemoteInfo');
      descriptor = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  const methods = property(descriptor, 'methods');
  assert.ok(methods && ts.isObjectLiteralExpression(methods), 'Missing generated methods table');
  const result = Object.create(null);
  for (const method of methods.properties) {
    const endpoint = keyOf(method);
    assert.ok(endpoint && ts.isPropertyAssignment(method) && !(endpoint in result), 'Unsupported remote entry');
    const object = method.initializer;
    const parameters = property(object, 'parameters');
    assert.ok(parameters && ts.isArrayLiteralExpression(parameters), 'Missing remote parameters');
    const optional = (object, key) => property(object, key) ? literal(property(object, key)) : undefined;
    const codec = object => {
      const schema = property(object, 'jsonSchema');
      if (schema) return { schema: literal(schema) };
      const reason = property(object, 'jsonSchemaError');
      assert.ok(reason, 'Missing schema and explicit schema-generation error');
      return { schemaUnavailable: literal(reason) };
    };
    result[endpoint] = canonical({
      service: literal(property(object, 'service')),
      mode: optional(object, 'mode') ?? 'call',
      invocation: literal(property(object, 'invocation')),
      scope: optional(object, 'scope'),
      cancellation: optional(object, 'cancellation'),
      parameters: parameters.elements.map(parameter => ({
        ...Object.fromEntries(['name', 'wire', 'source', 'lookup', 'acceptsUndefined'].filter(key => property(parameter, key)).map(key => [key, literal(property(parameter, key))])),
        codec: codec(property(parameter, 'codec')),
        strictCodec: property(parameter, 'strictCodec') ? codec(property(parameter, 'strictCodec')) : undefined,
      })),
      result: codec(property(object, 'result')),
    });
  }
  return result;
}
export function bundleCatalog(source) {
  const names = ['OPTIONAL_BUNDLES', 'ON_DEMAND_BUNDLES', 'RETIRED_BUNDLES', 'EXPERIMENTAL_BUNDLES'];
  const ast = ts.createSourceFile('official-bundles.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(ast.parseDiagnostics.length, 0, 'Invalid official bundle catalog');
  const catalog = {};
  function visit(node) {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) {
      let value = node.initializer;
      if (value && ts.isNewExpression(value) && value.expression.getText(ast) === 'Set') value = value.arguments?.[0];
      const entries = literal(value);
      assert.ok(Array.isArray(entries) && entries.every(name => typeof name === 'string' && name.startsWith('@deepseek-ai/')), 'Unsupported bundle catalog entries');
      catalog[node.name.getText(ast)] = entries;
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const name of names) assert.ok(catalog[name], `Missing official bundle list ${name}`);
  return catalog;
}
async function files(root, suffix) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) result.push(...await files(path.join(root, entry.name), suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) result.push(path.join(root, entry.name));
  }
  return result.sort();
}
function declarationHash(source) {
  const ast = ts.createSourceFile('types.d.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  assert.equal(ast.parseDiagnostics.length, 0, 'Invalid official declaration syntax');
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  const tokens = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
  return hash(JSON.stringify(tokens));
}
// Settings.describe reads owner runtime.Config, not a fixed settings RPC schema.
// Fingerprint the actual schema expressions (including defaults/volatile/validation), never evaluate them.
export function ownerConfigs(source) {
  const ast = ts.createSourceFile('owner.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(ast.parseDiagnostics.length, 0, 'Invalid owner configuration syntax');
  const result = {};
  function visit(node) {
    const variable = ts.isVariableDeclaration(node) && /^Config(?:\$\d+)?$/.test(node.name.getText(ast));
    const member = ts.isPropertyDeclaration(node) && keyOf(node) === 'Config';
    if (variable || member) {
      assert.ok(node.initializer, 'Owner Config has no inspectable initializer');
      let owner = node.parent;
      while (member && owner && !ts.isVariableDeclaration(owner) && !ts.isClassDeclaration(owner)) owner = owner.parent;
      const name = variable ? node.name.getText(ast) : `${owner?.name?.getText(ast) ?? 'default'}.Config`;
      assert.ok(!(name in result), `Duplicate owner Config ${name}`);
      let schema;
      function findSchema(expression) {
        if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === 'object' && ts.isObjectLiteralExpression(expression.arguments[0])) schema ??= expression.arguments[0];
        ts.forEachChild(expression, findSchema);
      }
      findSchema(node.initializer);
      assert.ok(schema, `Owner Config ${name} is no longer an inline object schema; inspect its source`);
      const fields = schema.properties.map(field => {
        const key = keyOf(field);
        assert.ok(key && ts.isPropertyAssignment(field), `Owner Config ${name} contains dynamic fields; inspect its source`);
        return key;
      }).sort();
      result[name] = { fingerprint: declarationHash(node.initializer.getText(ast)), fields };
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}
export async function inspectRuntime(root) {
  const scope = path.join(root, 'node_modules/@deepseek-ai');
  const manifest = JSON.parse(await readFile(path.join(scope, 'dsh/package.json'), 'utf8'));
  assert.equal(manifest.name, '@deepseek-ai/dsh');
  assert.ok(exactVersion.test(manifest.version), 'Invalid DSH version');
  const catalog = bundleCatalog(await readFile(path.join(scope, 'dsh-official-bundles/lib/index.js'), 'utf8'));
  const catalogNames = new Set(Object.values(catalog).flat());
  const packages = {};
  const inventory = [];
  for (const entry of (await readdir(scope, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!monitored.includes(entry.name) && !entry.name.startsWith('dsh-experimental-') && !catalogNames.has(`@deepseek-ai/${entry.name}`)) continue;
    const pkg = path.join(scope, entry.name);
    const meta = JSON.parse(await readFile(path.join(pkg, 'package.json'), 'utf8'));
    assert.equal(meta.name, `@deepseek-ai/${entry.name}`, 'Official package identity must match its directory');
    inventory.push({ name: meta.name, version: meta.version, description: meta.description });
    if (!monitored.includes(entry.name)) continue;
    assert.equal(meta.version, manifest.version, `Mixed official runtime: ${entry.name}`);
    const declarations = {};
    for (const file of await files(path.join(pkg, 'lib/types'), '.d.ts')) declarations[path.relative(pkg, file).split(path.sep).join('/')] = declarationHash(await readFile(file, 'utf8'));
    assert.ok(Object.keys(declarations).length, `Missing declarations: ${entry.name}`);
    let remote = {};
    try { remote = remoteContracts(await readFile(path.join(pkg, 'lib/typert.remote-client.js'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const ownerConfig = settingsPackages.includes(entry.name) ? ownerConfigs(await readFile(path.join(pkg, 'lib/index.js'), 'utf8')) : {};
    packages[entry.name] = { version: meta.version, declarations, remote, ownerConfig };
  }
  for (const name of monitored.filter(name => !teamPackages.includes(name))) assert.ok(packages[name], `Missing monitored package ${name}`);
  assert.ok(teamPackages.some(name => packages[name]), 'Missing both inspected Team package generations');
  return { version: manifest.version, inventory, bundleCatalog: catalog, packages };
}
export function compareRuntimes(baseline, candidate) {
  const changes = [];
  for (const name of new Set([...Object.keys(baseline.bundleCatalog ?? {}), ...Object.keys(candidate.bundleCatalog ?? {})])) {
    if (JSON.stringify(baseline.bundleCatalog?.[name]) !== JSON.stringify(candidate.bundleCatalog?.[name])) changes.push({ package: 'dsh-official-bundles', area: 'bundle-catalog', contract: name, change: 'changed' });
  }
  for (const name of new Set([...Object.keys(baseline.packages), ...Object.keys(candidate.packages)])) {
    const before = baseline.packages[name], after = candidate.packages[name];
    for (const area of ['declarations', 'remote', 'ownerConfig']) {
      for (const key of new Set([...Object.keys(before?.[area] ?? {}), ...Object.keys(after?.[area] ?? {})])) {
        const a = before?.[area]?.[key], b = after?.[area]?.[key];
        if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ package: name, area, contract: key, change: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed' });
      }
    }
  }
  return changes;
}
// Review exceptions bind both sides of one contract, not a package/version-wide waiver.
export function reviewChanges(baseline, candidate, review) {
  const changes = compareRuntimes(baseline, candidate);
  const fingerprint = (runtime, change) => {
    const value = change.area === 'bundle-catalog' ? runtime.bundleCatalog?.[change.contract] : runtime.packages[change.package]?.[change.area]?.[change.contract];
    return value === undefined ? null : hash(JSON.stringify(canonical(value)));
  };
  if (review) {
    assert.equal(review.schemaVersion, 1, 'Unsupported review baseline');
    assert.ok(Array.isArray(review.entries), 'Missing review entries');
    const keys = new Set();
    for (const entry of review.entries) {
      const key = JSON.stringify([entry.package, entry.area, entry.contract]);
      assert.ok(!keys.has(key), 'Duplicate reviewed contract');
      keys.add(key);
      assert.ok(['accepted', 'mobile-change-required'].includes(entry.decision) && entry.reason?.trim(), 'Missing review decision/reason');
      for (const side of ['before', 'after']) assert.ok(entry[side] === null || /^[a-f0-9]{64}$/.test(entry[side]), 'Invalid reviewed fingerprint');
    }
  }
  const entries = review?.baseline === baseline.version && review?.candidate === candidate.version ? review.entries : [];
  const acceptedChanges = [], pendingChanges = [];
  for (const change of changes) {
    const entry = entries.find(entry => entry.package === change.package && entry.area === change.area && entry.contract === change.contract && entry.before === fingerprint(baseline, change) && entry.after === fingerprint(candidate, change));
    if (entry?.decision === 'accepted') acceptedChanges.push({ ...change, reason: entry.reason });
    else pendingChanges.push({ ...change, reason: entry?.reason ?? 'Unreviewed contract or changed release/fingerprint' });
  }
  return { acceptedChanges, pendingChanges };
}
async function mobileReferences() {
  const references = {};
  for (const file of [...await files(path.join(project, 'nsh-app/src'), '.ts'), ...await files(path.join(project, 'nsh-app/src'), '.tsx')]) {
    if (/\.test\.tsx?$/.test(file)) continue;
    const source = await readFile(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['rpc', 'stream'].includes(node.expression.name.text) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const endpoint = node.arguments[0].text;
        (references[endpoint] ??= []).push({ file: path.relative(project, file).split(path.sep).join('/'), line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1 });
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return references;
}
const limits = [
  'Static inspection does not execute upstream code and is not feature parity or live acceptance.',
  'Settings monitoring includes declarations/Remote contracts of the named settings domains. Inline Config expression fingerprints cover the six settings/voice packages only; other owner defaults, activation profiles and installation-specific values also require live describe/readback.',
  'Any monitored descriptor/declaration drift needs review, including compatible additions and schema annotation edits. No automatic baseline update or upgrade.',
  'Mobile references are literal rpc/stream call sites, not proof of rendering, permissions or behavior. Dynamic/wrapped calls may be missed.',
  'Official descriptors sometimes report jsonSchemaError (notably follow/control). These remain explicitly opaque; declaration drift is still checked, not schema compatibility.',
  'Implementation-only behavior changes can escape this static comparison. The bounded official bundle catalog is not an exhaustive public roadmap.',
  'Model catalogs and input capabilities depend on configured providers; no real provider, credentials or model request is used here.',
  'Existing real SessionController, adapter, todo, subagent and registry canaries remain separate semantic gates.',
  'Account announcements are not phone background delivery. Native background notifications, physical devices, approval/question continuation and all provider/tool combinations are not proven by this report.',
];
export async function reportCompatibility(baselineRoot, candidateRoot, review) {
  const [baseline, candidate, mobile] = await Promise.all([inspectRuntime(baselineRoot), inspectRuntime(candidateRoot), mobileReferences()]);
  const changes = compareRuntimes(baseline, candidate);
  const { acceptedChanges, pendingChanges } = reviewChanges(baseline, candidate, review);
  const mobileFeatureGaps = [];
  for (const [name, pkg] of Object.entries(candidate.packages)) {
    for (const endpoint of Object.keys(pkg.remote)) if (!mobile[endpoint]) mobileFeatureGaps.push({ package: name, endpoint, status: 'no-literal-mobile-reference', action: 'review relevance; not automatically a missing feature' });
  }
  const settingsReview = changes.filter(change => change.area === 'ownerConfig').map(change => {
    const before = baseline.packages[change.package]?.ownerConfig[change.contract]?.fields ?? [];
    const after = candidate.packages[change.package]?.ownerConfig[change.contract]?.fields ?? [];
    return { ...change, addedFields: after.filter(field => !before.includes(field)), removedFields: before.filter(field => !after.includes(field)), action: 'Review phone settings coverage and read/write/readback support before adaptation' };
  });
  return { schemaVersion: 1, kind: 'official-dsh-contract-review', status: pendingChanges.length ? 'review-required' : changes.length ? 'reviewed-static-drift' : 'no-monitored-static-drift', generatedAt: new Date().toISOString(), baseline, candidate, changes, acceptedChanges, pendingChanges, mobileReferences: mobile, mobileFeatureGaps, settingsReview, limits };
}
async function jsonFetch(url, github = false, body) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), headers: github ? { accept: 'application/vnd.github+json', ...(body ? { 'content-type': 'application/json' } : {}), ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) } : {} });
  assert.ok(response.ok, `Metadata request failed (${response.status}): ${new URL(url).pathname}`);
  return response.json();
}
export function channelMetadata(packument, defaultBaseline, requested) {
  const channels = ['latest', 'next', 'alpha'];
  assert.ok(channels.includes(requested) || exactVersion.test(requested), 'Request must be latest, next, alpha or an exact version');
  const distTags = packument['dist-tags'];
  const selected = distTags[requested] ?? requested;
  const baseline = selected === alphaReviewPair.candidate ? alphaReviewPair.baseline : defaultBaseline;
  assert.ok(exactVersion.test(baseline), 'Baseline must be an exact inspected version');
  const taggedVersions = channels.filter(tag => tag !== 'alpha' || Object.hasOwn(distTags, tag)).map(tag => distTags[tag]);
  const versions = {};
  for (const version of new Set([baseline, selected, ...taggedVersions])) {
    const meta = packument.versions[version];
    assert.ok(meta && exactVersion.test(version), `Missing official release metadata: ${version}`);
    assert.ok(meta.dist?.integrity && meta.dist?.tarball?.startsWith('https://registry.npmjs.org/'), 'Missing official integrity/tarball');
    versions[version] = { version, publishedAt: packument.time?.[version], integrity: meta.dist.integrity, tarball: meta.dist.tarball, gitHead: meta.gitHead, engines: meta.engines, dependencies: meta.dependencies };
  }
  return { schemaVersion: 1, baseline, requested, selected, releaseKey: hash(`${selected}:${versions[selected].integrity}`), distTags, versions };
}
async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(['--baseline-root', '--runtime-root', '--output-dir', '--baseline-version', '--requested', '--review-baseline'].includes(args[i]) && args[i + 1] && !options[args[i]], 'Unknown, duplicate or incomplete option');
    options[args[i]] = args[i + 1];
  }
  const output = options['--output-dir'];
  assert.ok(output, '--output-dir is required (use an ignored scratch/CI directory)');
  await mkdir(output, { recursive: true });
  if (mode === 'metadata') {
    const metadata = channelMetadata(await jsonFetch('https://registry.npmjs.org/@deepseek-ai%2fdsh'), options['--baseline-version'], options['--requested']);
    // Write resolved npm evidence before GitHub, so a GitHub outage cannot erase it.
    await writeFile(path.join(output, 'channels.json'), JSON.stringify(metadata, null, 2));
    const upstream = {};
    for (const [name, url] of Object.entries({ releases: 'releases?per_page=10', repository: '', issues: 'issues?state=open&per_page=30' })) {
      try { upstream[name] = { status: 'read', value: await jsonFetch(`https://api.github.com/repos/deepseek-ai/deepseek-harness${url ? `/${url}` : ''}`, true) }; }
      catch (error) { upstream[name] = { status: 'unavailable', reason: error.message }; }
    }
    // The official repository directs feedback to Discussions, not Issues. This is a bounded feed, not a roadmap guarantee.
    try {
      const result = await jsonFetch('https://api.github.com/graphql', true, { query: 'query { repository(owner:"deepseek-ai", name:"deepseek-harness") { discussions(first:20, orderBy:{field:UPDATED_AT,direction:DESC}) { nodes { number title url updatedAt category { name } } } } }' });
      assert.ok(!result.errors && result.data?.repository?.discussions, 'Public discussion query unavailable');
      upstream.discussions = { status: 'read', value: result.data.repository.discussions, coverage: '20 most recently updated; not an exhaustive roadmap' };
    } catch (error) { upstream.discussions = { status: 'unavailable', reason: error.message }; }
    await writeFile(path.join(output, 'upstream.json'), JSON.stringify(upstream, null, 2));
    console.log(JSON.stringify({ baseline: metadata.baseline, selected: metadata.selected, distTags: metadata.distTags, upstream: Object.fromEntries(Object.entries(upstream).map(([key, value]) => [key, value.status])) }, null, 2));
    return;
  }
  assert.equal(mode, 'compare', 'Use metadata or compare');
  assert.ok(options['--baseline-root'] && options['--runtime-root'], 'Both inspected runtime roots are required');
  try {
    const review = options['--review-baseline'] ? JSON.parse(await readFile(options['--review-baseline'], 'utf8')) : undefined;
    const report = await reportCompatibility(options['--baseline-root'], options['--runtime-root'], review);
    await writeFile(path.join(output, 'compatibility.json'), JSON.stringify(report, null, 2));
    const summary = [`## Official DSH compatibility: ${report.status}`, '', `Inspected baseline **${report.baseline.version}** → candidate **${report.candidate.version}**.`, '', `${report.changes.length} monitored contract/declaration changes: ${report.acceptedChanges.length} explicitly accepted, ${report.pendingChanges.length} pending. ${report.mobileFeatureGaps.length} endpoints without a literal mobile reference (review candidates, not parity verdicts).`, '', '### Pending changes', ...report.pendingChanges.map(change => `- ${change.change}: ${change.package} / ${change.area} / ${change.contract}: ${change.reason}`), '', '### Accepted changes', ...report.acceptedChanges.map(change => `- ${change.change}: ${change.package} / ${change.area} / ${change.contract}: ${change.reason}`), '', '### Limits', ...report.limits.map(limit => `- ${limit}`), '', 'See compatibility.json for complete contracts, evidence inventory and mobile call sites.'].join('\n');
    await writeFile(path.join(output, 'compatibility.md'), `${summary}\n\n### Settings owner review candidates\n${report.settingsReview.map(change => `- ${change.package} / ${change.contract}: added [${change.addedFields.join(', ')}], removed [${change.removedFields.join(', ')}]; ${change.action}`).join('\n')}\n`);
    console.log(summary);
    process.exitCode = report.pendingChanges.length ? 2 : 0;
  } catch (error) {
    await writeFile(path.join(output, 'compatibility.json'), JSON.stringify({ schemaVersion: 1, status: 'inspection-failed', error: error.message, limits }, null, 2));
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
