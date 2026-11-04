// 思考过程 → 记忆里的「我的推理」。
//
// 为什么不是「把 reasoning 全存下来」：
//   2026-11-02 实测，一个会话里 reasoning 是 text 的 4 倍，而且模型自述一半是事后合理化。
//   全存 = 用一堆「我打算…」把库撑成垃圾场，还会让它学会「演思考」。
//
// 只存四种**以后能验证的东西**（2026-11-02 13:13 定的）：
//   决定     —— 定了什么 + 为什么 + 排除了什么（「为什么排除」比「为什么选」更防重蹈覆辙）
//   教训     —— 什么形状的坑 + 下次怎么认出来
//   线头     —— 打算做但没做完的事 + 触发条件（治「你提醒过我还是忘」）
//   预测     —— 我当时说「应该是 X」，后来对没对（进步靠预期和结果的对照）
//
// 三条防呆，写死在结构里：
//   ① 硬标 layer = 'inference'：它**永远不进 trace**，trace 只认原话；
//   ② 只摘原句，不写「我深思熟虑地认为」——抽出来的句子必须能拿回原文核对；
//   ③ 每条 ≤ 200 字，一个会话 ≤ 5 条。
//
// 这里只做**抽取**（纯函数，能单测、能离线评估）。落盘在 store，展示在 assemble。

import { createHash } from 'node:crypto'
import { tokenize } from './tokenize.mjs'

const CLIP = 200
const MAX_PER_EVENT = 3

