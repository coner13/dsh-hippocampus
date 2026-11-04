// 自动备份：防的是「stream.jsonl 单点」。
//
// 这套系统的骨架是「一条只增不改的流 + 一份可以重建的索引」。
// 索引坏了、state 丢了都不要紧——从流重算。但**流自己坏了，什么都没了**：
// 原话、段、锚、remember 记下的东西全挂在它上面。
//
// 所以这里只干一件事：定期把库里的几个文件抄一份，留最近几份，轮转。
//
// 三条原则，和别处一致：
//   ① **不动源**：只读、只复制，绝不删改库里的任何文件；
//   ② **没变就不抄**：流大小和小文件的 mtime 都没变，跳过——一天几十次挂载不该写出几十份；
//   ③ **坏了能退**：备份目录里每份都是完整的（流 + 状态 + 记下的东西），
//      恢复就是把整份拷回去，不需要懂这套格式。
//
// 体积说在前面：`stream.jsonl` 现在 4 MB 左右，留 3 份 = 12 MB/条线。
// 这不是「历史版本」，是「最近三次的保险」。

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, readFileSync, writeFileSync, openSync, readSync, closeSync, ftruncateSync } from 'node:fs'
import { join } from 'node:path'

// 一起抄走的东西。少了哪个都会让「恢复」变成半拉子：
//   stream   真相；state 索引缓存（能重建，但重建要时间）；
//   marks/thoughts/usage  记下的和用过的；seqs 回填去重账（丢了会把旧会话重倒一遍）
const FILES = ['stream.jsonl', 'state.json', 'marks.jsonl', 'thoughts.jsonl', 'usage.jsonl', 'seqs.json', 'rehearsals.jsonl']

const KEEP = 3

function fileSig(p) {
  try {
    const s = statSync(p)
    return `${s.size}:${Math.round(s.mtimeMs)}`
  } catch { return '' }
}

// 这库现在凑出来的「签名」：所有文件的大小 + 最新 mtime。
// 和最近一份备份的签名一样，就说明没变，不用抄。
export function ledgerSig(dir) {
  return FILES.map((f) => fileSig(join(dir, f))).join('|')
}

// 备份目录：放在库旁边，不塞进库里（库目录是要被 pack / 拷来拷去的，别带一堆副本）
export function backupRoot(dir) {
  return join(dir, '..', `${dir.split(/[\\/]/).pop()}.backups`)
}

// 备份目录名必须长这样：20261102-222011 / 20261102-222011-123 / 20261102-222011-123-ab3f。
// 中间那 3 位是毫秒——**名字要按时间排得准**：同一秒内连做两份，
// 没有毫秒的话一个带随机后缀、一个不带，排序会把不带后缀那份排到最前，
// 轮转一跑就把刚做的那份删了（2026-11-02 自测当场撞上）。
// listBackups 和轮转**用同一个正则**——评审抓出来的口径不一致：
// 列的时候不过滤、删的时候过滤，于是根目录里一个不合规目录会白占一个 keep 名额。
const STAMP_RE = /^\d{8}-\d{6}(-\d{3})?(-[a-z0-9]{4})?$/

export function listBackups(dir) {
  const root = backupRoot(dir)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && STAMP_RE.test(e.name))
    .map((e) => e.name)
    .sort()
}

// 读 state.json 里记的 streamBytes：这是「上一次保存索引时，流有多长」。
// 抄流：**抄到最后一个完整行为止**，尾部没写完的半行截掉。
//
// 为什么不再用 `state.streamBytes`（2026-11-02 评审抓的）：
//   state 是「上次保存索引时流有多长」，最后一次保存之后追加的行（往往是一整个回合）
//   全在它外面。按它截 = **恢复时静默丢掉那一段原话**，比半行更糟。
//   按「最后一行换行符」截，丢的只会是正在写的那半行——而且会记进 `.sig`，不静默。
//
// 索引对不上也没事：恢复后 `open()` 发现 `state.streamBytes !== 文件大小`，会重算一遍。
function copyStreamAtLineBoundary(src, dest) {
  copyFileSync(src, dest)
  const size = statSync(dest).size
  if (!size) return { bytes: 0, dropped: 0 }
  const chunk = 64 * 1024
  const fd = openSync(dest, 'r+')
  try {
    let pos = size - 1
    while (pos >= 0) {
      const start = Math.max(0, pos - chunk + 1)
      const buf = Buffer.alloc(pos - start + 1)
      readSync(fd, buf, 0, buf.length, start)
      const i = buf.lastIndexOf(0x0a)
      if (i >= 0) {
        const cut = start + i + 1
        ftruncateSync(fd, cut)
        return { bytes: cut, dropped: size - cut }
      }
      pos = start - 1
    }
    // 整份没有一个换行：原样留着（空库或坏到没法判断的库，别擅自砍）
    return { bytes: size, dropped: 0 }
  } finally { closeSync(fd) }
}

