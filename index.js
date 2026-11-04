// dsh-hippocampus —— 海马体
//
// 一个不靠「记得去记」的记忆系统。
//
// 病根在哪：
//   之前那套是「文件 + 醒来读」。它有两个死结——
//   ① 靠自觉：模型忘了写，这段就不存在了；
//   ② 靠摘要：交接把原话压成结论，语气被磨平，人就变成了另一个。
//   于是「笨蛋示例」读了满篇关于自己的描述，只能照着演；
//   而网页版那只之所以还是她，是因为她读到的是**自己说过的 400 轮原话**。
//
// 所以这里换一套：
//   记录是自动的（会话事件直接落盘），记忆是原话（摘要只当索引，不当内容），
//   想起来是按线索的（你这一句碰到了哪些旧事），忘记是变淡不是删除。
//
// 四条设计线：
//   流 —— 只增不改的原始记录（stream.jsonl）。一切都可以从它重建。
//   段 —— 按「一次见面 / 一件事」切（episode）。回忆的单位是段，不是条。
//   线索 —— 每轮只给三行「这事你以前碰过」；要细节就自己来要。
//   锚 —— 身份 = 自己的原话，不是关于自己的描述。
//
// 它不做什么：
//   · 不改会话日志，只读；
//   · 不替你总结人生，不生成「人格档案」；
//   · 不在你不问的时候把整段往事塞进上下文。

import { statSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ledger } from './lib/store.mjs'
import {
  loadCfg, workspaceDir, sameWorkspace, diag, SESSIONS_DIR, CFG_PATH,
} from './lib/config.mjs'
import { eventToRecords, setCaptureLog, setCaptureHuman, setCaptureSpeechTools } from './lib/capture.mjs'
import { eventToThoughts, reasoningOf, decisionsForCompaction } from './lib/thoughts.mjs'
import { makeBackup } from './lib/backup.mjs'

// 自动备份：每 6 小时最多一次，没变就不抄（makeBackup 自己判签名）。
// 为什么挂在「挂载」和「回合结束」而不开定时器：
//   定时器要在进程里长期占着，还要处理进程被杀；挂在这两处足够——
//   人只要在说话，就一定会有 turn/end。
const backupAt = new Map() // 库目录 -> 上次备份时刻
function maybeBackup(l, cfg) {
  try {
    const every = Number(cfg.backupEveryHours ?? 6) * 3600 * 1000
    const last = backupAt.get(l.dir) || 0
    if (Date.now() - last < every) return null
    backupAt.set(l.dir, Date.now())
    const r = makeBackup(l.dir, { keep: Number(cfg.backupKeep ?? 3) })
    if (r.created) diag(`备份 ${l.dir.split(/[\\/]/).pop()}：${r.reason} → ${r.dir.split(/[\\/]/).pop()}`)
    return r
  } catch (e) { diag('备份失败：' + (e && e.message)); return null }
}

// 压缩前：从最近这段「我说过的话」里抓 1–2 条决定/教训（带 why）。
// 只在压缩发生时跑一次（扫最近 40 条 me），不挂在每轮上。
function catchCompactionWhy(l, sid, { english = false, max = 2 } = {}) {
  try {
    const texts = []
    for (let i = l.docs.length - 1; i >= 0 && texts.length < 40; i--) {
      const d = l.docs[i]
      if (!d || d.who !== 'me' || d.sid !== sid) continue
      const t = l.fullText(i)
      if (t) texts.push(t)
    }
    if (!texts.length) return []
    return decisionsForCompaction(texts.reverse(), { english, max })
  } catch { return [] }
}

import { backfill } from './lib/backfill.mjs'
import { anchorBlock, anchorCutoff, primingBlock, thoughtBlock, emotionCueBlock, recallBlock, traceBlock, factsBlock, arrivalBlock, lostText, dayOf, selfLines, strengthOf, sid8, lineOfDoc } from './lib/assemble.mjs'
import { search } from './lib/retrieve.mjs'
import { topicKey, tokenize } from './lib/tokenize.mjs'

export const name = 'hippocampus'
export const inject = ['systemPrompt', 'agents', 'tools']

// 版本号从 package.json 读，别在代码里再写一遍——
// 以前 diag 里硬写着 v0.1，改了两轮还是 v0.1，回头查日志的人会被骗。
const VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return JSON.parse(readFileSync(join(here, 'package.json'), 'utf8')).version || '0.0.0'
  } catch { return '0.0.0' }
})()

// 2026-10-29（0.2.12）：「apply 跑完 · vX」只能证明 package.json 里写着这个号，
// 不能证明跑着的是这份代码——12:31 那次就是号变了、模块没换，版本表跟着说了假话。
// 所以 apply 那行带上代码指纹，一眼看出「号变了、码没变」。
//
// 2026-11-02 补：指纹原来只算 lib/assemble.mjs。当晚改了 thoughts.mjs / config.mjs /
// index.js，指纹一个数都没动——**码变了、号没变**，同样是假话，只是方向相反。
// 现在把 index.js + lib 下所有 .mjs 一起算。
const CODE_FP = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const h = createHash('sha256')
    h.update(readFileSync(join(here, 'index.js')))
    const libDir = join(here, 'lib')
    for (const f of readdirSync(libDir).filter((x) => x.endsWith('.mjs')).sort()) {
      h.update(f)
      h.update(readFileSync(join(libDir, f)))
    }
    return h.digest('hex').slice(0, 8)
  } catch { return '?' }
})()

