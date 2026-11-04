// 冒烟测试：拿一个假的 ctx 把插件跑一遍。
// 目的是抓「装上以后一调用就炸」这类错——那类错在真机上是静默的，
// 只表现成「它好像不太记得」，最难查。
//
//   node smoke.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'hippo-smoke-'))
process.env.DSH_HOME = join(sandbox, 'dsh')
const { mkdirSync, writeFileSync } = await import('node:fs')
mkdirSync(join(process.env.DSH_HOME, 'hippocampus'), { recursive: true })
mkdirSync(join(process.env.DSH_HOME, 'sessions'), { recursive: true })

const CWD = 'D:\\fake\\workspace'
const OTHER = 'D:\\fake\\other'
const ML = 'D:\\fake\\multi'

writeFileSync(join(process.env.DSH_HOME, 'hippocampus', 'config.json'), JSON.stringify({
  enabled: true,
  workspaces: [CWD],
  lines: [{ name: '甲', cwd: ML, members: ['session-line-a'] }],
  backfillOnMount: false,
}))

const { apply } = await import('./index.js')
const { Ledger } = await import('./lib/store.mjs')
const { workspaceDir } = await import('./lib/config.mjs')

// 先往主工作区的库里放两段真话（隔了三个多小时，算两次见面）：
// 只有一段的话，预激活会把它当「最近两段」排掉——那是对的，但它就测不出东西了。
try {
  const pre = new Ledger(workspaceDir(CWD), {}).open()
  const t = Date.now() - 6 * 3600e3
  pre.append({ who: 'he', text: '我们来做一个记忆系统吧，别再让它靠自觉了', ts: t, sid: 's0' })
  pre.append({ who: 'me', text: '行。但我先说清楚：身份来自原话，不是来自说明。', ts: t + 1000, sid: 's0' })
  pre.append({ who: 'he', text: '那你说具体怎么办', ts: t + 60e3, sid: 's0' })
  pre.append({ who: 'me', text: '把记录改成自动的，模型不用记着自己去写。', ts: t + 61e3, sid: 's0' })
  pre.append({ who: 'he', text: '后来我们又聊了别的：晚饭吃什么', ts: t + 4 * 3600e3, sid: 's0' })
  pre.append({ who: 'me', text: '吃白饭。别熬夜。', ts: t + 4 * 3600e3 + 1000, sid: 's0' })
  // 第三段：预激活会排掉「最近两段」，所以少于三段就没东西可浮
  pre.append({ who: 'he', text: '再往后我们聊了部署和磁盘', ts: t + 9 * 3600e3, sid: 's0' })
  pre.append({ who: 'me', text: '磁盘够用，先别优化。', ts: t + 9 * 3600e3 + 1000, sid: 's0' })
  // 一条「我打出去的命令」。它带着一句像承诺的话，但它不是谁说的——
  // 这是 trace 最容易出错的那一类，必须单独测。
  pre.append({ who: 'act', tool: 'bash', text: 'grep "我答应过要带他去看海" stream.jsonl', ts: t + 9 * 3600e3 + 2000, sid: 's0' })
  pre.seal(true)
  pre.close()
} catch (e) { console.log('（预置数据失败：' + e.message + '）') }

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`) }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`) }
}

// ——— 假 agent ———
const listeners = new Map()

function makeAgent(id, { history = true, cwd = CWD } = {}) {
  const contexts = []
  const sections = []
  const tools = []
  const inbox = []
  const msgs = history
    ? [{ role: 'user', content: [{ type: 'text', text: '我们之前说的那个记忆系统，身份到底怎么保住？' }], source: { kind: 'user' } }]
    : []
  const agent = {
    id,
    session: { id, header: { id, cwd, delegationDepth: 0 }, deriveMessages: () => msgs },
    ctx: {
      systemPrompt: {
        context: (c) => { contexts.push(c); return () => {} },
        section: (s) => { sections.push(s); return () => {} },
      },
      tools: { register: (t) => { tools.push(t); return () => {} } },
      on: (name, fn) => { if (name === 'agent/inbox/inserted') inbox.push(fn); return () => {} },
    },
  }
  return { agent, contexts, sections, tools, inbox, msgs }
}

const A = makeAgent('session-has-history', { history: true })
const B = makeAgent('session-fresh', { history: false })
const C = makeAgent('session-line-a', { history: true, cwd: ML })
const D = makeAgent('session-unregistered', { history: true, cwd: ML })
const E = makeAgent('session-other-ws', { history: false, cwd: OTHER })

