/**
 * 复盘辅助（dispatch_lessons）：读台账、判点位、出配对规则修订建议草稿。
 *
 * 口径要点：review 事件＝全仓销账点（其后仍有事件的批进增量统计，之前的只进全量累计）；
 * 历史统计按事件内规则指纹分组，不跨版本平均（配对表/形态表改过，旧批的 findings 率不能
 * 直接和新口径平均）；修复轮数＝同一批证伪门轮数−1。只出建议，不写盘、不改配对表。
 */
import { normalizeEvent, parseLedger } from './batch.js'
import { loadDispatchData } from './data.js'
import { GATE_LABELS } from './vocab.js'

/** 零拦截降级的观测次数下限（跨全量台账累积）。 */
const ZERO_FORM_TIMES = 2

/** 形态明细只列 findings 前 N 名，其余归并。 */
const TOP_FORMS = 5

/** 双报重叠告警线：重叠 findings 占总 gate 轮数的比例。 */
const OVERLAP_ALERT = 0.34

/** 采纳率告警线：采纳数/(采纳+拒收) 低于它时提示复核组合可能失准。 */
const ADOPTION_ALERT = 0.5

function isNonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/** 复盘节奏判据点：lifecycle 里带 point 的那一行（单源，不在这里抄阈值）。 */
export function pointOf(data) {
  const row = data.lifecycle.stages.find(stage => stage.point !== undefined)
  if (!row) throw new Error('lifecycle.json 缺 point 字段（复盘节奏判据点）——数据面坏了，先修数据')
  return { ...row.point, stage: row.id }
}

function tally(map, key, count = 1) {
  map.set(key, (map.get(key) ?? 0) + count)
}

function sortedEntries(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
}

/**
 * 台账统计：按批归并四事件，切出增量窗口（上次 review 之后），再算门效能与形态 findings。
 */
