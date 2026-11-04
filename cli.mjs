#!/usr/bin/env node
// 离线命令行：不装插件也能先把记忆跑通、看清楚。
//
//   node cli.mjs stats   <工作区目录>
//   node cli.mjs index   <工作区目录> [--rebuild]   看/重建落盘的倒排索引
//   node cli.mjs backfill<工作区目录>
//   node cli.mjs episodes<工作区目录> [条数]
//   node cli.mjs recall  <工作区目录> <一句话|日期|#编号>
//   node cli.mjs trace   <工作区目录> <一句话>        按字查：谁说的、哪一场、第几行
//   node cli.mjs prime   <工作区目录> <一句话>
//   node cli.mjs anchor  <工作区目录>
//   node cli.mjs arrive  <工作区目录>
//   node cli.mjs dump    <工作区目录> [n]     看最近 n 条原始记录
//   node cli.mjs audit   <工作区目录>         体检：每个会话多带多少运行时上下文、压缩过几次
//   node cli.mjs lines   [add <线名> <工作区> <会话id> | join <线名> <会话id>]

import { Ledger } from './lib/store.mjs'
import { writeFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { sep, join, resolve } from 'node:path'
import { workspaceDir, normPath, loadCfg, DEFAULT_CFG, saveCfg, isDbDirPath } from './lib/config.mjs'
import { backfill } from './lib/backfill.mjs'
import { anchorBlock, primingBlock, thoughtBlock, recallBlock, traceBlock, factsView, arrivalBlock, dayOf } from './lib/assemble.mjs'
import { search, priming } from './lib/retrieve.mjs'
import { makeBackup, listBackups, backupRoot, restoreBackup } from './lib/backup.mjs'
import { packTo, unpackTo, renderMarkdown } from './lib/pack.mjs'
import { indexStat } from './lib/index-file.mjs'

const [cmd, cwd, ...rest] = process.argv.slice(2)
if (!cmd || !cwd) {
  console.log('用法：node cli.mjs <stats|backfill|episodes|recall|trace|thoughts|facts|backup|restore|pack|unpack|export|prime|anchor|arrive|dump|audit|lines> <工作区目录|zip> [...]')
  process.exit(1)
}

// 多线文件夹：用 HIPPO_LINE=<线名> 指定看哪条
const lineName = process.env.HIPPO_LINE || null
// 库目录名按 **resolve 之后**的 cwd 算（独立复核 2026-11-03）：
// 原来拿原始串算，「D:\work\ws\..」会落成库根里一个叫 `..-52f4a451` 的库——
// 守卫放行是对的（resolve 后确实不是库目录），但那个脏库会被冻包带走。
// 对规范写法（带不带尾斜杠、正斜杠、大小写）hash 不变，只有带 `.`/`..` 的才变。
const dir = workspaceDir(resolve(cwd), lineName)

// —— 守卫全部放在 `loadCfg()` **之前**（评审 2026-11-03 抓的「鞋脱在门口」）——
// loadCfg() 会顺手写/刷 config.json + .bak；拿库根当工作区时，那个落点**就是库根**，
// 于是「拒绝进来」之前门口已经多出两个文件。workspaceDir() 只用 cwd + HOME，不读配置，
// 所以两条守卫都能安全地提到前面（临时目录那条原来落在 loadCfg 之后，同一个洞）。
if (cmd !== 'lines' && cmd !== 'unpack' && isDbDirPath(cwd)) {
  console.error('拒绝把记忆库目录当工作区：' + cwd)
  console.error('（会在库根下再造一个库：' + dir + '）')
  console.error('要试就指定一个真正的、放对话的工作区文件夹。')
  process.exit(2)
}

// 临时目录里**不建库**——但只管「会落到真记忆目录」的那种。
//
// 库目录名是按 cwd 算出来的（workspaceDir），所以拿一个 /tmp/xxx 当工作区跑一次 cli，
// 就会在真 ~/.dsh/hippocampus 下留一个空库——2026-11-02 22:58 就这么留下了
// tmp.rzbjxglxjk-78fa920e，还跟着冻包走了一趟。这和那次 config 事故是同一个形状：
// **测试的东西落进了真数据目录**。
//
// 判据是「落点在哪」，不是「DSH_HOME 有没有设」：DSH_HOME 指到临时目录时，
// 库建在临时目录里，碰不到真库，那种**不该拦**——拦了就是假红，
// 而假红和假绿一样坏（今晚最忌的那种）。
{
  const REAL_HOME = normPath(join(homedir(), '.dsh', 'hippocampus'))
  const target = normPath(dir)
  const wouldPollute = target === REAL_HOME || target.startsWith(REAL_HOME + sep) || target.startsWith(REAL_HOME + '/')
  const t = normPath(tmpdir())
  const c = normPath(resolve(cwd))
  const inTemp = c === t || c.startsWith(t + sep) || c === t + '/' || c.startsWith(t + '/')
  if (cmd !== 'lines' && cmd !== 'unpack' && inTemp && wouldPollute && !existsSync(dir)) {
    console.error('拒绝在临时目录建库：' + cwd)
    console.error('（会在真记忆目录下留一个空库：' + dir + '）')
    console.error('想拿临时目录试：DSH_HOME=<临时目录> node cli.mjs ' + cmd + ' <工作区>')
    process.exit(2)
  }
}

// `unpack` 整条被上面豁免（它不按 cwd 开库），但它的落点来自 `--to`（缺省是 cwd），
// 那个值原来没人检查：`unpack x.zip --to <库根>` 会在库根里建 `<名字>-<hash>`。
{
  const to = (() => {
    const i = rest.indexOf('--to')
    return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : null
  })()
  if (cmd === 'unpack' && to && isDbDirPath(to)) {
    console.error('拒绝把记忆库目录当解包落点：' + to)
    process.exit(2)
  }
}

const cfg = { ...DEFAULT_CFG, ...loadCfg(), workspaces: [cwd] }

// lines / unpack 自己会开库（或根本不该开库）；别为它们凭空造一个空库出来
const ledger = (cmd === 'lines' || cmd === 'unpack') ? null : new Ledger(dir, { meetingGapMs: cfg.meetingGapMs }).open()

const arg = rest.join(' ')
// --名字 取值；没有就给默认
const opt = (name, dflt = null) => {
  const i = rest.indexOf('--' + name)
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : dflt
}
const flag = (name) => rest.includes('--' + name)

function kb(n) { return (n / 1024).toFixed(1) + ' KB' }

// ——— 多线的登记表 ———
// 注意：这一段自己退场（process.exit），不落到下面的 switch 里
if (cmd === 'lines') {
  const real = loadCfg()
  const lines = Array.isArray(real.lines) ? real.lines : []
  const sub = rest[0]

  if (!sub) {
    if (!lines.length) {
      console.log('（没有多线文件夹：现在每个工作区就是一条线）')
      process.exit(0)
    }
    for (const l of lines) {
      const d = workspaceDir(l.cwd, l.name)
      const lg = new Ledger(d, {}).open()
      const s = lg.stats()
      console.log(`# ${l.name}   ${l.cwd}`)
      console.log(`   根 ${l.root || '（没设）'} · 成员 ${(l.members || []).length} 个 · ${s.episodes} 段 / ${s.traces} 句 / ${kb(s.bytes)}`)
      for (const m of l.members || []) console.log(`     · ${m}`)
      lg.close()
    }
    process.exit(0)
  }

  if (sub === 'add' || sub === 'join') {
    const name = rest[1]
    const sid = sub === 'add' ? rest[3] : rest[2]
    const where = sub === 'add' ? rest[2] : cwd
    if (!name || !sid) {
      console.log(`用法：node cli.mjs lines ${sub} <线名> ${sub === 'add' ? '<工作区> ' : ''}<会话id>`)
      process.exit(1)
    }
    const list = Array.isArray(real.lines) ? real.lines : []
    let line = list.find((x) => x.name === name)
    if (!line) {
      line = { name, cwd: where, root: sub === 'add' ? sid : undefined, members: [] }
      list.push(line)
    }
    line.members = Array.isArray(line.members) ? line.members : []
    if (!line.members.includes(sid) && line.root !== sid) line.members.push(sid)
    real.lines = list
    // 一旦某文件夹进了 lines，就不要再把它留在 workspaces 里（否则两套语义打起来）
    real.workspaces = (real.workspaces || []).filter((w) => String(w).toLowerCase() !== String(line.cwd).toLowerCase())
    console.log(saveCfg(real) ? `写好了：线「${name}」现在有 ${line.members.length + (line.root ? 1 : 0)} 个会话。配置热读，几秒后生效。` : '写配置失败')
    process.exit(0)
  }

  console.log('用法：node cli.mjs lines [add <线名> <工作区> <会话id> | join <线名> <会话id>]')
  process.exit(0)
}

switch (cmd) {
  case 'stats': {
    const s = ledger.stats()
    console.log('库：' + s.dir)
    console.log(`记录 ${s.docs} 条（原话 ${s.traces}，动作 ${s.acts}）· 段 ${s.episodes} · 词 ${s.terms} · ${kb(s.bytes)} · 特意记下 ${s.marks} · 我的推理 ${s.thoughts}`)
    if (ledger.episodes.length) {
      const a = ledger.episodes[0]
      const b = ledger.episodes[ledger.episodes.length - 1]
      console.log(`从 ${dayOf(a.startTs)} 到 ${dayOf(b.endTs)}`)
    }
    break
  }

  case 'index': {
    const st = indexStat(ledger.indexPath)
    const onDisk = statSync(ledger.streamPath).size
    if (rest.includes('--rebuild')) {
      const t = Date.now()
      const r = ledger.rebuildIndex()
      console.log(r
        ? `重建好了：${r.termCount} 词 · ${r.postWords / 2} 打点 · ${kb(r.bytes)} · ${Date.now() - t} ms`
        : '重建失败：' + (ledger._lastIndexError || '未知原因（看 diag）'))
      break
    }
    if (!st) {
      // 没有索引���时也走「同一形状」的一行，别另起一套话。
      // 踩过（评审 2026-11-02 23:13）：对账脚本里我**自己模拟**了 cli 的输出，
      // 而真 cli 在这个分支上印的是另一句话——于是用例钉住的是模拟，不是真东西。
      // 现在两边字面一致：`覆盖 无索引 / 文件 N 字节`。
      console.log(`索引：无 · 覆盖 无索引 / 文件 ${onDisk} 字节 · 下次开库自动重建（或：node cli.mjs index <工作区> --rebuild）`)
      break
    }
    // 报字节，不报 KB 取整；打点也拆成「文件里 + 尾巴」——
    // 这样这一行能和 diag 的 `索引 …` 那一行**逐字段对**：
    // 两边都是「覆盖字节 / 文件字节 / 打点 base+tail」。对不上时一眼看得出差在哪。
    const ix = ledger.stats().index
    console.log(`索引：${kb(st.bytes)} · 覆盖 ${st.streamBytes} / 文件 ${onDisk} 字节 · ${st.terms} 词 · 打点 ${ix ? ix.baseWords / 2 : st.postings}+${ix ? ix.tailWords / 2 : 0}`)
    console.log(`      stateVer ${st.stateVer} · 还差 ${kb(Math.max(0, onDisk - st.streamBytes))} 没进索引（下次启动补这一小段）`)
    break
  }

  case 'backfill': {
    const r = backfill(ledger, cwd, cfg)
    ledger.seal(true)
    console.log(`回填：${r.sessions} 份会话，${r.added} 条记录`)
    console.log(`现在：${ledger.episodes.length} 段，${ledger.stats().traces} 句原话`)
    break
  }

  case 'episodes': {
    const n = Number(rest[0]) || 20
    for (const e of ledger.episodes.slice(-n)) {
      const emo = e.emotion > 0.3 ? ' ★' : ''
      console.log(`#${String(e.id).padStart(3)} ${dayOf(e.startTs)}  ${String(e.turns).padStart(3)} 回合  显著 ${e.salience.toFixed(2)}  情绪 ${e.emotion.toFixed(2)}${emo}  ${e.title}`)
    }
    break
  }

  case 'recall': {
    if (!arg) { console.log('要给一句话或日期'); break }
    if (/^#?\d+$/.test(arg)) {
      const block = recallBlock(ledger, { episode: Number(arg.replace('#', '')), maxChars: cfg.recallMaxChars })
      console.log(block || '（没有这一段）')
      break
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      const hit = ledger.episodes.filter((e) => dayOf(e.startTs) === arg || dayOf(e.endTs) === arg)
      if (!hit.length) { console.log('（那天没有记录）'); break }
      console.log(recallBlock(ledger, { episode: hit[0].id, maxChars: cfg.recallMaxChars }))
      break
    }
    const block = recallBlock(ledger, { query: arg, maxChars: cfg.recallMaxChars })
    if (block) { console.log(block); break }
    const hits = search(ledger, arg, { limit: 6, recency: cfg.recency })
    if (!hits.length) { console.log('（想不起来）'); break }
    console.log('【零碎想起】')
    for (const h of hits) {
      const d = ledger.docs[h.id]
      const who = d.who === 'he' ? '他' : d.who === 'me' ? '我' : '做'
      console.log(`${dayOf(d.ts)} ${who}：${ledger.fullText(h.id).replace(/\s+/g, ' ').slice(0, 200)}`)
    }
    break
  }

  case 'trace': {
    // 按字查，不按意思查。和 recall 摆在一起用：
    // recall 回答「有没有像的」，trace 回答「有没有这句」。
    if (!arg) { console.log('要给一句话'); break }
    console.log(traceBlock(ledger, arg, { sid: null }))
    break
  }

  case 'thoughts': {
    // 我的推理：决定 / 教训 / 线头 / 预测。不在原话层，trace 查不到它。
    const list = typeof ledger.thoughtsView === 'function' ? ledger.thoughtsView() : (ledger.thoughts || [])
    if (!list.length) { console.log('（还没有「我的推理」：thoughts.jsonl 是空的）'); break }
    for (const t of list.slice(-40)) {
      // 出处要能指回去：第几行（原话位置）+ 落在哪一段。段是读的时候现算的——
      // 写入那一刻新的一行还没分段，存下来只会是 null。
      const line = t.src && typeof t.src.line === 'number' ? t.src.line : null
      const ep = line !== null ? ledger.episodeAt(line) : null
      // 推理本身不进 stream（按设计），所以它常常没有行号——
      // 那时退到事件序号 seq：同一个会话里 seq 是唯一的，能对回会话日志。
      const seq = t.src && typeof t.src.seq === 'number' ? t.src.seq : null
      const where = line !== null
        ? `第 ${line + 1} 行${ep ? ` · 段 #${ep.id}` : ''}`
        : (seq !== null ? `会话内第 ${seq} 事件（推理不进 stream，没有行号）` : '（没有行号）')
      console.log(`#${t.id} ${dayOf(t.ts)} [${t.kind}] ${where}`)
      console.log(`        ${t.text}${t.why ? `（因为 ${t.why}）` : ''}`)
    }
    console.log(`--- 共 ${list.length} 条（只显示最后 40 条）`)
    break
  }

  case 'pack': {
    // 打包：带 stream / marks / thoughts / usage / seqs，**不带 state**（索引要重建的）
    const r = packTo(ledger, { cwd, lineName, out: opt('out') })
    console.log(`打包完成：${r.path}`)
    console.log(`  ${(r.bytes / 1024).toFixed(0)} KB · ${r.counts.docs} 条记录 · ${r.counts.speech} 句原话 · ${r.counts.episodes} 段`)
    console.log(`  范围：${r.manifest.oldest || '?'} ~ ${r.manifest.newest || '?'}`)
    break
  }

  case 'unpack': {
    // 参数：unpack <zip 路径> --to <新工作区目录> [--line 线名] [--force]
    const zipPath = cwd
    const to = opt('to')
    if (!to) { console.log('要告诉它解到哪：--to <新工作区目录>'); break }
    try {
      const r = unpackTo(zipPath, { cwd: to, lineName: opt('line'), force: flag('force') })
      console.log(`解包完成：${r.dir}`)
      console.log(`  映射：从 <${r.mapped.fromHash}> 来 → ${r.mapped.to}`)
      console.log(`  段 ${r.manifest.counts.episodes} → 落盘 ${r.manifest.counts.episodes}`)
      console.log(`  原话 ${r.manifest.counts.speech} 句 · ${r.manifest.counts.docs} 条记录`)
    } catch (e) {
      console.log('没解：' + (e && e.message))
      process.exit(1)
    }
    break
  }

  case 'export': {
    // 导出可读：长期存档，不总结、不截断
    const md = renderMarkdown(ledger, { from: opt('from'), to: opt('to') })
    const from = opt('from') || ''
    const to = opt('to') || ''
    const name = `${(cwd.split(/[\\/]/).filter(Boolean).pop() || 'memory')}-${from || '起始'}-${to || '至今'}.md`
    const outDir = opt('out') || cwd
    const file = `${outDir.replace(/[\\/]+$/, '')}\\${name}`
    writeFileSync(file, md, 'utf8')
    console.log(`导出完成：${file}`)
    console.log(`  ${(Buffer.byteLength(md, 'utf8') / 1024).toFixed(0)} KB · ${md.split('\n').length} 行`)
    // 校验「没截断」看的是**我们自己加的标记**，不是正文里有没有省略号——
    // 原话里本来就可能有「……」，那是数据，不是 bug（2026-11-02 实测：21 个省略号全是原话里的）。
    const cutMarks = /^(……（后面还有|……（前面还有|（前面还有|（后面还有)/m.test(md)
    // 数「原话行」要**按行首**数：正文里可能引用过「〔12:34〕你说的：」，那是内容不是行
    const said = md.split('\n').filter((l) => /^〔\d{2}:\d{2}〕(?:你说的|我说的)：/.test(l)).length
    const should = ledger.stats().traces
    if (cutMarks) console.log('  ⚠ 出现了截断标记——那是 bug，不是格式（导出不许截断）')
    if (said !== should) console.log(`  ⚠ 原话句数对不上：导出 ${said} / 库里 ${should}`)
    else console.log(`  原话 ${said} 句，一句不少`)
    break
  }

  case 'prime': {
    const block = primingBlock(ledger, arg, cfg)
    // 「我的推理」也一起打出来：它和预激活是同一层（背景），只是另起一块。
    const th = thoughtBlock(ledger, arg, { max: cfg.thoughtMax ?? 2 })
    const all = [th, block].filter(Boolean).join('\n')
    console.log(all || '（没有浮起来的东西）')
    console.log('--- ' + Buffer.byteLength(all, 'utf8') + ' B')
    break
  }

  case 'backup': {
    // 手动抄一份：force=true，不看「有没有变」。自动备份在插件里（每 6 小时、没变就跳过）。
    const sub = rest[0]
    if (sub === 'list' || sub === 'ls') {
      const stamps = listBackups(ledger.dir)
      if (!stamps.length) { console.log('（还没有备份：' + backupRoot(ledger.dir) + '）'); break }
      for (const s of stamps) console.log(`  ${s}${s === stamps[stamps.length - 1] ? '  ← 最新' : ''}`)
      console.log(`共 ${stamps.length} 份 · ${backupRoot(ledger.dir)}`)
      break
    }
    const r = makeBackup(ledger.dir, { keep: Number(cfg.backupKeep ?? 3), force: true })
    console.log(`备份完成：${r.dir}`)
    console.log(`  抄了 ${r.copied} 个文件 · 现在保留 ${listBackups(ledger.dir).length} 份`)
    console.log(`  备份根：${backupRoot(ledger.dir)}`)
    break
  }

  case 'restore': {
    // 破坏性：覆盖当前库。规矩在 restoreBackup 里——先给现在这份也备一次。
    const stamp = rest.find((x) => !x.startsWith('--')) || null
    const before = { docs: ledger.docs.length, traces: ledger.stats().traces }
    const r = restoreBackup(ledger.dir, stamp)
    const after = new Ledger(ledger.dir, { meetingGapMs: cfg.meetingGapMs }).open()
    console.log(`恢复完成：${r.restored}（覆盖了 ${r.files} 个文件）`)
    console.log(`  恢复前：${before.docs} 条记录 · ${before.traces} 句原话`)
    console.log(`  恢复后：${after.docs.length} 条记录 · ${after.stats().traces} 句原话`)
    console.log(`  恢复前那份已另存：${r.safetyNet}`)
    after.close()
    break
  }

  case 'facts': {
    // 「我记下的」视图：按热度排，不是按 weight 排。
    // heat = weight × 时间衰减 × 使用加成。源一条没删。
    const view = factsView(ledger, cfg)
    if (!view.length) { console.log('（还没有特意记下的东西）'); break }
    for (const f of view) {
      const age = f.ageDays < 1 ? '今天' : `${Math.round(f.ageDays)} 天前`
      console.log(`[${f.heat.toFixed(2)}] ${f.key || '(没key)'} · ${age}${f.uses ? ` · 用过 ${f.uses} 次` : ''}`)
      console.log(`        ${f.text}`)
    }
    console.log(`--- 视图 ${view.length} 条 · 源 ${ledger.marks.length} 条（只降权，不删）`)
    break
  }

  case 'anchor': {
    const block = anchorBlock(ledger, cfg)
    console.log(block || '（还没有能当锚的话）')
    console.log('--- ' + Buffer.byteLength(block, 'utf8') + ' B')
    break
  }

  case 'arrive': {
    const block = arrivalBlock(ledger, cfg)
    console.log(block || '（空的：还没记忆）')
    console.log('--- ' + Buffer.byteLength(block, 'utf8') + ' B')
    break
  }

  case 'dump': {
    const n = Number(rest[0]) || 15
    const start = Math.max(0, ledger.docs.length - n)
    for (let i = start; i < ledger.docs.length; i++) {
      const d = ledger.docs[i]
      if (!d) continue
      console.log(`${String(i).padStart(4)} ${dayOf(d.ts)} ${(d.who || '-').padEnd(4)} ${d.text.replace(/\s+/g, ' ').slice(0, 130)}`)
    }
    break
  }

  // 体检：这条线上每个会话「多带了多少运行时上下文」「压缩接过几次」。
  // 这两个数是那轮评审的核心指控，也是最容易被自己骗过去的地方——
  // 别靠感觉，量。
  case 'audit': {
    const { listSessions } = await import('./lib/session-file.mjs')
    const { SESSIONS_DIR } = await import('./lib/config.mjs')
    const MARK = /Current runtime context|你说过的话|忽然浮起来|我记下的|你刚来到另一个|刚压掉了/
    const sessions = listSessions(SESSIONS_DIR, cwd)
    if (!sessions.length) { console.log('（这个工作区没有会话）'); break }

    let allRt = 0
    let allRtBytes = 0
    let allTurns = 0
    let allPrunes = 0
    let allShadowed = 0
    console.log('会话                        回合  运行时上下文        压缩   压掉')
    for (const s of sessions) {
      let rt = 0
      let rtBytes = 0
      let prunes = 0
      let shadowed = 0
      let turns = 0
      for (const ev of s.events) {
        if (ev.type === 'turn/start') turns += 1
        if (String(ev.type).startsWith('compaction/')) {
          prunes += 1
          shadowed += Number(ev.data && ev.data.shadowedTokenCount) || 0
        }
        if (ev.type !== 'user/message') continue
        const t = JSON.stringify(ev.data || {})
        if (MARK.test(t)) { rt += 1; rtBytes += t.length }
      }
      allRt += rt; allRtBytes += rtBytes; allTurns += turns
      allPrunes += prunes; allShadowed += shadowed
      const per = turns ? (rtBytes / 1024 / turns).toFixed(2) : '0'
      console.log(
        s.id.slice(0, 26).padEnd(28),
        String(turns).padStart(4),
        `${String(rt).padStart(3)} 份 / ${(rtBytes / 1024).toFixed(0).padStart(4)} KB`.padEnd(20),
        String(prunes).padStart(4),
        `${shadowed} tok`,
      )
      console.log(''.padEnd(28) + '  平均每回合多带 ' + per + ' KB')
    }
    console.log('—'.repeat(72))
    const per = allTurns ? (allRtBytes / 1024 / allTurns).toFixed(2) : '0'
    console.log(`合计：${allTurns} 回合 · ${allRt} 份运行时上下文 / ${(allRtBytes / 1024).toFixed(0)} KB · 平均每回合 ${per} KB`)
    console.log(`压缩：${allPrunes} 次，共压掉约 ${Math.round(allShadowed / 1000)}k token`)
    console.log(allPrunes
      ? '（有压缩发生 → 去 diag.log 里搜「压缩 」，看插件有没有接住）'
      : '（这个工作区还没压过；真正的触发点多半是 tool-result pruner，不是 1M 上限）')
    break
  }

  // 清掉「同一个人短时间内说了两遍一模一样的话」——插件重装时会撞出来。
  // **只动他/我说的话**：动手（工具调用）重复多半是真的又跑了一遍，删了就是篡改记忆。
  // 这是唯一一次改写流的机会，所以先备份，再顺手让索引作废重建。
  case 'dedup': {
    const { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync } = await import('node:fs')
    const { join } = await import('node:path')
    const p = join(dir, 'stream.jsonl')
    if (!existsSync(p)) { console.log('（没有流）'); break }
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
    const seen = new Map()
    const keep = []
    let removed = 0
    for (const ln of lines) {
      let d
      try { d = JSON.parse(ln) } catch { keep.push(ln); continue }
      if (d.who !== 'he' && d.who !== 'me') { keep.push(ln); continue }
      const t = String(d.text || '')
      const fp = `${d.who}|${d.sid || ''}|${t.length}|${t.slice(0, 48)}|${t.slice(-24)}`
      const win = t.length >= 12 ? 10 * 60 * 1000 : 60 * 1000
      const prev = seen.get(fp)
      if (prev !== undefined && Math.abs((d.ts || 0) - prev) < win) { removed += 1; continue }
      seen.set(fp, d.ts || 0)
      keep.push(ln)
    }
    if (!removed) { console.log('没有重复，不用动'); break }
    copyFileSync(p, p + '.bak')
    writeFileSync(p, keep.join('\n') + '\n', 'utf8')
    const sp = join(dir, 'state.json')
    if (existsSync(sp)) unlinkSync(sp)
    console.log(`去掉 ${removed} 条重复的「他/我」发言（备份在 stream.jsonl.bak）。动手记录一条没动。索引会在下次打开时重建。`)
    break
  }

  default:
    console.log('不认识的命令：' + cmd)
}

if (ledger) ledger.close()
