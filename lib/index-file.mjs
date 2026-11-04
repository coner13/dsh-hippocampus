// 倒排索引的落盘格式：一个文件，二进制。
//
// 为什么单独一个文件、不塞进 state.json：
//   · state.json 是给人看的（段、锚、序号），这个文件只给程序看；
//   · 它会长到几百 MB，JSON 编码/解析一次，就把「落盘省下的时间」全吃回去。
//
// 为什么用 Uint32Array + 零拷贝：
//   36 万行时倒排有 1176 万个 (docId, tf) 打点。装进 JS 数组是 1 GB 堆；
//   装成 Uint32Array 是 94 MB，而且能直接盖在 readFileSync 拿到的 Buffer 上，
//   一个字节都不用复制。
//
// 它永远是**派生**的：删掉就重算，所以格式里带 stateVer（分词/切段规则版本）。
// 规则一改，旧文件自动作废，不需要写迁移。
//
// 文件布局（全部小端）：
//   0    8   magic "HIPIDX01"
//   8    u32 格式版本
//   12   u32 stateVer（和 store.mjs 的 STATE_VERSION 对齐：分词/切段规则一变就作废）
//   16   f64 覆盖到的流字节数 streamBytes
//   24   u32 docCount（含空行占位，等于 docs.length）
//   28   u32 termCount
//   32   u32 postWords（u32 个数 = 打点数 × 2）
//   36   f64 totalLen（所有文档长度之和，算 BM25 的 avgdl 用）
//   44   u32 indexChars（前缀截断长度：调大它 tf 全变，头里别的字段一个都不动）
//   48   u32 termIdxOff
//   52   u32 blobOff
//   56   u32 blobLen
//   60   u32 postOff
//   64   u32 docLenOff
//   68   u32 保留
//   72   32B sha256(流的前 streamBytes 字节) —— 防「同长度原地改写」
//   ——— 104 起是四块数据 ———
//   词表项 termIdx：每个词 16 字节 = [strOff, strLen, postStart, postCount]（单位都是 u32 个数）
//   词面 blob：UTF-8 拼在一起
//   postings：u32 对齐的 [docId, tf, docId, tf, ...]
//   docLen：每个文档一个 u32
//
// 为什么要那个 sha256：只比「字节数 + 文档数」挡不住同长度改写（原地改一个字、
// 或者整份换成一个恰好同样大的库）。那种情况下索引会静默地和新流对不上——
// 不报错、不崩，只是回忆开始说错话。80 MB 算一遍 sha256 是 35 ms，
// 换的是「这一版索引到底是不是这条流的」。

