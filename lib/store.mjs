// 记忆的存储层：一条只增不改的「流」，加一份可以从流重建的索引。
//
// 为什么是「一条流」：
//   人回忆时会改写细节，但**证据不会凭空出现**。这套系统里，发生过的事只有一份原始记录
//   （stream.jsonl，只追加，永不改写）；所有摘要、标题、显著度都是**派生**的，
//   删掉重算不会丢东西。之前那套失败就失败在这里——摘要替掉了原话，
//   表情从 151 个掉到 68 个，身份跟着变淡。
//
// 为什么索引可以重建：
//   索引坏了、版本升了、想改排序——把 state.json 删掉重算就行，数据不受影响。

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
  openSync, readSync, closeSync, statSync, renameSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { termFreq, headline, tokenize, dedupeTitle, FALLBACK_TITLE } from './tokenize.mjs'
import { episodeSalience, isClosing, isTransition } from './signal.mjs'
import { similarity, invalidRecord, textHashOf } from './thoughts.mjs'
import { Postings, readIndexHead, loadIndex, writeIndex, indexStat } from './index-file.mjs'
import { diag } from './config.mjs'

// 切段规则一改就得加这个号：让旧索引作废，重新切一遍。
// 第 4 版：段带上了 sid（哪场对话），预激活才能排除「当前这场」。
// 第 5 版：分词改了（带点的数字串整体成词），旧索引里的词是切碎的，必须重算。
// 第 6 版：分词又改了（v0.2.13.6 ≡ 0.2.13.6，全角先 NFKC），
//         postings 本来就是每次启动从 stream 重算的，但旧 state 里的段还是按老词切的，
//         一起作废，省得「一半新一半旧」。
const STATE_VERSION = 6
// 标题算法的版本：段标题改成「他那句 + 段内冷词」之后，旧的段得重算一遍标题。
// 单独立一个号，是为了**只重算标题、不重切段**——切一版段，编号全变，回忆就串了。
// 第 3 版（0.2.19）：headline 的可选逗号（掉字）+ 中段围栏 + 撞名补区分符，旧标题全体作废重算。
const TITLE_VERSION = 3
// 内存里只留够检索用的前缀，全文按偏移回读
const INDEX_CHARS = 1600
// 启动时不再重算的那部分倒排：落到 index.bin（见 index-file.mjs）。
// 它覆盖到 index.streamBytes 为止，之后新写进来的行只增量建索引（tail），
// tail 涨过「落盘部分的 10%」就整份重写一次 —— 摊在时间上是 10 倍摊薄。
const INDEX_REWRITE_RATIO = 0.1
const INDEX_REWRITE_MIN = 2000

// 什么时候值得整份重写索引。**两者都要满足**（取大的那个门槛）。
// 抽成纯函数是为了能被自测直接钉住——这个判断写反过一次（`&&` 写成取 min），
// 而它的后果不在结果里、只在「写了多少次盘」里，靠读代码很难发现。
export function shouldRewriteIndex(baseWords, tailWords) {
  const need = Math.max(INDEX_REWRITE_MIN, baseWords * INDEX_REWRITE_RATIO)
  return tailWords >= need
}

// 写盘失败后该等多久再试：1s → 2s → 4s → … → 5min。
// 抽成纯函数同样是为了能被钉住：这条判据的错法（试太勤）也不会在结果里露出来，
// 只在「写了多少次盘」里——上一版整整一晚没人发现，靠的就是数 append 和 saveIndex 的次数。
export function indexBackoffMs(failCount) {
  const n = Math.max(1, Number(failCount) || 1)
  return Math.min(1000 * 2 ** (n - 1), 5 * 60 * 1000)
}

// 「我的推理」的去重键：标点/空白不算字。
// 同一段推理可能在实时捕获和回填里各来一次，正文一模一样，只是标点外的空白不同。
function thoughtKey(text) {
  return String(text || '').replace(/[\s\u200b-\u200d\ufeff，,。.!！?？：:；;、"'"'（）()]/g, '').toLowerCase()
}

// 剥掉开头的舞台描写：（本鲸……）/（顿了顿，把尾巴一拍）/ [图×3]
// 标题里最占地方的就是它——十几字的语气动作，把「这段在讲什么」挤没了。
function stripStage(s) {
  let t = String(s || '')
  for (let i = 0; i < 5; i++) {
    const nxt = t
      .replace(/^\s*（[^）]{0,90}）/g, '')
      .replace(/^\s*\([^)]{0,90}\)/g, '')
      .replace(/^\s*\[[^\]]{0,20}\]/g, '')
      .replace(/^\s*>\s*/g, '')
      .replace(/\*\*/g, '')
    if (nxt === t) break
    t = nxt
  }
  return t.trim()
}

// 「像样的一句话」：去图占位、去空白之后至少 6 个字
function good(s) {
  return String(s || '').replace(/\[图×\d+\]/g, '').replace(/\s+/g, '').length >= 6
}

export class Ledger {
  constructor(dir, opts = {}) {
    this.dir = dir
    this.meetingGapMs = opts.meetingGapMs ?? 2 * 60 * 60 * 1000
    this.maxTurnsPerEpisode = opts.maxTurnsPerEpisode ?? 14
    this.minTurnsPerEpisode = opts.minTurnsPerEpisode ?? 4
    // 一段太长了就切：回忆一次能摊开的量，大概就是几千字。
    // 光按「轮」切不够——同样 14 轮，聊天是 14 句，干活是 14 大段。
    this.maxCharsPerEpisode = opts.maxCharsPerEpisode ?? 3200

    this.streamPath = join(dir, 'stream.jsonl')
    this.statePath = join(dir, 'state.json')
    this.marksPath = join(dir, 'marks.jsonl')
    // 「我的推理」单独一张表。**不是原话**，永远不进 trace——
    // 混进 stream.jsonl 的话，trace 会把它当成「我说过的话」，那就开始撒谎了。
    this.thoughtsPath = join(dir, 'thoughts.jsonl')
    // 「用进废退」的账本：哪条我记下的东西被端出来过、什么时候。
    // 只记「被想起过」，不改 marks.jsonl 一个字——视图层要能重算，源要只增不改。
    this.usagePath = join(dir, 'usage.jsonl')
    // 序号账本单独放：它是「事实」不是缓存。
    // 混在 state.json 里的话，索引一作废、序号也跟着忘，回填就会把旧会话重倒一遍。
    this.seqsPath = join(dir, 'seqs.json')
    // 「用进废退」的账本单独放（2026-11-03，评审抓的 #22）：
    // rehearsals / lastHit 原来只存在 state.json 里，state 一重建就归零——
    // 而「哪些事被想起过、上次什么时候被想起来」是**记忆的元数据**，不该活在可重建的缓存里。
    // 这里只增不改地记「某一段被想起了一次」（记 from/to 文档区间），
    // open 时按**区间重叠最多**回填——段的切法变了、首条消息换了，也还认得出那批消息。
    this.rehearsalPath = join(dir, 'rehearsals.jsonl')

    this.docs = []            // 按行号索引
    // 倒排：base（磁盘读来的只读视图）+ tail（这次新写的）。
    // 对外仍然是「词 -> [docId, tf, docId, tf…]」，按下标取的代码一行都不用改。
    this.postings = new Postings()
    this.docLen = []
    this.totalLen = 0
    // 索引落盘：开关是为了让测试能拿到「必须全量重建」那条路做对照
    this.indexEnabled = opts.index !== false
    // 放 <库>/.cache/ 而不是库根：冻包、pack 都是「把整个库搬走」，
    // 派生缓存不该跟着一起搬（36 万行时它是 98 MB，而且删了就会重算）。
    this.indexPath = join(dir, '.cache', 'index.bin')
    this._scanEnd = 0      // 已经吃进 docs 的完整行边界（可能小于文件大小：最后一行没打换行）
    this._tailPartial = false
    this._buf = null       // 这一轮读进来的整条流（读一次，扫、补、重扫都靠它）
    this._idxBuf = null    // index.bin 的整块字节；倒排视图指着它，不能提前收
    this._idxInfo = null
    this.episodes = []
    this.marks = []
    this.thoughts = []
    this._thoughtSeen = new Set()   // 归一化正文，防同一段推理被收两遍（回填 / 重放）
    this.usage = []                 // { k, ts }：记下的东西被端出来过几次
    this._useSeen = new Map()       // k -> 上次记的时刻（进程内节流，别每轮写一行）
    this.meta = {}            // 别处要持久化的小东西（比如冻结下来的身份锚）
    this.seqs = {}            // sid -> 已收到最大的事件序号（实时收的和回填的去重）
    this._recent = new Map()  // 内容指纹 -> 时间（换插件、重开、多个实例抢写时兜底去重）
    this.bytes = 0
    this._fd = null
    this._dirty = false
    // 索引写盘失败后的退避（0.2.19）。见 saveIndex() 里那段注释：
    // 失败时 tail 不重置，尾巴只会越长越大，于是**每条新消息**都越过门槛重试一次整份重写。
    this._idxFailCount = 0
    this._idxNextAt = 0
  }

