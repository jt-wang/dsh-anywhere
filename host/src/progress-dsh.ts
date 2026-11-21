// Progress's sources in a real DSH process: the session controller's list, cold-safe follow openings and projections,
// DSH's workspace registry for project names and order, and one call through DSH's own llm service on the chat's own model route
// (inspected DSH 0.2.2-rc.1 and 0.2.1-rc.3).
import { basename, isAbsolute, join } from 'node:path';
import type { DshSessionController } from './dsh-adapter.ts';
import { adoptLegacyFolder } from './zero-config.ts';
import type { ProgressSources } from './progress.ts';
import type { DshWorkspaceRegistry } from './workspace-source.ts';

/** DSH's llm service as the judgement uses it: a stream of chunks whose text-delta parts make the reply. */
export interface DshLlmStream {
  stream(options: { provider: string; model: string; system: string; messages: { role: 'user'; content: { type: 'text'; text: string }[] }[]; signal: AbortSignal }): AsyncIterable<{ type: string; text?: string }>;
}

/** Where the split is kept: `<DSH home>/dsh-anywhere/progress` (profileContext.home, the Harness home), else the folder the
 * plugin's row names. A `<DSH home>/dsh-mobile` folder from 0.8.2 and earlier is moved to `dsh-anywhere` first. */
export function progressDirectory(profile: { home?: unknown } | undefined, fallback: unknown): string | undefined {
  if (typeof profile?.home === 'string' && isAbsolute(profile.home)) return join(adoptLegacyFolder(join(profile.home, 'dsh-mobile'), join(profile.home, 'dsh-anywhere')), 'progress');
  return typeof fallback === 'string' && isAbsolute(fallback) ? fallback : undefined;
}

const obj = (v: unknown): Record<string, any> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : undefined);

export function dshProgressSources(options: { sessionController: DshSessionController; workspaceRegistry?: () => DshWorkspaceRegistry | undefined; llm?: () => DshLlmStream | undefined }): ProgressSources {
  const sc = options.sessionController;
  return {
    async sessions(signal) {
      const { items } = await sc.list({}, signal);
      return items.map(row => ({
        sessionId: row.sessionId, title: typeof row.projections?.values?.title === 'string' ? row.projections.values.title : '',
        running: row.running === true, updatedAt: Number(row.updatedAt) || 0,
        ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}), ...(typeof row.origin === 'string' ? { origin: row.origin } : {}), ...(row.blank ? { blank: true } : {}),
      }));
    },
    // The first frame only: a second pull can promote a cold chat to a running Agent (docs/DSH_INTEGRATION.md).
    async opening(sessionId, signal) {
      const cleanup = new AbortController();
      const iterator = sc.follow({ address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 100 }, AbortSignal.any([signal, cleanup.signal]))[Symbol.asyncIterator]();
      try {
        const first = await iterator.next();
        const records = obj(first.value)?.records;
        return Array.isArray(records) ? records : [];
      } finally {
        cleanup.abort();
        const closing = iterator.return?.(); closing?.catch(() => {});
        if (closing) await Promise.race([closing, new Promise(resolve => setTimeout(resolve, 1_000))]);
      }
    },
    async projections(sessionId, signal) {
      const value = obj(await sc.projections({ sessionId }, signal));
      return obj(value?.values) ?? value;
    },
    // Asked on every list: DSH can add, rename or remove a workspace while it runs. Without the registry, projects are
    // the chats' working folders.
    ...(options.workspaceRegistry ? { async workspaces() {
      return (options.workspaceRegistry!()?.list() ?? []).map(w => ({ id: w.id, title: (typeof w.title === 'string' ? w.title.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim() : '') || basename(w.path) || w.path, path: w.path }));
    } } : {}),
    ...(options.llm ? {
      async judge({ route, system, user, signal }) {
        const llm = options.llm!();
        if (!llm?.stream) throw new Error('no llm service');
        let text = '';
        for await (const chunk of llm.stream({ provider: route.provider, model: route.model, system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], signal })) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        }
        return text;
      },
    } : {}),
  };
}
