#!/usr/bin/env node
/**
 * DSH 整机迁移 · 恢复脚本（随包走，新机不需要装任何插件）。
 *
 *   node restore-dsh.mjs --verify-only           只校验卷的 sha256
 *   node restore-dsh.mjs --dry-run               只看计划（不写任何文件）
 *   node restore-dsh.mjs                         真恢复（覆盖前会备份目标机现有配置）
 *   node restore-dsh.mjs --workspace "D:\Deepseek工作区"   指定工作区落盘位置
 *   node restore-dsh.mjs --target-home "%USERPROFILE%\.dsh"  指定 DSH_HOME（默认就是它）
 *   node restore-dsh.mjs --volumes 01,02         只恢复指定卷
 *
 * 设计原则：
 *   · 先备份再覆盖：目标机现有 .credentials.yaml / settings.yaml / profile 配置一律先复制成 .bak-restore-<ts>
 *   · 不静默丢：写不进去的文件全部进 RESTORE-REPORT.json
 *   · 修路径：包内记录的是来源机的绝对路径，恢复时按新机器改写 file:/link: 并重建 junction
 */

import { createHash } from 'node:crypto'
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  statSync, symlinkSync, writeFileSync, rmSync, writeSync as fsWriteSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const flag = (k) => argv.includes(k)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

const PKG = dirname(fileURLToPath(import.meta.url))
const MANIFEST = join(PKG, 'MANIFEST.json')
const TMP = join(PKG, '.unpacked')
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

const log = (...a) => console.log(...a)
const warn = (...a) => console.warn(...a)