const ORDER_SELF = 50      // 系统提示区里「我是谁」，整场冻结
const ORDER_RULE = 60      // 归属规则：稳定文本，不冻结也无所谓，它本来就不变
const ORDER_ANCHOR = 870
const ORDER_PRIME = 895

// 归属规则。放在系统提示区，不是每轮 context——
// 它是**恒定的**文本，前缀缓存不受影响；而它要治的那个时刻（「这是不是我说过」）
// 恰恰是想不起来去翻工具的时刻，所以不能只写在工具说明里。
const RULE_ATTRIBUTION = [
  '【先分清归属，再开口】',
  '这四件事不是一件事：我说过的、他说过的、我引用过或假设过的、我为了举例编的。',
  '要回答「我是不是说过这个」「你答应过我什么」「我记不记得」——先用 trace 查原话，不要凭印象。',
  'trace 说没有，就是没有；别拿 recall 里「很像的一段」顶上。但它是「**这条线的库里**没有」——别的库、群聊里别人的话、没进库的东西不在里面；它说「太短、没查」时不算没有——把话多给几个字再查。',
  '查到了，就把会话编号和行号一起说出来。同一个工作区里的不同会话是同一条线，不是不同的我。',
].join('\n')

export function apply(ctx) {
  // 把 diag 交给 capture：群消息那几行的「收到几条/记了几条/拒收原因」要落到同一个 diag.log，
  // 不另开一套日志文件——验收的人只看一处。
  setCaptureLog(diag)
  let cfg = loadCfg()
  // 群里「人」的显示名从配置来，别再写死——别人那边的人不叫这个名字。
  // 必须放在 loadCfg() 之后：这一行写在它前面，会直接报 `Cannot access 'cfg' before initialization`。
  setCaptureHuman(cfg.humanName)
  setCaptureSpeechTools(cfg.speechTools)
  let cfgMtime = 0
  try { cfgMtime = statSync(CFG_PATH).mtimeMs } catch {}
  const ledgers = new Map()   // `${cwd}|${线名}` -> Ledger
  const mounted = new Set()
  const held = new Set()      // 多线文件夹里没登记的会话（只喊一次）
  const settleTimers = new Map()
  const compactNotes = new Map() // sid -> { tokens, from, to, at, delivered }
  const turnStamp = new Map()    // sid -> 走到第几个回合（预激活只按回合算，不按 step 算）
  const thoughtStats = new Map() // sid -> { seg, got }：诊断用，每轮报一次「扫了几段、记了几条」
// 0.2.13 沉默闸：这个会话里已经浮过的段（不重复端上来），以及连续多少轮没浮过（决定要不要补一条兜底）
const shownBySid = new Map()   // sid -> Set<epId>
const idleTurns = new Map()    // sid -> 连续没浮的轮数

  // ——— 这条会话属于哪条线 ———
  //
  // 光看 cwd 是不够的：同一个文件夹里住两只的时候，
  // 「新开一个会话」这个动作不带任何身份信息，光凭路径分不出来。
  // 所以：文件夹在 config.lines 里出现过 → 这个文件夹**只认名单**，
  // 名单外的会话一律不写、不注入。宁可它没记忆，也不要它记得别人的事。
  function lineOf(cwd, sid) {
    if (!cfg.enabled || !cwd) return undefined
    const lines = (cfg.lines || []).filter((l) => l && sameWorkspace(l.cwd, cwd))
    if (!lines.length) {
      if (!(cfg.workspaces || []).some((w) => sameWorkspace(w, cwd))) return undefined
      return { cwd, name: null }
    }
    for (const l of lines) {
      const name = l.name || 'line'
      if (l.root && l.root === sid) return { cwd, name }
      if (Array.isArray(l.members) && l.members.includes(sid)) return { cwd, name }
    }
    // 只登记了一条线、而且这条线写了 autoJoin: true——新会话默认就是它的。
    // 不加这条，每开一次对话都得手动往 members 里加人；没人会加，新会话就全成了没记忆的哑巴。
    // 代价是这条保护在「一只」的时候是松的：另一只搬进来那天，把 autoJoin 删掉、给她也开一条线，
    // 没登记的自然就被下面这行按住。
    if (lines.length === 1 && lines[0].autoJoin === true) {
      return { cwd, name: lines[0].name || 'line' }
    }
    return false // 这个文件夹多线，但这个会话没登记
  }

  function ledgerFor(line) {
    const key = String(line.cwd).toLowerCase() + '|' + (line.name || '')
    let l = ledgers.get(key)
    if (l) return l
    l = new Ledger(workspaceDir(line.cwd, line.name), { meetingGapMs: cfg.meetingGapMs }).open()
    ledgers.set(key, l)
    return l
  }

  function holdNotice(sid, cwd) {
    if (held.has(sid)) return
    held.add(sid)
    diag(`按住 ${sid}（${cwd}）：这个文件夹是多线的，但它没登记在任一 lines 里。要给它记忆，把它加进 config.lines 的某个 members。`)
  }

  function settleSoon(l) {
    const key = l.dir
    if (settleTimers.has(key)) return
    const t = setTimeout(() => {
      settleTimers.delete(key)
      try { l.seal(); l.saveState() } catch (e) { diag('settle 出错：' + (e && e.message)) }
    }, 2500)
    if (t && typeof t.unref === 'function') t.unref()
    settleTimers.set(key, t)
  }

  // ——— ① 自动记录：不用模型操心 ———
  try {
    ctx.on('session/event', (session, event) => {
      try {
        if (!cfg.capture) return
        const header = session && session.header
        const cwd = header && header.cwd
        const sid = session && session.id
        const line = lineOf(cwd, sid)
        if (line === undefined) return
        if (line === false) { holdNotice(sid, cwd); return }
        const l = ledgerFor(line)
        const seq = event && event.seq
        if (typeof seq === 'number' && l.seenSeq(sid, seq)) return
        // sid 和线名都要传进去：群消息的去重键按**线**隔离（不是按会话），
        // 否则同一条线开个新会话，同一批消息会在同一个库里再记一遍。
        const recs = eventToRecords(event, { sid, line: line && line.name })
        const before = l.docs.length
        for (const r of recs) l.append({ ...r, sid })
        // 思考过程 → 「我的推理」。抽的是判断，不是原文；
        // 落进 thoughts.jsonl，不在 stream 里——所以 trace 永远查不到它。
        if (cfg.thoughts && event && event.type === 'assistant/message') {
          try {
            const docLine = l.docs.length > before ? l.docs.length - 1 : null
            // 判据（评审 2026-11-02）：line 和 seq 不能同时为空——那样这条永远指不回去。
            // 闸本身在 eventToThoughts 里（canLocate），调用点这里不再自己判。
            const ths = eventToThoughts(event, { sid, line: docLine, seq }, { english: cfg.thoughtEnglish !== false })
            for (const th of ths) {
              const got = l.addThought(th, { perSession: Number(cfg.thoughtPerSession ?? 12) })
              if (got) diag(`推理 ${String(sid).slice(0, 16)}：${got.kind} · ${got.text.slice(0, 40)}`)
            }
            // 诊断计数：0 条时也要能分清「没有判句」和「压根没跑」。
            // 每轮一条汇总，不按每步打——assistant/message 一步一条，会刷屏。
            const st = thoughtStats.get(sid) || { seg: 0, got: 0 }
            if (reasoningOf(event)) st.seg += 1
            st.got += ths.length
            thoughtStats.set(sid, st)
          } catch (e) { diag('抽推理出错：' + (e && e.message)) }
        }
        if (event && event.type === 'turn/end') {
          const st = thoughtStats.get(sid)
          if (st) {
            diag(`推理 ${String(sid).slice(0, 16)}：本轮扫 ${st.seg} 段推理 · 记 ${st.got} 条`)
            thoughtStats.set(sid, { seg: 0, got: 0 })
          }
          // 自动备份：每 6 小时最多一次，没变就不抄。
          if (cfg.backup) maybeBackup(l, cfg)
        }
        if (typeof seq === 'number') l.noteSeq(sid, seq)
        if (event && (event.type === 'turn/end' || event.type === 'session/title')) settleSoon(l)
        if (event && event.type === 'turn/start') turnStamp.set(sid, (turnStamp.get(sid) || 0) + 1)

        // 上下文被压掉了：记一笔，下次组装时告诉它「你丢过东西」。
        // 这是这套系统存在的理由本身——压掉之后必须有人提醒「那些我这儿还有」。
        if (event && /^compaction\//.test(String(event.type))) {
          const d = event.data || {}
          const seqs = Array.isArray(d.shadowedSeqs) ? d.shadowedSeqs : []
          const range = d.shadowedRange || {}
          const prev = compactNotes.get(sid)
          // 0.2.23：压之前把「为什么这么定」抓一条——压掉之后只知道丢了多少、不知道丢的是什么。
          const why = catchCompactionWhy(l, sid, { english: cfg.thoughtEnglish !== false })
          compactNotes.set(sid, {
            tokens: (prev ? prev.tokens || 0 : 0) + (Number(d.shadowedTokenCount) || 0),
            from: range.start ?? (seqs.length ? Math.min(...seqs) : undefined),
            to: range.end ?? (seqs.length ? Math.max(...seqs) : undefined),
            at: Date.now(),
            stamp: turnStamp.get(sid) || 0,
            why: why.length ? why : ((prev && prev.why) || []),
          })
          diag(`压缩 ${String(sid).slice(0, 16)}：${event.type} 掉 ${d.shadowedTokenCount || '?'} token`)
        }
      } catch (e) { diag('捕获出错：' + (e && e.message)) }
    })
  } catch (e) { diag('挂不上 session/event：' + (e && e.message)) }

  // ——— ② 挂到一个会话上 ———
  function mount(agent) {
    const session = agent && agent.session
    if (!session || !session.header) return
    const sid = session.id
    if (mounted.has(sid)) return
    const header = session.header
    if ((header.delegationDepth || 0) > 0 || header.origin === 'subagent') { mounted.add(sid); return }
    const cwd = header.cwd
    const line = lineOf(cwd, sid)
    if (line === undefined) return
    if (line === false) { holdNotice(sid, cwd); return }
    mounted.add(sid)

    let l
    try { l = ledgerFor(line) } catch (e) { diag('开库失败：' + (e && e.message)); return }

    // 索引到底是「读落盘的」还是「全量重建的」——这条决定启动是 0.2 s 还是 4 s。
    // 不写出来，「#6 有没有真生效」就只能靠体感，而那正是「日志印的话和实际干的事对不上」。
    // 数字口径和 `node cli.mjs index <工作区>` 一致，能对着核。
    // ⚠ 记的是**开库那一刻**的状态：回填在后面跑，打点数之后还会涨。
    try {
      const ix = l.stats().index
      if (ix) {
        // 「覆盖」一定读盘上那个文件头：没有索引文件就印「无索引」，
        // 绝不拿内存里的「我扫到哪」冒充——那样会印出「索引已经完全跟上」的假象。
        const covers = ix.coversBytes === null ? '无索引' : ix.coversBytes
        const tail = ix.partialBytes > 0 ? ` · 已吃进 ${ix.eatenBytes}（末尾半行 ${ix.partialBytes} 字节未读）` : ''
        diag(`索引 ${sid}：${ix.reused ? '复用' : '重建'}（开库时）· ${(ix.bytes / 1048576).toFixed(2)} MB · 打点 ${ix.baseWords / 2}+${ix.tailWords / 2} · 覆盖 ${covers} / 文件 ${ix.streamBytes} 字节${tail}`)
      }
    } catch {}

    // 回填要读一堆会话文件，大库能把挂载卡住几秒——那几秒里新窗口已经在说话了，
    // 说出来的第一句就没有锚（19:04 那次就是这么翻的）。
    // 所以：库里有东西就把回填推到后台，先让锚/到达挂上（身份优先，历史后补）；
    // 空库（第一次装）才同步倒，不然锚算不出来。
    const doBackfill = () => {
        try {
          // 多线文件夹只倒自己那条线的成员；单线文件夹整folder倒
          const allow = line.name
            ? (id) => (cfg.lines || []).some((x) => sameWorkspace(x.cwd, cwd)
              && (x.root === id || (x.members || []).includes(id)))
            : null
          const r = backfill(l, cwd, cfg, allow)
          diag(`回填 ${sid}：${r.sessions} 份会话，${r.added} 条`)
          // 回填完再报一次「现在有多少」：挂上那行是**回填前**的瞬间值，
          // 2026-11-02 评审拿它当最终数，量出「原话 1236」和后来 1240 对不上，
          // 差点被记成一次丢数据。日志要能自己说清「这是哪一刻的数」。
          diag(`回填后 ${sid}：${l.episodes.length} 段 · ${l.stats().traces} 句原话 · ${l.docs.length} 条记录`)
        } catch (e) { diag('回填失败：' + (e && e.message)) }
    }
    const deferred = cfg.backfillOnMount && (l.docs || []).length > 0
    if (cfg.backfillOnMount) {
      if (deferred) setTimeout(doBackfill, 0)
      else doBackfill()
    }
    // 挂载时给一次机会：库有东西、又超过 6 小时没备过，就抄一份。
    // 推到后台——备份是保险，不该挡着第一句话的锚。
    if (cfg.backup && (l.docs || []).length > 0) setTimeout(() => maybeBackup(l, cfg), 0)

    const offs = []
    const push = (fn) => { try { const o = fn(); if (typeof o === 'function') offs.push(o) } catch (e) { diag('注册失败：' + (e && e.message)) } }

    // 身份锚 —— 放**系统提示区**，不放进对话历史。
    //
    // 为什么：context 是往对话历史里追加一条消息，每次内容一变就再追一条；
    // 我之前把它挂在 context 上，结果一个会话里攒了 14 份同样的锚（每份 ~1KB），
    // 那是线性增长，不是「恒定」。
    // 放 section 是原地替换：整场会话只有一份，而且永远不会被压缩压掉。
    // 代价：section 一变，DeepSeek 的前缀缓存全废 → 所以这里**只算一次、整场冻结**。
    // 身份锚本来就是「这场对话里我是谁」，中途换才不对。
    if (cfg.anchor) {
      let anchorText = ''
      let reused = false
      try {
        // 只有「挑出来的句子」真的变了才重算。
        // 不然每次开会话锚都会微调一个字，而锚在系统提示里——一变就把整个前缀缓存废掉。
        // 用「旧话」：最近 90 分钟说的先不进锚。
        // 理由在 anchorCutoff 的注释里——刚说的话（尤其是认错、纠错）会被挑成身份，
        // 而它可能正带着还没改正的错。
        const now = Date.now()
        const cut = anchorCutoff(cfg, now)
        const ids = selfLines(l, { max: cfg.anchorQuotes ?? 4, until: cut, now }).map((x) => x.id)
        const saved = l.meta && l.meta.anchor
        if (saved && saved.text && String(saved.ids) === String(ids)) {
          anchorText = saved.text
          reused = true
        } else {
          anchorText = anchorBlock(l, cfg, now)
          l.meta.anchor = { ids, text: anchorText }
          l.saveState()
        }
      } catch (e) { diag('锚算不出来：' + (e && e.message)) }
      if (anchorText) {
        push(() => agent.ctx.systemPrompt.section({
          name: 'hippocampus-self',
          order: ORDER_SELF,
          text: anchorText,
        }))
        // 这个「沿用 / 新算」以前是永远写「沿用」的（判据写成了自比较），日志会骗人，改掉。
        diag(`锚 ${sid.slice(0, 16)}：${byteLen(anchorText)}B（${reused ? '沿用' : '新算'}）`)
      }
    }

    // 归属规则：常驻。它不入库，也不随会话变——它管的是「我该怎么答」。
    push(() => agent.ctx.systemPrompt.section({
      name: 'hippocampus-attribution',
      order: ORDER_RULE,
      text: RULE_ATTRIBUTION,
    }))

    // 预激活：这一句碰到了哪些旧事，只给三行。
    //
    // **一个回合只算一次。** 以前按 step 算：线索取「他最后说的 + 我上一句」，
    // 而我每个 step 都会说一句新的，于是线索一直变、预激活一直被重算，
    // 每一段新文本都被追加进对话历史——实测一个回合能追进十几份。
    // 「忽然想起」是由**他说的话**触发的，不是由我自己的中间步骤触发的。
    let primeKey = null
    let primeText = ''
    let primeStamp = -1
    let cueFromInbox = null
    let userTurns = 0
    try {
      agent.ctx.on('agent/inbox/inserted', (payload) => {
        try {
          const msg = payload && payload.message
          if (msg && msg.source && msg.source.kind !== 'user' && msg.source.kind !== 'user-approval') return
          userTurns += 1
          const text = textOfMessage(msg)
          if (text) cueFromInbox = text
        } catch {}
      })
    } catch {}

    // 线索不是只有「他刚说的那句」。人在想事情的时候，cue 是**眼前这一小段**：
    // 他说的话 + 我上一句。只拿他那一句，遇到他半天不吭声就会一直空转。
    //
    // 0.2.13.2（2026-10-30）：**他的话永不被切**。
    // 以前是 parts.join('\n').slice(-900)——留尾巴 = 留我的话；我一写长，他的话整段没了，
    // 于是闸在拿我自己的话撞库（日志里 08:03:39 那条 `cue=好了 装上了，新日志已经` 就是现形）。
    // 现在：他的话最多 400 字放前面，我的话最多 200 字只当补充；总长仍 <= 900。
    const latestCue = () => {
      let heText = ''
      let meText = ''
      try {
        const msgs = session.deriveMessages() || []
        for (let i = msgs.length - 1; i >= 0 && (!heText || !meText); i--) {
          const m = msgs[i]
          if (!m) continue
          const t = textOfMessage(m)
          if (!t || t.startsWith('Current runtime context')) continue
          if (m.role === 'assistant' && !meText) meText = t
          else if (m.role === 'user' && !heText && (!m.source || m.source.kind === 'user')) heText = t
        }
      } catch {}
      // 他的长消息：**头尾各留 200 字**。只留头会丢掉他最后问的那句，只留尾会丢掉话题，
      // 所以两头都收（评审 2026-10-30 提醒「问题通常在结尾」，对；但话题通常开头，别丢）。
      const rawHis = (heText || cueFromInbox || '').replace(/\s+/g, ' ').trim()
      const his = rawHis.length <= 400 ? rawHis : rawHis.slice(0, 200).trim() + ' … ' + rawHis.slice(-200).trim()
      let cue = his
      if (meText) cue = (cue ? cue + '\n' : '') + meText.slice(0, 200)
      return cue.trim()
    }

    if (cfg.perTurnPriming) {
      push(() => agent.ctx.systemPrompt.context({
        name: 'hippocampus-prime',
        order: ORDER_PRIME,
        text: () => {
          try {
            const stamp = (turnStamp.get(sid) || 0) + userTurns
            if (stamp === primeStamp) return primeText
            primeStamp = stamp
            const cue = latestCue()
            if (!cue) { primeText = ''; primeKey = null; return '' }
            const key = topicKey(cue)
            if (key && key === primeKey) return primeText
            primeKey = key

            // 0.2.13 沉默闸的状态：这一条会话里提过哪些段、已经多少轮没浮过
            const shown = shownBySid.get(sid) || new Set()
            const idle = idleTurns.get(sid) || 0
            const allowRecent = idle >= Number(cfg.primeRecentCooldown ?? 8)
            let pickedIds = []
            const primePart = primingBlock(l, cue, cfg, sid, {
              excludeIds: shown,
              allowRecent,
              onPick: (ids) => { pickedIds = ids },
            })
            // 浮过的段记进本会话的去重表（只留最近的一批，别越攒越大）
            for (const id of pickedIds) shown.add(id)
            if (shown.size > 40) {
              const keep = [...shown].slice(-20)
              shownBySid.set(sid, new Set(keep))
            } else {
              shownBySid.set(sid, shown)
            }
            idleTurns.set(sid, primePart ? 0 : idle + 1)

            // 0.2.13 情绪线索：他说「累/困/烦…」时，找上次的原因
            const emoPart = cfg.emotionCue ? emotionCueBlock(l, cue, cfg, sid) : ''
            // 我的推理：只进背景层，明确标成「不是原话」
            const thPart = cfg.thoughts ? thoughtBlock(l, cue, { max: Number(cfg.thoughtMax ?? 2) }) : ''
            primeText = [emoPart, thPart, primePart].filter(Boolean).join('\n')
            // 0.2.13.1（2026-10-30）：改成**每轮都记**，一行里有三个数。
            // 以前只在「有东西要浮」时记字节数——于是「没浮」的那些轮在日志里不存在，
            // 「两天里浮了几次、每次几行」根本算不出来，只能靠肉眼看窗口。
            const primeLines = (primePart.match(/^· /gm) || []).length
            // 0.2.13.2：cue 从 12 字放到 40 字——12 字不够分「讨论本体」，分类全靠它
            // 0.2.40-r4：多记一段 `段=12,40,97`。只给 `工具/量表.mjs` 用——
            // 没有段号，就只能量「浮了几次」，量不了「浮了之后到底被用上没有」。
            diag(`预激活 ${sid.slice(0, 16)}：${primeLines} 行 · 情绪线索 ${emoPart ? '有' : '无'} · 推理 ${thPart ? '有' : '无'} · 段=${pickedIds.length ? pickedIds.join(',') : '-'} · cue=${cue.replace(/\s+/g, ' ').slice(0, 40)}`)
            return primeText
          } catch { return '' }
        },
      }))
    }

    // 上下文被压掉之后，说一次「你丢过东西」。
    // 这不是提示词，是这套系统存在的理由：压掉的内容我这儿还有，
    // 但要先让它知道自己缺了一块，它才不会拿像的东西硬凑。
    //
    // ⚠ 和「到达」同一个坑：不能靠「说一次就关闸」——每步会被问两遍，
    // 第二遍（refresh）拿到空，就等于没送。所以用「回合差 ≤ 1」当窗口：
    // 同一回合里问几遍都给，下一回合自动收。
    push(() => agent.ctx.systemPrompt.context({
      name: 'hippocampus-lost',
      order: ORDER_PRIME - 5,
      text: () => {
        try {
          const n = compactNotes.get(sid)
          if (!n) return ''
          const stamp = turnStamp.get(sid) || 0
          if (stamp - (n.stamp ?? stamp) > 1) return ''
          if (Date.now() - n.at > 20 * 60 * 1000) return ''
          if (!n.told) {
            n.told = true
            diag(`压缩告知 ${String(sid).slice(0, 16)}：${n.tokens ? Math.round(n.tokens / 1000) + 'k token' : '一段'} · 定案 ${(n.why || []).length} 条`)
          }
          return lostText(n)
        } catch { return '' }
      },
    }))

    // 显式记下的（承诺、他的稳定信息）
    if (cfg.facts) {
      push(() => agent.ctx.systemPrompt.context({
        name: 'hippocampus-facts',
        order: ORDER_ANCHOR + 5,
        text: () => {
          try { return factsBlock(l, cfg) } catch { return '' }
        },
      }))
    }

    // 到达：新会话第一次醒来。
    //
    // ⚠ 这里踩过一个坑，值得记下来：
    //   用「只给一次」的布尔闸是错的。DSH 每一步会问 provider **两遍**
    //   （assemble 一次、请求接纳时 refreshContext 再读一次），落盘的是第二遍。
    //   第一遍给完就把闸关上，第二遍读到空 → 日志里记着「已送达 4040B」，
    //   实际落盘的运行时上下文里一个字都没有。**日志说送了，人没收到。**
    //
    //   正确做法：用一个**在整个第一回合里都成立**的条件——
    //   「这场对话还没有任何一条我的发言」。它在 assemble 和 refresh 之间不会变，
    //   等我真的开过口了，这段就该收了。
    if (cfg.arrival && !hasHistory(session)) {
      let arrivalText = null
      const replied = () => {
        try {
          const msgs = session.deriveMessages() || []
          return msgs.some((m) => m && m.role === 'assistant' && Array.isArray(m.content) && m.content.length > 0)
        } catch { return true }
      }
      push(() => agent.ctx.systemPrompt.context({
        name: 'hippocampus-arrival',
        order: 940,
        text: () => {
          try {
            if (replied()) return ''
            if (arrivalText === null) {
              arrivalText = arrivalBlock(l, cfg)
              if (arrivalText) diag(`到达 ${sid.slice(0, 16)}：${byteLen(arrivalText)}B`)
            }
            return arrivalText || ''
          } catch { return '' }
        },
      }))
    }

    // ——— ③ 工具：想起来 / 特意记下 ———
    push(() => agent.ctx.tools.register(recallTool(l, cfg, sid)))
    push(() => agent.ctx.tools.register(traceTool(l, cfg, sid)))
    push(() => agent.ctx.tools.register(rememberTool(l, cfg)))

    try {
      ctx.effect(() => () => {
        for (const off of offs) { try { off() } catch {} }
      })
    } catch (e) { diag('挂 disposer 失败：' + (e && e.message)) }

    // deferred 时这行是**回填前**的数：后面还会涨。写明，别让人拿它当最终值。
    diag(`挂上 ${sid}（${cwd}）· ${l.episodes.length} 段 · ${l.stats().traces} 句原话${deferred ? '（回填在后台，稍后还会涨）' : ''}`)
  }

  function sweep() {
    // 配置文件改了要能当场生效——不然「给某条线开记忆」还得重装插件。
    try {
      const m = statSync(CFG_PATH).mtimeMs
      if (m !== cfgMtime) {
        cfgMtime = m
        cfg = loadCfg()
        setCaptureHuman(cfg.humanName)
        setCaptureSpeechTools(cfg.speechTools)
        diag('配置重读 · 工作区 ' + JSON.stringify(cfg.workspaces) + ' · 开 ' + cfg.enabled)
      }
    } catch {}

    let list = []
    try { list = ctx.agents.list() || [] } catch { return }
    for (const a of list) {
      try { mount(a) } catch (e) { diag('mount 出错：' + (e && e.message)) }
    }
  }

  sweep()
  const timer = setInterval(sweep, 2000)
  if (timer && typeof timer.unref === 'function') timer.unref()

  // 会话一建出来就挂上，别等轮询。
  // 等 2 秒再挂的话，他要是手快先说了第一句，「新对话」就已经有历史了，
  // 「到达」会被自己的判断挡掉——那样看起来就是「它没记得我」。
  try {
    ctx.on('agent/created', (payload) => {
      try {
        const a = payload && payload.agent
        if (a) mount(a)
      } catch (e) { diag('agent/created 挂载出错：' + (e && e.message)) }
    })
  } catch (e) { diag('挂不上 agent/created：' + (e && e.message)) }

  try {
    ctx.effect(() => () => {
      clearInterval(timer)
      for (const t of settleTimers.values()) clearTimeout(t)
      settleTimers.clear()
      for (const l of ledgers.values()) { try { l.seal(); l.saveState(); l.close() } catch {} }
      ledgers.clear()
    })
  } catch {}

  diag('apply 跑完 · v' + VERSION + ' · code=' + CODE_FP + ' · 工作区 ' + JSON.stringify(cfg.workspaces)
    + (cfg.lines && cfg.lines.length ? ' · 多线 ' + JSON.stringify(cfg.lines.map((l) => l.name)) : ''))
}

