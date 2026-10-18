/**
 * DSH 整机迁移（换电脑用）：把「本机 DSH 的全部资产」打成一份可分卷、可校验、可恢复的包。
 *
 * 与另外两档的分工（不抢活）：
 *   ① 迁移包   = 只搬插件本体（给已经会装的人）
 *   ④ 全量整合包 = 插件 + 环境知识 + 施工提示词（给一台全新 DSH 自己搭）
 *   ⑤ 整机迁移（本文件）= 换电脑：配置 / 记忆 / 会话 / 附件 / 技能 / 插件源码 / API 密钥 → 一台机器搬完
 *
 * 无损原则：
 *   · 选中范围内的文件**逐字节原样**复制，不改写、不脱敏（含明文 API 密钥 —— 这是换机场景的要求，
 *     所以包必须当机密对待：文件名带 SECRETS 标记，包里 README 首行就是警示）。
 *   · 每个文件记 size / crc32 / sha256，恢复端可逐文件校验。
 *   · 打不进去的（单文件超卷上限、读失败）**逐个列进 skipped**，不静默丢。
 *
 * 为什么不用系统 tar / 现有 zip.mjs：见 lib/stream-zip.mjs 头部注释（GBK 文件名 / 内存爆炸）。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packEntries } from './stream-zip.mjs'

const now = () => new Date().toISOString()
const stamp = () => now().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')

/* ───────────────────────── 范围定义 ───────────────────────── */

/** 所有档位共用的排除项：机器绑定 / 可重装 / 缓存 / 自身产物。 */
const ALWAYS_EXCLUDE = [
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])dsh-browser-profile([\\/]|$)/,
  /(^|[\\/])\.engine([\\/]|$)/,
  /(^|[\\/])(\.venv|venv)([\\/]|$)/,
  /(^|[\\/])plugin-migrations([\\/]|$)/,
  /\.(zip|tgz|7z|rar)$/i,
  /\.bak([-.~]|$)/i, // 备份文件：省体积；而且 `.bak-xxx.` 这种带尾点的名字落到 Windows 上删不掉
  /(^|[\\/])\.unpacked([\\/]|$)/,
  /\.log$/i,
  /(^|[\\/])\.cache([\\/]|$)/,
]

/** 素材 / 下载 / 备份类：只有最全档才带（换机时一般重新下载更快）。 */
const MEDIA_EXCLUDE = [
  /(^|[\\/])(_downloads|_backups|baidu-backup|视频下载|driver-downloads)([\\/]|$)/,
  /(^|[\\/])models?([\\/]|$)/,
  /(^|[\\/])(cache|Cache|logs)([\\/]|$)/,
  /(^|[\\/])_repair_backups([\\/]|$)/,
  /(^|[\\/])dsh-builtin-browser-host([\\/]|$)/,
  /(^|[\\/])phone-bridge([\\/]|$)/,
]

/** ~/.dsh 里「配置与状态」的白名单（相对 ~/.dsh 的顶层条目）。 */
const HOME_CORE = [
  '.credentials.yaml', '.anonymous-user-id', 'AGENTS.md', 'prompt-inject.md',
  'cordis.patch.yml', 'preset-plus.json', 'settings.yaml', 'settings.yaml.imported',
  'docs', 'skills', '.agent-presets', 'super-injector', 'storages', 'session-trash',
  'undo-snapshots', 'plugin-migrator', 'llm-deepseek', 'relay', 'remote-web-ui-registry',
  'redteam', 'doubao-bridge', 'rea-workbench', 'dsh-purge', 'backups', 'lnk-backups',
  'dsh-dafeiyu', 'migrated-plugins',
]

/** profile 里「配置与索引」的白名单（相对 profile 目录）。 */
const PROFILE_CORE = [
  'package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  '.dsh-market', '.plugin-manager', 'node_modules', // node_modules 只收 junction 记录，实际由 ALWAYS_EXCLUDE 挡掉
]

export const SCOPES = {
  essential: {
    id: 'essential',
    label: '精简：配置 + 记忆 + 技能 + 密钥',
    hint: '换电脑的最小必要集：约 30~60MB。只带 ~/.dsh 的配置/记忆/技能/清单，不带工作区源码、会话、附件。',
    sessions: false,
    attachments: false,
    workspacePlugins: false,
    stateExtra: false,
    media: false,
    workspaceAll: false,
  },
  standard: {
    id: 'standard',
    label: '标准：再加会话历史 + 附件 + 插件源码',
    hint: '推荐档：几百 MB~1GB。会话、对话附件、全部插件源码都在，node_modules/模型不带。',
    sessions: true,
    attachments: true,
    workspacePlugins: true,
    stateExtra: false,
    media: false,
    workspaceAll: false,
  },
  everything: {
    id: 'everything',
    label: '最全：再加缓存/备份/浏览器运行时/整个工作区',
    hint: '十几 GB 起（含本地模型目录则更多），打包按分钟计。适合「换台机器一模一样」的场景。',
    sessions: true,
    attachments: true,
    workspacePlugins: true,
    stateExtra: true,
    media: true,
    workspaceAll: true,
  },
}

