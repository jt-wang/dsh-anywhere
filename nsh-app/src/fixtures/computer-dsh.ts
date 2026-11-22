// A stand-in DSH for src/computer-settings.test.tsx, shaped as DSH 0.2.2-rc.5 answers settings/describe,
// permissionPresets/catalog and pluginManager/* (dsh-settings types.ts, dsh-plugin-manager types.ts), behind the
// companion's /dsh relay and its /v1/capabilities. Synthetic values only; every call is kept in `calls`.
export const ORIGIN = 'http://127.0.0.1:40001/dsh'
export const SELF = '@jt-wang/dsh-anywhere'
export const VOICE = '@deepseek-ai/dsh-experimental-voice-input-bundle'

type Json = any
const ns = (name: string, value: Record<string, Json>, extra: Record<string, Json> = {}) => ({ ns: name, schema: {}, value, base: {}, user: value, revision: 1, applies: 'live', autoGenerate: false, secrets: [], ...extra })

export function computerDsh(options: { control?: boolean; down?: boolean; slow?: boolean; selfVersion?: string } = {}) {
  const selfVersion = options.selfVersion ?? '0.8.7'
  let down = !!options.down, conflict = false
  const calls: { method: string; args: Record<string, Json> }[] = []
  const namespaces = [
    ns('permission', {}),
    ns('locale', {}),
    ns('ui-theme', { preference: 'system', fontSize: 14, codeFontSize: 11, terminalFontSize: 13, textFontFamily: '', codeFontFamily: '', terminalFontFamily: '' }),
    ns('ui-settings', { enabled: true }),
    ns('ui-conversation', { busyEnter: 'queue' }),
    ns('session-log-deepseek', { enabled: true }),
    ns('subagent', { maxDepth: 1, maxActiveSubagents: 8 }),
    ns('subagent-model-selection-settings', { enabled: false }),
    ns('bash-sandbox', { timeoutMs: 60000, maxOutputBytes: 64000 }),
    // A plugin's own volatile Config, served for a generic form (Schemastery envelope).
    ns('auto-review', { enabled: true, maxRetries: 2 }, { autoGenerate: true, schema: { uid: 3, refs: { 1: { type: 'boolean' }, 2: { type: 'number' }, 3: { type: 'object', dict: { enabled: 1, maxRetries: 2 } } } } }),
  ]
  const bundle = (name: string, b: Record<string, Json>): Record<string, Json> => ({ name, official: true, availability: 'installation', installed: true, optional: true, rows: [], overrides: [], ...b })
  const bundles = [
    bundle(VOICE, { version: '0.2.2', enabled: false, removable: true, update: 'registry', meta: { title: { en: 'Voice input' }, description: { en: 'Transcribe recordings locally.' } } }),
    bundle('@deepseek-ai/dsh-cua-bundle', { version: '0.2.2', enabled: true, removable: false, listedByDefault: true }),
    bundle(SELF, { official: false, availability: 'profile', version: selfVersion, enabled: true, removable: true, update: 'registry', meta: { title: 'DSH Anywhere' } }),
  ]
  const registry = { url: 'https://registry.npmjs.org/' }
  const newer: Record<string, string> = { [SELF]: '0.8.8', [VOICE]: '0.2.3' }
  const applied = (target: string) => ({ changed: true, application: 'applied', stage: 'enable', target })
  const answer = (method: string, args: Record<string, Json>): Json => {
    switch (method) {
      case 'session/list': return { items: [] }
      case 'settings/describe': return { writable: true, hasDocument: true, namespaces }
      case 'permissionPresets/catalog': {
        const options = ['read-only', 'workspace-write', 'danger-full-access'].map(v => ({ value: v, name: v }))
        return { options, defaultOptions: options, defaultPreset: 'workspace-write' }
      }
      case 'settings/mutate': {
        if (conflict) { conflict = false; throw Object.assign(new Error('changed'), { code: 'settings/conflict' }) }
        const n = namespaces.find(x => x.ns === args.ns)!
        if (args.expectedRevision !== n.revision) throw Object.assign(new Error('changed'), { code: 'settings/conflict' })
        for (const op of args.ops) {
          let at: Json = n.value
          for (const k of op.path.slice(0, -1)) at = at[k] ??= {}
          if (op.op === 'set') at[op.path.at(-1)] = op.value; else delete at[op.path.at(-1)]
        }
        n.revision++
        return n
      }
      case 'pluginManager/listBundles': return bundles
      case 'pluginManager/listVersions': return { status: 'listed', installed: bundles.find(b => b.name === args.name)?.version, registry, attempts: [{ registry }], versions: [{ version: newer[args.name], tags: ['latest'], prerelease: false, bundle: true }], omitted: 0 }
      case 'pluginManager/setBundleEnabled': { const b = bundles.find(x => x.name === args.name)!; b.enabled = args.enabled; return applied(b.name) }
      case 'pluginManager/removeBundle': return applied(args.name)
      case 'pluginManager/updateBundle': return { from: bundles.find(b => b.name === args.name)?.version, to: args.version, step: 'install', result: applied(args.name) }
      default: throw Object.assign(new Error('unknown method'), { code: 'gateway/bad-request' })
    }
  }
  const network = {
    'GET http://127.0.0.1:40001/v1/capabilities': () => ({ body: { hostName: 'DSH Anywhere companion', computerName: 'Studio', hostVersion: selfVersion, release: '0.1.18', upstreamVersion: '0.2.2-rc.5', capabilities: { control: options.control !== false } } }),
    [`POST ${ORIGIN}/api/*`]: (request: { url: string; body?: string | null }) => {
      const method = request.url.slice(`${ORIGIN}/api/`.length)
      if (down && method !== 'session/list') return { status: 503 }
      if (options.slow && method === 'settings/describe') return { delay: 600000, status: 503 }
      const frame = JSON.parse(request.body ?? '{}'), args = frame?.payload?.args ?? {}
      calls.push({ method, args })
      try { return { body: { type: 'server-response', rpcId: frame.rpcId, result: { ok: true, value: answer(method, args) } } } }
      catch (e) { return { body: { type: 'server-response', rpcId: frame.rpcId, result: { ok: false, error: { code: (e as { code?: string }).code ?? 'gateway/internal', message: String((e as Error).message) } } } } }
    },
  }
  return { network, calls, conflictNext: () => { conflict = true }, up: () => { down = false } }
}