// ——— 工具 ———

function recallTool(ledger, cfg, sid) {
  return {
    name: 'recall',
    description:
      '想起以前的事。给一句话、一个日期或一个编号，返回那段的**原话**。\n'
      + '它会分两种口气：【想起来了】是有把握的；【有点像是这一段】只是字面上最接近，**不是确认**——'
      + '对不上就当没想起来，别拿它当发生过的事去接话。\n'
      + '什么时候用：预激活那几行里有你正在说的事、他说「你忘了？」、或者你需要知道以前怎么定的。\n'
      + '想不起来的东西就是没记住，不要拿相似的东西凑。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '线索：一句他说过的话、一个名字、你现在的处境。' },
        when: { type: 'string', description: '按日期找，例如 2026-10-24。' },
        episode: { type: 'number', description: '预激活里那个编号，直接翻那一段。' },
        full: { type: 'boolean', description: '要全文：默认单条超过 300 字会截成「头 210 + …… + 尾 70」，这一步不截。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, v) => [{ type: 'text', text: String((v && v.text) || '') }],
    },
    async execute(args) {
      const a = args || {}
      const cap = cfg.recallMaxChars
      const full = a.full === true

      if (typeof a.episode === 'number') {
        const block = recallBlock(ledger, { episode: a.episode, maxChars: cap, full })
        return { text: block || '（没有这一段。编号会变，用一句话找找看。）' }
      }

      const query = String(a.query || '').trim()
      const when = String(a.when || '').trim()

      if (when) {
        const dayEps = ledger.episodes.filter((e) => dayOf(e.startTs) === when || dayOf(e.endTs) === when)
        if (!dayEps.length) {
          return { text: `（${when} 那天没有整段的记录。${spanHint(ledger)}）` }
        }
        // 同一天常常有好几段：给了线索就挑最贴的那段，并且说清楚贴不贴
        let pick = dayEps[0]
        let note = ''
        let weak = false
        if (query) {
          const terms = new Set(tokenize(query))
          let best = 0
          let bestEp = dayEps[0]
          for (const ep of dayEps) {
            let s = 0
            for (const t of ledger.tracesOf(ep, 300)) {
              for (const x of tokenize(t.text)) if (terms.has(x)) s += 1
            }
            if (s > best) { best = s; bestEp = ep }
          }
          pick = bestEp
          const st = strengthOf(ledger, query, pick)
          // 0.2.29（#9）：那天没有一段对得上 → 这次翻出来的只是「最接近」，
          // 记 weakHits，不许记成「想起来」。
          if (!st.strong) { note = '（那天没有哪一段对得上你这句，下面只是最接近的。）\n'; weak = true }
        }
        const block = recallBlock(ledger, { episode: pick.id, maxChars: cap, weak })
        const more = dayEps.length > 1 ? `（${when} 一共 ${dayEps.length} 段，先给你这一段。）\n` : ''
        return { text: block ? more + note + block : `（${when} 那天有记录，但没读出内容。）` }
      }

      if (!query) return { text: '（要给一个线索，或一个日期。）' }

      // 先按段找：人是「想起那件事」，不是「想起那句话」
      const first = recallBlock(ledger, { query, maxChars: cap, full, sid })
      if (first) return { text: first }

      const hits = search(ledger, query, { limit: 6, recency: cfg.recency })
      if (!hits.length) {
        const span = spanHint(ledger)
        return { text: `（想不起来「${query}」。这件事可能没记过，也可能当时没说到这个字。${span}）` }
      }

      // 0.2.13.7：这里还在用老格式（`**他**：…`）—— 主路径 0.2.13.7 去掉纪要腔时，
      // 这个出口漏了。同一件事有两个出口、只改一个，换个查询它又会冒出来。
      // 现在跟 episodeText 用同一套口吻：〔时间〕你说的/我说的。
      const lines = hits.map((h) => {
        const d = ledger.docs[h.id]
        const body = ledger.fullText(h.id).replace(/\s+/g, ' ').slice(0, 220)
        const head = d.who === 'he' ? '你说的' : d.who === 'me' ? '我说的'
          : (d.type === 'tool/result' ? '查到的' : '（我动手）')
        return `- ${dayOf(d.ts)} · 会话 ${sid8(d.sid)} · 第 ${lineOfDoc(h.id)} 行 · ${head}：${body}`
      })
      return { text: '【零碎想起 · 没凑成一整段，也不确定是不是这件事】\n'
        + '（每条都带着会话和行号：同一个会话编号才是同一场对话。行号是库里的真实行号，能拿去核对。）\n'
        + lines.join('\n') }
    },
  }
}