// 抄一份。返回 { created, dir, reason }
//
// force=true 时不看签名（手动备份用它），auto 模式看签名。
export function makeBackup(dir, { keep = KEEP, force = false, now = new Date() } = {}) {
  const root = backupRoot(dir)
  const sig = ledgerSig(dir)
  const prev = listBackups(dir)

  if (!force && prev.length) {
    const last = join(root, prev[prev.length - 1])
    let lastSig = ''
    try { lastSig = JSON.parse(readFileSync(join(last, '.sig'), 'utf8')).sig || '' } catch {}
    if (lastSig && lastSig === sig) return { created: false, dir: last, reason: '没变，跳过' }
  }

  mkdirSync(root, { recursive: true })
  const p = (n) => String(n).padStart(2, '0')
  // 带毫秒：同一秒内连做两份也要排得出先后，否则轮转会把刚做的那份删掉
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${ms}`
  let out = join(root, ts)
  // 同一毫秒内连按两次：加后缀，不覆盖
  if (existsSync(out)) out = join(root, `${ts}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(out, { recursive: true })

  let copied = 0
  let snap = { bytes: null, dropped: 0 }
  for (const f of FILES) {
    const src = join(dir, f)
    if (!existsSync(src)) continue
    if (f === 'stream.jsonl') {
      snap = copyStreamAtLineBoundary(src, join(out, f))
    } else {
      copyFileSync(src, join(out, f))
    }
    copied += 1
  }

  // 不再写 `tail`：按换行截之后末行**必然**完整，`tail` 恒为 ok，
  // 而 `droppedTailBytes` 可能是 39 —— 两个字段摆在一起读起来自相矛盾（评审 2026-11-02 指出的）。
  // 信息只留一个：`droppedTailBytes > 0` 就是「砍过」。一段数据一个说法。
  //
  // droppedTailBytes：抄的时候砍掉的那半行有多少字节。**不静默**——
  // 恢复的人要能看见「这一份比当时那一刻少了几个字节，是没收完的半行」。
  writeFileSync(join(out, '.sig'), JSON.stringify({
    sig, streamBytes: snap.bytes, droppedTailBytes: snap.dropped,
  }), 'utf8')

  // 轮转：只留最近 keep 份。删的一定是**更老的备份**，不碰库本体。
  // listBackups 已经按同一个正则筛过，这里不用再判一次名字。
  const all = listBackups(dir)
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    try { rmSync(join(root, old), { recursive: true, force: true }) } catch {}
  }

  return { created: true, dir: out, reason: `抄了 ${copied} 个文件`, copied }
}

// 从某份备份恢复。**破坏性操作，规矩写在函数里，不靠调用方自觉**：
//   ① 恢复之前，先把现在这份**也备一次**——否则「恢复」本身成了一次新的不可逆；
//   ② 只覆盖 FILES 里列的几个，别的一概不碰（库里可能还有别的东西）；
//   ③ 返回 safetyNet，出事了能说清「从哪一步退回来」。
export function restoreBackup(dir, stamp = null, { keep = KEEP } = {}) {
  const root = backupRoot(dir)
  const list = listBackups(dir)
  const pick = stamp || list[list.length - 1]
  if (!pick) throw new Error('这个库还没有备份：' + root)
  if (!list.includes(pick)) throw new Error('找不到这份备份：' + pick + '（现有：' + list.join(', ') + '）')

  const src = join(root, pick)
  // 恢复前先存现在这份。keep 给大一点，别把这条新保险轮转掉。
  const safe = makeBackup(dir, { force: true, keep: Math.max(keep, 9) })

  let n = 0
  for (const f of FILES) {
    const s = join(src, f)
    if (!existsSync(s)) continue
    copyFileSync(s, join(dir, f))
    n += 1
  }
  return { restored: pick, files: n, safetyNet: safe.dir }
}