import { openSync, readSync, closeSync, writeSync, renameSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MAGIC = 'HIPIDX01'
const FORMAT = 2        // 2：头里加了 indexChars + streamHash
const HEADER = 104

const align4 = (n) => (n + 3) & ~3

function utf8Compare(a, b) {
  // 按字节序排，稳定且与写作时的落盘顺序一致（不依赖 ICU 的本地化比较）
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  return Buffer.compare(ba, bb)
}

// 倒排的内存形态：base（从磁盘读来的只读视图）+ tail（这次新写进来的）
//
// 为什么分成两截：启动时读进来的部分不可变（零拷贝，不能 push），
// 新来的文档只往 tail 里加。同一个词两边都有时，第一次往 tail 写就把 base 那份
// 复制过来（一次性），之后 get() 只认 tail —— 读的时候没有合并成本。
export class Postings {
  constructor() {
    this.base = new Map()   // term -> Uint32Array（只读视图）
    this.tail = new Map()   // term -> number[]（可变，可能包含 base 的复制）
    this.extra = 0          // tail 里那些 base 没有的词
    this.baseWords = 0      // 落盘那部分的打点字数（算「增量占比」用）
    this.words = 0          // tail 里累计的打点字数（记着数，别每次遍历）
  }

  get size() {
    return this.base.size + this.extra
  }

  get(term) {
    const t = this.tail.get(term)
    if (t) return t
    return this.base.get(term)
  }

  has(term) {
    return this.tail.has(term) || this.base.has(term)
  }

  _fromBase(term) {
    const b = this.tail.get(term)
    if (b) return b
    const v = this.base.get(term)
    const arr = v ? Array.from(v) : []
    if (!v) this.extra += 1
    this.tail.set(term, arr)
    return arr
  }

  add(term, id, tf) {
    this._fromBase(term).push(id, tf)
    this.words += 2
  }

  reset() {
    this.base = new Map()
    this.tail = new Map()
    this.extra = 0
    this.baseWords = 0
    this.words = 0
  }

  // 这次启动以来新增了多少个 u32 打点字数
  get tailWords() {
    return this.words
  }

  // 写盘用：把 base 里没被动过的词（Uint32Array）也一起吐出来
  *allTerms() {
    const seen = new Set()
    for (const [t, arr] of this.tail) {
      seen.add(t)
      yield [t, arr]
    }
    for (const [t, v] of this.base) {
      if (!seen.has(t)) yield [t, v]
    }
  }
}

// 只读文件头（不读整份文件）。用来在扫流之前就知道「这份索引还对不对得上」。
export function readIndexHead(path) {
  let fd = null
  try {
    if (!existsSync(path)) return null
    const size = statSync(path).size
    if (size < HEADER) return null
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(HEADER)
    readSync(fd, buf, 0, HEADER, 0)
    if (buf.toString('latin1', 0, 8) !== MAGIC) return null
    const head = {
      size,
      format: buf.readUInt32LE(8),
      stateVer: buf.readUInt32LE(12),
      streamBytes: buf.readDoubleLE(16),
      docCount: buf.readUInt32LE(24),
      termCount: buf.readUInt32LE(28),
      postWords: buf.readUInt32LE(32),
      totalLen: buf.readDoubleLE(36),
      indexChars: buf.readUInt32LE(44),
      termIdxOff: buf.readUInt32LE(48),
      blobOff: buf.readUInt32LE(52),
      blobLen: buf.readUInt32LE(56),
      postOff: buf.readUInt32LE(60),
      docLenOff: buf.readUInt32LE(64),
      streamHash: buf.toString('hex', 72, 104),
    }
    return head
  } catch {
    return null
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch {} }
  }
}

function u32View(buf, off, words) {
  // 对齐才能零拷贝；小文件从 Buffer 池里来，可能不对齐 —— 那种情况复制一份。
  if ((buf.byteOffset + off) % 4 === 0) {
    return new Uint32Array(buf.buffer, buf.byteOffset + off, words)
  }
  const copy = Buffer.allocUnsafeSlow(words * 4)
  buf.copy(copy, 0, off, off + words * 4)
  return new Uint32Array(copy.buffer, 0, words)
}

// 读整份索引。head 必须是 readIndexHead 的结果（省得读两遍头）。
// 任何一处越界/对不上都返回 null —— 宁可就地重建，也不拿半个索引去回答回忆。
export function loadIndex(path, head) {
  let fd = null
  try {
    if (!head || head.format !== FORMAT) return null
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(head.size)
    readSync(fd, buf, 0, head.size, 0)

    const { docCount, termCount, postWords } = head
    if (head.termIdxOff + termCount * 16 > head.size) return null
    if (head.postOff + postWords * 4 > head.size) return null
    if (head.docLenOff + docCount * 4 > head.size) return null
    if (head.blobOff + head.blobLen > head.size) return null

    const termIdx = u32View(buf, head.termIdxOff, termCount * 4)
    const postings = u32View(buf, head.postOff, postWords)
    const docLen = u32View(buf, head.docLenOff, docCount)

    const terms = new Map()
    for (let i = 0; i < termCount; i++) {
      const so = termIdx[i * 4]
      const sl = termIdx[i * 4 + 1]
      const ps = termIdx[i * 4 + 2]
      const pc = termIdx[i * 4 + 3]
      if (so + sl > head.blobLen) return null
      if ((ps + pc) * 4 > postWords * 4) return null
      if (ps + pc > postWords) return null
      const term = buf.toString('utf8', head.blobOff + so, head.blobOff + so + sl)
      terms.set(term, postings.subarray(ps, ps + pc))
    }
    return {
      streamBytes: head.streamBytes,
      docCount,
      totalLen: head.totalLen,
      terms,
      docLen,
      postWords,
      buf,   // 视图指着它，别让 GC 提前收
    }
  } catch {
    return null
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch {} }
  }
}