const isExcluded = (rel, rules) => rules.some((r) => r.test(rel))
const toPosix = (p) => p.split(sep).join('/')

/** 递归收集（同步；大目录交给后台任务 + 让出事件循环由调用方负责）。 */
const HEAVY_FILE_BYTES = 50 * 1024 * 1024

/** 统计一个"被排除的目录"有多大 —— 只用于评估展示，所以带文件数上限，别为统计把机器拖死。 */
function dirBytesFast(dir, cap = 30000, depth = 0) {
  let n = 0
  let bytes = 0
  if (depth > 10) return { bytes, files: n }
  let list
  try { list = readdirSync(dir, { withFileTypes: true }) } catch { return { bytes, files: n } }
  for (const e of list) {
    if (n > cap) break
    const abs = join(dir, e.name)
    if (e.isDirectory()) {
      const sub = dirBytesFast(abs, cap - n, depth + 1)
      bytes += sub.bytes
      n += sub.files
    } else if (e.isFile()) {
      try { bytes += statSync(abs).size; n += 1 } catch { /* 读不到就跳过 */ }
    }
  }
  return { bytes, files: n }
}

function walk(base, prefix, rules, out, depth = 0, ledger) {
  if (depth > 24) return
  let list
  try { list = readdirSync(base, { withFileTypes: true }) } catch { ledger.badDir.push(base); return }
  for (const e of list) {
    const abs = join(base, e.name)
    const rel = prefix ? prefix + '/' + e.name : e.name
    if (isExcluded(rel, rules)) {
      ledger.excluded += 1
      if (ledger.trackExcluded && e.isDirectory()) {
        const d = dirBytesFast(abs)
        ledger.excludedDirs.push({ rel, bytes: d.bytes, files: d.files })
      }
      continue
    }
    if (e.isDirectory()) { walk(abs, rel, rules, out, depth + 1, ledger); continue }
    if (!e.isFile()) continue
    let st
    try { st = statSync(abs) } catch { ledger.badFile.push(rel); continue }
    if (!ledger.allowHeavy && st.size > HEAVY_FILE_BYTES) { ledger.heavy.push({ rel, size: st.size }); continue }
    out.push({ abs, rel, size: st.size })
    ledger.bytes += st.size
  }
}

/** 只收白名单里的顶层条目（不存在就跳过，不报错）。 */
function walkWhitelist(baseDir, prefix, names, rules, out, ledger) {
  for (const n of names) {
    const abs = join(baseDir, n)
    if (!existsSync(abs)) continue
    const rel = prefix ? prefix + '/' + n : n
    if (isExcluded(rel, rules)) continue
    let st
    try { st = statSync(abs) } catch { continue }
    if (st.isDirectory()) walk(abs, rel, rules, out, 0, ledger)
    else if (st.isFile()) {
      if (!ledger.allowHeavy && st.size > HEAVY_FILE_BYTES) { ledger.heavy.push({ rel, size: st.size }); return }
      out.push({ abs, rel, size: st.size }); ledger.bytes += st.size
    }
  }
}

/**
 * 探测工作区根：DSH 没有把「工作区」写死在任何配置里（本机实际是 D:\Deepseek工作区）。
 * 依次看：① 环境变量 ② profiles/<p>/package.json 里 file:/link: 依赖的公共父目录（最准：插件源码根）
 * ③ 常见候选路径 ④ 进程 cwd。
 */
