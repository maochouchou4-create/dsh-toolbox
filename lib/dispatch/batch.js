/**
 * 批次台账 v2：四事件（start／gate／commit／review）的构造、集合式状态推导、读写与回填。
 *
 * 本文件不 import defineTool（能直接被 node:test 加载）；I/O 一律经注入的 fs 端口，
 * 与 memory 写侧同一条通道。台账是唯一真相：状态永远从事件现推，不存状态文件。
 *
 * 旧六阶段的 advance 事件按 stage 名归一（门一/方案→方案证伪、门二→证伪门、提交/复盘各归一），
 * 归一后标 legacy：能读、能算修复轮数与会话历史，但不参与门禁硬判——旧事件的判定口径与 v2
 * 不同，拿它当门禁会让「旧流程跑过的批」在新门禁下永远差一道门。
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { storeDataDir } from '../memory-root.js'
import { isNonBlankString } from '../value.js'
import { loadDispatchData } from './data.js'
import {
  BACKFILL_FIELDS,
  GATE_LABELS,
  GATE_NAMES,
  LIFECYCLE_KINDS,
  SUBJECT_PLACEHOLDER,
} from './vocab.js'

/** 四个动作的词表：工具描述、参数面与未知动作报错共用这一份。 */
export const BATCH_ACTIONS = ['commit', 'review', 'status', 'list']

/** 台账文件名；位置固定（store 下的 data/，两机 git 同步的那一处才叫共享）。 */
const LEDGER_NAME = 'dispatch-ledger.jsonl'

/** 规则指纹取这两份规则面的原始字节，顺序固定：换序＝换指纹。 */
const RULE_FILES = ['pairing.json', 'forms.json']

/** 坏行报错里回显的那一截。 */
const BAD_LINE_SAMPLE = 80

/** 旧流程的六个阶段名（归一读的输入词表；v2 不再新写这些阶段）。 */
const LEGACY_STAGES = ['方案', '门一', '施工', '门二', '提交', '复盘']

