/**
 * DSH 插件迁移器 · 恢复引擎（零依赖，随迁移包一起拷走）
 *
 * 两种用法：
 *   ① 命令行（拷到目标机器上跑）：
 *        node restore.mjs [--profile web] [--root D:/插件根目录] [--dry-run] …
 *   ② 被 @dsh-external/dsh-plugin-migrator 的宿主进程内直接 import 调用：
 *        const { restore } = await import('file:///…/restore.mjs'); restore({ … })
 *
 * 选项：见 parseArgs() / restore() 的 opts。
 *
 * 做的事：
 *   ① 本地插件（file:/link:/注入态）→ 拷源码到 <root>/<包目录名>（缺省沿用原路径）
 *   ② 远程插件（npm/github 版本号）→ 原样写回依赖声明，由 npm/pnpm 安装
 *   ③ 写 profile/package.json 的 dependencies + dsh.profile.bundles（写前备份 .bak-<时间戳>）
 *   ④ 建 node_modules/<包名> junction（Windows 免管理员）
 *   ⑤ 迁移 cordis.patch.yml 相关条目（按 id 去重，防 "duplicate loader entry id" 崩溃）
 *
 * 完成后需重启 DSH 生效（桌面版：关窗口，再双击图标）。
 */

import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const EXCLUDE = ['node_modules', '.git', '.tmp', '_backups', '.pnpm', '.deploy-backup*', '*.log']
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

function copyDir(src, dest, exclude = EXCLUDE) {
  mkdirSync(dest, { recursive: true })
  let files = 0
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (exclude.some((r) => (r.endsWith('*') ? entry.name.startsWith(r.slice(0, -1)) : entry.name === r))) continue
    const from = join(src, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) files += copyDir(from, to, exclude)
    else if (entry.isFile()) { copyFileSync(from, to); files += 1 }
  }
  return files
}

function linkDir(target, linkPath) {
  rmSync(linkPath, { recursive: true, force: true })
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

const isLink = (p) => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }

/**
 * 恢复一个迁移包。
 * @param {object} opts
 * @param {string} opts.manifestPath  manifest.json 路径（必填）
 * @param {string} [opts.profile]     目标 profile，默认 web
 * @param {string} [opts.dshHome]     DSH 主目录，默认 $DSH_HOME 或 ~/.dsh
 * @param {string} [opts.root]        本地插件源码落盘根目录（缺省沿用原路径）
 * @param {boolean} [opts.dryRun]     只预览
 * @param {boolean} [opts.force]      目标目录已存在时覆盖
 * @param {boolean} [opts.noBundles]  不写 bundles 数组
 * @param {string[]} [opts.only]      只恢复这些插件
 * @returns {{ok:boolean,fatal?:string,lines:string[],written:string[],plan:string[]}}
 */