export function detectWorkspace(dshHomeDir) {
  const envv = process.env.DSH_WORKSPACE || process.env.DSH_WORKSPACE_DIR
  if (envv && existsSync(envv)) return resolve(envv)
  const votes = new Map()
  const pdir = join(dshHomeDir, 'profiles')
  try {
    for (const e of readdirSync(pdir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      let pkg
      try { pkg = JSON.parse(readFileSync(join(pdir, e.name, 'package.json'), 'utf8')) } catch { continue }
      for (const spec of Object.values(pkg.dependencies ?? {})) {
        const s = String(spec).replace(/^(file:|link:)/, '')
        if (!/^[A-Za-z]:[\\/]/.test(s)) continue
        const parent = dirname(resolve(s))
        votes.set(parent, (votes.get(parent) ?? 0) + 1)
      }
    }
  } catch { /* 没有 profiles 就算了 */ }
  let best = null
  let bestN = 0
  for (const [p, n] of votes) {
    if (!existsSync(p)) continue
    if (n > bestN) { best = p; bestN = n }
  }
  if (best) return best
  for (const cand of [
    process.env.DSH_WORKSPACE,
    join(dirname(dshHomeDir), 'Deepseek工作区'),
    join(dirname(dshHomeDir), 'workspace'),
    'D:\\Deepseek工作区',
  ].filter(Boolean)) {
    if (existsSync(cand)) return cand
  }
  return process.cwd()
}

/**
 * 扫一遍范围，产出待打包条目（不写盘）。
 * @returns {{entries, stats, ledger, dshVersion, profiles, workspaceRoot}}
 */
export function collectScope(scopeId = 'standard', { dshHomeDir, workspaceDir, trackExcluded = false } = {}) {
  const sc = SCOPES[scopeId] ?? SCOPES.standard
  const h = dshHomeDir || home()
  const ws = workspaceDir || detectWorkspace(h)
  const rules = [...ALWAYS_EXCLUDE, ...(sc.media ? [] : MEDIA_EXCLUDE)]
  const entries = []
  const ledger = { excluded: 0, bytes: 0, badDir: [], badFile: [], heavy: [], roots: [], allowHeavy: Boolean(sc.media), trackExcluded: Boolean(trackExcluded), excludedDirs: [] }

  // ── 1) ~/.dsh ──
  const homeNames = [...HOME_CORE]
  if (sc.sessions) homeNames.push('sessions')
  if (sc.attachments) homeNames.push('attachments')
  if (sc.stateExtra) homeNames.push('state')
  else homeNames.push('_temp_backup_sessions') // 小（28MB），且是会话备份，标准档也带
  walkWhitelist(h, 'dsh-home', homeNames, rules, entries, ledger)
  ledger.roots.push({ kind: 'dsh-home', path: h, target: '~/.dsh' })

  // 2) profiles：只收白名单文件（node_modules 被规则挡掉，避免把 1.7GB 依赖打进去）
  const pdir = join(h, 'profiles')
  if (existsSync(pdir)) {
    for (const e of readdirSync(pdir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      walkWhitelist(join(pdir, e.name), 'dsh-home/profiles/' + e.name, PROFILE_CORE, rules, entries, ledger)
    }
    ledger.roots.push({ kind: 'profiles', path: pdir, target: '~/.dsh/profiles' })
  }

  // 3) 工作区：插件源码（workspacePlugins）或整个工作区（workspaceAll）
  if (existsSync(ws)) {
    if (sc.workspaceAll) {
      walk(ws, 'workspace', rules, entries, 0, ledger)
    } else if (sc.workspacePlugins) {
      for (const e of readdirSync(ws, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        // 插件目录判定：含 package.json，或名字像插件
        const hasPkg = existsSync(join(ws, e.name, 'package.json'))
        if (!hasPkg && !/^(dsh|ds-|@)/i.test(e.name)) { ledger.excluded += 1; continue }
        walkWhitelist(ws, 'workspace', [e.name], rules, entries, ledger)
      }
      // 工作区根上的散文件（.md、配置）也带上
      for (const e of readdirSync(ws, { withFileTypes: true })) {
        if (e.isDirectory()) continue
        const rel = 'workspace/' + e.name
        if (isExcluded(rel, rules)) continue
        const abs = join(ws, e.name)
        let st
        try { st = statSync(abs) } catch { continue }
        entries.push({ abs, rel, size: st.size })
        ledger.bytes += st.size
      }
    }
    ledger.roots.push({ kind: 'workspace', path: ws, target: '<新机工作区>' })
  }

  const files = entries.length
  return {
    scope: sc.id,
    label: sc.label,
    entries,
    ledger,
    stats: { files, bytes: ledger.bytes, excluded: ledger.excluded },
    dshVersion: (() => { try { return JSON.parse(readFileSync(join(h, 'package.json'), 'utf8')).version } catch { return null } })(),
    dshHomeDir: h,
    workspaceDir: ws,
  }
}

/* ───────────────────────── 文档生成 ───────────────────────── */

const KEY_FILES = [
  '.credentials.yaml', 'settings.yaml', 'AGENTS.md', 'prompt-inject.md',
  'profiles/<p>/cordis.patch.yml', 'profiles/<p>/cordis.yml', 'profiles/<p>/package.json',
  'profiles/<p>/pnpm-lock.yaml', 'super-injector/registry.json',
]

function mdReadme(ctx) {
  const L = []
  L.push('==============================================================')
  L.push('  ⚠ 这个包里有明文 API 密钥（.credentials.yaml / cordis.yml 等）')
  L.push('  只在本人的机器之间传递；别上传网盘公开链接、别发群、别进代码仓库。')
  L.push('  用完（新机确认能跑起来之后）建议删掉本包，或至少改一次密钥。')
  L.push('==============================================================')
  L.push('')
  L.push('DSH 整机迁移包')
  L.push('================')
  L.push('生成时间：' + ctx.createdAt)
  L.push('来源机器：' + (ctx.source.host || '?') + '（' + ctx.source.platform + '）｜DSH 版本：' + (ctx.source.dshVersion || '?') + '｜Node：' + ctx.source.node)
  L.push('档位：' + ctx.label)
  L.push('文件 ' + ctx.stats.files + ' 个 / ' + (ctx.stats.bytes / 1048576).toFixed(1) + ' MB' + (ctx.stats.volumes > 1 ? '，分 ' + ctx.stats.volumes + ' 卷' : ''))
  L.push('')
  L.push('包里有什么')
  L.push('-----------')
  L.push('  01-dsh-home.zip      ~/.dsh 下的配置/记忆/技能/会话/附件（看清单一栏里的「已排除」）')
  L.push('  02-workspace.zip     工作区里的插件源码与散文件（不含 node_modules）')
  L.push('  MANIFEST.json        逐文件清单：大小 + crc32 + sha256，可校验无损')
  L.push('  MANIFEST.sha256      各个卷自身的 sha256（先校验再解，防传输损坏）')
  L.push('  PROMPT.md            给新机器 DSH 的恢复提示词（整段粘进对话框即可）')
  L.push('  restore-dsh.mjs      恢复脚本（可 --dry-run 预览）')
  L.push('  恢复-DSH.bat         Windows 双击入口')
  L.push('')
  L.push('新机器怎么用（三步）')
  L.push('--------------------')
  L.push('  0) 先装好 Node 22+ 与 DSH，并让目标 profile 至少启动过一次')
  L.push('  1) 双击「恢复-DSH.bat」→ 按提示选工作区落盘位置')
  L.push('     （命令行：node restore-dsh.mjs --dry-run 先预览，去掉 --dry-run 才写）')
  L.push('  2) 在 profile 目录跑一次 pnpm install（或 npm install），再启动 DSH')
  L.push('')
  L.push('  更省事：把 PROMPT.md 整段贴进新机器的 DSH 对话框，让 agent 按步骤恢复并验收。')
  L.push('')
  L.push('明确不进包的东西（换机后需要重装/重下，不是遗漏）')
  L.push('----------------------------------------------')
  L.push('  · node_modules（依赖，pnpm install 重建）')
  L.push('  · 浏览器 profile（含 cookie，换机失效）、python 运行时（.engine/.venv）')
  L.push('  · 本地模型目录（models/，几 GB，重新下载更快）')
  L.push('  · 下载/素材/备份目录（_downloads、视频下载、baidu-backup、_repair_backups 等）')
  L.push('  · 以往生成的迁移包（plugin-migrations/，避免包里套包）')
  L.push('')
  if (ctx.skipped.length) {
    L.push('⚠ 有 ' + ctx.skipped.length + ' 个文件没能打进去（详见 MANIFEST.json 的 skipped）：')
    for (const s of ctx.skipped.slice(0, 10)) L.push('  · ' + s.rel + '：' + s.reason)
    if (ctx.skipped.length > 10) L.push('  … 其余见 MANIFEST.json')
    L.push('')
  }
  L.push('校验方法')
  L.push('--------')
  L.push('  PowerShell: Get-FileHash 01-dsh-home.zip -Algorithm SHA256  与 MANIFEST.sha256 对照')
  L.push('  或 node restore-dsh.mjs --verify-only  逐文件比对 sha256（最严格）')
  L.push('')
  return L.join('\n')
}

function mdPrompt(ctx) {
  const L = []
  L.push('# 任务：把这台机器恢复成另一台机器的 DSH 环境')
  L.push('')
  L.push('你在一台新机器上，面前有一个「DSH 整机迁移包」。它来自一台已经配置好的机器：`~/.dsh` 的配置、记忆库、错误库、技能、会话历史、对话附件、插件源码，以及 API 密钥。')
  L.push('目标：**恢复成一样的可用状态**，并用校验证明没有丢东西。')
  L.push('')
  L.push('## 包结构')
  L.push('')
  L.push('```')
  L.push('README-先读我.txt     ← 先看：含明文密钥的警示 + 三步流程')
  L.push('MANIFEST.json         ← 逐文件 size/crc32/sha256（唯一权威清单）')
  L.push('MANIFEST.sha256       ← 各卷自身哈希')
  L.push('01-dsh-home.zip       ← ~/.dsh 的内容（包内前缀 dsh-home/）')
  L.push('02-workspace.zip      ← 工作区内容（包内前缀 workspace/）')
  L.push('restore-dsh.mjs       ← 恢复脚本；恢复-DSH.bat 是它的双击壳')
  L.push('PROMPT.md             ← 本文件')
  L.push('```')
  L.push('')
  L.push('## 铁律')
  L.push('')
  L.push('1. **先备份目标机现状**：`~/.dsh` 的 `.credentials.yaml` / `settings.yaml` / `profiles/*/package.json` / `profiles/*/cordis.patch.yml` 一律先复制成 `.bak-restore-<时间戳>`，再覆盖。')
  L.push('2. **先 `--dry-run` 再真跑**：`node restore-dsh.mjs --dry-run` 会打印「哪个文件覆盖到哪里」，确认无误再执行。')
  L.push('3. **包内的相对路径不要改**：`dsh-home/` 必须落到 `~/.dsh`，`workspace/` 落到你选的工作区根。')
  L.push('4. **node_modules 不恢复**：目录不会被带过来，恢复后在每个 profile 目录执行 `pnpm install`（无 pnpm 用 `npm install`）。')
  L.push('5. **junction 要重建**：`profiles/<p>/node_modules/<包名>` 是指向工作区源码的链接，恢复脚本会按新路径重建；失败时用 `dev_heal_links`。')
  L.push('6. **密钥是本机真人给的**：包里已带来源机的密钥，恢复后**先验证能不能调通**；调不通就问本人要新的，不要编造。')
  L.push('7. **失败就停下报错**，不要「差不多能跑就行」——这个包的价值就是无损。')
  L.push('')
  L.push('## 顺序')
  L.push('')
  L.push('```')
  L.push('0) 装 Node ≥22 与 DSH；让目标 profile 启动过一次（否则 profiles/<p>/ 不存在）')
  L.push('1) 校验卷：比对 MANIFEST.sha256，或 node restore-dsh.mjs --verify-only')
  L.push('2) node restore-dsh.mjs --dry-run            # 看计划')
  L.push('3) node restore-dsh.mjs --workspace <路径>    # 真恢复（会把被覆盖的配置备份）')
  L.push('4) 每个 profile 目录：pnpm install')
  L.push('5) 重建 junction（restore 已尝试；失败用 dev_heal_links）')
  L.push('6) 启动 DSH，逐个确认：设置页里插件都在、记忆库条数对、会话列表在、skill 列表在')
  L.push('7) 抽 3 个插件点开 UI 试一次；抽 2 个工具调一次')
  L.push('```')
  L.push('')
  L.push('## 完成定义（逐条自证）')
  L.push('')
  L.push(`- MANIFEST.json 里 ${ctx.stats.files} 个文件，恢复后目标机上同路径同 size 同 sha256（或说明为何跳过）。`)
  L.push('- `~/.dsh/docs/ai-memory.json` 词条数与来源机一致（可用 memory_library stats 看）。')
  L.push('- 会话列表能看到来源机的会话；附件目录有内容。')
  L.push(`- 插件数一致（来源机 ${(ctx.pluginCount ?? '?')} 个），且设置页无「缺 dsh.bundle」告警。`)
  L.push('- 至少一次真实模型调用成功（证明密钥与新机网络都通）。')
  L.push('')
  L.push('## 恢复后要提醒本人的事')
  L.push('')
  L.push('- 这个包里有明文密钥：确认能跑之后，删掉包或轮换一次密钥。')
  L.push('- 工作区路径变了的话，插件里写死的绝对路径要跟着改（restore 会列出改动清单）。')
  L.push('- 会话/记忆是**当时快照**，之后两边的增量不会自动合并。')
  L.push('')
  return L.join('\n')
}

/* ───────────────────────── 构建 ───────────────────────── */

function sha256File(p) {
  const h = createHash('sha256')
  const buf = readFileSync(p)
  h.update(buf)
  return { sha256: h.digest('hex'), bytes: buf.length }
}

/**
 * 构建整机迁移包（后台任务会逐条推进度）。
 * @param {{scope?:string, outDir?:string, maxVolumeMB?:number, dshHomeDir?:string, workspaceDir?:string,
 *          includeSessions?:boolean, onProgress?:Function, cancelled?:Function}} o
 */
export async function buildFullMigration({
  scope = 'standard', outDir, maxVolumeMB = 1800, dshHomeDir, workspaceDir,
  onProgress, cancelled,
} = {}) {
  const t0 = Date.now()
  const say = (msg, extra) => { try { onProgress?.(msg, extra) } catch { /* 进度只是提示 */ } }

  say('扫描范围内文件…')
  const col = collectScope(scope, { dshHomeDir, workspaceDir })
  if (!col.entries.length) return { ok: false, result: '范围内没有可打包的文件（检查 DSH_HOME 与工作区路径）' }
  say(`扫描完成：${col.stats.files} 个文件 / ${(col.stats.bytes / 1048576).toFixed(1)} MB，开始打包…`, { phase: 'pack', total: col.entries.length })
  await sleep(0)

  const root = join(resolve(outDir || join(home(), 'dsh-migrations')), 'dsh-migration-' + stamp())
  mkdirSync(root, { recursive: true })

  // 按前缀分成两卷（~/.dsh 与 workspace 分开，恢复时可以只解其中一卷）
  const groups = new Map()
  for (const e of col.entries) {
    const top = e.rel.split('/')[0]
    if (!groups.has(top)) groups.set(top, [])
    groups.get(top).push(e)
  }
  const order = [...groups.keys()].sort((a, b) => (a === 'dsh-home' ? -1 : b === 'dsh-home' ? 1 : a.localeCompare(b)))

  const volumesOut = []
  const manifestEntries = []
  const skipped = []
  let done = 0
  const volNames = { 'dsh-home': '01-dsh-home.zip', workspace: '02-workspace.zip' }

  for (let i = 0; i < order.length; i += 1) {
    const top = order[i]
    const list = groups.get(top)
    const outFile = join(root, volNames[top] ?? String(i + 3).padStart(2, '0') + '-' + top + '.zip')
    say(`打包 ${top}（${list.length} 个文件）…`, { phase: 'pack', group: top })
    const res = await packEntries({
      outFile,
      entries: list,
      maxVolumeBytes: Math.max(64, Number(maxVolumeMB) || 1800) * 1024 * 1024,
      cancelled,
      onProgress: (p) => {
        done += 1
        if (done % 40 === 0 || p.done === p.total) {
          say(`打包中 ${done}/${col.stats.files}：${p.rel.length > 60 ? '…' + p.rel.slice(-58) : p.rel}`, { phase: 'pack', done, total: col.stats.files, group: top })
        }
      },
    })
    const volName = (n) => n === 1 ? basename(outFile) : basename(outFile).replace(/\.zip$/i, '') + '.part' + n + '.zip'
    for (const v of res.volumes) volumesOut.push({ file: basename(v.file), path: v.file, entries: v.entries, bytes: v.bytes })
    for (const m of res.manifest) manifestEntries.push({ ...m, volume: volName(m.volume) })
    for (const s of res.skipped) skipped.push(s)
    await sleep(0)
  }

  say('写清单与文档…')
  const ctx = {
    createdAt: now(),
    scope,
    label: col.label,
    source: {
      host: process.env.COMPUTERNAME ?? null,
      platform: process.platform,
      node: process.version,
      dshVersion: col.dshVersion,
      dshHome: col.dshHomeDir,
      workspace: col.workspaceDir,
    },
    stats: {
      files: manifestEntries.length,
      bytes: manifestEntries.reduce((n, m) => n + m.size, 0),
      volumes: volumesOut.length,
      skipped: skipped.length,
      excludedEntries: col.stats.excluded,
    },
    skipped,
  }

  // 卷自身 sha256（传输校验）
  const volHashes = []
  for (const v of volumesOut) {
    const { sha256, bytes } = sha256File(v.path)
    volHashes.push({ file: v.file, bytes, sha256 })
  }

  const manifest = {
    schemaVersion: 1,
    kind: 'dsh-full-migration',
    createdAt: ctx.createdAt,
    scope,
    label: col.label,
    source: ctx.source,
    containsSecrets: true,
    warning: '包含明文 API 密钥（.credentials.yaml 等），按机密文件处理',
    stats: ctx.stats,
    volumes: volHashes,
    roots: col.ledger.roots,
    entries: manifestEntries,
    skipped,
  }
  writeFileSync(join(root, 'MANIFEST.json'), JSON.stringify(manifest, null, 1) + '\n', 'utf8')
  writeFileSync(join(root, 'MANIFEST.sha256'), volHashes.map((v) => `${v.sha256}  ${v.file}`).join('\n') + '\n', 'utf8')
  writeFileSync(join(root, 'README-先读我.txt'), mdReadme(ctx) + '\n', 'utf8')
  const pluginCount = (() => {
    try {
      const pdir = join(col.dshHomeDir, 'profiles', 'web', 'package.json')
      const pkg = JSON.parse(readFileSync(pdir, 'utf8'))
      return Object.keys(pkg.dependencies ?? {}).filter((n) => !n.startsWith('@deepseek-ai/')).length
    } catch { return null }
  })()
  ctx.pluginCount = pluginCount
  writeFileSync(join(root, 'PROMPT.md'), mdPrompt(ctx) + '\n', 'utf8')

  // 恢复脚本与 bat 从 assets 复制（随包走，新机不需要装本插件）
  const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets')
  for (const [src, dst] of [['restore-dsh.mjs', 'restore-dsh.mjs'], ['恢复-DSH.bat', '恢复-DSH.bat']]) {
    const from = join(assetsDir, src)
    if (existsSync(from)) {
      writeFileSync(join(root, dst), readFileSync(from))
    } else {
      skipped.push({ rel: dst, reason: 'assets 里缺这个文件（包里少一个便捷入口）' })
    }
  }

  const took = Date.now() - t0
  say('完成')
  return {
    ok: true,
    root,
    volumes: volumesOut.map((v) => ({ file: v.file, bytes: v.bytes })),
    stats: { ...ctx.stats, tookMs: took },
    result: [
      `已生成整机迁移包：${root}`,
      `档位：${col.label}`,
      `文件 ${ctx.stats.files} 个 / ${(ctx.stats.bytes / 1048576).toFixed(1)} MB / ${volumesOut.length} 卷`,
      skipped.length ? `⚠ ${skipped.length} 个文件未打包（见 MANIFEST.json → skipped）` : '全部文件已打包',
      `提示词：${join(root, 'PROMPT.md')}`,
      `耗时 ${(took / 1000).toFixed(1)}s`,
    ].join('\n'),
  }
}

/* ───────────────────────── 后台任务 ───────────────────────── */

function jobsDir() { return join(home(), 'plugin-migrator', 'jobs') }
const jobFile = (id) => join(jobsDir(), id + '.json')
function writeJob(job) {
  try {
    mkdirSync(jobsDir(), { recursive: true })
    writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2) + '\n', 'utf8')
  } catch { /* 进度落盘失败不影响构建 */ }
}
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }

export function getFullJob(id) { return id ? readJson(jobFile(String(id))) : null }
export function listFullJobs(limit = 8) {
  try {
    return readdirSync(jobsDir())
      .filter((f) => f.startsWith('fm-') && f.endsWith('.json'))
      .map((f) => readJson(join(jobsDir(), f)))
      .filter(Boolean)
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, limit)
  } catch { return [] }
}

export function startFullMigration(opts = {}) {
  const id = 'fm-' + stamp() + '-' + Math.random().toString(36).slice(2, 6)
  const job = {
    id,
    status: 'running',
    scope: opts.scope || 'standard',
    outDir: opts.outDir || null,
    maxVolumeMB: Number(opts.maxVolumeMB) || 1800,
    startedAt: now(),
    endedAt: null,
    step: '排队…',
    phase: 'scan',
    done: 0,
    total: 0,
    steps: [],
    root: null,
    volumes: [],
    stats: null,
    result: null,
    error: null,
  }
  writeJob(job)
  void (async () => {
    try {
      const r = await buildFullMigration({
        scope: job.scope,
        outDir: job.outDir || undefined,
        maxVolumeMB: job.maxVolumeMB,
        onProgress: (msg, extra) => {
          job.step = msg
          if (extra) {
            if (extra.phase) job.phase = extra.phase
            if (typeof extra.done === 'number') job.done = extra.done
            if (typeof extra.total === 'number') job.total = extra.total
          }
          job.steps.push({ at: now(), msg })
          if (job.steps.length > 120) job.steps.splice(0, 40)
          writeJob(job)
        },
      })
      job.status = r.ok ? 'done' : 'error'
      job.result = r.result ?? null
      job.root = r.root ?? null
      job.volumes = r.volumes ?? []
      job.stats = r.stats ?? null
      job.error = r.ok ? null : (r.result ?? '构建失败')
    } catch (e) {
      job.status = 'error'
      job.error = String(e?.stack ?? e).slice(0, 1500)
    } finally {
      job.endedAt = now()
      job.step = job.status === 'done' ? '完成' : '失败'
      writeJob(job)
    }
  })()
  return job
}

