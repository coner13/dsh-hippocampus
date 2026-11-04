// 读 DSH 的会话日志（.zstd，多帧，第一帧只有 header 一行）。
// 只读，从不写——会话日志是 DSH 的地盘，这套记忆系统只从里面「回忆」。
//
// 两个必须记住的坑（我们踩过）：
//   · 整份日志可能是**多个 zstd 帧**拼起来的，直接一次性解只能拿到第一帧；
//   · 第一帧里只有 header 那一行，事件在后面几帧里。

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

const ZSTD_MAGIC = 4247762216

function scanFrames(buf) {
  const frames = []
  let off = 0
  while (off < buf.length) {
    const start = off
    if (buf.length - off < 4 || buf.readUInt32LE(off) !== ZSTD_MAGIC) break
    off += 4
    const desc = buf.readUInt8(off); off += 1
    const fcs = desc >>> 6
    const single = (desc & 32) !== 0
    const checksum = (desc & 4) !== 0
    const dict = desc & 3
    const dictBytes = dict === 3 ? 4 : dict
    const contentBytes = fcs === 0 ? (single ? 1 : 0) : 1 << fcs
    off += (single ? 0 : 1) + dictBytes + contentBytes
    for (;;) {
      if (buf.length - off < 3) return frames
      const h = buf.readUIntLE(off, 3); off += 3
      const last = (h & 1) !== 0
      const type = (h >>> 1) & 3
      const size = h >>> 3
      if (type === 3) return frames
      off += type === 1 ? 1 : size
      if (last) break
    }
    if (checksum) off += 4
    frames.push({ start, end: off })
  }
  return frames
}

export function readSessionFile(path) {
  let buf
  try { buf = readFileSync(path) } catch { return null }
  const events = []
  const frames = scanFrames(buf)
  for (const fr of frames) {
    let text
    try { text = zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8') } catch { continue }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { events.push(JSON.parse(line)) } catch {}
    }
  }
  if (!events.length) return null
  const header = events[0] && events[0].type === 'session' ? events[0] : null
  return { header, events, mtime: statSync(path).mtimeMs }
}

// 一个工作区里所有会话（不含子会话）
export function listSessions(sessionsRoot, cwd) {
  const out = []
  let dirs = []
  try { dirs = readdirSync(sessionsRoot, { withFileTypes: true }) } catch { return out }
  const want = norm(cwd)

  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const dir = join(sessionsRoot, d.name)
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const s of entries) {
      if (!s.isDirectory()) continue
      const f = join(dir, s.name, 'session.v4.jsonl.zstd')
      if (!existsSync(f)) continue
      let size = 0
      try { size = statSync(f).size } catch { continue }
      if (size < 512) continue
      const parsed = readSessionFile(f)
      if (!parsed || !parsed.header) continue
      if (norm(parsed.header.cwd) !== want) continue
      if ((parsed.header.delegationDepth || 0) > 0) continue
      out.push({ id: parsed.header.id, path: f, mtime: parsed.mtime, header: parsed.header, events: parsed.events })
    }
  }
  out.sort((a, b) => (a.header.createdAt || a.mtime) - (b.header.createdAt || b.mtime))
  return out
}

function norm(p) {
  return String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}

export { norm as normPath }
