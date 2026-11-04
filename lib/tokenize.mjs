// 分词：中文按「字二元组」，英文/数字按词。
//
// 为什么不用词表：这份东西要在任何一台机器上都能跑，不该依赖一个 900KB 的词典文件。
// 而且中文检索里，二元组的召回率基本能追平词典分词——「记忆」「系统」这种词，
// 「记忆系统」拆成 记忆/忆系/系统 之后仍然能被「记忆」和「系统」两边同时命中。
// 代价是会有少量噪声，靠 idf 和后面的排序压下去。

// 0.2.15：带点的数字串**整体**成一个词。
// 以前 "0.2.14" 被拆成 ["0","2","14"]，其中 0 和 2 在全库 8110 条记录里各出现 1500+ 次，
// 等于两个纯噪声词占了权重；真正的区分度「14」只能靠 197 条记录撑。
// 现在 0.2.14 / 0.2.10 各是一个词，版本号之间不会再互相冒充。
// 尾巴上的句号不会被吞（点后面必须还有一个字母或数字）。
const ASCII_RE = /[a-z0-9_]+(?:\.[a-z0-9_]+)*/g
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

// ——— 规范形（0.2.13.7）———
//
// 一个词在索引里长什么样，得由**一个地方**定：写入和查询走同一个函数。
// 教训：`v0.2.13.6` 那次，分词把字母也吃进词里，于是文档里写 `v0.2.13.6`、
// 人查询打 `0.2.13.6`，两边是两个词 —— 修好的「版本号召得回」换一版又漏一半。
// 所以凡是同一个东西的几种写法，都在这里并成一个：
//   · 前导 v + 数字点串 → 去 v（v0.2.13.6 ≡ 0.2.13.6）
//   · 全角字母数字 → 半角（NFKC，在 tokenize 入口做）
// 代价说清楚：单独搜字母 v 时，搜不到 `v0.2.13.6` 里的那个 v。
// 这个代价是划算的 —— 那个 v 本来就不是内容。
function normTerm(w) {
  if (w.length > 1 && w[0] === 'v' && /^\d[\d.]*$/.test(w.slice(1))) return w.slice(1)
  return w
}

// 高频虚词二元组：检索上没有区分度，占着 postings 只会拖慢速度
const STOP = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '这么', '那么', '什么', '怎么',
  '就是', '还是', '也是', '只是', '但是', '可是', '因为', '所以', '如果', '然后',
  '可以', '没有', '不是', '一个', '这样', '那样', '这些', '那些', '自己', '已经',
  '现在', '时候', '一下', '一点', '应该', '需要', '可能', '觉得', '知道', '东西',
  '而且', '或者', '不过', '其实', '真的', '比较', '非常', '一定', '一样', '这里',
  '那里', '怎么', '为什', '么样', '对的', '好的', '嗯嗯', '哈哈',
])

export function tokenize(text) {
  const out = []
  if (!text) return out
  // NFKC：全角字母/数字先变半角，`ｖ０.２.１４` 和 `v0.2.14` 才落到同一个词上。
  // 兼容汉字也会被规范成标准汉字，这正好是想要的：两种写法本来就是同一个字。
  const s = String(text).normalize('NFKC').toLowerCase()

  for (const m of s.matchAll(ASCII_RE)) {
    const w = normTerm(m[0])
    if (w.length >= 2 || /\d/.test(w)) out.push(w)
  }

  let run = ''
  const flush = () => {
    if (!run) return
    if (run.length === 1) {
      out.push(run)
    } else {
      for (let i = 0; i + 1 < run.length; i++) {
        const bg = run.slice(i, i + 2)
        if (!STOP.has(bg)) out.push(bg)
      }
    }
    run = ''
  }
  for (const ch of s) {
    if (CJK_RE.test(ch)) run += ch
    else flush()
  }
  flush()
  return out
}

// 词频
export function termFreq(text) {
  const tf = new Map()
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1)
  return tf
}

