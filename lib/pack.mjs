// 可带走：pack（打包）/ unpack（解包重绑）/ export（导出可读）。
//
// 设计稿：`设计-记忆可带走-20261102.md`。三条规矩照抄，不自己发挥：
//   ① **谁是源**：`stream.jsonl` 是真相，`state.json` 只是索引——所以包里**不放 state**，
//      换台机器按新规则重建就行；带上反而会被当成数据。
//   ② **不覆盖已有库**：`--force` 也只是把旧的改名成 `.bak-<时间>`，绝不直接盖。
//   ③ **包里不放 `config.json`**：那里面有用户的路径和线名，跟着包走等于泄露。
//
// `export` 的定位（2026-11-02 补，§8.1）：不只是「顺手导出」，是**长期存档**。
// 于是「不总结、不截断」从格式偏好升成硬约束——正文里出现省略号就是 bug。

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { zipWrite, zipRead } from './zip.mjs'
import { workspaceDir, normPath } from './config.mjs'
import { episodeText } from './retrieve.mjs'

// 包里带的文件。`state.json` 故意不在里面。
//
// 0.2.29 补 `rehearsals.jsonl`：0.2.25 加这本账时只改了 backup 清单，忘了 pack——
// 于是「可带走」打出来的包换台机器就没有「哪些段被想起来过」，
// 用进废退的账在迁移那一步悄悄归零，而且**不报错**。
// （同一样东西写在两处、只改一处，今晚已经踩过一次：rehearse 系数。）
const PACK_FILES = ['stream.jsonl', 'marks.jsonl', 'thoughts.jsonl', 'usage.jsonl', 'seqs.json', 'rehearsals.jsonl']

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function iso(ts) {
  const d = new Date(Number(ts) || 0)
  const p = (n) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

// 打包。返回 { path, bytes, counts }
export function packTo(ledger, { cwd = '', lineName = null, out = null, now = new Date() } = {}) {
  const parts = []
  const hashes = {}
  for (const f of PACK_FILES) {
    const p = join(ledger.dir, f)
    if (!existsSync(p)) continue
    const buf = readFileSync(p)
    hashes[f] = sha256(buf)
    parts.push({ name: f, data: buf })
  }
  if (!hashes['stream.jsonl']) throw new Error('这个库里没有 stream.jsonl，没什么可打包的')

  const docs = ledger.docs
  const withTs = docs.filter((d) => d && d.ts)
  const manifest = {
    schema: 1,
    packedAt: iso(now.getTime()),
    pluginVersion: (() => { try { return JSON.parse(readFileSync(join(ledger.dir, '..', '..', 'package.json'), 'utf8')).version } catch { return null } })(),
    // **不写明文路径**（2026-11-02 评审抓的）：这个包是要「带走、换电脑、发给别人」的，
    // 一条 `C:\Users\user\...` 就把用户名和目录结构一起送出去了。
    // 解包重绑用的是 workspaceDir(新 cwd)，cwd 本来也用不上——
    // 只留一个哈希，能打印「从哪儿来」，又还原不出路径。
    cwdHash: (() => {
      try { return createHash('sha1').update(normPath(cwd) + (lineName ? '::' + lineName : '')).digest('hex').slice(0, 8) } catch { return null }
    })(),
    lineName: lineName || null,
    dirName: basename(ledger.dir),
    // 写进包里，不只写在文档里：**拿包的人第一眼看到的就是 manifest**。
    // 清不了数据（清了就带不走记忆），那就把话说明白（2026-11-02 评审的建议）。
    note: '此包含全部对话与本地路径（用户名、工作区、会话编号），仅限本人迁移使用，不可外发、不可上传。',
    counts: { docs: docs.length, speech: ledger.stats().traces, episodes: ledger.episodes.length },
    oldest: withTs.length ? iso(withTs[0].ts) : null,
    newest: withTs.length ? iso(withTs[withTs.length - 1].ts) : null,
    sha256: hashes,
  }

  const file = out || join(cwd || process.cwd(), `记忆-${basename(String(cwd || 'export').replace(/[\\/]+$/, ''))}-${stamp(now)}.zip`)
  // 包里放一份大字报，和冻包同一个做法：**数据清不了，就把话说明白**。
  const README = [
    // 第一行就写那四个字：以后谁 grep、谁用编辑器搜，都一搜一个准（评审 2026-11-02 提的）
    '不可外发。',
    '',
    '这个包里是完整的对话记忆：原话、时间、会话编号、本地工作区路径，',
    '以及说话人（你和我）的名字。把它发给别人、传上 GitHub、当素材分享——',
    '等于把整段聊天记录和这台机器的目录结构一起交出去。',
    '',
    '它只有一个用途：**换电脑、换工作区时把它解开，记忆跟着人走**。',
    '插件源码可以公开，记忆不行。',
  ].join('\n')
  const buf = zipWrite([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: '!!不可外发.txt', data: Buffer.from(README, 'utf8') },
    ...parts,
  ], now)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, buf)
  return { path: file, bytes: buf.length, counts: manifest.counts, manifest }
}