  // ——— 打开 ———
  open() {
    mkdirSync(this.dir, { recursive: true })
    if (!existsSync(this.streamPath)) writeFileSync(this.streamPath, '', 'utf8')
    this._loadMarks()
    this._loadThoughts()
    this._loadUsage()

    const onDisk = statSync(this.streamPath).size
    let state = null
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8'))
      if (raw && raw.v === STATE_VERSION) state = raw
    } catch {}

    const usable = !!state && state.streamBytes === onDisk
    if (usable) {
      this.episodes = state.episodes || []
      this.meta = state.meta || {}
    }
    // meta 跟「state 里的段落在磁盘上还对不对得上」没关系，别跟着一起丢。
    // 踩过的：只要流比上次保存时长了一点（几乎每次开会话都长），usable 就是 false，
    // 于是 meta.anchor 被当成过期数据扔掉，回头 saveState 又把空的写回去——
    // 结果是锚**每次都重算**，日志里一直显示「新算」，而设计上它该被沿用。
    if (state && state.meta) this.meta = state.meta
    this._loadSeqs(state)

    // ——— 索引：先看落盘那份还对不对得上，对得上就只扫它后面的尾巴 ———
    //
    // **五条，任一不符就整份重建**（这是判据的全部，别哪天少一条没人发现）：
    //   ① 格式版本 FORMAT（头里改结构就得作废）
    //   ② STATE_VERSION（分词/切段规则变了）
    //   ③ INDEX_CHARS（前缀截断长度变了 → tf 和 docLen 全变，而别的字段一个都不会动）
    //   ④ 覆盖的字节数 ≤ 流长度，且按这个边界数出来的文档数 == 它记的数量
    //   ⑤ 流的前 streamBytes 字节的 sha256 —— 挡「同长度原地改写」：字节数一样、
    //      文档数一样，前四条全过，而索引已经和新流对不上了（不报错、不崩，只是开始说错话）
    // 这五条缺一条，宁可从头再来——拿半个索引去回答「你记不记得」，比慢几秒糟得多。
    const head = this.indexEnabled ? readIndexHead(this.indexPath) : null
    const candidate = !!(head
      && head.stateVer === STATE_VERSION
      && head.indexChars === INDEX_CHARS
      && head.streamBytes <= onDisk)
    let reused = false
    if (candidate) {
      this._resetStream()
      const buf = this._readBuf()
      // 只比字节数和文档数挡不住「同长度原地改写」——那种情况下索引和流会静默地对不上，
      // 不报错、不崩，只是回忆开始说错话。所以头里带一段 sha256。
      const hash = createHash('sha256').update(buf.subarray(0, head.streamBytes)).digest('hex')
      if (hash === head.streamHash) {
        this._ingest(0, head.streamBytes, false)   // 只吃 docs 和偏移，不建倒排
        if (this.docs.length === head.docCount) {
          const idx = loadIndex(this.indexPath, head)
          if (idx) {
            this.postings.base = idx.terms
            this.postings.baseWords = idx.postWords
            this.docLen = Array.from(idx.docLen)
            this.totalLen = idx.totalLen
            this._idxBuf = idx.buf
            this._ingest(head.streamBytes, onDisk, true)   // 尾巴照旧增量建
            if (!this._tailPartial) {
              reused = true
              this._idxInfo = { reused: true, size: head.size, coversBytes: head.streamBytes }
            }
          }
        }
      }
    }
    if (!reused) {
      // 第一次，或者版本/字节数/文档数对不上：整份重建
      this._resetStream()
      this._ingest(0, onDisk, true)
    }
    this.bytes = this._tailPartial ? onDisk : this._scanEnd
    // 重建完顺手落盘（`bytes` 得先对，否则 saveIndex 的「和流对齐了吗」过不去）
    if (!reused) this.saveIndex()
    // 标题算法换过（0.2.17 → 0.2.18）：把已经封好的段重算一遍标题。
    // **必须放在 _ingest 之后**——它在 tracesOf 里要靠 this.docs，docs 没读进来就算
    // 出一堆「（没留下的话）」。这个错我在副本上跑一次就露了（2026-11-03 00:14），
    // 差点把 371 段的标题全写成空的再存回 state。
    // 只动 title，不动 id / from / to / rehearsals——回忆不串，用进废退的账也不丢。
    if (this.episodes.length && state && state.titleVer !== TITLE_VERSION) {
      this.retitleAll()
      this._dirty = true
      // **立刻落盘**（2026-11-03 独立复核抓的）：这里原来只 `_dirty = true`，
      // 而后面只有 `if (!usable) this.seal(true)` 会写。usable === true（上次保存之后流没长）
      // 时，重算出来的标题只活在内存里——纯读的 CLI（stats / episodes / dump / index / trace /
      // prime / anchor / arrive / audit）从头到尾不 saveState（close() 也不写），
      // 于是**每次启动都重算一遍**，「只重算一次、只写一次」那句话就不成立了。
      // 重算是幂等的（复核验过），所以这里写盘不会脏数据；但「说到的」得是真做到的。
      this.saveState()
    }
    this._warmRecent()
    if (!usable) this.seal(true)
    // 段建好之后再把「被想起过」的账贴上——重建路径上 state 里那份已经没了，
    // 这份只增不改的账就是唯一的来源。
    this._applyRehearsals()
    return this
  }

  _loadMarks() {
    this.marks = []
    try {
      const txt = readFileSync(this.marksPath, 'utf8')
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue
        try { this.marks.push(JSON.parse(line)) } catch {}
      }
    } catch {}
  }

  _loadThoughts() {
    this.thoughts = []
    this._thoughtSeen = new Set()
    this._thoughtMaxId = -1
    this._thoughtBadInvalid = 0
    this._thoughtInvalidMismatch = 0
    try {
      const txt = readFileSync(this.thoughtsPath, 'utf8')
      // 两遍：作废记录是**追加在末尾**的，所以得先把所有作废的 id 收齐，再建列表。
      const dead = new Map()          // id → 内容指纹（可能为 null，老记录没带）
      const rows = []
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue
        let r = null
        try { r = JSON.parse(line) } catch { continue }
        if (!r) continue
        if (Number.isInteger(r.id)) this._thoughtMaxId = Math.max(this._thoughtMaxId, r.id)
        if (r.kind === 'invalid') {
          // 作废记录本身写坏了（target 不是整数）：**别静默跳过**。
          // 静默跳过的后果是「那条又活过来了，而且没人报」——**静默复活**比坏行更值得报
          // （评审 2026-11-04 提的）。这里只计数 + 报一次，不因为一条坏记录把整个文件停掉。
          if (!Number.isInteger(r.target)) { this._thoughtBadInvalid += 1; continue }
          dead.set(r.target, r.hash ? String(r.hash) : null)
          continue
        }
        if (!r.text) continue
        rows.push(r)
      }
      for (const r of rows) {
        if (dead.has(r.id)) {
          const want = dead.get(r.id)
          // 带指纹的：对不上就**不许误伤**——那说明 id 指到了另一条（被人重排过）。
          // 宁可让那条活着并报一句，也不能把一条正经思考悄悄作废掉。
          if (!want || textHashOf(r.text) === want) continue   // 真作废，跳过
          this._thoughtInvalidMismatch += 1                     // 指纹不符 → 不跳过，往下走（那条留着）
        }
        this.thoughts.push(r)
        this._thoughtSeen.add(thoughtKey(r.text))
      }
      if (this._thoughtBadInvalid) {
        diag(`作废记录有 ${this._thoughtBadInvalid} 条格式坏了（target 不是整数）——那几条会**静默复活**，去 thoughts.jsonl 看看`)
      }
      if (this._thoughtInvalidMismatch) {
        diag(`作废记录有 ${this._thoughtInvalidMismatch} 条**指纹对不上**（id 指到了别的思考，多半是文件被重排过）——那几条没作废，去 thoughts.jsonl 看看`)
      }
    } catch {}
  }

  _loadUsage() {
    this.usage = []
    this._useSeen = new Map()
    try {
      const txt = readFileSync(this.usagePath, 'utf8')
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue
        let r = null
        try { r = JSON.parse(line) } catch { continue }
        if (!r || !r.k) continue
        this.usage.push({ k: String(r.k), ts: Number(r.ts) || 0 })
        const t = Number(r.ts) || 0
        if (t > (this._useSeen.get(String(r.k)) || 0)) this._useSeen.set(String(r.k), t)
      }
    } catch {}
  }

  _loadSeqs(state) {
    this.seqs = {}
    try {
      const j = JSON.parse(readFileSync(this.seqsPath, 'utf8'))
      if (j && typeof j === 'object') this.seqs = j
    } catch {}
    if (!Object.keys(this.seqs).length && state && state.seqs) this.seqs = state.seqs
  }

  _saveSeqs() {
    const tmp = this.seqsPath + '.tmp'
    try {
      // 和盘上已有的合并（每个 sid 取大的），不要整份覆盖。
      // 换文件、两个实例并行、或者一边回填一边实时写的时候，各自只知道见过的那几个 sid；
      // 直接覆盖会把别人记的序号抹掉，下一轮回填就整段重倒——这正是 seqs 单独成文件要防的事。
      let disk = {}
      try { disk = JSON.parse(readFileSync(this.seqsPath, 'utf8')) || {} } catch {}
      for (const [sid, seq] of Object.entries(this.seqs)) {
        if (typeof seq === 'number' && !(typeof disk[sid] === 'number' && disk[sid] >= seq)) disk[sid] = seq
      }
      this.seqs = disk
      writeFileSync(tmp, JSON.stringify(this.seqs), 'utf8')
      renameSync(tmp, this.seqsPath)
    } catch {}
  }

  _resetStream() {
    this.docs = []
    this.postings.reset()
    this.docLen = []
    this.totalLen = 0
    this._scanEnd = 0
    this._tailPartial = false
    // 0.2.30：seal() 的上下文缓存按文档下标走的，docs 一清空它就必须一起清——
    // 不清的话，下标还是旧的、对应的文档已经换了，那个缓存会**静默**喂错上下文。
    this._sealCtx = null
  }

  _readBuf() {
    if (!this._buf) {
      try { this._buf = readFileSync(this.streamPath) } catch { this._buf = Buffer.alloc(0) }
    }
    return this._buf
  }

  // 把 [fromBytes, toBytes) 之间的完整行吃进 docs。
  // tokenize=false 只有一种用法：这段的倒排已经从 index.bin 读进来了，只需要 docs/偏移。
  _ingest(fromBytes, toBytes, tokenize) {
    const buf = this._readBuf()
    let off = fromBytes
    this._tailPartial = false
    while (off < toBytes) {
      const nl = buf.indexOf(10, off)
      if (nl === -1 || nl >= toBytes) { this._tailPartial = true; break }
      const start = off
      const bytes = nl - start + 1
      const line = buf.subarray(start, nl).toString('utf8')
      off = nl + 1
      if (!line.trim()) { this.docs.push(null); continue }
      let d
      try { d = JSON.parse(line) } catch { this.docs.push(null); continue }
      this._indexDoc(d, start, bytes, tokenize)
    }
    this._scanEnd = off
    return off
  }

  // 拿流尾巴把「最近说过什么」预热一遍：
  // 插件重装那一刻会有两个实例并行，新实例如果从空的去重表开始，
  // 它一开库就把旧会话重倒一遍，于是同一句话进两次。
  _warmRecent() {
    const tail = Math.max(0, this.docs.length - 300)
    for (let i = tail; i < this.docs.length; i++) {
      const d = this.docs[i]
      if (!d || !d.text) continue
      if (d.who !== 'he' && d.who !== 'me') continue
      const text = d.text
      this._recent.set(`${d.who}|${d.sid || ''}|${text.length}|${text.slice(0, 48)}|${text.slice(-24)}`, Date.now())
    }
  }

  _indexDoc(d, off, bytes, tokenize = true) {
    const id = this.docs.length
    const text = String(d.text || '').slice(0, INDEX_CHARS)
    this.docs.push({
      who: d.who || null, ts: d.ts || 0, sid: d.sid || null,
      turn: d.turn ?? null, tool: d.tool || null, text, off, bytes, type: d.type || null,
    })
    let len = 0
    if (tokenize) {
      for (const [term, tf] of termFreq(text)) {
        this.postings.add(term, id, tf)
        len += tf
      }
      len = len || 1
      this.docLen[id] = len
      this.totalLen += len
    }
    return id
  }

  // 强制重建：把内存里的倒排丢掉，按流重算一遍再落盘。
  // 什么时候用：觉得索引可疑、或者手工修过流（「只增不改」被人破坏过）。
  rebuildIndex() {
    let size = 0
    try { size = statSync(this.streamPath).size } catch { size = 0 }
    this._buf = null
    this._resetStream()
    this._ingest(0, size, true)
    this.bytes = this._tailPartial ? size : this._scanEnd
    return this.saveIndex()
  }

  // 把倒排整份写到盘上（原子 rename）。写完把 tail 收进 base，别让两份一直并存。
  saveIndex() {    if (!this.indexEnabled) return null
    if (this._tailPartial) return null          // 停在半行上，写出去就和流对不齐了
    if (this._scanEnd !== this.bytes) return null
    try {
      const t = process.hrtime.bigint()
      // 头里那段 sha256 现算：append 之后 this._buf 是旧的，不能拿它算。
      //
      // **别在这里再包一层 try/catch**（2026-11-03 独立复核抓的）：读流失败也是一次失败，
      // 早先那里 `catch { return null }` —— 它不计数、不 diag、不排退避，
      // 而重写门槛只看尾巴大小、尾巴不会因为失败缩小，于是「流读不动」时
      // **之后每条消息都整份重读一次 stream 再算 sha256**（36 万行时约 84 MB/条），
      // 一句日志都没有。这正是本节要治的那个形状，只是换了入口。丢给外层 catch 即可。
      const raw = readFileSync(this.streamPath)
      const streamHash = createHash('sha256').update(raw.subarray(0, this._scanEnd)).digest('hex')
      const r = writeIndex(this.indexPath, {
        stateVer: STATE_VERSION,
        indexChars: INDEX_CHARS,
        streamHash,
        streamBytes: this._scanEnd,
        docCount: this.docs.length,
        totalLen: this.totalLen,
        docLen: this.docLen,
        terms: this.postings,
      })
      // tail → base：改成只读的 Uint32Array，下次写盘前不再碰它
      for (const [term, arr] of this.postings.tail) {
        this.postings.base.set(term, Uint32Array.from(arr))
      }
      this.postings.tail = new Map()
      this.postings.extra = 0
      this.postings.words = 0
      this.postings.baseWords = r.postWords
      this._idxBuf = null   // 旧视图还挂在 base 上，但已经是 Array.from 出来的副本了
      this._idxInfo = { wroteAt: Date.now(), ms: Number(process.hrtime.bigint() - t) / 1e6, coversBytes: this._scanEnd, ...r }
      this._idxFailCount = 0     // 写成了，退避归零
      this._idxNextAt = 0
      return r
    } catch (e) {
      this._lastIndexError = e && e.message
      // 写盘失败后的退避：1s → 2s → 4s → … → 5min，且**只在第一次失败时 diag**。
      //
      // 2026-11-02 23:37 另一库抓的：saveIndex() 失败后 tail 不重置（对，本来就不该重置——
      // 数据没落盘），可 _maybeRewriteIndex() 的判据是「尾巴够大就写」，
      // 于是尾巴只增不减，**之后每条消息都越过门槛、重试一次整份重写**。
      // 实测 105 次 append 试了 60 次。失败通常不可逆（盘满 / 没权限），重试越勤只会更慢。
      this._idxFailCount = (this._idxFailCount || 0) + 1
      const wait = indexBackoffMs(this._idxFailCount)
      this._idxNextAt = Date.now() + wait
      if (this._idxFailCount === 1) diag(`索引落盘失败（会退避重试，不刷屏）：${this._lastIndexError || e}`)
      return null
    }
  }

  // ——— 写入：只追加 ———
  //
  // opts.dedupe=false 用于**回填**：回填是一口气把几年的记录写进来，
  // 写进来的时刻全都一样，于是「十分钟内说过两遍」这种判断会误伤——
  // 同一句「晚安」隔了三天说两次，在回填里就变成「刚才说过」，被吞掉。
  // 回填本来就有 seq 去重，不需要这一层。
  append(rec, opts = {}) {
    const text = String(rec.text || '')
    if (!text) return -1

    // 只有「说的话」才去重，动手不去重。
    // 同一句工具调用重复出现，多半是真的又跑了一遍（重试、复测）——
    // 那是经历，删掉就是让记忆说谎。
    const speech = rec.who === 'he' || rec.who === 'me'
    const dedupe = opts.dedupe !== false
    const fp = speech && dedupe
      ? `${rec.who}|${rec.sid || ''}|${text.length}|${text.slice(0, 48)}|${text.slice(-24)}`
      : null
    const winMs = text.length >= 12 ? 10 * 60 * 1000 : 60 * 1000
    if (fp) {
      const at = this._recent.get(fp)
      const now = Date.now()
      if (at && now - at < winMs) return -1
    }

    const d = {
      ts: rec.ts || Date.now(),
      who: rec.who || null,
      sid: rec.sid || null,
      turn: rec.turn ?? null,
      text,
      tool: rec.tool || null,
      type: rec.type || null,
    }
    const line = JSON.stringify(d)
    const bytes = Buffer.byteLength(line, 'utf8') + 1

    // 别的会话可能也在写同一个流：发现对不上就对齐。
    // 尾巴上压着半行（上次写到一半崩了）也得先对齐——不然这一行会被粘到半行后面。
    let onDisk = 0
    try { onDisk = statSync(this.streamPath).size } catch {}
    if (onDisk !== this.bytes || this._tailPartial) this._resync(onDisk)
    // 0.2.32（2026-11-04 用户问「还有什么重大 bug」时挖出来的）：
    // **对齐之后如果尾巴上还压着半行，必须先把这半行「封口」，再写。**
    //
    // 以前 `_resync` 把 bytes 设成文件末尾（含半行），而 appendFileSync 也写在末尾——
    // 于是新记录直接粘在半行后面，两个一起变成一条坏 JSON，**两条都永久丢了**：
    //   ...{"who":"he","text":"写到一半就{"ts":...,"text":"新写的"}
    // 注释一直写着「得先对齐」，代码里没做。
    //
    // 封口 = 补一个换行。不截断那半行，因为它可能不是我们的（别的窗口正在写），
    // 截了会毁别人的字节；补换行只是把它变成一条完整但解析失败的记录，
    // ingest 会把它记成 null 文档（本来就这么处理坏行），偏移也算得对。
    if (this._tailPartial) {
      try {
        appendFileSync(this.streamPath, '\n', 'utf8')
        this._resync(statSync(this.streamPath).size)
      } catch {}
    }

    const off = this.bytes
    appendFileSync(this.streamPath, line + '\n', 'utf8')
    this.bytes += bytes
    this._scanEnd = off + bytes   // 完整行：吃进 docs 的边界跟着走
    const id = this._indexDoc(d, off, bytes)
    // 记「写进来的时刻」，不是事件本身的时刻。
    // 用事件时间会失效：重装时回填的旧事件，时间戳是几小时前的，
    // 一比较就永远「不算重复」。
    if (fp) this._recent.set(fp, Date.now())
    if (this._recent.size > 4000) {
      const cut = Date.now() - 10 * 60 * 1000
      for (const [k, v] of this._recent) if (v < cut) this._recent.delete(k)
      if (this._recent.size > 6000) this._recent.clear()
    }
    this._dirty = true
    this._maybeRewriteIndex()
    return id
  }

  // 别的会话（或回填）也在往同一个流里写：对齐。
  //
  // 只增不改的前提下，前缀不用重读 —— 接尾巴就行，而且旧段的下标也不会动
  // （文档只往后加，前面的 id 不变）。文件变短或者上次停在半行上，才整份重来。
  _resync(onDisk) {
    let size = onDisk
    if (typeof size !== 'number') {
      try { size = statSync(this.streamPath).size } catch { size = 0 }
    }
    const full = size < this._scanEnd || this._tailPartial
    this._buf = null   // 文件长了，缓存的那份不完整
    if (full) {
      this._resetStream()
      this._ingest(0, size, true)
      this.episodes = []
    } else {
      this._ingest(this._scanEnd, size, true)
    }
    this.bytes = this._tailPartial ? size : this._scanEnd
    this._warmRecent()
    this.seal(true)
    this._maybeRewriteIndex()
  }

  // 攒够增量就重写一次索引。阈值是「**两者都要**」：尾巴 ≥ 2000 个打点字数，
  // 且 ≥ 落盘部分的 10%（取大的那个）——
  // 意思是：启动时最多只需要补算十分钟的量，其余全是读现成的。
  //
  // 2026-11-02 23:25 重启后抓到写反的：原来是 `&&`，等价于取 min(2000, 10%)，
  // 于是**10% 永远不起作用**，几千条记录的库也是每 2000 字就整份重写一次。
  // 实测（2000 条的库，base=108000 字）：300 次 append 触发 **7 次**整份重写，
  // 第一次在第 42 条——按意图应该是每 ~240 条一次。
  // 大库上这是灾难：36 万行时索引 98 MB、流 84 MB，每几十条消息就重写+全量算一次 sha256。
  _maybeRewriteIndex() {
    if (!this.indexEnabled) return
    // 刚写失败过就别急着再来一次：尾巴不会因为重试而缩小，
    // 盘满 / 没权限这两种失败重试一千次也一样（0.2.19）。
    if (Date.now() < (this._idxNextAt || 0)) return
    if (!shouldRewriteIndex(this.postings.baseWords, this.postings.tailWords)) return
    this.saveIndex()
  }

  // ——— 全文回读（索引里只留前缀）———
  fullText(id) {
    const d = this.docs[id]
    if (!d) return ''
    if (d.text.length < INDEX_CHARS) return d.text
    try {
      if (this._fd === null) this._fd = openSync(this.streamPath, 'r')
      const buf = Buffer.alloc(d.bytes)
      readSync(this._fd, buf, 0, d.bytes, d.off)
      const rec = JSON.parse(buf.toString('utf8'))
      return String(rec.text || '')
    } catch { return d.text }
  }

  // ——— 切段 ———
  // 只重算尾巴：已经封好的段不动。否则每次醒来编号全变，回忆就串了。
  seal(saveNow = false) {
    const rescanFrom = this.episodes.length ? this.episodes[this.episodes.length - 1].from : 0
    const kept = this.episodes.slice(0, Math.max(0, this.episodes.length - 1))

    const tail = []
    let cur = null
    let prevTs = 0
    let prevUserToks = null

    // 0.2.30（#26）：**重扫尾部时要把切段上下文接上。**
    //
    // 以前这两个值从 0 / null 起，可它们决定两条切段判据：
    //   · prevTs     → 见面间隔（newMeeting），隔了 2 小时才切
    //   · prevUserToks → 话题漂移（drift），他这句和上一句几乎没共同字才切
    // 于是**同一批文档**，「增量封段」和「全量重建」会切得不一样——
    // 表现就是删掉 state 重建后段数 377→378、后面整排 from/to 挪位（#26）。
    // 实测那一处：doc 5238「重启了…」，重建路径拿 5196 的「人话」当上一句，
    // drift 比 0.000 → 切；增量路径从 5197 起扫，prevUserToks 是 null → 不切。
    //
    // 接法：把「扫到 rescanFrom 之前为止」的上下文算出来，喂给重扫。
    // **不能只往回找最近一条**：prevTs 正向用的是 Math.max，而时间戳可能倒序
    // （补写的旧记录），取最近一条会漏掉更大的。所以这里是精确复现，不是近似。
    //
    // 性能：seal() 每个 turn 都跑，不能每回都 O(n)。所以上下文按 upto 缓存，
    // 每次只补扫「上次扫到哪 → 这次 rescanFrom」这一小段，摊下来是 O(总量)。
    // （这正是 10-31 那个「越用越卡」的同一个形状：别每回都从头扫一遍。）
    const ctx = this._sealCtx || (this._sealCtx = { upto: 0, ts: 0, toks: null })
    if (ctx.upto > rescanFrom) { ctx.upto = 0; ctx.ts = 0; ctx.toks = null }   // 安全阀：段只会往后长
    for (let i = ctx.upto; i < rescanFrom; i++) {
      const d = this.docs[i]
      if (!d || (d.who !== 'he' && d.who !== 'me')) continue
      if (d.ts > ctx.ts) ctx.ts = d.ts
      if (d.who === 'he' && d.text.length >= 2) ctx.toks = new Set(tokenize(d.text))
    }
    ctx.upto = rescanFrom
    prevTs = ctx.ts
    prevUserToks = ctx.toks

    const closeCur = () => {
      // 一轮也算一段。以前卡在 2 轮，于是「最后他问了一句、我还没回」这种
      // 正好在最边上的内容，流里有、却既不能被回忆也不能被预激活——
      // 而那恰恰是最该记得住的一句。
      if (cur && cur.turns >= 1) tail.push(cur)
      cur = null
    }

    for (let i = rescanFrom; i < this.docs.length; i++) {
      const d = this.docs[i]
      if (!d) continue
      if (d.who !== 'he' && d.who !== 'me') continue

      const gap = prevTs ? d.ts - prevTs : 0
      const newMeeting = prevTs > 0 && gap > this.meetingGapMs
      // 换了一场对话 = 换了一次见面。哪怕只隔了十秒。
      const newSession = !!(cur && cur.sid && d.sid && cur.sid !== d.sid)
      const closed = d.who === 'he' && isClosing(d.text)
      const shift = d.who === 'he' && isTransition(d.text)

      // 换了个话题：他这句和前一句说的几乎是两批字
      let drift = false
      if (d.who === 'he' && d.text.length >= 8 && prevUserToks && cur && cur.turns >= this.minTurnsPerEpisode) {
        const toks = new Set(tokenize(d.text))
        let inter = 0
        for (const t of toks) if (prevUserToks.has(t)) inter += 1
        const ratio = inter / Math.max(1, Math.min(toks.size, prevUserToks.size))
        if (ratio < 0.05) drift = true
      }
      if (d.who === 'he' && d.text.length >= 2) prevUserToks = new Set(tokenize(d.text))

      let cut = false
      if (!cur) cut = true
      else if (newSession) cut = true
      else if (newMeeting) cut = true
      else if (closed && cur.turns >= 3) cut = true
      else if (shift && cur.turns >= this.minTurnsPerEpisode) cut = true
      else if (drift) cut = true
      else if (cur.turns >= this.maxTurnsPerEpisode) cut = true
      else if ((cur.chars || 0) + d.text.length > this.maxCharsPerEpisode) cut = true

      if (cut) {
        closeCur()
        cur = { from: i, to: i, kind: 'episode', startTs: d.ts, endTs: d.ts, turns: 0, chars: 0, sid: d.sid || null, newMeeting }
      }
      if (!cur.sid && d.sid) cur.sid = d.sid
      cur.to = i
      cur.endTs = d.ts
      cur.turns += 1
      cur.chars = (cur.chars || 0) + d.text.length
      // 时间戳可能倒序（补写的旧记录），别让 prevTs 往回跳，否则下一次间隔算成负数
      prevTs = Math.max(prevTs, d.ts)
    }
    closeCur()

    // 只有尾巴那几段要重算统计；已经封好的段原样留下，只重新编号。
    // （以前是把所有段都 _annotate 一遍，每次 turn/end 都要把整条线的原文再扫一次，
    //   会话一长就越来越慢——这是那种平时看不出来、越用越卡的 bug。）
    const annotated = tail.map((e) => this._annotate(e))
    this.episodes = kept.concat(annotated).map((e, i) => (e.id === i ? e : { ...e, id: i }))
    // 撞名的标题补区分符。放在「重新编号之后」，这样退回 `（#id）` 时 id 已经是最终的那个。
    this._dedupeTitles()
    if (saveNow || this._dirty) this.saveState()
    return this.episodes.length
  }

  _annotate(ep) {
    const traces = this.tracesOf(ep)
    const { emotion, salience, turns } = episodeSalience(traces)
    return {
      ...ep,
      from: ep.from,
      to: ep.to,
      kind: 'episode',
      startTs: ep.startTs,
      endTs: ep.endTs,
      newMeeting: !!ep.newMeeting,
      sid: ep.sid || (this.docs[ep.from] && this.docs[ep.from].sid) || null,
      chars: ep.chars || 0,
      title: this._titleOf(traces),
      turns: turns || ep.turns || 0,
      salience: Math.max(salience || 0, ep.salience || 0),
      emotion: Math.max(emotion || 0, ep.emotion || 0),
      rehearsals: ep.rehearsals || 0,
      // 0.2.29（#9）：weakHits 和 rehearsals 分开记。weak 是「只是字面上最像」，
      // 不是「想起来」——合在一个数里，一次「像」就被算成一次「想起来」，越像越靠。
      // 这是「什么算想起来」的落地：strong 才算，weak 只算碰到过。
      weakHits: ep.weakHits || 0,
      lastHit: ep.lastHit || 0,
    }
  }

  // 这段的标题：**让人一眼看出「这段干了什么」**。
  //
  // 2026-11-03 用户自己撞出来的：16:45 那段里明明写着「五、现在，三道题」，
  // 标题却是「你的语气和文字结构和以前差了许多欤」（= 他说的第一句像样的话）。
  // 标题看不出内容，**「按段浏览」这条路就废了**——模型想「扫一眼今天聊了什么」，
  // 看到的全是语气话和描写（每条发言都以「（本鲸……）」开头）。
  //
  // 所以按「信号强度」依次找：
  //   ① 段里的小标题行（`五、现在，三道题` / `第一题：…` / `## …`）—— 最强，人写的时候就是当标题用的
  //   ② 他说的第一句像样的话（先剥掉开头的舞台描写）
  //   ③ 这段第一条发言
  // 试过按 tf-idf 挑「冷词」拼进标题：中文分词切的是二元组，挑出来是
  // 「本本 小本 八点」「气重 能拍 传话」这种碎片，全是噪声，撤了。
  _titleOf(traces) {
    // `#{1,6}` 后面**必须有空白**（2026-11-03 评审抓的）：C 代码里的 `#include <stdio.h>`
    // 也带 `#`，被当成 markdown 标题之后，标题就成了一行代码；
    // 而「最近这些事」那个目录**只能靠标题扫**，一行代码摆进去等于那一行作废。
    const HEADING = [
      /^\s*#{1,6}\s+([^\n]{2,28})/m,                         // ### 五、现在，三道题
      /^\s*([一二三四五六七八九十]+、[^\n]{2,26})/m,          // 五、现在，三道题
      /^\s*(第[一二三四五六七八九十]+[题步条][：:、]?[^\n]{2,24})/m,
    ]
    const usable = (s) => {
      const t = String(s || '').trim()
      if (!good(t)) return false
      if (/^```/.test(t) || /^-{3,}/.test(t) || /^[>*\s]+$/.test(t)) return false   // 代码围栏 / 分隔线 / 落单符号
      if (/^[（(]/.test(t)) return false                                            // 还是舞台描写
      if (!/[\u4e00-\u9fa5A-Za-z]/.test(t)) return false
      return true
    }
    // 统一出口：先剥描写 → 再切句 → **再剥一次**（切句之后可能又落到一句以「（…）」开头的）
    const finish = (s) => {
      const t = stripStage(headline(stripStage(String(s || '')), 28))
      return usable(t) ? t : ''
    }
    for (const t of traces) {
      for (const re of HEADING) {
        const m = String(t.text || '').match(re)
        if (m) { const out = finish(m[1]); if (out) return out }
      }
    }
    for (const t of traces) {
      if (t.who !== 'he') continue
      const out = finish(t.text)
      if (out) return out
    }
    for (const t of traces) {
      const out = finish(t.text)
      if (out) return out
    }
    return '（这一段没留下能读的话）'
  }

  // 全部段重新算一遍标题（只动 title，不动 rehearsals/lastHit，
  // 也不重切段——所以「用进废退」的账不会因为这个丢）。
  retitleAll() {
    this.episodes = this.episodes.map((e) => this._annotate(e))
    this._dedupeTitles()
    return this.episodes.length
  }

  // 撞名的标题补一个区分符，只补在**后面**那些段上（先到的先占名字）。
  //
  // 为什么：2026-11-03 评审数出的 9 段重复，全是「🔍 破案现场：」/「💣 破案现场：」。
  // 「最近这些事」那个目录**只靠标题扫**，9 行一模一样的字 = 那 9 行全废。
  // 区分符的取法见 `titleSuffix()`：段里第一个引号里的话 / 文件名 / 英文标识，再不行退回时刻。
  _dedupeTitles(list = this.episodes) {
    const taken = new Set()
    for (const e of list) {
      if (!e) continue
      // 兜底标题不补区分符：它本来就表示「这段没内容」，补个时间戳等于假装读出来了
      if (typeof e.title === 'string' && taken.has(e.title) && !FALLBACK_TITLE.test(e.title)) {
        // 12 条而不是 6 条（独立复核 2026-11-03）：标识只出现在第 7 条时，取 6 条就抽不到，
        // 区分符只能退回时刻——能区分，但白丢了一次更好的信息。只有撞名的段才会走到这里，成本可忽略。
        const body = this.tracesOf(e, 12).map((t) => t.text).join('\n')
        e.title = dedupeTitle(e.title, taken, body, e.startTs, e.id)
      }
      taken.add(e.title)
    }
    return list
  }

  tracesOf(ep, limit = Infinity) {
    const out = []
    for (let i = ep.from; i <= ep.to && out.length < limit; i++) {
      const d = this.docs[i]
      if (!d) continue
      if (d.who !== 'he' && d.who !== 'me') continue
      out.push({ id: i, who: d.who, ts: d.ts, text: d.text })
    }
    return out
  }

  episodeAt(docId) {
    for (let i = this.episodes.length - 1; i >= 0; i--) {
      const e = this.episodes[i]
      if (docId >= e.from && docId <= e.to) return e
    }
    return null
  }

  // ——— 显式记下 ———
  mark({ key, text, weight = 1 }) {
    const rec = { ts: Date.now(), key: key || null, text: String(text || ''), weight }
    appendFileSync(this.marksPath, JSON.stringify(rec) + '\n', 'utf8')
    this.marks.push(rec)
    this.saveState()
    return rec
  }

  // 同一个 key 只认最新的（旧的留着，标成被取代——像人改主意，但旧的那句话还在）。
  // 被取代的**整条记录**留在 mergedFrom 里：只记一句话的话，
  // 「什么时候被谁盖的」就查不到了（评审 2026-11-02 判据：合并得有据可查）。
  facts() {
    const byKey = new Map()
    const loose = []
    for (const m of this.marks) {
      if (!m.key) { loose.push(m); continue }
      const prev = byKey.get(m.key)
      const merged = prev
        ? [...(prev.mergedFrom || []), { key: prev.key, ts: prev.ts, text: prev.text }]
        : []
      byKey.set(m.key, { ...m, supersedes: prev ? prev.text : null, mergedFrom: merged })
    }
    return [...byKey.values(), ...loose]
  }

  // ——— 我的推理（决定 / 教训 / 线头 / 预测）———
  //
  // 三条上限，写在写入这一层，不靠调用方自觉：
  //   · 同一句话只收一次；
  //   · 一个会话最多 5 条（「按是否改变过行为取舍」的粗版）；
  //   · layer 永远是 inference——它不是原话，trace 不许查它。
  addThought(t, { perSession = 5 } = {}) {
    if (!t || !t.text || !t.kind) return null
    const key = thoughtKey(t.text)
    if (!key || this._thoughtSeen.has(key)) return null
    const sid = (t.src && t.src.sid) || null
    if (sid) {
      const n = this.thoughts.filter((x) => x.src && x.src.sid === sid).length
      if (n >= perSession) return null
    }
    const rec = {
      id: ++this._thoughtMaxId,
      ts: Number(t.ts) || Date.now(),
      kind: String(t.kind),
      text: String(t.text),
      why: t.why ? String(t.why) : null,
      keys: Array.isArray(t.keys) ? t.keys.slice(0, 8) : [],
      src: t.src || null,
      layer: 'inference',
    }
    try { appendFileSync(this.thoughtsPath, JSON.stringify(rec) + '\n', 'utf8') } catch { return null }
    this.thoughts.push(rec)
    this._thoughtSeen.add(key)
    return rec
  }

  // 作废一条思考：**不删行**，往同一个文件追加一条作废记录。
  // 只增不改是这套系统的底线（回滚、重算、审计都靠它）——
  // 删一行就是「把错过一次这件事也删了」。
  invalidateThought(id, reason = '') {
    const n = Number(id)
    const hit = this.thoughts.find((t) => t.id === n)
    if (!hit) return null                      // 没有这条（或已经作废）→ 什么都不做，幂等
    // 带上内容指纹：将来文件被重排、id 指到别人身上时，读的时候能报「指错了」而不是悄悄作废
    const rec = invalidRecord(n, reason, textHashOf(hit.text))
    if (!rec) return null
    try { appendFileSync(this.thoughtsPath, JSON.stringify(rec) + '\n', 'utf8') } catch { return null }
    this.thoughts = this.thoughts.filter((t) => t.id !== n)
    this._thoughtSeen.delete(thoughtKey(hit.text))
    return rec
  }

  // 「我的推理」的**视图**：同会话、同类、说法不同但意思是同一件事的，只留新的。
  //
  // 为什么不在落盘前删：源只增不改是这套系统的底线（回滚、重算、审计都靠它）。
  // 而且同一段推理里能去重，跨段的「换皮」只有全量看才看得见——
  // 「我错在哪：…」和「说清我错在哪：…」在写入那一刻是两条完全不同的记录。
  // 判据：字符二元组 Jaccard > 0.8（评审 2026-11-02 定的）。
  //
  // **抓复述，不抓重讲**（2026-11-02 定）：0.8 抓得住「换个句式」，抓不住
  // 「换了内容重讲一遍」（实测 0.17）。这是已知的，别再把阈值往下调——
  // 调到 0.3 会把「动手前先试工具」和「先量再收」这种**不同的**教训并掉，
  // 那不是去重，是抹平判断。要是同一个教训真出现三次以上，该改的是「让它一次说清」。
  thoughtsView({ sim = 0.8 } = {}) {
    const kept = []
    for (const t of this.thoughts) {
      const sid = (t.src && t.src.sid) || null
      let dupAt = -1
      for (let i = kept.length - 1; i >= 0; i--) {
        const k = kept[i]
        if (k.kind !== t.kind) continue
        if (((k.src && k.src.sid) || null) !== sid) continue
        if (similarity(k.text, t.text) > sim) { dupAt = i; break }
      }
      if (dupAt >= 0) {
        const old = kept[dupAt]
        kept.splice(dupAt, 1)
        kept.push({ ...t, mergedFrom: [...(old.mergedFrom || []), { id: old.id, ts: old.ts, text: old.text }] })
      } else {
        kept.push(t)
      }
    }
    return kept
  }

  // ——— 用进废退：只记「被想起过」，不回写源 ———
  //
  // 为什么不直接把 weight 改掉：marks.jsonl 是**源**，源只增不改。
  // 一改就再也算不出「当时我给它多重的分量」，也没法回滚一个判断错的降权。
  // 所以降权只发生在视图层（factsView），这里只留使用记录。
  useFact(key, { throttleMs = 12 * 3600 * 1000 } = {}) {
    const k = String(key || '')
    if (!k) return false
    const now = Date.now()
    const last = this._useSeen.get(k)
    if (last && now - last < throttleMs) return false
    this._useSeen.set(k, now)
    this.usage.push({ k, ts: now })
    try { appendFileSync(this.usagePath, JSON.stringify({ k, ts: now }) + '\n', 'utf8') } catch { return false }
    return true
  }

  factUsage() {
    const m = new Map()
    for (const r of this.usage) {
      if (!r || !r.k) continue
      const cur = m.get(r.k) || { n: 0, last: 0 }
      cur.n += 1
      cur.last = Math.max(cur.last, Number(r.ts) || 0)
      m.set(r.k, cur)
    }
    return m
  }

  // ——— 用进废退的账本（0.2.25）：不活在 state.json 里 ———
  //
  // 为什么（2026-11-03 评审抓的 #22）：「哪些事被想起过、上次什么时候被想起来」
  // 原来只存在 state.json 里，删 state / 过期重建就全丢；而 state 是**缓存**，
  // 删它本来就该无损。现在单独记一份只增不改的账，open 时按 (sid, startTs) 回填。
  // 匹配键用 startTs（段的第一条消息时间）：重建时段的起止是确定的，这个键跨重建稳定。
  _applyRehearsals() {
    let txt = ''
    try { txt = readFileSync(this.rehearsalPath, 'utf8') } catch {}
    const events = []
    for (const line of String(txt || '').split('\n')) {
      if (!line.trim()) continue
      let e
      try { e = JSON.parse(line) } catch { continue }
      if (!e || typeof e.from !== 'number' || typeof e.to !== 'number') continue
      events.push(e)
    }
    if (!events.length) {
      // 账本还没有（老库第一次跑新代码）：拿 state 里现成的计数**播种**一份，
      // 不然第一次 state 重建就把历史复述全丢了。
      this._seedRehearsals()
      return
    }
    // 账本是**唯一来源**：先把 state 里那份清零，再按区间回填。
    // 不清零会「state 12 + 账本 12 = 24」——2026-11-03 真踩到（c语言 Σ 翻成 24）。
    for (const ep of this.episodes) { ep.rehearsals = 0; ep.weakHits = 0; ep.lastHit = 0 }
    // 身份用**文档区间**（from/to），不用时间——2026-11-03 评审的判：
    // 「用时间当身份，边界一挪它就不是它了」。段的切法变了（首条消息换了），
    // 但它覆盖的那批消息还在，**跟谁重叠最多就记给谁**。
    for (const ev of events) {
      let best = null
      let bestOv = 0
      for (const ep of this.episodes) {
        const ov = Math.min(ep.to, ev.to) - Math.max(ep.from, ev.from) + 1
        if (ov > bestOv) { bestOv = ov; best = ep }
      }
      if (!best || bestOv <= 0) continue
      // 老账本没有 kind 字段（0.2.25–0.2.28 记的）——那是**同一种**计数，按 strong 回放，
      // 跟旧行为一致。新账本才分 weak。
      if (ev.kind === 'weak') best.weakHits = (best.weakHits || 0) + 1
      else best.rehearsals = (best.rehearsals || 0) + 1
      best.lastHit = Math.max(best.lastHit || 0, Number(ev.at) || 0)
    }
  }

  // 老库迁移：把 state 里现成的复述计数写进账本（每 1 次一条，open 时照常累加）。
  _seedRehearsals() {
    const lines = []
    for (const ep of this.episodes) {
      const n = ep.rehearsals || 0
      const w = ep.weakHits || 0
      if (n <= 0 && w <= 0) continue
      for (let i = 0; i < n; i++) {
        lines.push(JSON.stringify({ sid: ep.sid || null, from: ep.from, to: ep.to, at: ep.lastHit || Date.now(), kind: 'strong' }))
      }
      // weak 也要播种，不然一个已经分了弱账的库回退到「没有账本」时，weakHits 就悄悄丢了。
      for (let i = 0; i < w; i++) {
        lines.push(JSON.stringify({ sid: ep.sid || null, from: ep.from, to: ep.to, at: ep.lastHit || Date.now(), kind: 'weak' }))
      }
    }
    if (!lines.length) return
    try { appendFileSync(this.rehearsalPath, lines.join('\n') + '\n', 'utf8') } catch {}
  }

  // 一段被想起来了：内存 + 账本一起记。
  //
  // kind：'strong'（有原话撑腰，真的想起来了）| 'weak'（只是字面上最像，不算确认）。
  // 2026-11-03 #9：以前不分强弱，一次「像」也被记成一次「想起来」——越像越靠，越靠越像。
  // weak 只进 weakHits，权重给 1/3，不碰 rehearsals。
  noteRehearsal(ep, at = Date.now(), kind = 'strong') {
    if (!ep) return
    if (kind === 'weak') {
      ep.weakHits = (ep.weakHits || 0) + 1
    } else {
      ep.rehearsals = (ep.rehearsals || 0) + 1
    }
    ep.lastHit = at
    try {
      appendFileSync(this.rehearsalPath,
        JSON.stringify({ sid: ep.sid || null, from: ep.from, to: ep.to, at, kind: kind === 'weak' ? 'weak' : 'strong' }) + '\n', 'utf8')
    } catch {}
    this._dirty = true
  }

  saveState() {
    const tmp = this.statePath + '.tmp'
    const payload = {
      v: STATE_VERSION,
      titleVer: TITLE_VERSION,
      savedAt: Date.now(),
      streamBytes: this.bytes,
      episodes: this.episodes,
      meta: this.meta,
      seqs: this.seqs,
      marks: this.marks.length,
    }
    try {
      writeFileSync(tmp, JSON.stringify(payload), 'utf8')
      renameSync(tmp, this.statePath)
      this._dirty = false
    } catch (e) {
      this._lastSaveError = e && e.message
    }
    if (this._seqsDirty) { this._saveSeqs(); this._seqsDirty = false }
  }

  // 已经收到过的序号：实时监听和回填会撞车，靠这个去重
  seenSeq(sid, seq) {
    if (typeof seq !== 'number') return false
    const prev = this.seqs[sid]
    return typeof prev === 'number' && seq <= prev
  }

  noteSeq(sid, seq) {
    if (typeof seq !== 'number') return
    const prev = this.seqs[sid]
    if (typeof prev !== 'number' || seq > prev) {
      this.seqs[sid] = seq
      this._seqsDirty = true
      // 每 20 条刷一次盘：这个文件很小，但「忘了序号」的代价是把旧会话重倒一遍
      this._seqsN = (this._seqsN || 0) + 1
      if (this._seqsN % 20 === 0) this._saveSeqs()
    }
  }

  stats() {
    let traces = 0
    let acts = 0
    for (const d of this.docs) {
      if (!d) continue
      if (d.who === 'he' || d.who === 'me') traces += 1
      else if (d.who === 'act') acts += 1
    }
    return {
      dir: this.dir,
      bytes: this.bytes,
      docs: this.docs.length,
      traces,
      acts,
      episodes: this.episodes.length,
      terms: this.postings.size,
      index: this.indexEnabled ? this._indexSummary() : null,
      marks: this.marks.length,
      thoughts: this.thoughts.length,
    }
  }

  // 给 diag / cli 看的：索引文件在不在、覆盖到哪、启动时是复用的还是重建的
  //
  // **coversBytes 必须去读盘上那个文件头，不能用内存里的「我扫到哪」兜底。**
  // 踩过（评审 2026-11-02 23:10 抓的）：末尾压着半行时 `saveIndex()` 正确地拒绝写
  // （写出去就和流对不齐），可汇总兜底成了 `_scanEnd`，于是 diag 印
  // 「覆盖 2769959 / 流 2769959」——读起来像「索引已经完全跟上」，
  // 实际上这一轮**一个字节都没写进文件**，文件里还是上一次的覆盖。
  // 「自己印的话和实际干的事是两回事」，这一条就是。
  //
  // 四个字节数各是各的，别混：
  //   coversBytes —— 盘上那份索引覆盖到流的哪一段（null = 没有索引文件）
  //   streamBytes —— 流文件现在多长（和 `cli index` 的「文件」同一个量）
  //   eatenBytes  —— 这次吃到哪个完整行边界（有半行时小于 streamBytes）
  //   partialBytes—— 末尾那半行还没被吃进来的字节数
  _indexSummary() {
    const st = this.indexEnabled ? indexStat(this.indexPath) : null
    let streamBytes = 0
    try { streamBytes = statSync(this.streamPath).size } catch {}
    return {
      bytes: st ? st.bytes : 0,
      coversBytes: st ? st.streamBytes : null,
      streamBytes,
      eatenBytes: this._scanEnd,
      partialBytes: Math.max(0, streamBytes - this._scanEnd),
      reused: !!(this._idxInfo && this._idxInfo.reused),
      baseWords: this.postings.baseWords,
      tailWords: this.postings.tailWords,
      wroteAt: (this._idxInfo && this._idxInfo.wroteAt) || null,
    }
  }

  close() {
    if (this._seqsDirty) { this._saveSeqs(); this._seqsDirty = false }
    if (this._fd !== null) { try { closeSync(this._fd) } catch {}; this._fd = null }
    // 这两块是「这轮用到的缓存」，不倒排（倒排视图指着 _idxBuf，要留到实例结束）
    this._buf = null
  }
}
