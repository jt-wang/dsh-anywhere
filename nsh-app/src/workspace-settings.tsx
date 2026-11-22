import { cleanup, locale, signal, Text, View } from 'nsh'
import { Input } from 'nsh/base'
import type { Dsh } from './dsh.ts'
import { dsh, network } from './state.ts'
import { language } from './strings.ts'
import type { ChatSummary, Workspace } from './workspaces.ts'
import { WorkspaceSettingsModel, type WorkspaceEdit } from './workspace-settings.ts'
import { workspaceSettingsStrings } from './workspace-settings-strings.ts'
import { setWorkspaceView, workspaceView } from './prefs.ts'
import { workspaceViewStrings } from './workspace-settings-view-strings.ts'

const words = () => workspaceSettingsStrings(language() === 'system' ? locale() : language())
const viewWords = () => workspaceViewStrings(language() === 'system' ? locale() : language())
function Action(props: { id: string; label: string; context?: string; disabled?: boolean; press: () => void }) {
  return <View role="button" testID={props.id} accessibilityLabel={`${props.label}${props.context ? `: ${props.context}` : ''}`} accessibilityState={{ disabled: !!props.disabled }} onPress={() => { if (!props.disabled) props.press() }} class={`min-h-[48px] justify-center rounded-[9px] bg-secondary px-3 ${props.disabled ? 'opacity-40' : 'active:opacity-60'}`}><Text class="text-foreground text-[14px]">{props.label}</Text></View>
}

function WorkspaceRow(props: { row: Workspace; rows: Workspace[]; disabled: boolean; edit: (edit: WorkspaceEdit) => void; chats: ChatSummary[] }) {
  const draft = signal(props.row.title), confirming = signal(false), expanded = signal(false)
  const w = () => props.row, index = () => props.rows.findIndex(r => r.workspaceId === w().workspaceId)
  const reorder = (beforeWorkspaceId?: string) => props.edit({ kind: 'workspace-order', workspaceId: w().workspaceId, ...(beforeWorkspaceId ? { beforeWorkspaceId } : {}) })
  const moveChat = (sessionId: string, beforeSessionId?: string) => props.edit({ kind: 'session-order', workspaceId: w().workspaceId, sessionId, ...(beforeSessionId ? { beforeSessionId } : {}) })
  const title = (id: string) => props.chats.find(c => c.sessionId === id)?.title || id
  return <View testID={`workspace-row-${w().workspaceId}`} class="rounded-[14px] border border-border bg-card p-[14px] gap-2">
    <Text class="text-foreground text-[16px] font-medium">{w().title}</Text>
    <Text class="text-muted-foreground text-[12px]">{w().path}</Text>
    <Input testID={`workspace-name-${w().workspaceId}`} accessibilityLabel={`${words().name}: ${w().title}`} value={draft()} onChange={e => draft.set(e.value)} class="min-h-[48px] bg-background rounded-[8px] border border-input px-3 text-foreground" />
    <View class="flex-row flex-wrap gap-2">
      <Action id={`workspace-rename-${w().workspaceId}`} label={words().rename} context={w().title} disabled={props.disabled || !draft().trim() || draft().trim() === w().title} press={() => props.edit({ kind: 'rename', workspaceId: w().workspaceId, title: draft() })} />
      <Action id={`workspace-up-${w().workspaceId}`} label={words().up} context={w().title} disabled={props.disabled || index() <= 0} press={() => reorder(props.rows[index() - 1]?.workspaceId)} />
      <Action id={`workspace-down-${w().workspaceId}`} label={words().down} context={w().title} disabled={props.disabled || index() >= props.rows.length - 1} press={() => reorder(props.rows[index() + 2]?.workspaceId)} />
      <Action id={`workspace-end-${w().workspaceId}`} label={words().end} context={w().title} disabled={props.disabled || index() >= props.rows.length - 1} press={() => reorder()} />
      <Action id={`workspace-remove-${w().workspaceId}`} label={words().remove} context={w().title} disabled={props.disabled} press={() => confirming.set(true)} />
    </View>
    <If when={confirming()}><View testID={`workspace-confirmation-${w().workspaceId}`} class="border border-border rounded-lg p-3 gap-2">
      <Text class="text-foreground text-[14px]">{words().removal}</Text><Text class="text-foreground text-[14px]">{w().title}</Text><Text class="text-muted-foreground text-[12px]">{w().path}</Text>
      <View class="flex-row flex-wrap gap-2"><Action id={`workspace-cancel-${w().workspaceId}`} label={words().cancel} press={() => confirming.set(false)} /><Action id={`workspace-confirm-${w().workspaceId}`} label={words().confirm} context={w().title} disabled={props.disabled} press={() => { confirming.set(false); props.edit({ kind: 'remove', workspaceId: w().workspaceId }) }} /></View>
    </View></If>
    <If when={w().sessionIds.length > 0}><Action id={`workspace-sessions-${w().workspaceId}`} label={words().sessions} context={w().title} press={() => expanded.set(!expanded())} /></If>
    <If when={expanded()}><Each of={w().sessionIds} key={id => id}>{id => <View class="border-t border-border pt-2 gap-2">
      <Text class="text-foreground text-[14px]">{title(id())}</Text>
      <View class="flex-row flex-wrap gap-2">
        <Action id={`workspace-chat-up-${id()}`} label={words().up} context={title(id())} disabled={props.disabled || w().sessionIds.indexOf(id()) <= 0} press={() => moveChat(id(), w().sessionIds[w().sessionIds.indexOf(id()) - 1])} />
        <Action id={`workspace-chat-down-${id()}`} label={words().down} context={title(id())} disabled={props.disabled || w().sessionIds.indexOf(id()) >= w().sessionIds.length - 1} press={() => moveChat(id(), w().sessionIds[w().sessionIds.indexOf(id()) + 2])} />
        <Action id={`workspace-chat-end-${id()}`} label={words().end} context={title(id())} disabled={props.disabled || w().sessionIds.indexOf(id()) >= w().sessionIds.length - 1} press={() => moveChat(id())} />
      </View>
    </View>}</Each></If>
  </View>
}