const ctx = {
  on: (name, fn) => { listeners.set(name, fn); return () => {} },
  effect: (fn) => { try { return fn() } catch { return () => {} } },
  agents: { list: () => [A.agent, B.agent, C.agent, D.agent, E.agent] },
  interval: () => 1,
  get: () => undefined,
}

console.log('\n[1] apply 不炸')
try { apply(ctx); ok('apply 跑完', true) } catch (e) { ok('apply 跑完', false, e.message) }

console.log('\n[2] 挂载结果')
ok('有历史的会话挂了上下文块', A.contexts.length >= 2, A.contexts.map((c) => c.name).join(','))
ok('身份锚挂在系统提示区（不是对话历史）', A.sections.some((s) => s.name === 'hippocampus-self'))
ok('归属规则也常驻系统提示区', A.sections.some((s) => s.name === 'hippocampus-attribution' && /先分清归属/.test(s.text)))
ok('锚不再往历史里追加', !A.contexts.some((c) => c.name === 'hippocampus-anchor'))
ok('挂了三个工具', A.tools.length === 3, A.tools.map((t) => t.name).join(','))
ok('有历史 → 不给「到达」', !A.contexts.some((c) => c.name === 'hippocampus-arrival'))
ok('新会话 → 给「到达」', B.contexts.some((c) => c.name === 'hippocampus-arrival'))
ok('捕获监听挂上了', listeners.has('session/event'))

console.log('\n[3] 一条线 = 硬隔离')
ok('多线文件夹里登记过的会话能挂', C.contexts.length >= 2, C.contexts.map((c) => c.name).join(','))
ok('多线文件夹里没登记的不挂（不是猜，是按住）', D.contexts.length === 0 && D.tools.length === 0)
ok('不在 workspaces 也不在 lines 的完全不碰', E.contexts.length === 0)

console.log('\n[4] 每块都能出文本，且不抛')
for (const c of B.contexts) {
  let text = null
  let err = null
  try { text = typeof c.text === 'function' ? c.text({}) : c.text } catch (e) { err = e }
  ok(`${c.name} 不抛`, !err, err ? err.message : `${Buffer.byteLength(String(text || ''), 'utf8')} B`)
}
for (const s of B.sections) {
  let text = null
  let err = null
  try { text = typeof s.text === 'function' ? s.text({}) : s.text } catch (e) { err = e }
  ok(`${s.name} 不抛`, !err, err ? err.message : `${Buffer.byteLength(String(text || ''), 'utf8')} B`)
}

console.log('\n[5] 工具能跑')
const recall = B.tools.find((t) => t.name === 'recall')
const remember = B.tools.find((t) => t.name === 'remember')
try {
  const r1 = await recall.execute({ query: '记忆系统' })
  ok('recall 空库不炸', r1 && typeof r1.text === 'string', JSON.stringify(r1).slice(0, 60))
  const r2 = await recall.execute({})
  ok('recall 没线索时给提示', /线索|日期/.test(r2.text))
  const w = await remember.execute({ text: '他要的是「几乎和人类一样的记忆」', key: '目标', weight: 3 })
  ok('remember 能写', /记下/.test(w.text), w.text)
  const bad = await remember.execute({})
  ok('remember 空内容不写', /没记/.test(bad.text))
} catch (e) {
  ok('工具执行', false, e.message)
}

