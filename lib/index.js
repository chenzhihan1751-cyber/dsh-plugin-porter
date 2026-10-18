/**
 * @dsh-external/dsh-plugin-migrator — host half.
 *
 * 插件迁移器：把这台机器上装好的 DSH 插件「选中 → 打包 → 在别处/别的 profile 复原」。
 *
 * 与邻居的分工（不抢活）：
 *   · dsh-super-injector 的「插件管理」= 装卸本机插件（inject/uninstall）
 *   · dshmarket = 从市场装插件
 *   · 本插件 = 只在「搬迁」这件事上动手：导出迁移包 / 导入迁移包 / 搬到另一个 profile
 *
 * 唯一写入者声明：本插件只写
 *   ~/.dsh/profiles/<profile>/package.json（先备份 .bak-<时间戳>）
 *   ~/.dsh/profiles/<profile>/cordis.patch.yml（先备份，且按 id 去重防重复 entry）
 *   <输出目录>/plugin-migration-<时间戳>/…（迁移包）
 *   目标插件源码目录（导入时拷贝）
 * 不碰 ~/.dsh/docs/*（错误库/AI 记忆库有各自唯一写入者）。
 *
 * 零构建：本文件是手写 ESM（本机没有 dsh 源码 checkout / tsc，无法跑 tsc 编译）。
 *
 * 宿主 API：/plugin-migrator/api/{list,export,import,copy,inspect}
 */

import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, copyFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zipDirectory, unzipTo } from './zip.mjs'
import { buildAllInOne, exportAllInOne, getJob, listJobs, startAllInOne } from './allinone.js'
import { estimateScope, exportFull, getFullJob, listFullJobs, startFullMigration } from './fullmigration.js'

const RESTORE_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'restore.mjs')

/** 运行时诊断（面板/API 可见，方便排查「工具没注册上」这类问题）。 */
const runtime = { defineToolFrom: null, tools: [], error: null }

/** 本插件自己的状态文件（唯一写入者）：只记最近导出到哪，供「路径菜单」快捷跳转。 */
const stateFile = () => join(dshHome(), 'plugin-migrator', 'state.json')
const readState = () => readJson(stateFile()) ?? {}
function writeState(patch) {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify({ ...readState(), ...patch }, null, 2) + '\n', 'utf8')
  } catch { /* 记不住不影响主流程 */ }
}

/**
 * 取宿主工具的 defineTool（做参数 schema → JSON Schema 转换，不能省略）。
 * 多路探测：① DSH 进程自身入口所在的安装目录（npm 把 dsh-tools 嵌在 dsh/node_modules 里）
 * ② 本插件目录 ③ 当前 profile 目录。全都失败 → 只跳过 agent 工具，面板照常可用。
 */
function resolveDefineTool() {
  const bases = []
  try { if (process.argv[1]) bases.push(process.argv[1]) } catch { /* 忽略 */ }
  bases.push(join(dshHome(), 'profiles', 'web', 'package.json'))
  bases.push(import.meta.url)
  for (const base of bases) {
    try {
      const req = createRequire(base.startsWith('file:') ? base : join(base))
      const mod = req('@deepseek-ai/dsh-tools')
      if (typeof mod?.defineTool === 'function') { runtime.defineToolFrom = base; return mod.defineTool }
    } catch { /* 换下一条路 */ }
  }
  return null
}

export const name = '@dsh-external/dsh-plugin-migrator'
export const inject = ['tools', 'webServer']

/** 默认值（不导出 Config：DSH 要求 Config 是 schemastery schema，本插件零依赖，配置走 patch 层或留空）。 */
const DEFAULTS = { profile: 'web', exportRoot: '', packagesRoot: '' }

/** 迁移包里不打包的东西：依赖目录、仓库元数据、缓存与备份。 */
const EXCLUDE = [
  'node_modules', '.git', '.tmp', '_backups', '.pnpm', '.deploy-backup*', '*.log',
  'dsh-browser-profile', '.engine', '.venv', 'venv', '*.zip', '*.tgz', '*.7z',
]

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const profilesDir = () => join(dshHome(), 'profiles')

function copyDir(src, dest, exclude = EXCLUDE) {
  // 备份/临时文件不进迁移包：除了省体积，`.bak-xxx.` 这种带尾点的名字在 Windows 上
  // 一旦落盘就删不掉（资源管理器/pwsh 都访问不了），会污染输出目录。
  const SKIP_FILE = /\.bak(-|\.|$)|\.orig$|\.old$|~$/i
  mkdirSync(dest, { recursive: true })
  let files = 0
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (exclude.some((r) => (r.endsWith('*') ? e.name.startsWith(r.slice(0, -1)) : e.name === r))) continue
    if (e.isFile() && SKIP_FILE.test(e.name)) continue
    const from = join(src, e.name)
    const to = join(dest, e.name)
    if (e.isDirectory()) files += copyDir(from, to, exclude)
    else if (e.isFile()) { copyFileSync(from, to); files += 1 }
  }
  return files
}

function dirSize(dir, cap = 20000) {
  let bytes = 0
  let files = 0
  const walk = (d) => {
    if (files > cap) return
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) { try { bytes += statSync(p).size; files += 1 } catch { /* 跳过 */ } }
      if (files > cap) return
    }
  }
  walk(dir)
  return { bytes, files, truncated: files > cap }
}

const isLocalSpec = (spec) => typeof spec === 'string' && /^(file:|link:|\.|\/|[A-Za-z]:[\\/])/.test(spec)
const shortName = (n) => (n || '').split('/').pop()