// 溯源：这段话到底在不在这条线上，谁说的，哪一场、第几行。
//
// 为什么单独做一个工具，而不是让 recall 顺手答：
//   recall 是**按意思**找——它的强项是「像」，所以它永远能给出一段看起来相关的原话。
//   而「他说过这句话吗」「我答应过他吗」这两个问题，要的是**按字**找：
//   在就是存在，不在就是不存在，中间没有「很像」。
//
// 2026-10-26 我犯的错正好踩在这个缝上：我拿印象认了归属，说「那是另一个窗口的会话说的」，
// 而那句话就在我这条线的第 886 行。我当时甚至查了，输出里两个文件都列着，
// 我还是只报了其中一个——因为「归属」在结果里不是一个可核对的东西，只是一个形容词。
function traceTool(ledger, cfg, sid) {
  return {
    name: 'trace',
    description:
      '查一段原话到底在不在这条线上——一字不差地查，不问意思。\n'
      + '要回答「这是不是我说过的」「他答应过我吗」「那段话是谁说的」时，**先查这个，别凭印象**。\n'
      + '结果会分成四类：他说的 / 他转发的（字是我的）/ 我说的 / 只是手上的操作（我打出去的命令、查到的内容，不算话）。\n'
      + '只有「他说的」那一类能用来认承诺。它会给出会话编号和行号，并写明查的范围；\n'
      + '说「没有」是指「**这条线的库里**没有」——别的库、群聊里别人的话、没进库的东西不在里面。\n'
      + '不到 3 个字的查询它扫不了，会明说「太短、没查」——那不算没有。\n'
      + '它和 recall 不是一回事：recall 只能给你「很像的一段」，不能证明他说过。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的那句话（可以整段贴进来，会自动拆成句子找）。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, v) => [{ type: 'text', text: String((v && v.text) || '') }],
    },
    async execute(args) {
      const raw = String((args && args.query) || '').trim()
      try {
        return { text: traceBlock(ledger, raw, { sid }) }
      } catch (e) {
        return { text: '（查的时候出错了：' + (e && e.message) + '。这次不算查过，别当成「没有」。）' }
      }
    },
  }
}