export function collectStats(events) {
  const normalized = events.map(normalizeEvent)
  const byBatch = new Map()
  for (const event of normalized) {
    if (!isNonBlank(event.batch)) continue
    if (!byBatch.has(event.batch)) {
      byBatch.set(event.batch, { batch: event.batch, starts: [], gates: [], reviews: [], commits: [], other: [] })
    }
    const slot = byBatch.get(event.batch)
    const bucket = event.kind === 'start' ? slot.starts : event.kind === 'gate' ? slot.gates : event.kind === 'review' ? slot.reviews : event.kind === 'commit' ? slot.commits : slot.other
    bucket.push(event)
  }
  const batches = [...byBatch.values()]
    .map(slot => {
      const start = slot.starts[0] ?? null
      const rules = start?.rules ?? slot.gates.find(event => isNonBlank(event.rules))?.rules ?? 'unknown'
      const t0 = start?.t ?? slot.gates[0]?.t ?? slot.reviews[0]?.t ?? ''
      return {
        batch: slot.batch,
        tier: start?.tier ?? slot.gates.find(event => event.tier !== undefined)?.tier ?? null,
        triage: start?.triage ?? null,
        rules,
        t0,
        gates: [...slot.gates].sort((a, b) => String(a.t ?? '').localeCompare(String(b.t ?? ''))),
        reviews: [...slot.reviews].sort((a, b) => String(a.t ?? '').localeCompare(String(b.t ?? ''))),
      }
    })
    .sort((a, b) => String(a.t0).localeCompare(String(b.t0)))
  const reviewTimes = batches.flatMap(batch => batch.reviews.map(review => review.t)).filter(Boolean).sort()
  const cutoff = reviewTimes.at(-1) ?? null
  const increment = cutoff === null ? batches : batches.filter(batch => String(batch.t0) > String(cutoff))
  const typeOf = batch => batch.tier ?? '（未登记档位）'
  const incrementTypes = new Set(increment.map(typeOf))
  const allTypes = new Set(batches.map(typeOf))
  const rules = new Map()
  for (const batch of batches) tally(rules, batch.rules)
  const formFindings = new Map()
  const formDispatched = new Map()
  const formAdopted = new Map()
  let gateRounds = 0
  let adopted = 0
  let rejected = 0
  let overlap = 0
  let missedBatches = 0
  const fixRoundsByBatch = []
  const efficacy = []
  for (const batch of batches) {
    const challengeGates = batch.gates.filter(event => event.gate === GATE_LABELS.challenge)
    fixRoundsByBatch.push(Math.max(0, challengeGates.length - 1))
    for (const event of batch.gates) {
      gateRounds += 1
      adopted += Number.isSafeInteger(event.adopted) ? event.adopted : 0
      rejected += Number.isSafeInteger(event.rejected) ? event.rejected : 0
      overlap += Number.isSafeInteger(event.overlap) ? event.overlap : 0
      if (isNonBlank(event.missed)) missedBatches += 1
      for (const id of event.forms ?? []) tally(formDispatched, id)
      for (const item of event.perFormCounts ?? []) {
        if (!isNonBlank(item.form)) continue
        tally(formFindings, item.form, Number.isSafeInteger(item.count) ? item.count : 0)
      }
      if (Number.isSafeInteger(event.adopted)) {
        for (const id of event.forms ?? []) tally(formAdopted, id, 0)
      }
    }
    for (const review of batch.reviews) {
      if (isNonBlank(review.efficacy)) efficacy.push(`${batch.batch}：${review.efficacy}`)
    }
  }
  const versionStats = sortedEntries(rules).map(([fingerprint, count]) => ({ rules: fingerprint, batchCount: count }))
  const zeroForms = sortedEntries(formDispatched)
    .filter(([form, dispatched]) => dispatched >= ZERO_FORM_TIMES && (formFindings.get(form) ?? 0) === 0)
    .map(([form, dispatched]) => ({ form, dispatched }))
  const avgFixRounds = fixRoundsByBatch.length === 0 ? 0 : fixRoundsByBatch.reduce((sum, value) => sum + value, 0) / fixRoundsByBatch.length
  const adoptionTotal = adopted + rejected
  return {
    batches: batches.length,
    cutoff,
    incrementCount: increment.length,
    incrementTypes: [...incrementTypes],
    allTypes: [...allTypes],
    gateRounds,
    adopted,
    rejected,
    overlap,
    adoptionRate: adoptionTotal === 0 ? null : adopted / adoptionTotal,
    missedBatches,
    avgFixRounds,
    maxFixRounds: fixRoundsByBatch.length === 0 ? 0 : Math.max(...fixRoundsByBatch),
    formFindings: sortedEntries(formFindings).slice(0, TOP_FORMS).map(([form, count]) => ({ form, count })),
    uselessForms: zeroForms,
    versions: versionStats,
    efficacy,
    batchesDetail: batches.map(batch => ({ batch: batch.batch, tier: batch.tier, rules: batch.rules, gates: batch.gates.length })),
  }
}

/** 点位判定：增量批数与档位覆盖同时达标才算到点；全量攒到上限也提示该复盘了。 */
export function judgeDue(stats, point) {
  const countOk = stats.incrementCount >= point.minBatches
  const typeOk = stats.incrementTypes.length >= point.minTiers
  const forcedByVolume = stats.batches >= point.upperBatches
  return {
    due: (countOk && typeOk) || forcedByVolume,
    countOk,
    typeOk,
    forcedByVolume,
    reason:
      stats.cutoff === null
        ? `台账还没有 review 事件：按全量 ${stats.batches} 批算`
        : `上次复盘〔${stats.cutoff}〕后增量 ${stats.incrementCount} 批／全量 ${stats.batches} 批`,
  }
}

