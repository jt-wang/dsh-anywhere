// A message on its way with a full-size phone photo, in a scroll view like the chat's (src/sent.test.tsx).
import { mount, Scroll } from 'nsh'
import { Bubble, OutgoingView } from '../sent.tsx'
import type { Outgoing } from '../outbox.ts'
import photo from './photo-3000x4000.png'

// On a phone the preview is the photo's blob URL, measured once decoded. Headless tests load no URL (nor data: URL),
// only an imported asset, whose size is known: <Image src> takes both, so the asset stands in for the URL here.
const message: Outgoing = {
  id: '1', text: 'see the photo', state: 'sending', ahead: 0, sentAt: Date.now(),
  drafts: [{ kind: 'image', id: 'p1', name: 'photo.png', mediaType: 'image/png', data: '', preview: photo as unknown as string }],
}

mount(() => (
  <Scroll testID="thread" class="flex-1 bg-background" contentClass="p-4 gap-4">
    <Bubble text="first message" />
    <OutgoingView message={() => message} busy={() => false} retry={() => {}} />
  </Scroll>
))
