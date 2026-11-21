// What the companion needs when DSH loads it from the bundle row (`dsh plugin add @jt-wang/dsh-anywhere`),
// which carries no configuration: the private configuration path, the running DSH version and whether an
// install-host companion is already set up in the same profile.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, posix, sep, win32 } from 'node:path';

/** The private folder's name. Releases up to 0.8.3 (when the project was still called DSH Mobile) used `DSHMobile`. */
export const DATA_FOLDER = 'DSHAnywhere', LEGACY_DATA_FOLDER = 'DSHMobile';

/** The companion's private folder: ~/Library/Application Support on a Mac (Apple silicon and Intel), %LOCALAPPDATA% on
 * Windows, $XDG_DATA_HOME (~/.local/share) elsewhere. tools/install-host.mjs and tools/install-host.ps1 use the same rule. */
export function dataFolder(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir(), name: string = DATA_FOLDER): string {
  const path = platform === 'win32' ? win32 : posix;
  const absolute = (value: string | undefined) => value && path.isAbsolute(value) ? value : undefined;
  return platform === 'darwin' ? path.join(home, 'Library', 'Application Support', name)
    : platform === 'win32' ? path.join(absolute(env.LOCALAPPDATA) ?? path.join(home, 'AppData', 'Local'), name)
    : path.join(absolute(env.XDG_DATA_HOME) ?? path.join(home, '.local', 'share'), name);
}
export function defaultConfigPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const path = platform === 'win32' ? win32 : posix;
  return path.join(dataFolder(platform, env, home), 'host', 'host.json');
}

/** Moves a folder kept under its old name to the new name, once. The move is one rename, so an interrupted start
 * leaves either the old folder or the new one, never half of each. A new folder that already exists is never
 * overwritten (the old one is then left alone). Returns the folder to use: the old one only when the rename failed
 * (Windows refuses while a file in it is open), so this start runs from it and the next start tries again. */
export function adoptLegacyFolder(legacy: string, current: string): string {
  if (existsSync(current) || !existsSync(legacy)) return current;
  try { renameSync(legacy, current); return current; } catch { return existsSync(current) ? current : legacy; }
}

/** host.json names its own files by absolute path (statePath, tls, relay token). After the folder moved, points the ones
 * inside the old folder at the new one. Runs on every start, so a start interrupted between the move and this rewrite
 * is completed by the next one. The rewrite is a new file renamed over the old, so host.json is always whole. */
export function retargetConfiguration(configPath: string, legacy: string, current: string): void {
  if (legacy === current || !existsSync(configPath)) return;
  const text = readFileSync(configPath, 'utf8');
  let changed = false;
  const fix = (value: unknown): unknown => {
    if (typeof value === 'string' && (value === legacy || value.startsWith(legacy + sep))) { changed = true; return current + value.slice(legacy.length); }
    if (Array.isArray(value)) return value.map(fix);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fix(item)]));
    return value;
  };
  const updated = fix(JSON.parse(text));
  if (!changed) return;
  // Same folder, so the folder's owner-only permissions (Windows: its inherited ACL) cover the new file.
  const staged = `${configPath}.moving`;
  writeFileSync(staged, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(staged, 0o600);
  renameSync(staged, configPath);
}

/** The bundle row's configuration path, after moving the companion's `host` folder from DSHMobile to DSHAnywhere (and
 * fixing host.json's paths). The `host` folder is what moves, not the whole private folder: DSHAnywhere can exist
 * already without it (the release keys of a computer that builds DSH Anywhere live in DSHAnywhere/signing, measured
 * 2026-11-21), and an install-host companion's own files (plugin, backups, install-receipt.json) stay in DSHMobile. */
export function currentConfigPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const path = platform === 'win32' ? win32 : posix;
  const legacy = dataFolder(platform, env, home, LEGACY_DATA_FOLDER), current = dataFolder(platform, env, home);
  if (!existsSync(path.join(current, 'host')) && existsSync(path.join(legacy, 'host'))) mkdirSync(current, { recursive: true, mode: 0o700 });
  const folder = adoptLegacyFolder(path.join(legacy, 'host'), path.join(current, 'host')) === path.join(current, 'host') ? current : legacy;
  const configPath = path.join(folder, 'host', 'host.json');
  if (folder === current) {
    retargetConfiguration(configPath, legacy, current);
    // DSHMobile held only the moved folder: nothing is left of it. rmdir refuses a folder with anything in it.
    try { rmdirSync(legacy); } catch {}
  }
  return configPath;
}
/** Where an install-host companion (tools/install-host.mjs, before the rename) keeps its files: it is not moved while
 * its block is in the profile, since that block names the old folder. */
export function legacyConfigPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const path = platform === 'win32' ? win32 : posix;
  const legacy = dataFolder(platform, env, home, LEGACY_DATA_FOLDER);
  return existsSync(legacy) ? path.join(legacy, 'host', 'host.json') : defaultConfigPath(platform, env, home);
}

/** DSH's `profileContext` service (dsh/lib/profile-boot: runProfile provides it to every profile plugin). */
export interface ProfileFacts { readonly installAnchor?: unknown; readonly patchPath?: unknown }

/** The running DSH's version, read where DSH reads it. DSH 0.2.1-rc.3, inspected 2026-10-31 in the Desktop app.asar:
 * - dsh-app-boot `getDshRuntimeVersion()` is the `version` of dsh-app-boot's own package.json; DSH checks every
 *   plugin's `engines.dsh` against it (`evaluatePluginCompatibility`, at install, startup and each inserted row).
 * - runProfile provides `profileContext.installAnchor` = the installation's @deepseek-ai/dsh package.json (Desktop:
 *   `<runtime>/node_modules/@deepseek-ai/dsh/package.json`, dsh-desktop-host), and @deepseek-ai/dsh imports
 *   @deepseek-ai/dsh-app-boot, so resolving it from that anchor finds the copy DSH runs. app-boot exports ./package.json.
 * Undefined when there is no profile context or the package cannot be read; the caller fails closed. */
export function runningDshVersion(profile: ProfileFacts | undefined): string | undefined {
  const anchor = profile?.installAnchor;
  if (typeof anchor !== 'string' || !isAbsolute(anchor)) return undefined;
  try {
    const manifest = createRequire(anchor)('@deepseek-ai/dsh-app-boot/package.json') as { name?: unknown; version?: unknown };
    return manifest.name === '@deepseek-ai/dsh-app-boot' && typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch { return undefined; }
}

/** tools/install-host.mjs writes its companion between these markers in the profile's cordis.patch.yml. */
export const LEGACY_BEGIN = '# DSH-MOBILE-COMPANION-BEGIN';
/** Whether the profile patch holds an install-host companion block. Both companions would share the private
 * configuration (port, state, Tailcat node), so the bundle row stands down while that block exists. */
export function legacyCompanionActive(profile: ProfileFacts | undefined): boolean {
  const path = profile?.patchPath;
  if (typeof path !== 'string' || !isAbsolute(path)) return false;
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return false; }
  return text.split(/\r?\n/).some(line => line.startsWith(LEGACY_BEGIN));
}
