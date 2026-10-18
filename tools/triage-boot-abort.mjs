#!/usr/bin/env node
/**
 * DSH 崩溃分诊（boot-abort triage）——补上修复工具链缺的那一环。
 *
 * 背景（2026-09-12 实测）：dsh 因 profile 装配校验失败（缺 dsh.bundle）在启动阶段直接抛错退出。
 * 当时的修复链只做了「清残留 pid / 查重复模块 / 扫会话 / 重启」——**从头到尾没读崩溃原因**，
 * 而「启动装配阶段抛错」这类故障每次重启都会重抛，于是白跑两轮、4 分钟后才靠 crash-diag 归纳出来。
 *
 * 本脚本做的事（只读，绝不改文件、绝不重启）：
 *   1) 读启动器的 stderr/out 日志，抓出真正的抛错行（`Error: dsh: ...` 或首个 Error: 行）
 *   2) 跑一次 DSH 自己的 loadProfile 体检（与启动同源）——判断「下次启动是否还会挂」
 *   3) 给出结论：是不是「启动装配故障」、具**重启有没有用**、该改哪个包/哪个字段
 *
 * 用法：
 *   node triage-boot-abort.mjs [--profile web] [--dsh-home <dir>] [--launcher-dir <dsh-desktop 目录>]
 * 退出码：0 = 可以安全重启；2 = 启动装配故障（**别重启，先修**）；3 = 其它/未知（按日志人工判）
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(import.meta.url)
const args = process.argv.slice(2)
const flag = (n, d) => {
  const i = args.indexOf('--' + n)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d
}
const dshHome = resolve(flag('dsh-home', process.env.DSH_HOME || join(homedir(), '.dsh')))
const profile = flag('profile', 'web')
const launcherDir = resolve(flag('launcher-dir', process.env.DSH_LAUNCHER_DIR || ''))

const out = []
const say = (l) => out.push(l)

/** 读日志（UTF-8 容错；日志可能是 GBK，退化为 latin1 读取不抛错）。 */
function readText(p) {
  try { return readFileSync(p, 'utf8') } catch { return '' }
}

/** 找出最近一次启动尝试的 stderr/out 日志（按路径去重）。 */
function candidateLogs() {
  const byPath = new Map()
  const add = (p, tag) => {
    if (!p || !existsSync(p) || byPath.has(resolve(p))) return
    byPath.set(resolve(p), { p, tag, mtime: statSync(p).mtimeMs })
  }
  add(join(launcherDir, 'logs', 'web.err.log'), 'stderr')
  add(join(launcherDir, 'logs', 'web.out.log'), 'stdout')
  add(join(launcherDir, 'logs', 'web-test.err.log'), 'stderr(test)')
  try {
    for (const f of readdirSync(join(launcherDir, 'logs'))) {
      if (/\.log$/.test(f) && /(err|out)/i.test(f)) add(join(launcherDir, 'logs', f), 'log')
    }
  } catch { /* 无 logs 目录 */ }
  return [...byPath.values()].sort((a, b) => b.mtime - a.mtime)
}

/** 从日志里抓「真正的抛错行」——只看尾部 400 行，避免翻出几个月前的老错。 */
function extractErrors(text) {
  const lines = text.split(/\r?\n/).slice(-400)
  const hits = []
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]
    if (/^\s*(Error|TypeError|RangeError)\b/.test(l) || /\bdsh:\s/.test(l) || /^\s*throw /.test(l) || /EADDRINUSE/.test(l)) {
      hits.push({ line: l.trim(), next: (lines[i + 1] ?? '').trim() })
    }
  }
  return hits
}