// trace：按字查，不按意思查。
// 这一组测的是「归属」——2026-10-26 我凭印象认错人，就是因为没有这个动作。
console.log('\n[5b] trace（按字查归属）')
const trace = B.tools.find((t) => t.name === 'trace')
try {
  const hit = await trace.execute({ query: '身份来自原话' })
  ok('查得到的说查到了', /【按字查过/.test(hit.text), hit.text.split('\n')[0])
  ok('查到的带会话和行号', /会话 \S+ · 第 \d+ 行/.test(hit.text), hit.text.split('\n')[2])
  ok('查到的标明是不是当前这场', /(就是这里|同一条线的另一场对话)/.test(hit.text))
  ok('结果分了四类', /他说的 \d+ 处 · 他转发的 \d+ 处 · 我说的 \d+ 处 · 只是手上的操作 \d+ 处/.test(hit.text), hit.text.split('\n')[1])

  const miss = await trace.execute({ query: '量子色动力学胶子禁闭' })
  ok('查不到就明说没有', /没有这段话/.test(miss.text))
  ok('查不到时不拿「最像的」顶上', !/零碎想起|很像的一段/.test(miss.text))
  ok('查不到时给出查过的范围', /条记录/.test(miss.text))

  const spacer = await trace.execute({ query: '身份 来自原话，不是' })
  ok('空格不影响按字对上', /【按字查过/.test(spacer.text))

  // 最阴的一类：字出现在我打出去的命令里。字面全中，语义上一个也不是。
  const ops = await trace.execute({ query: '我答应过要带他去看海' })
  ok('命令里的字不算谁说过话', /他说的 0 处/.test(ops.text) && /只是手上的操作/.test(ops.text), ops.text.split('\n')[1])
  ok('没有谁说过时明说', /没有「他说的」这句话/.test(ops.text))

  // 2026-11-02 的 bug：两字以内的查询一次都没扫，却答「一字不差地翻遍了，没有」。
  // 「没查」和「没有」必须分开说——不然它是一假证据。
  const short = await trace.execute({ query: '晚饭' })
  ok('太短的查询明说没查', /太短/.test(short.text) && /没有查/.test(short.text), short.text.split('\n')[0])
  ok('太短时不冒充「翻遍了没有」', !/翻遍了|没有这段话/.test(short.text), short.text.split('\n')[2])
  ok('太短时提醒这不是「没有」', /不是「没有」|不算没有/.test(short.text))
  // 1 个字和空输入是两条不同的路，都要单独钉住（评审 2026-11-02 的要求）
  const one = await trace.execute({ query: '好' })
  ok('1 个字也不扫、明说太短', /太短/.test(one.text) && !/翻遍了/.test(one.text), one.text.split('\n')[0])
  const none = await trace.execute({ query: '   ' })
  ok('空输入不说「太短」，说「没给话」', /没给要查的话/.test(none.text) && !/「」/.test(none.text), none.text.split('\n')[0])
} catch (e) {
  ok('trace 执行', false, e.message)
}