// 写整份索引（先写 .tmp 再 rename：崩在中间不会留下一份半截的索引）
export function writeIndex(path, opt) {
  const { stateVer, streamBytes, docCount, totalLen, indexChars, streamHash } = opt
  const terms = opt.terms   // 可以是 Postings 实例（用 allTerms），也可以是 Map

  const entries = terms instanceof Postings ? [...terms.allTerms()] : [...terms]
  entries.sort((a, b) => utf8Compare(a[0], b[0]))

  let blobLen = 0
  let postWords = 0
  const blobs = new Array(entries.length)
  for (let i = 0; i < entries.length; i++) {
    const b = Buffer.from(entries[i][0], 'utf8')
    blobs[i] = b
    blobLen += b.length
    postWords += entries[i][1].length
  }

  const termCount = entries.length
  const termIdxOff = HEADER
  const blobOff = termIdxOff + termCount * 16
  const postOff = align4(blobOff + blobLen)
  const docLenOff = postOff + postWords * 4
  const end = docLenOff + docCount * 4

  const out = Buffer.alloc(end)
  out.write(MAGIC, 0, 'latin1')
  out.writeUInt32LE(FORMAT, 8)
  out.writeUInt32LE(stateVer, 12)
  out.writeDoubleLE(streamBytes, 16)
  out.writeUInt32LE(docCount, 24)
  out.writeUInt32LE(termCount, 28)
  out.writeUInt32LE(postWords, 32)
  out.writeDoubleLE(totalLen, 36)
  out.writeUInt32LE(indexChars || 0, 44)
  out.writeUInt32LE(termIdxOff, 48)
  out.writeUInt32LE(blobOff, 52)
  out.writeUInt32LE(blobLen, 56)
  out.writeUInt32LE(postOff, 60)
  out.writeUInt32LE(docLenOff, 64)
  out.writeUInt32LE(0, 68)
  if (streamHash) Buffer.from(String(streamHash), 'hex').copy(out, 72, 0, 32)

  const termIdx = new Uint32Array(termCount * 4)
  const postings = new Uint32Array(postWords)
  let so = 0
  let po = 0
  for (let i = 0; i < termCount; i++) {
    const blob = blobs[i]
    blob.copy(out, blobOff + so)
    const data = entries[i][1]
    termIdx[i * 4] = so
    termIdx[i * 4 + 1] = blob.length
    termIdx[i * 4 + 2] = po
    termIdx[i * 4 + 3] = data.length
    postings.set(data, po)
    so += blob.length
    po += data.length
  }
  Buffer.from(termIdx.buffer, termIdx.byteOffset, termIdx.byteLength).copy(out, termIdxOff)
  Buffer.from(postings.buffer, postings.byteOffset, postings.byteLength).copy(out, postOff)

  const docLen = new Uint32Array(docCount)
  for (let i = 0; i < docCount; i++) docLen[i] = opt.docLen[i] || 0
  Buffer.from(docLen.buffer, docLen.byteOffset, docLen.byteLength).copy(out, docLenOff)

  const tmp = path + '.tmp'
  mkdirSync(dirname(path), { recursive: true })
  const fd = openSync(tmp, 'w')
  try {
    let w = 0
    while (w < out.length) w += writeSync(fd, out, w, out.length - w)
  } finally {
    try { closeSync(fd) } catch {}
  }
  renameSync(tmp, path)
  return { bytes: out.length, termCount, postWords, docCount }
}

// 给 cli 看的
export function indexStat(path) {
  const head = readIndexHead(path)
  if (!head) return null
  return {
    bytes: head.size,
    stateVer: head.stateVer,
    streamBytes: head.streamBytes,
    docs: head.docCount,
    terms: head.termCount,
    postings: head.postWords / 2,
  }
}