/** 建议草稿：只出「配对规则怎么改」的方向，采纳与否归主会话。 */
export function buildSuggestions(stats, point, force) {
  const suggestions = []
  if (!force && !judgeDue(stats, point).due) {
    return [`未到复盘点位：增量 ${stats.incrementCount} 批／需 ${point.minBatches} 批，档位覆盖 ${stats.incrementTypes.length}／需 ${point.minTiers}——先攒批，不为清零而复盘。`]
  }
  for (const item of stats.uselessForms) {
    suggestions.push(
      `${item.form}：全量台账实派 ${item.dispatched} 次、findings 0 条 → 建议降级或删除（连续零拦截；按台账累积，不跨规则版本平均）。`,
    )
  }
  if (stats.missedBatches > 0) {
    suggestions.push(`漏网 ${stats.missedBatches} 批：按漏网类型加派对应形态（门报里 missed 字段是唯一线索，先看它写的是什么）。`)
  }
  if (stats.avgFixRounds > 1) {
    suggestions.push(
      `修复轮数均值 ${stats.avgFixRounds.toFixed(1)}（最高 ${stats.maxFixRounds}）：复核在拦真问题，暂不放松；若某形态连续零 findings 再考虑降级。`,
    )
  } else if (stats.avgFixRounds === 0 && stats.gateRounds > 0) {
    suggestions.push('修复轮数恒为 0：证伪门从未逼出返工——先确认 findings 是否真被采纳，而不是门空转。')
  }
  if (stats.gateRounds > 0 && stats.overlap / stats.gateRounds > OVERLAP_ALERT) {
    suggestions.push(
      `双报重叠 ${stats.overlap}／${stats.gateRounds} 轮：两路在看同一处，建议合并该组合或改一路判据。`,
    )
  }
  if (stats.adoptionRate !== null && stats.adoptionRate < ADOPTION_ALERT) {
    suggestions.push(
      `采纳率 ${(stats.adoptionRate * 100).toFixed(0)}%（采纳 ${stats.adopted}／拒收 ${stats.rejected}）：拒收偏多，先核 findings 证据链（复跑命令贴没贴）再改配对表。`,
    )
  }
  if (stats.efficacy.length > 0) {
    suggestions.push(`门效能记录（review 事件 ${stats.efficacy.length} 条，按需并入下一版配对表）：${stats.efficacy.slice(0, 3).join('；')}`)
  }
  if (suggestions.length === 0) suggestions.push('无可采建议：本轮维持现配对表（先把台账攒厚，单批样本不足以改规则）。')
  return suggestions
}

function formatStats(stats, point, due) {
  const lines = []
  lines.push(
    `复盘口径：上次复盘〔${stats.cutoff ?? '无（全量）'}〕｜增量 ${stats.incrementCount} 批｜全量 ${stats.batches} 批｜档位覆盖 ${stats.incrementTypes.join('／') || '无'}`,
  )
  lines.push(
    `点位判据：攒 ${point.minBatches}–${point.upperBatches} 批、覆盖 ≥${point.minTiers} 档位 → ${due.due ? '已到点位' : '未到点位'}`,
  )
  lines.push(
    `门报：${stats.gateRounds} 轮｜采纳 ${stats.adopted}／拒收 ${stats.rejected}／双报重叠 ${stats.overlap}｜修复轮数 均值 ${stats.avgFixRounds.toFixed(1)}（最高 ${stats.maxFixRounds}）`,
  )
  lines.push(
    stats.formFindings.length === 0
      ? '形态 findings：台账里还没有 perFormCounts 落库（裁决时 dispatch_challenge 要带 perFormCounts）'
      : `形态 findings：${stats.formFindings.map(item => `${item.form}=${item.count}`).join('｜')}`,
  )
  if (stats.versions.length > 1) {
    lines.push(`规则版本：${stats.versions.map(item => `${item.rules}=${item.batchCount} 批`).join('｜')}（分组统计，不跨版本平均）`)
  }
  if (stats.efficacy.length > 0) lines.push(`门效能：${stats.efficacy.slice(0, 3).join('；')}`)
  return lines.join('\n')
}

async function readEvents({ port, path, signal }) {
  const target = await port.resolve(path)
  const observed = await port.stat(target, signal)
  const text = observed.kind === 'absent' ? '' : await port.readText(target, signal)
  return parseLedger(text, '台账')
}

/**
 * 复盘入口：台账缺失按「还没有复盘事件」处理（空台账不是错误，是攒批期）。
 */
export async function runLessons({ port, path, dataDir, force = false, signal }) {
  const data = loadDispatchData(dataDir).data
  const point = pointOf(data)
  const events = await readEvents({ port, path, signal })
  const stats = collectStats(events)
  const judged = judgeDue(stats, point)
  const due = force || judged.due
  const suggestions = buildSuggestions(stats, point, force)
  const statsText = formatStats(stats, point, judged)
  return { due, stats: statsText, suggestions }
}

/** 渲染：stats 与 suggestions 都是 execute 算好的，这里只排版。 */
export function renderLessonsResult(value) {
  const lines = [value.stats]
  lines.push('')
  lines.push(value.due ? '到复盘点位：以下是配对规则修订建议草稿（只出建议，采纳归主会话）。' : '未到复盘点位。')
  for (const suggestion of value.suggestions) lines.push(`· ${suggestion}`)
  return lines.join('\n')
}
