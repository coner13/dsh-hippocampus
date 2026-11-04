// 把「发生过的事」翻译成记忆里的一行。
//
// 会话事件长什么样、我们只关心哪几种，都在这里定。
// 关键取舍：**工具调用也要记**。那不是噪声——「我上次是这么查的」「这条命令报错了」
// 是经历的一部分。人回忆一件事的时候，记得住自己当时做了什么。

const MAX_TEXT = 6000

// 日志出口。capture 是**纯函数模块**，自己不写文件——写日志的路径、轮转、格式都在
// index.js 那边有一套了，这里再实现一遍就是两套。index.js 挂载时把 diag() 传进来。
// 默认什么都不记，所以单测里不需要 mock 也能跑。
let _log = () => {}
export function setCaptureLog(fn) { _log = typeof fn === 'function' ? fn : () => {} }

// 群聊里「人」的显示名。必须和那个群聊插件里的显示名一致（那边也有一份同样的名字）。
// 改名的代价：群里的消息会在记忆里被当成「别的角色说的」，trace 就再也查不到他说过什么——
// 这个名字写错不会报错，只会安静地少记，所以两边要同步改。
//
// 原来这里写死 '用户'：那是**功能耦合**，不是文案。群消息靠这个名字分「人说的」和
// 「别的 bot 说的」，名字对不上，人就永远进不了记忆。对外发布后别人的「人」不叫这个
// 名字，所以改成配置项：index.js 挂载（含重读配置）时用 config.humanName 调 setCaptureHuman()。
// 兜底值取中性的 'human'——代码里不许出现具体称呼，那属于用户配置。
let _humanName = 'human'
export function setCaptureHuman(name) {
  _humanName = String(name || 'human').trim() || 'human'
}

// ——— 群消息的进程内去重（2026-10-30，示例线指出来的真实风险）———
// 为什么需要：gid 不落库（store 只留七个字段），所以「同一条群消息被投两次」只剩
// store 那层的 10 分钟内容指纹挡着。隔十几分钟又投一次，指纹窗口早过了，
// 记忆里就会多出一条一模一样的 he——预激活端出来就是两行重复的「你说过」。
// 键用 (消息原始 ts, 正文前 40 字)：同一个人在同一毫秒说同一句话，现实里不会发生。
// 代价：这是**进程内**的，重启就清空。它是一道补丁，不是根治——根治要靠 gid 落库，
// 那要动存储层，观察期不动。
const _seenGroupKeys = new Set()
const SEEN_GROUP_MAX = 2000

function seenGroupKey(key) {
  if (_seenGroupKeys.has(key)) return true
  _seenGroupKeys.add(key)
  if (_seenGroupKeys.size > SEEN_GROUP_MAX) {
    // 满了就丢掉最早的一半（Set 保插入序）：群消息一天几十条，这个容量够撑很久
    let drop = _seenGroupKeys.size - Math.floor(SEEN_GROUP_MAX * 0.7)
    for (const k of _seenGroupKeys) { if (drop-- <= 0) break; _seenGroupKeys.delete(k) }
  }
  return false
}

// 这些工具的结果就是文件内容本身，记了只会污染记忆
//
// 2026-10-26 补的：`ops_grep`（dsh-ops 的 rust 搜索工具）返回的也是文件内容，
// 一个都没拦。顺手把同类的一起补上——`grep` / `glob` / `rg` 的结果都是「文件里有什么」，
// 不是「我做过什么」。文件内容随时能重读；记忆只留「我查过这件事」。
const FILE_OPS = new Set([
  'write', 'edit', 'read', 'ops_replace', 'ops_inspect_local_file', 'ops_glob', 'ops_grep',
  'grep', 'glob', 'rg',
  'todo_write', 'todo_read', 'multi_edit', 'str_replace_editor',
])

// 工具的「调用」和「结果」是两个事件，结果里不带工具名，只能自己记一下
const callNames = new Map()

function noteCall(callId, name) {
  if (!callId) return
  callNames.set(callId, name)
  if (callNames.size > 500) {
    const drop = callNames.size - 400
    let i = 0
    for (const k of callNames.keys()) { if (i++ >= drop) break; callNames.delete(k) }
  }
}

function nameOfCall(callId) {
  return callNames.get(callId) || ''
}

// 发言型工具：它发出去的文字就是「我说的话」，不是「我做了什么」。
//
// 2026-11-04 的真实事故：群聊里发出去的话被记成了 `act`（工具调用），
// 于是「这句话是谁说的」查不出来——用 trace 查，得到的是「只是手上的操作」。
//
// 判法只有一条：**显式配置**（`config.speechTools`）。不猜形状，也不写死插件名。
// 理由：名字里带 say/post 的不一定是在说话（也可能是发文章、发指令），
// 猜错的代价是把动作记成「我说过」——那比漏记一句更坏。
// 代价说在前面：装了群聊/消息插件，要在这里登记一次；不登记就还按动作记。
let _speechTools = new Set()
export function setCaptureSpeechTools(list) {
  _speechTools = new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [])
}
function isSpeechTool(name) { return _speechTools.has(String(name || '')) }

