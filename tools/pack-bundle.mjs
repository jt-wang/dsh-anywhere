#!/usr/bin/env node
// Packs the built host (host/dist with the Tailcat helper of every computer DSH Desktop ships for: Apple-silicon and
// Intel Macs, Windows x64) as the npm package @jt-wang/dsh-anywhere, which DSH Desktop installs with `dsh plugin --profile desktop add @jt-wang/dsh-anywhere` and updates with its own plugin
// manager. The release workflow publishes this file to npm and attaches it to the GitHub release. Never use the bare
// name `dsh-anywhere`: on npm that is another author's DSH plugin.
//   node tools/pack-bundle.mjs [--out <dir>] [--host <built host dir>] [--only <goos-goarch>]
// --only packs a single helper, for a CI computer that cannot build the others (Windows and Linux have no macOS SDK);
// never publish such a package. A release packs no Linux helper: DSH Desktop has no Linux build (DSH's
// apps/desktop/scripts/package-target.ts targets mac-arm64, mac-x64 and win-x64), so the Linux CI check packs its own.
// npm-pack layout (`package/` prefix). No scripts and no dependencies: DSH's bundled pnpm refuses packages with
// install scripts, and ws is bundled into dist/plugin.js. The archive is byte-for-byte reproducible from one build.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = message => { console.error(message); process.exit(1); };
const args = process.argv.slice(2), flags = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--out', '--host', '--only'].includes(args[i]) || !args[i + 1] || flags.has(args[i])) fail('Usage: node tools/pack-bundle.mjs [--out <dir>] [--host <built host dir>] [--only <goos-goarch>]');
  flags.set(args[i], args[i] === '--only' ? args[i + 1] : path.resolve(args[i + 1]));
}
const host = flags.get('--host') ?? path.join(root, 'host'), out = flags.get('--out') ?? path.join(root, 'build', 'bundle');

// ROW_ID stays the one every release before 0.8.1 used, so DSH sees one companion row, whichever package carries it.
const NAME = '@jt-wang/dsh-anywhere', FILE = 'dsh-anywhere.tgz', ROW_ID = 'dsh-anywhere';
// bundledTailcatHelper (host/src/tailcat-connector.ts) picks the one for the computer DSH runs on.
const PLATFORMS = ['darwin-arm64', 'darwin-amd64', 'windows-amd64'];
const only = flags.get('--only');
if (only !== undefined && ![...PLATFORMS, 'linux-amd64'].includes(only)) fail(`--only takes one of ${PLATFORMS.join(', ')}, linux-amd64`);
const HELPERS = (only ? [only] : PLATFORMS).map(platform => `dsh-tailcat-host-${platform}${platform.startsWith('windows-') ? '.exe' : ''}`);
const pkg = JSON.parse(readFileSync(path.join(host, 'package.json'), 'utf8'));
for (const required of ['dist/plugin.js', 'dist/client.js', 'dist/compatibility.js'])
  if (!existsSync(path.join(host, required))) fail(`Missing ${required}. Run "npm ci && npm run build" in host/ first.`);
for (const helper of HELPERS)
  if (!existsSync(path.join(host, 'dist', 'tailcat', helper))) fail(`Missing dist/tailcat/${helper}. Run tools/build-tailcat.sh, then "npm run build" in host/; nothing was packed.`);
const { DSH_ENGINES_RANGE } = await import(pathToFileURL(path.join(host, 'dist', 'compatibility.js')).href);

// 1. The host half: one ES module with ws inside. ws loads its optional native addons with require() in a try block,
// so they stay external and are simply absent; the banner gives the bundle a require for that and for node built-ins.
const { build } = createRequire(path.join(root, 'host', 'package.json'))('esbuild');
// absWorkingDir: esbuild writes each module's path, relative to this folder, into the bundle's comments.
const bundled = await build({ absWorkingDir: path.resolve(host), entryPoints: [path.join(host, 'dist', 'plugin.js')], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24',
  external: ['bufferutil', 'utf-8-validate'], legalComments: 'inline', logLevel: 'error',
  banner: { js: 'import { createRequire as __dshAnywhereRequire } from "node:module"; const require = __dshAnywhereRequire(import.meta.url);' } });
const plugin = bundled.outputFiles[0].contents;

// 2. The browser half (Settings → DSH Anywhere, and the plugin's own page). DSH registers a client module under its package's name.
const client = readFileSync(path.join(host, 'dist', 'client.js'), 'utf8');
const header = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},`;
if (!client.startsWith(header)) fail('dist/client.js does not start with the module-loader header tools/build-host.mjs writes.');
const renamed = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(NAME)},` + client.slice(header.length);