// 极简标题：不生成新句子，只从原话里挑一行最像「那件事叫什么」的。
export function headline(text, max = 30) {
  let s = String(text || '')
    .replace(/\[图×\d+\]/g, '')
    // 围栏整块**在压平空白之前**换成一个切分点（评审 2026-11-03 12:32 抓的洞）。
    //
    // 顺序错了就是我先犯的那个错：先 `.replace(/\s+/g,' ')` 把换行压平，再按句号切，
    // 而围栏块里**没有句号**——于是「围栏块」和**后面那句**粘成同一个 piece，
    // `clean()` 看到里面有 ``` 就整块丢掉，连里面那句好的也丢掉；
    // 标题就落到下一块上，而那一块是从「。）」中间切开的，开头是一个右括号。
    // 实例：id 113 的标题一度成了「） 这个坑今天踩了两次…」——比原来的病更难看。
    // 换成「。」的意思是：围栏块本身不重要，但它是一个**边界**，前后两句各自独立。
    .replace(/```[\s\S]*?(?:```|$)/g, '。')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return '（没留下的话）'
  const pieces = s.split(/[。！？!?\n；;]/).map((x) => x.trim()).filter(Boolean)
  // 整段只有一个围栏块：换完之后只剩切分点，没有句子可挑——那是「没内容」，不是「原文」
  if (!pieces.length) return '（没留下的话）'
  // 「先暂停」这种太短，不足以当标题，往后找一句像样的。
  // 分隔线 / 落单符号也不许当标题（围栏在上一步已经整块换掉了，这里只是双保险）。
  const clean = (x) => !x.includes('```') && !/^(-{3,}|[*>\s]+)$/.test(x)
  // 每个候选都要「收拾干净再用」：剥掉开头落单的右括号、砍掉口语转折、去掉尾巴上的标点。
  // 一条候选收拾完是空的（比如整句就是「） 」），就换下一条，别端出去。
  // 开头落单的右括号 = 上一句被切在括号中间，这半句剩下的只是尾巴（`） 这个坑…`），读不得。
  const tidy = (x) => String(x || '')
    .replace(/^[）)」』”"]+\s*/, '')
    .replace(/^(?:对了|另外|顺便|所以|然后|那)[，,]\s*/, '')   // 逗号必需：见上面那段注释
    .replace(/[，,：:；;、\s]+$/, '')
  const order = [
    ...pieces.filter((x) => x.length >= 8 && clean(x)),
    ...pieces.filter(clean),
    ...pieces,
  ]
  let pick = ''
  for (const c of order) {
    const t = tidy(c)
    if (t) { pick = t; break }
  }
  if (!pick) pick = tidy(s) || s
  return pick.length > max ? pick.slice(0, max) + '…' : pick
}

// 两个兜底标题：它们的意思是「这一段没留下能读的话」，不是内容。
// 撞名时**不给它们补区分符**——补了就等于说「这段有东西，只是我没读出来」，
// 那是反过来撒谎。目录里两行一样的「没留下能读的话」，总比两行假的时间戳好。
export const FALLBACK_TITLE = /^（(这一段没留下能读的话|没留下的话)）$/

// 撞名时补的「区分符」：段里第一个像专名/标识的东西，再不行退回段开始的时刻。
//
// 为什么要补：2026-11-03 评审数的——重复标题覆盖 9 段，全是「🔍/💣 破案现场：」。
// 目录里 9 行一模一样的字，对「扫一眼今天聊了什么」的贡献是负的（占一行，什么都没说）。
export function titleSuffix(text, startTs = 0) {
  const s = String(text || '')
  // 只认「一看就是个专名/标识」的东西，**不认中文引号**（评审 2026-11-03 抓的）：
  // 从「」里抽出来的常是半句话，id 20/21 那对被补成 `…你是不是…（自己还在）`，
  // 能区分，但读着像话没说完——区分符的用处是「让人认出是哪一段」，不是再塞一句半截话。
  const m =
    s.match(/`([^`\n]{2,12})`/) ||                                        // 反引号里的标识：最干净
    s.match(/([A-Za-z0-9_.\-]+\.(?:mjs|js|json|jsonl|md|txt|yml))/) ||    // 文件名
    s.match(/(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]{2,23})/)            // 英文标识（canLocate / saveIndex）
  if (m) return m[1].slice(0, 12)
  if (startTs) {
    const d = new Date(startTs)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return ''
}

// 标题撞了就一路往下补，直到不撞：
//   「🔍 破案现场：」→「🔍 破案现场：（store.mjs）」→「…（store.mjs · 14:20）」→「…（#123）」
// taken 是「已经占了这个名字的段」的集合（Set 或 Map 都行，只看 has）。
export function dedupeTitle(title, taken, text = '', startTs = 0, id = null) {
  const base = String(title || '')
  if (!taken || typeof taken.has !== 'function' || !taken.has(base)) return base
  const suf = titleSuffix(text, startTs)
  const tries = []
  const d = startTs ? new Date(startTs) : null
  const hm = d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''
  if (suf) tries.push(`${base}（${suf}）`)
  if (d && suf && suf !== hm) tries.push(`${base}（${suf} · ${hm}）`)   // suf 就是时刻时别再叠一次：
  if (d) tries.push(`${base}（${hm}）`)                                 // 「（08:00 · 08:00）」白占一次尝试
  if (id !== null && id !== undefined) tries.push(`${base}（#${id}）`)
  for (const t of tries) if (!taken.has(t)) return t
  // 实在撞到底：加序号，保证**一定**能区分开。
  // 别用 Date.now() —— 那条路一旦走到，**同一份数据每跑一遍标题都不一样**，
  // 「幂等」就没了（独立复核 2026-11-03 点出来的；正常走不到，但走得到的那天最难查）。
  for (let i = 2; i < 50; i++) {
    const t = `${base}（${suf || '同一句话'} ${i}）`
    if (!taken.has(t)) return t
  }
  return `${base}（${suf || '同一句话'} 50+）`
}

// 话题指纹：用来判断「是不是还在说同一件事」，好让注入的那几行别每轮都变
export function topicKey(text, n = 6) {
  const freq = new Map()
  for (const t of tokenize(text)) freq.set(t, (freq.get(t) || 0) + 1)
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, n)
    .map((x) => x[0])
    .sort()
    .join('|')
}