/** 预估（不打包，只扫描）：给面板显示「选这档大概多大」，并给出体积构成 ——
 *  评估阶段真正要看的是「这 900MB 花在哪、砍掉什么能瘦」，而不是一个总数。 */
export function estimateScope(scope, opts = {}) {
  const t0 = Date.now()
  const col = collectScope(scope, { ...opts, trackExcluded: opts.trackExcluded !== false })
  const byKey = new Map()
  for (const e of col.entries) {
    const k = e.rel.split('/').slice(0, 2).join('/')
    const cur = byKey.get(k) ?? { key: k, bytes: 0, files: 0 }
    cur.bytes += e.size
    cur.files += 1
    byKey.set(k, cur)
  }
  const included = [...byKey.values()]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 12)
    .map((x) => ({ key: x.key, mb: +(x.bytes / 1048576).toFixed(1), files: x.files }))
  const heaviest = col.entries
    .slice()
    .sort((a, b) => b.size - a.size)
    .slice(0, 8)
    .map((e) => ({ rel: e.rel, mb: +(e.size / 1048576).toFixed(1) }))
  const excludedTop = (col.ledger.excludedDirs ?? [])
    .slice()
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10)
    .map((x) => ({ path: x.rel, mb: +(x.bytes / 1048576).toFixed(1), files: x.files }))
  const excludedMb = (col.ledger.excludedDirs ?? []).reduce((n, x) => n + x.bytes, 0) / 1048576
  return {
    ok: true,
    scope: col.scope,
    label: col.label,
    files: col.stats.files,
    bytes: col.stats.bytes,
    mb: Math.round(col.stats.bytes / 1048576),
    volumesAt1800: Math.max(1, Math.ceil(col.stats.bytes / (1800 * 1024 * 1024))),
    excluded: col.stats.excluded,
    excludedMb: +excludedMb.toFixed(1),
    excludedTop,
    heavySkipped: col.ledger.heavy.length,
    heavyTop: col.ledger.heavy.slice().sort((a, b) => b.size - a.size).slice(0, 5).map((h) => ({ rel: h.rel, mb: +(h.size / 1048576).toFixed(1) })),
    included,
    heaviest,
    tookMs: Date.now() - t0,
    workspace: col.workspaceDir,
    dshHome: col.dshHomeDir,
    roots: col.ledger.roots,
  }
}

