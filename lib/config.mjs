// 配置与目录。
//
// 一个工作区 = 一条「身份线」的记忆库。换文件夹就是换一个人，
// 同一个文件夹里两只就会串——这是上一轮踩过的坑，这里用目录直接钉死。

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const HOME = join(DSH_HOME, 'hippocampus')
export const CFG_PATH = join(HOME, 'config.json')
// 上一份「读得动」的配置。读坏的时候退到这里，而不是拿默认值把用户的名单盖掉。
export const CFG_BAK = join(HOME, 'config.json.bak')
export const DIAG = join(HOME, 'diag.log')
export const SESSIONS_DIR = join(DSH_HOME, 'sessions')

export const DEFAULT_CFG = {
  enabled: true,
  // 单线文件夹：整个文件夹就是一个人。空数组 = 哪都不生效。
  workspaces: [],
  // 多线文件夹：同一个文件夹里住着不止一只时，用这个把会话分到不同的线上。
  // 形状：[{ "name": "另一库", "cwd": "D:\\...\\另一库", "root": "session-xxx", "members": ["session-yyy"] }]
  // 一个 cwd 只要在 lines 里出现过，这个文件夹就**不再**是「整个文件夹一条线」：
  // 没登记的会话一律不写入、不注入——宁可它没记忆，也不要它记得别人的事。
  // 例外：这个 cwd 只登记了一条线，且它写了 "autoJoin": true —— 新会话自动归这条线。
  // （不加这个，每开一次新对话都要手动往 members 里加人；没人会加，新会话就全成了哑巴。）
  // 另一只搬进来的那天：删掉 autoJoin、给她也开一条线，剩下的自然被按住。
  lines: [],
  // 实时捕获：每一轮、每次工具调用都落盘，不用模型操心
  capture: true,
  // 群聊里「人」的显示名：群里靠它分「人说的」和「别的角色说的」，要和那个群聊插件的显示名一致。
  // 写错不会报错，只会安静地少记（人的消息被当成别人说的跳过）——所以它对不上时，去 diag.log
  // 看「跳过(非X)」那行的 X 是不是它那边的名字。
  humanName: 'human',
  // 发言型工具：显式登记（不猜名字）。装了群聊/消息插件就把它的发言工具写进来，
  // 不写就还按「动作」记——少记一句，不会记错。
  speechTools: [],
  // 挂载时把该工作区已有的会话倒进来（只倒一次，靠 seq 去重）
  backfillOnMount: true,
  // 归档的会话不算记忆（他手动收起来的东西，别自作主张捞回来）
  includeArchived: false,
  // 每轮那三行「这事你以前碰过」
  perTurnPriming: true,
  primeMax: 3,
  // 0.2.13 沉默闸
  // 最低分：先关掉（0）——实测分数阈值分不开「相关/无关」，见 CHANGELOG 的标定记录
  primeMinScore: 0,
  // 只认「不那么常见的词」当证据：df ≤ 22。标定结果（评审的公开组）：
  //   df≤22 → 无关 0/10 误浮、真线索 3/4 命中；df≤30 → 误浮 2；不设 → 8
  primeMaxDf: 22,
  // 「最近一条」兜底：只在连续 N 轮都没命中相关时补一次；命中相关就不补
  primeRecentCooldown: 8,
  // 情绪线索：他说「累/困/烦…」时，去找上次那句话的原因
  emotionCue: true,
  emotionCueMaxChars: 80,
  // 身份锚：自己的原话，几乎不变
  anchor: true,
  anchorQuotes: 5,
  anchorChars: 150,
  // 新对话第一次醒来
  arrival: true,
  arrivalChars: 2400,
  // 显式记下的东西
  facts: true,
  factMax: 8,
  // 思考过程 → 「我的推理」（决定 / 教训 / 线头 / 预测）。
  // 存的是抽出来的判断，不是 reasoning 全文：全存会把库撑成垃圾场，还会养出「演思考」。
  // 它只进预激活的背景层，**永远不进 trace**（trace 只认原话）。
  thoughts: true,
  thoughtMax: 2,            // 一轮最多浮两条
  // 英文窄门（2026-11-02 用户拍板 B）：非中文句子只认
  // `I decided to / I chose / I'll go with / decision:` 这几个明确定案句。
  // 关掉它就退回「只抽中文」——这条线上实测汉字只占 5.8%，关掉等于这层不工作。
  thoughtEnglish: true,
  // 一个会话最多收几条。设计稿写的是 5，这里放宽到 12：
  // 「按有没有改变过行为取舍」要模型判断，v1 做不到；先多存，在**看的时候**收——
  // 同一个会话同一类只留最新那条（决定会推翻决定），见 thoughtBlock。
  thoughtPerSession: 12,
  // 自动备份：防「stream.jsonl 单点」——流坏了，索引再能重建也没东西可建。
  // 抄到库旁边 `<库名>.backups/`，没变就不抄，只留最近 3 份。
  // 体积：一条线现在 4 MB 左右，3 份 ≈ 12 MB。
  backup: true,
  backupEveryHours: 6,
  backupKeep: 3,
  // 「我记下的」视图层的时间衰减（用进废退）。
  // 和检索的 recency 不是一组：检索要「近期陡、远期糊」，记下的东西要**慢得多**——
  // 一句「他是谁」放三个月也还是他，不该掉到流程事实后面。
  markRecency: { t0: 7, alpha: 0.6, floor: 0.2 },
  // 一次回忆最多给多少字
  recallMaxChars: 2200,
  // 时间衰减（0.2.13.8）：幂律，不是半衰。
  //   t0    拐点（天）——比它近的几乎不动
  //   alpha 尾巴厚度——越大掉得越快
  //   floor 地板——只用来拖住归零
  // 为什么换掉半衰：半衰是「每天掉一样的比例」，于是「今天 vs 三天前」和
  // 「三个月 vs 四个月」掉得一样多；人的感觉正相反，近期陡、远期糊。
  //
  // 这组数是标定出来的，不是拍的。标定脚本：工具/标定-recency.mjs
  // 样本：工具/标定样本-20261101（**冻结**，两份库各 70 个探测词）——
  // 活库每天都长，用活库标出来的数第二天就对不上，这是 10-30 栽过的坑。
  // 两条线一起看（只压一头是作弊）：
  //   A 近期命中：今天和更早都说过这个词 → 第一行该落今天
  //   B 旧事找回：只在 4 天前说过 → 该找回那一段
  //
  // 冻结样本实测（示例线B / 示例线）。三条前提缺一个数就不成立：
  //   ① 库：工具/标定样本-20261101（6.5 MB，两份库）
  //   ② 现在：同一目录的 NOW.txt，冻在 2026-11-01 09:50:37
  //      ——只冻库不冻时间，「今天」会跟着钟走，A 组的词进出，隔 20 分钟量出两个数（栽过）
  //   ③ 边距：A 组只收 minAge ≤ 0.9 天、B 组只收 ≥ 4.1 天
  //      ——卡在 1.0 / 4.0 边界上的词是刀刃样本，库一变就换身份
  //   旧·半衰30天           A 54%/33%   B 34%/33%
  //   t0=.25 α=.8 floor=0   A 90%/81%   B 43%/39%   ← 当前
  //
  // **别拿 A 的 90 去对比 0.2.13.7 的 81**：那是换了题，不是做得更好。
  // 边距把最难的刀刃词排除了，同一张卷子难度降了。只跟同样加了边距的
  // 「旧·半衰 54/33」比，才是同一个题。
  //
  // floor 从 0.03 降回 0 的理由：地板会把**所有**老段一起抬起来，
  // 该找的那段反倒更容易被别的老段压过去；冻结样本上 A+B 也是 0 更好。
  // 代价说在前面：**远期（几个月以上）没验过**——库里最老只有 7 天。
  // floor=0 时极老的事靠 idf 和 salience 撑；等有更长的库再定这条。
  recency: { t0: 0.25, alpha: 0.8, floor: 0 },
  // 多长没说话算「换了一次见面」
  meetingGapMs: 2 * 60 * 60 * 1000,
}

