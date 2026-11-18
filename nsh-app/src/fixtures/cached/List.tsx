// The real list without the app-wide notification watcher's separate list request.
import './socket.ts'
import { mount } from 'nsh'
import { boot } from '../../state.ts'
import { SessionsScreen } from '../../sessions.tsx'

boot().then(() => mount(() => <SessionsScreen onOpen={() => {}} newChat={() => false} onNewChatClosed={() => {}} />))
