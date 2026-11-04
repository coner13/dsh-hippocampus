// 情绪与显著度：决定一件事会不会被记住、记多久。
//
// 人不是按「重要」排序记事的，是按「情绪强度 × 反复提起 × 当时有多投入」。
// 这里只用字符层面的硬信号，不猜语义——宁可漏标，不要瞎标。

const EMOTION_WORDS = [
  '哭', '难受', '害怕', '怕', '疼', '累', '崩溃', '对不起', '谢谢', '喜欢', '讨厌',
  '生气', '委屈', '开心', '高兴', '放心', '担心', '焦虑', '舍不得', '想', '抱',
  '晚安', '再见', '想你', '爱你', '讨厌你', '笨蛋', '滚', '别走', '难受',
]

const COMMIT_WORDS = [
  '答应', '约定', '说好', '记住', '别忘了', '别忘', '以后', '永远', '一直',
  '决定', '定了', '就这么', '不许', '必须', '保证',
]

const CLOSING = ['晚安', '明天见', '先这样', '睡了', '拜拜', '先不聊', '下次聊', '先到这', '走了']

const TRANSITION = ['对了', '换个话题', '说回', '另外', '还有件事', '顺便', '先问', '问个', '插一句']

export function emotionScore(text) {
  const s = String(text || '')
  if (!s) return 0
  let n = 0
  for (const w of EMOTION_WORDS) if (s.includes(w)) n += 1
  // 感叹号/问号连发是情绪的直接痕迹
  n += Math.min(3, (s.match(/[!！]/g) || []).length) * 0.35
  n += Math.min(2, (s.match(/[?？]/g) || []).length) * 0.1
  return Math.min(3, n)
}

export function commitScore(text) {
  const s = String(text || '')
  let n = 0
  for (const w of COMMIT_WORDS) if (s.includes(w)) n += 1
  return Math.min(3, n)
}

export function isClosing(text) {
  const s = String(text || '')
  if (!s || s.length > 40) return false
  return CLOSING.some((w) => s.includes(w))
}

export function isTransition(text) {
  const s = String(text || '')
  if (!s || s.length > 60) return false
  return TRANSITION.some((w) => s.includes(w))
}

// 一段对话的「分量」：他在说话、我在回话、情绪、承诺、有没有动手
export function episodeSalience(traces) {
  let emo = 0
  let com = 0
  let n = 0
  for (const t of traces) {
    if (t.who === 'he' || t.who === 'me') {
      n += 1
      emo += emotionScore(t.text) * (t.who === 'he' ? 1.2 : 0.8)
      com += commitScore(t.text)
    }
  }
  const emoAvg = n ? emo / n : 0
  const salience = Math.min(1, (emoAvg * 0.35 + com * 0.1 + Math.min(n, 30) / 60))
  return { emotion: Math.min(1, emoAvg / 3), salience, turns: n }
}