// 先写临时文件再改名：写到一半断电/被杀，也不会留半截 JSON。
function writeAtomic(p, text) {
  const tmp = p + '.tmp'
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, p)
}

function readJsonFile(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

// 上一次读到的好配置原文。只在内容变了时刷 .bak，免得每 2 秒写一次盘。
let _lastGoodRaw = null

export function loadCfg() {
  let raw = null
  try { raw = readFileSync(CFG_PATH, 'utf8') } catch {}

  // 第一次装：没有配置文件，写一份默认的
  if (raw === null) {
    try {
      mkdirSync(HOME, { recursive: true })
      writeAtomic(CFG_PATH, JSON.stringify(DEFAULT_CFG, null, 2))
    } catch {}
    return { ...DEFAULT_CFG }
  }

  let parsed = null
  try { parsed = JSON.parse(raw) } catch {}
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    // 好配置：留一份 .bak。手滑存坏一次时，退回来的就是这一份。
    if (raw !== _lastGoodRaw) {
      _lastGoodRaw = raw
      try { writeAtomic(CFG_BAK, raw) } catch {}
    }
    return { ...DEFAULT_CFG, ...parsed }
  }

  // 文件在，但读不出来：**不写盘**。
  //
  // 以前这里直接拿默认值覆盖，实测：把 config.json 写成半截 JSON 再读一次，
  // workspaces / lines 全变空；而 sweep() 每 2 秒重读一次，手滑存坏 2 秒后就生效，
  // 多条线共用这一份配置 → 四条线一起失去归属。
  // 现在：留一句话在 diag 里，退回上一份好的；改好那个文件，下次 mtime 一变就自动恢复。
  diag('配置读不出来（格式坏了）：这次用上一份好的，没有就用默认值；**没有写盘**，把文件改好就会自动恢复。')
  const bak = readJsonFile(CFG_BAK)
  return { ...DEFAULT_CFG, ...(bak || {}) }
}