/** 「render 拿不到推导输入」＝内部不变量破坏，不是调用方用法错误。 */
export class RenderModelMissingError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RenderModelMissingError'
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGiven(value) {
  return value !== undefined && value !== null && value !== ''
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 台账路径：显式配置优先，缺省按记忆根推导到 store 下的 data/。 */
export function resolveLedgerPath({ configuredPath, memoryRoot } = {}) {
  if (isNonBlankString(configuredPath)) return configuredPath
  return join(storeDataDir(memoryRoot), LEDGER_NAME)
}

/** 规则版本指纹（原始字节 sha256 前 12 位）：复盘统计按它分组，跨版本不混算。 */
export function rulesFingerprint(raw) {
  if (!isObject(raw)) return 'unknown'
  const hash = createHash('sha256')
  for (const name of RULE_FILES) {
    const key = name === 'pairing.json' ? 'pairing' : 'forms'
    hash.update(String(raw[key] ?? ''))
    hash.update('\u0000')
  }
  return hash.digest('hex').slice(0, 12)
}

function parseArrayBody(body) {
  try {
    const parsed = JSON.parse(body)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 台账解析：整份 JSON 数组或 JSONL 都收（旧工具写的是数组，v2 追加行；fenced 块也收）。 */
export function parseLedger(text, label = '台账') {
  let body = String(text ?? '').trim()
  if (body === '') return []
  if (body.startsWith('```')) {
    body = body.replace(/^```[A-Za-z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  }
  const asArray = parseArrayBody(body)
  if (asArray) {
    asArray.forEach((event, index) => {
      if (!isObject(event)) throw new Error(`${label}: 第 ${index + 1} 个事件必须是对象`)
    })
    return asArray
  }
  const events = []
  body.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed === '') return
    let event
    try {
      event = JSON.parse(trimmed)
    } catch (error) {
      throw new Error(
        `${label}: 第 ${index + 1} 行不是合法 JSON 事件（${error.message}）：${trimmed.slice(0, BAD_LINE_SAMPLE)}${trimmed.length > BAD_LINE_SAMPLE ? '…' : ''}`,
      )
    }
    if (!isObject(event)) throw new Error(`${label}: 第 ${index + 1} 行的事件必须是对象`)
    events.push(event)
  })
  return events
}

/** 旧 advance 事件的归一：按 stage 名映射到四事件，统一标 legacy。 */
function normalizeLegacyAdvance(raw) {
  const stage = raw.stage
  const forms = Array.isArray(raw.forms)
    ? raw.forms
    : isObject(raw.combo)
      ? Object.keys(raw.combo)
      : []
  const perFormCounts = Array.isArray(raw.perFormCounts)
    ? raw.perFormCounts
    : isObject(raw.formCounts)
      ? Object.entries(raw.formCounts).map(([form, count]) => ({ form, count }))
      : []
  if (stage === '门一' || stage === '方案') {
    return { ...raw, kind: 'gate', gate: GATE_LABELS.planChallenge, forms, perFormCounts, legacy: true }
  }
  if (stage === '门二') {
    return { ...raw, kind: 'gate', gate: GATE_LABELS.challenge, forms, perFormCounts, legacy: true }
  }
  if (stage === '提交') {
    return { ...raw, kind: 'commit', legacy: true, commit: raw.commit ?? null, pushed: raw.pushed ?? null }
  }
  if (stage === '复盘') {
    return { ...raw, kind: 'review', legacy: true, retro: raw.retro ?? raw.note ?? '' }
  }
  return { ...raw, kind: 'legacy', legacy: true }
}

/** 事件归一：v2 四事件原样收（旧 start 无 tier/triage 标 legacy），advance 走 stage 映射。 */
export function normalizeEvent(raw) {
  if (!isObject(raw)) throw new Error('台账事件必须是对象')
  if (raw.action === 'start') {
    const legacy = !('tier' in raw) || !('triage' in raw)
    return { ...raw, kind: 'start', legacy }
  }
  if (raw.action === 'gate') return { ...raw, kind: 'gate', legacy: raw.legacy === true }
  if (raw.action === 'commit') return { ...raw, kind: 'commit', legacy: raw.legacy === true }
  if (raw.action === 'review') return { ...raw, kind: 'review', legacy: raw.legacy === true }
  if (raw.action === 'advance') {
    if (!LEGACY_STAGES.includes(raw.stage) && raw.stage !== undefined) {
      return { ...raw, kind: 'legacy', legacy: true }
    }
    return normalizeLegacyAdvance(raw)
  }
  return { ...raw, kind: 'legacy', legacy: true }
}

function stamp() {
  return new Date().toISOString()
}

/** start 事件：档位／分诊行／拍板清单＋规则指纹。subject 未登记写占位。 */
export function startEvent({ batch, tier, triage, intent, subject, decisions = [], rules, now = stamp() }) {
  return {
    t: now,
    action: 'start',
    batch,
    tier,
    triage,
    intent,
    subject: isGiven(subject) ? subject : SUBJECT_PLACEHOLDER,
    decisions: [...(decisions ?? [])],
    rules,
  }
}

/** gate 事件：门名＋findings 裁决字段＋施工段标记（方案证伪段 vs 净 diff 段）。 */
export function gateEvent({
  batch,
  gate,
  tier,
  segment,
  recommended = [],
  forms = [],
  perFormCounts = [],
  adopted = 0,
  rejected = 0,
  overlap = 0,
  missed = '',
  note = '',
  rules,
  now = stamp(),
}) {
  return {
    t: now,
    action: 'gate',
    batch,
    gate,
    tier,
    segment,
    recommended: [...recommended],
    forms: [...forms],
    perFormCounts: [...perFormCounts],
    adopted,
    rejected,
    overlap,
    missed,
    note,
    rules,
  }
}

/** commit 事件：commit 号＋推送结果。 */
export function commitEvent({ batch, commit, pushed, note = '', now = stamp() }) {
  return { t: now, action: 'commit', batch, commit, pushed, note }
}

/** review 事件：复盘行＋门效能字段（交 dispatch_lessons 读）。 */
export function reviewEvent({ batch, retro, efficacy = '', note = '', now = stamp() }) {
  return { t: now, action: 'review', batch, retro, efficacy, note }
}

function ordered(normalized) {
  return normalized
    .map((event, index) => ({ event, index }))
    .sort((a, b) => String(a.event.t ?? '').localeCompare(String(b.event.t ?? '')) || a.index - b.index)
    .map(item => item.event)
}

function stageDoneOf(kind, state) {
  if (kind === '立项') return state.starts.length > 0
  if (kind === '门报') return state.gates.length > 0
  if (kind === '提交') return state.commits.length > 0
  if (kind === '复盘') return state.reviews.length > 0
  return false
}

function stageLegacyOf(kind, state) {
  if (kind === '立项') return state.starts.length > 0 && state.starts.every(event => event.legacy)
  if (kind === '门报') return state.gates.length > 0 && state.gates.every(event => event.legacy)
  if (kind === '提交') return state.commits.length > 0 && state.commits.every(event => event.legacy)
  if (kind === '复盘') return state.reviews.length > 0 && state.reviews.every(event => event.legacy)
  return false
}

/**
 * 集合式状态推导：批次的一生从事件现推，不按行序累加（跨机合并的追加行天然乱序）。
 */
export function foldBatch(events, data = null) {
  const normalized = events.map(normalizeEvent)
  const batch = normalized.find(event => isNonBlankString(event.batch))?.batch ?? null
  const orderedEvents = ordered(normalized.filter(event => event.batch === batch))
  const starts = orderedEvents.filter(event => event.kind === 'start')
  const gates = orderedEvents.filter(event => event.kind === 'gate')
  const commits = orderedEvents.filter(event => event.kind === 'commit')
  const reviews = orderedEvents.filter(event => event.kind === 'review')
  const legacyEvents = orderedEvents.filter(event => event.legacy === true || event.kind === 'legacy')
  const latestStart = [...starts].reverse().find(event => event.tier !== undefined) ?? starts.at(-1) ?? null
  const tier = latestStart?.tier ?? [...gates].reverse().find(event => event.tier !== undefined)?.tier ?? null
  const triage = latestStart?.triage ?? null
  const intent = latestStart?.intent ?? null
  const decisions = Array.isArray(latestStart?.decisions) ? latestStart.decisions : []
  const subject = starts.find(event => isGiven(event.subject))?.subject ?? null
  const stages = data
    ? [...data.lifecycle.stages].sort((a, b) => a.order - b.order)
    : LIFECYCLE_KINDS.map((kind, index) => ({ id: kind, order: index + 1, kind, gate: kind === '门报' }))
  const partial = { starts, gates, commits, reviews }
  const stageStates = stages.map(stage => ({
    id: stage.id,
    kind: stage.kind,
    order: stage.order,
    done: stageDoneOf(stage.kind, partial),
    legacy: stageLegacyOf(stage.kind, partial),
  }))
  const nextStage = stageStates.find(stage => !stage.done)?.id ?? null
  const tierRow = tier === null ? null : (data?.pairing.tiers.find(row => row.tier === tier) ?? null)
  const requiredGates = []
  if (tierRow?.planChallenge?.length) requiredGates.push(GATE_LABELS.planChallenge)
  if (tierRow?.challenge?.length) requiredGates.push(GATE_LABELS.challenge)
  const recordedGates = new Set(gates.map(event => event.gate).filter(name => GATE_NAMES.includes(name)))
  const gatesAhead = requiredGates.filter(name => !recordedGates.has(name))
  const warnings = []
  if (starts.length > 1) warnings.push(`批次 ${batch} 有 ${starts.length} 条 start 事件（重复立项？状态按第一条登记值算）`)
  if (starts.length === 0 && (commits.length > 0 || reviews.length > 0 || gates.length > 0)) {
    warnings.push(`批次 ${batch} 有门报/提交/复盘事件但没有 start 事件（先行事件缺立项）`)
  }
  if (tier === null) warnings.push(`批次 ${batch} 档位未登记（旧事件或未立项）：门禁判定降级`)
  const hasLegacy = legacyEvents.length > 0
  if (gatesAhead.length > 0 && !hasLegacy && starts.length > 0) {
    warnings.push(`门禁未过：${gatesAhead.join('、')}（提交前必查；先 dispatch_challenge 出 brief 并裁决记账）`)
  }
  if (hasLegacy) {
    warnings.push(`含旧事件（legacy）${legacyEvents.length} 条：门禁不参与硬判，仅按归档展示`)
  }
  const fixRounds = Math.max(0, gates.filter(event => event.gate === GATE_LABELS.challenge).length - 1)
  const adoption = gates.reduce(
    (acc, event) => ({
      adopted: acc.adopted + (Number.isSafeInteger(event.adopted) ? event.adopted : 0),
      rejected: acc.rejected + (Number.isSafeInteger(event.rejected) ? event.rejected : 0),
      overlap: acc.overlap + (Number.isSafeInteger(event.overlap) ? event.overlap : 0),
    }),
    { adopted: 0, rejected: 0, overlap: 0 },
  )
  return {
    batch,
    tier,
    triage,
    intent,
    subject,
    decisions,
    starts,
    gates,
    commits,
    reviews,
    legacyEvents,
    stageStates,
    next: nextStage,
    gatesAhead,
    requiredGates,
    fixRounds,
    adoption,
    warnings,
    latestGate: gates.at(-1) ?? null,
    latestCommit: commits.at(-1) ?? null,
    latestReview: reviews.at(-1) ?? null,
  }
}

/** 一批一行的摘要（list 与不带批次的 status 共用）。 */
export function renderBatchRow(state) {
  const stageText = state.stageStates
    .filter(stage => stage.done)
    .map(stage => `${stage.id}${stage.legacy ? '（旧）' : ''}`)
    .join('→')
  return [
    `${state.batch}｜${state.tier ?? '（未登记档位）'}｜已过：${stageText || '无'}｜下一阶段：${state.next ?? '完工'}`,
    state.gates.length > 0 ? `　门报 ${state.gates.length} 轮（修复轮数 ${state.fixRounds}）` : '　门报：无',
    state.gatesAhead.length > 0 ? `　门禁未过：${state.gatesAhead.join('、')}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

/** 单批状态的人话（status 视图）。 */
export function renderBatchFold(state) {
  const lines = [`批次 ${state.batch}｜档位 ${state.tier ?? '（未登记）'}`]
  if (state.triage) lines.push(`分诊行：${state.triage}`)
  if (state.intent) lines.push(`意图：${state.intent}`)
  const progress = state.stageStates
    .map(stage => `${stage.id}${stage.done ? (stage.legacy ? '（旧事件）' : '✓') : '…'}`)
    .join(' → ')
  lines.push(`进度：${progress}`)
  lines.push(state.gates.length > 0 ? `门报 ${state.gates.length} 轮（修复轮数 ${state.fixRounds}；采纳 ${state.adoption.adopted}／拒收 ${state.adoption.rejected}／双报重叠 ${state.adoption.overlap}）` : '门报：无')
  if (state.gatesAhead.length > 0) lines.push(`门禁未过：${state.gatesAhead.join('、')}`)
  else if (state.requiredGates.length > 0) lines.push(`门禁：${state.requiredGates.join('、')} 已过`)
  if (state.latestReview) {
    lines.push(`最近复盘：${state.latestReview.retro ?? '—'}${state.latestReview.efficacy ? `（门效能：${state.latestReview.efficacy}）` : ''}`)
  }
  if (state.latestCommit) lines.push(`提交：${state.latestCommit.commit ?? '—'}／推送 ${state.latestCommit.pushed ?? '—'}`)
  lines.push(`下一阶段：${state.next ?? '完工'}`)
  for (const warning of state.warnings) lines.push(`注意：${warning}`)
  return lines.join('\n')
}

/** 回填：台账登记的那几格按 gate 消费，显式传参优先且不许与台账说岔。 */
export function backfillFromBatch(state, gate) {
  const values = {}
  const notes = []
  if (!state) return { values, notes }
  const excluded = gate === GATE_LABELS.challenge ? ['subject'] : []
  for (const field of BACKFILL_FIELDS) {
    if (excluded.includes(field)) continue
    const value = state[field]
    if (!isGiven(value)) continue
    if (field === 'subject' && value === SUBJECT_PLACEHOLDER) {
      notes.push(`批次 ${state.batch} 的 subject 是占位「${SUBJECT_PLACEHOLDER}」：按未登记处理，请补记或显式传 subject`)
      continue
    }
    if (Array.isArray(value) && value.length === 0) continue
    values[field] = value
  }
  return { values, notes }
}

/** 合并显式参数与回填值：显式优先；显式空值或与台账冲突都是错。 */
export function mergeBackfill({ args, state, gate }) {
  const { values, notes } = backfillFromBatch(state, gate)
  // 非回填参数（adjudicate／裁决字段／segment 等）原样带过去：回填只负责补登记格，
  // 不能把调用方显式传的其它槽位吞掉（吞掉的症状是「裁决永远记不上账」）。
  const params = { ...values, ...args }
  for (const field of BACKFILL_FIELDS) {
    if (!(field in args)) continue
    const explicit = args[field]
    if (!isGiven(explicit) || (Array.isArray(explicit) && explicit.length === 0)) {
      throw new Error(
        `显式传了空的 ${field}（${JSON.stringify(explicit)}）——台账里这一格登记着「${JSON.stringify(values[field] ?? '（无）')}」；要么按台账来（删掉该参数），要么改成非空值`,
      )
    }
    if (field in values && !deepEqual(explicit, values[field])) {
      throw new Error(
        `参数 ${field} 与批次「${args.batch}」台账里登记的不一致：传值 ${JSON.stringify(explicit)}，台账 ${JSON.stringify(values[field])}——删掉该参数改由台账回填，或改台账口径后再调`,
      )
    }
    params[field] = explicit
  }
  return { params, notes }
}

async function readEvents({ port, path, signal }) {
  const target = await port.resolve(path)
  const observed = await port.stat(target, signal)
  const text = observed.kind === 'absent' ? '' : await port.readText(target, signal)
  return { target, observed, text, events: parseLedger(text, '台账') }
}

async function appendEvent({ port, path, signal }, event, existing) {
  const line = `${JSON.stringify(event)}\n`
  const current = existing ?? await readEvents({ port, path, signal })
  const body = current.text === '' || current.text.endsWith('\n') ? current.text : `${current.text}\n`
  const target = current.target
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const intent =
        current.observed.kind === 'absent'
          ? { kind: 'createIfAbsent' }
          : { kind: 'replaceIfVersion', version: current.observed.version }
      await port.writeText(target, body + line, intent, signal)
      return
    } catch (error) {
      if (attempt === 0 && current.observed.kind !== 'absent' && error?.code === 'FS_STALE_VERSION') {
        const fresh = await readEvents({ port, path, signal })
        return appendEvent({ port, path, signal }, event, fresh)
      }
      if (attempt === 0 && current.observed.kind === 'absent' && error?.code === 'FS_NOT_OBSERVED') {
        const fresh = await readEvents({ port, path, signal })
        return appendEvent({ port, path, signal }, event, fresh)
      }
      throw error
    }
  }
}

function assertSingleLine(value, label) {
  if (!isNonBlankString(value)) throw new Error(`${label} 必须是非空字符串`)
  if (String(value).includes('\n')) throw new Error(`${label} 必须是单行（台账事件按行追加，多行会拆成坏行）`)
  return value
}

/**
 * 台账四动作的入口：commit／review 追加事件，status／list 只读推导。
 * 数据面每趟现读（事后改 JSON 即改门禁口径，不用重启）。
 */
export async function runBatchAction({ port, path, dataDir, action, params = {}, signal }) {
  if (!BATCH_ACTIONS.includes(action)) {
    throw new Error(`未知台账动作 ${String(action)}；只认 ${BATCH_ACTIONS.join('／')}`)
  }
  const loaded = loadDispatchData(dataDir)
  const data = loaded.data
  const rules = rulesFingerprint(loaded.raw)
  const { target, observed, text, events } = await readEvents({ port, path, signal })
  const batch = params.batch
  if (action === 'list') {
    const batches = [...new Set(events.map(event => event.batch).filter(isNonBlankString))]
    if (batches.length === 0) {
      return { ok: true, rows: [], emptyText: '台账还没有批次：dispatch_task 出稿即自动立项。', text: '台账还没有批次：dispatch_task 出稿即自动立项。' }
    }
    const rows = batches.map(name => foldBatch(events.filter(event => event.batch === name), data))
    const textOut = rows.map(renderBatchRow).join('\n')
    return {
      ok: true,
      rows: rows.map(state => ({ batch: state.batch, tier: state.tier, next: state.next, text: renderBatchRow(state) })),
      text: textOut,
    }
  }
  if (action === 'status') {
    if (!isNonBlankString(batch)) {
      const batches = [...new Set(events.map(event => event.batch).filter(isNonBlankString))]
      if (batches.length === 0) {
        return { ok: true, rows: [], emptyText: '台账还没有批次：dispatch_task 出稿即自动立项，status 才有东西可查。', text: '台账还没有批次：dispatch_task 出稿即自动立项，status 才有东西可查。' }
      }
      const rows = batches.map(name => foldBatch(events.filter(event => event.batch === name), data))
      return {
        ok: true,
        rows: rows.map(state => ({ batch: state.batch, tier: state.tier, next: state.next, text: renderBatchRow(state) })),
        text: rows.map(renderBatchRow).join('\n'),
      }
    }
    const state = foldBatch(events.filter(event => event.batch === batch), data)
    if (state.starts.length === 0) {
      throw new Error(`台账里没有批次「${batch}」的 start 事件（先 dispatch_task 立项）`)
    }
    return { ok: true, batch: state.batch, tier: state.tier, next: state.next, events: state.starts.concat(state.gates, state.commits, state.reviews), text: renderBatchFold(state) }
  }
  if (!isNonBlankString(batch)) throw new Error(`${action} 必须带 batch（批次名）`)
  const state = foldBatch(events.filter(event => event.batch === batch), data)
  if (state.starts.length === 0) throw new Error(`批次 ${batch} 未立项（台账无 start 事件）——先 dispatch_task 出稿立项`)
  let event
  if (action === 'commit') {
    const commit = assertSingleLine(params.commit, 'commit')
    const pushed = assertSingleLine(params.pushed, 'pushed')
    event = commitEvent({ batch, commit, pushed, note: params.note ?? '' })
  } else {
    const retro = assertSingleLine(params.retro, 'retro')
    event = reviewEvent({ batch, retro, efficacy: params.efficacy ?? '', note: params.note ?? '' })
  }
  await appendEvent({ port, path, signal }, event, { target, observed, text, events })
  const after = foldBatch(events.concat(event).filter(item => item.batch === batch), data)
  return {
    ok: true,
    batch: after.batch,
    tier: after.tier,
    next: after.next,
    events: after.starts.concat(after.gates, after.commits, after.reviews),
    text: renderBatchFold(after),
  }
}

/**
 * 立项落账：同批已有 start 就不重复写（台账只追加，重跑出稿不制造重复立项行）。
 */
export async function appendStartOnce({ port, path, event, signal }) {
  const current = await readEvents({ port, path, signal })
  const exists = current.events
    .map(normalizeEvent)
    .some(item => item.kind === 'start' && item.batch === event.batch)
  if (exists) {
    return `批次 ${event.batch} 已登记（start 存在）：本次不重复落账（台账只追加；改档位/分诊行先裁决口径）`
  }
  await appendEvent({ port, path, signal }, event, current)
  return `已落 start 事件：批次 ${event.batch}｜档位 ${event.tier}｜规则指纹 ${event.rules}`
}

/** 门报落账：gate 事件一条一轮（不合并），裁决完必须记。 */
export async function appendGateEvent({ port, path, event, signal }) {
  const current = await readEvents({ port, path, signal })
  await appendEvent({ port, path, signal }, event, current)
  return `已落 gate 事件：批次 ${event.batch}｜门 ${event.gate}｜段 ${event.segment}`
}

/** 读某批的折叠状态（复核工具回填用；批次不存在返回 null 而不是炸）。 */
export async function loadBatchState({ port, path, batch, data, signal }) {
  if (!isNonBlankString(batch)) return null
  const { events } = await readEvents({ port, path, signal })
  const state = foldBatch(events.filter(event => event.batch === batch), data ?? null)
  return state.starts.length > 0 ? state : null
}

export { LEDGER_NAME }
