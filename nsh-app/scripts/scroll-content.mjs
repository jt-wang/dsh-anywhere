#!/usr/bin/env node
// Runs NSH tests with --trace and fails when a scroll view's content is larger than the viewport the tests set.
// NSH counts an image's own size (a photo's pixels, an SVG's viewBox) in its scroll view's content however small the
// image is drawn, unless it clips; the JS test API cannot see a scroll view's content size, the trace can.
// The tests named here must lay out less than one screen in every scroll view. Each --image <asset>=<w>x<h> also
// finds the images showing that asset in the trace and requires each one's last frame to be that size, so the check
// fails when the image is gone as well as when it stops clipping.
// Usage (in nsh-app): node scripts/scroll-content.mjs <nsh> <width> <height> [--image <asset>=<w>x<h>]... <test file>...
import { spawnSync } from 'node:child_process'

const usage = 'Usage: node scripts/scroll-content.mjs <nsh> <width> <height> [--image <asset>=<w>x<h>]... <test file>...'
const [nsh, width, height, ...rest] = process.argv.slice(2)
const images = []
const files = []
for (let i = 0; i < rest.length; i++) {
  if (rest[i] !== '--image') { files.push(rest[i]); continue }
  const m = /^(.+)=(\d+)x(\d+)$/.exec(rest[++i] ?? '')
  if (!m) { console.error(usage); process.exit(2) }
  images.push({ asset: m[1], w: Number(m[2]), h: Number(m[3]) })
}
if (!nsh || !(Number(width) > 0) || !(Number(height) > 0) || !files.length) {
  console.error(usage)
  process.exit(2)
}
const run = spawnSync(nsh, ['test', ...files, '--trace'], { encoding: 'utf8', maxBuffer: 1 << 28 })
const log = `${run.stdout}${run.stderr}`
if (run.status !== 0) {
  console.error(log.split('\n').filter((l) => /✗|error|expected/.test(l)).join('\n') || log.slice(-2000))
  console.error(`scroll-content: nsh test exited ${run.status}`)
  process.exit(1)
}
const sizes = [...log.matchAll(/ScrollContent \{ id: (\d+), size: Size \{ width: ([\d.]+)pt, height: ([\d.]+)pt/g)]
if (!sizes.length) {
  console.error('scroll-content: the trace has no ScrollContent (no scroll view laid out, or the trace format changed)')
  process.exit(1)
}
const last = new Map(sizes.map(([, id, w, h]) => [id, [Number(w), Number(h)]]))
const over = [...last].filter(([, [w, h]]) => w > Number(width) || h > Number(height))
for (const [id, [w, h]] of last) console.log(`scroll ${id}: content ${w}×${h} pt${over.some(([o]) => o === id) ? `, larger than ${width}×${height}` : ''}`)
if (over.length) {
  console.error(`scroll-content: ${over.length} scroll view(s) larger than the viewport: an image that does not clip?`)
  process.exit(1)
}
// Node ids restart with each app a test opens: look for each image within its app's part of the trace.
const apps = log.split(/^── open\(/m).slice(1)
let wrong = 0
for (const { asset, w, h } of images) {
  let found = 0
  for (const app of apps) {
    const ids = new Set([...app.matchAll(/Image \{ id: (\d+), source: Some\(ImageSource \{ uri: "([^"]*)"/g)]
      .filter(([, , uri]) => uri.endsWith(`/${asset}`)).map(([, id]) => id))
    for (const id of ids) {
      found++
      const frames = [...app.matchAll(new RegExp(`Frame \\{ id: ${id}, x: [-\\d.]+, y: [-\\d.]+, w: ([\\d.]+), h: ([\\d.]+) \\}`, 'g'))]
      const [fw, fh] = frames.length ? frames[frames.length - 1].slice(1).map(Number) : []
      const ok = fw === w && fh === h
      console.log(`image ${id} (${asset}): ${frames.length ? `${fw}×${fh}` : 'no frame'}${ok ? '' : `, expected ${w}×${h}`}`)
      if (!ok) wrong++
    }
  }
  if (!found) { console.error(`scroll-content: no image shows ${asset} in the trace`); wrong++ }
}
if (wrong) {
  console.error(`scroll-content: ${wrong} image(s) missing or not the expected size`)
  process.exit(1)
}