export function saveCfg(cfg) {
  try {
    mkdirSync(HOME, { recursive: true })
    const text = JSON.stringify(cfg, null, 2)
    writeAtomic(CFG_PATH, text)
    writeAtomic(CFG_BAK, text)
    _lastGoodRaw = text
    return true
  } catch { return false }
}

export function normPath(p) {
  return String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}

// 「把记忆库目录当工作区」——2026-11-02 22:58 和 23:15 各踩一次。
//
// 为什么它危险：库目录名是按 cwd 的哈希算出来的（workspaceDir）。拿库根当 cwd 跑一次
// cli，就会在库根**下面**再造一个库，留下一个空库——而空库会跟着冻包走一趟
// （那次就是这么把 tmp.rzbjxglxjk-78fa920e 冻进去的）。
//
// 判据是「落点」，不是「意图」：cwd 等于库根、或落在库根里面，就算。
// 抽成纯函数是为了能被自测直接钉住（这行判断本身不该靠「下次记得小心」）。
export function isDbDirPath(cwd, home = HOME) {
  // 先 resolve 再归一：`D:\a\..\b`、`./x`、尾斜杠这几种写法最后都落在同一个地方，
  // 「落点」判断就得先把落点算准（2026-11-03 评审那颗螺丝：`join` 会把带尾斜杠的同一个目录判成两个）。
  let c = ''
  let h = ''
  try { c = normPath(resolve(String(cwd || ''))) } catch { c = normPath(cwd) }
  try { h = normPath(resolve(String(home || ''))) } catch { h = normPath(home) }
  if (!c || !h) return false
  return c === h || c.startsWith(h + '\\')
}

export function sameWorkspace(a, b) {
  return normPath(a) === normPath(b)
}

// 每个工作区（或每条线）一个库：目录名可读（用文件夹名/线名），后缀用路径哈希，避免同名撞车
export function workspaceDir(cwd, lineName) {
  const full = normPath(cwd) + (lineName ? '::' + lineName : '')
  const hash = createHash('sha1').update(full).digest('hex').slice(0, 8)
  const baseRaw = lineName || full.split('::')[0].split('\\').filter(Boolean).pop() || 'root'
  const base = baseRaw.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 40) || 'ws'
  return join(HOME, `${base}-${hash}`)
}

export function diag(msg) {
  try {
    mkdirSync(HOME, { recursive: true })
    appendFileSync(DIAG, new Date().toISOString() + '  ' + msg + '\n', 'utf8')
  } catch {}
}
