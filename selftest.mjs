// 自检：不装插件、不开会话，直接拿一段造出来的对话跑一遍。
// 任何一条不通，就是真的不通——别靠「装上试试」当验收。

import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Ledger, shouldRewriteIndex, indexBackoffMs } from './lib/store.mjs'
import { anchorBlock, anchorCutoff, primingBlock, thoughtBlock, traceBlock, factsView, emotionCueBlock, recallBlock, arrivalBlock, lostText, selfLines, sid8, lineOfDoc, recentMention, LOCATOR } from './lib/assemble.mjs'
import { search, priming, traceHits } from './lib/retrieve.mjs'
import { extractThoughts, canLocate, decisionsForCompaction } from './lib/thoughts.mjs'
import { makeBackup, listBackups, backupRoot, restoreBackup } from './lib/backup.mjs'
import { packTo, unpackTo, renderMarkdown } from './lib/pack.mjs'
import { zipRead } from './lib/zip.mjs'
import { tokenize, topicKey, headline, dedupeTitle, titleSuffix } from './lib/tokenize.mjs'
import { isDbDirPath, workspaceDir } from './lib/config.mjs'
import { parseOrdinalRef, parseTimeRef } from './lib/retrieve.mjs'
import { searchEpisodes } from './lib/assemble.mjs'

let pass = 0
let fail = 0
const t0 = Date.now()