/** 已知故障类型识别表（可增长；命中即给出对症处置）。 */
const KNOWN = [
  {
    id: 'bundle-no-dsh-bundle',
    re: /declares no dsh\.bundle/i,
    name: 'profile bundle 缺 dsh.bundle',
    why: 'DSH ≥ 0.1.2-rc.1 启动会校验 dsh.profile.bundles 里每个包的 dsh.bundle.patch，缺了就在装配阶段抛错退出',
    restartHelps: false,
    fix: [
      '① 定位：node "<migrator>/tools/check-profile-boot.mjs"（与启动同源，离线复现同一条错）',
      '② 修插件：插件目录加 cordis.patch.yml（- insert:\\n    - id: <短名>\\n      name: \'<包名>\'），package.json 加 "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }',
      '   装了迁移器插件的话：设置 →「插件迁移」→ 勾选该插件 → 「修复选中：dsh.bundle」',
      '③ 应急：把该包从 dsh.profile.bundles 摘掉（只留 dependencies）即可启动（插件退回运行时注入）',
      '④ 修好后**必须再跑一次体检确认通过**，再重启',
    ],
  },
  {
    id: 'bundle-patch-missing',
    re: /failed to read overlay|no such file|must be a top-level YAML array/i,
    name: 'bundle 的 patch 文件缺失/格式错',
    why: 'dsh.bundle.patch 指向的文件读不到或不是顶层 YAML 数组',
    restartHelps: false,
    fix: ['检查该包目录下 patch 文件是否存在、是否为 "- insert:" 开头的 YAML 数组'],
  },
  {
    id: 'duplicate-module',
    re: /TOOL_RUNTIME_SCHEDULER|duplicate-module|different copies of @deepseek-ai\/dsh-tools/i,
    name: 'dsh-tools 模块重复（Symbol 不匹配）',
    why: '同一进程解析到两个物理副本 → 工具调度器不可用',
    restartHelps: true,
    fix: ['备份后删掉多余物理副本（dsh-tools.bak-* / .old / -copy），删完**必须重启**才生效'],
  },
  {
    id: 'port-in-use',
    re: /EADDRINUSE|address already in use/i,
    name: '端口 3080 已被占用（重复启动）',
    why: '上一个实例还没退干净（或启动器在故障窗口里重复拉起）就再启一个 → 新进程争不到端口直接退出',
    restartHelps: false,
    fix: [
      '① 先确认 3080 的持有者：Get-NetTCPConnection -LocalPort 3080 -State Listen（拿 OwningProcess）',
      '② 确认是旧实例后再结束它，然后**只启动一次**；不要靠反复重启撞运气',
      '③ 若同时出现启动装配错误，先按那条修好再启动（否则每次都会留下一个新的 EADDRINUSE）',
    ],
  },
  {
    id: 'session-corrupt',
    re: /corrupt Zstandard|seq gap in committed region|must be followed by tool messages/i,
    name: '会话文件损坏（torn 帧 / seq gap / 悬空 tool_calls）',
    why: '会话日志结构坏掉，回放时解析失败',
    restartHelps: true,
    fix: ['跑会话自愈脚本（DSH 安装目录下的 session-repair.mjs，默认预览，--apply 才写），修完重启'],
  },
]

/** 探活：服务在跑时，日志里的抛错多为历史记录，不该判死。 */
function probeService(port = 3080, timeoutMs = 2500) {
  return new Promise((resolve) => {
    import('node:http').then(({ get }) => {
      const req = get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
        res.resume()
        resolve({ up: true, status: res.statusCode })
      })
      req.on('timeout', () => { req.destroy(); resolve({ up: false, reason: 'timeout' }) })
      req.on('error', (e) => resolve({ up: false, reason: e.code ?? String(e) }))
    }).catch(() => resolve({ up: false, reason: 'no-http' }))
  })
}

/** 端口是否真被占（有进程监听）。这是「确定性」证据，可用于阻止启动。 */
function probePortHeld(port = 3080, timeoutMs = 1200) {
  return new Promise((resolve) => {
    import('node:net').then(({ connect }) => {
      const sock = connect({ host: '127.0.0.1', port })
      const done = (held) => { try { sock.destroy() } catch { /* 忽略 */ } resolve(held) }
      sock.setTimeout(timeoutMs, () => done(false))
      sock.on('connect', () => done(true))
      sock.on('error', () => done(false))
    }).catch(() => resolve(false))
  })
}

