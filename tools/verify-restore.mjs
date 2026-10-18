import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const pkg = process.argv[2]
const home = process.argv[3]
const ws = process.argv[4]
const m = JSON.parse(readFileSync(join(pkg, 'MANIFEST.json'), 'utf8'))

let ok = 0
const mismatch = []
const missing = []
const expectedChanged = []
for (const e of m.entries) {
  const [top, ...rest] = e.rel.split('/')
  const base = top === 'dsh-home' ? home : ws
  const p = join(base, ...rest)
  if (!existsSync(p)) { missing.push(e.rel); continue }
  const st = statSync(p)
  const sha = createHash('sha256').update(readFileSync(p)).digest('hex')
  if (sha === e.sha256 && st.size === e.size) { ok += 1; continue }
  // restore 会改写 profile 的依赖路径（跨机器必须），这类差异是预期的
  if (top === 'dsh-home' && /^profiles\/[^/]+\/package\.json$/.test(rest.join('/'))) { expectedChanged.push(e.rel); continue }
  mismatch.push({ rel: e.rel, want: e.sha256.slice(0, 10), got: sha.slice(0, 10), size: [e.size, st.size] })
}

console.log(JSON.stringify({
  total: m.entries.length,
  ok,
  expectedChanged: expectedChanged.length,
  missing: missing.length,
  mismatch: mismatch.length,
}, null, 0))
if (missing.length) console.log('missing sample:', missing.slice(0, 8))
if (mismatch.length) console.log('mismatch sample:', mismatch.slice(0, 8))
