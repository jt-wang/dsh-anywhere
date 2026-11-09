/** DSH ships a pre-release every other day. An exact list cut every phone off at each update, so a line is accepted
 * whole once inspected and run: 0.2.1 with every tag (rc.3 → rc.5 changed none of the packages the adapter uses, only
 * version numbers in them); 0.2.2 from its release candidates on, because only rc.1 was run (the DSH canary and the packed-plugin
 * load) and alpha.2 left resumed empty sessions in the session list. A new line still needs inspection
 * and a canary before it is added. */
const LINES = [['0.2.1', ['alpha', 'beta', 'rc']], ['0.2.2', ['rc']]] as const;
const EXACT = ['0.2.0-rc.2'] as const;
const PLAIN = /^(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.(?:0|[1-9]\d*))?$/;

/** `engines.dsh` of the install package (tools/pack-bundle.mjs): the same versions as isCompatibleDshVersion, as a
 * SemVer range. DSH checks it with prereleases included (dsh-app-boot evaluatePluginCompatibility) when the package
 * is added, at startup and for each row it inserts. `<x.y.z-alpha.a` bounds each tag to `alpha.<number>`. */
export const DSH_ENGINES_RANGE = [...EXACT, ...LINES.flatMap(([line, tags]) => [...tags.map(tag => `>=${line}-${tag}.0 <${line}-${tag}.a`), line])].join(' || ');
export const SUPPORTED_DSH_VERSIONS = '0.2.0-rc.2, every 0.2.1 release or pre-release, and every 0.2.2 release candidate or release';
export function isCompatibleDshVersion(value: string): boolean {
  if ((EXACT as readonly string[]).includes(value)) return true;
  const match = PLAIN.exec(value);
  const line = match && LINES.find(([base]) => base === match[1]);
  return !!line && (match[2] === undefined || (line[1] as readonly string[]).includes(match[2]));
}