if (!existsSync(MANIFEST)) {
  warn('✗ 找不到 MANIFEST.json —— 这个目录不是迁移包（或者文件没拷全）。')
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const stats = manifest.stats ?? {}
const sayHeader = () => {
  log('')
  log('DSH 整机迁移 · 恢复')
  log('  包生成于：' + manifest.createdAt)
  log('  来源机器：' + (manifest.source?.host ?? '?') + '｜DSH ' + (manifest.source?.dshVersion ?? '?') + '｜Node ' + (manifest.source?.node ?? '?'))
  log('  档位：' + manifest.label)
  log('  内容：' + stats.files + ' 个文件 / ' + (stats.bytes / 1048576).toFixed(1) + ' MB / ' + (manifest.volumes?.length ?? 0) + ' 卷')
  if (manifest.containsSecrets) log('  ⚠ 含明文 API 密钥：本包按机密文件处理，恢复完请删包或轮换密钥')
  log('')
}

/* ── ① 校验卷 ── */
function verifyVolumes() {
  let bad = 0
  for (const v of manifest.volumes ?? []) {
    const p = join(PKG, v.file)
    if (!existsSync(p)) { warn('  ✗ 缺卷：' + v.file); bad += 1; continue }
    const buf = readFileSync(p)
    const sha = createHash('sha256').update(buf).digest('hex')
    if (sha !== v.sha256) { warn('  ✗ 哈希不符：' + v.file); bad += 1 } else log('  ✓ ' + v.file + '  ' + (buf.length / 1048576).toFixed(1) + ' MB')
  }
  return bad
}

/* ── ② 解包（本文件内自带，store 模式顺序解析）── */
function unpackVolume(zipFile, destDir) {
  const st = statSync(zipFile)
  const fd = openSync(zipFile, 'r')
  let pos = 0
  let n = 0
  const head = Buffer.alloc(30)
  try {
    while (pos < st.size) {
      const got = readSync(fd, head, 0, 30, pos)
      if (got < 30) break
      if (head.readUInt32LE(0) !== 0x04034b50) break
      const nameLen = head.readUInt16LE(26)
      const extraLen = head.readUInt16LE(28)
      const size = head.readUInt32LE(18)
      const nb = Buffer.alloc(nameLen)
      readSync(fd, nb, 0, nameLen, pos + 30)
      const rel = nb.toString('utf8')
      const dataStart = pos + 30 + nameLen + extraLen
      pos = dataStart + size
      n += 1
      if (rel.endsWith('/')) continue
      const target = join(destDir, rel)
      mkdirSync(dirname(target), { recursive: true })
      const wfd = openSync(target, 'w')
      let left = size
      let cur = dataStart
      const chunk = Buffer.alloc(Math.min(4 * 1024 * 1024, Math.max(size, 1)))
      while (left > 0) {
        const want = Math.min(chunk.length, left)
        const g = readSync(fd, chunk, 0, want, cur)
        if (g <= 0) break
        writeSyncAll(wfd, chunk, g)
        cur += g
        left -= g
      }
      closeSync(wfd)
    }
  } finally {
    closeSync(fd)
  }
  return n
}
function writeSyncAll(fd, buf, len) {
  let off = 0
  while (off < len) off += fsWriteSync(fd, buf, off, len - off)
}

/* ── ③ 规划 ── */
function plan(targetHome, workspace) {
  const items = []
  for (const e of manifest.entries ?? []) {
    const [top, ...rest] = e.rel.split('/')
    const sub = rest.join('/')
    if (top === 'dsh-home') items.push({ src: join(TMP, e.rel), dst: join(targetHome, sub), rel: e.rel, size: e.size })
    else if (top === 'workspace') items.push({ src: join(TMP, e.rel), dst: join(workspace, sub), rel: e.rel, size: e.size })
  }
  return items
}

const BACKUP_NAMES = [
  '.credentials.yaml', 'settings.yaml', 'AGENTS.md', 'prompt-inject.md', 'cordis.patch.yml',
]

function backupExisting(targetHome, ts) {
  const dir = join(targetHome, '.restore-backup-' + ts)
  const saved = []
  const put = (src, rel) => {
    if (!existsSync(src)) return
    const dst = join(dir, rel)
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    saved.push(rel)
  }
  for (const n of BACKUP_NAMES) put(join(targetHome, n), n)
  const pdir = join(targetHome, 'profiles')
  if (existsSync(pdir)) {
    for (const e of readdirSync(pdir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      for (const f of ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-lock.yaml']) {
        put(join(pdir, e.name, f), join('profiles', e.name, f))
      }
    }
  }
  return { dir, saved }
}

/* ── ④ 改写 profile 里的绝对路径 + 重建 junction ── */
function relocateProfiles(targetHome, workspace, { dryRun }) {
  const pdir = join(targetHome, 'profiles')
  if (!existsSync(pdir)) return { rewritten: [], junctions: [], failed: [] }
  const rewritten = []
  const junctions = []
  const failed = []
  for (const e of readdirSync(pdir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const pkgPath = join(pdir, e.name, 'package.json')
    if (!existsSync(pkgPath)) continue
    let pkg
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
    let touched = false
    for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
      const s = String(spec)
      const m = s.match(/^(file:|link:)([A-Za-z]:[\\/].*)$/)
      if (!m) continue
      const srcAbs = m[2].split('/').join('\\')
      const short = name.split('/').pop()
      // 新位置：优先「工作区下同名目录」，其次「工作区下与原目录同名」
      const cands = [join(workspace, short), join(workspace, basename(dirname(srcAbs)))]
      const hit = cands.find((p) => existsSync(join(p, 'package.json')))
      const newAbs = hit ?? join(workspace, short)
      const newSpec = m[1] + newAbs.split('\\').join('/')
      if (newSpec !== s) {
        pkg.dependencies[name] = newSpec
        touched = true
        rewritten.push({ profile: e.name, pkg: name, from: s, to: newSpec, exists: existsSync(join(newAbs, 'package.json')) })
      }
      // junction
      const linkPath = join(pdir, e.name, 'node_modules', name)
      if (!existsSync(linkPath) && existsSync(newAbs)) {
        junctions.push({ profile: e.name, name, target: newAbs, link: linkPath })
        if (!dryRun) {
          try {
            mkdirSync(dirname(linkPath), { recursive: true })
            symlinkSync(newAbs, linkPath, 'junction')
          } catch (err) {
            failed.push({ name, link: linkPath, error: String(err?.message ?? err).slice(0, 120) })
          }
        }
      }
    }
    if (touched && !dryRun) {
      writeFileSync(pkgPath + '.bak-restore-' + stamp(), readFileSync(pkgPath))
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    }
  }
  return { rewritten, junctions, failed }
}

/* ── 主流程 ── */
const verifyOnly = flag('--verify-only')
const dryRun = flag('--dry-run')
const targetHome = resolve(opt('--target-home', process.env.DSH_HOME || join(homedir(), '.dsh')))
const workspace = resolve(opt('--workspace', join(dirname(targetHome), 'Deepseek工作区')))
const only = opt('--volumes', '') ? String(opt('--volumes')).split(',').map((s) => s.trim()).filter(Boolean) : null

sayHeader()

log('① 校验卷哈希…')
const bad = verifyVolumes()
if (bad) {
  warn('\n✗ ' + bad + ' 个卷校验失败 —— 传输可能损坏，先重新拷一份。')
  process.exit(2)
}
if (verifyOnly) { log('\n✓ 校验通过（只校验，未写任何文件）'); process.exit(0) }

log('\n② 解包到临时目录…')
if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const vols = (manifest.volumes ?? []).filter((v) => !only || only.some((o) => v.file.startsWith(o)))
for (const v of vols) {
  const n = unpackVolume(join(PKG, v.file), TMP)
  log('  ' + v.file + ' → ' + n + ' 项')
}

const items = plan(targetHome, workspace)
log('\n③ 计划：' + items.length + ' 个文件')
log('  DSH_HOME  → ' + targetHome)
log('  工作区    → ' + workspace)
const existsCount = items.filter((i) => existsSync(i.dst)).length
log('  其中会覆盖已存在文件：' + existsCount + ' 个（覆盖前先备份到 .restore-backup-<ts>）')
for (const i of items.slice(0, 12)) log('    ' + i.rel + '  →  ' + i.dst)
if (items.length > 12) log('    …（还有 ' + (items.length - 12) + ' 个）')

if (dryRun) {
  log('\n--dry-run：到此为止，没有写任何文件。')
  log('去掉 --dry-run 即真正恢复。')
  rmSync(TMP, { recursive: true, force: true })
  process.exit(0)
}

log('\n④ 备份目标机现有配置…')
const bk = backupExisting(targetHome, stamp())
log('  已备份 ' + bk.saved.length + ' 个文件 → ' + bk.dir)

log('\n⑤ 写入…')
let ok = 0
const failed = []
for (const i of items) {
  try {
    mkdirSync(dirname(i.dst), { recursive: true })
    copyFileSync(i.src, i.dst)
    ok += 1
  } catch (e) {
    failed.push({ rel: i.rel, error: String(e?.message ?? e).slice(0, 160) })
  }
  if (ok % 500 === 0) log('  …' + ok + '/' + items.length)
}
log('  写入成功 ' + ok + ' / ' + items.length)

log('\n⑥ 改写 profile 绝对路径 + 重建 junction…')
const rel = relocateProfiles(targetHome, workspace, { dryRun: false })
log('  改写依赖路径：' + rel.rewritten.length + ' 处')
for (const r of rel.rewritten.slice(0, 8)) log('    [' + r.profile + '] ' + r.pkg + '：' + (r.exists ? 'OK' : '⚠ 目标目录不存在') )
log('  重建 junction：' + rel.junctions.length + ' 个' + (rel.failed.length ? '（失败 ' + rel.failed.length + '）' : ''))

const report = {
  restoredAt: new Date().toISOString(),
  from: manifest.source,
  to: { dshHome: targetHome, workspace },
  files: { planned: items.length, written: ok, failed: failed.length },
  backupDir: bk.dir,
  rewrittenDeps: rel.rewritten,
  junctions: rel.junctions,
  junctionFailures: rel.failed,
  failedFiles: failed,
  skippedFromPackage: manifest.skipped ?? [],
}
writeFileSync(join(PKG, 'RESTORE-REPORT.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
rmSync(TMP, { recursive: true, force: true })

log('\n⑦ 还需要你手动做的（必读）')
log('  1) 每个 profile 目录跑一次依赖安装：')
const pdir = join(targetHome, 'profiles')
if (existsSync(pdir)) {
  for (const e of readdirSync(pdir, { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(join(pdir, e.name, 'package.json'))) log('       cd "' + join(pdir, e.name) + '" && pnpm install')
  }
}
log('  2) 启动 DSH（桌面版双击图标；CLI 版 dsh web）')
log('  3) 打开 设置 核对：插件都在、无「缺 dsh.bundle」告警、记忆库条数对、会话列表在')
log('  4) 调一次模型确认密钥通；包里的密钥是来源机的，必要时换成你的')
log('  5) 确认没问题后：删掉这个迁移包，或轮换一次密钥')
if (failed.length) warn('\n  ⚠ ' + failed.length + ' 个文件写入失败，详见 RESTORE-REPORT.json')
log('\n报告：' + join(PKG, 'RESTORE-REPORT.json'))
