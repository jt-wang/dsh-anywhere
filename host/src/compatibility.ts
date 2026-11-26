/** DSH ships a pre-release every other day, and DSH Desktop updates itself. A line is verified once inspected and run:
 * 0.2.1 with every tag (rc.3 → rc.5 changed none of the packages the adapter uses, only version numbers in them);
 * 0.2.2 from its release candidates on, because only rc.1 was run (the DSH canary and the packed-plugin load) and
 * alpha.2 left resumed empty sessions in the session list; 0.2.3 with every tag. */
const LINES = [['0.2.1', ['alpha', 'beta', 'rc']], ['0.2.2', ['rc']], ['0.2.3', ['alpha', 'beta', 'rc']]] as const;
const EXACT = ['0.2.0-rc.2'] as const;
/** Every later version below 1.0.0 is accepted unverified, so the phone stays connected on the day DSH ships a new
 * line. The DSH canary (tools/dsh-canary/compatibility.mjs upcoming) turns red before that line reaches npm; inspect
 * and run it, then add it to LINES. The floor stays 0.2.4-0 when a later line is verified, so verifying 0.3.0 does
 * not refuse a 0.2.4 that phones were already on. */
export const UNVERIFIED_FROM = '0.2.4-0';
const UNVERIFIED_BELOW = '1.0.0-0';
const PLAIN = /^(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.(?:0|[1-9]\d*))?$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

/** `engines.dsh` of the install package (tools/pack-bundle.mjs): the same versions as isCompatibleDshVersion, as a
 * SemVer range. DSH checks it with prereleases included (dsh-app-boot evaluatePluginCompatibility) when the package
 * is added, at startup and for each row it inserts. `<x.y.z-alpha.a` bounds each tag to `alpha.<number>`. */
export const DSH_ENGINES_RANGE = [...EXACT, ...LINES.flatMap(([line, tags]) => [...tags.map(tag => `>=${line}-${tag}.0 <${line}-${tag}.a`), line]), `>=${UNVERIFIED_FROM} <${UNVERIFIED_BELOW}`].join(' || ');
export const SUPPORTED_DSH_VERSIONS = '0.2.0-rc.2, every 0.2.1 or 0.2.3 release or pre-release, every 0.2.2 release candidate or release, and every later version below 1.0.0';

/** Inspected and run by the DSH canary. */
export function isVerifiedDshVersion(value: string): boolean {
  if ((EXACT as readonly string[]).includes(value)) return true;
  const match = PLAIN.exec(value);
  const line = match && LINES.find(([base]) => base === match[1]);
  return !!line && (match[2] === undefined || (line[1] as readonly string[]).includes(match[2]));
}
export function isCompatibleDshVersion(value: string): boolean {
  return isVerifiedDshVersion(value) || (SEMVER.test(value) && compareDshVersions(value, UNVERIFIED_FROM) >= 0 && compareDshVersions(value, UNVERIFIED_BELOW) < 0);
}

export const isDshSemver = (value: string): boolean => SEMVER.test(value);

/** SemVer 2.0.0 precedence of two versions that pass isDshSemver. */
export function compareDshVersions(a: string, b: string): number {
  const [x, y] = [a, b].map(value => SEMVER.exec(value)!);
  for (let i = 1; i <= 3; i++) if (Number(x![i]) !== Number(y![i])) return Number(x![i]) - Number(y![i]);
  if (x![4] === undefined || y![4] === undefined) return x![4] === y![4] ? 0 : x![4] === undefined ? 1 : -1;
  const p = x![4].split('.'), q = y![4].split('.');
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p[i]!), qn = /^\d+$/.test(q[i]!);
    if (pn && qn) { if (Number(p[i]) !== Number(q[i])) return Number(p[i]) - Number(q[i]); }
    else if (pn !== qn) return pn ? -1 : 1;
    else if (p[i] !== q[i]) return p[i]! < q[i]! ? -1 : 1;
  }
  return 0;
}