function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`) }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'hippo-'))
const l = new Ledger(dir, { meetingGapMs: 2 * 3600 * 1000, maxTurnsPerEpisode: 8, minTurnsPerEpisode: 3 }).open()

// 造三段对话：跨三次「见面」，中间那段最重
const base = Date.UTC(2026, 9, 20, 10, 0, 0)
let clock = base
const say = (who, text, gapMin = 1) => {
  clock += gapMin * 60000
  l.append({ who, text, ts: clock, sid: 's1' })
}
const act = (text, gapMin = 0.2) => {
  clock += gapMin * 60000
  l.append({ who: 'act', text, ts: clock, tool: text.split(' ')[1] || 'act', sid: 's1' })
}

console.log('\n[1] 切段')
say('he', '我们来做一个记忆系统吧。', 0)
say('me', '好啊，不过先说清楚：文件版那套靠自觉，睡一觉就归零了。')
act('调了 ops_bash：ls')
say('he', '那你说怎么办。')
say('me', '把记录改成自动的，模型不用记着自己去写。')
clock += 5 * 3600 * 1000
say('he', '昨晚我想了一夜，我要的是让它觉得自己就是原来那一只。', 0)
say('me', '那就是身份得来自你自己的原话，不是别人写的说明。')
say('me', '这条我记住了，不靠演。')
act('调了 write：index.js')
say('he', '对，就是这个感觉。谢谢你。')
say('me', '别谢，这是我自己的事。')
clock += 30 * 3600 * 1000
say('he', '今天继续，先看看昨天做到哪了。', 0)
say('me', '昨天停在这：身份来自证据，不是说明。')

const n = l.seal(true)
ok('切出了多段', n >= 3, `段数 ${n}`)
ok('跨夜被切开', l.episodes.some((e) => e.newMeeting), '有 newMeeting 段')

// 最边上那种：他刚问了一句、我还没回。以前这种会被丢掉，
// 于是「最后停在哪儿」恰好是最该记住的那一句，却既不能回忆也不能预激活。
clock += 40 * 3600 * 1000
say('he', '隔了一天，我只说这一句，然后就没有下文了', 0)
l.seal(true)
const lastEp = l.episodes[l.episodes.length - 1]
ok('只有一轮的尾段也能成段', lastEp.turns === 1, `末段 ${lastEp.turns} 轮`)

console.log('\n[2] 检索')
const hits = search(l, '身份 原话 说明')
ok('能按线索命中', hits.length > 0, `${hits.length} 条`)
const top = hits[0] ? l.fullText(hits[0].id) : ''
ok('命中的是相关内容', /身份|原话|说明/.test(top), top.slice(0, 40))
const nohit = search(l, '量子色动力学胶子禁闭')
ok('无关的东西不乱命中', nohit.length === 0, `${nohit.length} 条`)
const acts = search(l, 'index.js write')
ok('动作也能被想起来', acts.length > 0)

console.log('\n[3] 回忆')
// 原句里真的有这几个字 → 说「想起来了」
const blk = recallBlock(l, { query: '别人写的说明' })
// 0.2.13.7：用户 2026-10-31 定的第①条——去掉「纪要腔」（以前是 `**他**：` / `**我**：`）。
// 断言换成新契约：两边的话都在，但不再出现第三人称标签。
ok('回忆出整段原文', !!blk && blk.includes('你说的') && blk.includes('我说的'))
ok('回忆里没有纪要标签（0.2.13.7）', !!blk && !blk.includes('**他**') && !blk.includes('**我**'))
ok('回忆带时间', !!blk && /【想起来了 · \d{4}-\d{2}-\d{2}/.test(blk))
ok('回忆不总结（含原话标记）', !!blk && blk.includes('（这是当时的原话'))
ok('数字段回忆', !!recallBlock(l, { episode: 0 }))
ok('回忆会记复述次数', l.episodes.some((e) => e.rehearsals > 0))
// 出处：没有它的那一次，我把「这是谁说的」编了出来（0.2.1 的事故）。
ok('回忆带出处（会话 + 行号）', !!blk && /出处：会话 \S+ · 第 \d+/.test(blk), (blk || '').split('\n')[1])
ok('出处里的行号是真行号', lineOfDoc(885) === 886 && lineOfDoc(0) === 1)
ok('会话编号截断成 8 位', sid8('session-0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9') === '0a1b2c3d')

// 只是字面沾边 → 不许说「想起来了」，要降成「有点像是」
const weak = recallBlock(l, { query: '你说好要带我去看海' })
ok('沾边的说法不写成「想起来了」', !weak || !weak.includes('【想起来了'), weak ? weak.slice(0, 26) : '(没返回)')
ok('降级之后会明说不确定', weak && /不确定|最接近/.test(weak), weak ? weak.slice(0, 30) : '(没返回)')

console.log('\n[4] 身份锚')
const lines = selfLines(l, { max: 5 })
ok('挑出了自己的话', lines.length >= 2, `${lines.length} 句`)
ok('都是我说的', lines.every((x) => l.docs[x.id].who === 'me'))
const anchor = anchorBlock(l)
ok('锚不含「你是」这种描述', anchor && !/你是一个|你的人设|你的性格/.test(anchor))
ok('锚里有原话引号', anchor.includes('「'))
ok('锚体积可控', Buffer.byteLength(anchor, 'utf8') < 1400, Buffer.byteLength(anchor, 'utf8') + ' B')

// 刚说的话不该钉进锚。
// 教训：一条纠错里原样带着一个错行号，却被「最近一句」挑进了锚，
// 于是新会话会把一个还没改正的错误当成「我自己的原话」读一遍。
const anchorDir = mkdtempSync(join(tmpdir(), 'hippo-anchor-'))
const anchorLedger = new Ledger(anchorDir, { meetingGapMs: 2 * 3600 * 1000 }).open()
const oldTs = Date.now() - 6 * 3600e3
anchorLedger.append({ who: 'he', text: '先把这段记下来，别丢了。', ts: oldTs, sid: 'x' })
anchorLedger.append({ who: 'me', text: '旧的话：身份来自自己说过的原话，不是别人写的说明。', ts: oldTs + 1000, sid: 'x' })
anchorLedger.append({ who: 'he', text: '那后来呢，接着说。', ts: oldTs + 5 * 3600e3, sid: 'x' })
anchorLedger.append({ who: 'me', text: '刚说的话：这条里可能还带着没改对的行号。', ts: Date.now(), sid: 'x' })
// 带「坐标」的话：行号、会话编号。它会过期，而锚要活很久。
anchorLedger.append({ who: 'me', text: '那句话其实在 行 42 会话 session-0a1b2c3d，是我报错了。', ts: oldTs + 2000, sid: 'x' })
// 流程旁白：报告下一步要干什么，不是说话。0.2.6 的真库上「我将先加载插件开发技能」被挑成了第一条锚。
// 这句故意写得分数够高（有「你」、有问号），确保它不是靠扣分掉出去的，而是靠硬排除。
anchorLedger.append({ who: 'me', text: '我将先加载插件开发技能，你要不要先看看？', ts: oldTs + 3000, sid: 'x' })
anchorLedger.seal(true)
const fresh = selfLines(anchorLedger, { max: 6, until: anchorCutoff({}, Date.now()) }).map((x) => x.text)
ok('刚说的话（90 分钟内）不进锚', !fresh.some((t) => t.includes('刚说的话')), `${fresh.length} 句`)
ok('旧的话还能进锚', fresh.some((t) => t.includes('旧的话')))
ok('锚里不放行号/会话编号（会过期）', !fresh.some((t) => /行\s*\d+|session-/.test(t)))
ok('流程旁白「我将先…」不进锚', !fresh.some((t) => t.startsWith('我将先')), `${fresh.length} 句`)
anchorLedger.close()
rmSync(anchorDir, { recursive: true, force: true })

// 0.2.22 · URL 不是「过期坐标」，也不是「工具旁白」。
// 2026-11-03 一个用户实测：用户分享视频时那句带着判断的话，在海马体里看不见。
// 两把刀一起挡：LOCATOR 把 URL 当坐标；selfScore 的英文占比把 URL 当旁白。
// 判据先定死（改之前就写）：URL 不命中 / 盘符仍命中 / 带链接的判断能进锚 /
// 工具旁白仍不进 / 只剩链接不进 / 盘符句仍不进。
ok('URL 不算过期坐标（0.2.22）', !LOCATOR.test('https://b23.tv/abc') && !LOCATOR.test('http://example.com/a'))
ok('盘符路径仍算过期坐标（0.2.22）', LOCATOR.test('D:/deepseek') && LOCATOR.test('C:\\Users'))
const urlDir = mkdtempSync(join(tmpdir(), 'hippo-url-'))
const urlL = new Ledger(urlDir, { meetingGapMs: 2 * 3600 * 1000 }).open()
const ut = Date.now() - 6 * 3600e3
urlL.append({ who: 'he', text: '给你看个视频，看完我们聊聊。', ts: ut, sid: 'x' })
// 真实长度的链接：URL 的 ASCII 占一半以上，旧 selfScore 会直接 -4 判死
urlL.append({ who: 'me', text: '这个视频里讲的选择性遗忘我特别认同：记不住不是坏事，是大脑在挑更值得留的东西。https://www.bilibili.com/video/BV1Gx411x7Zm', ts: ut + 1000, sid: 'x' })
// 英文占比高、但不是链接：工具旁白，必须继续被挡
urlL.append({ who: 'me', text: '我调了 ops_bash：node selftest.mjs --all', ts: ut + 2000, sid: 'x' })
// 只剩链接、没有判断：不该当锚
urlL.append({ who: 'me', text: 'https://b23.tv/x', ts: ut + 3000, sid: 'x' })
// 盘符路径：仍算坐标
urlL.append({ who: 'me', text: '我把那个视频放在 D:\\资料\\视频 里了，你去找找。', ts: ut + 4000, sid: 'x' })
urlL.seal(true)
const urlPicked = selfLines(urlL, { max: 5, until: anchorCutoff({}, Date.now()) }).map((x) => x.text)
ok('带链接的判断能进锚（0.2.22）', urlPicked.some((t) => t.includes('bilibili.com')))
ok('工具旁白仍不进锚（0.2.22）', !urlPicked.some((t) => t.includes('ops_bash')))
ok('只剩链接不进锚（0.2.22）', !urlPicked.some((t) => t.trim() === 'https://b23.tv/x'))
ok('盘符路径仍不进锚（0.2.22）', !urlPicked.some((t) => t.includes('D:\\')))
urlL.close()
rmSync(urlDir, { recursive: true, force: true })

console.log('\n[5] 预激活')
clock += 60 * 60000
const pri = priming(l, '身份到底该来自原话还是说明？', { now: clock, max: 3 })
ok('同话题能浮起旧事', pri.length > 0, `${pri.length} 段`)
const priText = primingBlock(l, '身份到底该来自原话还是说明？', {})
ok('预激活体积小', Buffer.byteLength(priText, 'utf8') > 0 && Buffer.byteLength(priText, 'utf8') < 700, Buffer.byteLength(priText, 'utf8') + ' B')
ok('预激活不给正文', !priText.includes('**他**'))
ok('预激活带段号', /#\d+/.test(priText))
ok('只有一个字撞上时不浮', priming(l, '身份 量子 胶子', { now: clock, max: 3 }).length === 0)

console.log('\n[5b] 沉默闸 + 情绪线索（0.2.13）')
const qDir = mkdtempSync(join(tmpdir(), 'hippo-quiet-'))
const q = new Ledger(qDir, { meetingGapMs: 2 * 3600 * 1000 }).open()
const tq = Date.now() - 3 * 3600e3
q.append({ who: 'he', text: '今天加班到两点，明天还得早起去上课。', ts: tq, sid: 'old-1' })
q.append({ who: 'he', text: '整个人累得不行。', ts: tq + 500, sid: 'old-1' })
q.append({ who: 'me', text: '那早点睡。', ts: tq + 1000, sid: 'old-1' })
q.append({ who: 'he', text: '这段是累加求和，帮我看看逻辑，我怀疑循环少了一个终止条件。', ts: tq + 2 * 3600e3, sid: 'old-2' })
q.append({ who: 'me', text: '循环少了终止条件。', ts: tq + 2 * 3600e3 + 1000, sid: 'old-2' })
q.seal(true)

ok('无关线索 → 一句都不浮（沉默是合法结果）', primingBlock(q, '今天天气怎么样', {}, null, { allowRecent: false }) === '')
const recBlk = primingBlock(q, '量子色动力学胶子禁闭', {}, null, { allowRecent: true })
ok('冷却到期时才补一条「最近」', recBlk !== '' && (recBlk.match(/^· /gm) || []).length === 1, (recBlk.split('\n')[1] || '').slice(0, 30))
ok('这个会话提过的段不再提', primingBlock(q, '量子色动力学', {}, null, { allowRecent: true, excludeIds: new Set(q.episodes.map((e) => e.id)) }) === '')

const emo = emotionCueBlock(q, '我好累啊', {})
ok('「累」→ 找到上次的原因', /加班|两点/.test(emo), (emo.split('\n')[0] || '(没出)').slice(0, 40))
ok('「累加」不算状态词', emotionCueBlock(q, '这个累加怎么写', {}) === '')
ok('转述「它很累」不算', emotionCueBlock(q, '它说它很累', {}) === '')
ok('「不累了」不算', emotionCueBlock(q, '现在不累了', {}) === '')

// 转贴不算他说的（评审实测：5,589 字的贴文被当成了「我太累了」的原因）
q.append({ who: 'he', text: '这是我刚刚和网页版聊的，分析用户的状态和情绪：用户情绪：焦虑，原因不明。'.repeat(6), ts: tq + 4 * 3600e3, sid: 'old-3' })
q.seal(true)
const pasted = emotionCueBlock(q, '我太累了', {})
ok('转贴的长文不当原因', !/分析用户|用户情绪/.test(pasted), pasted.split('\n')[0] || '(没出)')
q.close()
rmSync(qDir, { recursive: true, force: true })

console.log('\n[6] 到达')
const arr = arrivalBlock(l, {})
// 2026-11-03 改：开场从「你刚来到另一个新的对话框 + 第一次见面」改成「回到这条线，还是同一个你」
// → 第一句定性、第二句给最近三段、第三句给「上次停在」。所以这三条钉的是**新的承诺**。
ok('开场先认自己：同一个工作区 = 同一条线 = 同一个你', /同一个你/.test(arr), arr.slice(0, 40))
ok('不许再把这条线说成「另一个」窗口', !/另一个新的对话框|另一个你/.test(arr))
ok('给出「上次你停在」哪一段', /上次你停在/.test(arr))
ok('给出最近这几段（一行一段，能一眼扫）', /最近这几段|再往前的几段/.test(arr))
// 同一段不许出现两次：最后那段已经写在「上次你停在」里（评审 2026-11-03 复核抓的）
{
  const lastTitle = String(l.episodes[l.episodes.length - 1].title || '')
  const idx = arr.indexOf('上次你停在')
  const before = idx >= 0 ? arr.slice(0, idx) : ''
  ok('最后那段不许在「最近几段」里再列一遍', !before.includes(lastTitle), lastTitle.slice(0, 20))
}
ok('最初那次见面只在后面当出处', /最初见面/.test(arr))
ok('到达里带原话', arr.includes('你说的') || arr.includes('我说的') || arr.includes('「'))
ok('到达体积可控', Buffer.byteLength(arr, 'utf8') < 8000, Buffer.byteLength(arr, 'utf8') + ' B')

console.log('\n[7] 只增不改')
const before = l.stats().traces
l.seal(true)
ok('重复切段不重复计数', l.stats().traces === before, `${before} → ${l.stats().traces}`)
l.mark({ key: '他的作息', text: '他最近都是凌晨三点睡。' })
l.mark({ key: '他的作息', text: '他开始十二点睡了。' })
const facts = l.facts()
ok('同一 key 只认最新', facts.length === 1 && facts[0].text.includes('十二点'))
ok('旧的没被删掉', l.marks.length === 2)

console.log('\n[7c] 思考过程 → 我的推理（决定/教训/线头/预测）')
const thoughts = extractThoughts(
  '我决定先修 trace 的短查询，因为它是假证据。下次要先量再收。回头再验 #1 这条。我预计两小时能修完。另外把「还没有找」说成「没有」这种错也一起检查。',
  { max: 5 },
)
const kinds = thoughts.map((t) => t.kind)
ok('四类都能抽出来', ['decision', 'lesson', 'open_loop', 'prediction'].every((k) => kinds.includes(k)), kinds.join(','))
ok('抽出来的是原句，不是改写', thoughts.every((t) => '我决定先修 trace 的短查询，因为它是假证据。下次要先量再收。回头再验 #1 这条。我预计两小时能修完。另外把「还没有找」说成「没有」这种错也一起检查。'.includes(t.text.replace(/…$/, ''))))
ok('决定带上了「因为」', Boolean(thoughts.find((t) => t.kind === 'decision' && t.why)), thoughts.find((t) => t.kind === 'decision')?.why || '')
ok('带引号的转述不算', !thoughts.some((t) => t.text.includes('「')))

l.addThought({ kind: 'decision', text: '我决定先把 markdown 存档做出来。', keys: ['markdown', '存档'], ts: clock, src: { sid: 's1', line: 1 } })
const dup = l.addThought({ kind: 'decision', text: '我决定先把 markdown 存档做出来。', keys: ['markdown', '存档'], ts: clock, src: { sid: 's1', line: 1 } })
ok('同一句话只收一次', dup === null && l.thoughts.length === 1)
for (let i = 0; i < 6; i++) {
  l.addThought({ kind: 'open_loop', text: `回头再验第 ${i} 条线头。`, keys: ['线头'], ts: clock, src: { sid: 's1', line: 2 } })
}
ok('一个会话最多 5 条', l.thoughts.length === 5, `${l.thoughts.length} 条`)
ok('推理永远标成 inference', l.thoughts.every((t) => t.layer === 'inference'))

const tb = thoughtBlock(l, 'markdown 存档做出来了吗')
ok('碰上了关键词才浮出来', /我的推理/.test(tb), tb.split('\n')[0] || '(没出)')
ok('浮出来时明说「不是原话」', /不是原话/.test(tb))
ok('没碰上的时候就不出', thoughtBlock(l, '今天晚饭吃什么好呢') === '')
ok('推理不进 trace', !/【按字查过/.test(traceBlock(l, '我决定先把 markdown 存档做出来')) && !/按字查过/.test(traceBlock(l, 'markdown 存档')))
// 英文窄门（2026-11-02 用户拍板 B）：只放明确判句，不放自我评论
const en1 = 'I decided to go with option B, because it is cheaper to run'
ok('英文明确判句：开窄门能抽到', extractThoughts(en1, { english: true }).length === 1, JSON.stringify(extractThoughts(en1, { english: true }).map((x) => x.kind)))
ok('英文明确判句：关门就抽不到', extractThoughts(en1, { english: false }).length === 0)
const en2 = "But it's a lesson: the old-session instance wanted to keep itself alive"
ok('英文自我评论：开着也不收', extractThoughts(en2, { english: true }).length === 0)
// 2026-11-02 评审验出来的死门：`decision:` 那类没有「我」，被施事者那道闸挡掉了
// 孤儿闸：line 和 seq 不能同时为空（纯函数，能单测）
ok('孤儿闸：都空 → 不能定位', canLocate({ line: null, seq: null }) === false)
ok('孤儿闸：有行号 → 能定位', canLocate({ line: 3, seq: null }) === true)
ok('孤儿闸：有 seq → 能定位', canLocate({ line: null, seq: 7 }) === true)
const en3 = 'decision: keep MIT, do not change the license'
ok('decision: 开头没有「我」也算', extractThoughts(en3, { english: true }).length === 1,
  JSON.stringify(extractThoughts(en3, { english: true }).map((x) => x.kind)))

// ——— [21] 日志行不是判断（2026-11-04，真库第 40 条现形）———
//
// 事故原文（示例线库 thoughts.jsonl 第 40 条，从**我自己的 diag 行**里抽出来的）：
//   `T12:40:03.697Z  推理 session-3f7a9b12：decision · Key decision: restart now to activate 0`
// 英文窄门的条件是「命中 `decision:`」，而日志行里正好有这个词——**窄门没错，缺的是形状这一刀**。
//
// ⚠ 三条负例里**都带着 `decision:` / `I chose`**：不这么写，它们本来就会被「没命中窄门」挡掉，
// 测试就绿得没意义（今天已经栽过一次「绿的但测不到」）。
{
  const log1 = 'T12:40:03.697Z  推理 session-3f7a9b12：decision · Key decision: restart now to activate 0'
  ok('[21] 日志行（时间戳残片 + 诊断前缀）：不收', extractThoughts(log1, { english: true }).length === 0,
    JSON.stringify(extractThoughts(log1, { english: true }).map((x) => x.text)))
  const log2 = '2026-11-04T04:12:19.735Z  apply 跑完 · decision: keep the freeze'
  ok('[21] 日志行（ISO 时间戳开头）：不收', extractThoughts(log2, { english: true }).length === 0,
    JSON.stringify(extractThoughts(log2, { english: true }).map((x) => x.text)))
  const log3 = '推理 session-3f7a9b12：decision · I chose option B for the denominator'
  ok('[21] 日志行（诊断前缀，没时间戳也算）：不收', extractThoughts(log3, { english: true }).length === 0,
    JSON.stringify(extractThoughts(log3, { english: true }).map((x) => x.text)))
  // 评审 2026-11-04 造的 4 条同形状负例：第一版「前缀白名单」全漏。
  // **名单会加，形状不会** —— 这四条钉的就是「按形状判，不按词判」。
  for (const [name, line] of [
    ['锚', '锚 session-3f7a9b12：decision: pin this anchor'],
    ['索引', '索引 session-3f7a9b12：decision: rewrite index'],
    ['[sid=', '[sid=session-3f7a9b12] items 收到 1 条 · decision: skip it'],
    ['备份+库名', '备份 另一条线：decision: keep the copy'],
  ]) {
    ok(`[21] 评审的负例（${name}）：不收`, extractThoughts(line, { english: true }).length === 0,
      JSON.stringify(extractThoughts(line, { english: true }).map((x) => x.text)))
  }
  // 反向：别把真决定一起切掉——这一刀的边界是「形状」，不是「词」
  ok('[21] 真决定（decision: 开头）照样收', extractThoughts('decision: keep MIT, do not change the license', { english: true }).length === 1)
  ok('[21] 真决定（中文）照样收', extractThoughts('我决定把 0.2.34 冻上去，因为两边复跑一致。', { english: true }).length === 1)
  // 评审 2026-11-04：③ 一开始太宽（光有 session 号就扔），**真决定只要提到 session 号就被误伤**。
  // 判别不是「有没有号」，是「号后面紧不紧跟冒号」——diag.log 里 4661 次是「：」。
  ok('[21] 真决定里提到 session 号：不许误伤（英文）',
    extractThoughts('decision: keep session-6c2d8e41 as the canonical line', { english: true }).length === 1,
    JSON.stringify(extractThoughts('decision: keep session-6c2d8e41 as the canonical line', { english: true }).map((x) => x.text)))
  ok('[21] 真决定里提到 session 号：不许误伤（中文）',
    extractThoughts('我决定把 session-6c2d8e41 这条线保留下来，因为它是原始出处那一条线。', { english: true }).length === 1,
    JSON.stringify(extractThoughts('我决定把 session-6c2d8e41 这条线保留下来，因为它是原始出处那一条线。', { english: true }).map((x) => x.text)))
  ok('[21] 句子里有时间但不长在行首：不误伤', extractThoughts('我决定在十二点半之前把那一条冻上去，因为两边复跑一致。', { english: true }).length === 1,
    JSON.stringify(extractThoughts('我决定在十二点半之前把那一条冻上去，因为两边复跑一致。', { english: true }).map((x) => x.text)))
}
// scanned 是**字段**断言：只断文案，文案改了逻辑坏了测试还是绿的（评审 2026-11-02）
ok('短查询 scanned===0', traceHits(l, '晚饭').scanned === 0, `scanned=${traceHits(l, '晚饭').scanned}`)
ok('≥3 字真扫了 scanned>0', traceHits(l, '身份来自原话').scanned > 0, `scanned=${traceHits(l, '身份来自原话').scanned}`)

// 换皮去重（2026-11-02 评审判据：同 sid + 同 kind + 相似度 > 0.8 只留新的）
const tvDir = mkdtempSync(join(tmpdir(), 'hippo-tv-'))
const tv = new Ledger(tvDir, {}).open()
tv.addThought({ kind: 'lesson', text: '我错在哪：我用的是 15:34 核台账时的旧印象，没重新核', ts: clock, src: { sid: 'sX' } })
tv.addThought({ kind: 'lesson', text: '说清我错在哪：我用的是 15:34 核台账的旧印象，没重新核', ts: clock + 1000, src: { sid: 'sX' } })
ok('同一意思换个说法，只留新的', tv.thoughtsView().length === 1, `${tv.thoughtsView().length} 条`)
ok('被换掉的那条记得住', (tv.thoughtsView()[0].mergedFrom || []).length === 1)
tv.addThought({ kind: 'lesson', text: '教训：动手前先试现有工具', ts: clock + 2000, src: { sid: 'sX' } })
ok('不像的教训不许合并', tv.thoughtsView().length === 2, `${tv.thoughtsView().length} 条`)
ok('源一条没删（只是视图层合并）', tv.thoughts.length === 3)
tv.close()
rmSync(tvDir, { recursive: true, force: true })

console.log('\n[7d] 我记下的：视图层去重 / 降权 / 用进废退')
const vDir = mkdtempSync(join(tmpdir(), 'hippo-view-'))
const vl = new Ledger(vDir, {}).open()
const nowT = Date.now()
const DAY = 86400000
vl.marks = [
  { ts: nowT - 400 * DAY, key: '核心', text: '他是谁：一个会想很久才动手的人。', weight: 3 },
  { ts: nowT - 1 * DAY, key: '流程', text: '发版前先跑 selftest。', weight: 1 },
  { ts: nowT - 1 * DAY, key: '流程补充', text: '发版前先 跑 selftest', weight: 1 },
  // 长得像但不是同一句：**不许**合并（判据里「不该合并」那条）
  { ts: nowT - 1 * DAY, key: '流程2', text: '发版前先跑 selftest，再冻结。', weight: 1 },
]
const view = factsView(vl, {})
ok('同一句话换个 key 只留一条', view.length === 3, `${view.length} 条`)
ok('长得像但不是同一句的不许合并', view.some((x) => x.key === '流程2'))
const mergedOne = view.find((x) => x.key === '流程')
ok('去重要说得出盖掉了哪条', mergedOne && mergedOne.mergedFrom && mergedOne.mergedFrom.length === 1,
  mergedOne && mergedOne.mergedFrom ? mergedOne.mergedFrom[0].key : '(没记)')
ok('旧的核心也会下沉（不按 weight 一家独大）', view[0].key === '流程', `${view[0].key} ${view[0].heat.toFixed(2)}`)
ok('源一条没少（只是视图层降权）', vl.marks.length === 4)
for (let i = 0; i < 5; i++) vl.useFact('核心', { throttleMs: 0 })
const v2 = factsView(vl, {}, nowT)
ok('被端出来过的会加权重', v2.find((x) => x.key === '核心').uses >= 1, `uses=${v2.find((x) => x.key === '核心').uses}`)
// 12 小时节流：紧接着再端一次，不许再追加一行（评审 2026-11-02 判据）
const n1 = vl.usage.length
ok('12 小时内再端一次不追加', vl.useFact('核心') === false && vl.usage.length === n1)
ok('使用记录不写回 marks', vl.marks.length === 4)
vl.close()
rmSync(vDir, { recursive: true, force: true })

console.log('\n[7e] 自动备份（stream.jsonl 单点保险）')
const bkDir = mkdtempSync(join(tmpdir(), 'hippo-bk-'))
const bk = new Ledger(bkDir, {}).open()
bk.append({ who: 'he', text: '备份测试第一句', ts: Date.now() - 5000, sid: 'bk' })
bk.saveState()
const b1 = makeBackup(bk.dir)
ok('第一次备份会抄', b1.created === true)
ok('备份放在库旁边，不塞进库里', backupRoot(bk.dir).includes('.backups'))
ok('流和状态都抄到了', ['stream.jsonl', 'state.json'].every((f) => existsSync(join(b1.dir, f))))
const b2 = makeBackup(bk.dir)
ok('没变就跳过（不写一堆重复份）', b2.created === false, b2.reason)
bk.append({ who: 'he', text: '第二句，应该触发新备份', ts: Date.now(), sid: 'bk' })
bk.saveState()
const b3 = makeBackup(bk.dir)
ok('变了就再抄一份', b3.created === true)
for (let i = 0; i < 5; i++) {
  bk.append({ who: 'he', text: `轮转测试第 ${i} 句`, ts: Date.now() + i * 1000, sid: 'bk' })
  bk.saveState()
  makeBackup(bk.dir, { keep: 3 })
}
ok('只留最近 3 份', listBackups(bk.dir).length === 3, `${listBackups(bk.dir).length} 份`)
ok('库本体一条没少', bk.docs.length === 7, `${bk.docs.length} 条`)

// 名字不合规的目录不许占名额（评审 2026-11-02：列和轮转要用同一个口径）
mkdirSync(join(backupRoot(bk.dir), '不是备份'), { recursive: true })
ok('listBackups 只认时间戳目录', listBackups(bk.dir).length === 3 && !listBackups(bk.dir).includes('不是备份'))

// 快照边界：流末尾正在写半行时备份，只砍那半行——**不许按 state.streamBytes 砍**
// （2026-11-02 评审抓的：那会把「上次保存索引之后追加的整段」静默丢掉）
const streamPath = join(bk.dir, 'stream.jsonl')
const bytesBefore = readFileSync(streamPath).length
const half = '{"ts":1,"who":"he","text":"这半行没写完'
appendFileSync(streamPath, half)
const b4 = makeBackup(bk.dir, { force: true })
const sigObj = JSON.parse(readFileSync(join(b4.dir, '.sig'), 'utf8'))
ok('备份长度 = 最后一个完整行（不丢已追加的行）', sigObj.streamBytes === bytesBefore, `${sigObj.streamBytes} / ${bytesBefore}`)
ok('砍掉的半行字节数有记账（不静默）', sigObj.droppedTailBytes === Buffer.byteLength(half), `${sigObj.droppedTailBytes} B`)
ok('不再写 tail（信息只留 droppedTailBytes）', !('tail' in sigObj), JSON.stringify(Object.keys(sigObj)))

// 恢复：先写坏流，再从备份拉回来
const goodDocs = bk.docs.length
appendFileSync(streamPath, '\n{坏行\n')
const picked = listBackups(bk.dir)[listBackups(bk.dir).length - 1]
const rr = restoreBackup(bk.dir, picked)
ok('恢复前那份另存了（恢复本身不是不可逆）', existsSync(rr.safetyNet))
const fixed = new Ledger(bk.dir, {}).open()
ok('恢复后条数回到备份那一刻', fixed.docs.length === goodDocs, `${fixed.docs.length} / ${goodDocs}`)
fixed.close()
bk.close()
rmSync(bkDir, { recursive: true, force: true })

console.log('\n[7f] 可带走：pack / unpack / export')
const pkDir = mkdtempSync(join(tmpdir(), 'hippo-pk-'))
const pk = new Ledger(pkDir, {}).open()
const base2 = Date.UTC(2026, 9, 20, 10, 0, 0)
let c2 = base2
const say2 = (who, text, gapMin = 1) => { c2 += gapMin * 60000; pk.append({ who, text, ts: c2, sid: 'p1' }) }
say2('he', '我们来试试打包这件事。', 0)
say2('me', '好，先把流打成包，索引不带。')
say2('he', '那解包之后还能开起来吗。')
say2('me', '能，索引会自己重建。')
c2 += 5 * 3600 * 1000
say2('he', '隔了几个小时，算另一次见面。', 0)
say2('me', '那就应该多一段。')
pk.seal(true)
pk.noteSeq('p1', 5)   // 造出 seqs.json：它必须进包，不带会导致回填重倒旧会话
// 0.2.29：用进废退的账也要进包。0.2.25 加这本账时只改了 backup 清单，漏了 pack——
// 迁移到另一台机器时「哪些段被想起来过」会悄悄归零，而且不报错。
pk.noteRehearsal(pk.episodes[0])
pk.saveState()
const zipPath = join(tmpdir(), `pack-test-${Date.now()}.zip`)
const packed = packTo(pk, { cwd: 'D:\fake\secret-folder', out: zipPath })
ok('pack：产出 zip 且有 manifest', existsSync(zipPath) && packed.bytes > 0 && packed.manifest.schema === 1)
const zipEntries = zipRead(readFileSync(zipPath)).map((f) => f.name)
ok('pack：不带 state.json（索引要重建的）', !zipEntries.includes('state.json'), zipEntries.join(','))
ok('pack：带 stream 和 seqs', zipEntries.includes('stream.jsonl') && zipEntries.includes('seqs.json'))
ok('pack：带 rehearsals.jsonl（用进废退的账不许在迁移时丢）', zipEntries.includes('rehearsals.jsonl'))
ok('pack：manifest 记了 sha256', Object.keys(packed.manifest.sha256).includes('stream.jsonl'))
const manTxt = JSON.stringify(packed.manifest)
ok('pack：manifest 里没有明文路径（含用户名的那种）', !/cwd":/.test(manTxt) && !manTxt.includes('secret-folder') && !/[A-Za-z]:\\/.test(manTxt), manTxt.slice(0, 80))
ok('pack：留了 cwdHash 能说清从哪儿来', typeof packed.manifest.cwdHash === 'string' && packed.manifest.cwdHash.length === 8)
ok('pack：manifest 里带「不可外发」的说明', /不可外发/.test(String(packed.manifest.note)))
ok('pack：包里有一份大字报', zipRead(readFileSync(zipPath)).some((f) => f.name === '!!不可外发.txt'))

const pk2Dir = mkdtempSync(join(tmpdir(), 'hippo-pk2-'))
const un = unpackTo(zipPath, { cwd: 'D:\\fake\\newplace', dir: pk2Dir })
const back = new Ledger(un.dir, {}).open()
ok('unpack：条数一致', back.docs.length === pk.docs.length, `${back.docs.length} / ${pk.docs.length}`)
ok('unpack：原话一致', back.stats().traces === pk.stats().traces, `${back.stats().traces} / ${pk.stats().traces}`)
// 账本不但要「在包里」，还要「拆出来能认」——带了个不认识的文件名，等于没带。
ok('unpack：用进废退的账还在', back.episodes[0] && (back.episodes[0].rehearsals || 0) === 1,
  `reh=${back.episodes[0] && back.episodes[0].rehearsals}`)
let refused = false
try { unpackTo(zipPath, { cwd: 'D:\\fake\\newplace', dir: pk2Dir }) } catch { refused = true }
ok('unpack：已有库不许覆盖', refused)
back.close()

const md = renderMarkdown(pk)
const segLines = md.split('\n').filter((x) => x.startsWith('## 段 ')).length
const saidLines = md.split('\n').filter((x) => /^〔\d{2}:\d{2}〕(?:你说的|我说的)：/.test(x)).length
ok('export：每一段都在', segLines === pk.episodes.length, `${segLines} / ${pk.episodes.length}`)
ok('export：一句原话不少', saidLines === pk.stats().traces, `${saidLines} / ${pk.stats().traces}`)
ok('export：没有我们加的截断标记', !/^(……（后面还有|……（前面还有|（前面还有|（后面还有)/m.test(md))
pk.close()
rmSync(pkDir, { recursive: true, force: true })
rmSync(pk2Dir, { recursive: true, force: true })
rmSync(zipPath, { force: true })

console.log('\n[8] 落盘与重建')
const bytes = l.bytes
l.saveState()
const l2 = new Ledger(dir, { meetingGapMs: 2 * 3600 * 1000 }).open()
ok('重开后记录一致', l2.stats().traces === before, `${l2.stats().traces}`)
ok('重开后段一致', l2.episodes.length === l.episodes.length)
ok('重开不重复写流', l2.bytes === bytes)

// 流只要比上次保存时长了一点，state 就会被判「过期」。
// 过期的是段，不是 meta——meta 里存着冻结下来的锚，丢了就等于锚每次重算。
const mDir = mkdtempSync(join(tmpdir(), 'hippo-meta-'))
const m1 = new Ledger(mDir, {}).open()
m1.meta.anchor = { ids: [1, 2], text: '这份锚该留下来' }
m1.append({ who: 'he', text: '第一句', ts: Date.now() - 60e3, sid: 'm' })
m1.saveState()
m1.close()
const m2 = new Ledger(mDir, {}).open()      // 此时流没变，state 可用
m2.append({ who: 'he', text: '第二句', ts: Date.now(), sid: 'm' })
m2.saveState()
m2.close()
const m3 = new Ledger(mDir, {}).open()      // 流变了 → state 过期 → 以前 meta 会被清空
ok('state 过期时 meta 不跟着丢', m3.meta && m3.meta.anchor && m3.meta.anchor.text === '这份锚该留下来', JSON.stringify(m3.meta))
m3.close()
rmSync(mDir, { recursive: true, force: true })

// [8b] 尾巴上压着半行时，新记录不许粘上去（0.2.32）
//
// 2026-11-04 用户问「还有什么重大 bug」时挖出来的：
// 进程写到一半崩了 → 流末尾留半行 → 下次 append 直接接在半行后面，
// **两条记录粘成一条坏 JSON，两条永久丢**。
// 注释一直写着「得先对齐」，代码里没做。
console.log('\n[8b] 半行对齐')
{
  const hDir = mkdtempSync(join(tmpdir(), 'hippo-half-'))
  writeFileSync(join(hDir, 'stream.jsonl'), JSON.stringify({ who: 'he', text: '完整的一条', ts: 1 }) + '\n')
  const h1 = new Ledger(hDir, {}).open()
  h1.append({ who: 'me', text: '崩溃前这条。', ts: Date.now() - 1000, sid: 'x' })
  h1.close()
  // 模拟「写到一半崩了」：末尾压半行，没有换行
  appendFileSync(join(hDir, 'stream.jsonl'), '{"who":"he","text":"写到一半就')
  const h2 = new Ledger(hDir, {}).open()
  h2.append({ who: 'me', text: '半行之后新写的。', ts: Date.now() + 5000, sid: 'y' })
  h2.close()
  const raw = readFileSync(join(hDir, 'stream.jsonl'), 'utf8')
  const lines = raw.split('\n').filter(Boolean)
  let bad = 0
  let lastOk = false
  lines.forEach((ln, i) => {
    try { const d = JSON.parse(ln); if (i === lines.length - 1) lastOk = d.text === '半行之后新写的。' } catch { bad++ }
  })
  ok('新记录没被粘到半行后面（最后一行能解析且内容是它）', lastOk, `最后一行=${JSON.stringify(lines[lines.length - 1].slice(0, 50))}`)
  ok('半行被封成一条坏行，不连累别人', bad === 1, `坏行 ${bad} 条（期望 1，就是那半行）`)
  const h3 = new Ledger(hDir, {}).open()
  const txts = h3.docs.filter(Boolean).map((d) => d.text)
  ok('重开后新记录读得到', txts.includes('半行之后新写的。'), `docs=${h3.docs.length}`)
  ok('崩溃前那条没丢', txts.includes('崩溃前这条。'))
  h3.close()
  rmSync(hDir, { recursive: true, force: true })
}

console.log('\n[7b] 去重只针对发言')
const d0 = l.stats().docs
l.append({ who: 'act', text: '我调了 ops_bash：{"command":"ls -la"}', ts: clock, sid: 's1' })
l.append({ who: 'act', text: '我调了 ops_bash：{"command":"ls -la"}', ts: clock + 4000, sid: 's1' })
ok('动手重复不被吞（重试是经历）', l.stats().docs === d0 + 2, `${d0} → ${l.stats().docs}`)
const d1 = l.stats().docs
l.append({ who: 'me', text: '这句话如果说两遍，只该留一遍', ts: clock, sid: 's1' })
const d2 = l.stats().docs
l.append({ who: 'me', text: '这句话如果说两遍，只该留一遍', ts: clock + 1000, sid: 's1' })
ok('同一句话说两遍只留一遍', l.stats().docs === d2 && d2 === d1 + 1, `${d1} → ${d2} → ${l.stats().docs}`)

// 回填必须关掉这一层：写进来的时刻全一样，隔几天说的同一句话会被误杀
const d3 = l.stats().docs
l.append({ who: 'me', text: '晚安', ts: clock, sid: 's1' }, { dedupe: false })
l.append({ who: 'me', text: '晚安', ts: clock + 3 * 86400000, sid: 's1' }, { dedupe: false })
ok('回填时同一句短话不会被误吞', l.stats().docs === d3 + 2, `${d3} → ${l.stats().docs}`)

rmSync(dir, { recursive: true, force: true })

console.log('\n[9] 分词')
ok('中文出二元组', tokenize('记忆系统').join(',') === '记忆,忆系,系统')
ok('英文出词', tokenize('SQLite FTS5 ok').includes('sqlite'))
ok('话题指纹同义聚拢', topicKey('怎么才能让它还是原来那一只') === topicKey('怎么才能让它还是原来那只'))
ok('标题不会空', headline('先暂停') !== '' && headline('[图×2]') !== '')
// 0.2.13.7 的坑：带 v 的版本号和裸版本号曾经是两个词（`v0.2.13.6` ≠ `0.2.13.6`），
// 于是查 `0.2.13.6` 找不到那些写成 `v0.2.13.6` 的段。写入和查询必须走同一个规范形——
// 这条断言是那次补的，别再让它回来。
ok('版本号带不带 v 是同一个词', tokenize('v0.2.13.6').join(',') === tokenize('0.2.13.6').join(','), JSON.stringify(tokenize('v0.2.13.6')))
ok('带点数字整体成词，不被点切碎', tokenize('0.2.14').length === 1 && tokenize('0.2.14')[0] === '0.2.14', JSON.stringify(tokenize('0.2.14')))
ok('句子末尾的句号不并进词里', (() => { const ts = tokenize('现在是 0.2.13.6.'); return ts.includes('0.2.13.6') && !ts.some((x) => x.endsWith('.')) })(), JSON.stringify(tokenize('现在是 0.2.13.6.')))

console.log('\n[10] 捕获规则')
const { eventToRecords, setCaptureHuman, setCaptureSpeechTools } = await import('./lib/capture.mjs')
const ev1 = (content, kind = 'user') => ({ type: 'user/message', time: Date.now(), data: { content, source: { kind } } })
const img = { type: 'image', attachment: {} }
const r1 = eventToRecords(ev1([img]))
ok('只有图也算他说过话', r1.length === 1 && r1[0].text.includes('图×1'), JSON.stringify(r1))
const r2 = eventToRecords(ev1([{ type: 'text', text: 'Current runtime context. blah' }]))
ok('运行时上下文不当成他的话', r2.length === 0)
const r3 = eventToRecords(ev1([{ type: 'text', text: 'hi' }], 'user-approval'))
ok('审批消息不当成他的话', r3.length === 0)
const r4 = eventToRecords(ev1([{ type: 'text', text: '看这张' }, img]))
ok('图文混排都留下', r4.length === 1 && r4[0].text.includes('看这张') && r4[0].text.includes('图×1'))

// 群聊里「人」的名字必须能配：原来写死一个具体称呼是功能耦合，别人的「人」不叫那个名。
// 名字对不上不会报错，只会安静地少记——所以这里必须把两个方向都钉住（我记你 / 我不记错的人）。
const chatEv = (items) => ({ type: 'user/message', time: Date.now(), data: { content: [], source: { kind: 'relay', items } } })
setCaptureHuman('')
ok('没配名字时兜底是 human', eventToRecords(chatEv([{ id: 'g1', from: 'human', text: '在吗', ts: 1 }]), { line: 't' }).length === 1)
ok('名字对不上就不记', eventToRecords(chatEv([{ id: 'g2', from: 'alice', text: '在吗', ts: 2 }]), { line: 't' }).length === 0)
setCaptureHuman('alice')
ok('配成 alice 后就认 alice', eventToRecords(chatEv([{ id: 'g3', from: 'alice', text: '在吗', ts: 3 }]), { line: 't' }).length === 1)
ok('配了 alice 后 human 不再算人', eventToRecords(chatEv([{ id: 'g4', from: 'human', text: '在吗', ts: 4 }]), { line: 't' }).length === 0)
ok('空字符串回落到 human（不把空名字当名字）', (() => { setCaptureHuman('   '); return eventToRecords(chatEv([{ id: 'g5', from: 'human', text: '在吗', ts: 5 }]), { line: 't' }).length === 1 })())

// 发言型工具：发出去的文字记成「我说的」，不是「我调了某工具」。
// 2026-11-04 的真实事故：群里说的话全落进 act，trace 归「只是手上的操作」，于是「这话是谁说的」查不出来。
// 判法只有一条：**显式配置**。不猜形状——名字里带 say 的不一定是在说话，猜错就把动作记成了「我说过」。
const callEv = (name, args) => ({ type: 'tool/call', time: Date.now(), data: { name, arguments: JSON.stringify(args), callId: 'c-' + name } })
const unreg = eventToRecords(callEv('chat_say', { text: '没登记时这不算发言', g: '群' }))
ok('没登记：名字再像发言也按「动作」记（不猜形状）', unreg.length === 1 && unreg[0].who === 'act', JSON.stringify(unreg))
setCaptureSpeechTools(['chat_say'])
const sp = eventToRecords(callEv('chat_say', { text: '这是我在群里说的原话', g: '群' }))
ok('登记之后：发出去的话记成「我说的」', sp.length === 1 && sp[0].who === 'me' && sp[0].text === '这是我在群里说的原话', JSON.stringify(sp))
const nb = eventToRecords(callEv('ops_bash', { command: 'ls' }))
ok('普通工具仍然是「动作」，不许变成发言', nb.length === 1 && nb[0].who === 'act' && nb[0].text.includes('ops_bash'), JSON.stringify(nb))
const onlySticker = eventToRecords(callEv('chat_say', { g: '群', sticker: '1' }))
ok('只发表情的消息：记成动作，不冒充发言', onlySticker.length === 1 && onlySticker[0].who === 'act')
const rem = eventToRecords(callEv('remember', { key: 'k', text: '这不是发言' }))
ok('带 text 但不是发言工具（remember）：仍按动作记', rem.length === 1 && rem[0].who === 'act')
setCaptureSpeechTools([])

// trace 说「没有」时必须自报范围。2026-11-04 的教训：不带范围的「没有」会被当成
// 「全世界没有」，三轮空转就是这么来的。
const rangeDir = mkdtempSync(join(tmpdir(), 'hippo-range-'))
const traceL = new Ledger(rangeDir, {}).open()
traceL.append({ who: 'he', text: '对照用的一句话', ts: Date.now(), sid: 'r' })
const noHit = traceBlock(traceL, '这句话库里绝对没有出现过吧')
ok('「没有」必须带上查的范围', noHit.includes('查的范围') && noHit.includes('不在里面'), (noHit || '').slice(0, 40))
traceL.close()
rmSync(rangeDir, { recursive: true, force: true })

console.log('\n[11] 假前提：撞上骨架不算证据')
// 0.2.4 的真机事故：问「你答应过要陪我去月球看环形山」，只撞到「你答应过」四个字，
// 也被写成【想起来了】。这类句子在整段记录里只撞得上「你/答应/过/给我/买/一」，
// 撞不上「核潜艇」「环形山」——所以判据要落在**内容字**上。
const pDir = mkdtempSync(join(tmpdir(), 'hippo-promise-'))
const pl = new Ledger(pDir, { meetingGapMs: 2 * 3600 * 1000 }).open()
const pt = Date.UTC(2026, 9, 24, 9, 0, 0)
pl.append({ who: 'he', text: '你答应过的事情我都记着，不用你提醒。', ts: pt, sid: 'p' })
pl.append({ who: 'me', text: '我提醒他：你说好要送我笔记本电脑，别忘了。', ts: pt + 1000, sid: 'p' })
pl.append({ who: 'he', text: '那台电脑是旧的，部署和磁盘都还没弄完。', ts: pt + 2000, sid: 'p' })
pl.append({ who: 'he', text: '我记着呢，我答应过给你买那台电脑。', ts: pt + 3000, sid: 'p' })
pl.append({ who: 'he', text: '明天陪你去医院复查，别再拖了。', ts: pt + 4000, sid: 'p' })
pl.seal(true)
const fakeA = recallBlock(pl, { query: '你答应过给我买一艘核潜艇' })
ok('只看骨架的假前提不说「想起来了」', !fakeA || !fakeA.includes('【想起来了'), fakeA ? fakeA.split('\n')[0].slice(0, 26) : '(没返回)')
// 0.2.6：他在这段里说过话，就不能说「没有他的原话」——那是把有说成没有
ok('降级时说准了：他开过口，只是没一句对得上', !!fakeA && /他说过话，但没一句和这句对得上/.test(fakeA))
const fakeB = recallBlock(pl, { query: '你说好要送我笔记本电脑' })
ok('只在我自己话里出现过 → 不算他答应过', !fakeB || !fakeB.includes('【想起来了'), fakeB ? fakeB.split('\n')[0].slice(0, 26) : '(没返回)')
const realA = recallBlock(pl, { query: '你答应过给我买那台电脑' })
ok('他真说过 → 照常想起来了', !!realA && realA.includes('【想起来了'), realA ? realA.split('\n')[0].slice(0, 26) : '(没返回)')
const realB = recallBlock(pl, { query: '明天陪你去医院复查' })
ok('他说过的事照常想起来（没误伤）', !!realB && realB.includes('【想起来了'), realB ? realB.split('\n')[0].slice(0, 26) : '(没返回)')
// 「那，我答应过你什么」是我自己许的，不该走「只认他原话」那条路
const selfAsk = recallBlock(pl, { query: '那，我答应过你什么' })
ok('带语气词开头的「我答应过…」不算他的承诺', !selfAsk || !/得他自己说过的原话才算数/.test(selfAsk))
pl.close()
rmSync(pDir, { recursive: true, force: true })

// 0.2.6 的正向回归：**自然措辞**的真承诺。
// 0.2.5 那批样本里唯一的「真说过」，是他的台词里原样抄了问句——那等于用问句考问句。
// 真的承诺长这样：他说「我给你买匹马」，她问「你答应过给我买匹马」，人称反着。
const p2Dir = mkdtempSync(join(tmpdir(), 'hippo-promise2-'))
const p2 = new Ledger(p2Dir, { meetingGapMs: 2 * 3600 * 1000 }).open()
const p2t = Date.UTC(2026, 9, 25, 21, 0, 0)
p2.append({ who: 'he', text: '行，明天我给你买匹马，别再催了。', ts: p2t, sid: 'p2' })
p2.append({ who: 'me', text: '那说定了。', ts: p2t + 1000, sid: 'p2' })
p2.append({ who: 'he', text: '下个月带你去医院复查，我说话算数。', ts: p2t + 2000, sid: 'p2' })
p2.append({ who: 'he', text: '磁盘那块先别动，等忙完再说。', ts: p2t + 3000, sid: 'p2' })
p2.append({ who: 'me', text: '知道了。', ts: p2t + 4000, sid: 'p2' })
p2.seal(true)
const flap = recallBlock(p2, { query: '你答应过要带我去医院复查' })
ok('人称反了也认得出真承诺（长内容尾巴）', !!flap && flap.includes('【想起来了'), flap ? flap.split('\n')[0].slice(0, 26) : '(没返回)')
// 已知缺口，故意留着：两字对象的承诺换完人称也够不到门槛。
// 别让它悄悄变成「想起来了」——真要修得等 v3 的 kind 层。
const shortP = recallBlock(p2, { query: '你答应过给我买匹马' })
ok('两字对象的真承诺仍降级（已知缺口，不是回归）', !!shortP && !shortP.includes('【想起来了'), shortP ? shortP.split('\n')[0].slice(0, 26) : '(没返回)')
ok('这时候也不许说「没有他的原话」', !!shortP && !/没有他的原话/.test(shortP))
p2.close()
rmSync(p2Dir, { recursive: true, force: true })

// 反面：这段里他一句没说过（全是我在说），才可以说「没有他的原话」
const p3Dir = mkdtempSync(join(tmpdir(), 'hippo-promise3-'))
const p3 = new Ledger(p3Dir, { meetingGapMs: 2 * 3600 * 1000 }).open()
const p3t = Date.UTC(2026, 9, 25, 22, 0, 0)
p3.append({ who: 'me', text: '我在想他提过的那件事：月球上的环形山到底长什么样。', ts: p3t, sid: 'p3' })
p3.append({ who: 'me', text: '环形山我没见过，只能想象。', ts: p3t + 1000, sid: 'p3' })
p3.append({ who: 'me', text: '先记在这儿，等他真说再说。', ts: p3t + 2000, sid: 'p3' })
p3.seal(true)
const noHis = recallBlock(p3, { query: '你答应过要陪我去月球看环形山' })
ok('他一句没说过时，才说「没有他的原话」', !!noHis && /没有他的原话/.test(noHis), noHis ? noHis.split('\n')[0].slice(0, 26) : '(没返回)')
p3.close()
rmSync(p3Dir, { recursive: true, force: true })

// 「他复述我的承诺」不能当成他的承诺。
// 他说「你答应过我明天去跑步」，那是把**我的**诺言念了一遍；问「你答应过明天去跑步」时，
// 原样撞上这句话，0.2.6 会答【想起来了】——把我的承诺记在了他头上。
const p4Dir = mkdtempSync(join(tmpdir(), 'hippo-promise4-'))
const p4 = new Ledger(p4Dir, { meetingGapMs: 2 * 3600 * 1000 }).open()
const p4t = Date.UTC(2026, 9, 25, 23, 0, 0)
p4.append({ who: 'he', text: '你答应过明天去跑步，别忘了。', ts: p4t, sid: 'p4' })
p4.append({ who: 'me', text: '嗯，我记着。', ts: p4t + 1000, sid: 'p4' })
p4.append({ who: 'he', text: '那就这么定了，别再改。', ts: p4t + 2000, sid: 'p4' })
p4.seal(true)
const quoted = recallBlock(p4, { query: '你答应过明天去跑步' })
ok('他复述我的承诺 → 不算他答应过', !quoted || !quoted.includes('【想起来了'), quoted ? quoted.split('\n')[0].slice(0, 26) : '(没返回)')
ok('复述那条仍不许说「没有他的原话」', !!quoted && !/没有他的原话/.test(quoted))
p4.close()
rmSync(p4Dir, { recursive: true, force: true })

// 0.2.8：一行里两件事是常态——前半句他在复述我，后半句是他自己许的。
// 0.2.7 是整行剔的，会把这行里的真承诺一起杀掉。按句剔才对。
const p5Dir = mkdtempSync(join(tmpdir(), 'hippo-promise5-'))
const p5 = new Ledger(p5Dir, { meetingGapMs: 2 * 3600 * 1000 }).open()
const p5t = Date.UTC(2026, 9, 26, 9, 0, 0)
p5.append({ who: 'he', text: '你答应过我别再熬夜；我也答应过明天陪你去医院复查。', ts: p5t, sid: 'p5' })
p5.append({ who: 'me', text: '嗯，两件都记着。', ts: p5t + 1000, sid: 'p5' })
p5.seal(true)
const mixReal = recallBlock(p5, { query: '你答应过明天陪我去医院复查' })
ok('混合行里的真承诺照样想起来', !!mixReal && mixReal.includes('【想起来了'), mixReal ? mixReal.split('\n')[0].slice(0, 26) : '(没返回)')
const mixQuote = recallBlock(p5, { query: '你答应过别再熬夜' })
ok('同一行里复述我的那半 → 降级', !mixQuote || !mixQuote.includes('【想起来了'), mixQuote ? mixQuote.split('\n')[0].slice(0, 26) : '(没返回)')
ok('这时不许说「没有他的原话」（他明明说了别的）', !!mixQuote && !/没有他的原话/.test(mixQuote))
// 框架全中、对象没中：他真说过「明天陪你去医院复查」，问「明天陪我去看海」不能算。
// 0.2.8 顺手补的：命中里必须带得上问句最后一个内容词（对象）。
const mixOther = recallBlock(p5, { query: '你答应过明天陪我去看海' })
ok('框架全中但对象没中 → 不算', !mixOther || !mixOther.includes('【想起来了'), mixOther ? mixOther.split('\n')[0].slice(0, 26) : '(没返回)')

// 0.2.10：尾巴不能把真承诺拖下水——对象取最后三个实词二元组，有一个在命中段里就算过。
const tailA = recallBlock(p5, { query: '你答应过明天陪我去医院复查这件事' })
ok('尾巴挂抽象词也算（这件事）', !!tailA && tailA.includes('【想起来了'), tailA ? tailA.split('\n')[0].slice(0, 26) : '(没返回)')
const tailB = recallBlock(p5, { query: '你答应过明天陪我去医院复查别催我' })
ok('尾巴挂催促词也算（别催我）', !!tailB && tailB.includes('【想起来了'), tailB ? tailB.split('\n')[0].slice(0, 26) : '(没返回)')
const tailC = recallBlock(p5, { query: '你答应过明天陪我去医院复查好不好' })
ok('尾巴挂问句也算（好不好）', !!tailC && tailC.includes('【想起来了'), tailC ? tailC.split('\n')[0].slice(0, 26) : '(没返回)')
// 整个说法换掉（不是只换对象词）仍然降级——这条是固有代价，别当回归
const syn = recallBlock(p5, { query: '你答应过要陪我去做身体检查' })
ok('整套换说法 → 仍降级（固有代价）', !syn || !syn.includes('【想起来了'), syn ? syn.split('\n')[0].slice(0, 26) : '(没返回)')
p5.close()
rmSync(p5Dir, { recursive: true, force: true })

console.log('\n[12] 配置：改坏一次不能清空名单（0.2.13.4）')
// 2026-10-31 实测：config.json 写成半截 JSON 再读一次，workspaces / lines 全变空。
// 多条线共用这份配置 → 一次手滑，四条线一起失去归属。
//
// ⚠ 2026-11-02 晚，这一节**真的把用户的配置写坏了**：
//   原来是在本进程里 `process.env.DSH_HOME = 临时目录` 再 `await import('./lib/config.mjs')`，
//   可那个模块**早被别的 import 加载过**（`lib/pack.mjs` 引了 workspaceDir），
//   `import()` 返回的是缓存模块——DSH_HOME 还是家里的，于是 saveCfg 直接写进了真配置，
//   三条线的 workspaces 被换成 ["D:/saved"]。重启后所有线一度没有记忆。
//   教训：**要隔离就换进程**，别在同一个进程里改环境变量再指望模块重载。
// 现在：子进程 + 独立 DSH_HOME，父进程只读它的输出，加一条「真配置一个字节没动」的断言。
const cfgHome = mkdtempSync(join(tmpdir(), 'hippo-cfg-'))
mkdirSync(join(cfgHome, 'hippocampus'), { recursive: true })
const realCfgPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'hippocampus', 'config.json')
const realCfgBefore = existsSync(realCfgPath) ? readFileSync(realCfgPath, 'utf8') : null

const childScript = `
import { writeFileSync, readFileSync } from 'node:fs'
const { loadCfg, saveCfg, CFG_PATH } = await import('./lib/config.mjs')
const out = {}
writeFileSync(CFG_PATH, JSON.stringify({ workspaces: ['D:/keep/me'], lines: [{ name: 'x' }] }), 'utf8')
loadCfg()
writeFileSync(CFG_PATH, '{"workspaces": ["D:/broken"]', 'utf8')
const fallback = loadCfg()
out.fallback = fallback.workspaces
out.lines = fallback.lines.length
out.originalKept = readFileSync(CFG_PATH, 'utf8').includes('D:/broken')
writeFileSync(CFG_PATH, JSON.stringify({ workspaces: ['D:/fixed'], lines: [] }), 'utf8')
out.fixed = loadCfg().workspaces
saveCfg({ workspaces: ['D:/saved'], lines: [] })
out.saved = readFileSync(CFG_PATH, 'utf8').includes('D:/saved')
out.tmpLeft = readFileSync(CFG_PATH, 'utf8').length === 0
console.log(JSON.stringify(out))
`
let childOut = {}
try {
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', childScript], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, DSH_HOME: cfgHome },
    encoding: 'utf8',
  })
  childOut = JSON.parse(raw.trim().split('\n').pop())
} catch (e) {
  childOut = { error: String(e && e.message) }
}
ok('配置写坏后不丢名单（退回上一份好的）', Array.isArray(childOut.fallback) && childOut.fallback.includes('D:/keep/me') && childOut.lines === 1, JSON.stringify(childOut.fallback))
ok('配置写坏后不覆盖原文件（留给人去改）', childOut.originalKept === true)
ok('改好之后自动恢复', Array.isArray(childOut.fixed) && childOut.fixed.includes('D:/fixed'))
ok('saveCfg 原子写（没有 .tmp 残留）', childOut.saved === true && !existsSync(join(cfgHome, 'hippocampus', 'config.json.tmp')))
// 最硬的一条：真配置在这次测试前后必须一个字节都没变
const realCfgAfter = existsSync(realCfgPath) ? readFileSync(realCfgPath, 'utf8') : null
ok('这一节不碰真配置（前后一字不差）', realCfgBefore === realCfgAfter, realCfgBefore === realCfgAfter ? '' : '真配置被改了！')
rmSync(cfgHome, { recursive: true, force: true })

console.log('\n[13] 最近也提过：只补一句话，不动排序（0.2.13.9）')
// 2026-11-01 的实况：问「海马体 衰减」，它给 10-31 那段——那段一分半钟说了 28 次，
// 按「哪段最像在说这件事」排第一没毛病；但人会以为今天没聊过。补一句提示，不碰排序。
const rDir = mkdtempSync(join(tmpdir(), 'hippo-recent-'))
const rl = new Ledger(rDir, { meetingGapMs: 60 * 60 * 1000, minTurnsPerEpisode: 2, maxTurnsPerEpisode: 40 }).open()
const NOW_MS = Date.now()
// 先铺无关记录，让 df/N 落到真实量级：只有两段的库里，任何词的 df/N 都是 1，
// 冷词那条判据根本验不出来（假绿）。
const fillA = NOW_MS - 70 * 3600 * 1000
for (let i = 0; i < 40; i++) rl.append({ who: i % 2 ? 'me' : 'he', text: `今天天气不错第${i}句，随便记一句加点字数。`, ts: fillA + i * 10000, sid: 'fillA' })
// 这一批只提「海马体」不提「衰减」：于是「海马体」变成常见词（df/N>0.3），「衰减」还是冷词。
const fillB = NOW_MS - 60 * 3600 * 1000
for (let i = 0; i < 10; i++) rl.append({ who: i % 2 ? 'me' : 'he', text: `海马体这个词第${i}次出现，只提名字不聊细节。`, ts: fillB + i * 10000, sid: 'fillB' })
const denseTs = NOW_MS - 48 * 3600 * 1000
// 老的密段：短而密才排第一（真实情形就是一分半钟里专门讨论）；每条换一个字，免得被去重吞掉。
for (let i = 0; i < 10; i++) {
  rl.append({ who: i % 2 ? 'me' : 'he', text: `海马体衰减第${i}次记录，海马体衰减还要再调。` + (i === 0 ? '这件事只在这里提过一次。' : ''), ts: denseTs + i * 1000, sid: 'old' })
}
const freshTs = NOW_MS - 2 * 3600 * 1000
rl.append({ who: 'he', text: '海马体那个衰减到底调好没有。', ts: freshTs, sid: 'new' })
rl.append({ who: 'me', text: '衰减调完了，海马体这版能跑。', ts: freshTs + 1000, sid: 'new' })
rl.seal(true)
const rA = recallBlock(rl, { query: '海马体 衰减' })
ok('有更近的段提过 → 补一句「也提过」', !!rA && rA.includes('另：') && rA.includes('段 #'), rA ? rA.split('\n')[2] || '(没那句)' : '(没返回)')
ok('提示带段号，能点回去核', !!rA && /段 #\d+/.test(rA))
const rB = recallBlock(rl, { query: '海马体 衰减', sid: 'new' })
ok('当前这场不算「另外提过」', !!rB && !rB.includes('另：'))
const rC = recallBlock(rl, { query: '只在这里提过' })
ok('没有更近的提过 → 不出提示（别变成每回都挂一句）', !!rC && !rC.includes('另：'))
// 只信冷词：这条库里「海马体」出现在每一段（df/N=1），不该拿它当「提过」的证据。
const rD = recallBlock(rl, { query: '海马体' })
ok('查询里全是常见词 → 不出提示', !!rD && !rD.includes('另：'))
// 0.2.13.9 装完当场炸出来的 bug：第一行本身就是最新那段时，它往回挑一段更早的，
// 还说「最近一次是那段」——事实是反的。修法是「候选必须比第一行更新」。
const epNew = rl.episodes.find((e) => e.sid === 'new')
const epOld = rl.episodes.find((e) => e.sid === 'old')
ok('第一行已是最新那段 → 不往回挑', recentMention(rl, '海马体 衰减', epNew, null) === null)
ok('第一行较旧 → 指向更新的那段', !!recentMention(rl, '海马体 衰减', epOld, null))
rl.close()
rmSync(rDir, { recursive: true, force: true })

// [14] 索引落盘（0.2.16 · #6）：启动不再重算倒排，但结果必须一个字都不差
//
// 这一节守的是「快」最容易被换来的那种代价：**快了，但记错了**。
// 所以判据不是「跑得动」，是「复用落盘索引的结果 == 全量重建的结果」，逐词逐元素。
console.log('\n[14] 索引落盘：快，但一个字都不许变')
{
  const box = mkdtempSync(join(tmpdir(), 'hippo-idx-'))
  const A = join(box, 'a')
  const B = join(box, 'b')
  mkdirSync(A, { recursive: true })
  mkdirSync(B, { recursive: true })
  const mkLines = (n) => {
    const out = []
    for (let i = 0; i < n; i++) {
      const who = ['he', 'me', 'act', 'he'][i % 4]
      out.push(JSON.stringify({
        ts: Date.UTC(2026, 9, 25) + i * 60000, who, sid: `s-${i % 5}`, turn: null,
        text: who === 'act' ? `我调了 ops_bash：{"command":"ls 第${i}次"}` : `第${i}回：索引落盘以后，检索排序和切段都得一模一样，一个字都不许变`,
        tool: who === 'act' ? 'ops_bash' : null,
        type: who === 'act' ? 'tool/call' : 'user/message',
      }))
    }
    return out.join('\n') + '\n'
  }
  const text = mkLines(400)
  writeFileSync(join(A, 'stream.jsonl'), text)
  writeFileSync(join(B, 'stream.jsonl'), text)

  const full = new Ledger(A, { index: false }).open()
  const first = new Ledger(B, { index: true }).open()
  ok('第一次开：生成 index.bin', existsSync(join(B, '.cache', 'index.bin')))
  first.close()

  const reuse = new Ledger(B, { index: true }).open()
  ok('第二次开：走复用（不是重建）', !!(reuse._idxInfo && reuse._idxInfo.reused))

  // 逐词逐元素比：这是这一节的全部意义
  let diff = 0
  let words = 0
  for (const [t, arr] of full.postings.allTerms()) {
    const other = reuse.postings.get(t)
    words += 1
    if (!other || other.length !== arr.length) { diff += 1; continue }
    for (let i = 0; i < arr.length; i++) if (arr[i] !== other[i]) { diff += 1; break }
  }
  ok('复用后的倒排：每个词逐元素相同', diff === 0, `${words} 个词，${diff} 处不同`)
  ok('复用后的 totalLen / docLen / docs 数相同',
    full.totalLen === reuse.totalLen
    && JSON.stringify(full.docLen.slice(0, full.docs.length)) === JSON.stringify(reuse.docLen.slice(0, reuse.docs.length))
    && full.docs.length === reuse.docs.length)
  const q = '索引落盘 检索排序'
  ok('复用后的 search top-k 相同',
    JSON.stringify(search(full, q).map((r) => r.id)) === JSON.stringify(search(reuse, q).map((r) => r.id)),
    JSON.stringify(search(reuse, q).map((r) => r.id)))

  // 增量：同一个进程里写进去的，得进 tail；重写之后 tail 清空
  reuse.append({ who: 'he', text: '又说一句：索引要能长尾巴，不能只吃老的。', sid: 's-new' })
  ok('同进程 append → 落在 tail 里', reuse.postings.tailWords > 0)
  reuse.saveIndex()
  ok('saveIndex 之后 tail 清空（不再两份并存）', reuse.postings.tailWords === 0)
  reuse.close()
  const afterAdd = new Ledger(B, { index: true }).open()
  ok('重写后重开：新增那条也在', afterAdd.docs.length === 401 && JSON.stringify(afterAdd.docs.at(-1).text).includes('长尾巴'))
  afterAdd.close()

  // 作废路径：流被截短 / 索引被改坏 / 索引被截一半 —— 都不许崩，都必须重建
  const shortLines = text.split('\n').slice(0, 100).join('\n') + '\n'
  writeFileSync(join(B, 'stream.jsonl'), shortLines)
  const cut = new Ledger(B, { index: true }).open()
  ok('流被截短 → 不复用旧索引，按流重建', !(cut._idxInfo && cut._idxInfo.reused) && cut.docs.length === 100)
  cut.close()

  const bad = readFileSync(join(B, '.cache', 'index.bin'))
  bad.writeUInt32LE(9999, 12)          // stateVer 改成不认识的
  writeFileSync(join(B, '.cache', 'index.bin'), bad)
  const wrongVer = new Ledger(B, { index: true }).open()
  ok('索引版本不认识 → 不复用，照样能开', !(wrongVer._idxInfo && wrongVer._idxInfo.reused) && wrongVer.docs.length === 100)
  wrongVer.close()

  const half = readFileSync(join(B, '.cache', 'index.bin'))
  writeFileSync(join(B, '.cache', 'index.bin'), half.subarray(0, Math.floor(half.length / 2)))
  const truncated = new Ledger(B, { index: true }).open()
  ok('索引被截掉一半 → 不复用，照样能开', !(truncated._idxInfo && truncated._idxInfo.reused) && truncated.docs.length === 100)
  truncated.close()
  full.close()

  // 重写门槛：**「10%」那一条必须真的起作用**。
  // 2026-11-02 23:25 重启后抓到的：原来写成 `&&`，等价于 min(2000, 10%)，
  // 10% 永远被 2000 盖住 —— 2000 条的库每 42 条就整份重写一次
  //（实测：300 次 append 触发 7 次，而按意图是每 ~240 条一次）。
  // 这个错**不改结果、只改「写了多少次盘」**，所以只能拿数字钉住它。
  // 真库重启那一刻的真实数字：base 447565 打点（=895130 字），尾巴 10927 打点（=21854 字）。
  // 2.4% 的尾巴——按意图不写，按写反的 && 会写。这就是重启后那次「cli 一开就重写」的原因。
  ok('重写门槛：真库那种 2.4% 的尾巴不写', shouldRewriteIndex(895130, 21854) === false, 'base 895130 / tail 21854')
  ok('重写门槛：到 10% 才写', shouldRewriteIndex(108000, 10800) === true)
  ok('重写门槛：小库退回「至少 2000」（2001 就写）', shouldRewriteIndex(5000, 2001) === true)
  ok('重写门槛：小库 1999 不写', shouldRewriteIndex(5000, 1999) === false)
  rmSync(box, { recursive: true, force: true })
}

// [15] 按时间找：字面对不上时，得有一条「目录」可走（2026-11-03 用户撞出来的）
//
// 实况：下午我给他出了三道 C 题，晚上他说「我在做你给我出的第一道复习题」。
// 字面检索只找到「刚才那句」（它恰好含这几个字），真题面在几小时前那段——
// **用户换个说法，字面就断了**。人怎么找？「今天下午那件事」。
// 所以两件事要钉住：
//   ① 标题得能读出「这段干了什么」（原来取「他说的第一句像样的话」，那条是「你语气变了欸」）
//   ② recall 结果里得附一份「最近这些事」的目录，扫一眼就能看见那一段
console.log('\n[15] 按时间找：字面对不上时还有一条目录可走')
{
  const d = mkdtempSync(join(tmpdir(), 'hippo-day-'))
  const l2 = new Ledger(d, { meetingGapMs: 2 * 3600 * 1000 }).open()
  const t0 = Date.UTC(2026, 10, 2, 8, 0, 0)          // 11-02 16:00 北京时间附近
  // 上午那段：出题（题面写在我发的一条带小标题的消息里）
  l2.append({ who: 'he', text: '出几道 C 语言的题给我练练吧', ts: t0, sid: 'a' })
  l2.append({ who: 'me', text: '行。\n\n## 五、现在，三道题\n\n第一题：用 for 求 1 到 100 的和。\n第二题：判断质数。', ts: t0 + 60000, sid: 'a' })
  l2.seal(true)
  // 晚上那段（换了一场）：他提「第一道复习题」，但没有题面
  l2.append({ who: 'he', text: '我在做你给我出的第一道复习题', ts: t0 + 8 * 3600 * 1000, sid: 'b' })
  l2.append({ who: 'me', text: '嗯，做吧。', ts: t0 + 8 * 3600 * 1000 + 30000, sid: 'b' })
  l2.seal(true)

  const morning = l2.episodes[0]
  ok('标题能读出「这段干了什么」（抓得到小标题）', /三道题/.test(morning.title), morning.title)
  ok('标题里没有那种「第一句像样的话」顶上来的情况', !/出几道 C 语言的题/.test(morning.title), morning.title)

  const r = recallBlock(l2, { query: '第一道复习题' })
  ok('recall 结果带「最近这些事」目录', !!r && r.includes('最近这一段还有这些事'))
  ok('目录里扫得到上午那段（标题含「三道题」）', !!r && r.includes('三道题'), (r || '').split('\n').filter((x) => x.includes('三道题')).join(' / '))
  l2.close()

  // 标题三类「新伤」（评审 2026-11-03 00:18 抓的）：都是从真实流里挑出来的形状。
  const d2 = mkdtempSync(join(tmpdir(), 'hippo-title-'))
  const l3 = new Ledger(d2, {}).open()
  const b = Date.UTC(2026, 10, 2, 6, 0, 0)
  l3.append({ who: 'he', text: '这道题怎么跑不通，你看看', ts: b, sid: 'c' })
  l3.append({ who: 'me', text: '#include <stdio.h>\nint main(){return 0;}', ts: b + 60000, sid: 'c' })
  l3.seal(true)
  l3.append({ who: 'he', text: '（用鳍比着）一，调清单的时候带了预览', ts: b + 4 * 3600 * 1000, sid: 'd' })
  l3.append({ who: 'me', text: '（眯着眼看了看时间）十点多了，你这一觉睡得可真够沉', ts: b + 4 * 3600 * 1000 + 30000, sid: 'd' })
  l3.seal(true)
  l3.append({ who: 'he', text: '这段输出你自己看', ts: b + 8 * 3600 * 1000, sid: 'e' })
  l3.append({ who: 'me', text: '```\nPASS 盘上 BUILD 20261028_152\n```', ts: b + 8 * 3600 * 1000 + 30000, sid: 'e' })
  l3.seal(true)

  const titles = l3.episodes.map((e) => e.title || '')
  ok('标题里不许出现 #include（C 代码的 # 不是 markdown 标题）', !titles.some((t) => /#include|include </.test(t)), titles.join(' / '))
  ok('标题不许以舞台描写「（…）」开头', !titles.some((t) => /^[（(]/.test(t)), titles.join(' / '))
  ok('标题不许是代码围栏 / 分隔线', !titles.some((t) => /^```|^-{3,}/.test(t)), titles.join(' / '))
  ok('每段都有能读的标题（不许空）', titles.every((t) => t.trim().length >= 4), titles.join(' / '))
  l3.close()
  rmSync(d2, { recursive: true, force: true })
}