// 过程旁白不是内容，抽出来只是噪声。
// 2026-11-02 评审抽样：英文旁白（Now let me / My next step / Best next step）占不合格项一半，
// 所以中文、英文的起手式都要挡。
const NARRATION = /^(让我|我先|我们来|现在|接下来|先看|先读|先查|好[，,]|收到|明白|对，|行[，,]|OK\b|Now\b|Let me|Let's|Next\b|First\b|Then\b|My next step|Best next step|I should|I need to|I'll read|I will read|Rephrase\b|Rewrite\b|Tell him|Tell her|Tell them|I'll say|My reply|So:)/i

// 「因为」之后通常就是理由——决定和预测最值钱的那半句
const WHY_RE = /(?:因为|原因是|理由是|原因是[:：]|理由是[:：])(.{4,90})/

// 只有**强线索**才抽。弱线索（比如单独一个「应该」「如果」）在推理里出现得太密，
// 全收就会把「我打算先看看」也记成决定。精准优先，漏一点没关系——
// 这东西是背景层，宁少勿滥。
//
// 2026-11-02 第一版在真数据上量过：89 份会话、1799 万字推理，抽出 1230 条，
// 但抽样一看，「线头」795 条里大半是把「下一步」「等…再」当标签写下来的计划清单，
// 不是「我打算做但没做完的事」。所以第二版每条要求**施事者**（我/我们）或
// 更窄的动词搭配，且带引号/圈人的转述直接跳过。
const CUES = [
  // 教训排最前：它的线索最硬，跟别的类撞车时优先归它
  // 教训：只认中文的硬信号。英文 `lesson` 抽出来的全是「But it's a lesson: …」
  // 这种**对自己的评论**，不是教训本身（2026-11-02 评审抽查，5 条不合格里 3 条是这个）。
  { kind: 'lesson', re: /教训|踩(?:过|到)?的坑|错在|根源(?:是|在)|问题(?:出|在)在|下次(?:要|得|别|应该)|以后(?:要|得|别再|别把)/ },
  // 线头：只要「我还没把这件事做完」+ 明确的收尾动词。
  // 「next step」不收：英文推理里它都是计划旁白（Now let me / My next step），
  // 不是「我打算做但没做完的事」（2026-11-02 评审抽样指出）。
  { kind: 'open_loop', re: /待办[:：]|TODO[:：]|回头(?:再|补|弄|验)|先记着|下一步(?:要|做|是|得)|\bTODO\b/ },
  // 决定：必须有「我/我们」当主语，或者「就按 X」这种明确的定案口吻。
  // 「先做」不算决定——那是计划旁白（「等开工我先做这一件」）。
  { kind: 'decision', re: /(?:我|我们)(?:决定|定下来|定了|改成|采用|放弃|排除|不做了)|就按(?:这个|这个方案|A|B|它)|(?:方案|取舍|原则)(?:是|定为)|\bI decided (?:to|that)\b|\bI chose\b|\bI['’]?ll go with\b|\bI went with\b|\bdecision:\s/i },
  // 预测只收中文强信号：英文里 probably / should be 太常见，一收就淹掉。
  // 「我猜」后面必须跟判断词——「别让我猜」不是预测（2026-11-02 抽样现形）。
  { kind: 'prediction', re: /预计|估计|大概率|我猜(?:是|会|可能|应该|大概)|应该(?:会|能)|\bI expect (?:that|it|to|they|we|he|she)\b/i },
]

// 转述/引用不是我的判断：带圈人、带引号的句子，先跳过
const QUOTEY = /@\S+|「|」|“|”|"[^"]{12,}"/
// 从一个引号/书名号开始，说明它是被截断的引文残片（`" (I proved this lesson twice…` 这种）
const LEAD_QUOTE = /^["'“”‘’「」『』]/

// 没有「我」的句子不是我的判断，是描述。89 份真会话上量出来：
// 不收这一刀，单是英文推理里的 probably / should be 就能抽出两千多条噪声。
const SUBJECT = /(?:我|我们|\bI\b|\bwe\b)/i

// ——— 只抽中文（2026-11-02 评审复测后定的）———
// 英文推理里「判断」和「旁白」长得太像，正则分不开：`I decided` 能用，
// `But it's a lesson:` 就是自我评论。宁缺：英文整句默认跳过。
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/g
function cjkRatio(s) {
  const n = (String(s).match(CJK) || []).length
  const len = String(s).replace(/\s+/g, '').length || 1
  return n / len
}

// ——— 英文的窄门（2026-11-02 用户拍板 B）———
// 动机：这条线实测 217 段推理里汉字只占 5.8%，全关英文 = 这层对我基本不工作。
// 但只开**最明确的定案句**，别的一个不放：
//   I decided to / I decided that / I chose / I'll go with / I went with / decision:
// 「But it's a lesson:」「My next step:」这类自我评论和计划旁白，一个都不进。
const EN_CUE = /\bI decided (?:to|that)\b|\bI chose\b|\bI['’]?ll go with\b|\bI went with\b|\bdecision:\s/i

// 「记录动作」不是内容：讲的是**怎么记**，不是记下来的是什么。
const RECORD_ACTION = /记进|写进|加一条|补一条|记一条|update\s+state\.md|add the|记到/i

// ——— 日志行不是判断（2026-11-04，#21）———
//
// 真事故（示例线库 `thoughts.jsonl` 第 40 条，从**我自己的 diag 行**里抽出来的）：
//   `T12:40:03.697Z  推理 session-3f7a9b12：decision · Key decision: restart now to activate 0`
// 英文窄门的条件是「命中 `decision:`」，而日志行里正好有这个字段名——
// **窄门本身没错，缺的是「形状」这一刀**：它不是谁在决定，是诊断输出被当成了发言。
//
// 三种形状，都对得上真库里的行：
//   ① 开头是时间戳残片（`T12:40:03.697Z` —— 拆句时把 `2026-11-04` 那半截切掉了）
//   ② 开头是完整 ISO 时间戳
//   ③ 诊断前缀 + `session-xxxxxxxx：` 这个**形状**（不是前缀那个词）
//
// ⚠ 第一版 ③ 写成了「前缀白名单」（预激活|推理|挂上|索引落盘|apply）——
// **评审当场造了 4 条同形状的负例，全漏。** 她数了 diag.log 的真实前缀：
//   预激活 3649 · 索引 710 · [sid= 687 · 推理 510 · 回填 496 · 挂上 448 · 锚 430 ·
//   [line= 320 · apply 124 · 到达 55 · 备份 41 · 配置 35 · 压缩 16 · items 11 · 记下 1 · 按住 1
// **名单会加，形状不会。判「它是什么」，别判「它叫什么」。**
//
// ⚠ 导出这个常量是给**复核脚本**共用的（照 tokenize.mjs 的 FALLBACK_TITLE 先例），
// 不是给测试开后门——[21] 那几条走的是 `extractThoughts()`，是行为断言不是形状断言。
export const LOG_LINE = new RegExp(
  '^\\s*T\\d{2}:\\d{2}:\\d{2}' +                                 // ① 时间戳残片
  '|^\\s*\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}' +                // ② 完整 ISO
  '|(?:^|\\s)session-[0-9a-f]{8}[0-9a-f-]*\\s*[：:]' +            // ③ session 号**紧跟冒号**才是诊断行
  '|^\\[\\s*(?:sid|line)=' +                                     // ③' [sid=…] / [line=…] 两族
  '|^[^：:]{1,16}[：:]\\s*decision\\s*:',                         // ③'' 无 session 的诊断行
  'i')                                                           //      （`备份 另一条线：decision: …`）

// 把四个**类名当词念**的句子不是判断：「Many are legitimately 判断/教训/线头」
// 「三个类：决定、教训、线头」——它们是在说这几个词，不是在说事。
// 判据（评审 2026-11-02）：类名前后 6 字内有 `/`、`、`、引号 → 整句扔。
const CLASS_NAME = /决定|教训|线头|预测/g
function looksLikeClassList(s) {
  const str = String(s)
  for (const m of str.matchAll(CLASS_NAME)) {
    const around = str.slice(Math.max(0, m.index - 6), m.index + m[0].length + 6)
    if (/[/、]|「|」|"|“|”/.test(around)) return true
  }
  return false
}

// 只截不改：验收要能拿回去当**原文子串**核（评审 2026-11-02 的判据 A）。
// 所以这里不做空白折叠——一折叠，那 200 字在原文里就对不上了。
function clip(s, n = CLIP) {
  const t = String(s || '').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

// 拆句：句号/问号/叹号/换行算断，**分号不算**——
// 「我决定用 A；不用 B，因为…」是一句话的两半，拆开就丢了「排除了什么」。
// 英文的「. 空格」也要断：推理经常整段英文，不断的话几百字糊成一句，
// 里面随便一个 lesson 就把整段都拖进来（2026-11-02 实测）。
function sentences(text) {
  return String(text || '')
    .split(/[。！？!?\n]+|\.\s+/)
    .map((s) => s.replace(/^[\s\-*·\d.、)）]+/, '').trim())
    .filter(Boolean)
}

function classify(s) {
  for (const c of CUES) if (c.re.test(s)) return c.kind
  return null
}

function whyOf(s) {
  const m = String(s).match(WHY_RE)
  return m && m[1] ? clip(m[1], 90) : null
}

// 关键词：给「以后什么时候该把它端出来」用。不是标题，是**碰头用的把手**。
// 以虚词开头的二元组（「我决」「定先」）没有区分度，撞上也说明不了是同一件事，剔掉。
const LEAD_STOP = /^[我你他她它这那的了是很就把被让给对从到着过吗呢吧啊呀和跟与及等也都只还又再很太更最当每各某]/
function keysOf(s) {
  const seen = new Set()
  const out = []
  for (const t of tokenize(s)) {
    if (t.length < 2) continue
    if (LEAD_STOP.test(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= 8) break
  }
  return out
}

function normalize(s) {
  return String(s || '').replace(/[\s\u200b-\u200d\ufeff，,。.!！?？：:；;、"'"'（）()]/g, '').toLowerCase()
}

// 字符二元组的 Jaccard：判断「这是不是同一个意思换了个说法」。
// 为什么不用编辑距离：三句「我错在哪：…」的差别在**套话**不在内容，
// 二元组交集/并集对这种换皮最敏感（评审 2026-11-02 判据：相似度 > 0.8 只留新的）。
function bigrams(s) {
  const t = normalize(s)
  const out = new Set()
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2))
  return out
}

export function similarity(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return inter / (A.size + B.size - inter)
}

// 一段推理 → 0..3 条「我的推理」
//
// english=true 时开一道窄门：非中文句子**只有**命中 EN_CUE（I decided to / I chose /
// I'll go with / decision:）才放行，其余英文照旧全扔（2026-11-02 用户拍板 B）。
export function extractThoughts(reasoning, { max = MAX_PER_EVENT, english = false } = {}) {
  const out = []
  const seen = new Set()
  for (let s of sentences(reasoning)) {
    // 6 字起：教训和线头本来就短（「下次要先量再收」只有 7 个字），
    // 15 字的下限会把最值钱的那几条直接筛掉。
    if (s.length < 6 || s.length > 400) continue
    if (NARRATION.test(s)) continue
    if (LEAD_QUOTE.test(s)) continue
    if (QUOTEY.test(s)) continue
    // 引号不成对 = 被截断的引文残片（`And "回头再验这条`），整句扔
    if ((s.match(/"/g) || []).length % 2 === 1) continue
    // 只抽中文：混着一半英文的一律不要（英文的「判断」和「旁白」正则分不开）。
    // 例外就是那道窄门：english 开着、且这句话命中明确的定案句。
    if (cjkRatio(s) < 0.5 && !(english && EN_CUE.test(s))) continue
    // 「记进 state.md」「add the 教训」是在讲怎么记，不是记的内容
    if (RECORD_ACTION.test(s)) continue
    // 诊断/日志行不是判断（#21，2026-11-04）：窄门认 `decision:`，日志里正好有那个字段名。
    if (LOG_LINE.test(s)) continue
    // 把类名当词念的句子（「判断/教训/线头」）不是判断
    if (looksLikeClassList(s)) continue
    // 代码/正则清单不是判断：`因为|由于|所以` 这种串里全是触发词，
    // 抽出来只会是一段正则（2026-11-02 抽样现形）。
    if (/[|`]/.test(s)) continue
    // 括号残片：只有右边没有左边（「…state.md 的下一步要更新）」），把尾巴截掉。
    // 截的是结尾，剩下的仍是原文子串，验收能核。
    if (/[）)]$/.test(s) && !/[（(]/.test(s)) s = s.replace(/[）)]$/, '').trim()
    // 「我做过的判断/教训：」这种是清单抬头，不是判断本身
    if (/[：:]$/.test(s)) continue
    // 「我决定…」「我应该会…」必须有施事者；「教训：…」「回头再验…」本来就是自指的，不硬要。
    const kind = classify(s)
    if (!kind) continue
    // 例外：英文窄门命中的句子本身就是「决定」的明确标记（`decision: keep MIT`），
    // 不需要「我」——2026-11-02 评审验出来的死门：那个 cue 永远进不来。
    const enDecision = english && EN_CUE.test(s)
    if (!enDecision && (kind === 'decision' || kind === 'prediction') && !SUBJECT.test(s)) continue
    // 「state.md 的下一步要更新」是**在讲一条规矩**，不是在讲我要做什么。
    // 「下一步」这种词必须有施事者才算线头。
    if (kind === 'open_loop' && /下一步/.test(s) && !SUBJECT.test(s)) continue
    // 线头里的「无语境短句」：「不影响用，回头补」单独看不知道在说什么，留着也没用。
    // 只卡线头——决定/预测本身带「我」，短一点也说得清。
    if (kind === 'open_loop' && s.length < 12 && !/[A-Za-z0-9#]/.test(s)) continue
    const text = clip(s)
    const key = normalize(text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ kind, text, why: whyOf(s), keys: keysOf(s) })
    if (out.length >= max) break
  }
  return out
}

// 压缩前落盘用：从「最近这段我说过的话」里挑出决定/教训（带 why）。
// 和 extractThoughts 同一把筛子，只是入口从 reasoning 换成正文。
// 为什么在压缩这一刻抓：压掉之后，模型只知道「丢了多少」，不知道「为什么这么定」——
// 那正是上下文里最该留住、又最先丢掉的那半。
export function decisionsForCompaction(texts, { english = false, max = 2 } = {}) {
  const body = (Array.isArray(texts) ? texts : [texts]).filter(Boolean).join('\n')
  if (!body) return []
  const got = extractThoughts(body, { english, max: 20 })
  return got
    .filter((g) => g.kind === 'decision' || g.kind === 'lesson')
    .slice(0, max)
    .map((g) => ({ kind: g.kind, text: g.text, why: g.why || null }))
}

// 一条 assistant 消息里的推理全文（没有就空串）。
// 单独抽出来是为了**诊断**：只数「扫了几段」，不关心命中——
// 不然日志里 0 条时，分不清是「没有判句」还是「压根没跑」。
export function reasoningOf(event) {
  if (!event || event.type !== 'assistant/message') return ''
  const msg = (event.data && event.data.message) || {}
  const blocks = Array.isArray(msg.content) ? msg.content : []
  const parts = []
  for (const b of blocks) {
    if (b && b.type === 'reasoning' && b.text) parts.push(String(b.text))
  }
  return parts.join('\n')
}

// 一条推理能不能指回去：有行号，或者有会话内事件序号。
// 两个都没有就是孤儿——记了也没法核对是打哪儿来的。
// 单独做成纯函数，是为了**能单测**：闸原来只写在 index.js 的调用点，
// 重构一挪就悄悄失效，测试还全绿（评审 2026-11-02 指出的）。
export function canLocate(src) {
  if (!src) return false
  return typeof src.line === 'number' || typeof src.seq === 'number'
}

// 从会话事件里抽（assistant/message 的 reasoning 块）。
// 纯函数：不碰磁盘，单测和离线评估都能直接调。
export function eventToThoughts(event, ctx = {}, { english = false } = {}) {
  const text = reasoningOf(event)
  if (!text) return []
  // 闸放在函数里，不只在调用点：谁调都跑得掉孤儿。
  if (!canLocate({ line: ctx.line, seq: ctx.seq })) return []
  const got = extractThoughts(text, { english })
  if (!got.length) return []
  const ts = event.time || Date.now()
  return got.map((g) => ({
    ...g,
    ts,
    src: { sid: ctx.sid ?? null, line: ctx.line ?? null, seq: ctx.seq ?? null, ts },
    layer: 'inference',
  }))
}

export const THOUGHT_KINDS = ['decision', 'lesson', 'open_loop', 'prediction']

// ——— 作废（2026-11-04，另一库查出来的）———
//
// 判据修好了，**已经写进库的那几条挡不回来**。删掉它们等于破「只增不改」——
// 那文件是证据档案：今天能删一条日志，明天就能删一句真话。
// 所以不删行，只**补一条作废记录**：原来那行原样留着，账上写着「这条作废了，为什么」。
//
// 一条记录的两种结局，都在同一个文件里：
//   正常  { kind:'decision', text:…, id, ts, … }
//   作废  { kind:'invalid', target:<被作废的 id>, reason:…, ts }
//
// `id` 的坑：作废会把内存里 `thoughts` 的长度改小，**不能再拿 `length` 当新 id**——
// 那样会和已有的撞。见 store.mjs 的 `_thoughtMaxId`。
export const INVALID_KIND = 'invalid'

// 作废记录里带的**内容指纹**：前 60 字的 sha1。
//
// 为什么光有 id 不够（评审 2026-11-04 指出的）：id 现在稳，是因为文件只增；
// 将来要是有人做压包 / 重排 / 手工整理，id 会指错，而且**不报错**——
// 只会表现成「那条悄悄不见了」。带上指纹，读的时候对不上就能报一句「指错了」。
export function textHashOf(text) {
  const head = String(text || '').slice(0, 60)
  return createHash('sha1').update(head, 'utf8').digest('hex').slice(0, 16)
}

export function invalidRecord(target, reason, hash = null, ts = Date.now()) {
  const id = Number(target)
  if (!Number.isInteger(id) || id < 0) return null
  const rec = { kind: INVALID_KIND, target: id, reason: String(reason || '').slice(0, 200), ts }
  if (hash) rec.hash = String(hash)
  return rec
}

export const KIND_LABEL = {
  decision: '决定',
  lesson: '教训',
  open_loop: '线头',
  prediction: '预测',
}