// 解包并重绑。返回 { dir, counts, mapped }
export function unpackTo(zipPath, { cwd, lineName = null, force = false, dir: dirOverride = null } = {}) {
  const buf = readFileSync(zipPath)
  const files = zipRead(buf)
  const get = (name) => files.find((f) => f.name === name)
  const man = get('manifest.json')
  if (!man) throw new Error('这个包里没有 manifest.json，不像一份记忆包')
  const manifest = JSON.parse(man.data.toString('utf8'))
  if (manifest.schema !== 1) throw new Error('包的 schema 是 ' + manifest.schema + '，这份代码只认 1')

  // 先验哈希再动盘：不拿坏包盖好数据
  for (const [name, want] of Object.entries(manifest.sha256 || {})) {
    const f = get(name)
    if (!f) throw new Error('包里缺文件：' + name)
    const got = sha256(f.data)
    if (got !== want) throw new Error(`包坏了：${name} 的 sha256 对不上（要 ${want.slice(0, 12)}… 实际 ${got.slice(0, 12)}…）`)
  }

  // dir 是给测试/高级用法留的显式落点；正常走 workspaceDir(新 cwd) 算目录
  const dir = dirOverride || workspaceDir(cwd, lineName)
  if (existsSync(dir) && readdirSync(dir).length) {
    if (!force) throw new Error('目标库已经有东西了，不动它：' + dir + '（确实要覆盖请加 --force，会先改名备份）')
    const bak = dir + '.bak-' + stamp()
    renameSync(dir, bak)
  }
  mkdirSync(dir, { recursive: true })
  for (const [name] of Object.entries(manifest.sha256 || {})) {
    const f = get(name)
    writeFileSync(join(dir, name), f.data)
  }

  return {
    dir,
    manifest,
    // 只报哈希，不报原路径——包里本来就没存明文
    mapped: { fromHash: manifest.cwdHash || '(没记)', to: cwd, fromDir: manifest.dirName, toDir: basename(dir) },
  }
}

// 导出可读：不总结、不截断。段标题 + 原话，格式和 recall 一致。
export function renderMarkdown(ledger, { from = null, to = null } = {}) {
  const dayOf = (ts) => {
    const d = new Date(Number(ts) || 0)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const clockOf = (ts) => {
    const d = new Date(Number(ts) || 0)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  const parts = []
  const used = new Set()
  let first = null
  let last = null
  for (const ep of ledger.episodes) {
    const day = dayOf(ep.startTs)
    if (from && day < from) continue
    if (to && day > to) continue
    if (!first) first = day
    last = dayOf(ep.endTs)
    // maxChars 给到无穷、full=true：导出的意义就是完整，这里**不许**出现省略号
    const got = episodeText(ledger, ep.id, { maxChars: Number.POSITIVE_INFINITY, full: true })
    if (!got) continue
    parts.push(`## 段 #${ep.id} · ${clockOf(ep.startTs)} · ${ep.title || '(没标题)'}`)
    parts.push('')
    parts.push(got.text)
    parts.push('')
    for (let i = ep.from; i <= ep.to; i++) used.add(i)
  }

  const head = [
    `# ${basename(ledger.dir)} · 记忆导出`,
    '',
    `- 导出范围：${from || first || '?'} ~ ${to || last || '?'}`,
    `- 段数：${ledger.episodes.length} · 原话：${ledger.stats().traces} 句 · 记录：${ledger.docs.length} 条`,
    '',
    '> 这是一份**完整存档**：不总结、不摘要、不截断。正文里出现省略号就是 bug。',
    '',
  ]
  return head.join('\n') + parts.join('\n')
}
