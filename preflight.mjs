// 预检：在把一个工作区接进海马体**之前**，先量一遍它有多大、会被切成多少段。
//
//   node preflight.mjs "D:\ws\assistant"
//
// 为什么要有这一步：接一个新工作区 = 一次性把它的历史全倒进来。
// 倒之前应该知道：多少会话、多少条记录、多少字、大概切几段、锚有多长。
// 不要装完才发现它是三个月的量。
//
// 注意：这个脚本**只读**。库还不存在的时候它不会替你建一个空库。

import { statSync, existsSync } from 'node:fs'
import { listSessions } from './lib/session-file.mjs'
import { SESSIONS_DIR, workspaceDir } from './lib/config.mjs'
import { archivedSessionIds } from './lib/backfill.mjs'
import { eventToRecords } from './lib/capture.mjs'
import { Ledger } from './lib/store.mjs'

const targets = process.argv.slice(2)
if (!targets.length) {
  console.log('用法：node preflight.mjs <工作区目录> [...]')
  process.exit(1)
}

// 2026-11-04：原来这里调 loadCfg()——它会顺手刷一份 ~/.dsh/hippocampus/config.json.bak，
// 跟上面那句「这个脚本只读」对不上。preflight 用不到配置，直接不碰。

for (const ws of targets) {
  const t0 = Date.now()
  let ss = []
  try { ss = listSessions(SESSIONS_DIR, ws) } catch {}
  const skip = archivedSessionIds()

  let kept = 0
  let archived = 0
  let fileBytes = 0
  let records = 0
  let chars = 0
  for (const s of ss) {
    fileBytes += statSync(s.path).size
    if (skip.has(s.id)) { archived += 1; continue }
    kept += 1
    for (const ev of s.events) {
      for (const r of eventToRecords(ev)) { records += 1; chars += (r.text || '').length }
    }
  }

  // 已有库就顺手续上它的数；没有就只报「待导入」，别为了量体积去建一个空库
  let have = null
  const dir = workspaceDir(ws)
  if (existsSync(dir)) {
    try {
      const l = new Ledger(dir, {}).open()
      have = { records: l.stats().docs, episodes: l.stats().episodes, traces: l.stats().traces, bytes: l.stats().bytes }
      l.close()
    } catch {}
  }

  console.log(JSON.stringify({
    工作区: ws.split('\\').pop(),
    会话: ss.length,
    归档: archived,
    有效会话: kept,
    可导入记录: records,
    原文: (chars / 1024).toFixed(0) + 'K 字',
    磁盘: (fileBytes / 1048576).toFixed(1) + 'MB',
    现有库: have ? `${have.records} 条 / ${have.episodes} 段 · ${(have.bytes / 1024).toFixed(0)}KB` : '（还没建）',
    差: have ? records - have.records : '（待导入）',
    解析ms: Date.now() - t0,
  }, null, 1))
}