function speechTextOf(rawArgs) {
  try {
    const a = JSON.parse(String(rawArgs || ''))
    if (!a || typeof a !== 'object') return ''
    return String(a.text ?? a.message ?? '').trim()
  } catch { return '' }
}

const NOISE_PREFIX = [
  'Current runtime context.',
  'The approval policy changed',
  'Time sampled while preparing',
]

export function isNoise(text) {
  const s = String(text || '').trim()
  if (!s) return true
  return NOISE_PREFIX.some((p) => s.startsWith(p))
}

function blocksText(content) {
  if (!Array.isArray(content)) return { text: '', images: 0 }
  let images = 0
  const parts = []
  for (const b of content) {
    if (!b) continue
    if (b.type === 'text' && b.text) parts.push(b.text)
    else if (b.type === 'image') images += 1
  }
  return { text: parts.join('\n').trim(), images }
}

function clip(s, n) {
  const t = String(s || '')
  return t.length > n ? t.slice(0, n) + '…' : t
}

// 一个会话事件 → 0..n 条记忆记录
// ctx.sid：这条事件属于哪个会话。**去重键必须带它**，否则同一个 host 进程里
// 所有线共用一个 Set：第一条线记完，别的线全被判「重复」——2026-10-31 实测踩到：
// 「重启完成」只进了 A 那条线，B 那条什么都没记。
export function eventToRecords(event, ctx) {
  if (!event || !event.type) return []
  const ts = event.time || Date.now()
  // 去重键里的「线身份」：**优先用线名**，没有才退回会话 id。
  // 为什么不能用 sid 当键（2026-10-31 示例线点出来的）：sid 是会话 id，
  // 同一条线开个新会话，键就变了——同一批群消息会在同一条线里再记一遍。
  // 那条线的库是同一个，结果就是预激活里端出两条一模一样的话。
  const lineKey = String((ctx && (ctx.line || ctx.sid)) || '')
  const out = []
  const data = event.data || {}

  switch (event.type) {
    case 'user/message': {
      const src = data.source && data.source.kind
      // ——— 群聊投递（source.kind 是群聊插件那一种）———
      // 2026-10-30 修的：以前这里 `if (src !== 'user') return []` 把群聊消息整条丢掉了，
      // 于是「群里说的话」一条都进不了记忆，他说过的话只能查到命令的回声。
      //
      // 为什么不能直接把正文当他的话记：群聊投递的正文是**给人看的唤醒消息**，
      // 开头是几百字公告，中间混着别的角色的发言。整条记下来 = 把公告写进记忆。
      //
      // 所以只认投递里附带的**结构化原文**（那个插件侧后来加的 source.items）：
      //   · 只取 from === 人 的——别的角色的话记成 he 会让 trace 把别人的话当成他说过的话
      //   · 别的角色的发言留在群日志里，要用时另取，不进记忆（v1 定死）
      //   · 没有结构化原文（老版本）就不记：宁可缺，也不掺假
      if (src === 'relay') {
        const items = Array.isArray(data.source.items) ? data.source.items : []
        const out2 = []
        const rejects = []
        const ids = []
        let mine = 0, skipped = 0, dups = 0
        for (const it of items) {
          if (!it || !it.from) { rejects.push('拒收 (无from) 字段不全'); continue }
          if (it.from !== _humanName) { skipped += 1; continue }
          mine += 1
          // 约定：id / from / text 三样齐全才记。
          // 缺 id 就记下来的话，这条永远没法跟 group 日志对账、也没法去重——
          // 看着是记了，其实是个孤儿。
          if (!it.id || !it.text) {
            rejects.push(`拒收 ${it.id || '(无id)'} 缺${!it.id ? 'id' : 'text'}`)
            continue
          }
          const body = String(it.text || '').trim()
          if (!body || isNoise(body)) { rejects.push(`拒收 ${it.id} 空或噪声`); continue }
          // 同一条消息被投第二次：直接跳过，不记、也不进 gid 日志（它已经记过了）
          // 键里缺 ts 时退回唤醒体的 event.time，**不能用 0**——0 是所有缺 ts 的消息
          // 共享的同一个键，会把「同前缀、都没 ts」的两条不同消息判成重复，安静地丢一条。
          if (seenGroupKey(`${lineKey}|${Number(it.ts) || ts}|${body.slice(0, 40)}`)) { dups += 1; continue }
          // 注意：**不往记录里塞 gid / channel**。
          // store.append() 的 d 对象只留 ts/who/sid/turn/text/tool/type 七个字段，
          // capture 多返回的一律被切掉——写了也是白写，反而让人以为「已经落了」。
          // 所以 gid 只进日志（下面那行），当验收时的定位键用。
          out2.push({ who: 'he', ts: Number(it.ts) || ts, text: clip(body, MAX_TEXT), turn: null, type: event.type })
          ids.push(it.id)
        }
        // 验收取数面（2026-10-30 和评审、另一库定死的）：
        //   「装上去到底修没修好」必须能从日志一眼判出来，不能靠猜。
        //   最后一行带 gid 列表（一次最多带 3 条，所以最多 3 个），
        //   验收的人拿它回群日志查即可，不必改存储层。
        //   **每行带 sid**（2026-10-31 的要求）：几条线的日志原来长得一模一样，
        //   「哪行是哪条线打的」分不出来——上一个 bug 就是在这个盲区里发生的。
        if (items.length || out2.length) {
          // 标签优先写线名（人看得懂），没有线名才写会话 id 前 8 位
          const tag = (ctx && ctx.line) ? `line=${ctx.line}` : (lineKey ? `sid=${lineKey.slice(0, 8)}` : 'line=?')
          _log(`[${tag}] items 收到 ${items.length} 条 · ${_humanName} ${mine} 条 · 记了 ${out2.length} 条 · 跳过(非${_humanName}) ${skipped} 条 · 拒收 ${rejects.length} 条${dups ? ` · 重复 ${dups} 条` : ''}`)
          for (const r of rejects.slice(0, 5)) _log(`[${tag}]   ` + r)
          if (rejects.length > 5) _log(`[${tag}]   其余 ${rejects.length - 5} 条拒收略`)
          if (ids.length) _log(`[${tag}]   记下 gid：${ids.join(',')}`)
        }
        return out2
      }
      const { text, images } = blocksText(data.content)
      if (src !== 'user') return []
      // 只发图、没打字的消息是**内容**，不是噪声。
      // （这里踩过一次：isNoise('') 返回 true，于是整条线的第一张图被丢了，
      //   「初见」就从我那句开始，看着像他一句话没说。）
      if (text && isNoise(text)) return []
      const body = images ? `${text ? text + ' ' : ''}[图×${images}]` : text
      if (!body) return []
      out.push({ who: 'he', ts, text: clip(body, MAX_TEXT), turn: null, type: event.type })
      return out
    }

    case 'assistant/message': {
      const msg = data.message || {}
      const { text } = blocksText(msg.content)
      if (!text) return []
      out.push({ who: 'me', ts, text: clip(text, MAX_TEXT), turn: data.turn ?? null, type: event.type })
      return out
    }

    case 'tool/call': {
      const name = data.name || '?'
      noteCall(data.callId, name)
      // 发言型工具：发出去的文字记成「我说的」，不是「我调了某工具」
      if (isSpeechTool(name)) {
        const spoken = speechTextOf(data.arguments)
        if (spoken) {
          out.push({ who: 'me', ts, text: clip(spoken, MAX_TEXT), turn: data.turn ?? null, type: event.type, tool: name })
          return out
        }
      }
      const args = clip(String(data.arguments || ''), 150).replace(/\s+/g, ' ')
      out.push({ who: 'act', ts, text: `我调了 ${name}：${args}`, tool: name, turn: data.turn ?? null, type: event.type })
      return out
    }

    // 工具结果：**只看它「查到了什么」**，不看它「写了什么」。
    // 文件内容不进记忆（随时能重读，而且会把流撑成垃圾场），
    // 但搜索/命令/网页这类结果里，往往就是「我上次查到的东西」——那得留。
    case 'tool/result': {
      const msg = data.message || {}
      const { text } = blocksText(msg.content)
      if (!text) return []
      if (msg.isError) {
        out.push({ who: 'act', ts, text: clip(text, 240) + '（报错了）', turn: data.turn ?? null, type: event.type })
        return out
      }
      const tool = String(data.name || msg.toolName || nameOfCall(data.message && data.message.toolCallId) || '')
      if (FILE_OPS.has(tool)) return []
      const flat = text.replace(/\s+/g, ' ').trim()
      if (flat.length < 40) return []
      out.push({ who: 'act', ts, text: clip(flat, 220), turn: data.turn ?? null, type: event.type })
      return out
    }

    case 'session/title': {
      if (!data.title) return []
      out.push({ who: 'meta', ts, text: `这个对话叫「${data.title}」`, type: event.type })
      return out
    }

    default:
      return []
  }
}

// 事件里带的序号：用来去重（实时收的和回填的可能是同一件事）
export function eventKey(event) {
  if (!event) return null
  return typeof event.seq === 'number' ? event.seq : null
}