export function restore(opts = {}) {
  const lines = []
  const extraWarnings = []
  const say = (l) => { lines.push(l) }
  const manifestPath = opts.manifestPath ? resolve(opts.manifestPath) : join(SELF_DIR, 'manifest.json')
  if (!existsSync(manifestPath)) return { ok: false, fatal: '找不到清单：' + manifestPath, lines, written: [], plan: [] }
  const manifest = readJson(manifestPath)
  if (!manifest?.plugins) return { ok: false, fatal: '清单格式不对（缺 plugins）：' + manifestPath, lines, written: [], plan: [] }
  const packRoot = dirname(manifestPath)

  const dshHome = resolve(opts.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh'))
  const profilesDir = join(dshHome, 'profiles')
  const profile = opts.profile || 'web'
  const profileDir = join(profilesDir, profile)
  if (!existsSync(profileDir)) {
    const avail = existsSync(profilesDir) ? readdirSync(profilesDir).filter((d) => !d.startsWith('.')).join(' / ') : '(无)'
    return { ok: false, fatal: `目标 profile 不存在：${profileDir}\n可用 profile：${avail}`, lines, written: [], plan: [] }
  }

  const dryRun = Boolean(opts.dryRun)
  const force = Boolean(opts.force)
  const noBundles = Boolean(opts.noBundles)
  const only = Array.isArray(opts.only) && opts.only.length ? opts.only : null

  const pkgPath = join(profileDir, 'package.json')
  const pkgExists = existsSync(pkgPath)
  const pkg = pkgExists ? readJson(pkgPath) : { name: 'dsh-profile-' + profile, private: true, dependencies: {} }
  // 解析不了就绝不覆盖：否则会把用户原有的依赖声明抹成空文件（比任何迁移失败都严重）
  if (pkgExists && !pkg) {
    return {
      ok: false,
      fatal: `目标 profile 的 package.json 无法解析，已中止（不覆盖）：${pkgPath}\n请先修好该文件（常见原因：JSON 被写坏、非法 BOM、多余逗号）再运行。`,
      lines, written: [], plan: [],
    }
  }
  pkg.dependencies ||= {}
  pkg.dsh ||= {}
  pkg.dsh.profile ||= {}
  pkg.dsh.profile.bundles ||= []
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const oldPatch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const haveIds = new Set([...oldPatch.matchAll(/^\s*-?\s*id:\s*([^\s#]+)/gm)].map((m) => m[1]))
  let patchText = oldPatch

  say('迁移包：' + packRoot)
  say('目标：' + profileDir + (dryRun ? '   [DRY-RUN 只预览，不写任何文件]' : ''))
  say('')

  const rootOverride = typeof opts.root === 'string' && opts.root.trim() ? resolve(opts.root.trim()) : null
  const plan = []
  let patchDirty = false

  for (const p of manifest.plugins) {
    if (only && !only.includes(p.name)) continue
    let spec = p.spec
    const notes = []
    const item = { name: p.name, actions: [], notes }

    if (p.kind === 'local' && p.packageDir) {
      const from = join(packRoot, p.packageDir)
      if (!existsSync(from)) {
        notes.push('迁移包里缺源码目录 ' + p.packageDir + '，跳过')
        plan.push(item)
        continue
      }
      const destDir = rootOverride ? join(rootOverride, basename(p.originalDir || p.name)) : resolve(p.originalDir || join(dshHome, 'migrated-plugins', basename(p.name)))
      spec = 'file:' + destDir.split(sep).join('/')
      item.destDir = destDir
      const same = resolve(from).toLowerCase() === resolve(destDir).toLowerCase()
      if (same) notes.push('源码已在目标位置')
      else if (existsSync(destDir) && !force) notes.push('目标目录已存在，保留原样（要覆盖加 force/--force）')
      else if (dryRun) item.actions.push('COPY ' + from + ' → ' + destDir)
      else {
        const n = copyDir(from, destDir)
        item.actions.push('拷贝源码 ' + n + ' 个文件 → ' + destDir)
      }
    } else if (p.kind === 'local') {
      notes.push('本地插件但迁移包里没有源码快照，只写依赖声明（若无源码会装不上）')
    } else {
      notes.push('远程包（' + spec + '），需在目标机 npm/pnpm install')
    }

    item.spec = spec
    pkg.dependencies[p.name] = spec

    // 「能不能被 loader 加载」决定要不要进 bundles：不在 bundles 里只是不生效，
    // 而在 bundles 里但包不存在 / 包没声明 dsh.bundle.patch（DSH ≥ 0.1.2-rc.1 硬要求）
    // → 启动直接失败。安全优先：任一条不满足就只写依赖声明 + 说明。
    const installedOnTarget = existsSync(join(profileDir, 'node_modules', p.name))
    const pkgPresent = p.kind === 'local'
      ? Boolean(item.destDir && existsSync(join(item.destDir, 'package.json')))
      : installedOnTarget
    const probeDir = p.kind === 'local'
      ? item.destDir
      : (installedOnTarget ? join(profileDir, 'node_modules', p.name) : null)
    let bundlePatch = null
    try { bundlePatch = probeDir ? (readJson(join(probeDir, 'package.json'))?.dsh?.bundle?.patch ?? null) : null } catch { /* 读不到当缺 */ }
    const ready = pkgPresent && Boolean(bundlePatch)
    if (!noBundles && !pkg.dsh.profile.bundles.includes(p.name)) {
      if (ready) pkg.dsh.profile.bundles.push(p.name)
      else {
        extraWarnings.push(p.name)
        if (pkgPresent && !bundlePatch) {
          notes.push('包的 package.json 没有 dsh.bundle.patch，**暂不写入 bundles**：'
            + 'DSH ≥ 0.1.2-rc.1 启动会因 "declares no dsh.bundle in its package.json" 直接报错。'
            + '修法：在插件目录加 cordis.patch.yml（内容 `- insert: [{ id: <短名>, name: <包名> }]`）'
            + '并给 package.json 加 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，再重跑本脚本')
        } else {
          notes.push('只写进 dependencies，**暂不写入 bundles**：包还没到位（远程包需在该 profile 目录跑 npm/pnpm install；装好后重跑本脚本或手动把包名加进 dsh.profile.bundles），否则重启会因 loader 找不到包而报错')
        }
      }
    }

    if (p.kind === 'local' && item.destDir) {
      const linkPath = join(profileDir, 'node_modules', p.name)
      const realDir = existsSync(linkPath) && !isLink(linkPath)
      if (realDir) notes.push('node_modules 里已是实体目录，未改动')
      else if (dryRun) item.actions.push('JUNCTION node_modules/' + p.name + ' → ' + item.destDir)
      else {
        try { linkDir(item.destDir, linkPath); item.actions.push('已建链接 node_modules/' + p.name) }
        catch (e) { notes.push('建链接失败：' + String(e).slice(0, 120)) }
      }
    }

    for (const patch of p.patch || []) {
      if (!patch?.id) continue
      if (haveIds.has(patch.id)) { notes.push('patch 条目 ' + patch.id + ' 已存在，跳过'); continue }
      if (dryRun) { item.actions.push('PATCH 追加 ' + patch.id); continue }
      patchText += '\n- id: ' + patch.id + '\n' + (patch.name ? '  name: ' + JSON.stringify(patch.name) + '\n' : '') + '  disabled: ' + (patch.disabled ? 'true' : 'false') + '\n'
      haveIds.add(patch.id)
      patchDirty = true
      item.actions.push('patch 条目 ' + patch.id + ' 已迁移')
    }
    plan.push(item)
  }

  const written = []
  if (!dryRun) {
    if (existsSync(pkgPath)) { writeFileSync(pkgPath + '.bak-' + stamp(), readFileSync(pkgPath, 'utf8')); written.push(pkgPath + '.bak-' + stamp()) }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    written.push(pkgPath)
    if (patchDirty) {
      if (existsSync(patchPath)) { writeFileSync(patchPath + '.bak-' + stamp(), oldPatch); written.push(patchPath + '.bak-' + stamp()) }
      writeFileSync(patchPath, patchText, 'utf8')
      written.push(patchPath)
    }
  }

  say('')
  say('== 结果 ==')
  for (const r of plan) {
    say('· ' + r.name + '  [' + (r.spec || '') + ']')
    for (const a of r.actions) say('    → ' + a)
    for (const n of r.notes) say('    - ' + n)
  }
  say('')
  say(dryRun ? 'DRY-RUN：未写入任何文件。' : '已写入：' + written.filter((w) => !w.includes('.bak-')).join('、') + '（原文件已备份为 .bak-' + stamp() + '）')
  if (extraWarnings.length) say('注意：' + extraWarnings.length + ' 个插件没能进 bundles（见上方说明）：' + extraWarnings.join(', '))
  if (!dryRun) say('下一步：重启 DSH 生效（桌面版：关窗口，再双击图标）。')

  return { ok: true, lines, written, plan, profileDir }
}

/** 只读预览：列出迁移包内容。 */
export function describe(manifestPath) {
  const p = manifestPath ? resolve(manifestPath) : join(SELF_DIR, 'manifest.json')
  const m = readJson(p)
  if (!m?.plugins) return { ok: false, lines: ['不是迁移包（缺 manifest.json）：' + p] }
  const lines = [
    '迁移包：' + dirname(p),
    '导出时间：' + (m.createdAt || '?'),
    '来源：profile=' + (m.source?.profile || '?') + '  机器=' + (m.source?.host || '?') + '  源码根=' + (m.source?.sourceRoot || '?'),
    '插件 ' + m.plugins.length + ' 个：',
  ]
  for (const x of m.plugins) lines.push('  - ' + x.name + '@' + (x.version || '?') + '  [' + x.kind + (x.packageDir ? '，含源码 ' + (x.fileCount ?? '?') + ' 文件' : '，仅声明') + ']')
  return { ok: true, lines, manifest: m }
}

/** ── 命令行入口 ─────────────────────────────────────── */
function parseArgs(argv) {
  const out = { flags: new Set() }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { out[key] = next; i += 1 } else out.flags.add(key)
  }
  return out
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) {
  const argv = parseArgs(process.argv.slice(2))
  if (argv.flags.has('list')) {
    const d = describe(argv.manifest)
    console.log(d.lines.join('\n'))
    process.exit(d.ok ? 0 : 2)
  }
  const res = restore({
    manifestPath: argv.manifest,
    profile: argv.profile,
    dshHome: argv['dsh-home'],
    root: argv.root,
    dryRun: argv.flags.has('dry-run'),
    force: argv.flags.has('force'),
    noBundles: argv.flags.has('no-bundles'),
    only: typeof argv.only === 'string' ? argv.only.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  })
  console.log([...(res.fatal ? [res.fatal] : []), ...res.lines].join('\n'))
  process.exit(res.ok ? 0 : 2)
}

export const RESTORE_EXCLUDES = EXCLUDE
export { stamp, readJson, copyDir, linkDir }
