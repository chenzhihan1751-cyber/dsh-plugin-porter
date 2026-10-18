#!/usr/bin/env node
/**
 * DSH 启动前体检：在**不重启**的前提下，跑 DSH 启动时的那套 profile 装配校验。
 *
 * 背景：DSH ≥ 0.1.2-rc.1 启动会校验 `dsh.profile.bundles` 里每个包（必须有
 * `dsh.bundle.patch`、patch 文件要能读能解析），任何一条不合格 → 直接抛错起不来。
 * 这类错只在启动瞬间出现，事后翻日志都不一定留痕，所以把校验搬到离线跑。
 *
 * 做法（关键）：`@deepseek-ai/dsh-app-boot` 导出了 `loadProfile`——直接调**真函数**
 * （与启动完全同源，不是复刻）。取不到该包时才退回复刻逻辑，保证老版本 DSH 也能用。
 *
 * 用法：
 *   node check-profile-boot.mjs [--profile web] [--dsh-home <dir>] [--quiet] [--no-user-layer]
 * 退出码：0 = 通过；1 = 有问题（逐条列出，含 DSH 原文报错）
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt
}
const has = (name) => args.includes('--' + name)

const dshHome = resolve(flag('dsh-home', process.env.DSH_HOME || join(homedir(), '.dsh')))
const profile = flag('profile', 'web')
const quiet = has('quiet')
const userLayer = !has('no-user-layer')

function packageDirFromAnchor(anchorFile, packageName) {
  let dir = dirname(resolve(anchorFile))
  for (;;) {
    const candidate = join(dir, 'node_modules', packageName)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function findInstallAnchor() {
  for (const c of [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(process.env.ProgramFiles ?? '', 'nodejs', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]) {
    if (c && existsSync(c)) return c
  }
  return null
}

const profileDir = join(dshHome, 'profiles', profile)
const manifestPath = join(profileDir, 'package.json')
const installAnchor = findInstallAnchor()

/** 找一个能 require/import 的锚点上下文。 */
function reqFrom(...bases) {
  for (const b of bases.filter(Boolean)) {
    try { return createRequire(pathToFileURL(b).href) } catch { /* 换锚点 */ }
  }
  return null
}
const req = reqFrom(installAnchor, join(profileDir, 'package.json'))

function readManifest() {
  const raw = readFileSync(manifestPath, 'utf8')
  const withBom = raw.charCodeAt(0) === 0xfeff
  return { manifest: JSON.parse(raw.replace(/^\uFEFF/, '')), withBom }
}

/** 首选：调 DSH 自己的 loadProfile（与启动同源）。返回 {ok, lines, problems} 或 null（拿不到该包）。 */
async function runRealCheck() {
  if (!req) return null
  let entry
  try { entry = req.resolve('@deepseek-ai/dsh-app-boot') } catch { return null }
  let mod
  try { mod = await import(pathToFileURL(entry).href) } catch { return null }
  if (typeof mod.loadProfile !== 'function') return null

  const lines = []
  const problems = []
  const ok = (s) => lines.push('  ✔ ' + s)
  const bad = (s) => { lines.push('  ✗ ' + s); problems.push(s) }

  lines.push('方式：直接调用 DSH 自己的 loadProfile()（与启动同源）')
  lines.push('  实现: ' + entry)
  lines.push('')
  try {
    const loaded = mod.loadProfile('dsh', profile, installAnchor, dshHome, { userLayer })
    ok(`loadProfile 通过：${loaded.layers.length} 个 bundle 层 + profile 用户层 ${userLayer ? loaded.patches.length + ' 条' : '（已跳过）'}`)
    lines.push('')
    for (const l of loaded.layers) {
      let pkg = null
      try { pkg = JSON.parse(readFileSync(join(l.packageDir, 'package.json'), 'utf8')) } catch { /* 忽略 */ }
      const patchRel = pkg?.dsh?.bundle?.patch ?? '(缺 dsh.bundle)'
      ok(`${l.packageName}\n      目录: ${l.packageDir}\n      patch: ${patchRel} → ${l.patches.length} 条`)
    }
  } catch (e) {
    bad(String(e?.message ?? e))
    lines.push('')
    lines.push('  ↳ 这条报错就是 DSH 启动时会抛的同一条（已离线复现）。修好后重跑本脚本即可确认。')
  }
  return { ok: problems.length === 0, lines, problems }
}