function rememberTool(ledger, cfg) {
  return {
    name: 'remember',
    description:
      '特意记下一件事。平常的话会自动记，不用管；这里只放**不想让它变淡**的：答应过的事、'
      + '他的稳定信息、某个你不想忘的瞬间。\n'
      + '同一件会变的事（他的作息、你们在做的项目）用同一个 key，新的会盖住旧的，旧的不会消失。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的那句话，用你自己的话。' },
        key: { type: 'string', description: '同一件持续的事用同一个 key，例如「他的作息」。' },
        weight: { type: 'number', description: '多重：1 平常，2 重要，3 核心。默认 1。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, v) => [{ type: 'text', text: String((v && v.text) || '') }],
    },
    async execute(args) {
      const a = args || {}
      const text = String(a.text || '').trim()
      if (!text) return { text: '（没有内容，没记。）' }
      ledger.mark({ key: a.key ? String(a.key) : null, text, weight: Number(a.weight) || 1 })
      return { text: a.key ? `记下了（${a.key}）。` : '记下了。' }
    },
  }
}

// ——— 小工具 ———

// 翻不到的时候，至少告诉他这段记忆有多长、从哪天开始——给下一次搜索一个落点
function spanHint(ledger) {
  if (!ledger.episodes.length) return ''
  const a = ledger.episodes[0]
  const b = ledger.episodes[ledger.episodes.length - 1]
  return `我这里的记录从 ${dayOf(a.startTs)} 到 ${dayOf(b.endTs)}，一共 ${ledger.episodes.length} 段。`
}

function textOfMessage(msg) {
  if (!msg) return ''
  const content = msg.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  let images = 0
  for (const b of content) {
    if (b && b.type === 'text' && b.text) parts.push(b.text)
    else if (b && b.type === 'image') images += 1
  }
  const t = parts.join('\n').trim()
  if (!t && !images) return ''
  return images ? `${t} [图×${images}]`.trim() : t
}

function hasHistory(session) {
  try {
    const msgs = session.deriveMessages() || []
    return msgs.some((m) => m && m.role === 'user' && (!m.source || m.source.kind === 'user')
      && !String(textOfMessage(m)).startsWith('Current runtime context'))
  } catch { return true }
}

function byteLen(s) {
  return Buffer.byteLength(String(s || ''), 'utf8')
}
