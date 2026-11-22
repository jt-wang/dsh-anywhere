// In-memory unsent content belongs to a linked chat, not its replaceable detail page.
// No disk writes, retries or background effects: sending still belongs to ChatScreen.
import { signal } from 'nsh'
import type { Draft } from './attach.ts'
import type { Outgoing } from './outbox.ts'

function createComposer(text: string) {
  return { draft: signal(text), attached: signal<Draft[]>([]), uploading: signal(false), outbox: signal<Outgoing[]>([]) }
}

const links = new WeakMap<object, Map<string, ReturnType<typeof createComposer>>>()

/** Use the stable paired cache as owner (or client for uncached sample/legacy links), never a transport port.
 * A child address includes its parent; a new link never inherits another computer's content. */
export function composerState(link: object, address: readonly string[], savedText = '') {
  let chats = links.get(link)
  if (!chats) { chats = new Map(); links.set(link, chats) }
  const key = JSON.stringify(address)
  let state = chats.get(key)
  if (!state) { state = createComposer(savedText); chats.set(key, state) }
  return state
}
