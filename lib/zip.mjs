// 一个最小的 ZIP 读写：只做「打包 / 解包记忆」需要的那点事。
//
// 为什么自己写而不是拉个依赖：
//   这个插件一直零依赖（`package.json` 里没有 dependencies），装到别人机器上不该
//   为了一份导出多带一个包。ZIP 的 store / deflate 两种模式用 `node:zlib` 就够了。
//
// 支持范围（够用就停，不追标准全量）：
//   · 写：deflate（method 8），UTF-8 文件名
//   · 读：deflate（8）和 store（0）都认，别的模式直接报错——**不猜**
//   · 不写 zip64、不加密、不分卷。记忆包不会大到 4GB，真到那天该换格式了。

import { deflateRawSync, inflateRawSync } from 'node:zlib'

// CRC32 查表
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// DOS 时间：给个固定值没有任何好处，还是按真实时间写，解压出来时间是对的
function dosTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | (Math.floor(d.getSeconds() / 2) & 31)
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
  return { time, date }
}

// files: [{ name, data: Buffer }] → Buffer
export function zipWrite(files, now = new Date()) {
  const { time, date } = dosTime(now)
  const locals = []
  const centrals = []
  let offset = 0

  for (const f of files) {
    const name = Buffer.from(String(f.name), 'utf8')
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8')
    const comp = deflateRawSync(raw)
    const crc = crc32(raw)

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)      // version needed
    lh.writeUInt16LE(0x0800, 6)  // flags: UTF-8 name
    lh.writeUInt16LE(8, 8)       // deflate
    lh.writeUInt16LE(time, 10)
    lh.writeUInt16LE(date, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(comp.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28)
    locals.push(lh, name, comp)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)      // version made by
    ch.writeUInt16LE(20, 6)      // version needed
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(8, 10)
    ch.writeUInt16LE(time, 12)
    ch.writeUInt16LE(date, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(comp.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt16LE(0, 30)      // extra
    ch.writeUInt16LE(0, 32)      // comment
    ch.writeUInt16LE(0, 34)      // disk
    ch.writeUInt16LE(0, 36)      // internal attrs
    ch.writeUInt32LE(0, 38)      // external attrs
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)

    offset += lh.length + name.length + comp.length
  }

  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, cd, eocd])
}

// Buffer → [{ name, data }]
export function zipRead(buf) {
  // 从尾巴往回找 EOCD（22 字节 + 最多 64KB 注释，我们从不写注释，从尾巴找即可）
  let eo = -1
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eo = i; break }
  }
  if (eo < 0) throw new Error('不是 zip：找不到中央目录结尾')
  const count = buf.readUInt16LE(eo + 10)
  const cdSize = buf.readUInt32LE(eo + 12)
  const cdOff = buf.readUInt32LE(eo + 16)
  if (cdOff + cdSize > buf.length) throw new Error('zip 坏了：中央目录越界')

  const out = []
  let p = cdOff
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 坏了：中央目录条目不对')
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const rawSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const lho = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen

    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('zip 坏了：本地头不对：' + name)
    const lNameLen = buf.readUInt16LE(lho + 26)
    const lExtraLen = buf.readUInt16LE(lho + 28)
    const dataOff = lho + 30 + lNameLen + lExtraLen
    const comp = buf.subarray(dataOff, dataOff + compSize)
    if (comp.length !== compSize) throw new Error('zip 坏了：数据被截断：' + name)

    let data
    if (method === 0) data = Buffer.from(comp)
    else if (method === 8) data = inflateRawSync(comp)
    else throw new Error('这个 zip 用了不支持的模式 ' + method + '：' + name)

    if (data.length !== rawSize) throw new Error('zip 坏了：解出来长度不对：' + name)
    if (crc32(data) !== crc) throw new Error('zip 坏了：CRC 不对：' + name)
    out.push({ name, data })
  }
  return out
}
