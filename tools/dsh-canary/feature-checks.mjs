import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { composeRuntime, officialLoader } from './composition.mjs';
import { opening } from './checks.mjs';

// Inspected npm rc.5 contracts: dsh-agent-team state v7/task v2,
// dsh-subagent catalog v3, SessionController continuation and experimental speech.
// See .dev/team-board-rc5.md and .dev/dsh-official-alignment.md for release/roadmap evidence.
// Later releases must be reviewed before extending this exact-version gate.
export const featureChecksSupported = version => version === '0.2.2-rc.5';

/** Independent real runtime: neither plugins nor counted calls leak into controllerChecks. */
export async function featureChecks({ runtimeRoot, directories }) {
  const loader = officialLoader(runtimeRoot);
  assert.ok(featureChecksSupported(await loader.version()), 'Feature contracts require inspected rc.5');
  const root = path.join(directories.home, 'feature-contract');
  const owned = Object.fromEntries(['home', 'workspace', 'temp', 'sessions', 'storages'].map(key => [key, path.join(root, key)]));
  for (const directory of Object.values(owned)) await mkdir(directory, { recursive: true });
  const checks = [], continuations = [];
  let runtime;
  const signal = new AbortController().signal;
  // These optional owners are intentionally not added to the global composition.
  const optional = new Set(['dsh-agent-team', 'dsh-experimental-speech-to-text', 'dsh-experimental-api-speech-to-text']);
  async function plugin(id, config = {}) {
    let module;
    if (optional.has(id)) {
      const base = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', id);
      assert.equal(JSON.parse(await readFile(path.join(base, 'package.json'), 'utf8')).version, runtime.version);
      module = await import(pathToFileURL(path.join(base, 'lib/index.js')).href);
    } else module = await loader.load(id);
    const fiber = runtime.ctx.plugin(module.default ?? module, config);
    await fiber.await();
    assert.equal(fiber.state, 2, `Feature owner ${id} active`);
  }
  const invoke = (namespace, method, args, caller = signal) => {
    const ctx = runtime.ctx;
    const peer = { id: 'synthetic-feature-owner', ctx, principal: { kind: 'owner' }, signal: caller, interactions: 'none', dispose: async () => {} };
    return ctx.typertGateway.invoke({ namespace, method, args, signal: caller, peer });
  };
  const projections = sessionId => invoke('session', 'projections', { request: { sessionId } });
  const prompt = request => invoke('session', 'prompt', { request });
  try {
    runtime = await composeRuntime(loader, owned);
    const { ctx, deterministic } = runtime;
    const originalStream = deterministic.stream;
    const attempts = new Map();
    deterministic.stream = async function* (options) {
      assert.equal(options.provider, 'dsh-anywhere-canary');
      assert.equal(options.model, 'deterministic-text-v1');
      assert.equal(options.tools?.length ?? 0, 0);
      options.signal?.throwIfAborted();
      const text = options.messages.flatMap(message => message.role === 'user' ? message.content.filter(block => block.type === 'text').map(block => block.text) : [])
        .find(value => /^(?:FEATURE_SYNTHETIC_CHILD|CONTINUATION_SYNTHETIC_[A-Z_]+)$/.test(value));
      assert.ok(text, 'Only exact synthetic feature prompts admitted');
      const attempt = (attempts.get(options.sessionId) ?? 0) + 1;
      attempts.set(options.sessionId, attempt);
      this.calls++; this.active++;
      try {
        if (text.startsWith('CONTINUATION_') && attempt === 1) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: text.slice('CONTINUATION_SYNTHETIC_'.length), message: 'Synthetic deterministic provider failure' } } };
          return;
        }
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'FEATURE_SYNTHETIC_COMPLETED' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'FEATURE_SYNTHETIC_COMPLETED' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } finally { this.active--; }
    };
    let board, catalog, leadId;
    try {
      await plugin('dsh-subagent');
      await plugin('dsh-subagent-spawn-in-process');
      const lead = (await ctx.agents.create({ sessionId: 'synthetic-feature-lead', meta: { cwd: owned.workspace }, agentOptions: ctx.agentDefaultModel.currentSelection() })).agent;
      leadId = lead.session.id;
      assert.equal((await projections(leadId)).values.agentTeam, undefined);
      await plugin('dsh-agent-team');
      assert.deepEqual((await projections(leadId)).values.agentTeam, { enabled: false, tasks: [] });
      await invoke('agentTeams', 'setEnabled', { agentId: leadId, enabled: true });
      assert.equal((await projections(leadId)).values.agentTeam.enabled, true);
      checks.push('official-team-unavailable-before-plugin-disabled-default-and-gateway-enable');

      const abort = new AbortController();
      const follow = ctx.sessionController.follow({ address: { kind: 'session', sessionId: leadId }, assistantStream: true }, abort.signal)[Symbol.asyncIterator]();
      let childId;
      try {
        assert.equal((await follow.next()).value.type, 'snapshot');
        const discovery = (async () => {
          for (;;) {
            const item = await follow.next();
            assert.equal(item.done, false);
            if (item.value.type === 'event' && item.value.event.type === 'subagent/catalog') return item.value.event.data;
          }
        })();
        const receipt = await ctx.subagents.startActivation({ provider: 'spawn', label: 'Synthetic protocol review', parent: lead, maxDepth: 4, prompt: [{ type: 'text', text: 'FEATURE_SYNTHETIC_CHILD' }], name: 'reviewer', signal });
        childId = receipt.childId;
        await ctx.agents.get(childId).whenIdle();
        const event = await discovery;
        assert.equal(event.version, 3);
        assert.equal(event.name, 'reviewer');
        assert.equal(event.childId, childId);
        catalog = (await projections(leadId)).values.subagentCatalog;
        const { version, childId: id, childCreatedAt: createdAt, ...descriptor } = event;
        assert.deepEqual(catalog, [{ id, createdAt, ...descriptor }]);
        assert.equal(catalog[0].label, 'Synthetic protocol review');
        assert.equal(catalog[0].mode, 'continuable');
        assert.deepEqual((await opening(ctx.sessionController, leadId)).projections.values.subagentCatalog, catalog);
        checks.push('real-named-spawn-v3-follow-discovery-equals-official-catalog-opening');
      } finally { abort.abort(); await follow.return(); }

      const task = (id, status, extra = {}) => ({ id, revision: 1, subject: `Synthetic ${id}`, description: `Synthetic description ${id}`, status, blockedBy: [], writeScopes: [], ...extra });
      const append = task => lead.session.append('team/task', { version: 2, teamId: leadId, task });
      const active = task('active', 'in_progress', { ownerId: childId, ownerName: 'reviewer', writeScopes: ['src'] });
      for (const value of [task('completed', 'completed'), active, task('blocked', 'pending', { blockedBy: ['active'], writeScopes: ['src/board'] }), task('ready', 'pending', { blockedBy: ['completed'] })]) append(value);
      await ctx.sessions.flush(lead.session);
      board = (await projections(leadId)).values.agentTeam;
      assert.equal(board.enabled, true);
      assert.deepEqual(board.tasks.map(task => [task.status, task.ready]), [['completed', false], ['in_progress', false], ['pending', false], ['pending', true]]);
      assert.equal(board.tasks[1].ownerName, 'reviewer');
      assert.equal(board.tasks[1].ownerId, childId);
      assert.deepEqual(board.tasks[2].writeScopeWarnings, ['write scopes overlap with active']);
      assert.deepEqual((await opening(ctx.sessionController, leadId)).projections.values.agentTeam, board);
      checks.push('official-v2-board-enriched-status-readiness-owner-dependency-and-write-warning');
      append({ ...active, revision: 2, status: 'completed' });
      await ctx.sessions.flush(lead.session);
      board = (await projections(leadId)).values.agentTeam;
      assert.equal(board.tasks[1].revision, 2);
      assert.equal(board.tasks[1].status, 'completed');
      assert.equal(board.tasks[2].ready, true);
      assert.deepEqual(board.tasks[2].writeScopeWarnings, []);
      checks.push('contiguous-board-revision-recomputes-readiness-and-clears-warning');
      const validTasks = structuredClone(board.tasks);
      append({ ...active, revision: 9 });
      append({ ...active, revision: 3, subject: 'Synthetic must not supersede last valid state' });
      await ctx.sessions.flush(lead.session);
      board = (await projections(leadId)).values.agentTeam;
      assert.match(board.failure, /revision is not contiguous/);
      assert.deepEqual(board.tasks, validTasks);
      await invoke('agentTeams', 'setEnabled', { agentId: leadId, enabled: false });
      board = (await projections(leadId)).values.agentTeam;
      assert.equal(board.enabled, false);
      assert.deepEqual(board.tasks, validTasks);
      assert.match(board.failure, /revision is not contiguous/);
      checks.push('invalid-board-revision-freezes-last-valid-state-even-after-new-record-and-disable');

      for (const code of ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'STREAM_CLOSED', 'AUTH', 'QUOTA']) {
        const sessionId = `synthetic-feature-continuation-${code.toLowerCase()}`;
        await ctx.agents.create({ sessionId, meta: { cwd: owned.workspace }, agentOptions: ctx.agentDefaultModel.currentSelection() });
        await prompt({ sessionId, requestId: `original-${sessionId}`, mode: 'queue', content: [{ type: 'text', text: `CONTINUATION_SYNTHETIC_${code}` }] });
        await ctx.agents.get(sessionId).whenIdle();
        const snapshot = await opening(ctx.sessionController, sessionId);
        const ending = snapshot.records.findLast(record => record.event?.type === 'turn/end').event;
        assert.equal(ending.data.reason.error.code, code);
        const retryable = !['AUTH', 'QUOTA'].includes(code);
        assert.equal(snapshot.projections.values.conversationContinuation, retryable ? ending.seq : null);
        assert.equal((await projections(sessionId)).values.conversationContinuation, retryable ? ending.seq : null);
        assert.equal(attempts.get(sessionId), 1, 'Projection reads cannot trigger continuation');
        const requestId = `manual-${sessionId}`;
        const request = { sessionId, requestId, mode: 'queue', content: [] };
        if (!retryable) {
          await assert.rejects(() => prompt(request));
          assert.equal(attempts.get(sessionId), 1);
          checks.push(`${code}:nonretryable-projection-null-and-empty-queue-rejected`);
          continue;
        }
        await assert.rejects(() => prompt({ ...request, requestId: `steer-${sessionId}`, mode: 'steer' }));
        assert.deepEqual(await prompt(request), { accepted: true });
        await ctx.agents.get(sessionId).whenIdle();
        const after = await opening(ctx.sessionController, sessionId);
        const retries = after.records.filter(record => record.event?.type === 'user/message' && record.event.data.source.kind === 'retry');
        assert.equal(retries.length, 1);
        assert.equal(retries[0].event.data.source.rpcId, requestId);
        assert.deepEqual(retries[0].event.data.content, []);
        assert.equal(after.projections.values.conversationContinuation, null);
        assert.equal(after.records.findLast(record => record.event?.type === 'turn/end').event.data.reason.kind, 'completed');
        const before = deterministic.calls;
        assert.deepEqual(await prompt(request), { accepted: true });
        await ctx.agents.get(sessionId).whenIdle();
        assert.equal(deterministic.calls, before);
        assert.equal(attempts.get(sessionId), 2);
        continuations.push({ code, request, retrySeq: retries[0].event.seq });
        checks.push(`${code}:continuation-projection-empty-queue-requestId-durable-retry-and-dedup`);
      }
      assert.equal(deterministic.calls, 15, 'One named child, six failure/success pairs, two nonretryable failures');
    } finally { deterministic.stream = originalStream; }

    await speechChecks();
    await runtime.dispose(); runtime = undefined;
    runtime = await composeRuntime(loader, owned);
    await plugin('dsh-subagent'); await plugin('dsh-agent-team');
    assert.deepEqual((await projections(leadId)).values.agentTeam, board);
    assert.deepEqual((await projections(leadId)).values.subagentCatalog, catalog);
    checks.push('cold-runtime-retains-official-board-last-state-failure-disabled-and-actual-names');
    for (const { request, retrySeq } of continuations) {
      const snapshot = await opening(runtime.ctx.sessionController, request.sessionId);
      assert.equal(snapshot.projections.values.conversationContinuation, null);
      const retries = snapshot.records.filter(record => record.event?.type === 'user/message' && record.event.data.source.kind === 'retry');
      assert.equal(retries.length, 1);
      assert.equal(retries[0].event.seq, retrySeq);
      assert.equal(retries[0].event.data.source.rpcId, request.requestId);
      assert.deepEqual(retries[0].event.data.content, []);
      assert.deepEqual(await prompt(request), { accepted: true });
      await runtime.ctx.agents.get(request.sessionId)?.whenIdle();
    }
    assert.equal(runtime.deterministic.calls, 0, 'Cold durable retry-id dedup cannot invoke the provider');
    checks.push('cold-runtime-retry-receipts-retain-requestId-and-dedup-with-zero-model-calls');
    return { phase: 'rc5-official-feature-contracts', checks, deterministicCalls: deterministic.calls, coldCalls: runtime.deterministic.calls, speech: 'deterministic-provider-contract-only; not real ASR or native microphone acceptance' };
  } finally { await runtime?.dispose(); }

  async function speechChecks() {
    await plugin('dsh-experimental-speech-to-text', { defaultProvider: 'synthetic-speech', language: 'en' });
    await plugin('dsh-experimental-api-speech-to-text');
    // Canonical 16kHz mono PCM16 silence; never recorded or sent to an ASR engine.
    const audio = Buffer.alloc(44 + 320);
    audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28);
    audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
    audio.write('data', 36); audio.writeUInt32LE(320, 40);
    let calls = 0;
    const transcript = { text: 'SYNTHETIC_TRANSCRIPT', audioSeconds: 0.01, inferenceSeconds: 0 };
    const remove = runtime.ctx.speechToText.register({
      info: { id: 'synthetic-speech', name: 'Synthetic contract provider, not ASR', location: 'host-local', languages: ['en'] },
      async transcribe(request, signal) {
        signal.throwIfAborted();
        assert.deepEqual(request.audio, audio); assert.equal(request.language, 'en');
        calls++; return transcript;
      },
    });
    try {
      const request = { audioBase64: audio.toString('base64'), providerId: 'synthetic-speech', language: 'en' };
      const before = (await runtime.ctx.sessionController.list({}, signal)).items.map(row => row.sessionId).sort();
      assert.deepEqual(await invoke('speech', 'transcribe', { request }), transcript);
      for (const invalid of [{ ...request, audioBase64: 'AAAA' }, { ...request, audioBase64: request.audioBase64 + '\n' }, { ...request, providerId: 'missing-synthetic' }, { ...request, language: 'unsupported' }]) {
        await assert.rejects(() => invoke('speech', 'transcribe', { request: invalid }));
      }
      const aborted = new AbortController(); aborted.abort();
      await assert.rejects(() => invoke('speech', 'transcribe', { request }, aborted.signal));
      assert.equal(calls, 1, 'Invalid audio, provider, language and cancelled calls never reach recognition');
      assert.deepEqual((await runtime.ctx.sessionController.list({}, signal)).items.map(row => row.sessionId).sort(), before);
      checks.push('speech-real-gateway-canonical-wav-routing-transcript-invalid-input-and-cancellation-contract-not-real-ASR');
    } finally { await remove(); }
  }
}
