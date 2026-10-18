/**
 * @dsh-external/dsh-plugin-migrator — 迷你 zip（无外部依赖、不调 powershell）。
 *
 * 为什么自己写：本机插件进程里 spawnSync('powershell') 会被拒（EPERM），
 * 而压缩/解压又是「把迁移包拷到另一台机器」的核心便利点。
 * 写：store 模式（不压缩，跨工具兼容最好）；读：兼容 store(0) 与 deflate(8)，
 * 所以 Windows 资源管理器 / Compress-Archive 生成的 zip 也能读。
 */

import { inflateRawSync } from 'node:zlib'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32Of(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f)
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f)
  return { time, date }
}

function collect(dir, base = dir, out = [], exclude = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (exclude.some((r) => (r.endsWith('*') ? e.name.startsWith(r.slice(0, -1)) : e.name === r))) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) collect(p, base, out, exclude)
    else if (e.isFile()) out.push({ path: p, rel: relative(base, p).split(sep).join('/') })
  }
  return out
}

/** 目录 → zip 文件（store 模式）。返回 { file, entries, bytes }。 */
export function zipDirectory(srcDir, zipFile, exclude = []) {
  const files = collect(srcDir, srcDir, [], exclude)
  const { time, date } = dosDateTime()
  const locals = []
  const central = []
  let offset = 0

  for (const f of files) {
    const data = readFileSync(f.path)
    const nameBuf = Buffer.from(f.rel, 'utf8')
    const crc = crc32Of(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)          // version needed
    lh.writeUInt16LE(0x0800, 6)      // flags: UTF-8 名称
    lh.writeUInt16LE(0, 8)           // method: store
    lh.writeUInt16LE(time, 10)
    lh.writeUInt16LE(date, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    locals.push(lh, nameBuf, data)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(0, 10)
    ch.writeUInt16LE(time, 12)
    ch.writeUInt16LE(date, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, nameBuf)
    offset += lh.length + nameBuf.length + data.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  const out = Buffer.concat([...locals, centralBuf, eocd])
  writeFileSync(zipFile, out)
  return { file: zipFile, entries: files.length, bytes: out.length }
}

/** zip → 目录（支持 store 与 deflate，含 zip64 之外的常规情形）。 */
export function unzipTo(zipFile, destDir) {
  const buf = readFileSync(zipFile)
  const eocdPos = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocdPos < 0) throw new Error('不是 zip（找不到 EOCD）：' + zipFile)
  const count = buf.readUInt16LE(eocdPos + 10)
  let p = buf.readUInt32LE(eocdPos + 16)
  let written = 0
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue
    const lhNameLen = buf.readUInt16LE(localOff + 26)
    const lhExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen
    const raw = buf.subarray(dataStart, dataStart + size)
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null
    if (!data) throw new Error('不支持的压缩方式 method=' + method + '（' + name + '）')
    const out = join(destDir, name.split('/').join(sep))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, data)
    written += 1
  }
  return { dir: destDir, entries: written }
}