/** 把已生成的包「导出」到用户选的目录（散文件与卷都拷过去）。 */
export function exportFull({ jobId, target }) {
  const job = getFullJob(jobId)
  if (!job) return { ok: false, result: '找不到任务：' + jobId }
  if (job.status !== 'done' || !job.root) return { ok: false, result: '任务还没完成（status=' + job.status + '）' }
  const dest = resolve(String(target || '').trim())
  if (!dest) return { ok: false, result: '请先选择导出目录' }
  try { mkdirSync(dest, { recursive: true }) } catch (e) {
    return { ok: false, result: '导出目录不可写：' + String(e?.message ?? e).slice(0, 200) }
  }
  const copied = []
  let bytes = 0
  for (const e of readdirSync(job.root, { withFileTypes: true })) {
    if (!e.isFile()) continue
    const from = join(job.root, e.name)
    let to = join(dest, e.name)
    if (existsSync(to)) to = join(dest, e.name.replace(/(\.[a-z0-9]+)$/i, '-' + stamp() + '$1'))
    try {
      copyFileSync(from, to)
      copied.push(to)
      bytes += statSync(to).size
    } catch { /* 单个失败继续 */ }
  }
  if (!copied.length) return { ok: false, result: '包里没有可导出的文件' }
  return {
    ok: true,
    dest,
    files: copied,
    result: ['已导出 ' + copied.length + ' 个文件 / ' + (bytes / 1048576).toFixed(1) + ' MB → ' + dest]
      .concat(copied.map((p) => '  · ' + basename(p))).join('\n'),
  }
}

export const __internal = { ALWAYS_EXCLUDE, MEDIA_EXCLUDE, HOME_CORE, PROFILE_CORE, mdReadme, mdPrompt }
