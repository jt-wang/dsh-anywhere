import type { SessionModel, ResolvedQuestion, AttachmentRef, PendingQuestion, QueueItem, PhoneCapabilities, ModelCatalog, SessionMutation, PromptOptions, UploadedAttachment } from './phone.ts';
export interface WorkspaceConfig { id: string; name: string; path: string }
export interface Preset { id: string; name: string }
export interface HostSession {
  id: string; title: string; workspaceId: string; updatedAt: number; running: boolean;
  blank?: boolean;
  waitingForAnswer?: boolean;
  runningSubagents?: number;
  model?: SessionModel | null;
}
export interface ChatMessage {
  id: string; role: 'user' | 'assistant' | 'system'; text: string; createdAt: number;
  attachments?: AttachmentRef[];
  delivery?: import('./phone.ts').Delivery;
  requestId?: string; provisional?: boolean; kind?: 'message' | 'agent_event' | 'context' | 'step' | 'thought'; serviceText?: string;
  /** Present exactly when kind is 'step'. */
  step?: import('./step-presentation.ts').StepInfo;
}
export interface HostSnapshot {
  session: HostSession; messages: ChatMessage[]; cursor: number; hasMore: boolean;
  pendingQueue?: QueueItem[]; pendingQuestions?: PendingQuestion[];
  model?: SessionModel | null; resolvedQuestions?: ResolvedQuestion[];
  activity: 'idle' | 'running' | 'waiting' | 'unknown'; notice?: string;
  runningSubagents?: number;
  activityDetail?: { turnStartedAt: number; tool?: string };
}
export interface FileUploadReservation { release(): void }
export interface HostAdapter {
  readonly upstreamVersion: string;
  notifications?(): import('./notifications.ts').NotificationSources | undefined;
  listPresets(signal: AbortSignal): Promise<Preset[]>;
  listSessions(signal: AbortSignal): Promise<HostSession[]>;
  /** Header-only scope resolution for hiding failed point reads; never returns transcript data. */
  sessionScope?(sessionId: string, signal: AbortSignal): Promise<string>;
  snapshot(sessionId: string, signal: AbortSignal): Promise<HostSnapshot>;
  watch(sessionId: string, signal: AbortSignal): AsyncIterable<HostSnapshot>;
  /** Server-authorized identity is checked again inside the adapter before upstream admission. */
  createSession(input: { workspaceId: string; presetId?: string; requestId: string }, signal: AbortSignal, expectedWorkspaceId: string): Promise<{ sessionId: string }>;
  phoneCapabilities?(): PhoneCapabilities;
  models?(signal: AbortSignal): Promise<ModelCatalog>;
  mutateSession?(sessionId: string, mutation: SessionMutation, signal: AbortSignal, expectedWorkspaceId: string): Promise<void>;
  reserveFileUploads?(sessionId: string, count: number, signal: AbortSignal, expectedWorkspaceId: string): Promise<FileUploadReservation>;
  upload?(sessionId: string, input: { data: AsyncIterable<Uint8Array>; size: number; mime: string; name: string; reservation?: FileUploadReservation }, signal: AbortSignal, expectedWorkspaceId: string): Promise<UploadedAttachment>;
  file?(sessionId: string, attachmentId: string, signal: AbortSignal, expectedWorkspaceId: string): Promise<{ data: Uint8Array; ref: AttachmentRef }>;
  image?(sessionId: string, attachmentId: string, signal: AbortSignal, expectedWorkspaceId: string): Promise<{ data: Uint8Array; ref: AttachmentRef }>;
  prompt(sessionId: string, text: string, requestId: string, signal: AbortSignal, expectedWorkspaceId: string, options?: PromptOptions): Promise<void>;
  /** Conservative observed-cursor guard; upstream cancellation remains session-wide at admission. */
  cancel(sessionId: string, signal: AbortSignal, expectedCursor: number, expectedWorkspaceId: string): Promise<void>;
}
export type CommandStatus = 'pending' | 'accepted' | 'rejected' | 'uncertain';
export interface CommandReceipt {
  requestId: string; status: CommandStatus; result?: { sessionId?: string };
  error?: { code: string; message: string }; updatedAt: number;
}
export interface DeviceGrants { readWorkspaceIds: string[]; executeWorkspaceIds: string[] }
/** A tailpocket-relay server, always opaque (DSH's inner TLS end to end). The token stays in its own owner-only file. */
export interface TailcatRelayConfiguration { url: string; /** Absolute; read once when the companion starts. */ tokenFile: string }
/** Transport v3 (docs/TAILCAT.md). hostId names the inner TLS identity h-<hostId>.dsh.invalid. */
export interface TailcatConfiguration { enabled: true; hostId: string; /** Absolute; defaults to the bundled helper for this platform. */ helperPath?: string; relay?: TailcatRelayConfiguration;
  /** false turns TailPocket's same-network route off (default on: private addresses only, end-to-end encrypted). */
  lan?: boolean;
  /** Tailcat only, as before TailPocket: no local network route and no relay. */
  tailcatOnly?: boolean }
export interface HostBaseConfiguration {
  hostName: string;
  bind: string;
  port: number;
  statePath: string;
  tls?: { certPath: string; keyPath: string };
  /** Must remain false outside explicit local test/development composition. */
  allowInsecureLoopback?: boolean;
  tailcat?: TailcatConfiguration;
}
/** Omitting workspaceSource preserves the original explicit-list configuration. */
export type HostConfiguration = HostBaseConfiguration & (
  { workspaceSource?: 'explicit'; workspaces: WorkspaceConfig[] } |
  { workspaceSource: 'dsh-registry'; workspaces?: WorkspaceConfig[] }
);
export type PreparedHostConfiguration = HostConfiguration & { workspaces: WorkspaceConfig[] };
