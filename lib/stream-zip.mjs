/**
 * 流式 ZIP 写入器（store 模式，UTF-8 文件名，可分卷）。
 *
 * 为什么不用系统 tar.exe / 现有 zip.mjs：
 *   · bsdtar（Windows 自带）写 zip 时按**本地代码页**存文件名、且不置 UTF-8 标志位（0x0800），
 *     换到非中文系统解包就是乱码 —— 这与「无损迁移」直接冲突。
 *   · 现有 lib/zip.mjs 是内存实现（读全文件 + Buffer.concat 整包）：十几 MB 没问题，
 *     上 GB 直接 OOM（实测：7GB 的 models 目录连 zip 都打不出来）。
 *
 * 本文件的做法：
 *   · 字节级自己写 local header / central directory / EOCD，文件名一律 UTF-8 + 置 0x0800。
 *   · 每个文件分两种读法：小文件（≤64MB）一次读进内存（一遍 IO 同时算 CRC32 + SHA-256）；
 *     大文件流式两遍（第一遍算哈希，第二遍直接写盘），内存恒定。
 *   · 分卷：单卷超过 maxVolumeBytes 就收尾开下一卷（每个卷都是**独立可解**的 zip，
 *     不是 zip 分卷格式），单文件超过一卷上限则跳过并记录（宁缺不给坏包）。
 *   · 每写一个文件就产出 manifest 条目（rel/size/crc32/sha256/mtime/volume），
 *     恢复端可以逐文件校验「无损」。
 */

import { closeSync, createReadStream, mkdirSync, openSync, readFileSync, readSync, statSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crcInit() { return -1 }
function crcUpdate(c, buf) {
  let x = c
  for (let i = 0; i < buf.length; i += 1) x = CRC_TABLE[(x ^ buf[i]) & 0xff] ^ (x >>> 8)
  return x
}
const crcFinal = (c) => (c ^ -1) >>> 0

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f)
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f)
  return { time, date }
}

const SMALL = 64 * 1024 * 1024

/** 小文件：一次读入，同时算 CRC32 / SHA-256 / size。 */
function digestBuffer(buf) {
  const sha = createHash('sha256').update(buf).digest('hex')
  return { crc: crcFinal(crcUpdate(crcInit(), buf)), sha, size: buf.length }
}

/** 大文件：流式一遍算 CRC32 / SHA-256 / size（不占内存）。 */
async function digestFile(abs) {
  const sha = createHash('sha256')
  let crc = crcInit()
  let size = 0
  for await (const chunk of createReadStream(abs)) {
    crc = crcUpdate(crc, chunk)
    sha.update(chunk)
    size += chunk.length
  }
  return { crc: crcFinal(crc), sha: sha.digest('hex'), size }
}

function localHeader({ nameBuf, crc, size, time, date }) {
  const h = Buffer.alloc(30)
  h.writeUInt32LE(0x04034b50, 0)
  h.writeUInt16LE(20, 4)      // version needed
  h.writeUInt16LE(0x0800, 6)  // flags: UTF-8 文件名
  h.writeUInt16LE(0, 8)       // method: store
  h.writeUInt16LE(time, 10)
  h.writeUInt16LE(date, 12)
  h.writeUInt32LE(crc, 14)
  h.writeUInt32LE(size, 18)
  h.writeUInt32LE(size, 22)
  h.writeUInt16LE(nameBuf.length, 26)
  h.writeUInt16LE(0, 28)
  return h
}

function centralHeader({ nameBuf, crc, size, time, date, offset }) {
  const h = Buffer.alloc(46)
  h.writeUInt32LE(0x02014b50, 0)
  h.writeUInt16LE(20, 4)      // version made by
  h.writeUInt16LE(20, 6)      // version needed
  h.writeUInt16LE(0x0800, 8)  // flags
  h.writeUInt16LE(0, 10)      // method
  h.writeUInt16LE(time, 12)
  h.writeUInt16LE(date, 14)
  h.writeUInt32LE(crc, 16)
  h.writeUInt32LE(size, 20)
  h.writeUInt32LE(size, 24)
  h.writeUInt16LE(nameBuf.length, 28)
  h.writeUInt32LE(offset, 42)
  return h
}

function eocd({ count, centralBytes, centralOffset }) {
  const h = Buffer.alloc(22)
  h.writeUInt32LE(0x06054b50, 0)
  h.writeUInt16LE(count, 8)
  h.writeUInt16LE(count, 10)
  h.writeUInt32LE(centralBytes, 12)
  h.writeUInt32LE(centralOffset, 16)
  return h
}

/**
 * 分卷打包。
 * @param {object} o
 * @param {string} o.outFile      第一卷路径（后续卷自动命名 xxx.part2.zip …）
 * @param {Array<{abs:string, rel:string, mtime?:number}>} o.entries
 * @param {number} [o.maxVolumeBytes] 单卷上限（默认 1800MB）
 * @param {(p:{done:number,total:number,rel:string,bytes:number})=>void} [o.onProgress]
 * @param {()=>boolean} [o.cancelled]
 */