// 3. What DSH's Plugins page shows: title and description per language (locale/<language id>.json, `meta`, read like
// DSH's own experimental plugins), and the app's icon. A language without a file reads English.
const TITLE = 'DSH Anywhere';
const META = {
  en: 'Use DSH Desktop on this computer from your phone: chats, agents and approvals, over Tailcat.',
  zh: '在手机上使用这台电脑上的 DSH Desktop：对话、智能体和审批，通过 Tailcat 连接。',
  'zh-hant': '在手機上使用這台電腦上的 DSH Desktop：對話、代理程式與審核，透過 Tailcat 連線。',
  ja: 'このコンピュータの DSH Desktop をスマートフォンから使えます。チャット、エージェント、承認を Tailcat 経由で。',
  ko: '휴대폰에서 이 컴퓨터의 DSH Desktop을 사용하세요. 채팅, 에이전트, 승인을 Tailcat으로 연결합니다.',
  es: 'Usa DSH Desktop de este ordenador desde el teléfono: chats, agentes y aprobaciones, a través de Tailcat.',
  fr: 'Utilisez DSH Desktop de cet ordinateur depuis votre téléphone : conversations, agents et validations, via Tailcat.',
  ru: 'Пользуйтесь DSH Desktop на этом компьютере с телефона: чаты, агенты и подтверждения через Tailcat.',
};
for (const language of Object.keys(META)) META[language] = { title: TITLE, description: META[language] };
const icon = readFileSync(path.join(root, 'nsh-app', 'assets', 'brand', 'icon.svg'));

// 4. Manifest and bundle patch. The row has no configuration: the companion finds the running DSH version and creates
// its private Tailcat configuration on first start (host/src/zero-config.ts).
const manifest = {
  name: NAME, version: pkg.version, description: META.en.description, license: 'MIT', type: 'module', icon: './icon.svg',
  // npm checks provenance against this repository; scoped packages are private unless published public.
  repository: { type: 'git', url: 'git+https://github.com/jt-wang/dsh-anywhere.git' }, publishConfig: { access: 'public' },
  engines: { dsh: DSH_ENGINES_RANGE },
  exports: { '.': './dist/plugin.js', './client': './dist/client.js', './package.json': './package.json', './locale/*.json': './locale/*.json' },
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: pkg.dsh.client },
};
// The row names the package (its "." export), as DSH's own bundles do: DSH reads a row's title, description and icon
// from the package a bare name resolves to, and shows a path for a relative one.
const patch = `# DSH Anywhere ${pkg.version}. DSH applies this before the profile's own cordis.patch.yml.\n- insert:\n    - id: ${ROW_ID}\n      name: '${NAME}'\n      config: {}\n`;

const files = [
  ['package/package.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), 0o644],
  ['package/cordis.patch.yml', Buffer.from(patch), 0o644],
  ['package/LICENSE', readFileSync(path.join(root, 'LICENSE')), 0o644],
  ['package/icon.svg', icon, 0o644],
  ...Object.entries(META).map(([language, meta]) => [`package/locale/${language}.json`, Buffer.from(JSON.stringify({ meta }, null, 2) + '\n'), 0o644]),
  ['package/dist/plugin.js', Buffer.from(plugin), 0o644],
  ['package/dist/client.js', Buffer.from(renamed), 0o644],
  ...HELPERS.map(helper => [`package/dist/tailcat/${helper}`, readFileSync(path.join(host, 'dist', 'tailcat', helper)), 0o755]),
];

// 5. ustar archive with fixed owner and time (npm pack uses the same date), gzip without a timestamp.
const MTIME = Math.floor(Date.UTC(1985, 9, 26, 8, 15) / 1000);
function header512(name, size, mode) {
  if (Buffer.byteLength(name) > 100) fail(`Path too long for the archive: ${name}`);
  const block = Buffer.alloc(512);
  const put = (text, offset, length) => block.write(text, offset, length, 'utf8');
  const octal = (value, length) => value.toString(8).padStart(length - 1, '0') + '\0';
  put(name, 0, 100); put(octal(mode, 8), 100, 8); put(octal(0, 8), 108, 8); put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12); put(octal(MTIME, 12), 136, 12); put('        ', 148, 8); put('0', 156, 1);
  put('ustar\0', 257, 6); put('00', 263, 2);
  let sum = 0; for (const byte of block) sum += byte;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return block;
}
const parts = [];
for (const [name, data, mode] of files) parts.push(header512(name, data.length, mode), data, Buffer.alloc((512 - data.length % 512) % 512));
parts.push(Buffer.alloc(1024));
const archive = gzipSync(Buffer.concat(parts), { level: 9 });

mkdirSync(out, { recursive: true });
const target = path.join(out, FILE), staged = `${target}.${process.pid}.tmp`;
writeFileSync(staged, archive); renameSync(staged, target);
console.log(`Packed ${files.length} files, ${statSync(target).size} bytes, engines.dsh "${DSH_ENGINES_RANGE}".`);
console.log(target);
