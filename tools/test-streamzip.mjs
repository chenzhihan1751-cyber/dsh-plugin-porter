#!/usr/bin/env node
/**
 * stream-zip 自测：造文件 → 分卷打包 → 解包 → 逐文件 SHA-256 比对。
 * 覆盖：中文名 / 小文件内存路径 / 大文件流式路径 / 强制分卷 / UTF-8 标志位。
 *
 *   node tools/test-streamzip.mjs
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { packEntries, unpackVolume } from '../lib/stream-zip.mjs'

const root = join(tmpdir(), 'szip-test-' + Date.now())
const src = join(root, 'src')
const dst = join(root, 'dst')
const out = join(root, 'bundle.zip')
mkdirSync(join(src, '中文目录', 'sub'), { recursive: true })
mkdirSync(join(src, 'ascii'), { recursive: true })

writeFileSync(join(src, '中文目录', '文件一.txt'), '中文内容 ✓\n'.repeat(200), 'utf8')
writeFileSync(join(src, '中文目录', 'sub', 'deep.json'), JSON.stringify({ k: '值' }), 'utf8')
writeFileSync(join(src, 'ascii', 'small.txt'), 'x'.repeat(1024), 'utf8')
// 大文件：70MB > SMALL(64MB) → 走流式两遍路径
const big = Buffer.alloc(70 * 1024 * 1024, 7)
writeFileSync(join(src, 'ascii', 'big.bin'), big)

const rels = ['中文目录/文件一.txt', '中文目录/sub/deep.json', 'ascii/small.txt', 'ascii/big.bin']
const entries = rels.map((rel) => ({ abs: join(src, rel.split('/').join('\\')), rel }))

const t0 = Date.now()
// 阶段 1：单卷 90MB（>70MB 的大文件走流式两遍路径）
const res = await packEntries({ outFile: out, entries, maxVolumeBytes: 90 * 1024 * 1024 })
console.log('pack ok in', Date.now() - t0, 'ms')
console.log('volumes:', res.volumes.map((v) => ({ f: v.file.split(/[\\/]/).pop(), entries: v.entries, mb: +(v.bytes / 1048576).toFixed(1) })))
console.log('stats:', res.stats)

// UTF-8 标志位检查（local header byte 6-7 = 0x0800）
const raw = readFileSync(out)
const flag = raw.readUInt16LE(6)
console.log('utf8 flag:', (flag & 0x0800) !== 0 ? 'OK' : 'MISSING')

// 逐卷解包，按 manifest 校验
mkdirSync(dst, { recursive: true })
const byVol = new Map()
for (const m of res.manifest) byVol.set(m.volume, [...(byVol.get(m.volume) ?? []), m])
for (const v of res.volumes) {
  await unpackVolume(v.file, dst, {})
}
let ok = 0
let bad = []
for (const m of res.manifest) {
  const p = join(dst, m.rel.split('/').join('\\'))
  try {
    const buf = readFileSync(p)
    const sha = createHash('sha256').update(buf).digest('hex')
    if (sha === m.sha256 && buf.length === m.size) ok += 1
    else bad.push({ rel: m.rel, want: m.sha256.slice(0, 8), got: sha.slice(0, 8) })
  } catch (e) {
    bad.push({ rel: m.rel, err: String(e.message).slice(0, 60) })
  }
}
console.log(`verified ${ok}/${res.manifest.length}`)
if (bad.length) console.log('MISMATCH:', bad)
console.log('中文名解包检查:', statSync(join(dst, '中文目录', '文件一.txt')).size, 'bytes')

// 阶段 2：强制分卷（3 × 20MB，卷上限 45MB → 应切成 2 卷）
const src2 = join(root, 'src2')
mkdirSync(src2, { recursive: true })
const e2 = []
for (let i = 1; i <= 3; i += 1) {
  const p = join(src2, 'p' + i + '.bin')
  writeFileSync(p, Buffer.alloc(20 * 1024 * 1024, i))
  e2.push({ abs: p, rel: 'p' + i + '.bin' })
}
const res2 = await packEntries({ outFile: join(root, 'vol.zip'), entries: e2, maxVolumeBytes: 45 * 1024 * 1024 })
console.log('split volumes:', res2.volumes.map((v) => ({ f: v.file.split(/[\\/]/).pop(), entries: v.entries, mb: +(v.bytes / 1048576).toFixed(1) })))
if (res2.volumes.length < 2) bad.push({ split: 'expected >=2 volumes' })

// 阶段 3：单文件超卷上限 → 必须 skip 而不是产出坏包
const res3 = await packEntries({ outFile: join(root, 'toobig.zip'), entries: [{ abs: join(src2, 'p1.bin'), rel: 'p1.bin' }], maxVolumeBytes: 10 * 1024 * 1024 })
console.log('oversize handling:', res3.stats, res3.skipped.map((s) => s.reason))
if (res3.stats.files !== 0 || res3.skipped.length !== 1) bad.push({ oversize: 'should skip exactly 1' })

rmSync(root, { recursive: true, force: true })
process.exit(bad.length ? 1 : 0)
