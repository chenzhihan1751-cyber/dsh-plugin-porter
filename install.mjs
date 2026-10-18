#!/usr/bin/env node
/**
 * Plugin Porter 一键安装器
 *
 *   node install.mjs                     # 装进默认 profile（web）
 *   node install.mjs --profile headless   # 装进指定 profile
 *   node install.mjs --dry-run            # 只看会做什么，不写盘
 *
 * 做三件事：
 *   1. 在 <profile>/node_modules 里建目录链接，指向本仓库
 *   2. 往 <profile>/package.json 的 dependencies 写 link: 依赖
 *   3. 把包名加进 dsh.profile.bundles（启动时才装配）
 *
 * 不跑 pnpm，不改主程序，不碰你的插件源码。写 package.json 前先备份。
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync,
  lstatSync, rmSync, symlinkSync, copyFileSync, readlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = '@dsh-external/dsh-plugin-migrator'
const PKG_DIR = 'dsh-plugin-migrator'
const SCOPE = '@dsh-external'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? (argv[i + 1] ?? true) : fallback
}
const dryRun = argv.includes('--dry-run')

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profilesRoot = join(dshHome, 'profiles')

if (!existsSync(profilesRoot)) {
  console.error(`✗ 找不到 DSH 的 profiles 目录：${profilesRoot}`)
  console.error('  确认 DSH 已安装过，或者用 DSH_HOME 环境变量指定位置。')
  process.exit(1)
}

const available = readdirSync(profilesRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

const profile = String(flag('profile', available.includes('web') ? 'web' : available[0] ?? 'web'))
const profileDir = join(profilesRoot, profile)

if (!existsSync(profileDir)) {
  console.error(`✗ 没有这个 profile：${profile}`)
  console.error(`  本机可用：${available.join(', ') || '（无）'}`)
  process.exit(1)
}

const pkgJsonPath = join(profileDir, 'package.json')
if (!existsSync(pkgJsonPath)) {
  console.error(`✗ 缺少 ${pkgJsonPath}，不像一个正常的 profile。`)
  process.exit(1)
}

console.log(`▶ 目标 profile: ${profile}`)
console.log(`  插件源码: ${here}`)
if (dryRun) console.log('  （--dry-run：只预览，不写任何文件）\n')

// ── 1. 目录链接 ──────────────────────────────────────────────
const scopeDir = join(profileDir, 'node_modules', SCOPE)
const linkPath = join(scopeDir, PKG_DIR)
let linkState = '已存在'

if (!existsSync(linkPath)) {
  linkState = '新建'
  if (!dryRun) {
    mkdirSync(scopeDir, { recursive: true })
    symlinkSync(here, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  }
} else {
  const st = lstatSync(linkPath)
  if (st.isSymbolicLink() || st.isDirectory()) {
    // 已指向别处 → 重建，保证指向当前这份源码
    let target = ''
    try { target = readlinkSync(linkPath) } catch { /* ignore */ }
    if (target && resolve(target) !== resolve(here)) {
      linkState = '重建（指向旧位置）'
      if (!dryRun) {
        rmSync(linkPath, { recursive: true, force: true })
        symlinkSync(here, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
      }
    }
  }
}
console.log(`  ① 目录链接: ${linkState}`)

// ── 2 & 3. package.json ─────────────────────────────────────
const raw = readFileSync(pkgJsonPath, 'utf8')
let pkg
try {
  pkg = JSON.parse(raw)
} catch (e) {
  console.error(`✗ ${pkgJsonPath} 不是合法 JSON：${e.message}`)
  process.exit(1)
}

pkg.dependencies ??= {}
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []

const wantDep = `link:${here.replace(/\\/g, '/')}`
const depChanged = pkg.dependencies[PKG] !== wantDep
const bundleChanged = !pkg.dsh.profile.bundles.includes(PKG)

if (depChanged) pkg.dependencies[PKG] = wantDep
if (bundleChanged) pkg.dsh.profile.bundles.push(PKG)

console.log(`  ② 依赖声明: ${depChanged ? '写入' : '已是当前路径'}`)
console.log(`  ③ bundles:  ${bundleChanged ? '已加入' : '已在列表中'}`)

if ((depChanged || bundleChanged) && !dryRun) {
  const bak = `${pkgJsonPath}.bak-${stamp()}`
  copyFileSync(pkgJsonPath, bak)
  writeFileSync(pkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log(`  ④ 备份: ${bak}`)
}

console.log('')
if (dryRun) {
  console.log('预览结束。去掉 --dry-run 才会真的写盘。')
} else {
  console.log(`✓ 装好了。重启 DSH 生效：关掉窗口，再双击图标。`)
  console.log(`  重启后打开 设置 → 插件迁移。`)
}

// ── helpers ────────────────────────────────────────────────
function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