/** 'file:D:/a/b' / 'link:D:/a/b' → 'D:\a\b'（用户自己的源码目录）。 */
function specToDir(spec) {
  if (typeof spec !== 'string') return null
  const m = spec.match(/^(?:file|link):(.+)$/)
  if (!m) return null
  let p = m[1].trim().replace(/^\/\/+/, '')
  try { p = decodeURIComponent(p) } catch { /* 原样使用 */ }
  return resolve(p.replace(/\//g, sep))
}

/**
 * patch 条目 ↔ 插件 的归属判断。loader entry id 通常不是包名（如
 * `ui-skin-orca-link` 对应 `@dsh-external/dsh-client-ui-skin-orca-link`），
 * 所以按「显式 name 相等」或「包名尾段与 id 互为后缀」两种方式认领。
 */
function patchBelongsTo(entry, packageName) {
  if (!entry) return false
  if (entry.name && entry.name === packageName) return true
  const tail = shortName(packageName)
  if (entry.id === packageName || entry.id === tail) return true
  return Boolean(entry.id) && (tail.endsWith(entry.id) || entry.id.endsWith(tail))
}

/** 解析 cordis.patch.yml 的条目（id / name / disabled），用于标注「已禁用」。 */
function readPatchEntries(profileDir) {
  const file = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const out = []
  const blocks = text.split(/^(?=\s*-\s*id:)/m)
  for (const block of blocks) {
    const id = block.match(/^\s*-\s*id:\s*([^\s#]+)/m)?.[1]
    if (!id) continue
    out.push({
      id,
      name: block.match(/^\s*name:\s*['"]?([^'"\s#]+)/m)?.[1] ?? null,
      disabled: /^\s*disabled:\s*true/m.test(block),
      config: /^\s*config:/m.test(block),
    })
  }
  return out
}

function listProfiles() {
  try {
    // 只认「有 package.json 的目录」：profiles/node_modules 这种依赖目录不是 profile
    return readdirSync(profilesDir())
      .filter((d) => !d.startsWith('.') && d !== 'node_modules' && existsSync(join(profilesDir(), d, 'package.json')))
  } catch { return [] }
}

/** 扫描一个 profile 的插件清单。 */
export function scanProfile(profile) {
  const profileDir = join(profilesDir(), profile)
  const warnings = []
  if (!existsSync(profileDir)) return { profile, profileDir, plugins: [], warnings: ['profile 不存在: ' + profileDir] }
  const pkg = readJson(join(profileDir, 'package.json')) || {}
  const bundles = pkg.dsh?.profile?.bundles ?? []
  const deps = pkg.dependencies ?? {}
  const patch = readPatchEntries(profileDir)

  const entries = new Map()
  for (const [n, spec] of Object.entries(deps)) entries.set(n, { name: n, spec: String(spec), source: 'dependency' })

  // 运行时注入的插件（super-injector registry）：不在 package.json 里，但同样值得迁移
  const registryFile = join(dshHome(), 'super-injector', 'registry.json')
  if (existsSync(registryFile)) {
    const list = readJson(registryFile)
    if (Array.isArray(list)) {
      for (const e of list) {
        if (!e?.name) continue
        const prev = entries.get(e.name)
        if (prev) { prev.source = 'dependency+injected'; prev.injectedDir = e.dir ?? null }
        else entries.set(e.name, { name: e.name, spec: 'injected', source: 'injected', injectedDir: e.dir ?? null })
      }
    }
  }

  // ── 第一遍：解析每个插件的候选目录（依赖声明 → 注入记录 → node_modules 安装副本）
  const hasPkg = (d) => Boolean(d) && existsSync(join(d, 'package.json'))
  const inProfile = (d) => Boolean(d) && d.toLowerCase().startsWith(profileDir.toLowerCase())
  const rootVotes = new Map()
  const raw = []
  for (const e of entries.values()) {
    const linkPath = join(profileDir, 'node_modules', e.name)
    let installedDir = null
    let linkTarget = null
    if (existsSync(linkPath)) {
      try { if (lstatSync(linkPath).isSymbolicLink()) linkTarget = realpathSync(linkPath) } catch { /* 链接目标不可读 */ }
      try { installedDir = realpathSync(linkPath) } catch { installedDir = null }
    }
    if (!installedDir && e.injectedDir && existsSync(e.injectedDir)) installedDir = resolve(e.injectedDir)

    const specDir = specToDir(e.spec)
    const injectedSource = e.injectedDir && hasPkg(resolve(e.injectedDir)) ? resolve(e.injectedDir) : null
    let dir = null
    let dirSource = 'none'
    if (hasPkg(specDir)) { dir = specDir; dirSource = 'spec' }
    else if (hasPkg(injectedSource)) { dir = injectedSource; dirSource = 'injected' }
    else if (hasPkg(installedDir)) { dir = installedDir; dirSource = 'installed' }
    else if (specDir) { dir = specDir; dirSource = 'spec(缺失)' }
    if (dir && dirSource !== 'installed' && !inProfile(dir)) {
      const parent = dirname(dir)
      rootVotes.set(parent, (rootVotes.get(parent) ?? 0) + 1)
    }
    raw.push({ e, linkTarget, installedDir, specDir, dir, dirSource, viaSpec: dirSource === 'spec' || dirSource === 'injected' })
  }

  // 插件源码根猜测：多数插件源码所在的那个目录（例：D:\Deepseek工作区）
  let sourceRoot = null
  let bestVotes = 0
  for (const [d, n] of rootVotes) if (n > bestVotes) { bestVotes = n; sourceRoot = d }

  // ── 第二遍：修掉「依赖声明里的路径被写坏」的本地插件（本机 web profile 实际存在此问题：
  //    file:D:/Deepseek?????dsh-xxx 指不到任何地方）→ 回退到 <源码根>/<包名>
  const plugins = []
  let repaired = 0
  for (const r of raw) {
    const e = r.e
    if (!r.viaSpec && sourceRoot) {
      const cand = join(sourceRoot, shortName(e.name))
      if (hasPkg(cand)) { r.dir = cand; r.dirSource = 'guessed'; repaired += 1 }
    }
    const metaDir = hasPkg(r.dir) ? r.dir : r.installedDir
    const pkgMeta = metaDir ? readJson(join(metaDir, 'package.json')) : null
    const kind = isLocalSpec(e.spec) || e.source === 'injected' ? 'local' : 'remote'
    const localUsable = kind === 'local' && hasPkg(r.dir)
    const size = localUsable ? dirSize(r.dir) : { bytes: 0, files: 0, truncated: false }
    const mine = patch.filter((p) => patchBelongsTo(p, e.name))
    // DSH ≥ 0.1.2-rc.1：进 dsh.profile.bundles 的包必须在 package.json 声明 dsh.bundle.patch，
    // 且该 patch 文件真实存在——缺了启动直接抛错（校验见 tools/check-profile-boot.mjs）
    const bundlePatch = pkgMeta?.dsh?.bundle?.patch ?? null
    const bundlePatchOk = Boolean(bundlePatch && metaDir && existsSync(join(metaDir, bundlePatch)))
    plugins.push({
      name: e.name,
      version: pkgMeta?.version ?? null,
      description: (pkgMeta?.description ?? '').slice(0, 120),
      spec: e.spec,
      specBroken: kind === 'local' && !hasPkg(r.specDir) && Boolean(r.specDir),
      source: e.source,
      kind,
      dir: localUsable ? r.dir : r.dir,
      dirSource: r.dirSource,
      installedDir: r.installedDir,
      linked: Boolean(r.linkTarget),
      dirExists: Boolean(metaDir),
      inBundles: bundles.includes(e.name),
      disabled: mine.some((p) => p.disabled),
      patch: mine,
      hasClient: Boolean(pkgMeta?.dsh?.client) || (metaDir ? existsSync(join(metaDir, 'lib', 'client.js')) : false),
      bundlePatch,
      bundlePatchOk,
      needsBundleFix: kind === 'local' && hasPkg(r.dir) && !bundlePatchOk,
      runsStandalone: e.source === 'injected' || String(e.spec) === 'injected',
      sizeBytes: size.bytes,
      fileCount: size.files,
      official: e.name.startsWith('@deepseek-ai/'),
    })
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name))
  if (repaired) warnings.push(repaired + ' 个本地插件的依赖声明路径已损坏（编码转错），已按源码根 ' + sourceRoot + ' 定位到真实目录；迁移时会写成正常路径')
  return { profile, profileDir, sourceRoot, dshVersion: readJson(join(dshHome(), 'package.json'))?.version ?? null, plugins, patches: patch, bundles, warnings }
}

/** 导出迁移包：选中插件 → 独立目录（+ 可选 zip），含 manifest.json / restore.mjs / 说明。 */
/* ─────────────────────────────────────────────────────────────
 *  密钥需求扫描（导出侧）
 *
 *  迁移包**绝不带走密钥值**：这里只找出「哪个插件的哪个字段需要填」，
 *  记进 manifest.secrets（无值），并把快照里真的带密钥的配置抹成空。
 *  目标机导入时由 恢复.bat 弹窗（ask-secrets.ps1）问使用者，再写进目标机。
 *
 *  两大来源（本机实测）：
 *    ① ~/.dsh/settings.yaml 的插件段，如 dsh-dafeiyu.balanceApiKey / chatApiKey
 *    ② 插件源码目录里的配置文件（config.json / .env …）—— 抹值后随包走
 *  另有第三类：代码里硬编码的 sk-xxx —— 抹掉但不进弹窗（记进 manualSecrets 提醒）
 *  ───────────────────────────────────────────────────────────── */

const SECRET_FIELD_RE = /(api[_-]?key|apikey|secret|token|password|passwd|credential)/i
const SECRET_LITERAL_RE = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{20,})/
const CFG_EXT_RE = /\.(json|ya?ml|env|ini|toml)$/i
const CFG_NAME_RE = /(config|setting|secret|credential)/i
const CODE_EXT_RE = /\.(js|mjs|cjs|ts|ps1|bat|cmd|sh|py)$/i

/** 值看起来是不是「真填了」（空串/占位符不算）。 */
const looksFilled = (raw) => {
  const v = String(raw ?? '').trim().replace(/^['"]|['"]$/g, '')
  if (!v) return false
  return !/^(<.*>|x{3,}|\*{3,}|\.{3}|-+|null|none)$/i.test(v)
}

/** ① settings.yaml 插件段里的密钥字段。 */
function scanSettingsSecrets(pluginName) {
  const file = join(dshHome(), 'settings.yaml')
  if (!existsSync(file)) return []
  let lines = []
  try { lines = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/) } catch { return [] }
  const sec = shortName(pluginName)
  const re = new RegExp('^' + sec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':')
  let start = -1
  for (let i = 0; i < lines.length; i += 1) if (re.test(lines[i])) { start = i; break }
  if (start === -1) return []
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) if (/^\S/.test(lines[i])) { end = i; break }
  const out = []
  for (let i = start + 1; i < end; i += 1) {
    const m = /^(\s+)([A-Za-z0-9_.-]+):\s*(.*)$/.exec(lines[i])
    if (!m || !SECRET_FIELD_RE.test(m[2])) continue
    out.push({ scope: 'settings', section: sec, field: m[2], hadValue: looksFilled(m[3]), label: '「' + sec + '」的 ' + m[2] + '（settings.yaml）' })
  }
  return out
}

/** JSON 里所有「键名像密钥」的字符串叶子。 */
function jsonSecretHits(obj, path = [], out = []) {
  if (obj === null || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj)) {
    const p = [...path, k]
    if (v !== null && typeof v === 'object') { jsonSecretHits(v, p, out); continue }
    const keyLooksSecret = SECRET_FIELD_RE.test(k)
    const valueLooksSecret = typeof v === 'string' && SECRET_LITERAL_RE.test(v)
    if (keyLooksSecret || valueLooksSecret) out.push({ path: p, key: k, hadValue: looksFilled(v) || valueLooksSecret })
  }
  return out
}

/** ② 插件源码目录里的配置文件 / ③ 代码里的硬编码密钥。 */
function scanPluginFileSecrets(dir) {
  const cfgHits = []
  const codeHits = []
  const walk = (d, rel) => {
    let entries = []
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (EXCLUDE.some((r) => (r.endsWith('*') ? e.name.startsWith(r.slice(0, -1)) : e.name === r))) continue
      const r2 = rel ? rel + '/' + e.name : e.name
      const full = join(d, e.name)
      if (e.isDirectory()) { walk(full, r2); continue }
      if (!e.isFile()) continue
      const isCfg = CFG_EXT_RE.test(e.name) || CFG_NAME_RE.test(e.name)
      const isCode = CODE_EXT_RE.test(e.name)
      if (!isCfg && !isCode) continue
      try { if (statSync(full).size > 262144) continue } catch { continue }
      let text = ''
      try { text = readFileSync(full, 'utf8') } catch { continue }
      if (isCfg && /\.json$/i.test(e.name)) {
        const obj = readJson(full)
        if (obj) {
          for (const h of jsonSecretHits(obj)) if (h.hadValue) cfgHits.push({ rel: r2, kind: 'json', keyPath: h.path, field: h.key, hadValue: true })
          continue
        }
      }
      if (isCfg) {
        for (const line of text.split(/\r?\n/)) {
          const m = /^\s*([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd)[A-Za-z0-9_.-]*)\s*[=:]\s*(.*)$/i.exec(line)
          if (!m || !looksFilled(m[2])) continue
          cfgHits.push({ rel: r2, kind: 'text', field: m[1], keyPath: [m[1]], hadValue: true })
        }
      }
      if (isCode) {
        for (const line of text.split(/\r?\n/)) {
          const m = SECRET_LITERAL_RE.exec(line)
          if (m) codeHits.push({ rel: r2, sample: m[1].slice(0, 8) + '…' })
        }
      }
    }
  }
  walk(dir, '')
  return { cfgHits, codeHits }
}

/** 抹掉快照里的密钥值（只改快照副本，不动用户源码）。 */
function redactSnapshot(pkgDir, hits) {
  let n = 0
  for (const h of hits) {
    const file = join(pkgDir, h.rel)
    if (!existsSync(file)) continue
    try {
      if (h.kind === 'json') {
        const obj = readJson(file)
        if (!obj) continue
        let cur = obj
        for (let i = 0; i < h.keyPath.length - 1; i += 1) cur = cur?.[h.keyPath[i]]
        if (cur && typeof cur === 'object') { cur[h.keyPath[h.keyPath.length - 1]] = ''; writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8'); n += 1 }
      } else {
        const text = readFileSync(file, 'utf8')
        const re = new RegExp('^(\\s*' + h.field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[=:]\\s*).*$', 'm')
        if (re.test(text)) { writeFileSync(file, text.replace(re, '$1'), 'utf8'); n += 1 }
      }
    } catch { /* 抹不掉就跳过，绝不因此中断导出 */ }
  }
  return n
}

/**
 * 打包一个插件目录，顺带把密钥需求记下来、把值抹掉。
 * @returns {{files:number, secrets:object[], manual:string[]}}
 */
function copyPluginSnapshot(srcDir, destDir, pluginName) {
  const { cfgHits, codeHits } = scanPluginFileSecrets(srcDir)
  const files = copyDir(srcDir, destDir)
  const redacted = redactSnapshot(destDir, cfgHits)
  for (const c of codeHits) {
    const file = join(destDir, c.rel)
    try {
      const text = readFileSync(file, 'utf8')
      writeFileSync(file, text.replace(new RegExp(SECRET_LITERAL_RE.source, 'g'), 'REDACTED_BY_MIGRATOR'), 'utf8')
    } catch { /* 忽略 */ }
  }
  const secrets = cfgHits.map((h, i) => ({
    id: 'pf:' + pluginName + ':' + h.rel + ':' + h.keyPath.join('.') + ':' + i,
    scope: 'plugin-file',
    plugin: pluginName,
    file: h.rel,
    kind: h.kind,
    keyPath: h.keyPath,
    field: h.field,
    label: '「' + shortName(pluginName) + '」的 ' + h.rel + ' → ' + h.keyPath.join('.'),
    required: true,
  }))
  const manual = codeHits.map((c) => pluginName + ' 的 ' + c.rel + '（硬编码 ' + c.sample + '，已抹成 REDACTED_BY_MIGRATOR，目标机需自行配置）')
  return { files, secrets, manual, redacted }
}

/**
 * 体检用导出（tools/secret-scan.mjs 用）：给定插件目录，看哪些文件带密钥、
 * 导出时会被抹成什么、目标机需要填哪些字段。
 */
export const secretTools = { scanSettingsSecrets, scanPluginFileSecrets, copyPluginSnapshot, redactSnapshot, jsonSecretHits }

/**
 * 导出迁移包。
 */
export function exportMigration({ profile = 'web', names = [], outDir }) {
  const scan = scanProfile(profile)
  const picked = names.length ? scan.plugins.filter((p) => names.includes(p.name)) : scan.plugins.filter((p) => !p.official)
  if (!picked.length) return { ok: false, result: '没有选中任何插件（或该 profile 无可迁移插件）' }
  const root = resolve(outDir || join(dshHome(), 'plugin-migrations'), 'plugin-migration-' + stamp())
  mkdirSync(join(root, 'packages'), { recursive: true })

  const manifest = {
    tool: name,
    version: '0.1.0',
    createdAt: new Date().toISOString(),
    source: { dshHome: dshHome(), profile, profileDir: scan.profileDir, sourceRoot: scan.sourceRoot ?? null, host: process.env.COMPUTERNAME ?? null, platform: process.platform },
    plugins: [],
    secrets: [],
    manualSecrets: [],
    notes: [
      '本地插件（kind=local）已附源码快照；远程插件（kind=remote）只记版本声明，目标机需 npm install。',
      'API 密钥不在包里：secrets[] 只记「哪个插件的哪个字段需要填」，目标机导入时弹窗输入（ask-secrets.ps1）。',
      '恢复：拷整个包到目标机 → 双击「恢复.bat」（会自动判定插件源码该落在哪，不用手填路径）。',
      '排除项：node_modules / .git / dsh-browser-profile（浏览器配置，含 cookie）/ .engine（python 运行时）/ *.log。',
    ],
  }

  const lines = []
  const allSecrets = []
  const manualSecrets = []
  for (const p of picked) {
    const hasSource = p.kind === 'local' && p.dir && existsSync(join(p.dir, 'package.json'))
    const item = {
      name: p.name, version: p.version,
      // 本地插件统一写回「正常路径」声明：原声明可能是坏的（编码转错）或 link: 专用写法
      spec: p.kind === 'local' && hasSource ? 'file:' + p.dir.split(sep).join('/') : p.spec,
      originalSpec: p.spec,
      specBroken: p.specBroken,
      kind: p.kind, source: p.source, dirSource: p.dirSource,
      originalDir: p.dir, installedDir: p.installedDir,
      inBundles: p.inBundles, disabled: p.disabled, hasClient: p.hasClient, fileCount: p.fileCount,
      patch: p.patch.map((x) => ({ id: x.id, name: x.name, disabled: x.disabled })),
    }
    // settings.yaml 里的插件段密钥（无论有没有源码都要记：目标机同样要填）
    // 注意：先攒着，等这个插件自己的那行摘要打印完再输出，否则看起来像挂在上一个插件名下
    const secSecrets = scanSettingsSecrets(p.name)
    let secNote = null
    if (secSecrets.length) {
      for (const s of secSecrets) {
        allSecrets.push({
          id: 'st:' + s.section + ':' + s.field,
          scope: 'settings', section: s.section, field: s.field,
          plugin: p.name, label: s.label, required: true,
        })
      }
      item.secrets = secSecrets.map((s) => s.label)
      secNote = `  ↳ settings.yaml 里检测到 ${secSecrets.length} 个密钥字段：${secSecrets.map((s) => s.field).join('、')}（值未写入迁移包，目标机弹窗填）`
    }
    if (hasSource) {
      const rel = 'packages/' + p.name.replace(/[@/\\]/g, '_')
      // 打包时顺带扫密钥：快照里带密钥的配置会被抹成空，需求记进 manifest.secrets
      const snap = copyPluginSnapshot(p.dir, join(root, rel), p.name)
      const n = snap.files
      for (const s of snap.secrets) allSecrets.push(s)
      for (const m of snap.manual) manualSecrets.push(m)
      item.packageDir = rel
      item.fileCount = n
      if (snap.secrets.length) {
        item.secrets = snap.secrets.map((s) => s.label)
        lines.push(`  ↳ 快照里发现 ${snap.secrets.length} 个需要 API 密钥的字段，已抹掉值并记入清单（目标机导入时弹窗填写）`)
      }
      if (snap.manual.length) lines.push(`  ! 代码里有硬编码密钥，已抹掉：${snap.manual.length} 处（目标机需自行配置，见 说明.txt）`)
      // 快照里补上 DSH ≥ 0.1.2-rc.1 要求的 dsh.bundle（只改快照副本，不动用户源码）
      if (!p.bundlePatchOk) {
        const fx = fixBundleField(join(root, rel), p.name)
        if (fx.ok && fx.changed) {
          item.bundleFieldAdded = true
          lines.push(`  ↳ 快照已自动补 dsh.bundle（原插件缺该字段，新版 DSH 会拒绝启动）`)
        } else if (!fx.ok) {
          lines.push(`  ! 快照补 dsh.bundle 失败：${fx.notes.join('；')}`)
        }
      }
      lines.push(`· ${p.name}@${p.version ?? '?'} → 源码 ${n} 个文件（来自 ${p.dirSource}${p.dirSource === 'guessed' ? '：原声明路径已损坏，已按源码根修正' : ''}）`)
    } else if (p.kind === 'local') {
      lines.push(`! ${p.name}@${p.version ?? '?'} → 找不到源码目录（${p.dir}），只写依赖声明`)
    } else {
      lines.push(`· ${p.name}@${p.version ?? '?'} → 仅版本声明（${p.spec}）`)
    }
    if (secNote) lines.push(secNote)
    manifest.plugins.push(item)
  }

  manifest.secrets = allSecrets
  manifest.manualSecrets = manualSecrets
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  if (existsSync(RESTORE_SRC)) copyFileSync(RESTORE_SRC, join(root, 'restore.mjs'))
  else { lines.push('! 警告：未找到 assets/restore.mjs，迁移包缺少恢复脚本') }
  const batSrc = join(dirname(RESTORE_SRC), 'restore.bat')
  if (existsSync(batSrc)) copyFileSync(batSrc, join(root, '恢复.bat'))
  const askSrc = join(dirname(RESTORE_SRC), 'ask-secrets.ps1')
  if (existsSync(askSrc)) copyFileSync(askSrc, join(root, 'ask-secrets.ps1'))
  else if (allSecrets.length) lines.push('! 警告：未找到 assets/ask-secrets.ps1，目标机弹窗输入 API 会不可用（改用 --secrets 文件）')
  // 一键 bat：恢复 → 装远程插件 → 再恢复补 bundles。内容必须保持纯 ASCII + CRLF，
  // 否则 cmd 在 chcp 切换后会解析错位（实测过：中文注释会让 rem 行被当命令执行）。
  const oneClickSrc = join(dirname(RESTORE_SRC), '新机一键装.bat')
  if (existsSync(oneClickSrc)) copyFileSync(oneClickSrc, join(root, '新机一键装.bat'))
  else lines.push('! 警告：未找到 assets/新机一键装.bat，迁移包缺少一键安装脚本')
  writeFileSync(join(root, '说明.txt'), [
    'DSH 插件迁移包（自带恢复脚本，目标机器不需要装任何插件）',
    '导出时间：' + manifest.createdAt,
    '来源 profile：' + profile,
    '插件数量：' + manifest.plugins.length,
    '来源机器：' + (manifest.source.host || '?') + '（这台机器的路径只作为参考，目标机自动适配）',
    '需要 API 密钥：' + (allSecrets.length ? allSecrets.length + ' 个（导入时弹窗输入）' : '无'),
    '',
    '在目标机器上恢复：',
    '  0) 目标机要求：装好 Node 22+ 与 DSH，且该 profile 至少启动过一次',
    '  1) 把整个文件夹拷到目标机器（或解压 zip）',
    '  2) 推荐：Windows 双击「新机一键装.bat」（全自动：填密钥 → 恢复 → 装远程插件 → 再恢复补 bundles）',
    '     或：双击「恢复.bat」按提示走（会先自动判定插件源码落在哪，回车即用推荐值）',
    '     命令行等价：',
    '       node restore.mjs --list                （只列清单）',
    '       node restore.mjs --list-roots          （只看路径自动判定结果）',
    '       node restore.mjs --secrets-list        （只看要填哪些 API 密钥）',
    '       node restore.mjs --dry-run             （预览，不写文件）',
    '       node restore.mjs                       （真正恢复：路径自动判定 + 用弹窗结果填密钥）',
    '       node restore.mjs --root "D:\\我的插件"  （想自己指定落盘位置时才用）',
    '  3) 重启 DSH（桌面版：关窗口，再双击图标）',
    '  4) 打开 设置 →「插件迁移」核对（若目标机也装了本插件）',
    '',
    '路径自动判定：不照抄来源机器的绝对路径。会依次看「包所在的上级目录 / 本机已存在的插件源码根 /',
    '  目标 profile 里已有 file: 依赖指向的目录 / 用户目录与各盘符下的候选」，能写才选，',
    '  最后兜底 <用户目录>\\.dsh\\migrated-plugins。判定结果会打印出来，并列出备选。',
    'API 密钥：包里不含任何密钥值。settings.yaml 段落 / 插件配置文件里的密钥字段会被记进 manifest.secrets，',
    '  导入时由 ask-secrets.ps1 弹窗逐个询问，写入前都有 .bak-secrets-<时间戳> 备份；留空=跳过。',
    '',
    '注意：远程插件（github/npm 版本号）只恢复了声明，需要在 profile 目录跑一次 npm/pnpm install。',
    '每个插件：' + manifest.plugins.map((p) => p.name).join(', '),
    ...(manualSecrets.length ? ['', '硬编码密钥（已抹掉，目标机需自行配置）：', ...manualSecrets.map((m) => '  · ' + m)] : []),
  ].join('\n') + '\n', 'utf8')

  let zip = null
  try {
    const target = root + '.zip'
    const z = zipDirectory(root, target)
    if (existsSync(target)) { zip = target; lines.push('压缩包：' + target + '（' + z.entries + ' 个文件，' + Math.round(z.bytes / 1024) + ' KB）') }
  } catch (e) { lines.push('! zip 打包跳过：' + String(e).slice(0, 160)) }

  // 记住这次导到哪 + 包目录，供「路径菜单」下次直接跳过去
  const prev = Array.isArray(readState().recentExports) ? readState().recentExports : []
  writeState({
    lastExportRoot: root,
    lastExportDir: dirname(root),
    recentExports: [root, ...prev.filter((p) => p !== root)].slice(0, 6),
  })

  return {
    ok: true,
    root,
    zip,
    count: picked.length,
    result: ['已导出 ' + picked.length + ' 个插件 → ' + root, ...lines].join('\n'),
  }
}

/**
 * 从迁移包恢复。zip 走自带的纯 JS 解压；恢复逻辑直接 import 迁移包自带的 restore.mjs
 * 在进程内执行（本机插件进程里 spawn 会被拒 EPERM，且同一份逻辑与在别机器上跑完全一致）。
 * `dshHome` 可覆盖目标 DSH 主目录 —— 测试/异地恢复用；不传则写本机 profile。
 */
export async function importMigration({ pkgPath, profile = 'web', root, dryRun = false, force = false, only, dshHome: targetHome, secretValues, secretsFile }) {
  let dir = pkgPath ? resolve(pkgPath) : ''
  if (!dir || !existsSync(dir)) return { ok: false, result: '迁移包路径不存在：' + (pkgPath ?? '(空)') }
  let unzipRoot = null
  if (statSync(dir).isFile()) {
    if (!dir.toLowerCase().endsWith('.zip')) return { ok: false, result: '不是文件夹也不是 .zip：' + dir }
    // 就地解压（zip 所在目录旁），避免写系统目录时遇到权限问题
    unzipRoot = join(dirname(dir), '_unzip-' + stamp())
    try {
      unzipTo(dir, unzipRoot)
      dir = unzipRoot
      const inner = readdirSync(unzipRoot).filter((n) => !n.startsWith('_'))
      if (inner.length === 1 && !existsSync(join(unzipRoot, 'manifest.json')) && statSync(join(unzipRoot, inner[0])).isDirectory()) dir = join(unzipRoot, inner[0])
    } catch (e) {
      return { ok: false, result: 'zip 解压失败：' + String(e).slice(0, 200) }
    }
  }
  const manifest = join(dir, 'manifest.json')
  if (!existsSync(manifest)) return { ok: false, result: '这个目录里没有 manifest.json，不是迁移包：' + dir }

  const script = join(dir, 'restore.mjs')
  if (!existsSync(script)) return { ok: false, result: '迁移包缺 restore.mjs（可用本插件的「导出」重新生成）：' + dir }

  try {
    const mod = await import(pathToFileURL(script).href + '?v=' + Date.now())
    if (typeof mod.restore !== 'function') return { ok: false, result: '迁移包的 restore.mjs 不支持进程内调用（缺 restore 导出），请手动运行：node "' + script + '" --profile ' + profile }

    // 前置：旧迁移包自带的是旧版 restore 引擎（没有 dsh.bundle 护栏），
    // 直接把缺字段的本地插件写进 bundles 会让新版 DSH 启动失败。
    // 这里在跑包内脚本之前，先把包内快照缺的字段补齐（只动包内副本，写前备份 package.json）。
    const pre = []
    const man = readJson(join(dir, 'manifest.json'))
    for (const item of man?.plugins ?? []) {
      if (item.kind !== 'local' || !item.packageDir) continue
      const snap = join(dir, item.packageDir)
      if (!existsSync(join(snap, 'package.json'))) continue
      if (readJson(join(snap, 'package.json'))?.dsh?.bundle?.patch) continue
      const fx = fixBundleField(snap, item.name, { dryRun })
      if (fx.ok && fx.changed) pre.push(item.name + (dryRun ? '（预览）' : ''))
      else if (!fx.ok) pre.push(item.name + '（补齐失败：' + fx.notes.join('；') + '）')
    }

    const res = mod.restore({ manifestPath: manifest, profile, root, dryRun, force, only, dshHome: targetHome, secretValues, secretsFile })
    const text = [...(res.fatal ? ['ERROR: ' + res.fatal] : []), ...res.lines].join('\n')

    // 后置：用 DSH 自己的装配代码确认目标 profile 下次能起来（同一台机器上才检）
    let check = ''
    try {
      const target = targetHome || dshHome()
      if (target === dshHome()) {
        const bc = await bootCheck(profile)
        check = '\n\n—— 启动体检 ——\n' + bc.result
      }
    } catch { /* 体检失败不影响导入结果 */ }

    if (unzipRoot && res.ok) { try { rmSync(unzipRoot, { recursive: true, force: true }) } catch { /* 临时目录清理失败可忽略 */ } }
    return {
      ok: Boolean(res.ok),
      result: (pre.length ? '（前置修正：' + pre.length + ' 个本地插件快照补了 dsh.bundle —— ' + pre.join('、') + '）\n' : '') + text + check,
      packageDir: dir,
      dryRun,
      // 面板据此弹「输入 API 密钥」对话框：包里不含密钥值，需要现场填
      secrets: Array.isArray(res.secrets) ? res.secrets : [],
      rootUsed: res.detectedRoot ?? null,
      rootCandidates: res.rootCandidates ?? [],
    }
  } catch (e) {
    return { ok: false, result: '恢复失败：' + String(e?.stack ?? e).slice(0, 600) }
  }
}

/** 本机 profile 间搬运：把选中插件从 source profile 搬到 target profile。 */
export function copyToProfile({ profile = 'web', targetProfile, names = [], dryRun = false }) {
  if (!targetProfile) return { ok: false, result: '缺少目标 profile' }
  if (targetProfile === profile) return { ok: false, result: '源和目标都是 ' + profile + '，无需搬运' }
  const scan = scanProfile(profile)
  const targetDir = join(profilesDir(), targetProfile)
  if (!existsSync(targetDir)) return { ok: false, result: '目标 profile 不存在：' + targetDir + '（现有：' + listProfiles().join(' / ') + '）' }
  const picked = scan.plugins.filter((p) => names.includes(p.name))
  if (!picked.length) return { ok: false, result: '没有选中任何插件' }

  const pkgPath = join(targetDir, 'package.json')
  const pkgExists = existsSync(pkgPath)
  const pkg = pkgExists ? readJson(pkgPath) : { name: 'dsh-profile-' + targetProfile, private: true, dependencies: {} }
  if (pkgExists && !pkg) return { ok: false, result: '目标 profile 的 package.json 无法解析，已中止（不覆盖）：' + pkgPath + '\n请先修好该文件再搬运。' }
  pkg.dependencies ||= {}
  pkg.dsh ||= {}
  pkg.dsh.profile ||= {}
  pkg.dsh.profile.bundles ||= []

  const patchPath = join(targetDir, 'cordis.patch.yml')
  const oldPatch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const haveIds = new Set([...oldPatch.matchAll(/^\s*-?\s*id:\s*([^\s#]+)/gm)].map((m) => m[1]))
  let patchText = oldPatch

  const lines = []
  let newPatch = false
  const notBundled = []
  // 源目录守护（2026-10-08 事故防线）：记录每个本地插件源的完好状态，操作结束后必须仍然完好。
  const sourceGuard = picked
    .filter((p) => p.kind === 'local' && p.dir)
    .map((p) => ({ name: p.name, dir: p.dir, exe: existsSync(join(p.dir, 'package.json')) }))
  const preLost = sourceGuard.filter((s) => !s.exe).map((s) => s.name)
  for (const p of picked) {
    // 本地插件写「正常路径」声明（原声明可能损坏），远程插件原样保留
    const usableSource = p.kind === 'local' && p.dir && existsSync(join(p.dir, 'package.json'))
    const spec = usableSource ? 'file:' + p.dir.split(sep).join('/') : p.spec
    if (pkg.dependencies[p.name] !== spec) lines.push(`· ${p.name}：依赖声明 ${pkg.dependencies[p.name] ?? '(新增)'} → ${spec}`)
    pkg.dependencies[p.name] = spec
    // 包不到位就别进 bundles：不在 bundles 只是不生效，进了 bundles 但包不存在会让 loader 启动失败
    const installedOnTarget = existsSync(join(targetDir, 'node_modules', p.name))
    // 同理：DSH ≥ 0.1.2-rc.1 还要求包声明 dsh.bundle.patch，缺了进 bundles 会直接让启动抛错
    const ready = p.kind === 'local'
      ? Boolean(p.dir && existsSync(join(p.dir, 'package.json')) && p.bundlePatchOk)
      : (installedOnTarget && p.bundlePatchOk)
    if (!pkg.dsh.profile.bundles.includes(p.name)) {
      if (ready) pkg.dsh.profile.bundles.push(p.name)
      else notBundled.push(p.name)
    }
    const linkPath = join(targetDir, 'node_modules', p.name)
    let linkNote = '远程包：待目标 profile npm install'
    if (p.kind === 'local' && p.dir) {
      const real = existsSync(linkPath) && !lstatSync(linkPath).isSymbolicLink()
      if (real) linkNote = 'node_modules 已有实体目录，未改动'
      else if (dryRun) linkNote = '将建 junction → ' + p.dir
      else {
        try {
          // 只摘除链接本身。切勿 rmSync(linkPath, { recursive: true })：在 Windows 上它会跟随
          // junction/reparse point 递归删除「链接目标」，也就是用户自己的插件源码目录
          // （2026-10-08 事故：11 个本地插件源码被一次搬运整批掏空，只剩空目录）。
          if (existsSync(linkPath)) {
            if (lstatSync(linkPath).isSymbolicLink()) {
              // Windows junction 用 rmdir 摘除；POSIX 符号链接用不带 recursive 的 unlink 语义。
              if (process.platform === 'win32') rmdirSync(linkPath)
              else rmSync(linkPath, { force: true })
            } else throw new Error('目标位置已存在非链接实体，拒绝自动删除')
          }
          mkdirSync(dirname(linkPath), { recursive: true })
          symlinkSync(p.dir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
          linkNote = '已建 junction → ' + p.dir
        } catch (e) { linkNote = '建链接失败：' + String(e).slice(0, 100) }
      }
    }
    for (const patch of p.patch) {
      if (haveIds.has(patch.id)) { lines.push(`· ${p.name}：patch ${patch.id} 已存在，跳过`); continue }
      patchText += '\n- id: ' + patch.id + '\n' + (patch.name ? '  name: ' + JSON.stringify(patch.name) + '\n' : '') + '  disabled: ' + (patch.disabled ? 'true' : 'false') + '\n'
      haveIds.add(patch.id)
      newPatch = true
      lines.push(`· ${p.name}：patch ${patch.id} 已搬运`)
    }
    lines.push(`· ${p.name} [${spec}] → ${linkNote}`)
  }

  // 源目录守护：只要出现「操作前完好、操作后丢失」的本地插件源，立即中止且不写任何配置。
  const nowLost = sourceGuard.filter((s) => s.exe && !existsSync(join(s.dir, 'package.json')))
  if (nowLost.length && !dryRun) {
    return {
      ok: false,
      result: [
        '❌ 已中止，未写入任何配置：搬运过程中有本地插件源码目录被破坏（缺 package.json），请立即从快照恢复：',
        ...nowLost.map((s) => '  · ' + s.name + ' → ' + s.dir),
        '常见成因：删除 node_modules 里的 junction 时跟随链接删到了源码目录；本插件现已改为只摘链接、不再递归删除。',
      ],
    }
  }
  if (preLost.length) lines.push('⚠️ 以下本地插件源在本次操作前就已不完整（缺 package.json），已按降级方式处理：' + preLost.join(', '))

  if (!dryRun) {
    if (existsSync(pkgPath)) writeFileSync(pkgPath + '.bak-' + stamp(), readFileSync(pkgPath, 'utf8'))
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
    if (newPatch) {
      if (existsSync(patchPath)) writeFileSync(patchPath + '.bak-' + stamp(), oldPatch)
      writeFileSync(patchPath, patchText, 'utf8')
    }
  }

  return {
    ok: true,
    result: [
      `已从 ${profile} 搬运 ${picked.length} 个插件到 ${targetProfile}${dryRun ? '（DRY-RUN，未写入）' : ''}`,
      '配置：' + pkgPath + (dryRun ? '' : '（已备份原文件）'),
      ...lines,
      notBundled.length ? `注意：${notBundled.length} 个插件只写了依赖、暂未进 bundles（包还没装到 ${targetProfile}）：${notBundled.join(', ')}——在该 profile 目录 npm/pnpm install 后重启，再把包名加进 dsh.profile.bundles` : '',
      dryRun ? '' : '重启 DSH 后，在设置 →「插件迁移」里把 profile 切到 ' + targetProfile + ' 核对。',
    ].filter(Boolean).join('\n'),
  }
}

/** ── 启动体检 / 补 dsh.bundle（DSH ≥ 0.1.2-rc.1 的硬性要求）───────────── */

/** 从 dsh-app-boot 的入口路径反推 dsh 安装锚点（= dsh 包自己的 package.json）。 */
function dshAnchorFromEntry(entry) {
  let dir = dirname(entry)
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'package.json')
    try {
      const j = readJson(candidate)
      if (j?.name === '@deepseek-ai/dsh') return candidate
    } catch { /* 继续往上 */ }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 找 dsh-app-boot 的入口文件（用于调真实的 loadProfile）。 */
function resolveAppBootEntry(profile) {
  for (const base of [process.argv[1], join(dshHome(), 'profiles', profile, 'package.json'), import.meta.url]) {
    if (!base) continue
    try {
      const req = createRequire(base.startsWith('file:') ? base : join(base))
      return { entry: req.resolve('@deepseek-ai/dsh-app-boot'), anchor: dshAnchorFromEntry(req.resolve('@deepseek-ai/dsh-app-boot')) }
    } catch { /* 换下一个锚点 */ }
  }
  return null
}

/**
 * 启动体检：直接调用 DSH 自己的 loadProfile，等同于「启动时会不会抛装配错误」。
 * 这是离线可做的最强验证——不用重启就能知道下一次启动能不能起来。
 */
async function bootCheck(profile = 'web') {
  const found = resolveAppBootEntry(profile)
  if (!found) return { ok: false, result: '找不到 @deepseek-ai/dsh-app-boot，无法离线体检（可改用 tools/check-profile-boot.mjs）' }
  let mod = null
  try { mod = await import(pathToFileURL(found.entry).href) } catch (e) {
    return { ok: false, result: '加载 dsh-app-boot 失败：' + String(e).slice(0, 200) }
  }
  if (typeof mod.loadProfile !== 'function') return { ok: false, result: 'dsh-app-boot 未导出 loadProfile（版本过旧？）' }
  try {
    const loaded = mod.loadProfile('dsh', profile, found.anchor, dshHome())
    const lines = [`✔ 启动体检通过（与启动同源）：${loaded.layers.length} 个 bundle 层 + 用户层 ${loaded.patches.length} 条`]
    for (const l of loaded.layers) lines.push(`   · ${l.packageName} → ${l.patches.length} 条 patch`)
    return { ok: true, result: lines.join('\n'), layers: loaded.layers.length, patches: loaded.patches.length }
  } catch (e) {
    return { ok: false, result: '✗ 启动会失败（这是 DSH 启动时会抛的同一条错）：\n' + String(e?.message ?? e) }
  }
}

/**
 * 给插件补 dsh.bundle.patch + overlay 文件（写前备份 package.json）。
 * 所有写入都落在插件自己的目录里（用户显式点的动作）。dryRun 只预览。
 */
function fixBundleField(dir, packageName, { dryRun = false } = {}) {
  const notes = []
  const pkgPath = join(dir, 'package.json')
  const pkg = readJson(pkgPath)
  if (!pkg) return { ok: false, notes: ['package.json 读不了/不是 JSON：' + pkgPath] }
  if (pkg.dsh?.bundle?.patch) {
    const p = join(dir, pkg.dsh.bundle.patch)
    return { ok: true, notes: existsSync(p) ? ['已声明 dsh.bundle.patch 且文件存在，无需处理'] : [`已声明 dsh.bundle.patch=${pkg.dsh.bundle.patch}，但文件不存在（${p}）→ 需要补文件`] }
  }
  const rel = './cordis.patch.yml'
  const patchFile = join(dir, rel)
  const short = (packageName.split('/').pop() || packageName).replace(/[^A-Za-z0-9._-]/g, '-')
  const overlay = [
    '# 由 @dsh-external/dsh-plugin-migrator 补齐：DSH ≥ 0.1.2-rc.1 要求每个 profile bundle',
    '# 在 package.json 声明 dsh.bundle.patch，并由该 patch 的 insert 行把自己挂载起来。',
    '- insert:',
    '    - id: ' + short,
    "      name: '" + packageName + "'",
    '',
  ].join('\n')

  if (dryRun) {
    notes.push('将写入 ' + patchFile)
    notes.push('将给 ' + pkgPath + ' 增加 dsh.bundle.patch = ' + rel + '（先备份）')
    return { ok: true, notes, changed: true }
  }
  try {
    if (!existsSync(patchFile)) writeFileSync(patchFile, overlay, 'utf8')
    else notes.push('overlay 文件已存在，保留原样：' + patchFile)
    const bak = pkgPath + '.bak-bundlefield-' + stamp()
    writeFileSync(bak, readFileSync(pkgPath, 'utf8'))
    const next = { ...pkg, dsh: { ...(pkg.dsh ?? {}), bundle: { ...(pkg.dsh?.bundle ?? {}), patch: rel } } }
    writeFileSync(pkgPath, JSON.stringify(next, null, 2) + '\n', 'utf8')
    notes.push('已补 dsh.bundle.patch = ' + rel + '（package.json 备份：' + basename(bak) + '）')
    return { ok: true, notes, changed: true }
  } catch (e) {
    return { ok: false, notes: ['写入失败：' + String(e).slice(0, 200)] }
  }
}

/** ── 路径菜单：优先用宿主的 directoryPicker（browse → 列目录；native → 直接弹系统对话框），失败则自己读盘 ── */
function splitCrumbs(abs) {
  const parts = abs.split(/[\\/]/).filter(Boolean)
  const out = []
  let acc = ''
  for (let i = 0; i < parts.length; i += 1) {
    acc = i === 0 ? parts[0] + sep : acc + (acc.endsWith(sep) ? '' : sep) + parts[i]
    out.push({ name: acc, path: acc })
  }
  return out
}

function isHidden(name) { return name.startsWith('.') || name === 'node_modules' }

function fsBrowse(target, mode) {
  const start = target && target.trim() ? resolve(target.trim()) : homedir()
  const dirs = []
  const files = []
  let entries = []
  try { entries = readdirSync(start, { withFileTypes: true }) } catch (e) {
    return { ok: false, result: '目录读不了：' + start + '（' + String(e.code ?? e.message) + '）' }
  }
  for (const e of entries) {
    if (e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') continue
    const p = join(start, e.name)
    if (e.isDirectory()) dirs.push({ name: e.name, path: p, hidden: isHidden(e.name) })
    else if (mode === 'file' && /\.(zip)$/i.test(e.name)) files.push({ name: e.name, path: p, hidden: false })
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  files.sort((a, b) => a.name.localeCompare(b.name))
  const parent = dirname(start)
  return { ok: true, kind: 'local', path: start, home: homedir(), parent: parent === start ? null : parent, crumbs: splitCrumbs(start), entries: dirs, files, truncated: false }
}

function describeListing(listing, mode, kind) {
  const files = []
  const isPack = (p) => existsSync(join(p, 'manifest.json')) && existsSync(join(p, 'restore.mjs'))
  // 目录行标注「本身是不是迁移包」（可直接选），文件模式额外列出 .zip
  const entries = (listing.entries ?? []).map((e) => {
    let pack = false
    try { pack = isPack(e.path) } catch { /* 忽略不可读项 */ }
    return { ...e, isPack: pack }
  })
  if (mode === 'file') {
    try {
      for (const e of readdirSync(listing.path, { withFileTypes: true })) {
        if (e.isFile() && /\.zip$/i.test(e.name)) files.push({ name: e.name, path: join(listing.path, e.name), hidden: false })
      }
    } catch { /* 列文件失败不影响目录浏览 */ }
    files.sort((a, b) => a.name.localeCompare(b.name))
  }
  return {
    ok: true, kind,
    path: listing.path, home: listing.home,
    parent: listing.parent ?? null,
    pack: isPack(listing.path),
    crumbs: listing.crumbs ?? [], entries, files,
    truncated: Boolean(listing.truncated),
  }
}

/**
 * 列一级目录。优先宿主的 directoryPicker：
 *   browse 后端 → cap.list()（官方对话框同一套原语）
 *   native 后端 → cap.pick()（直接弹系统对话框，返回即最终路径）
 * 目标不存在/读不了时逐级回退到最近的已存在上级（用户输入的未来路径很常见），
 * 最后兜底是自己读盘，尽量别把面板搞成死路。
 */
async function browseFor(ctx, target, mode = 'dir') {
  let cap = null
  try { cap = ctx.get ? ctx.get('directoryPicker')?.capability?.() : null } catch { cap = null }
  const start = target && target.trim() ? resolve(target.trim()) : null

  if (cap?.kind === 'native' && typeof cap.pick === 'function') {
    const picked = await cap.pick(AbortSignal.timeout(300000))
    return { ok: true, kind: 'native', picked: picked ?? null, path: picked ?? '', home: homedir(), parent: null, crumbs: picked ? splitCrumbs(picked) : [], entries: [], files: [], truncated: false }
  }

  const tryOnce = async (p) => {
    if (cap?.kind === 'browse' && typeof cap.list === 'function') {
      const listing = await cap.list(p ?? undefined, AbortSignal.timeout(10000))
      const r = describeListing({ ...listing, parent: listing.crumbs?.length > 1 ? listing.crumbs[listing.crumbs.length - 2].path : null }, mode, 'browse')
      return r
    }
    return fsBrowse(p ?? undefined, mode)
  }

  let probe = start
  let lastErr = null
  for (let i = 0; i < 10; i += 1) {
    try {
      const r = await tryOnce(probe)
      if (r.ok && start && probe && resolve(probe) !== resolve(start)) r.note = '原路径当前不存在或读不了，已定位到最近的上级目录：' + r.path
      return r
    } catch (e) {
      lastErr = e
      const parent = probe ? dirname(probe) : null
      if (!parent || parent === probe) break
      probe = parent
    }
  }
  const fb = fsBrowse(start ?? undefined, mode)
  if (fb.ok) { if (start) fb.note = '宿主的 directoryPicker 不可用，已改用内置列目录'; return fb }
  return { ok: false, result: '读不了该路径：' + String(lastErr?.message ?? lastErr ?? '').slice(0, 200) }
}

/** ── 宿主 HTTP API ─────────────────────────────────────── */
/**
 * ④ 全量整合包的依赖注入：复用 ① 的扫描 / 导出 / 密钥抹除，避免两份实现漂移。
 */
function allInOneDeps() {
  return { scanProfile, exportMigration, copyPluginSnapshot, dshHome, readJson }
}

function registerApi(ctx, config) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/plugin-migrator/api',
    handler: async (req, res) => {
      const send = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/^\/plugin-migrator\/api/, '') || '/'
      let body = {}
      if (req.method === 'POST') {
        const chunks = []
        for await (const c of req) chunks.push(c)
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} } catch { body = {} }
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const q = (k, d) => url.searchParams.get(k) ?? d
      try {
        if (req.method === 'GET' && (path === '/list' || path === '/')) {
          const profile = String(body.profile || q('profile', config.profile) || 'web')
          const scan = scanProfile(profile)
          return send(200, {
            ok: true,
            profiles: listProfiles(),
            profile,
            exportRoot: config.exportRoot || join(dshHome(), 'plugin-migrations'),
            packagesRoot: config.packagesRoot || '',
            sourceRoot: scan.sourceRoot ?? null,
            home: homedir(),
            lastExportRoot: (() => { const s = readState(); return s.lastExportRoot && existsSync(s.lastExportRoot) ? s.lastExportRoot : null })(),
            lastExportDir: (() => { const s = readState(); return s.lastExportDir && existsSync(s.lastExportDir) ? s.lastExportDir : null })(),
            recentExports: (Array.isArray(readState().recentExports) ? readState().recentExports : []).filter((p) => typeof p === 'string' && existsSync(p)).slice(0, 6),
            profileDir: scan.profileDir,
            dshHome: dshHome(),
            plugins: scan.plugins,
            warnings: scan.warnings,
            runtime: { defineToolFrom: runtime.defineToolFrom, tools: runtime.tools, error: runtime.error },
          })
        }
        if (req.method === 'GET' && path === '/browse') {
          return send(200, await browseFor(ctx, q('path', ''), q('mode', 'dir')))
        }
        if (req.method === 'POST' && path === '/browse') {
          return send(200, await browseFor(ctx, body.path ?? '', body.mode ?? 'dir'))
        }
        if (req.method === 'POST' && path === '/mkdir') {
          const parent = String(body.parent ?? '')
          const name = String(body.name ?? '').trim()
          if (!parent || !name || /[\\/]/.test(name) || name === '.' || name === '..') return send(200, { ok: false, result: '目录名不合法（不能含路径分隔符）' })
          const target = join(parent, name)
          try { mkdirSync(target, { recursive: false }); return send(200, { ok: true, path: target, result: '已新建：' + target }) }
          catch (e) { return send(200, { ok: false, result: '新建失败：' + String(e.code ?? e.message) }) }
        }
        if (req.method === 'GET' && path === '/bootcheck') {
          return send(200, await bootCheck(q('profile', config.profile || 'web')))
        }
        if (req.method === 'POST' && path === '/fixbundle') {
          const profile = body.profile || config.profile || 'web'
          const names = Array.isArray(body.names) ? body.names : []
          const dryRun = Boolean(body.dryRun)
          const scan = scanProfile(profile)
          const picked = scan.plugins.filter((p) => names.includes(p.name))
          if (!picked.length) return send(200, { ok: false, result: '没有选中任何插件' })
          const lines = [`${dryRun ? '[预览] ' : ''}处理 ${picked.length} 个插件：`]
          let changed = 0
          for (const p of picked) {
            if (p.kind !== 'local' || !p.dir || !existsSync(join(p.dir, 'package.json'))) {
              lines.push(`· ${p.name}：非本地插件（装到 node_modules 的 npm 包），跳过 —— 这类包应等上游补 dsh.bundle，或用 npm 覆盖）`)
              continue
            }
            if (p.bundlePatchOk) { lines.push(`· ${p.name}：已有 dsh.bundle.patch=${p.bundlePatch}，跳过`); continue }
            const r = fixBundleField(p.dir, p.name, { dryRun })
            lines.push(`· ${p.name}：${r.ok ? '' : '失败 '}${r.notes.join('；')}`)
            if (r.changed) changed += 1
          }
          lines.push('')
          lines.push(dryRun
            ? `预览完成：${changed} 个插件将补 dsh.bundle（未写入任何文件）`
            : `完成：${changed} 个插件已补 dsh.bundle。改完后建议点「启动体检」确认；下次重启 DSH 生效。`)
          return send(200, { ok: true, result: lines.join('\n'), changed, dryRun })
        }
        if (req.method === 'POST' && path === '/export') {
          return send(200, { ...exportMigration({ profile: body.profile || config.profile || 'web', names: body.names ?? [], outDir: body.outDir || config.exportRoot || undefined }) })
        }
        /* ── ④ 全量整合包：生成（后台）/ 查进度 / 导出 / 读提示词 / 打开目录 ── */
        if (req.method === 'POST' && path === '/allinone/start') {
          const job = startAllInOne(allInOneDeps(), {
            profile: body.profile || config.profile || 'web',
            outDir: body.outDir || config.exportRoot || undefined,
            includeSource: body.includeSource !== false,
            includeKnowledge: body.includeKnowledge !== false,
          })
          return send(200, { ok: true, job })
        }
        if (req.method === 'GET' && path === '/allinone/status') {
          const job = getJob(q('job', ''))
          return send(200, job ? { ok: true, job } : { ok: false, result: '找不到该任务', jobs: listJobs(6) })
        }
        if (req.method === 'GET' && path === '/allinone/jobs') {
          return send(200, { ok: true, jobs: listJobs(8) })
        }
        if (req.method === 'POST' && path === '/allinone/export') {
          return send(200, exportAllInOne({ jobId: body.jobId, target: body.target }))
        }
        if (req.method === 'GET' && path === '/allinone/prompt') {
          const job = getJob(q('job', ''))
          const f = job?.prompt || (job?.root ? join(job.root, 'PROMPT.md') : null)
          if (!f || !existsSync(f)) return send(200, { ok: false, result: '还没有可读的 PROMPT.md（先生成一次整合包）' })
          return send(200, { ok: true, path: f, text: readFileSync(f, 'utf8') })
        }
        /* ── ⑤ 整机迁移：三档范围 / 预估 / 后台构建 / 导出 ── */
        if (req.method === 'GET' && path === '/full/estimate') {
          return send(200, estimateScope(q('scope', 'standard')))
        }
        if (req.method === 'POST' && path === '/full/start') {
          const job = startFullMigration({
            scope: body.scope || 'standard',
            outDir: body.outDir || config.exportRoot || undefined,
            maxVolumeMB: body.maxVolumeMB,
          })
          return send(200, { ok: true, job })
        }
        if (req.method === 'GET' && path === '/full/status') {
          const job = getFullJob(q('job', ''))
          return send(200, job ? { ok: true, job } : { ok: false, result: '找不到该任务' })
        }
        if (req.method === 'GET' && path === '/full/jobs') {
          return send(200, { ok: true, jobs: listFullJobs(8) })
        }
        if (req.method === 'GET' && path === '/full/prompt') {
          const job = getFullJob(q('job', ''))
          const f2 = job && job.root ? join(job.root, 'PROMPT.md') : null
          if (!f2 || !existsSync(f2)) return send(200, { ok: false, result: '还没有可读的 PROMPT.md（先生成一次整机迁移包）' })
          return send(200, { ok: true, path: f2, text: readFileSync(f2, 'utf8') })
        }
        if (req.method === 'POST' && path === '/full/export') {
          return send(200, exportFull({ jobId: body.jobId, target: body.target }))
        }
        if (req.method === 'POST' && path === '/allinone/open') {
          const dir = String(body.dir ?? '')
          if (!dir || !existsSync(dir)) return send(200, { ok: false, result: '目录不存在：' + dir })
          try {
            const { spawn } = await import('node:child_process')
            const child = spawn('explorer', [dir], { stdio: 'ignore', detached: true })
            child.unref()
            return send(200, { ok: true, result: '已在资源管理器中打开：' + dir })
          } catch (e) { return send(200, { ok: false, result: '打开失败：' + String(e?.message ?? e).slice(0, 200) }) }
        }
        if (req.method === 'POST' && path === '/import') {
          return send(200, {
            ...(await importMigration({
              pkgPath: body.pkgPath,
              profile: body.profile || config.profile || 'web',
              root: body.root || config.packagesRoot || undefined,
              dryRun: Boolean(body.dryRun),
              force: Boolean(body.force),
              // 面板弹窗填的 API 密钥（manifest.secrets 里哪些字段需要，值由用户现场给）
              secretValues: body.secrets && typeof body.secrets === 'object' ? body.secrets : undefined,
              secretsFile: typeof body.secretsFile === 'string' ? body.secretsFile : undefined,
            })),
          })
        }
        if (req.method === 'POST' && path === '/copy') {
          return send(200, { ...copyToProfile({ profile: body.profile || config.profile || 'web', targetProfile: body.targetProfile, names: body.names ?? [], dryRun: Boolean(body.dryRun) }) })
        }
        if (req.method === 'POST' && path === '/inspect') {
          const dir = resolve(body.pkgPath ?? '')
          const m = existsSync(join(dir, 'manifest.json')) ? readJson(join(dir, 'manifest.json')) : null
          if (!m) return send(200, { ok: false, result: '不是迁移包（缺 manifest.json）：' + dir })
          return send(200, { ok: true, manifest: m, result: m.plugins.map((p) => `${p.name}@${p.version ?? '?'} [${p.kind}]`).join('\n') })
        }
        return send(404, { ok: false, result: '未知接口 ' + req.method + ' ' + path })
      } catch (e) {
        return send(500, { ok: false, result: '内部错误：' + String(e?.stack ?? e).slice(0, 800) })
      }
    },
  }), 'plugin-migrator: api')
}

/** ── 宿主工具（agent 也能直接调）────────────────────────── */
function registerTools(ctx, config) {
  const defineTool = resolveDefineTool()
  if (!defineTool) {
    runtime.error = '找不到 @deepseek-ai/dsh-tools，已跳过 agent 工具（面板与 API 不受影响）'
    ctx.logger?.warn?.('[plugin-migrator] ' + runtime.error)
    return
  }

  const textOutput = (description) => ({
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
    description,
  })
  const register = (tool) => {
    ctx.effect(() => ctx.tools.register(defineTool(tool)), 'plugin-migrator: ' + tool.name)
    runtime.tools.push(tool.name)
  }
  runtime.tools = []

  const profileParam = { type: 'string', description: 'profile 名（默认 web）' }

  register({
    name: 'plugin_migrator_list',
    description: '列出某个 profile 已装插件（名称/版本/来源/目录/是否启用/是否含 UI），供迁移前挑选',
    parameters: { profile: profileParam },
    output: textOutput('插件清单 JSON'),
    async execute(args) {
      const scan = scanProfile(args?.profile || config.profile || 'web')
      return JSON.stringify({
        profile: scan.profile,
        profileDir: scan.profileDir,
        profiles: listProfiles(),
        plugins: scan.plugins.map((p) => ({ name: p.name, version: p.version, kind: p.kind, spec: p.spec, dir: p.dir, inBundles: p.inBundles, disabled: p.disabled, hasClient: p.hasClient })),
        warnings: scan.warnings,
      }, null, 2)
    },
  })

  register({
    name: 'plugin_migrator_export',
    description: '把选中插件导出为迁移包（含本地插件源码快照 + manifest.json + restore.mjs，可选 zip），供拷到别的机器',
    parameters: {
      names: { type: 'array', items: { type: 'string' }, required: true, description: '插件包名数组，如 ["dsh-update","dsh-ai-memory"]' },
      profile: profileParam,
      outDir: { type: 'string', description: '输出目录（默认 <DSH_HOME>/plugin-migrations）' },
    },
    output: textOutput('导出结果'),
    async execute(args) {
      return exportMigration({ profile: args?.profile || config.profile || 'web', names: args?.names ?? [], outDir: args?.outDir || config.exportRoot || undefined }).result
    },
  })

  register({
    name: 'plugin_migrator_import',
    description: '从迁移包（文件夹或 zip）恢复到本机 profile：拷贝源码 + 写依赖/bundles + 建 junction（写前自动备份）',
    parameters: {
      pkgPath: { type: 'string', required: true, description: '迁移包目录或 zip 路径' },
      profile: profileParam,
      root: { type: 'string', description: '本地插件源码落盘根目录（默认沿用迁移包里记录的路径）' },
      dryRun: { type: 'boolean', description: '只预览不写入' },
    },
    output: textOutput('导入结果'),
    async execute(args) {
      const r = await importMigration({ pkgPath: args?.pkgPath, profile: args?.profile || config.profile || 'web', root: args?.root || config.packagesRoot || undefined, dryRun: Boolean(args?.dryRun) })
      return r.result
    },
  })

  register({
    name: 'plugin_migrator_copy',
    description: '把选中插件从当前 profile 搬到本机另一个 profile（写依赖/bundles + junction + patch 条目）',
    parameters: {
      names: { type: 'array', items: { type: 'string' }, required: true, description: '插件包名数组' },
      targetProfile: { type: 'string', required: true, description: '目标 profile，如 headless' },
      profile: profileParam,
      dryRun: { type: 'boolean', description: '只预览不写入' },
    },
    output: textOutput('搬运结果'),
    async execute(args) {
      return copyToProfile({ profile: args?.profile || config.profile || 'web', targetProfile: args?.targetProfile, names: args?.names ?? [], dryRun: Boolean(args?.dryRun) }).result
    },
  })

  register({
    name: 'dsh_migration_estimate',
    description: '预估 DSH 整机迁移包体积：essential（配置+记忆+技能）/ standard（+会话+附件+插件源码）/ everything（+缓存备份整个工作区）',
    parameters: {
      scope: { type: 'string', description: 'essential | standard | everything（默认 standard）' },
    },
    output: textOutput('体积预估'),
    async execute(args) {
      const r = estimateScope(args?.scope || 'standard')
      return JSON.stringify(r, null, 2)
    },
  })

  register({
    name: 'dsh_migration_build',
    description: '生成 DSH 整机迁移包（换电脑用）：配置/记忆/会话/附件/技能/插件源码/API 密钥 → 可分卷、带 sha256 清单、含恢复脚本与提示词。耗时按体积计（standard 约 1 分钟）',
    timeoutMs: 1800000,
    parameters: {
      scope: { type: 'string', description: 'essential | standard | everything（默认 standard）' },
      outDir: { type: 'string', description: '输出目录（默认 <DSH_HOME>/dsh-migrations）' },
      maxVolumeMB: { type: 'number', description: '单卷上限 MB（默认 1800）' },
    },
    output: textOutput('整机迁移包构建结果'),
    async execute(args) {
      const r = await new Promise((resolveRun) => {
        const job = startFullMigration({
          scope: args?.scope || 'standard',
          outDir: args?.outDir || config.exportRoot || undefined,
          maxVolumeMB: args?.maxVolumeMB,
        })
        const timer = setInterval(() => {
          const j = getFullJob(job.id)
          if (j && j.status !== 'running') { clearInterval(timer); resolveRun(j) }
        }, 1500)
        if (typeof timer.unref === 'function') timer.unref()
      })
      return r.result || JSON.stringify({ status: r.status, error: r.error })
    },
  })

  register({
    name: 'dsh_migration_status',
    description: '查看 DSH 整机迁移包的构建任务（不给 jobId 就列最近任务）',
    parameters: { jobId: { type: 'string', description: '任务 id（fm-…）；留空列最近任务' } },
    output: textOutput('任务状态'),
    async execute(args) {
      if (args?.jobId) {
        const j = getFullJob(String(args.jobId))
        return j ? JSON.stringify(j, null, 2) : '找不到任务：' + args.jobId
      }
      const jobs = listFullJobs(6)
      if (!jobs.length) return '还没有整机迁移任务。用 dsh_migration_build 起一个。'
      return JSON.stringify(jobs.map((j) => ({ id: j.id, status: j.status, scope: j.scope, step: j.step, root: j.root, stats: j.stats })), null, 2)
    },
  })

  register({
    name: 'plugin_allinone_build',
    description: '生成「全量整合包」：把本机所有非官方插件打成一份自带说明书的包（每个插件的全部功能/装配要点/搭建技巧/版本变迁 + TRICKS.md + 可直接粘给新 DSH 的 PROMPT.md + 源码快照 + restore.mjs）。耗时约 10~60 秒',
    timeoutMs: 600000,
    parameters: {
      profile: profileParam,
      outDir: { type: 'string', description: '输出目录（默认 <DSH_HOME>/plugin-migrations）' },
      includeSource: { type: 'boolean', description: '是否带本地插件源码快照（默认 true）' },
      includeKnowledge: { type: 'boolean', description: '是否带知识层 AGENTS/playbook/技能/错误库摘录（默认 true）' },
    },
    output: textOutput('整合包构建结果'),
    async execute(args) {
      const r = await buildAllInOne(allInOneDeps(), {
        profile: args?.profile || config.profile || 'web',
        outDir: args?.outDir || config.exportRoot || undefined,
        includeSource: args?.includeSource !== false,
        includeKnowledge: args?.includeKnowledge !== false,
      })
      return r.result ?? JSON.stringify(r)
    },
  })

  register({
    name: 'plugin_allinone_status',
    description: '查看全量整合包的后台构建任务：不给 jobId 就列最近几个任务；给 jobId 返回进度/结果/产物路径',
    parameters: { jobId: { type: 'string', description: '任务 id（ao-…）；留空则列最近任务' } },
    output: textOutput('任务状态'),
    async execute(args) {
      if (args?.jobId) {
        const job = getJob(String(args.jobId))
        return job ? JSON.stringify(job, null, 2) : '找不到任务：' + args.jobId
      }
      const jobs = listJobs(6)
      if (!jobs.length) return '还没有任何整合包构建任务。用 plugin_allinone_build 起一个。'
      return JSON.stringify(jobs.map((j) => ({ id: j.id, status: j.status, step: j.step, root: j.root, zip: j.zip, startedAt: j.startedAt, endedAt: j.endedAt })), null, 2)
    },
  })
}


export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  registerApi(ctx, cfg)
  registerTools(ctx, cfg)
  ctx.logger?.info?.('[plugin-migrator] 就绪：设置 →「DSH 迁移」（插件整合包 + 整机迁移）')
}