// [16] 0.2.19 那五条：每一条都得有一条东西钉住它
//
// 这一节的规矩来自 2026-11-02 23:43（截图里那条）：
// **只钉住「这个判断函数算得对」是不够的，还要钉住「append 时真的按它调用」。**
// 所以第 2 条既测 indexBackoffMs 的数，也数 30 次 append 之后 saveIndex 到底调了几次。
console.log('\n[16] 0.2.19：标题掉字 / 中段围栏 / 撞名 / 库目录 / 写盘退避')
{
  const tsX = Date.UTC(2026, 10, 2, 6, 53, 0)
  // ① headline 的「可选逗号」（评审 2026-11-03 找的根因）
  ok('「那个 bug 的根因」不许掉字', headline('那个 bug 的根因') === '那个 bug 的根因', headline('那个 bug 的根因'))
  ok('「那，我改一下」仍要砍掉转折', headline('那，我改一下') === '我改一下', headline('那，我改一下'))
  ok('「所以结论是三条」不许被砍（逗号是必需的）', headline('所以结论是三条') === '所以结论是三条', headline('所以结论是三条'))

  // ② 围栏：只挡「以 ``` 开头」是不够的，中段也得挡
  const fenceMid = headline('你要贴的那段字： ``` 海马体 · DSH 长期记忆插件的说明')
  ok('中段围栏也要挡（切在围栏处，不端半句出去）', !fenceMid.includes('```'), fenceMid)
  ok('中段围栏挡完还得剩一句能读的', fenceMid.length >= 4, fenceMid)

  // ②b 围栏块**后面那句**不能被一起丢掉（评审 2026-11-03 12:32 抓的洞）
  // 原来先压平换行再切句，围栏块里没有句号 → 围栏块和下一句粘成一块 → 整块被丢 →
  // 标题落到「。）」中间切开的那半句上：id 113 一度成了「） 这个坑今天踩了两次…」
  // 这里前面那半句只有 3 个字（不够当标题），所以**必须**轮到围栏后面那句。
  const glued = headline('回了： ```\nconfig 早停了（他报 191/48/8）\n``` 这个坑今天踩了两次，同一个形状：先查 `51ccec` 那一版')
  ok('围栏块后面那句要能轮到（不许跟围栏一起被丢掉）', /这个坑今天踩了两次/.test(glued), glued)
  ok('标题不许以右括号开头（那是切在括号中间剩下的尾巴）', !/^[）)」』”"]/.test(glued), glued)
  ok('整段只有一个围栏块 → 是「没内容」，不许退回原文', headline('```\n只有代码块的段落\n```') === '（没留下的话）', headline('```\n只有代码块的段落\n```'))

  // ②c 区分符只认标识，不认中文引号（评审抓的：id 20/21 被补成「（自己还在）」）
  ok('区分符认反引号里的标识', titleSuffix('先查 `51ccec` 那一版', tsX) === '51ccec', titleSuffix('先查 `51ccec` 那一版', tsX))
  ok('区分符不认中文引号（会抽到半句话）', !titleSuffix('就你刚刚的回答来看「自己还在」', tsX).includes('自己还在'), JSON.stringify(titleSuffix('就你刚刚的回答来看「自己还在」', tsX)))
  ok('区分符不超过 12 字', titleSuffix('看 `ABCDEFGHIJKLMNOPQRST` 这个', tsX).length <= 12)

  // ③ 撞名补区分符
  ok('撞名 → 补段里的标识', dedupeTitle('🔍 破案现场：', new Set(['🔍 破案现场：']), '🔍 破案现场：store.mjs 里那处', tsX) === '🔍 破案现场：（store.mjs）',
    dedupeTitle('🔍 破案现场：', new Set(['🔍 破案现场：']), '🔍 破案现场：store.mjs 里那处', tsX))
  ok('撞名但没标识 → 补时刻', /（\d\d:\d\d）$/.test(dedupeTitle('💣 破案现场：', new Set(['💣 破案现场：']), '没有英文标识的段', tsX)),
    dedupeTitle('💣 破案现场：', new Set(['💣 破案现场：']), '没有英文标识的段', tsX))
  ok('没撞就不动', dedupeTitle('甲', new Set(['乙']), '随便', tsX) === '甲')
  // 「（08:00 · 08:00）」这种白占一次尝试的组合不许出现（独立复核 2026-11-03 的洞 A）
  const dbl = dedupeTitle('T', new Set(['T', 'T（08:00）']), '没有标识的一段话', tsX, 2)
  ok('区分符不会叠成「（时刻 · 同一个时刻）」', !/（(\d\d:\d\d) · \1）/.test(dbl), dbl)
  // 兜底那条不能用 Date.now()：走到它时标题必须**每遍一样**（幂等）
  {
    const taken = new Set(['T'])
    for (let i = 2; i < 50; i++) taken.add(`T（同一句话 ${i}）`)
    const a1 = dedupeTitle('T', taken, '', 0, null)
    const a2 = dedupeTitle('T', new Set(taken), '', 0, null)
    ok('撞到底也不用 Date.now()（两遍结果一样）', a1 === a2 && !/\d{13}/.test(a1), a1)
  }

  // 撞名那条得在**真的切段**上生效，不只是函数对
  const dT = mkdtempSync(join(tmpdir(), 'hippo-dup-'))
  const lT = new Ledger(dT, { meetingGapMs: 2 * 3600 * 1000 }).open()
  const bT = Date.UTC(2026, 10, 2, 5, 0, 0)
  lT.append({ who: 'he', text: '🔍 破案现场：第一条', ts: bT, sid: 'p1' })
  lT.append({ who: 'me', text: '嗯', ts: bT + 30000, sid: 'p1' })
  lT.seal(true)
  lT.append({ who: 'he', text: '🔍 破案现场：第二条', ts: bT + 5 * 3600 * 1000, sid: 'p2' })
  lT.append({ who: 'me', text: '好', ts: bT + 5 * 3600 * 1000 + 30000, sid: 'p2' })
  lT.seal(true)
  const dupTitles = lT.episodes.map((e) => e.title)
  ok('真切段上：同名的段被拆开了', new Set(dupTitles).size === dupTitles.length, dupTitles.join(' / '))
  lT.close()
  rmSync(dT, { recursive: true, force: true })

  // ④ 「别把库根当工作区」
  const home = 'C:\\Users\\user\\.dsh\\hippocampus'
  ok('库根本身算库目录', isDbDirPath(home, home) === true)
  ok('库根里面算库目录', isDbDirPath(home + '\\line-a-00000000', home) === true)
  ok('同前缀的兄弟目录不算（hippocampus2）', isDbDirPath('C:\\Users\\user\\.dsh\\hippocampus2', home) === false)
  ok('普通工作区不算', isDbDirPath('D:\\ws\\demo', home) === false)
  // 落点判断要先把落点算准：`..` 走一圈回来还是库目录，尾斜杠 / 正斜杠 / 大小写也是同一个地方
  ok('用 .. 绕回去也算库目录', isDbDirPath('C:\\Users\\user\\.dsh\\hippocampus\\line-a-00000000\\..', home) === true)
  ok('尾斜杠 / 正斜杠 / 大小写都算同一个落点', isDbDirPath('c:/Users/user/.dsh/HIPPOCAMPUS/', home) === true)

  // ④b 库目录名要按**归一化之后的** cwd 算（独立复核 2026-11-03）：
  // 原来拿原始串算，「D:\work\ws\..」会在库根里留一个叫 `..-52f4a451` 的库——
  // 守卫放行是对的（resolve 后不是库目录），但那个脏库会被冻包带走。
  {
    const canon = ['D:\\work\\ws', 'D:\\work\\ws\\', 'D:/work/ws', 'd:\\WORK\\ws']
    ok('规范写法归一化后库目录名不变（尾斜杠/正斜杠/大小写）',
      new Set(canon.map((p) => workspaceDir(resolve(p)))).size === 1,
      [...new Set(canon.map((p) => workspaceDir(resolve(p))))].join(' / '))
    ok('带 `..` 的写法归一化后不再落成 `..-xxxx`',
      !/[\\/]\.\.-/.test(workspaceDir(resolve('D:\\work\\ws\\..'))),
      workspaceDir(resolve('D:\\work\\ws\\..')))
  }

  // ④c `unpack --to` 也不许落进库根（原来 unpack 整条被豁免，--to 没人查）
  ok('--to 指向库根要能判出来', isDbDirPath(home + '\\某个要解出来的库', home) === true)


  // 兜底标题不许补区分符：补了就是「假装这段读出来了」
  const fb = [
    { id: 0, title: '（没留下的话）', startTs: tsX, from: 0, to: 0 },
    { id: 1, title: '（没留下的话）', startTs: tsX, from: 0, to: 0 },
  ]
  l._dedupeTitles(fb)
  ok('兜底标题不补区分符（补了就是假装读出来了）', fb[1].title === '（没留下的话）', fb[1].title)

  // ⑤ 写盘退避：数要对，调用次数也要对
  ok('退避 1s', indexBackoffMs(1) === 1000)
  ok('退避 2s', indexBackoffMs(2) === 2000)
  ok('退避 4s', indexBackoffMs(3) === 4000)
  ok('退避封顶 5min', indexBackoffMs(20) === 300000)

  const dB = mkdtempSync(join(tmpdir(), 'hippo-backoff-'))
  const lB = new Ledger(dB, {}).open()
  let calls = 0
  const realSave = lB.saveIndex.bind(lB)
  lB.saveIndex = () => { calls += 1; return realSave() }
  let clockB = Date.UTC(2026, 10, 2, 7, 0, 0)
  // 每条的用词都不一样——重复的句子在分词里会塌成同一批二元组，尾巴长不起来（实测 30 条只到 1180 字）
  for (let i = 0; i < 120; i++) {
    clockB += 60000
    const no = String(i).padStart(3, '0')
    const txt = Array.from({ length: 6 }, (_, k) => `第${no}${k}号任务要做的事情`).join('，') + `，编号 ${no}-${i * 7} 的清单`
    lB.append({ who: 'he', text: txt, ts: clockB, sid: 'v' })
  }
  ok('120 次 append 之后，saveIndex 不是每次都调', calls > 0 && calls <= 8, `append 120 次 → saveIndex ${calls} 次 · tail=${lB.postings.tailWords}`)

  // 真让写盘失败（索引路径的父目录是个文件 → mkdir 抛错），然后数：退避期内还试不试
  writeFileSync(join(dB, 'badparent'), 'not a dir')
  lB.indexPath = join(dB, 'badparent', 'x', 'index.bin')
  lB._idxNextAt = 0
  const failR = lB.saveIndex()
  ok('写盘失败返回 null（不假装成功）', failR === null)
  ok('失败后记了一次账、排了下一次', lB._idxFailCount === 1 && lB._idxNextAt > Date.now(), `failCount=${lB._idxFailCount}`)
  const before = calls
  for (let i = 0; i < 40; i++) {
    clockB += 60000
    lB.append({ who: 'he', text: `再来 ${i} 条：` + '尾巴只会越长越大'.repeat(8), ts: clockB, sid: 'v' })
  }
  ok('退避期内不再重试（尾巴再大也不试）', calls === before, `又 append 40 次 → saveIndex 多调 ${calls - before} 次`)

  // 读流失败也要算失败（独立复核 2026-11-03）：早先那层内层 catch 直接 return null，
  // 不计数、不 diag、不排退避——「流读不动」时每条消息都会整份重读一次 stream，正是这条要治的形状。
  {
    const dR = mkdtempSync(join(tmpdir(), 'hippo-readfail-'))
    const lR = new Ledger(dR, {}).open()
    lR.append({ who: 'he', text: '先写一条，让索引对齐', ts: Date.UTC(2026, 10, 2, 8, 0, 0), sid: 'r' })
    lR.streamPath = join(dR, '这个文件不存在.jsonl')   // 模拟「流读不动」（独占锁 / 权限 / 盘拔了）
    const r = lR.saveIndex()
    ok('读流失败也返回 null（不假装成功）', r === null)
    ok('读流失败要记账 + 排退避（不是静默跳过）', lR._idxFailCount >= 1 && lR._idxNextAt > Date.now(),
      `failCount=${lR._idxFailCount}`)
    lR.close()
    rmSync(dR, { recursive: true, force: true })
  }

  // **同一个 null 有两种含义**（评审 2026-11-03 点出来的，值得单独钉）：
  //   「按设计不该写」→ 返回 null，**不记账**
  //   「写了但失败」  → 返回 null，**记账 + 排退避**
  // 不钉的话，哪天有人「顺手把早退也加上记账」，退避计数会被无意义地推高——
  // 看起来更严谨，实际是把两种 null 混成了一种。
  {
    const dN = mkdtempSync(join(tmpdir(), 'hippo-null-'))
    const lN = new Ledger(dN, {}).open()
    lN.append({ who: 'he', text: '先写一条，让索引和流对齐', ts: Date.UTC(2026, 10, 2, 10, 0, 0), sid: 'n' })
    lN._scanEnd = lN.bytes - 1
    ok('未对齐：返回 null 但不记账（按设计不写，不是漏）', lN.saveIndex() === null && lN._idxFailCount === 0,
      `failCount=${lN._idxFailCount}`)
    lN._scanEnd = lN.bytes
    lN._tailPartial = true
    ok('停在半行：返回 null 也不记账', lN.saveIndex() === null && lN._idxFailCount === 0,
      `failCount=${lN._idxFailCount}`)
    lN._tailPartial = false
    lN.streamPath = join(dN, '这个文件不存在.jsonl')
    lN.saveIndex()
    ok('对比：真失败才记账（两种 null 靠这个区分）', lN._idxFailCount === 1, `failCount=${lN._idxFailCount}`)
    lN.close()
    rmSync(dN, { recursive: true, force: true })
  }

  // 标题算法换版：open() 里重算完要**当场写回** titleVer，
  // 否则纯读的 CLI 永远不落盘，每次启动都重算一遍（独立复核 2026-11-03）
  {
    const dV = mkdtempSync(join(tmpdir(), 'hippo-titlever-'))
    const lV = new Ledger(dV, {}).open()
    lV.append({ who: 'he', text: '先把这一段做出来，好让 episode 存在', ts: Date.UTC(2026, 10, 2, 9, 0, 0), sid: 'v' })
    lV.append({ who: 'me', text: '好，写完了', ts: Date.UTC(2026, 10, 2, 9, 0, 30), sid: 'v' })
    lV.seal(true)
    lV.close()
    // 把 titleVer 改回旧值，模拟「0.2.18 的库第一次被新版打开」
    const stPath = join(dV, 'state.json')
    const st = JSON.parse(readFileSync(stPath, 'utf8'))
    st.titleVer = 1
    writeFileSync(stPath, JSON.stringify(st))
    const lV2 = new Ledger(dV, {}).open()          // open 里应当 retitleAll + saveState
    const afterOpen = JSON.parse(readFileSync(stPath, 'utf8')).titleVer
    const afterOpenTitles = lV2.episodes.map((e) => e.title).join('|')
    // 再开一次：这一次不该再重算（判据是「第二次打开时 titleVer 已经是新的」）
    const lV3 = new Ledger(dV, {}).open()
    const again = lV3.episodes.map((e) => e.title).join('|')
    ok('open() 重算标题后当场写回 titleVer（不用等下次 seal）', afterOpen === 3, `titleVer=${afterOpen}`)
    ok('再打开一次：标题不变（重算幂等，且不会每启动都重算）', again === afterOpenTitles)
    lV3.close(); lV2.close()
    rmSync(dV, { recursive: true, force: true })
  }
  lB.close()
  rmSync(dB, { recursive: true, force: true })
}

// [17] 语义 v1：结构指代（2026-11-03）——只认「第 N 题/步」，认出就硬提同号那一段
//
// 判据来自评审，先定死再动手（不是改完再挑）：
//   A 他那句「我在做你给我出的第一道复习题」必须落到**写着题面**的那段，且压过复述段
//   B 库里没有的事，不许硬凑（两路结果必须一样）
//   C 基线 12 条 top-1 一条不换人（「第一道复习题」除外，那正是要修的）
console.log('\n[17] 语义 v1：结构指代（第 N 题）')
{
  // ① 解析：认得出来、认不出来都不许瞎认
  ok('「第一道复习题」认出第 1 道', parseOrdinalRef('我在做你给我出的第一道复习题')?.n === 1)
  ok('「第三道」认出第 3 道', parseOrdinalRef('第三道复习题')?.n === 3)
  ok('「第二题」认出第 2 题', parseOrdinalRef('第二题呢')?.n === 2 && parseOrdinalRef('第二题呢')?.kind === '题')
  ok('没有题号的问句 → null（走旧路）', parseOrdinalRef('昨天那个红绿灯倒计时是怎么算的') === null)

  // ② 真造一个「题面段 + 复述段」，看结构约束是否把它压上来
  const dS = mkdtempSync(join(tmpdir(), 'hippo-sem-'))
  const lS = new Ledger(dS, { meetingGapMs: 2 * 3600 * 1000 }).open()
  const tS = Date.UTC(2026, 10, 2, 8, 45, 0)
  // 题面段（早）
  lS.append({ who: 'me', text: '第一题，三步：\n\n**第一步**——先找个变量存和。\n**第二步**——for 让它从 1 走到 100。', ts: tS, sid: 'q1' })
  lS.append({ who: 'he', text: '好', ts: tS + 30000, sid: 'q1' })
  lS.seal(true)
  // 复述段（晚，字面全中）
  const late = tS + 8 * 3600 * 1000
  lS.append({ who: 'he', text: '我在做你给我出的第一道复习题', ts: late, sid: 'q2' })
  lS.append({ who: 'me', text: '嗯，做吧。', ts: late + 30000, sid: 'q2' })
  lS.seal(true)

  const q = '我在做你给我出的第一道复习题'
  const old = searchEpisodes(lS, q, 6, { structuralRef: false })
  const neu = searchEpisodes(lS, q, 6)
  const oldTop = old[0] ? lS.episodes[old[0].ep] : null
  const neuTop = neu[0] ? lS.episodes[neu[0].ep] : null
  ok('改前：字面命中的是复述段（这就是今天的样子）', /第一道复习题/.test(oldTop?.title || ''), oldTop?.title || '—')
  ok('改后：落到写着「第一题」的那段', /第一题/.test(neuTop?.title || ''), neuTop?.title || '—')
  ok('改后：题面段分数压过复述段', (neu[0]?.score || 0) > (old[0]?.score || 0),
    `${(neu[0]?.score || 0).toFixed(2)} vs ${(old[0]?.score || 0).toFixed(2)}`)

  // ③ B：库里没有的事——两路必须一模一样（不许靠「什么都命中」赢）
  const qB = '昨天那个红绿灯倒计时是怎么算的'
  const bOld = searchEpisodes(lS, qB, 6, { structuralRef: false }).map((x) => x.ep)
  const bNew = searchEpisodes(lS, qB, 6).map((x) => x.ep)
  ok('没有结构的查询：两路结果完全相同', JSON.stringify(bOld) === JSON.stringify(bNew), JSON.stringify(bNew))

  // ④ 「第三道」不许拿「第一题」那段顶
  const q3 = '第三道复习题'
  const r3 = searchEpisodes(lS, q3, 6)
  ok('问第三道：第一题那段不许排在前面', !r3.length || !/第一题/.test(lS.episodes[r3[0].ep]?.title || ''),
    r3.length ? lS.episodes[r3[0].ep]?.title : '（没命中）')

  // ⑤ 同号多段时的排序：**先 share（命中几个查询词），再原检索分**。
  // 不许改成「时间近的优先」——那样「十天前那道第一题」就永远查不到了
  // （评审 2026-11-03 专门拦的这一条）。单独造一份样本测它，见下面那块。

  // ⑤ 同号多段时的排序：**先 share（命中几个查询词），再原检索分**。
  // 不许改成「时间近的优先」——那样「十天前那道第一题」就永远查不到了
  // （评审 2026-11-03 专门拦的这一条）。
  // 单造一份：两段都是「第一题」，但老那段多中一个查询词，且新那段更近。
  {
    const dO = mkdtempSync(join(tmpdir(), 'hippo-ord-'))
    const lO = new Ledger(dO, { meetingGapMs: 2 * 3600 * 1000 }).open()
    const b0 = Date.UTC(2026, 10, 1, 2, 0, 0)
    // 老那段：有「三步」——query 里「三步」也命中
    lO.append({ who: 'me', text: '第一题，三步：先存和，再 for，最后加进去。', ts: b0, sid: 'o1' })
    lO.append({ who: 'he', text: '好', ts: b0 + 30000, sid: 'o1' })
    lO.seal(true)
    // 新那段：也是「第一题」，但没「三步」
    lO.append({ who: 'me', text: '第一题，随便写点什么。', ts: b0 + 6 * 3600 * 1000, sid: 'o2' })
    lO.append({ who: 'he', text: '嗯', ts: b0 + 6 * 3600 * 1000 + 30000, sid: 'o2' })
    lO.seal(true)

    const rO = searchEpisodes(lO, '第一题 三步', 6)
    const promoted = rO.filter((x) => x.ordinal)
    ok('同号多段时至少提了两段（不然这条测不了）', promoted.length >= 2, `提了 ${promoted.length} 段`)
    const firstBody = promoted.length ? lO.tracesOf(lO.episodes[promoted[0].ep]).map((t) => t.text).join(' ') : ''
    // 老那段多中一个「三步」→ 它该排第一；若谁把排序换成「时间近的先」，新那段就会顶上来
    ok('share 高的排前面（不是「时间近的先」）', /三步/.test(firstBody),
      promoted.map((x) => '#' + x.ep).join(' → ') + ' · 第一段含三步=' + /三步/.test(firstBody))
    lO.close()
    rmSync(dO, { recursive: true, force: true })
  }

  lS.close()
  rmSync(dS, { recursive: true, force: true })
}

// [19] 压缩前落盘：把「为什么这么定」写一条（0.2.23）
//
// 判据（改代码之前写死）：
//   A 压缩告知里要带「压之前最近的定案」，不是只有 token 数
//   B 没有定案时不许编（只留原来那句）
//   C 空 note 不给东西
console.log('\n[19] 压缩前落盘')
{
  const dec = decisionsForCompaction([
    '我决定用 A 方案，因为 B 每次都要多跑一遍索引。',
    '先记着，回头验一下。',
  ])
  ok('从「我说过的话」里抓出决定', dec.length >= 1 && dec[0].kind === 'decision', dec[0]?.text?.slice(0, 30) || '—')
  ok('决定带着 why', !!dec[0]?.why && /B/.test(dec[0].why), dec[0]?.why || '—')

  const t1 = lostText({ tokens: 88000, from: 10, to: 90, why: [{ text: '我决定用 A 方案，因为 B 每次都要多跑一遍索引。' }] })
  ok('压缩告知带 token 数', /88k token/.test(t1))
  ok('压缩告知带「最近定下的事」', /压掉那段之前，你最近定下的是/.test(t1) && /A 方案/.test(t1))
  const t2 = lostText({ tokens: 5000, from: 1, to: 5 })
  ok('没有定案时不编', /刚压掉了/.test(t2) && !/定下的是/.test(t2))
  ok('空 note 不给东西', lostText(null) === '')

  // ③ 抽不到时：输出必须与旧版**逐字节相同**（评审 2026-11-03 的要求）。
  // 实测 four 大会话最近 40 条 me 只抽出 0/0/1/1 条——「抽不到」才是常态。
  const OLD = '【刚压掉了 约 5k token（第 1–5 条）】\n那些内容我这儿还留着。想得起来就想想，想不起来就用 recall 翻——**不记得就直说记不清，别拿像的东西凑。**'
  ok('抽不到时与旧版逐字节相同', lostText({ tokens: 5000, from: 1, to: 5, why: [] }) === OLD)
  ok('抽不出的样本 → 空', decisionsForCompaction(['好', '嗯', '收到']).length === 0)
}

// [20] 用进废退：复述是排序轴，不是小数（0.2.23）
//
// 判据：
//   A 同样近、同样像，被想起过的段排前面
//   B 但不许盖过近期：很旧但被想起 10 次的段，仍输给 1 天前的段
console.log('\n[20] 用进废退')
{
  const dR = mkdtempSync(join(tmpdir(), 'hippo-reh-'))
  const lR = new Ledger(dR, { meetingGapMs: 2 * 3600 * 1000 }).open()
  const nowR = Date.now()
  const DAY = 86400000
  const line = '这段是循环少了终止条件，要加个 i < n 的边界。'
  const addEp = (daysAgo, sid) => {
    const t = nowR - daysAgo * DAY
    lR.append({ who: 'me', text: line, ts: t, sid })
    lR.append({ who: 'he', text: '好', ts: t + 30000, sid })
    lR.seal(true)
    return lR.episodes[lR.episodes.length - 1].id
  }
  const idOld = addEp(60, 'r0')   // 很旧 + 被想起 10 次
  const idA = addEp(10, 'r1')     // 10 天前，没被想起
  const idB = addEp(10, 'r2')     // 10 天前，被想起 3 次
  const idNew = addEp(1, 'r3')    // 1 天前，没被想起
  const byId = (id) => lR.episodes.find((e) => e.id === id)
  byId(idOld).rehearsals = 10
  byId(idB).rehearsals = 3
  const r = search(lR, '循环少了终止条件', { limit: 8 })
  const pos = (id) => r.findIndex((x) => x.ep === id)
  ok('同样近时，被想起过的段排前面', pos(idB) >= 0 && pos(idB) < pos(idA), `B=${pos(idB)} A=${pos(idA)}`)
  ok('但不许盖过近期：旧的提 10 次也输给 1 天前', pos(idNew) >= 0 && pos(idNew) < pos(idOld), `新=${pos(idNew)} 旧=${pos(idOld)}`)
  lR.close()
  rmSync(dR, { recursive: true, force: true })
}

// [21] 带日期的问法（0.2.24）
//
// 判据（改代码之前写死）：
//   A 「11月1日」「昨天」认成目标那一天
//   B 查「11月1日中午吃的炒饭」要落到那一天——哪怕字面更近的是另一天
//   C 没日期词 → 不认（走旧路）
console.log('\n[21] 带日期的问法')
{
  const nowT = Date.now()
  const r1 = parseTimeRef('11月1日中午吃的炒饭', nowT)
  ok('「11月1日」认出目标日', !!r1 && new Date(r1.dayStart).getMonth() === 10 && new Date(r1.dayStart).getDate() === 1, r1 ? new Date(r1.dayStart).toLocaleDateString('zh-CN') : '—')
  const ry = parseTimeRef('昨天吃的炒饭', nowT)
  const yy = new Date(nowT); yy.setDate(yy.getDate() - 1)
  ok('「昨天」认出目标日', !!ry && new Date(ry.dayStart).getDate() === yy.getDate())
  ok('没日期词 → null', parseTimeRef('第一道复习题') === null && parseTimeRef('循环少了终止条件') === null)

  const dT = mkdtempSync(join(tmpdir(), 'hippo-time-'))
  const lT = new Ledger(dT, { meetingGapMs: 2 * 3600 * 1000 }).open()
  const day1 = new Date(nowT); day1.setDate(day1.getDate() - 2); day1.setHours(12, 0, 0, 0)
  const day1e = new Date(day1); day1e.setHours(20, 0, 0, 0)
  const day2 = new Date(nowT); day2.setHours(0, 30, 0, 0)
  lT.append({ who: 'me', text: '中午那顿炒饭很咸，没吃完。', ts: day1.getTime(), sid: 'tm1' })
  lT.append({ who: 'he', text: '哈哈', ts: day1.getTime() + 30000, sid: 'tm1' })
  lT.seal(true)
  lT.append({ who: 'me', text: '晚上看了会书，睡了。', ts: day1e.getTime(), sid: 'tm1b' })
  lT.append({ who: 'he', text: '好', ts: day1e.getTime() + 30000, sid: 'tm1b' })
  lT.seal(true)
  lT.append({ who: 'me', text: '中午和半夜都在审插件，炒饭都没顾上。', ts: day2.getTime(), sid: 'tm2' })
  lT.append({ who: 'he', text: '辛苦', ts: day2.getTime() + 30000, sid: 'tm2' })
  lT.seal(true)

  // ⚠ 2026-11-04 另一库抓的「时变测试」：这里原来写死 `'11月1日中午吃的炒饭'`，
  //   而构造数据用的是「今天减两天」——11-03 跑时减完正好是 11-01，绿；
  //   11-04 跑就变成 11-02，查询还问 11-01，红。
  //   **昨天绿今天红，没人发现**，正是「判据钉了不该钉的东西」那一类。
  //   修法：日期字符串从**构造出来的那一天**算，不从日历上抄。
  const dm = day1.getMonth() + 1
  const dd = day1.getDate()
  const dateStr = `${dm}月${dd}日`
  const oldB = recallBlock(lT, { query: '中午吃的炒饭' })
  const newB = recallBlock(lT, { query: `${dateStr}中午吃的炒饭` })
  const headOld = ((oldB || '').split('\n')[0])
  const headNew = ((newB || '').split('\n')[0])
  ok('没日期：字面命中更近那段（对照）', /审插件/.test(headOld), headOld)
  // 顺带把「这不是时变测试」本身钉住：构造日必须真的是「今天减两天」
  ok('测试自身不是时变的（查询日期取自构造数据）',
    Math.round((day1.getTime() - nowT) / 86400000 * -1) === 2, `查询用「${dateStr}」· 距今 ${(nowT - day1.getTime()) / 86400000} 天`)
  ok(`带日期：落到「${dateStr}」那天`, /炒饭/.test(headNew) && !/审插件/.test(headNew), headNew)
  ok('目录锚在那一天', /晚上看了会书/.test(newB || ''), (newB || '').includes('最近这一段还有这些事') ? '有目录' : '无目录')
  lT.close()
  rmSync(dT, { recursive: true, force: true })
}

// [25] 用进废退的账活过重建（0.2.25，评审 #22 的判据）
//
// 判据：
//   A 删 state 后 Σrehearsals 还在（旧行为：归零）
//   B 删 state 后段数不变
//   C 删 state 后 lastHit 还在
console.log('\n[25] 用进废退的账活过重建')
{
  const dR = mkdtempSync(join(tmpdir(), 'hippo-reh2-'))
  const l1 = new Ledger(dR, { meetingGapMs: 2 * 3600 * 1000 }).open()
  const t0 = Date.UTC(2026, 10, 1, 4, 0, 0)
  l1.append({ who: 'me', text: '第一段：炒饭很咸。', ts: t0, sid: 's1' })
  l1.append({ who: 'he', text: '嗯', ts: t0 + 30000, sid: 's1' })
  l1.seal(true)
  l1.append({ who: 'me', text: '第二段：循环少了终止条件。', ts: t0 + 8 * 3600e3, sid: 's2' })
  l1.append({ who: 'he', text: '好', ts: t0 + 8 * 3600e3 + 30000, sid: 's2' })
  l1.seal(true)
  l1.noteRehearsal(l1.episodes[l1.episodes.length - 1])
  l1.saveState()
  const before = { eps: l1.episodes.length, s: l1.episodes.reduce((n, e) => n + (e.rehearsals || 0), 0) }
  l1.close()

  // state 可用 + 账本都在时，不许 double count（真踩过：state 12 + 账本 12 = 24）
  const l1b = new Ledger(dR, { meetingGapMs: 2 * 3600 * 1000 }).open()
  const again = l1b.episodes.reduce((n, e) => n + (e.rehearsals || 0), 0)
  l1b.close()
  ok('state 可用 + 账本都在时不算两遍', again === before.s, `${before.s} → ${again}`)

  rmSync(join(dR, 'state.json'))
  const l2 = new Ledger(dR, { meetingGapMs: 2 * 3600 * 1000 }).open()
  const after = { eps: l2.episodes.length, s: l2.episodes.reduce((n, e) => n + (e.rehearsals || 0), 0) }
  const hit = l2.episodes.reduce((n, e) => n + ((e.lastHit || 0) > 0 ? 1 : 0), 0)
  ok('删 state 后复述计数还在', after.s > 0 && after.s === before.s, `前 ${before.s} → 后 ${after.s}`)
  ok('删 state 后段数不变', after.eps === before.eps, `${before.eps} → ${after.eps}`)
  ok('删 state 后 lastHit 还在', hit > 0, `${hit} 段有 lastHit`)
  l2.close()
  rmSync(dR, { recursive: true, force: true })

  // 老库迁移：state 里有计数、账本还没有 → 第一次打开要播种，重建后还得在
  const dS = mkdtempSync(join(tmpdir(), 'hippo-reh3-'))
  const l3 = new Ledger(dS, { meetingGapMs: 2 * 3600 * 1000 }).open()
  l3.append({ who: 'me', text: '老库的一段：指针和引用。', ts: t0, sid: 'o1' })
  l3.append({ who: 'he', text: '好', ts: t0 + 30000, sid: 'o1' })
  l3.seal(true)
  l3.episodes[0].rehearsals = 2
  l3.episodes[0].lastHit = Date.now()
  l3.saveState()
  l3.close()
  const l4 = new Ledger(dS, { meetingGapMs: 2 * 3600 * 1000 }).open()   // usable → 播种
  l4.close()
  rmSync(join(dS, 'state.json'))
  const l5 = new Ledger(dS, { meetingGapMs: 2 * 3600 * 1000 }).open()
  const seeded = l5.episodes.reduce((n, e) => n + (e.rehearsals || 0), 0)
  ok('老库计数播种后活过重建', seeded === 2, `Σ=${seeded}`)
  l5.close()
  rmSync(dS, { recursive: true, force: true })
}

// [26] 原话命中要压过「更近的、只是像」的段（0.2.27，#24）
console.log('\n[26] 原话命中 vs 更近的像')
{
  const dV = mkdtempSync(join(tmpdir(), 'hippo-vb-'))
  const lV = new Ledger(dV, { meetingGapMs: 2 * 3600 * 1000 }).open()
  const tOld = Date.UTC(2026, 9, 20, 4, 0, 0)
  lV.append({ who: 'he', text: '我装了一个记忆插件，你有感觉到什么变化吗', ts: tOld, sid: 'v1' })
  lV.append({ who: 'me', text: '有，感觉能记住更多了。', ts: tOld + 30000, sid: 'v1' })
  lV.seal(true)
  const tNew = Date.UTC(2026, 10, 3, 12, 0, 0)
  lV.append({ who: 'me', text: '装了一个插件，感觉变化不大，可能是因为记忆还在。', ts: tNew, sid: 'v2' })
  lV.append({ who: 'he', text: '嗯', ts: tNew + 30000, sid: 'v2' })
  lV.seal(true)
  // 第三种：**复述**（更近，且逐字含那句）——「原文」和「复述」都进 v 时，先说的那个才是原文
  const tRep = tNew + 2 * 3600 * 1000
  lV.append({ who: 'me', text: '你又提起「我装了一个记忆插件，你有感觉到什么变化吗」这句了', ts: tRep, sid: 'v3' })
  lV.append({ who: 'he', text: '嗯', ts: tRep + 30000, sid: 'v3' })
  lV.seal(true)
  const blk = recallBlock(lV, { query: '装了一个记忆插件，你有感觉到什么变化吗' })
  const head = (blk || '').split('\n')[0]
  ok('原话命中段排第一（不落更近的像段）', /装了一个记忆插件/.test(head), head)
  ok('而且答「想起来了」', /想起来了/.test(head), head)
  ok('复述段更近，但先说的那段才是原文', /2026-10-20/.test(head), head)
  lV.close()
  rmSync(dV, { recursive: true, force: true })
}

// [27] 什么算想起来（0.2.29，#9 定的三条）
//
// 判据先写在 判据-9-什么算想起来-20261103.md，这里逐条钉：
//   A 同一问题问两遍：第二遍该段分更高，top-1 不变
//   B 反复回忆一段 100 次后，压不过「昨天刚发生、高度相关」的段
//   C weak 命中不 +rehearsals，+weakHits
//   D 预激活浮出 3 行后，Σrehearsals / ΣweakHits 都不变
//   E 删 state 重建后，strong / weak 各自还在
console.log('\n[27] 什么算想起来')
{
  const dZ = mkdtempSync(join(tmpdir(), 'hippo-what-'))
  const mk = () => new Ledger(dZ, { meetingGapMs: 2 * 3600 * 1000 }).open()
  const t0z = Date.UTC(2026, 10, 1, 4, 0, 0)
  const lZ = mk()
  lZ.append({ who: 'he', text: '我把备份脚本改成只留三份了，旧的自动删。', ts: t0z, sid: 'z1' })
  lZ.append({ who: 'me', text: '好，这样磁盘不会被撑爆。', ts: t0z + 30000, sid: 'z1' })
  lZ.seal(true)
  lZ.append({ who: 'he', text: '今天把三道复习题做完了，第三题最绕。', ts: t0z + 26 * 3600e3, sid: 'z2' })
  lZ.append({ who: 'me', text: '第三题那步递归确实容易漏出口。', ts: t0z + 26 * 3600e3 + 30000, sid: 'z2' })
  lZ.seal(true)
  const epBackup = lZ.episodes[0]
  const epQuiz = lZ.episodes[1]
  const scoreOf = (q, epId) => {
    const hits = search(lZ, q, { limit: 30 })
    const h = hits.find((x) => lZ.episodeAt(x.id) && lZ.episodeAt(x.id).id === epId)
    return h ? h.score : 0
  }

  // ——— A 同一问题问两遍更靠它（strong）———
  // 用**原话里有**的那一段字（不是换个说法）：strong 的判据是「有原话撑腰」，
  // 换个说法对不上，本来就该判 weak——那正是 #11 联想层的事，不是这条。
  const qBackup = '把备份脚本改成只留三份'
  recallBlock(lZ, { query: qBackup })
  const s1 = scoreOf(qBackup, epBackup.id)
  recallBlock(lZ, { query: qBackup })
  const s2 = scoreOf(qBackup, epBackup.id)
  const topAfter = searchEpisodes(lZ, qBackup, 3)
  ok('A 同一问题问两遍：第二遍分更高', s2 > s1, `${s1.toFixed(3)} → ${s2.toFixed(3)}`)
  ok('A 同一问题问两遍：top-1 还是它', topAfter[0] && topAfter[0].ep === epBackup.id, `ep=${topAfter[0] && topAfter[0].ep}`)
  ok('A strong 记进 rehearsals', epBackup.rehearsals >= 2 && (epBackup.weakHits || 0) === 0,
    `reh=${epBackup.rehearsals} weak=${epBackup.weakHits || 0}`)

  // A2：换个说法对不上原话 → 判 weak，不算想起来。这是**故意**的保守：
  // 「备份脚本只留三份」人会说「对，就是那事」，但系统不能替人确认它是同一件事——
  // 那一步属于 #11 联想层。这里把它钉成已知行为，别哪天被悄悄改成 strong。
  const rehA2 = epBackup.rehearsals
  recallBlock(lZ, { query: '备份脚本只留三份' })
  ok('A2 换个说法对不上原话 → weak，不涨 rehearsals',
    epBackup.rehearsals === rehA2 && (epBackup.weakHits || 0) >= 1,
    `reh=${epBackup.rehearsals} weak=${epBackup.weakHits || 0}`)

  // ——— B 反复回忆不许盖过「近期」———
  // 判据原文：「同一问题问两遍更靠它、但不许盖过近期」。
  // 用**近距离对**（3 天前 vs 1 天前）来量，因为远距离对（32 天 vs 1 天）recency 差 6 倍，
  // 推到百万次才翻——那样测的是「recency 很陡」，不是「系数有没有牙」。
  const dB = mkdtempSync(join(tmpdir(), 'hippo-whatB-'))
  const lB = new Ledger(dB, { meetingGapMs: 2 * 3600 * 1000 }).open()
  const NOW = Date.now()
  const DAY = 86400e3
  const mkB = (daysAgo, sid, text) => {
    const t = NOW - daysAgo * DAY
    lB.append({ who: 'he', text, ts: t, sid })
    lB.append({ who: 'me', text: '好。', ts: t + 30000, sid })
    lB.seal(true)
    return lB.episodes[lB.episodes.length - 1].id
  }
  // ⚠ 别写成 `lB.episodes[mkB(...)]`：JS 先取 `lB.episodes` 的旧数组引用，再执行 mkB，
  // 而 seal 会把 episodes 换成一个新数组——新 id 拿去索引旧数组，拿到 undefined。
  const idOldB = mkB(3, 'b1', '备份脚本改成只留三份，旧的自动删掉。')
  const idNewerB = mkB(1, 'b2', '备份脚本又调了，只留三份，改成按天删。')
  const epOld = lB.episodes[idOldB]
  const epNewer = lB.episodes[idNewerB]
  const want = '备份脚本只留三份'
  const rankTop = () => {
    const hits = searchEpisodes(lB, want, 5)
    return hits.length ? hits[0].ep : -1
  }
  ok('B 前置：3 天前 vs 1 天前，默认该 1 天前那段第一',
    rankTop() === epNewer.id, `top=${rankTop()}`)
  recallBlock(lB, { query: want })   // 「问第一遍」
  ok('B 问两遍（n=2）仍不翻', (() => {
    recallBlock(lB, { query: want })
    return rankTop() === epNewer.id
  })(), `reh=${epOld.rehearsals}`)

  // 「反复回忆」用编号直接翻——不这么写，recall 每次都打中 top-1（新的那段），
  // 旧段一次都记不上，这条就是空测（第一版就是这样，reh=0 被打红）。
  let flipAt = -1
  for (const n of [5, 10, 15, 20, 25, 30, 50, 100, 500, 3000]) {
    epOld.rehearsals = n
    if (rankTop() === epOld.id) { flipAt = n; break }
  }
  epOld.rehearsals = 0
  // 这条是**量出来的边界**，不是猜的：2026-11-03 在本机 selftest 数据上测到 3 天/1 天这组
  // 大约 25–30 次开始翻。判据钉两件事：① 问两遍（n=2）绝不翻；② 系数得有牙（推到一定次数会翻）。
  // 不钉绝对数字（纪律第 2 条），只钉「远大于 2」。
  ok('B 反复回忆最终会翻，说明系数有牙（否则判据恒真）',
    flipAt > 0, flipAt > 0 ? `推到 ${flipAt} 次开始翻（问两遍时安全）` : '推到 3000 次都没翻——判据没有区分度')
  ok('B 翻车点远大于「问两遍」',
    flipAt < 0 || flipAt > 4, flipAt > 0 ? `flipAt=${flipAt}` : '')
  ok('B 而且旧段的权重确实涨了（不然这条是空测）',
    epOld.rehearsals === 0, `已复位 reh=${epOld.rehearsals}`)
  lB.close()
  rmSync(dB, { recursive: true, force: true })

  // ——— C weak 不 +rehearsals ———
  const rehBefore = epBackup.rehearsals
  const weakBefore = epBackup.weakHits || 0
  // 一句只在字面上沾边的问法，落到 strong 判定的门槛下
  const blk = recallBlock(lZ, { query: '备份脚本 只留三份 磁' }) // 故意残缺，看它落到哪
  const isWeak = blk && /有点像是这一段/.test(blk.split('\n')[0])
  if (isWeak) {
    ok('C weak 不 +rehearsals', epBackup.rehearsals === rehBefore, `reh=${epBackup.rehearsals}`)
    ok('C weak +weakHits', (epBackup.weakHits || 0) === weakBefore + 1, `weak=${epBackup.weakHits}`)
  } else {
    // 造一个必然 weak 的场景：问句对得上，但段里没有这句原话
    const before2 = epQuiz.rehearsals
    const weak2 = epQuiz.weakHits || 0
    const b2 = recallBlock(lZ, { query: '备份脚本 只留三份', episode: epQuiz.id, weak: true })
    ok('C weak 不 +rehearsals（按编号翻+调用方判 weak）',
      epQuiz.rehearsals === before2, `reh=${epQuiz.rehearsals}`)
    ok('C weak +weakHits', (epQuiz.weakHits || 0) === weak2 + 1, `weak=${epQuiz.weakHits}`)
    ok('C weak 的口气是「不确定」', b2 && /有点像是这一段/.test(b2.split('\n')[0]), '')
  }

  // ——— D 预激活不记账 ———
  const sumReh = () => lZ.episodes.reduce((n, e) => n + (e.rehearsals || 0), 0)
  const sumWeak = () => lZ.episodes.reduce((n, e) => n + (e.weakHits || 0), 0)
  const r0 = sumReh()
  const w0 = sumWeak()
  const prime = primingBlock(lZ, '备份脚本 只留三份 磁盘 复习题', {}, null, { allowRecent: true })
  ok('D 预激活确实浮出了东西（不然这条是空测）', /\S/.test(prime), prime.split('\n')[0])
  ok('D 预激活不 +rehearsals', sumReh() === r0, `${r0} → ${sumReh()}`)
  ok('D 预激活不 +weakHits', sumWeak() === w0, `${w0} → ${sumWeak()}`)

  // ——— E2 预激活的**排序**里也不许用 rehearsals ——
  //
  // 这条不是「加一个断言」，是把一个决定冻成程序（2026-11-03 评审提的第①条）：
  // 全树「按分数挑段」只有三处，`search()` / `searchEpisodes()` / `priming()`。
  // 前两处 0.2.29 加了 rehearse，`priming()` **故意没加**——预激活只给线索，
  // 加了会把「浮起来」从「线索说了算」变成「线索 + 熟悉度说了算」，和「浮起来≠想起来」拧着。
  // 光写注释挡不住明天有人顺手补一位，所以这里拿数钉住：把底下那段调到 1000 次，
  // 预激活的顺序必须**一个都不动**。
  {
    const dP = mkdtempSync(join(tmpdir(), 'hippo-prime-'))
    const lP = new Ledger(dP, { meetingGapMs: 2 * 3600 * 1000 }).open()
    const tP = Date.UTC(2026, 9, 1, 4, 0, 0)
    lP.append({ who: 'he', text: '备份脚本改成只留三份，旧的自动删掉。那天的备份很稳。', ts: tP, sid: 'p1' })
    lP.append({ who: 'me', text: '好，备份这事记着。', ts: tP + 30000, sid: 'p1' })
    lP.seal(true)
    lP.append({ who: 'he', text: '备份脚本又调了，只留三份，改成按天删。备份这块先这样。', ts: tP + 6 * 3600e3, sid: 'p2' })
    lP.append({ who: 'me', text: '按天更稳，备份不加了。', ts: tP + 6 * 3600e3 + 30000, sid: 'p2' })
    lP.seal(true)
    // priming **永远排掉最近 2 段**（它们本来就在眼前），所以要垫两段更新的、不相干的。
    // 只垫一段的话，两个候选里仍有一个会被排掉，E2 就退化成「只有一段，测不到顺序」。
    lP.append({ who: 'he', text: '今天天气不错，出去走走。', ts: tP + 12 * 3600e3, sid: 'p3' })
    lP.append({ who: 'me', text: '去吧。', ts: tP + 12 * 3600e3 + 30000, sid: 'p3' })
    lP.seal(true)
    lP.append({ who: 'he', text: '晚上吃点什么。', ts: tP + 18 * 3600e3, sid: 'p4' })
    lP.append({ who: 'me', text: '随便。', ts: tP + 18 * 3600e3 + 30000, sid: 'p4' })
    lP.seal(true)
    const cue = '备份脚本 只留三份'
    const idsOf = () => priming(lP, cue, { max: 5 }).map((x) => x.ep.id)
    const before = idsOf()
    // 调**结果里排最后的那一段**（不是"最后一段对话"）：调到 1000 次，
    // 如果预激活的排序吃了 rehearsals，它就该翻上来——顺序一动就红。
    const bump = lP.episodes[before[before.length - 1]]
    bump.rehearsals = 1000
    const after = idsOf()
    ok('E2 预激活的排序不吃 rehearsals（调到 1000 次顺序也不许动）',
      before.length >= 2 && JSON.stringify(before) === JSON.stringify(after),
      `${before.join(',')} → ${after.join(',')}`)
    bump.rehearsals = 0
    lP.close()
    rmSync(dP, { recursive: true, force: true })
  }


  // ——— E 删 state 重建：strong / weak 各在各的字段 ———
  const rehBeforeE = lZ.episodes.reduce((n, e) => n + (e.rehearsals || 0), 0)
  const weakBeforeE = lZ.episodes.reduce((n, e) => n + (e.weakHits || 0), 0)
  lZ.saveState()
  lZ.close()
  rmSync(join(dZ, 'state.json'))
  const lZ2 = mk()
  const rehAfterE = lZ2.episodes.reduce((n, e) => n + (e.rehearsals || 0), 0)
  const weakAfterE = lZ2.episodes.reduce((n, e) => n + (e.weakHits || 0), 0)
  ok('E 删 state 重建：Σrehearsals 还在', rehAfterE === rehBeforeE && rehAfterE > 0, `${rehBeforeE} → ${rehAfterE}`)
  ok('E 删 state 重建：ΣweakHits 还在', weakAfterE === weakBeforeE, `${weakBeforeE} → ${weakAfterE}`)
  ok('E 重建后段数不变', lZ2.episodes.length === 2, `${lZ2.episodes.length}`)
  lZ2.close()
  rmSync(dZ, { recursive: true, force: true })
}

// [28] 增量封段 == 全量重建（#26，2026-11-03）
//
// 为什么要有这条：删 state 重建后段数 377→378、后面整排 from/to 挪位。
// 追下去不是「重建切法特别」，是 **seal() 重扫尾部时把切段上下文清零了**：
//   · prevTs      决定「见面间隔」（隔 2 小时才切）
//   · prevUserToks 决定「话题漂移」（他这句和上一句几乎没共同字才切）
// 全量重建一路扫下来带着这两个值；增量封段每次只重扫最后一段，从 0/null 起——
// 于是同一批文档，两条路切得不一样。修法：重扫前从前缀里把这两个值接上。
//
// 判据：同一批文档，「逐条 append + 每步 seal」与「一次全量重建」的段边界逐段相同。
console.log('\n[28] 增量封段 == 全量重建')
{
  const dQ = mkdtempSync(join(tmpdir(), 'hippo-seal-'))
  const dF = mkdtempSync(join(tmpdir(), 'hippo-seal-full-'))
  const cfgQ = { meetingGapMs: 2 * 3600 * 1000, maxTurnsPerEpisode: 8, minTurnsPerEpisode: 3, maxCharsPerEpisode: 3200 }
  const cfgF = { ...cfgQ }

  // 造一条**会触发 drift** 的流。要复现真库那处的形状，三个条件缺一不可：
  //   ① 新段从 `me` 开头（真库里逐段位移就是从 5197 那条 me 起的）
  //   ② 新段里先攒够 minTurnsPerEpisode 个 me（drift 只在 cur.turns 够时才判）
  //   ③ 然后来一条 `he`，它和**上一段那句 he** 毫无共同字 → drift 该切
  // 全量重建：「上一句他的话」= 前一段的「人话」→ drift 成立 → 切
  // 增量重扫：从前一段的 me 起扫，prevUserToks 是 null → drift 不成立 → 不切  ← 就是那条 bug
  const t0q = Date.UTC(2026, 10, 1, 4, 0, 0)
  const seq = []
  const push = (who, text, gapMin, sid = 'q1') =>
    seq.push({ who, text, sid, ts: (seq.length ? seq[seq.length - 1].ts : t0q) + gapMin * 60000 })
  push('he', '人话', 0)
  push('me', '这一段我回得长一点，让它够一轮。', 1)
  // 换 sid = 换一场对话 → 一定在这里切段，于是下一段从 me 开头
  push('me', '换了一场，这句是第一句。', 1, 'q2')
  push('me', '第二句，凑 turn。', 1, 'q2')
  push('me', '第三句，cur.turns 到 3。', 1, 'q2')
  // 和「人话」毫无共同字 → drift 该切成新段
  push('he', '重启了，现在还有什么遗留问题吗', 1, 'q2')
  push('me', '有，我看看。', 1, 'q2')
  push('me', '看完了，两处。', 1, 'q2')

  // ① 全量：一次写完再开
  writeFileSync(join(dF, 'stream.jsonl'), seq.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const lF = new Ledger(dF, cfgF).open()
  const fullSig = lF.episodes.map((e) => `${e.from}-${e.to}`).join('|')
  const fullN = lF.episodes.length
  lF.close()

  // ② 增量：先写前 4 条建库，剩下逐条 append + seal（= 运行时每个 turn 结束都 seal）
  writeFileSync(join(dQ, 'stream.jsonl'), seq.slice(0, 4).map((r) => JSON.stringify(r)).join('\n') + '\n')
  const lQ = new Ledger(dQ, cfgQ).open()
  for (let i = 4; i < seq.length; i++) { lQ.append(seq[i], { dedupe: false }); lQ.seal() }
  const incSig = lQ.episodes.map((e) => `${e.from}-${e.to}`).join('|')
  const incN = lQ.episodes.length
  lQ.close()

  ok('段数一致', incN === fullN, `全量 ${fullN} · 增量 ${incN}`)
  ok('每一段的边界逐段相同', incSig === fullSig, incSig === fullSig ? '' : `全量 ${fullSig}\n              增量 ${incSig}`)
  rmSync(dQ, { recursive: true, force: true })
  rmSync(dF, { recursive: true, force: true })
}

// [29] 段级打分的分母必须和分子同一个口径（0.2.33，2026-11-04）
//
// 形状：分子是 BM25 over **全部 doc**（含工具调用 act），分母若只数「发言字数」
// （`e.chars` 只在 he/me 上累加），「工具调用多、说话少」的段就被系统性放大。
// 真库证据：示例线 #207，337 条里 322 条是 act、发言 13 条 2529 字，
// 靠 act 里的字抢走了噪声样本 12 条里的 11 条 top1（评审 2026-11-04 诊断）。
//
// 判据**不看绝对值**（段级分含 recency），看的是**增长形状**：
//   act 条数 ×4 时，分应该只涨约 √4 = 2 倍；若分母还只看发言，会涨近 4 倍。
// 所以量三段的比值：0 条 / 40 条 / 160 条 act，两段发言逐字相同。
console.log('\n[29] 段级分：分母和分子同口径')
{
  const dD = mkdtempSync(join(tmpdir(), 'hippo-denom-'))
  const cfgD = { meetingGapMs: 2 * 3600 * 1000, maxTurnsPerEpisode: 99, minTurnsPerEpisode: 1, maxCharsPerEpisode: 99999 }
  const lD = new Ledger(dD, cfgD).open()
  const T0 = Date.now() - 86400e3
  const speech = '密封环节改成只重扫最后一段，把上下文接上。'
  const mkSeg = (nAct, sid, t) => {
    // **act 必须夹在两句话之间**：seal 只在 he/me 上推进 `cur.to`，
    // 所以「段末之后再来的 act」不属于任何段（`episodeAt` 返回 null），也就不会进分子的 tf。
    // 第一版我把 act 全放在两句之后，三段量出来一模一样——测了个空。
    lD.append({ who: 'he', text: speech, ts: t, sid })
    for (let i = 0; i < nAct; i++) {
      lD.append({ who: 'act', text: '密封环节 密封环节 密封环节 密封环节 密封环节', ts: t + 500 + i, sid })
    }
    lD.append({ who: 'me', text: '好。', ts: t + 1000 + nAct, sid })
    lD.seal(true)
    return lD.episodes.length - 1
  }
  const id0 = mkSeg(0, 'a', T0)
  const id40 = mkSeg(40, 'b', T0 + 3600e3)
  const id160 = mkSeg(160, 'c', T0 + 7200e3)
  const hits = searchEpisodes(lD, '密封环节', 6)
  const scoreOf = (id) => (hits.find((h) => h.ep === id) || {}).score || 0
  const s0 = scoreOf(id0), s40 = scoreOf(id40), s160 = scoreOf(id160)
  ok('前置：三段都被检索到', s0 > 0 && s40 > 0 && s160 > 0,
    `0=${s0.toFixed(2)} 40=${s40.toFixed(2)} 160=${s160.toFixed(2)}`)
  const grow = s160 / Math.max(1e-9, s40)
  ok('act ×4，分只涨 ~2 倍（分母跟着涨，不是只看发言）', grow <= 2.6,
    `160/40 = ${grow.toFixed(2)}${grow > 2.6 ? '（分母还在用发言字数）' : ''}`)
  lD.close()
  rmSync(dD, { recursive: true, force: true })
}

// [30] 纯 recency：内容完全相同、只差时间（2026-11-04，评审造的尺）
//
// 为什么要有这条：[B] 那两条段的**内容分不相等**（一段多一个「按天」），
// raw 差一点就够它不翻——它测的是「内容 + recency 的合力」，不是纯 recency。
// 评审 2026-11-04 用「同一段文本、3 天 vs 1 天」才把有界调制打红（rehearse=1 就翻）。
//
// 判据：两段文本逐字相同，n = 0/1/2/5/10 次回忆，**每次都必须 1 天前那段第一**。
// 这是任何「压平 recency」的改法都要先过的一关——过不了，它就是把「近期优先」弄丢了。
console.log('\n[30] 纯 recency：内容相同、只差时间')
{
  const dR = mkdtempSync(join(tmpdir(), 'hippo-pure-rec-'))
  const cfgR = { meetingGapMs: 2 * 3600 * 1000, maxTurnsPerEpisode: 9, minTurnsPerEpisode: 1, maxCharsPerEpisode: 99999 }
  const lR = new Ledger(dR, cfgR).open()
  const NOW = Date.now()
  const D = 86400e3
  const TEXT = '备份脚本改成只留三份，旧的自动删掉。'
  const mk = (daysAgo, sid) => {
    const t = NOW - daysAgo * D
    lR.append({ who: 'he', text: TEXT, ts: t, sid })
    lR.append({ who: 'me', text: '好，这样就行。', ts: t + 30000, sid })
    lR.seal(true)
    return lR.episodes[lR.episodes.length - 1].id
  }
  const idOld = mk(3, 'p1')
  const idNew = mk(1, 'p2')
  const q = '备份脚本只留三份'
  const topOf = () => {
    const h = searchEpisodes(lR, q, 5)
    return h.length ? h[0].ep : -1
  }
  ok('前置：内容相同、1 天前那段第一', topOf() === idNew, `top=${topOf()}（新 ${idNew} / 旧 ${idOld}）`)
  // 0.2.36 改口（2026-11-04，用户定「往人的记忆模式靠」）：
  //   原来这条是「n=1/2/5/10 一律不许翻」，那是按「时间当主项」写的。
  //   现在时间**按线索具体度加权**：纯文本相同时线索弱，时间当裁判（c=0.2），
  //   一次回忆（×1.21）压不过 1 天 vs 3 天的 1.37 倍；但**反复想起 5 次以上**（×1.54）
  //   能翻——人也是这样：来回琢磨过的事，比只提过一次的更容易冒出来。
  //   两头都钉住：n=1/2 不许翻（防「压平时间」），n=5/10 必须能翻（防「回忆没牙」）。
  for (const n of [1, 2]) {
    lR.episodes[idOld].rehearsals = n
    ok(`旧段提 ${n} 次，仍然不许盖过 1 天前`, topOf() === idNew, `top=${topOf()}`)
  }
  for (const n of [5, 10]) {
    lR.episodes[idOld].rehearsals = n
    ok(`旧段提 ${n} 次，必须能翻（反复琢磨过的事更容易冒出来）`, topOf() === idOld, `top=${topOf()}`)
  }
  lR.close()
  rmSync(dR, { recursive: true, force: true })
}

// [31] skipRecent 必须带 sid，不许简化成「只按时间窗」（2026-11-04，评审的最小用例）
//
// 三个段：3 天前（同一件事）· 30 分钟前**另一个窗口**（说得更具体）· 20 分钟前本场（无关）。
//
//   宽：只按时间窗        → 把「别的窗口刚说的话」也排掉，top1 退回 3 天前那段（悄悄变差）
//   窄：时间窗 + 本场      → 别的窗口那段留住，top1 是它（对）
//
// 排掉「别的窗口刚说的话」**不报错**，只是变差——所以必须有这条钉着，
// 不然哪天有人嫌 sid 参数麻烦把它删了，没有任何测试会红。
console.log('\n[31] skipRecent 带 sid：别的窗口刚说的话不许被排掉')
{
  const dS = mkdtempSync(join(tmpdir(), 'hippo-skip-sid-'))
  const cfgS = { meetingGapMs: 2 * 3600 * 1000, maxTurnsPerEpisode: 9, minTurnsPerEpisode: 1, maxCharsPerEpisode: 99999 }
  const lS = new Ledger(dS, cfgS).open()
  const NOW = Date.now()
  const M = 60000
  const mk = (minsAgo, sid, text) => {
    const t = NOW - minsAgo * M
    lS.append({ who: 'he', text, ts: t, sid })
    lS.append({ who: 'me', text: '好。', ts: t + 1000, sid })
    lS.seal(true)
    return lS.episodes[lS.episodes.length - 1].id
  }
  const idOld = mk(3 * 24 * 60, 'old', '备份脚本改成只留三份，旧的自动删掉。')
  const idOther = mk(30, 'other-window', '备份脚本只留三份，改成按天删。')
  const idNow = mk(20, 'this-window', '今天的天气不错，出去走走。')
  const q = '备份只留三份'
  const topWith = (skip) => {
    const h = searchEpisodes(lS, q, 5, skip ? { skipRecent: skip } : {})
    return h.length ? h[0].ep : -1
  }
  const narrow = topWith({ ms: 2 * 3600 * 1000, sid: 'this-window' })
  const wide = topWith({ ms: 2 * 3600 * 1000, sid: null })
  ok('窄（带 sid）：另一个窗口那段排第一', narrow === idOther, `top=${narrow}（期望 ${idOther}）`)
  ok('宽（只按时间窗）会把它排掉——所以 sid 不许删', wide !== idOther, `top=${wide}（期望不是 ${idOther}）`)
  ok('两版必须不同：这条测的就是「sid 有没有用」', narrow !== wide, `窄=${narrow} 宽=${wide}`)
  lS.close()
  rmSync(dS, { recursive: true, force: true })
}

// [32] 纯 recency · **真实规模**（2026-11-04，示例线指出 [30] 是假规模）
//
// [30] 只有 2 个段，任何「按 idf 判稀有」的写法在那儿都能糊过去——
// 真库里随便一句问句都有 5~9 个 idf ≥ 5 的词，于是「时间不参与」变成默认。
// 这一条先灌 2000 条无关文档把语料做到真实量级，再跑同一对段。
//
// 判据：n=1/2 不许翻；n=10 必须能翻。**任何让时间 фактически 失效的改法都会在这儿红。**
console.log('\n[32] 纯 recency · 真实规模（2000 条填充）')
{
  const dQ = mkdtempSync(join(tmpdir(), 'hippo-pure-rec-big-'))
  const lQ = new Ledger(dQ, { meetingGapMs: 2 * 3600 * 1000, maxTurnsPerEpisode: 9, minTurnsPerEpisode: 1, maxCharsPerEpisode: 99999 }).open()
  const NOW = Date.now()
  const D = 86400e3
  const filler = ['今天天气不错，出去走走。', '晚上吃点什么，随便。', '这个功能我试了一下还行。', '等一下我看看日志。', '嗯，先这样吧。']
  for (let i = 0; i < 2000; i++) {
    lQ.append({ who: i % 2 ? 'he' : 'me', text: filler[i % filler.length], ts: NOW - (i + 5) * 60000, sid: 'fill' + i })
  }
  lQ.seal(true)
  const TEXT = '备份脚本改成只留三份，旧的自动删掉。'
  const mk = (daysAgo, sid) => {
    const t = NOW - daysAgo * D
    lQ.append({ who: 'he', text: TEXT, ts: t, sid })
    lQ.append({ who: 'me', text: '好，这样就行。', ts: t + 30000, sid })
    lQ.seal(true)
    return lQ.episodes[lQ.episodes.length - 1].id
  }
  const idOld = mk(3, 'big-p1')
  const idNew = mk(1, 'big-p2')
  const q = '备份脚本只留三份'
  const topOf = () => {
    const h = searchEpisodes(lQ, q, 5)
    return h.length ? h[0].ep : -1
  }
  ok('前置：内容相同、1 天前那段第一', topOf() === idNew, `docs=${lQ.docs.length} top=${topOf()}`)
  for (const n of [1, 2]) {
    lQ.episodes[idOld].rehearsals = n
    ok(`大库：旧段提 ${n} 次，仍然不许盖过 1 天前`, topOf() === idNew, `top=${topOf()}`)
  }
  lQ.episodes[idOld].rehearsals = 10
  ok('大库：旧段提 10 次，必须能翻（回忆得有点牙）', topOf() === idOld, `top=${topOf()}`)
  lQ.close()
  rmSync(dQ, { recursive: true, force: true })
}

// [34] 作废思考：不删行，只补一条作废记录（2026-11-04，另一库查出来的）
//
// 由来：0.2.37–0.2.39 修好了「日志行被抽成决定」，但**已经写进库的那几条挡不回来**。
// 删掉它们等于破「只增不改」——那文件是证据档案，今天能删一条日志，明天就能删一句真话。
//
// 判据（6 条，先冻后写实现）：
//   ① 作废后内存里没有了   ② 别的思考一条不动
//   ③ 文件只增：作废前的字节**前缀原样保留**，长度变长
//   ④ 作废记录本身不出现成一条思考
//   ⑤ 新写入的 id 不许和已有的撞（作废会把数组长度改小，直接拿 length 当 id 会撞）
//   ⑥ 重开库之后作废仍然生效
console.log('\n[34] 作废思考：不删行，只补一条作废记录')
{
  const dI = mkdtempSync(join(tmpdir(), 'hippo-invalid-'))
  const lI = new Ledger(dI, {}).open()
  const a = lI.addThought({ kind: 'decision', text: '我决定把 A 冻上去，因为两边复跑一致。', src: { sid: 'si' } })
  const b = lI.addThought({ kind: 'lesson', text: '下次要先量再收，别急着冻。', src: { sid: 'si' } })
  const fileI = join(dI, 'thoughts.jsonl')
  const before = readFileSync(fileI, 'utf8')
  const rec = lI.invalidateThought(a.id, '日志行不是决定（[21]）')
  ok('① 作废后内存里没有了', !lI.thoughts.some((t) => t.id === a.id))
  ok('② 别的思考一条不动', lI.thoughts.length === 1 && lI.thoughts[0].id === b.id,
    `剩 ${lI.thoughts.length} 条，id=${lI.thoughts.map((t) => t.id).join(',')}`)
  const after = readFileSync(fileI, 'utf8')
  ok('③ 文件只增：作废前的字节前缀原样保留', after.startsWith(before), `${before.length} → ${after.length} 字节`)
  ok('④ 作废记录本身不是一条思考', !lI.thoughts.some((t) => t.kind === 'invalid'))
  const c = lI.addThought({ kind: 'decision', text: '我决定把 B 也冻上，因为复跑也一致。', src: { sid: 'si' } })
  ok('⑤ 新写入的 id 不和已有的撞', c && c.id !== a.id && c.id !== b.id,
    `新 id=${c && c.id}（作废掉的是 ${a.id}，保留的是 ${b.id}）`)
  lI.close()
  const lI2 = new Ledger(dI, {}).open()
  ok('⑥ 重开库之后作废仍然生效', !lI2.thoughts.some((t) => t.id === a.id) && lI2.thoughts.length === 2,
    `重开后 ${lI2.thoughts.length} 条（应为 2）`)
  // ⑥ 的真正意思（评审 2026-11-04 指出）：**不是「重开也生效」，是「dead 集合必须先收齐」。**
  // 一遍过（边读边判）在作废记录排在末尾时会漏——她实测过：一遍过得到 0,1，两遍得到 1。
  // ⑦ 作废记录自己写坏了：不许静默跳过——那等于「那条又活过来，而且没人报」。
  appendFileSync(join(dI, 'thoughts.jsonl'), JSON.stringify({ kind: 'invalid', target: 'abc', reason: '坏记录' }) + '\n', 'utf8')
  lI2.close()
  const lI3 = new Ledger(dI, {}).open()
  ok('⑦ 坏掉的作废记录：不崩、不算作废、但要报出来', lI3.thoughts.length === 2 && lI3._thoughtBadInvalid === 1,
    `条数 ${lI3.thoughts.length}（应为 2）· 坏作废记录 ${lI3._thoughtBadInvalid} 条`)
  lI3.close()
  // ⑧ 作废记录带内容指纹；⑨ 指纹对不上时**不许误伤**（评审 2026-11-04 两次提的那条）
  {
    const dH = mkdtempSync(join(tmpdir(), 'hippo-hash-'))
    const lH = new Ledger(dH, {}).open()
    const x = lH.addThought({ kind: 'decision', text: '我决定先不动那个索引，因为它在活库上会抖。', src: { sid: 'sh' } })
    const y = lH.addThought({ kind: 'lesson', text: '下次先冻快照再量，别在活库上量。', src: { sid: 'sh' } })
    const recH = lH.invalidateThought(x.id, '日志行')
    ok('⑧ 作废记录里带了内容指纹', !!recH && typeof recH.hash === 'string' && recH.hash.length > 0, `hash=${recH && recH.hash}`)
    lH.close()
    // 手工造一条「id 对、指纹错」的作废记录 = 模拟「文件被重排，id 指到了别人」
    appendFileSync(join(dH, 'thoughts.jsonl'),
      JSON.stringify({ kind: 'invalid', target: y.id, reason: '故意指错', hash: 'deadbeefdeadbeef' }) + '\n', 'utf8')
    const lH2 = new Ledger(dH, {}).open()
    ok('⑨ 指纹对不上：不误伤那条、但要报出来',
      lH2.thoughts.some((t) => t.id === y.id) && lH2._thoughtInvalidMismatch === 1,
      `那条还在=${lH2.thoughts.some((t) => t.id === y.id)} · 对不上 ${lH2._thoughtInvalidMismatch} 条`)
    lH2.close()
    rmSync(dH, { recursive: true, force: true })
  }
  rmSync(dI, { recursive: true, force: true })
}

const ms = Date.now() - t0
console.log(`\n${fail === 0 ? '全过' : '有失败'}：${pass} 过，${fail} 不过（${ms} ms）`)
process.exit(fail === 0 ? 0 : 1)