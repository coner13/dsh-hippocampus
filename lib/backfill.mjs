// 回填：把一个工作区里已经发生过的对话，倒进记忆里。
//
// 为什么要有这一步：新装上的记忆系统如果只有「从今往后」，那它一开始就是个陌生人。
// 回填让它一睁眼就带着过去——但只倒**自己的**（同 cwd、不含子会话、不含归档的）。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_HOME, SESSIONS_DIR } from './config.mjs'
import { listSessions } from './session-file.mjs'
import { eventToRecords, eventKey } from './capture.mjs'

export function archivedSessionIds() {
  const set = new Set()
  try {
    const p = join(DSH_HOME, 'storages', 'workspace.json')
    if (!existsSync(p)) return set
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const g = j && (j.global || j)
    const ids = (g && g.archivedSessionIds) || []
    for (const id of ids) set.add(typeof id === 'string' ? id : id && id.id)
  } catch {}
  return set
}

export function backfill(ledger, cwd, cfg = {}, allow = null) {
  const skip = cfg.includeArchived ? new Set() : archivedSessionIds()
  let sessions = []
  try { sessions = listSessions(SESSIONS_DIR, cwd) } catch { return { added: 0, sessions: 0 } }

  // 已经在流里的记录，不要再倒一遍。
  // 光靠 seqs 不够——两个实例各记各的序号，谁最后保存就把别人的那几行抹掉；
  // 抹掉之后下一轮回填就会把旧会话整段重倒。这里按「同一份会话、同一毫秒、同一个人、同样的开头」
  // 认作同一个事件，重复的直接跳过。这比 seqs 稳，而且不依赖任何一方记得住。
  const seen = new Set()
  for (const d of ledger.docs) {
    if (!d) continue
    seen.add(`${d.sid || ''}|${d.ts || 0}|${d.who || ''}|${String(d.text || '').slice(0, 40)}`)
  }

  let added = 0
  let used = 0
  for (const s of sessions) {
    if (skip.has(s.id)) continue
    // 多线文件夹：只倒属于这条线的会话。没登记的，哪怕就在同一个文件夹里，也不碰。
    if (typeof allow === 'function' && !allow(s.id)) continue
    used += 1
    for (const ev of s.events) {
      const key = eventKey(ev)
      if (key !== null && ledger.seenSeq(s.id, key)) continue
      const recs = eventToRecords(ev)
      for (const r of recs) {
        // 回填不做内容去重（间隔久的两句同样的话是真的说了两遍）；
        // 但同一条事件被倒第二遍要挡住，否则换文件 / 两个实例之后就会重影。
        const fp = `${s.id}|${r.ts || 0}|${r.who || ''}|${String(r.text || '').slice(0, 40)}`
        if (seen.has(fp)) continue
        seen.add(fp)
        ledger.append({ ...r, sid: s.id }, { dedupe: false })
        added += 1
      }
      if (key !== null) ledger.noteSeq(s.id, key)
    }
  }
  if (added) ledger.seal(true)
  return { added, sessions: used }
}