/** Common iOS/Android native controls, always available even with the computer offline. */
export function WorkspaceViewPreferences() {
  return <View testID="workspace-view-preferences" class="gap-2 pt-3">
    <Text class="text-foreground text-[15px] font-medium">{viewWords().title}</Text>
    <Text testID="workspace-desktop-view-scope" class="text-muted-foreground text-[13px]">{viewWords().scope}</Text>
    <Text class="text-muted-foreground text-[13px]">{viewWords().group}</Text>
    <View class="flex-row flex-wrap gap-2">{(['workspace', 'workspace-tree', 'flat'] as const).map(value => <Action id={`workspace-view-group-${value}`} label={`${workspaceView().groupBy === value ? '✓ ' : ''}${viewWords()[value]}`} press={() => setWorkspaceView({ groupBy: value })} />)}</View>
    <Text class="text-muted-foreground text-[13px]">{viewWords().order}</Text>
    <View class="flex-row flex-wrap gap-2">{(['manual', 'updated'] as const).map(value => <Action id={`workspace-view-order-${value}`} label={`${workspaceView().orderBy === value ? '✓ ' : ''}${viewWords()[value]}`} press={() => setWorkspaceView({ orderBy: value })} />)}</View>
    <Text class="text-muted-foreground text-[13px]">{viewWords().filter}</Text>
    <View class="flex-row flex-wrap gap-2">{(['default', 'show', 'only'] as const).map(value => <Action id={`workspace-view-filter-${value}`} label={`${workspaceView().archivedFilter === value ? '✓ ' : ''}${viewWords()[value]}`} press={() => setWorkspaceView({ archivedFilter: value })} />)}</View>
  </View>
}

/** Mount inside Settings' existing keyboard-aware Scroll. No network work until opened.
 * Optional chats supply human-readable titles; unknown/saved sessions retain their official IDs.
 */
export function WorkspaceSettings(props: { client?: () => Pick<Dsh, 'rpc' | 'stream'>; chats?: () => ChatSummary[]; online?: () => boolean; auto?: boolean } = {}) {
  const open = signal(!!props.auto), revision = signal(0)
  const model = new WorkspaceSettingsModel(props.client ?? dsh, () => revision.update(n => n + 1))
  const state = () => { revision(); return model }
  const online = props.online ?? network
  const disabled = () => state().busy || state().status !== 'ready' || !online()
  cleanup(() => model.dispose())
  if (props.auto) void model.refresh()
  return <View testID="workspace-settings" class="gap-2 pt-5">
    <WorkspaceViewPreferences />
    <Text class="px-2 text-muted-foreground text-[13px] font-medium">{words().title}</Text>
    <Text testID="workspace-phone-view-scope" class="px-2 text-muted-foreground text-[13px]">{words().phoneView}</Text>
    <If when={!props.auto}><Action id="workspace-settings-open" label={open() ? words().refresh : words().open} disabled={state().busy || state().status === 'loading' || !online()} press={() => { open.set(true); void model.refresh() }} /></If>
    <If when={open()}>
      <Text testID="workspace-registry-order-scope" class="px-2 text-foreground text-[13px] font-medium">{words().registryOrder}</Text>
      <Text class="px-2 text-muted-foreground text-[13px]">{words().hint}</Text>
      <If when={state().status === 'loading'}><Text class="text-muted-foreground text-[13px]">{words().loading}</Text></If>
      <If when={state().status === 'offline' || !online()}><Text testID="workspace-offline" class="text-muted-foreground text-[13px]">{words().offline}</Text></If>
      <If when={state().outcome}><Text testID="workspace-outcome" class="text-foreground text-[13px]">{words()[state().outcome as 'confirmed' | 'uncertain' | 'rejected']}</Text></If>
      <If when={state().status === 'ready' && !state().registry.list().length}><Text class="text-muted-foreground text-[13px]">{words().empty}</Text></If>
      <Each of={state().registry.list()} key={w => `${w.workspaceId}:${w.title}`}>{w => <WorkspaceRow row={w()} rows={state().registry.list()} disabled={disabled()} edit={edit => { if (!disabled()) void model.edit(edit) }} chats={props.chats?.() ?? []} />}</Each>
      <If when={!props.auto}><Action id="workspace-settings-close" label={words().close} disabled={state().busy} press={() => { open.set(false); model.pause() }} /></If>
    </If>
  </View>
}