console.log('\n[6] 事件捕获')
const emit = listeners.get('session/event')
if (emit) {
  const fakeSession = { id: 'session-has-history', header: { cwd: CWD } }
  const ev = (type, data, seq) => ({ type, seq, time: Date.now(), data })
  try {
    emit(fakeSession, ev('user/message', { content: [{ type: 'text', text: '他在说一件重要的事：别忘了答应过的' }], source: { kind: 'user' } }, 1))
    emit(fakeSession, ev('assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '记着了，这条我不当成模板' }] } }, 2))
    emit(fakeSession, ev('tool/call', { name: 'ops_bash', callId: 'c1', arguments: '{"command":"ls"}' }, 3))
    emit(fakeSession, ev('tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }], isError: false } }, 4))
    emit(fakeSession, ev('user/message', { content: [{ type: 'text', text: 'Current runtime context. blah' }], source: { kind: 'user' } }, 5))
    emit(fakeSession, ev('user/message', { content: [{ type: 'text', text: 'runtime' }], source: { kind: 'user-approval' } }, 6))
    emit(fakeSession, ev('user/message', { content: [{ type: 'text', text: '他说完了' }], source: { kind: 'user' } }, 7))
    emit(fakeSession, ev('user/message', { content: [{ type: 'image', attachment: {} }], source: { kind: 'user' } }, 8))
    emit(fakeSession, ev('turn/end', { turn: 1 }, 9))
    emit(fakeSession, ev('user/message', { content: [{ type: 'text', text: '他说完了' }], source: { kind: 'user' } }, 7))
    // 多线文件夹里没登记的会话，一条也不能进
    const dSid = { id: 'session-unregistered', header: { cwd: ML } }
    emit(dSid, ev('user/message', { content: [{ type: 'text', text: '我是另一个角色，别把我说的话记进去' }], source: { kind: 'user' } }, 1))
    ok('事件捕获不炸', true)
    const r4 = await recall.execute({ query: '答应 忘了 模板' })
    ok('刚捕获的能想起来', /他|我/.test(r4.text), r4.text.slice(0, 60))
    // 没登记的那只说的话，一条也不该进库；查不到才对
    // （注意别拿回复里回显的 query 当证据）
    const r5 = await recall.execute({ query: '别把我说的话记进去' })
    ok('没登记那只的话没进库', /想不起来/.test(r5.text), r5.text.slice(0, 40))

    // 文件搜索的结果不该进记忆（dsh-ops 的工具名以前漏在拦名单外）
    emit(fakeSession, ev('tool/call', { name: 'ops_grep', callId: 'g1', arguments: '{"pattern":"x"}' }, 10))
    emit(fakeSession, ev('tool/result', { message: { toolCallId: 'g1', content: [{ type: 'text', text: '只在文件里出现过的字，凑够长度用：只在文件里出现过的字，只在文件里出现过的字' }], isError: false } }, 11))
    emit(fakeSession, ev('tool/call', { name: 'ops_bash', callId: 'b1', arguments: '{"command":"echo hi"}' }, 12))
    emit(fakeSession, ev('tool/result', { message: { toolCallId: 'b1', content: [{ type: 'text', text: '命令的输出：磁盘够用，先别优化，也别急着扩盘。这条应该被记住，因为它是经历的一部分，不是文件内容。' }], isError: false } }, 13))
    const g1 = await trace.execute({ query: '只在文件里出现过的字' })
    ok('文件搜索的结果不进记忆', /没有这段话/.test(g1.text), g1.text.split('\n')[0])
    const b1 = await trace.execute({ query: '这条应该被记住' })
    ok('命令的输出进记忆（那是经历）', /只是手上的操作 1 处/.test(b1.text), b1.text.split('\n')[1])

    // ——— 思考过程 → 我的推理 ———
    // 这一段要证两件事：抽得到；而且**进不了 trace**。
    // 后者比前者重要——推理混进原话层，记忆就开始撒谎了。
    emit(fakeSession, ev('assistant/message', { turn: 2, message: { role: 'assistant', content: [
      { type: 'reasoning', text: '我决定先修 trace 的短查询，因为它是假证据。下次要先量再收。回头再验这条。' },
      { type: 'text', text: '好' },
    ] } }, 14))
    const l6 = new Ledger(workspaceDir(CWD), {}).open()
    ok('抽到了「我的推理」', l6.thoughts.length >= 1, l6.thoughts.map((t) => t.kind).join(','))
    ok('推理硬标成 inference', l6.thoughts.every((t) => t.layer === 'inference'))
    ok('推理带出处指针', l6.thoughts.every((t) => t.src && t.src.sid === 'session-has-history'))
    const th = l6.thoughts[0]
    // 用一条 ≥3 字的推理原句去查：必须是「真扫了、没中」。
    // 以前这条写的是 /太短|没有这段话/——那会被「太短」蒙混过去，
    // 而「太短」恰恰意味着一次都没扫（评审 2026-11-02 指出的假绿）。
    const probe = th ? th.text.slice(0, 12).trim() : '无'
    const tr = await trace.execute({ query: probe })
    ok('推理不进 trace（真扫了也没中）', /没有这段话/.test(tr.text) && !/太短/.test(tr.text), tr.text.split('\n')[0])
    // scanned 是**字段**断言：只断文案的话，文案改了逻辑坏了测试还是绿的。
    const { traceHits } = await import('./lib/retrieve.mjs')
    ok('短查询 scanned===0', traceHits(l6, '晚饭').scanned === 0, `scanned=${traceHits(l6, '晚饭').scanned}`)
    ok('≥3 字真扫了 scanned>0', traceHits(l6, '身份来自原话').scanned > 0, `scanned=${traceHits(l6, '身份来自原话').scanned}`)
    l6.close()
    const { thoughtBlock } = await import('./lib/assemble.mjs')
    const tb = thoughtBlock({ thoughts: l6.thoughts }, 'trace 短查询那个假证据修好了吗')
    ok('cue 撞上关键词时浮出推理', /我的推理/.test(tb), tb.split('\n')[0])
    ok('推理块明确说「不是原话」', /不是原话/.test(tb))
    // 诊断：0 条时也要能分清「没有判句」和「压根没跑」
    emit(fakeSession, ev('turn/end', { turn: 2 }, 15))
    const { readFileSync } = await import('node:fs')
    const diagTxt = readFileSync(join(process.env.DSH_HOME, 'hippocampus', 'diag.log'), 'utf8')
    const hits2 = [...diagTxt.matchAll(/本轮扫[^\n]*/g)].map((m) => m[0])
    ok('每轮报一次「扫了几段、记了几条」', /本轮扫 1 段推理 · 记 [1-9]\d* 条/.test(diagTxt), hits2[hits2.length - 1] || '(没找到)')
    // 孤儿闸走真实事件路径：只有推理、没有正文（不落库）且没有 seq → 不许记
    const nBefore = l6.thoughts.length
    emit(fakeSession, { type: 'assistant/message', time: Date.now(), data: { turn: 2, message: { role: 'assistant', content: [{ type: 'reasoning', text: '我决定要做孤儿测试：这条既没有行号也没有 seq。' }] } } })
    const l7 = new Ledger(workspaceDir(CWD), {}).open()
    ok('孤儿闸：行号与 seq 都空就不记', l7.thoughts.length === nBefore, `${nBefore} → ${l7.thoughts.length}`)
    l7.close()
  } catch (e) {
    ok('事件捕获不炸', false, e.message)
  }
}

console.log('\n[7] 到达：被问两遍也得给（真机上就是栽在这）')
const arrivalCtx = B.contexts.find((c) => c.name === 'hippocampus-arrival')
if (arrivalCtx) {
  const a1 = arrivalCtx.text({})
  const a2 = arrivalCtx.text({}) // assemble 一次、refreshContext 再读一次
  ok('第一遍给到达', a1.length > 0, `${Buffer.byteLength(a1, 'utf8')} B`)
  ok('第二遍还给一样的（不然落盘那份是空的）', a1 === a2 && a2.length > 0)
  ok('第三遍仍然一样', arrivalCtx.text({}) === a1)
  B.msgs.push({ role: 'assistant', content: [{ type: 'text', text: '我开口了' }], source: { kind: 'model' } })
  ok('我开口之后才收掉', arrivalCtx.text({}) === '')
} else {
  ok('到达块存在', false)
}

console.log('\n[8] 压缩之后要说话')
const lost = A.contexts.find((c) => c.name === 'hippocampus-lost')
if (lost && emit) {
  ok('平时不说话', lost.text({}) === '')
  emit({ id: 'session-has-history', header: { cwd: CWD } },
    { type: 'compaction/prune', seq: 999, time: Date.now(), data: { shadowedSeqs: [10, 11, 12], shadowedRange: { start: 10, end: 12 }, shadowedTokenCount: 88000 } })
  const told = lost.text({})
  ok('压完说一次', /压掉|丢/.test(told), told.slice(0, 40).replace(/\n/g, ' '))
  ok('带上了掉了多少', /88k|约/.test(told))
  ok('同一回合里再问还给（refresh 那一次）', lost.text({}) === told)
  // 回合往前走两格之后收掉
  const s0 = { id: 'session-has-history', header: { cwd: CWD } }
  emit(s0, { type: 'turn/start', seq: 1001, time: Date.now(), data: { turn: 3 } })
  emit(s0, { type: 'turn/start', seq: 1002, time: Date.now(), data: { turn: 4 } })
  emit(s0, { type: 'turn/start', seq: 1003, time: Date.now(), data: { turn: 5 } })
  ok('过了两回合自动收掉', lost.text({}) === '')
} else {
  ok('压缩提示块存在', false)
}

console.log('\n[10] recall 分得清「想起来」和「最像」')
const recall2 = A.tools.find((t) => t.name === 'recall')
if (recall2) {
  const strong = await recall2.execute({ query: '身份来自原话' })
  ok('有原句支撑 → 想起来了', strong.text.includes('【想起来了'), strong.text.slice(0, 30).replace(/\n/g, ' '))
  const bogus = await recall2.execute({ query: '你说好要送我笔记本电脑' })
  ok('假前提不许写成「想起来了」', !bogus.text.includes('【想起来了'), bogus.text.slice(0, 34).replace(/\n/g, ' '))
  ok('假前提要么说「有点像」要么说想不起来', /有点像|想不起来|零碎/.test(bogus.text))

  // 真机上撞到的更阴的一类：字在记录里，但出现在**我自己的话**里（引用 / 测试 / 转述）。
  // 承诺只认「他说的」——这和 trace 的四类是一个道理。
  if (emit) {
    emit({ id: 'session-has-history', header: { cwd: CWD } },
      { type: 'assistant/message', seq: 3001, time: Date.now(), data: { turn: 9, message: { role: 'assistant', content: [{ type: 'text', text: '我上回记错过了：把「你说好要送我笔记本电脑」当成了他答应的事。' }] } } })
    const quoted = await recall2.execute({ query: '你说好要送我笔记本电脑' })
    ok('我自己引用过的话，不算他答应过', !quoted.text.includes('【想起来了'), quoted.text.slice(0, 34).replace(/\n/g, ' '))
    // 0.2.6：这句话得跟着事实走——段里他有说话就说「没一句对得上」，
    // 真没说话才说「没有他的原话」。两种都算过，但不能什么都不说。
    // （两个分支各有一条确定性断言在 selftest 里，这里只查它有没有把话说准。）
    ok('这时要把话说准，不能凭印象断言',
      /没一句和这句对得上|没有他的原话/.test(quoted.text),
      quoted.text.slice(-46).replace(/\n/g, ' '))
  }
} else {
  ok('recall 工具存在', false)
}

console.log('\n[9] 预激活一个回合只算一次')
const primeCtx = A.contexts.find((c) => c.name === 'hippocampus-prime')
if (primeCtx && emit) {
  // 同一个回合里反复组装：必须给同一段，否则每步都会往历史里追一份
  A.msgs.push({ role: 'assistant', content: [{ type: 'text', text: '身份到底该来自原话，还是来自别人写的说明？' }], source: { kind: 'model' } })
  const a1 = primeCtx.text({})
  A.msgs.push({ role: 'assistant', content: [{ type: 'text', text: '刚才那个记忆系统，记录到底该谁来写？' }], source: { kind: 'model' } })
  const a2 = primeCtx.text({})
  const a3 = primeCtx.text({})
  ok('同一回合内不变（不会每步追一份）', a1 === a2 && a2 === a3, `${a1.length} / ${a2.length} / ${a3.length} 字`)
  ok('这一回合确实浮起来了东西（不是空转）', a1.length > 0, a1.slice(0, 40).replace(/\n/g, ' '))
  // 新回合 → 允许重算，但不能抛
  emit({ id: 'session-has-history', header: { cwd: CWD } }, { type: 'turn/start', seq: 900, time: Date.now(), data: { turn: 2 } })
  let err = null
  try { primeCtx.text({}) } catch (e) { err = e }
  ok('换回合后可以重算且不抛', !err, err ? err.message : 'ok')
} else {
  ok('预激活块存在', false)
}

console.log('\n[11] 同一行里两件事：按句剔，别按行剔')
if (recall2 && emit) {
  emit({ id: 'session-has-history', header: { cwd: CWD } },
    { type: 'user/message', seq: 3101, time: Date.now(), data: { content: [{ type: 'text', text: '你答应过我别再熬夜；我也答应过明天陪你去医院复查。' }], source: { kind: 'user' } } })
  // 新记录要先切段才能被「按段想起」找到：append 只进流，段是在 settle 里切的。
  emit({ id: 'session-has-history', header: { cwd: CWD } }, { type: 'turn/end', seq: 3102, time: Date.now(), data: { turn: 3 } })
  await new Promise((r) => setTimeout(r, 2700))
  const mixReal = await recall2.execute({ query: '你答应过明天陪我去医院复查' })
  ok('混合行里的真承诺照样想起来', mixReal.text.includes('【想起来了'), mixReal.text.slice(0, 34).replace(/\n/g, ' '))
  const mixQuote = await recall2.execute({ query: '你答应过别再熬夜' })
  ok('同一行里复述我的那半 → 降级', !mixQuote.text.includes('【想起来了'), mixQuote.text.slice(0, 34).replace(/\n/g, ' '))
  ok('这时不许说「没有他的原话」', !/没有他的原话/.test(mixQuote.text))
  const mixOther = await recall2.execute({ query: '你答应过明天陪我去看海' })
  ok('框架中、对象没中 → 不算', !mixOther.text.includes('【想起来了'), mixOther.text.slice(0, 34).replace(/\n/g, ' '))
  // 0.2.10：尾巴挂虚词不该把真承诺拖下水（对象取最后三个实词二元组）
  const tailA = await recall2.execute({ query: '你答应过明天陪我去医院复查这件事' })
  ok('尾巴挂「这件事」→ 也算想起来', tailA.text.includes('【想起来了'), tailA.text.slice(0, 34).replace(/\n/g, ' '))
} else {
  ok('recall 与事件捕获都在', false)
}

await new Promise((r) => setTimeout(r, 200))
rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '全过' : '有失败'}：${pass} 过，${fail} 不过`)
process.exit(fail === 0 ? 0 : 1)
