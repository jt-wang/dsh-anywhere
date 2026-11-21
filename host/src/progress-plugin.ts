// The Progress plugin: a Cordis plugin of its own that keeps the jobs of every chat (progress.ts) and provides them as
// the `progress` service. The companion's phone calls read it through injection (plugin.ts), and any other plugin can
// inject it the same way. The companion mounts it from the same release bundle, so installing stays one profile row.
// Cordis provide/inject inspected in DSH 0.2.2-rc.1 (cordis 4.1.0) and 0.2.1-rc.3 (cordis 4.0.5).
import type { DshSessionController } from './dsh-adapter.ts';
import { createProgress } from './progress.ts';
import type { Progress, ProgressSettings, ProgressView } from './progress.ts';
import { dshProgressSources, progressDirectory } from './progress-dsh.ts';
import type { DshLlmStream } from './progress-dsh.ts';
import type { DshWorkspaceRegistry } from './workspace-source.ts';

/** What the `progress` service offers a reader: the jobs by project, and the judging setting. */
export interface ProgressService {
  list(signal: AbortSignal): Promise<ProgressView>;
  settings(): ProgressSettings;
  configure(change: Partial<ProgressSettings>): Promise<ProgressSettings>;
}

/** The plugin's row: `dir` is where jobs are kept when DSH does not say where its home is. */
export interface ProgressPluginConfig { dir?: string }

/** The Cordis context as far as the plugin uses it. */
export interface ProgressContext {
  sessionController: DshSessionController;
  get?(name: 'workspaceRegistry' | 'llm' | 'profileContext'): unknown;
  on(name: string, listener: (...args: any[]) => any, options?: { global: boolean }): () => unknown;
  provide(name: 'progress', value: ProgressService): unknown;
  logger?: { warn(message: string): void };
}

export const name = 'dsh-anywhere-progress';
export const inject = ['sessionController'];

export async function apply(ctx: ProgressContext, config: ProgressPluginConfig | undefined): Promise<() => Promise<void>> {
  const dir = progressDirectory(ctx.get?.('profileContext') as { home?: unknown } | undefined, config?.dir);
  if (!dir) return async () => {};
  const progress: Progress = await createProgress({ dir, sources: dshProgressSources({
    sessionController: ctx.sessionController,
    workspaceRegistry: () => ctx.get?.('workspaceRegistry') as DshWorkspaceRegistry | undefined,
    llm: () => ctx.get?.('llm') as DshLlmStream | undefined,
  }), log: message => ctx.logger?.warn(message) });
  const off = ctx.on('session/event', (session: { id?: string }, event: unknown) => { if (typeof session?.id === 'string') progress.event(session.id, event); }, { global: true });
  ctx.provide('progress', { list: signal => progress.list(signal), settings: () => progress.settings(), configure: change => progress.configure(change) });
  return async () => { off(); await progress.close(); };
}

export default { name, inject, apply };