async function main() {
  say('DSH 崩溃分诊（只读：不改文件、不重启）')
  say('  DSH_HOME = ' + dshHome)
  say('  profile  = ' + profile)
  say('  启动器目录 = ' + launcherDir)
  const svc = await probeService()
  const portHeld = svc.up ? true : await probePortHeld()
  say('  服务探活 = ' + (svc.up ? '在跑（HTTP ' + svc.status + '）' : '连不上（' + svc.reason + '）') + '   端口 3080 = ' + (portHeld ? '有进程监听' : '空闲'))
  say('')

  // 1) 抓抛错行
  const logs = candidateLogs()
  if (!logs.length) {
    say('（没找到启动日志，无法从日志取证；继续做装配体检）')
  }
  let evidence = []
  for (const l of logs.slice(0, 3)) {
    const errs = extractErrors(readText(l.p))
    for (const e of errs) evidence.push({ ...e, from: l.tag + ':' + l.p.split(/[\\/]/).pop(), mtime: l.mtime })
  }
  evidence = evidence.slice(-8)

  say('① 日志里的抛错证据（最近 ' + evidence.length + ' 条）:')
  if (!evidence.length) say('   （没有抓到 Error/throw 行）')
  for (const e of evidence) say(`   · [${e.from}] ${e.line.slice(0, 160)}`)

  const matched = []
  for (const k of KNOWN) {
    const hit = evidence.find((e) => k.re.test(e.line) || k.re.test(e.next ?? ''))
    if (hit) matched.push({ k, hit })
  }

  // 2) 装配体检（与启动同源）
  say('')
  const mod = await import(pathToFileURL(join(HERE, '..', 'check-profile-boot.mjs')).href)
  const check = await mod.checkBoot({ dshHome, profile })
  say('② 装配体检（直接调 DSH 的 loadProfile）: ' + (check.ok ? '通过' : '**不通过**'))
  for (const l of check.lines) say('   ' + l)
  for (const p of check.problems) say('   ✗ ' + p)

  // 3) 结论
  say('')
  say('=== 结论 ===')
  const bootAbort = !check.ok
  // 只有「确定性证据」才阻止启动：
  //   ① 装配体检不通过（下次启动必然重抛）② 端口真被占（再启一个只会 EADDRINUSE）
  // 日志里的历史抛错只作提示，不阻止启动（否则工具会把自己卡死）
  const blocked = bootAbort || portHeld
  if (svc.up && !bootAbort) {
    // 服务活着 + 装配体检通过 → 日志里的抛错是历史记录，不要照着它动手
    say('服务当前在跑、装配体检也通过 → 上面那些抛错是本日志里的**历史记录**（stderr 只追加不清理），不是当前故障。')
    say('若本次确实是崩溃后重启失败，请以「服务探活=连不上」时再跑本脚本得到的结论为准。')
    console.log(out.join('\n'))
    process.exit(0)
  }
  if (matched.length) {
    for (const { k, hit } of matched) {
      say(`命中已知故障：${k.name}`)
      say('  证据：' + hit.line.slice(0, 120))
      say('  原因：' + k.why)
      say('  重启有用吗：' + (k.restartHelps ? '**有**（修完需重启生效）' : '**没有** —— 直接重启只会重复抛错'))
      for (const f of k.fix) say('  ' + f)
    }
  } else if (bootAbort) {
    say('未命中已知类型，但**装配体检不通过** → 属于「启动装配阶段故障」：直接重启没用，先按体检报错修。')
  } else {
    say('装配体检通过；日志里也没命中已知抛错 → 不是启动装配故障，可按常规流程（看门狗/会话/模块）排查。')
  }
  if (blocked) {
    say('')
    say('⛔ 结论：**先修再启动**（本次不要靠重启碰运气）' + (portHeld && !svc.up ? '；另外端口 3080 有进程监听，先确认并清掉它' : ''))
  }

  console.log(out.join('\n'))
  process.exit(blocked ? 2 : ((matched.length || evidence.length) ? 3 : 0))
}

main()
