/**
 * 全量整合包构建器（dsh-plugin-migrator 的「④ 全量整合包」半边）。
 *
 * 与「① 导出迁移包」的分工：
 *   ① 只搬插件本体（源码 + 依赖声明 + patch + 密钥需求清单），给「已经知道怎么装的人」。
 *   ④ 在本机把「环境知识」也一起抽出来 —— 每个插件干什么、怎么搭、踩过什么坑、版本怎么变的，
 *      再生成一份可以直接粘给全新 DSH 对话框的 PROMPT.md，让对端 agent 自己按步骤复刻。
 *
 * 唯一写入者：只写 <输出目录>/dsh-allinone-<时间戳>/… 与 ~/.dsh/plugin-migrator/jobs/。
 * 不写 ~/.dsh/docs/*（错误库 / AI 记忆库有各自唯一写入者），只读、只摘取、只脱敏。
 *
 * 零依赖、纯 ESM、不 spawn 子进程（本机插件进程里 stdio:"pipe" 会 EPERM）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { zipDirectory } from './zip.mjs'

const now = () => new Date().toISOString()
const stamp = () => now().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const home = () => process.env.DSH_HOME || join(homedir(), '.dsh')

/** 包里不带走的密钥字面量：命中就抹成 <已抹除>。 */
const SECRET_LITERAL = /(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._-]{16,})/g

/** 知识层里出现的「值是密钥」的行（形如 apiKey: xxx）→ 只留键名。 */
const SECRET_LINE = /^(\s*[-|*\s]*)([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|password|passwd|credential)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(\S.*)$/gim

export function redact(text) {
  if (typeof text !== 'string' || !text) return text ?? ''
  let out = text.replace(SECRET_LITERAL, '<已抹除>')
  out = out.replace(SECRET_LINE, (_m, p, k, sep) => `${p}${k}${sep}<已抹除>`)
  return out
}

const readText = (p, cap = 400_000) => {
  try {
    const st = statSync(p)
    if (!st.isFile() || st.size > cap) return ''
    return readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
  } catch { return '' }
}
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }

function walkFiles(dir, out = [], depth = 0, cap = 4000) {
  if (depth > 6 || out.length > cap) return out
  let list = []
  try { list = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of list) {
    if (out.length > cap) break
    if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.bak')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, out, depth + 1, cap)
    else if (e.isFile()) out.push(p)
  }
  return out
}

/* ───────────────────────── 插件静态画像 ───────────────────────── */

const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx)$/
const TOOL_WINDOW = 1600

/** 取一段代码里工具声明的 name/description。
 *  两种写法本机都有：① `defineTool({name,…})` 内联；② 工厂式 `register({name,…})`
 *  （dsh-plugin-migrator / interop 这类自己包了一层），只认 ① 会漏掉一半工具。 */