/** 兜底：拿不到 dsh-app-boot 时，按源码逻辑复刻校验。 */
function runReplicaCheck() {
  const lines = []
  const problems = []
  const ok = (s) => lines.push('  ✔ ' + s)
  const bad = (s) => { lines.push('  ✗ ' + s); problems.push(s) }

  lines.push('方式：复刻校验（没找到 dsh-app-boot，退回复刻逻辑）')
  lines.push('')

  let yaml = null
  let schema = null
  if (req) {
    try { yaml = req('js-yaml') } catch { /* 无 */ }
    try { schema = req('@deepseek-ai/cordis-plugin-include')?.entryListSchema } catch { /* 无 */ }
  }
  const load = (content) => (yaml && schema) ? yaml.load(content, { schema }) : (yaml ? yaml.load(content) : null)

  const { manifest, withBom } = readManifest()
  if (withBom) lines.push('  ! 清单带 BOM（能读，但建议去掉）')
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const patchReload = manifest.dsh?.profile?.patchReload
  if (patchReload !== undefined && patchReload !== 'live' && patchReload !== 'startup') {
    bad(`dsh.profile.patchReload 必须是 "live" 或 "startup"，当前 ${JSON.stringify(patchReload)}`)
  } else if (patchReload) ok('dsh.profile.patchReload = ' + patchReload)

  for (const name of bundles) {
    let dir = null
    for (const anchor of [installAnchor, join(profileDir, 'package.json')].filter(Boolean)) {
      dir = packageDirFromAnchor(anchor, name)
      if (dir) break
    }
    if (!dir) { bad(`${name}：解析不到包目录`); continue }
    let pkg = null
    try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch (e) {
      bad(`${name}：package.json 读不了/不是 JSON（${String(e.message)}）`); continue
    }
    const declared = pkg.dsh?.bundle?.patch
    if (declared === undefined) {
      bad(`${name}：package.json 缺 dsh.bundle —— 启动会报 "declares no dsh.bundle"；`
        + '修法：加 "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } 并提供该文件')
      continue
    }
    const patchPath = join(dir, declared)
    if (!existsSync(patchPath)) { bad(`${name}：dsh.bundle.patch=${declared} 但文件不存在`); continue }
    if (!yaml) { ok(`${name}：dsh.bundle.patch=${declared}（内容未校验）`); continue }
    let parsed
    try { parsed = load(readFileSync(patchPath, 'utf8')) } catch (e) { bad(`${name}：patch 解析失败 ${String(e.message)}`); continue }
    if (!Array.isArray(parsed)) { bad(`${name}：patch 必须是顶层 YAML 数组`); continue }
    ok(`${name}：patch 可解析（${parsed.length} 条）`)
  }
  return { ok: problems.length === 0, lines, problems }
}

/** 供其它脚本复用：跑一次真实 loadProfile 体检 → { ok, lines, problems, via }。 */
export async function checkBoot(opts = {}) {
  const home = resolve(opts.dshHome || dshHome)
  const prof = opts.profile || profile
  const dir = join(home, 'profiles', prof)
  const mf = join(dir, 'package.json')
  if (!existsSync(mf)) return { ok: false, lines: [], problems: ['profile 清单不存在：' + mf], via: 'none' }
  const anchor = findInstallAnchor()
  const r = reqFrom(anchor, mf)
  if (!r) return { ok: false, lines: [], problems: ['无法建立模块解析上下文'], via: 'none' }
  let entry = null
  try { entry = r.resolve('@deepseek-ai/dsh-app-boot') } catch { /* 退回复刻 */ }
  if (entry) {
    let mod = null
    try { mod = await import(pathToFileURL(entry).href) } catch { /* 退回复刻 */ }
    if (typeof mod?.loadProfile === 'function') {
      try {
        const loaded = mod.loadProfile('dsh', prof, anchor, home, { userLayer: opts.userLayer !== false })
        return { ok: true, lines: [`✔ loadProfile 通过：${loaded.layers.length} 个 bundle 层 + 用户层 ${loaded.patches.length} 条`], problems: [], via: 'loadProfile', layers: loaded.layers.length }
      } catch (e) {
        return { ok: false, lines: [], problems: [String(e?.message ?? e)], via: 'loadProfile' }
      }
    }
  }
  return { ok: false, lines: ['（取不到 dsh-app-boot，无法离线体检）'], problems: [], via: 'none' }
}

async function main() {
  if (!existsSync(manifestPath)) {
    console.error('✗ profile 清单不存在：' + manifestPath)
    process.exit(1)
  }
  const head = [
    'DSH 启动前体检',
    '  DSH_HOME = ' + dshHome,
    '  profile  = ' + profile + '  (' + profileDir + ')',
    '  dsh 锚点 = ' + (installAnchor ?? '(未找到)'),
    '',
  ]
  const result = (await runRealCheck()) ?? runReplicaCheck()
  const { manifest } = readManifest()
  const self = (manifest.dsh?.profile?.bundles ?? []).filter((b) => b.includes('dsh-plugin-migrator'))
  const tail = ['', 'migrator 相关：' + (self.length ? '在 bundles 里（' + self.join(', ') + '）' : '不在 bundles 里')]

  if (!quiet) console.log([...head, ...result.lines, ...tail].join('\n'))
  if (!result.ok) {
    console.error('\n✗ 体检不通过，共 ' + result.problems.length + ' 项（DSH 启动会失败）：')
    for (const p of result.problems) console.error('   - ' + p)
    process.exit(1)
  }
  if (!quiet) console.log('\n✔ 体检通过：这套 profile 配置在 DSH 启动时不会抛装配错误')
}

// 作为脚本直接运行时才执行 main（被 import 复用 checkBoot 时不跑）
const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (isMain) main()