export async function packEntries({ outFile, entries, maxVolumeBytes = 1800 * 1024 * 1024, onProgress, cancelled } = {}) {
  const volumes = []
  const manifest = []
  const skipped = []
  let volIndex = 0
  let fd = null
  let volBytes = 0
  let central = []
  let centralBytes = 0
  let offset = 0
  let volCount = 0
  let volFile = null
  let totalBytes = 0
  const { time, date } = dosDateTime()

  const openVolume = () => {
    volIndex += 1
    volFile = volIndex === 1
      ? outFile
      : outFile.replace(/(\.[^.]+)$/, '') + '.part' + volIndex + '.zip'
    fd = openSync(volFile, 'w')
    volBytes = 0
    offset = 0
    central = []
    centralBytes = 0
    volCount = 0
  }

  const closeVolume = () => {
    if (fd === null) return
    const centralBuf = Buffer.concat(central)
    writeSync(fd, centralBuf)
    writeSync(fd, eocd({ count: volCount, centralBytes: centralBuf.length, centralOffset: offset }))
    volBytes += centralBuf.length + 22
    closeSync(fd)
    fd = null
    volumes.push({ file: volFile, entries: volCount, bytes: volBytes })
  }

  openVolume()
  const total = entries.length
  let done = 0

  for (const e of entries) {
    if (cancelled && cancelled()) break
    let st
    try { st = statSync(e.abs) } catch { skipped.push({ rel: e.rel, reason: '读不到（可能已删除）' }); continue }
    if (!st.isFile()) continue

    // 单文件比一卷还大 → 跳过（不产出坏包）
    if (st.size > maxVolumeBytes) {
      skipped.push({ rel: e.rel, size: st.size, reason: `单文件 ${(st.size / 1048576).toFixed(0)}MB 超过单卷上限，未打包` })
      done += 1
      continue
    }

    let info
    let buf = null
    try {
      if (st.size <= SMALL) {
        buf = readFileSync(e.abs)
        info = digestBuffer(buf)
      } else {
        info = await digestFile(e.abs)
      }
    } catch (err) {
      skipped.push({ rel: e.rel, reason: '读取失败：' + String(err?.message ?? err).slice(0, 80) })
      done += 1
      continue
    }

    // 放不下就切卷（切卷前不允许把当前文件拆开）
    if (volCount > 0 && volBytes + 30 + Buffer.byteLength(e.rel) + info.size > maxVolumeBytes) {
      closeVolume()
      openVolume()
    }

    const nameBuf = Buffer.from(e.rel, 'utf8')
    const lh = localHeader({ nameBuf, crc: info.crc, size: info.size, time, date })
    writeSync(fd, lh)
    writeSync(fd, nameBuf)
    if (buf) {
      writeSync(fd, buf)
    } else {
      for await (const chunk of createReadStream(e.abs)) writeSync(fd, chunk)
    }
    const entryOffset = offset
    central.push(centralHeader({ nameBuf, crc: info.crc, size: info.size, time, date, offset: entryOffset }), nameBuf)
    centralBytes += 46 + nameBuf.length
    offset += 30 + nameBuf.length + info.size
    volBytes += 30 + nameBuf.length + info.size
    volCount += 1
    totalBytes += info.size
    manifest.push({ rel: e.rel, size: info.size, crc32: info.crc.toString(16).padStart(8, '0'), sha256: info.sha, volume: volIndex })
    done += 1
    onProgress?.({ done, total, rel: e.rel, bytes: info.size })
  }

  closeVolume()
  return {
    volumes,
    manifest,
    skipped,
    stats: { files: manifest.length, bytes: totalBytes, volumes: volumes.length, skipped: skipped.length },
  }
}

/** 解自己写的卷：顺序读 local header（store 模式），流式写回磁盘。 */
export async function unpackVolume(zipFile, destDir, { filter, onProgress } = {}) {
  const st = statSync(zipFile)
  const fd = openSync(zipFile, 'r')
  let pos = 0
  let n = 0
  const out = []
  const head = Buffer.alloc(30)
  try {
    while (pos < st.size) {
      const got = readSync(fd, head, 0, 30, pos)
      if (got < 30) break
      if (head.readUInt32LE(0) !== 0x04034b50) break // 到 central directory 了
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
      if (filter && !filter(rel)) continue
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
        writeSync(wfd, chunk, 0, g)
        cur += g
        left -= g
      }
      closeSync(wfd)
      out.push({ rel, size })
      onProgress?.({ files: n, rel })
    }
  } finally {
    closeSync(fd)
  }
  return { files: out.length, entries: out }
}