function extractTools(code) {
  const out = []
  const seen = new Set()
  const descAt = (win) => {
    const dv = win.match(/description:\s*(?:'((?:[^'\\\n]|\\.){6,400})'|"((?:[^"\\\n]|\\.){6,400})"|`((?:[^`\\]|\\.){6,400})`)/)
    return (dv?.[1] || dv?.[2] || dv?.[3] || '').replace(/\\n/g, ' ').trim()
  }
  const push = (name, desc) => {
    if (!name || seen.has(name)) return
    seen.add(name)
    out.push({ name, description: desc || '' })
  }
  // ① 内联 defineTool({…})
  for (const m of code.matchAll(/defineTool\(\s*\{/g)) {
    const win = code.slice(m.index, m.index + TOOL_WINDOW)
    const nm = win.match(/name:\s*['"]([A-Za-z0-9_.:-]{3,80})['"]/)
    if (nm) push(nm[1], descAt(win))
  }
  // ② 工厂式：name 里带下划线（工具命名惯例）+ 同窗口有 description 与 parameters/execute/output
  for (const m of code.matchAll(/\bname:\s*['"]([a-z][a-z0-9]*(?:_[a-z0-9]+){1,6})['"]/g)) {
    const win = code.slice(Math.max(0, m.index - 120), m.index + 1000)
    if (!/description\s*:/.test(win)) continue
    if (!/(parameters|execute|output)\s*[:=(]/.test(win)) continue
    push(m[1], descAt(win))
  }
  return out
}

/** 一个插件目录 → 画像（工具 / 路由 / 槽位 / 配置面 / 依赖 / 规模 / README）。 */
export function analyzePlugin(p, ctx) {
  const { copyPluginSnapshot } = ctx
  const dir = [p.dir, p.installedDir].find((d) => d && existsSync(join(d, 'package.json'))) || null
  const pkg = dir ? (readJson(join(dir, 'package.json')) || {}) : {}
  const info = {
    name: p.name,
    version: pkg.version ?? p.version ?? null,
    description: (pkg.description ?? p.description ?? '').trim(),
    kind: p.kind,
    spec: p.spec,
    dir,
    dirSource: p.dirSource ?? null,
    inBundles: Boolean(p.inBundles),
    disabled: Boolean(p.disabled),
    hasClient: Boolean(p.hasClient),
    runsStandalone: Boolean(p.runsStandalone),
    bundlePatch: p.bundlePatch ?? pkg.dsh?.bundle?.patch ?? null,
    bundlePatchOk: Boolean(p.bundlePatchOk),
    fileCount: p.fileCount ?? 0,
    sizeBytes: p.sizeBytes ?? 0,
    tools: [], routes: [], slots: [], settingsSlots: [], env: [], dataPaths: [], bins: {},
    deps: {}, peerDeps: {},
    codeLines: 0,
    readme: '',
    readmeExcerpt: '',
    versionsSeen: [],
    knowledge: [],
    files: [],
  }
  if (!dir) { info.missing = '源码/安装目录不存在'; info.files = []; return info }

  info.deps = pkg.dependencies ?? {}
  info.peerDeps = pkg.peerDependencies ?? {}
  info.bins = pkg.bin && typeof pkg.bin === 'object' ? pkg.bin : (typeof pkg.bin === 'string' ? { [pkg.name.split('/').pop()]: pkg.bin } : {})

  const files = walkFiles(dir)
  info.files = files.map((f) => f.slice(dir.length + 1)).slice(0, 260)

  // 代码面：lib/ 与 src/ 优先，限总量与单文件，避免把大 bundle 读进来
  let budget = 900_000
  const codeParts = []
  for (const f of files) {
    if (budget <= 0) break
    if (!CODE_EXT.test(f)) continue
    const rel = f.slice(dir.length + 1)
    if (!/^(lib|src|bin|tools)\b/.test(rel) && !/^(index|main)\.(js|mjs|ts)$/.test(rel)) continue
    const txt = readText(f, Math.min(300_000, budget))
    if (!txt) continue
    budget -= txt.length
    codeParts.push(txt)
    info.codeLines += txt.split('\n').length
  }
  const code = codeParts.join('\n// ----\n')

  info.tools = extractTools(code)

  const routes = new Set()
  for (const m of code.matchAll(/\bpath:\s*['"](\/[A-Za-z0-9._\/-]{2,90})['"]/g)) routes.add(m[1])
  info.routes = [...routes].slice(0, 40)

  const slots = new Set()
  for (const m of code.matchAll(/slots\.(?:register|inject)\(\s*['"]([A-Za-z0-9._-]{3,60})['"]/g)) slots.add(m[1])
  for (const m of code.matchAll(/(?:slots\.register|slots\.inject)\(\s*\{[^}]{0,200}?name:\s*['"]([A-Za-z0-9._-]{3,60})['"]/gs)) slots.add(m[1])
  info.slots = [...slots].slice(0, 30)

  const sset = new Set()
  for (const m of code.matchAll(/['"`](settings\.[a-z0-9_.-]{3,60})['"`]/gi)) sset.add(m[1])
  for (const m of code.matchAll(/(settings\.(?:section|plugins?\.tab|plugin\.item|item))/g)) sset.add(m[1])
  info.settingsSlots = [...sset].slice(0, 20)

  const env = new Set()
  for (const m of code.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,40})/g)) env.add(m[1])
  info.env = [...env].filter((k) => !/^(NODE_|PATH|HOME|TEMP|TMP|COMPUTERNAME|USERPROFILE|APPDATA|LOCALAPPDATA|OS|PROCESSOR|SYSTEMROOT|WINDIR|USERNAME)/.test(k)).slice(0, 30)

  const dp = new Set()
  for (const m of code.matchAll(/['"`]([^'"`\n]{0,40}?\.dsh[\\/][A-Za-z0-9_.\\/-]{2,70})['"`]/g)) dp.add(m[1].trim())
  info.dataPaths = [...dp].slice(0, 16)

  const rd = [join(dir, 'README.md'), join(dir, 'readme.md'), join(dir, 'README.MD')].find((f) => existsSync(f))
  const seenV = new Set()
  const scanVersions = (text, source) => {
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:[-*+>#\s]*)\[?v?(\d+\.\d+\.\d+)\]?\b([^\n]{0,90})/)
      if (!m) continue
      if (seenV.has(m[1])) continue
      seenV.add(m[1])
      info.versionsSeen.push({ version: m[1], note: m[2].replace(/^[\s:：—–-]+/, '').trim(), source })
      if (info.versionsSeen.length >= 30) return
    }
  }
  if (rd) {
    info.readme = readText(rd, 120_000)
    info.readmeExcerpt = info.readme.split('\n').slice(0, 90).join('\n').trim()
    scanVersions(info.readme, 'README')
  }
  // CHANGELOG 是版本变迁最直接的来源（很多包只在这里记）
  for (const cn of ['CHANGELOG.md', 'CHANGELOG', 'changelog.md', 'CHANGES.md', 'docs/CHANGELOG.md']) {
    const f = join(dir, cn)
    if (!existsSync(f)) continue
    const txt = readText(f, 120_000)
    if (!txt) continue
    info.changelog = cn
    info.changelogExcerpt = txt.split('\n').slice(0, 80).join('\n').trim()
    scanVersions(txt, 'CHANGELOG')
    break
  }
  void copyPluginSnapshot
  return info
}

/* ───────────────────────── 知识层（AI 记忆库 / 错误库 / 技能）───────────────────────── */

/** 插件名 → 关键词集合（去掉 scope、dsh- 前缀、-plugin 后缀）。 */
function keysOf(name) {
  const short = String(name).split('/').pop()
  const bare = short.replace(/^dsh-/, '').replace(/-?(plugin|extension)$/, '')
  const set = new Set([short, bare])
  for (const k of [...set]) if (k.length >= 5) set.add(k.replace(/-/g, ''))
  return [...set].filter((k) => k.length >= 4)
}

function loadMemory() {
  const j = readJson(join(home(), 'docs', 'ai-memory.json'))
  return Array.isArray(j?.entries) ? j.entries : []
}

/** 记忆库里跟这个插件相关的词条（term/别名/tags/summary 打分）。 */
export function matchKnowledge(entry, name) {
  const keys = keysOf(name)
  let score = 0
  const hay = {
    term: String(entry.term ?? '').toLowerCase(),
    aliases: (entry.aliases ?? []).join(' ').toLowerCase(),
    tags: (entry.tags ?? []).join(' ').toLowerCase(),
    summary: String(entry.summary ?? '').toLowerCase(),
    group: String(entry.group ?? '').toLowerCase(),
  }
  for (const k of keys) {
    const kk = k.toLowerCase()
    if (hay.term === kk) score += 10
    else if (hay.term.includes(kk)) score += 6
    if (hay.aliases.includes(kk)) score += 5
    if (hay.tags.includes(kk)) score += 3
    if (hay.summary.includes(kk)) score += 2
    if (hay.group.includes(kk)) score += 1
  }
  return score
}

function pickKnowledge(memory, name, limit = 4) {
  const scored = []
  for (const e of memory) {
    const s = matchKnowledge(e, name)
    if (s >= 3) scored.push({ s, e })
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, limit).map(({ e }) => ({
    term: e.term,
    kind: e.kind,
    summary: e.summary ?? '',
    facts: (e.facts ?? []).slice(0, 12),
    steps: (e.steps ?? []).slice(0, 12).map((s) => (typeof s === 'string' ? s : (s.title ?? s.body ?? ''))),
    versions: (e.versions ?? []).slice(-6).map((v) => ({ at: v.at, op: v.op, note: v.note ?? '', summary: v.summary ?? '' })),
    updatedAt: e.updatedAt ?? null,
  }))
}

/** 错误库里与「插件/注入/启动/热重载」相关的行（只取命中行，不整库带走）。 */
function pickErrorLines(text, limit = 120) {
  if (!text) return []
  const keep = /插件|plugin|注入|inject|热重载|reload|bundle|patch|启动|boot|fiber|junction|cordis|module|ESM|client\.js|webServer|schema|defineTool/
  const out = []
  const seen = new Set()
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (s.length < 12 || s.startsWith('#')) continue
    if (!keep.test(s)) continue
    const fp = s.slice(0, 90)
    if (seen.has(fp)) continue
    seen.add(fp)
    out.push(s)
    if (out.length >= limit) break
  }
  return out
}

/** 版本时间线：每生成一次整合包就记一条 {at, versions}，下次生成时就能对比出**真实**的版本变化
 *  （文档里抄来的版本号只能算「声称」，这里是自己观测到的）。存本插件自己的状态目录。 */
function historyFile() { return join(home(), 'plugin-migrator', 'history.json') }
function loadHistory() {
  const j = readJson(historyFile())
  return Array.isArray(j?.snapshots) ? j.snapshots : []
}
function saveHistory(snapshots) {
  try {
    mkdirSync(dirname(historyFile()), { recursive: true })
    writeFileSync(historyFile(), JSON.stringify({ version: 1, updatedAt: now(), snapshots: snapshots.slice(-60) }, null, 2) + '\n', 'utf8')
  } catch { /* 记不住不影响构建 */ }
}
function versionTimeline(hist, name) {
  const out = []
  let last = null
  for (const h of hist) {
    const v = h?.versions?.[name]
    if (!v || v === last) continue
    last = v
    out.push({ at: h.at, version: v })
  }
  return out
}

function readKnowledgeSources() {
  const kd = join(home(), 'docs')
  const sk = join(home(), 'skills')
  const pick = (p) => (existsSync(p) ? readText(p, 200_000) : '')
  return {
    agents: pick(join(home(), 'AGENTS.md')),
    playbook: pick(join(kd, 'agent-playbook.md')),
    errorMemory: pick(join(kd, 'error-memory.md')),
    repairSystem: pick(join(kd, 'repair-system.md')),
    devLoopSkill: pick(join(sk, 'dsh-plugin-dev-loop', 'SKILL.md')),
    bootTriageSkill: pick(join(sk, 'dsh-boot-triage', 'SKILL.md')),
    configSafeSkill: pick(join(sk, 'dsh-config-safe-write', 'SKILL.md')),
  }
}

/* ───────────────────────── Markdown 生成 ───────────────────────── */

const slugOf = (name) => String(name).replace(/^@/, '').replace(/[\\/]/g, '__')

function mdPluginCatalog(p, src) {
  const L = []
  L.push(`# ${p.name}${p.version ? '@' + p.version : ''}`)
  L.push('')
  L.push(`> ${p.description || '（package.json 未写 description）'}`)
  L.push('')
  L.push('## 1. 身份与定位')
  L.push('')
  L.push(`| 项 | 值 |`)
  L.push(`| --- | --- |`)
  L.push(`| 包名 | \`${p.name}\` |`)
  L.push(`| 版本 | \`${p.version ?? '?'}\` |`)
  L.push(`| 来源 | ${p.kind === 'local' ? '本地源码' : '远程包（npm/github）'}｜spec = \`${p.spec ?? '?'}\` |`)
  L.push(`| 源码目录 | \`${p.dir ?? '（无）'}\`${p.dirSource ? `（定位方式：${p.dirSource}）` : ''} |`)
  L.push(`| 是否进 bundles | ${p.inBundles ? '是' : '否'} |`)
  L.push(`| 是否被 disabled | ${p.disabled ? '**是**（目标机复刻后需重新启用或保持禁用）' : '否'} |`)
  L.push(`| 带 UI | ${p.hasClient ? '是' : '否'} |`)
  L.push(`| bundle patch | ${p.bundlePatch ? `\`${p.bundlePatch}\`${p.bundlePatchOk ? '' : '（**文件缺失，需修**）'}` : '**无（新版 DSH 会拒绝启动，需补）**'} |`)
  L.push(`| 规模 | ${p.fileCount} 文件 / ${Math.round((p.sizeBytes || 0) / 1024)} KB / 代码约 ${p.codeLines} 行 |`)
  L.push('')

  L.push('## 2. 全部功能')
  L.push('')
  if (p.tools.length) {
    L.push(`### 2.1 注册给 agent 的工具（${p.tools.length} 个）`)
    L.push('')
    for (const t of p.tools) L.push(`- \`${t.name}\` — ${t.description || '（无 description）'}`)
    L.push('')
  } else {
    L.push('### 2.1 注册给 agent 的工具')
    L.push('')
    L.push('无（本插件不注册宿主工具）。')
    L.push('')
  }
  if (p.routes.length) {
    L.push('### 2.2 宿主 HTTP 接口')
    L.push('')
    for (const r of p.routes) L.push(`- \`${r}\``)
    L.push('')
  }
  if (p.slots.length || p.settingsSlots.length) {
    L.push('### 2.3 UI 入口')
    L.push('')
    for (const s of p.slots) L.push(`- 槽位：\`${s}\``)
    for (const s of p.settingsSlots) L.push(`- 设置项：\`${s}\``)
    L.push('')
  }
  if (Object.keys(p.bins).length) {
    L.push('### 2.4 命令行')
    L.push('')
    for (const [k, v] of Object.entries(p.bins)) L.push(`- \`${k}\` → \`${v}\``)
    L.push('')
  }
  if (p.env.length) {
    L.push('### 2.5 读的环境变量')
    L.push('')
    for (const e of p.env) L.push(`- \`${e}\``)
    L.push('')
  }
  if (p.dataPaths.length) {
    L.push('### 2.6 落盘位置 / 数据文件')
    L.push('')
    for (const d of p.dataPaths) L.push(`- \`${d}\``)
    L.push('')
  }

  L.push('## 3. 依赖与装配')
  L.push('')
  const deps = Object.keys(p.deps ?? {})
  const peers = Object.keys(p.peerDeps ?? {})
  L.push(`- 运行时依赖：${deps.length ? deps.map((d) => '`' + d + '`').join('、') : '无'}`)
  L.push(`- peer 依赖：${peers.length ? peers.map((d) => '`' + d + '`').join('、') : '无'}`)
  L.push(`- 装配方式：${p.runsStandalone ? '运行时注入（super-injector registry），不在 package.json 的 bundles 里' : 'profile bundles + node_modules 链接'}`)
  L.push('')
  L.push('安装要点（按顺序）：')
  L.push('')
  L.push('1. 本地源码：放到目标机任意目录（建议与其它插件同根），`package.json` 保持原样。')
  L.push('2. profile 的 `package.json`：`dependencies["' + p.name + '"] = "file:<源码目录>（或 link:...）"`。')
  L.push('3. 进 bundles：若本插件不是运行时注入型，把包名加进 `dsh.profile.bundles`。')
  L.push('4. patch：' + (p.bundlePatch ? `保留 \`${p.bundlePatch}\`，并在 profile 的 \`cordis.patch.yml\` 里有一条 \`id: ${p.name.split('/').pop()}\` 的 insert/加载条目（重复 id 会启动崩溃）。` : '**本插件缺 `dsh.bundle.patch`：必须补 package.json 的 `dsh.bundle.patch` 字段 + 对应 patch 文件，否则新版 DSH 启动直接抛错。**'))
  L.push('5. 建链接：`node_modules/<包名>` → 源码目录（junction），失败用 `dev_heal_links`。')
  L.push('6. 跑一次 npm/pnpm install 让 lock 与依赖就位，然后重启 DSH。')
  L.push('')
  if (p.sourceOmitted) {
    L.push('> ⚠️ **本插件没有附源码快照**：' + p.omitReason)
    L.push('')
  }

  L.push('## 4. 搭建技巧（来自本机实践 / 记忆库 / 错误库）')
  L.push('')
  // 先按本插件特征自动命中铁律：记忆库里没有专属词条时，这里就是唯一的针对性提示
  const hits = []
  if (p.hasClient) hits.push('**client bundle 三关**：落盘字节完整 → `node --check` → factory 真调一次要拿到 `apply`。语法合法 ≠ 结构正确，错的 bundle 能装进去再打崩 boot；改完必须浏览器硬刷新。')
  if (p.kind === 'local' && !p.bundlePatchOk) hits.push('**本插件缺 `dsh.bundle.patch`**：放进 `dsh.profile.bundles` 前先补 package.json 字段 + patch 文件，否则启动直接抛 `declares no dsh.bundle`。')
  if (p.runsStandalone) hits.push('**运行时注入型**：不要写进 `dsh.profile.bundles`，由 super-injector 的 registry 恢复（否则会双挂载/找不到目录）。')
  if (p.routes.length) hits.push('**`webServer` 是最后注册的服务**：写进静态 `inject` 会让 fiber 永久 `pending (waiting for service: webServer)`，必须 `ctx.inject([...], cb)` 延迟绑定。')
  if (p.tools.length) hits.push('**每个工具必须给 `output:{schema,render}` 与正数 `timeoutMs`**：缺 output 时 fiber 直接 `[failed]`，注入器只报「host ✗」不给原因。')
  if (Object.keys(p.bins).length) hits.push('**CLI 入口在 `bin`**：目标机要保证 node 能解析；Windows 上 shebang 无效，用 `node <脚本>` 显式调用。')
  if (p.env.length) hits.push('**环境变量**：' + p.env.map((e) => '`' + e + '`').join('、') + ' 由运行环境提供，不随包走。')
  if (hits.length) {
    L.push('### · 按本插件特征自动命中（必读）')
    L.push('')
    for (const h of hits) L.push(`- ${h}`)
    L.push('')
  }
  if (p.knowledge.length) {
    for (const k of p.knowledge) {
      L.push(`### · ${k.term}${k.kind ? `（${k.kind}）` : ''}`)
      if (k.summary) L.push('', k.summary)
      if (k.facts.length) {
        L.push('', '要点：')
        for (const f of k.facts) L.push(`- ${f}`)
      }
      if (k.steps.length) {
        L.push('', '搭建/操作步骤：')
        k.steps.forEach((s, i) => L.push(`${i + 1}. ${s}`))
      }
      L.push('')
    }
  } else {
    L.push('- 记忆库里没有该插件的专属词条；通用坑见 `../TRICKS.md`。')
    L.push('')
  }
  if (p.errors.length) {
    L.push('### · 错误库命中（本机真实踩过）')
    L.push('')
    for (const e of p.errors) L.push(`- ${e}`)
    L.push('')
  }

  L.push('## 5. 版本变迁')
  L.push('')
  L.push(`- 当前版本：\`${p.version ?? '?'}\`（来源：package.json）`)
  if (p.timeline && p.timeline.length) {
    L.push('', `本机观测到的版本时间线（每次生成整合包时记录，共 ${p.timeline.length} 个观测点）：`)
    for (const t of p.timeline) L.push(`- ${String(t.at).slice(0, 16).replace('T', ' ')} → \`${t.version}\``)
    const last = p.timeline[p.timeline.length - 1]
    if (p.version && last && last.version !== p.version) L.push(`- **本次**：\`${last.version}\` → \`${p.version}\``)
  } else {
    L.push('', '本机观测：这是该插件第一次进整合包，暂无历史观测点（下次生成后这里会出现真实的变化时间线）。')
  }
  if (p.versionsSeen.length) {
    L.push('', '文档记录的版本痕迹（来源：README / CHANGELOG）：')
    for (const v of p.versionsSeen) L.push(`- \`${v.version}\`${v.note ? ' — ' + v.note : ''}${v.source && v.source !== 'README' ? `（${v.source}）` : ''}`)
  } else {
    L.push('- README/CHANGELOG 里没有版本记录段。')
  }
  if (p.changelogExcerpt) {
    L.push('', `### CHANGELOG 摘录（${p.changelog} 前 80 行）`, '', '```markdown', redact(p.changelogExcerpt), '```')
  }
  const kv = p.knowledge.filter((k) => k.versions.length)
  if (kv.length) {
    L.push('', '知识层演进（AI 记忆库里该词条的修订史，**不等于代码版本**，只说明认知怎么变的）：')
    for (const k of kv) {
      L.push(`- 「${k.term}」：`)
      for (const v of k.versions) L.push(`  - ${String(v.at).slice(0, 10)} ${v.op}${v.note ? '｜' + v.note : ''}${v.summary ? '｜' + String(v.summary).slice(0, 80) : ''}`)
    }
  }
  L.push('')

  L.push('## 6. 文件清单（头部）')
  L.push('')
  L.push('```')
  for (const f of p.files.slice(0, 60)) L.push(f)
  if (p.files.length > 60) L.push(`… 共 ${p.files.length}+ 个文件，完整快照见 packages/`)
  if (p.sourceOmitted) L.push('（本插件未附快照，原因见 §3 的提示）')
  L.push('```')
  L.push('')
  if (p.readmeExcerpt) {
    L.push('## 7. 原 README 摘录（前 90 行）')
    L.push('')
    L.push('```markdown')
    L.push(redact(p.readmeExcerpt))
    L.push('```')
    L.push('')
  }
  void src
  return L.join('\n')
}

function mdTricks(plugins, ks) {
  const L = []
  L.push('# 搭建设计与踩坑总集（TRICKS）')
  L.push('')
  L.push('这份文件只回答一个问题：**在全新机器上把这套插件装起来，哪些地方一定会崩、崩了怎么修。**')
  L.push('内容取自本机技能库、错误记忆库与 AI 记忆库，已脱敏（密钥值一律不含）。')
  L.push('')
  L.push('## 1. 铁律（跳过任何一条都会卡住）')
  L.push('')
  L.push('1. **每个进 bundles 的包必须在 package.json 里声明 `dsh.bundle.patch`，且该文件真实存在** —— DSH ≥ 0.1.2-rc.1 启动时硬校验，缺了直接抛 `profile bundle ... declares no dsh.bundle`。')
  L.push('2. **cordis.patch.yml 里同 id 只能一条** —— 重复 loader entry id 会让启动崩；手动 patch 两次是最常见成因。')
  L.push('3. **宿主工具必须给 `output:{schema,render}` 与正数 `timeoutMs`** —— 缺 output 会让 fiber 直接 `[failed]`，而注入器只报「host ✗」不给原因。')
  L.push("4. **静态 `inject` 只写启动早期就存在的服务** —— `webServer` 这类最后注册的必须用 `ctx.inject([\"webServer\"], …)` 延迟绑定，否则 fiber 永久 `pending`。")
  L.push('5. **不要在插件进程里 spawn 带 `stdio:"pipe"` 的子进程** —— 受限沙箱会 EPERM；用 `openSync` 出 fd 再 `readFileSync` 回读。')
  L.push('6. **client bundle 三关**：字节完整（读结尾）→ `node --check` → factory 真跑一次拿到 `apply`。语法合法 ≠ 结构正确，错的 bundle 能装进去然后打崩 boot。')
  L.push('7. **client 选择器不许写死哈希类名** —— 随构建变；只用稳定属性（`[data-composer-input="true"]` 之类）。')
  L.push('8. **改 client 必须浏览器硬刷新**；改 host 热重载即生效。')
  L.push('9. **同一会话里别反复 reload / 反复改工具 schema** —— 每次改动击穿前缀缓存，miss 价约为命中价 50 倍。同类改动合并成一次。')
  L.push('')
  L.push('## 2. 施工顺序（照抄）')
  L.push('')
  L.push('```')
  L.push('0) 确认目标机：Node ≥ 22、DSH 已装、目标 profile 至少启动过一次')
  L.push('1) 关掉 DSH（桌面版关窗口；CLI 版停掉 web 进程）')
  L.push('2) 解包 → 把 packages/* 里的插件源码放到目标机插件根目录')
  L.push('3) 按 manifest.json 的 plugins[].install 顺序：写 dependencies → 写 dsh.profile.bundles → 建 node_modules junction → 写 cordis.patch.yml 条目')
  L.push('4) profile 目录跑一次 pnpm/npm install（远程插件在这一步真正下载）')
  L.push('5) 填密钥（secrets.required.json 里列了字段，值不随包走）')
  L.push('6) 启动 DSH，用「启动体检」或看日志确认每个 fiber 都是 active')
  L.push('7) 逐个打开 UI 入口点一遍（见各 catalog 的 §2.3）')
  L.push('```')
  L.push('')
  L.push('## 3. 本机插件清单的共性')
  L.push('')
  const localCount = plugins.filter((p) => p.kind === 'local').length
  const remoteCount = plugins.filter((p) => p.kind === 'remote').length
  const noPatch = plugins.filter((p) => p.kind === 'local' && !p.bundlePatchOk).map((p) => p.name)
  const standalone = plugins.filter((p) => p.runsStandalone).map((p) => p.name)
  const disabled = plugins.filter((p) => p.disabled).map((p) => p.name)
  L.push(`- 共 ${plugins.length} 个插件：本地源码 ${localCount} 个、远程包 ${remoteCount} 个。`)
  L.push(`- 运行时注入型（不在 bundles、由 super-injector 恢复）：${standalone.length ? standalone.map((n) => '`' + n + '`').join('、') : '无'}。`)
  L.push(`- 当前被 disabled（复刻后默认不启用）：${disabled.length ? disabled.map((n) => '`' + n + '`').join('、') : '无'}。`)
  if (noPatch.length) L.push(`- **缺 dsh.bundle.patch，需先补**：${noPatch.map((n) => '`' + n + '`').join('、')}。`)
  L.push('')
  L.push('## 4. 错误记忆库命中（与插件/启动/注入相关）')
  L.push('')
  const errs = pickErrorLines(ks.errorMemory, 80)
  if (errs.length) for (const e of errs) L.push(`- ${redact(e)}`)
  else L.push('- （本机错误库当前无相关命中）')
  L.push('')
  L.push('## 5. 插件开发闭环（技能原文摘要）')
  L.push('')
  L.push('完整原文见 `knowledge/dsh-plugin-dev-loop.md`。摘的骨架：')
  L.push('')
  L.push('```')
  L.push('形态选择 → 纯 ESM 免编译（源码即 lib/*.js）→ host 半身（defineTool/output/timeoutMs/ctx.effect）')
  L.push('→ client 半身（window.__ModuleLoader__.load + slots + 三关校验）→ 注入(dev_inject_plugin)')
  L.push('→ 热重载(dev_reload_package) / 清路由(dev_clear_routes) → 装配(dev_install_package)')
  L.push('→ 卸载(dev_uninject_plugin) → 迁移(plugin_migrator_*)')
  L.push('```')
  L.push('')
  return L.join('\n')
}

function mdInstall(plugins, src, counts) {
  const L = []
  L.push('# 安装指南（人读版）')
  L.push('')
  L.push(`整合包生成时间：${now()}`)
  L.push(`来源机器：${src.host ?? '?'}｜profile：${src.profile}｜DSH 版本：${src.dshVersion ?? '?'}`)
  L.push(`插件数：${plugins.length}｜文档：${counts.catalog} 篇｜密钥字段：${counts.secrets}`)
  L.push('')
  L.push('## 包里有什么')
  L.push('')
  L.push('| 路径 | 内容 |')
  L.push('| --- | --- |')
  L.push('| `PROMPT.md` | **给全新 DSH 的施工提示词**，整段粘进对话框就能开工 |')
  L.push('| `INSTALL.md` | 本文件，人读的安装顺序 |')
  L.push('| `TRICKS.md` | 通用踩坑总集 + 施工顺序 |')
  L.push('| `catalog/*.md` | 每个插件一页：全部功能 / 装配 / 搭建技巧 / 版本变迁 |')
  L.push('| `knowledge/` | 本机操作纪律、开发闭环技能、错误库摘录（脱敏） |')
  L.push('| `packages/` | 本地插件源码快照（已抹密钥） |')
  L.push('| `manifest.json` | 机器可读全量清单（给脚本/agent） |')
  L.push('| `secrets.required.json` | 需要填的密钥字段（**只有字段名，没有值**） |')
  L.push('| `restore.mjs` / `恢复.bat` / `新机一键装.bat` | 自动恢复脚本（自动判定源码落盘位置） |')
  L.push('')
  L.push('## 三条路，选一条')
  L.push('')
  L.push('### A. 让 AI 干（推荐）')
  L.push('把 `PROMPT.md` 整段贴进目标机 DSH 的对话框，它会读 `manifest.json` + `catalog/` 自己装。')
  L.push('')
  L.push('### B. 一键脚本')
  L.push('Windows 双击 `新机一键装.bat`：填密钥 → 恢复 → 装远程插件 → 再恢复补 bundles。')
  L.push('')
  L.push('### C. 手工')
  L.push('照 `TRICKS.md` §2 的 7 步走，每步的验收标准如下：')
  L.push('')
  L.push('| 步骤 | 验收 |')
  L.push('| --- | --- |')
  L.push('| 写 dependencies | `node -e "console.log(require(\'./package.json\').dependencies)"` 里能看到每个包名 |')
  L.push('| 写 bundles | `dsh.profile.bundles` 数组含所有非注入型插件 |')
  L.push('| 建 junction | `node_modules/<包名>/package.json` 能读到 |')
  L.push('| 写 patch | 同 id 只有一条；`启动体检` 通过 |')
  L.push('| install | 无 ERR_MODULE_NOT_FOUND / ERESOLVE |')
  L.push('| 启动 | 日志里每个插件 fiber 为 active，无 `did not activate` |')
  L.push('')
  L.push('## 目标机最低要求')
  L.push('')
  L.push('- Node ≥ 22')
  L.push('- DSH 与来源机器同代或更新（版本差太远时，先补 `dsh.bundle.patch` 再启动）')
  L.push('- 目标 profile 至少启动过一次（否则 `profiles/<p>/package.json` 不存在，写不进去）')
  L.push('')
  return L.join('\n')
}

function mdPrompt(plugins, src, counts) {
  const names = plugins.map((p) => p.name)
  const L = []
  L.push('# 任务：把目标机复刻成这套 DSH 插件环境')
  L.push('')
  L.push('你正在一台已经装好 DSH 的机器上。下面这个整合包里，装着另一台机器上**已经跑通**的一整套插件环境：源码、装配关系、每个插件干什么、怎么搭、踩过什么坑、版本怎么变的。')
  L.push('你的任务不是"看看"，而是**把它在这台机器上装起来并验收通过**。')
  L.push('')
  L.push('## 一、先读什么（按顺序，不要跳）')
  L.push('')
  L.push('1. `manifest.json` —— 全量机器可读清单（包名/版本/来源/工具/路由/是否进 bundles/是否注入型/安装方式）。**以它为准**。')
  L.push('2. `TRICKS.md` —— 9 条铁律 + 7 步施工顺序。**先看铁律，能省掉 80% 的返工**。')
  L.push('3. `catalog/<插件>.md` —— 每个插件的全部功能（工具/接口/UI 入口）、依赖与装配要点、搭建技巧、版本变迁。')
  L.push('4. `knowledge/` —— 本机操作纪律、插件开发闭环技能、错误库摘录。')
  L.push('5. 需要恢复源码时看 `packages/`，需要自动恢复时用 `restore.mjs`（`node restore.mjs --dry-run` 先预览）。')
  L.push('')
  L.push('## 二、铁律（违反会直接崩，别试）')
  L.push('')
  L.push('- 进 `dsh.profile.bundles` 的包，`package.json` 必须有 `dsh.bundle.patch` 且文件真实存在。缺了先补，再启动。')
  L.push('- `cordis.patch.yml` 里同一个 id 只能有一条。改这个文件前先备份（`.bak-<时间戳>`）。')
  L.push('- 写 profile 的 `package.json` / `cordis.patch.yml` 前先备份；写完全局搜一遍确认没有重复 entry。')
  L.push('- 插件进程里**不要** spawn 带 `stdio:"pipe"` 的子进程（EPERM），要回读输出就用 fd。')
  L.push('- 宿主工具必须有 `output:{schema,render}` 和正数 `timeoutMs`，否则 fiber 直接 `[failed]` 且不给原因。')
  L.push('- 静态 `inject` 只写启动早期服务；`webServer` 这类用 `ctx.inject([...], cb)` 延迟绑定。')
  L.push('- 改 client 要浏览器硬刷新；改 host 热重载即可。')
  L.push('- 同一轮里别反复 reload / 反复改工具 schema（每次击穿前缀缓存，成本是命中价的 50 倍）。')
  L.push('')
  L.push('## 三、施工顺序（照这个走，每步都要验收）')
  L.push('')
  L.push('```')
  L.push('0) 体检：node -v (≥22)；确认目标 profile 已启动过一次（profiles/<p>/package.json 存在）；备份 profile 的两个配置文件')
  L.push('1) 读 manifest.json，把 plugins[] 分成三类：本地源码型 / 远程包型 / 运行时注入型')
  L.push('2) 本地源码型：packages/<pkg> 整目录复制到本机插件根目录；远程包型：只写依赖声明，等 install')
  L.push('3) 写 profiles/<p>/package.json：dependencies（本地 path 用 file:，远程用版本号）+ dsh.profile.bundles 追加包名')
  L.push('4) 给每个本地插件建 node_modules/<包名> → 源码目录 的 junction（Windows: cmd /c mklink /J）')
  L.push('5) 写 cordis.patch.yml：每个包一条 insert（id 用包名短名，去重）')
  L.push('6) profile 目录执行 pnpm install（无 pnpm 用 npm install），确认无 ERR_MODULE_NOT_FOUND')
  L.push('7) 填密钥：secrets.required.json 列出的字段，值问用户要，不要编、不要复用来源机器的值')
  L.push('8) 重启 DSH；看日志里每个插件 fiber 是否 active')
  L.push('9) 按 catalog 的 §2（全部功能）逐个点开 UI 入口、逐个调一次工具，确认能用')
  L.push('```')
  L.push('')
  L.push('## 四、出问题怎么办')
  L.push('')
  L.push('| 症状 | 处置 |')
  L.push('| --- | --- |')
  L.push('| 启动崩：`declares no dsh.bundle` | 给该包补 `dsh.bundle.patch` + patch 文件 |')
  L.push('| 启动崩：`duplicate loader entry id` | `cordis.patch.yml` 按 id 去重，保留最后一条 |')
  L.push('| fiber `pending (waiting for service: X)` | 静态 inject 里写了晚注册服务，改成 `ctx.inject([\'X\'], cb)` |')
  L.push('| fiber `[failed]` 且无原因 | 检查工具缺 `output` 或 `timeoutMs` 非正数 |')
  L.push('| UI 没出现 | client bundle 三关未过（字节完整/`node --check`/factory 返回 apply）；改完硬刷新 |')
  L.push('| `ERR_MODULE_NOT_FOUND` | junction 没建对，或 packages 没拷全 |')
  L.push('| EPERM spawn | 去掉 `stdio:"pipe"`，改 fd 回读 |')
  L.push('| 某插件装了但没生效 | 看它是否在 `dsh.profile.bundles` 里；注入型插件走 super-injector registry 而非 bundles |')
  L.push('')
  L.push('## 五、完成定义（请逐条自证）')
  L.push('')
  L.push(`1. manifest.json 里 ${plugins.length} 个插件，逐个在目标机 package.json 的 dependencies 里能找到。`)
  L.push('2. 每个本地插件 `node_modules/<包名>/package.json` 可读。')
  L.push('3. 重启后无 `did not activate` / `duplicate loader entry id` / `declares no dsh.bundle`。')
  L.push('4. 每个带 UI 的插件，其 UI 入口在目标机可见；每个注册了工具的插件，工具名出现在工具列表里。')
  L.push('5. 被 disabled 的插件保持 disabled（除非用户明确要启用）。')
  L.push('6. secrets 全部由用户提供；包里没有、日志里也不打印任何密钥值。')
  L.push('')
  L.push('## 六、这份清单（供你核对覆盖率）')
  L.push('')
  L.push('| 插件 | 版本 | 类型 | 工具数 | 有 UI | 进 bundles |')
  L.push('| --- | --- | --- | --- | --- | --- |')
  for (const p of plugins) L.push(`| \`${p.name}\` | ${p.version ?? '?'} | ${p.kind === 'local' ? (p.runsStandalone ? '注入型本地' : '本地') : '远程'} | ${p.tools.length} | ${p.hasClient ? '是' : '否'} | ${p.inBundles ? '是' : '否'} |`)
  L.push('')
  const omitted = plugins.filter((p) => p.sourceOmitted)
  if (omitted.length) {
    L.push('### 包里**没有**源码的插件（体积过大，需另行取得）')
    L.push('')
    for (const p of omitted) L.push(`- \`${p.name}\`：${p.omitReason}`)
    L.push('')
  }
  L.push(`合计 ${plugins.length} 个插件、${counts.tools} 个工具、${counts.routes} 个 HTTP 接口、${counts.catalog} 篇 catalog、${counts.secrets} 个待填密钥字段。`)
  L.push('')
  L.push('开始之前，先把 `TRICKS.md` 的九条铁律复述一遍，然后从第 0 步开始。')
  L.push('')
  void names
  void src
  return L.join('\n')
}

/* ───────────────────────── 主流程 ───────────────────────── */

/**
 * 构建全量整合包。先复用 ① 的 exportMigration 打底（它已经处理密钥抹除 / bundle 修复 /
 * restore.mjs / 一键 bat），再往里叠加 catalog / PROMPT / TRICKS / knowledge。
 */
export async function buildAllInOne(deps, { profile = 'web', outDir, includeSource = true, includeKnowledge = true, onProgress } = {}) {
  const { scanProfile, exportMigration } = deps
  const say = (msg) => { try { onProgress?.(msg) } catch { /* 进度只是提示 */ } }
  const t0 = Date.now()

  say('扫描 profile 插件…')
  const scan = scanProfile(profile)
  const picked = scan.plugins.filter((p) => !p.official)
  if (!picked.length) return { ok: false, result: `profile=${profile} 没有可打包的插件（只有官方包或空 profile）` }
  await sleep(0)

  const baseDir = resolve(outDir || join(home(), 'plugin-migrations'))
  // 超大插件（含本地模型 / 运行时）不附源码快照：7GB 的 models/ 会把 zip 撑爆，而且这些内容本来就要重装
  const HEAVY_MB = 80
  const heavy = new Set(picked.filter((p) => (p.sizeBytes || 0) > HEAVY_MB * 1024 * 1024).map((p) => p.name))
  const sourceable = picked.filter((p) => !heavy.has(p.name))
  let root
  if (includeSource && sourceable.length) {
    say(`打包 ${sourceable.length} 个插件的源码快照（复用迁移包逻辑）…`)
    const ex = exportMigration({ profile, names: sourceable.map((p) => p.name), outDir: baseDir })
    if (!ex.ok) return ex
    root = ex.root
  } else {
    root = join(baseDir, 'dsh-allinone-' + stamp())
    mkdirSync(root, { recursive: true })
  }
  if (includeSource && heavy.size) say(`跳过 ${heavy.size} 个超大插件的源码快照（>${HEAVY_MB}MB）：${[...heavy].join('、')}`)
  if (includeSource) {
    // fixBundleField 会给「快照副本」留 .bak-bundlefield-*（对副本没有还原意义），清掉免得污染包
    try { for (const f of walkFiles(root)) if (/\.bak-bundlefield-/.test(f)) rmSync(f, { force: true }) } catch { /* 清不掉也只是多两个文件 */ }
  }

  const memory = includeKnowledge ? loadMemory() : []
  const ks = includeKnowledge ? readKnowledgeSources() : { errorMemory: '' }
  const hist = loadHistory()

  const analyzed = []
  for (let i = 0; i < picked.length; i += 1) {
    const p = picked[i]
    say(`分析插件 ${i + 1}/${picked.length}：${p.name}`)
    const info = analyzePlugin(p, deps)
    if (heavy.has(p.name)) {
      info.sourceOmitted = true
      info.omitReason = `源码体积约 ${Math.round((p.sizeBytes || 0) / 1024 / 1024)} MB（多为本地模型/运行时），未附快照；目标机需按原目录 \`${p.dir ?? '?'}\` 重新取得源码，或从上游仓库/市场重装，模型目录另行下载`
    }
    if (includeKnowledge) {
      info.knowledge = pickKnowledge(memory, p.name, 4)
      const errs = pickErrorLines(ks.errorMemory, 400).filter((l) => {
        const low = l.toLowerCase()
        return keysOf(p.name).some((k) => k.length >= 5 && low.includes(k.toLowerCase()))
      })
      info.errors = errs.slice(0, 6)
    } else { info.knowledge = []; info.errors = [] }
    analyzed.push(info)
    await sleep(0)
  }

  // 本机观测到的版本时间线（不含本次，本次版本已在「当前版本」里）
  for (const info of analyzed) info.timeline = versionTimeline(hist, info.name)
  const snap = { at: now(), profile, versions: Object.fromEntries(analyzed.map((p) => [p.name, p.version ?? null]).filter(([, v]) => v)) }
  saveHistory([...hist, snap])

  say('写 catalog…')
  const catalogDir = join(root, 'catalog')
  mkdirSync(catalogDir, { recursive: true })
  for (const p of analyzed) {
    writeFileSync(join(catalogDir, slugOf(p.name) + '.md'), redact(mdPluginCatalog(p, scan)) + '\n', 'utf8')
    await sleep(0)
  }

  if (includeKnowledge) {
    say('写知识层（脱敏）…')
    const kdir = join(root, 'knowledge')
    mkdirSync(kdir, { recursive: true })
    const put = (name, text, header) => {
      if (!text) return
      writeFileSync(join(kdir, name), (header ? `<!-- ${header} -->\n` : '') + redact(text) + '\n', 'utf8')
    }
    put('AGENTS.md', ks.agents, '来源：~/.dsh/AGENTS.md（已脱敏）')
    put('agent-playbook.md', ks.playbook, '来源：~/.dsh/docs/agent-playbook.md（已脱敏）')
    put('dsh-plugin-dev-loop.md', ks.devLoopSkill, '来源：~/.dsh/skills/dsh-plugin-dev-loop/SKILL.md')
    put('dsh-boot-triage.md', ks.bootTriageSkill, '来源：~/.dsh/skills/dsh-boot-triage/SKILL.md')
    put('dsh-config-safe-write.md', ks.configSafeSkill, '来源：~/.dsh/skills/dsh-config-safe-write/SKILL.md')
    put('error-memory.plugin-relevant.md', pickErrorLines(ks.errorMemory, 200).join('\n'), '来源：~/.dsh/docs/error-memory.md 的插件相关命中行（已脱敏）')
    put('repair-system.md', ks.repairSystem, '来源：~/.dsh/docs/repair-system.md（已脱敏）')
  }

  const counts = {
    catalog: analyzed.length,
    tools: analyzed.reduce((n, p) => n + p.tools.length, 0),
    routes: analyzed.reduce((n, p) => n + p.routes.length, 0),
    secrets: 0,
  }
  const src = {
    host: process.env.COMPUTERNAME ?? null,
    platform: process.platform,
    profile,
    profileDir: scan.profileDir,
    dshVersion: scan.dshVersion,
    readyAt: now(),
  }

  say('写 PROMPT / TRICKS / INSTALL…')
  writeFileSync(join(root, 'PROMPT.md'), mdPrompt(analyzed, src, counts) + '\n', 'utf8')
  writeFileSync(join(root, 'TRICKS.md'), redact(mdTricks(analyzed, ks)) + '\n', 'utf8')
  writeFileSync(join(root, 'INSTALL.md'), mdInstall(analyzed, src, counts) + '\n', 'utf8')

  // 机器可读全量清单（agent 用；保持字段稳定）
  const baseManifest = existsSync(join(root, 'manifest.json')) ? (readJson(join(root, 'manifest.json')) || {}) : {}
  counts.secrets = Array.isArray(baseManifest.secrets) ? baseManifest.secrets.length : 0
  if (counts.secrets) writeFileSync(join(root, 'secrets.required.json'), JSON.stringify({ note: '只列字段，不含任何密钥值；值由目标机使用者提供', fields: baseManifest.secrets }, null, 2) + '\n', 'utf8')

  const all = {
    schemaVersion: 1,
    kind: 'dsh-allinone',
    generatedAt: now(),
    generator: { name: '@dsh-external/dsh-plugin-migrator', mode: 'allinone', tookMs: null },
    source: src,
    counts: { plugins: analyzed.length, ...counts },
    installOrder: analyzed
      .filter((p) => p.kind === 'local' && !p.runsStandalone).map((p) => p.name)
      .concat(analyzed.filter((p) => p.kind === 'remote').map((p) => p.name))
      .concat(analyzed.filter((p) => p.runsStandalone).map((p) => p.name)),
    plugins: analyzed.map((p) => ({
      name: p.name,
      version: p.version,
      kind: p.kind,
      description: p.description,
      spec: p.spec,
      dir: p.dir,
      dirSource: p.dirSource,
      inBundles: p.inBundles,
      disabled: p.disabled,
      hasClient: p.hasClient,
      runsStandalone: p.runsStandalone,
      bundlePatch: p.bundlePatch,
      bundlePatchOk: p.bundlePatchOk,
      deps: p.deps,
      peerDeps: p.peerDeps,
      tools: p.tools,
      routes: p.routes,
      slots: p.slots,
      settingsSlots: p.settingsSlots,
      env: p.env,
      dataPaths: p.dataPaths,
      bins: p.bins,
      files: p.files.length,
      codeLines: p.codeLines,
      catalog: 'catalog/' + slugOf(p.name) + '.md',
      sourceOmitted: Boolean(p.sourceOmitted),
      omitReason: p.omitReason ?? null,
      knowledge: p.knowledge.map((k) => k.term),
      versionsSeen: p.versionsSeen,
      versionTimeline: p.timeline ?? [],
    })),
    docs: { prompt: 'PROMPT.md', install: 'INSTALL.md', tricks: 'TRICKS.md', knowledge: includeKnowledge ? 'knowledge/' : null },
    secrets: { fields: counts.secrets, file: counts.secrets ? 'secrets.required.json' : null },
  }
  all.generator.tookMs = Date.now() - t0
  writeFileSync(join(root, 'manifest.allinone.json'), JSON.stringify(all, null, 2) + '\n', 'utf8')

  say('重新打 zip…')
  let zip = null
  let zipError = null
  try {
    const target = root + '.zip'
    if (existsSync(target)) rmSync(target, { force: true })
    const z = zipDirectory(root, target)
    zip = existsSync(target) ? target : null
    if (zip) all.zip = { path: zip, entries: z.entries, bytes: z.bytes }
    else zipError = 'zip 未落盘'
  } catch (e) {
    zipError = String(e?.message ?? e).slice(0, 200)
  }

  return {
    ok: true,
    root,
    zip,
    prompt: join(root, 'PROMPT.md'),
    count: analyzed.length,
    counts: all.counts,
    tookMs: all.generator.tookMs,
    result: [
      `已生成全量整合包：${root}`,
      `插件 ${analyzed.length} 个｜工具 ${counts.tools} 个｜HTTP 接口 ${counts.routes} 个｜待填密钥字段 ${counts.secrets} 个`,
      zip ? `压缩包：${zip}` : `压缩包：未生成${zipError ? '（' + zipError + '）' : '（可稍后手动压）'}`,
      `提示词：${join(root, 'PROMPT.md')}`,
      `人读指南：${join(root, 'INSTALL.md')}｜踩坑总集：${join(root, 'TRICKS.md')}`,
    ].join('\n'),
  }
}

/* ───────────────────────── 后台任务（面板用，避免 UI 卡住）───────────────────────── */

function jobsDir() { return join(home(), 'plugin-migrator', 'jobs') }
const jobFile = (id) => join(jobsDir(), id + '.json')

function writeJob(job) {
  try {
    mkdirSync(jobsDir(), { recursive: true })
    writeFileSync(jobFile(job.id), JSON.stringify(job, null, 2) + '\n', 'utf8')
  } catch { /* 进度落盘失败不影响构建 */ }
}

export function getJob(id) {
  if (!id) return null
  return readJson(jobFile(String(id)))
}
export function listJobs(limit = 8) {
  try {
    return readdirSync(jobsDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(join(jobsDir(), f)))
      .filter(Boolean)
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, limit)
  } catch { return [] }
}

/** 起一个后台构建任务，立刻返回 jobId；进度写 jobs/<id>.json。 */
export function startAllInOne(deps, opts = {}) {
  const id = 'ao-' + stamp() + '-' + Math.random().toString(36).slice(2, 6)
  const job = {
    id,
    status: 'running',
    profile: opts.profile || 'web',
    includeSource: opts.includeSource !== false,
    includeKnowledge: opts.includeKnowledge !== false,
    outDir: opts.outDir || null,
    startedAt: now(),
    endedAt: null,
    step: '排队…',
    steps: [],
    root: null,
    zip: null,
    prompt: null,
    result: null,
    error: null,
  }
  writeJob(job)
  void (async () => {
    try {
      const r = await buildAllInOne(deps, {
        profile: job.profile,
        outDir: job.outDir || undefined,
        includeSource: job.includeSource,
        includeKnowledge: job.includeKnowledge,
        onProgress: (msg) => {
          job.step = msg
          job.steps.push({ at: now(), msg })
          if (job.steps.length > 200) job.steps.splice(0, 60)
          writeJob(job)
        },
      })
      job.status = r.ok ? 'done' : 'error'
      job.result = r.result ?? null
      job.root = r.root ?? null
      job.zip = r.zip ?? null
      job.prompt = r.prompt ?? null
      job.counts = r.counts ?? null
      job.error = r.ok ? null : (r.result ?? '构建失败')
    } catch (e) {
      job.status = 'error'
      job.error = String(e?.stack ?? e).slice(0, 1200)
    } finally {
      job.endedAt = now()
      job.step = job.status === 'done' ? '完成' : '失败'
      writeJob(job)
    }
  })()
  return job
}

/** 把已生成的包「导出」到用户选的目录：zip + PROMPT.md（+ 顶层三份文档）各来一份。 */
export function exportAllInOne({ jobId, target }) {
  const job = getJob(jobId)
  if (!job) return { ok: false, result: '找不到任务：' + jobId }
  if (job.status !== 'done' || !job.root) return { ok: false, result: '任务还没完成（status=' + job.status + '）' }
  const dest = resolve(String(target || '').trim())
  if (!dest) return { ok: false, result: '请先选择导出目录' }
  try {
    mkdirSync(dest, { recursive: true })
  } catch (e) {
    return { ok: false, result: '导出目录不可写：' + String(e.message ?? e).slice(0, 200) }
  }
  const copied = []
  const keep = [
    [job.zip, job.zip ? basename(job.zip) : null],
    [join(job.root, 'PROMPT.md'), 'PROMPT.md'],
    [join(job.root, 'INSTALL.md'), 'INSTALL.md'],
    [join(job.root, 'TRICKS.md'), 'TRICKS.md'],
    [join(job.root, 'manifest.allinone.json'), 'manifest.allinone.json'],
  ]
  for (const [srcPath, leaf] of keep) {
    if (!srcPath || !leaf || !existsSync(srcPath)) continue
    let out = join(dest, leaf)
    if (existsSync(out)) out = join(dest, leaf.replace(/(\.[a-z0-9]+)$/i, '-' + stamp() + '$1'))
    try { copyFileSync(srcPath, out); copied.push(out) } catch { /* 单个失败继续 */ }
  }
  if (!copied.length) return { ok: false, result: '没有可导出的文件（zip 与文档都缺失）' }
  return { ok: true, dest, files: copied, result: ['已导出 ' + copied.length + ' 个文件 → ' + dest, ...copied.map((p) => '  · ' + basename(p))].join('\n') }
}

export const __internal = { extractTools, keysOf, pickKnowledge, pickErrorLines, slugOf, mdPrompt }
export { dirname, basename }
