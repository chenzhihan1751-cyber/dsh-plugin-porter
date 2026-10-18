#!/usr/bin/env node
/**
 * 全量整合包 CLI（不经 DSH UI 也能跑；构建逻辑与面板/工具完全同一份）。
 *
 *   node tools/allinone-build.mjs                       # 默认 profile=web，输出到 DSH_HOME/plugin-migrations
 *   node tools/allinone-build.mjs --profile web --out "D:\包" --no-source
 *   node tools/allinone-build.mjs --no-knowledge        # 只出功能/装配/版本，不带知识层
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { scanProfile, exportMigration, secretTools } from '../lib/index.js'
import { buildAllInOne } from '../lib/allinone.js'

const argv = process.argv.slice(2)
const has = (k) => argv.includes(k)
const val = (k, d) => {
  const i = argv.indexOf(k)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }
const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')

const deps = {
  scanProfile,
  exportMigration,
  copyPluginSnapshot: secretTools.copyPluginSnapshot,
  dshHome,
  readJson,
}

const r = await buildAllInOne(deps, {
  profile: val('--profile', 'web'),
  outDir: val('--out', undefined),
  includeSource: !has('--no-source'),
  includeKnowledge: !has('--no-knowledge'),
  onProgress: (m) => console.log('· ' + m),
})
console.log('')
console.log(r.result ?? JSON.stringify(r, null, 2))
process.exit(r.ok ? 0 : 1)
