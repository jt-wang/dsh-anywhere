// The whole app on a linked phone in one connection state (src/fixtures/header/fake.ts), with the app's own grants
// and fonts, for src/header.test.tsx on every target. It sits beside App.tsx because a device host loads the fonts
// nsh.json names only for an entry in this folder.
import './src/fixtures/cached/socket.ts'
import './src/fixtures/header/fake.ts'
import './App.tsx'
