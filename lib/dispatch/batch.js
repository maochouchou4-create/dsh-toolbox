/**
 * 批次台账：四事件（start／gate／commit／review）的构造、集合式状态推导与读写。
 *
 * 本文件不 import defineTool（能直接被 node:test 加载）；I/O 一律经注入的 fs 端口
 * （本仓写侧唯一通道）。台账是唯一真相：状态永远从事件现推，不存状态文件。
 *
 * 台账只记事实：不设闸、不设提醒，也不替主会话判断「该不该提交」——事件齐不齐是主会话的
 * 事，这里只保证写进来的每一行都是调用方说的那件事。旧六阶段的 advance 事件按 stage 名归一
 * （门一/方案→方案证伪、门二→证伪门、提交/复盘各归一），归一后标 legacy：能读、能算修复轮数
 * 与会话历史，只作归档展示。
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { storeDataDir } from '../memory-root.js'
import { isNonBlankString } from '../value.js'
import { loadDispatchData } from './data.js'
import { GATE_LABELS, GATE_NAMES, KIND_ACTIONS, LIFECYCLE_KINDS, SUBJECT_PLACEHOLDER } from './vocab.js'

/** 六个动作的词表：工具描述、参数面与未知动作报错共用这一份。 */
export const BATCH_ACTIONS = ['start', 'gate', 'commit', 'review', 'status', 'list']

/** 台账文件名；位置固定（store 下的 data/，两机 git 同步的那一处才叫共享）。 */
const LEDGER_NAME = 'dispatch-ledger.jsonl'

/**
 * 规则指纹取这份规则面的原始字节，顺序固定：换序＝换指纹。规则面是人读的 templates.md
 * （形态角色句与 brief 模板同在一处），改模板即换指纹，复盘按版本分组就不会混算。
 */
const RULE_FILES = ['templates']

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
    hash.update(String(raw[name] ?? ''))
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

/** 台账解析：整份 JSON 数组或 JSONL 都收（旧工具写的是数组，现行追加行；fenced 块也收）。 */
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

/** 事件归一：v2 四事件原样收（带 tier 的 start 是旧流程事件，标 legacy），advance 走 stage 映射。 */
export function normalizeEvent(raw) {
  if (!isObject(raw)) throw new Error('台账事件必须是对象')
  if (raw.action === 'start') {
    // 新流程的 start 不写 tier；带 tier＝旧流程事件，标 legacy（历史档位只展示，不进门禁）
    const legacy = 'tier' in raw
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

/** start 事件：意图／对象／拍板清单＋规则指纹。subject 未登记写占位。 */
export function startEvent({ batch, intent, subject, decisions = [], rules, now = stamp() }) {
  return {
    t: now,
    action: 'start',
    batch,
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

/** review 事件：复盘行＋门效能字段；它是收官事件（落账后清该批台账行）。 */
export function reviewEvent({ batch, retro, efficacy = '', note = '', now = stamp() }) {
  return { t: now, action: 'review', batch, retro, efficacy, note }
}

function ordered(normalized) {
  return normalized
    .map((event, index) => ({ event, index }))
    .sort((a, b) => String(a.event.t ?? '').localeCompare(String(b.event.t ?? '')) || a.index - b.index)
    .map(item => item.event)
}

/** 阶段 kind → foldBatch 收的事件列表；kind 与事件名只有 vocab.KIND_ACTIONS 一份对应。 */
function eventsOf(kind, state) {
  const action = KIND_ACTIONS[kind]
  return action === undefined ? undefined : state[`${action}s`]
}

function stageDoneOf(kind, state) {
  const events = eventsOf(kind, state)
  return Array.isArray(events) && events.length > 0
}

function stageLegacyOf(kind, state) {
  const events = eventsOf(kind, state)
  return Array.isArray(events) && events.length > 0 && events.every(event => event.legacy)
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
  const latestStart = starts.at(-1) ?? null
  // legacy 事件带着档位登记（旧流程）；新流程不写 tier——历史值只作展示
  const legacyTier = orderedEvents.map(event => event.tier).find(value => value !== undefined) ?? null
  const intent = latestStart?.intent ?? null
  const decisions = Array.isArray(latestStart?.decisions) ? latestStart.decisions : []
  const subject = starts.find(event => isGiven(event.subject))?.subject ?? null
  const stages = data
    ? [...data.lifecycle.stages].sort((a, b) => a.order - b.order)
    : LIFECYCLE_KINDS.map((kind, index) => ({ id: kind, order: index + 1, kind }))
  const partial = { starts, gates, commits, reviews }
  const stageStates = stages.map(stage => ({
    id: stage.id,
    kind: stage.kind,
    order: stage.order,
    done: stageDoneOf(stage.kind, partial),
    legacy: stageLegacyOf(stage.kind, partial),
  }))
  const nextStage = stageStates.find(stage => !stage.done)?.id ?? null
  const warnings = []
  if (starts.length > 1) warnings.push(`批次 ${batch} 有 ${starts.length} 条 start 事件（重复立项？状态按第一条登记值算）`)
  if (starts.length === 0 && (commits.length > 0 || reviews.length > 0 || gates.length > 0)) {
    warnings.push(`批次 ${batch} 有门报/提交/复盘事件但没有 start 事件（先行事件缺立项）`)
  }
  const hasLegacy = legacyEvents.length > 0
  if (hasLegacy) {
    warnings.push(`含旧事件（legacy）${legacyEvents.length} 条：只作归档展示`)
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
    legacyTier,
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
    `${state.batch}｜已过：${stageText || '无'}｜下一阶段：${state.next ?? '完工'}`,
    state.gates.length > 0 ? `　门报 ${state.gates.length} 轮（修复轮数 ${state.fixRounds}）` : '　门报：无',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 单批状态的人话（status 视图）。 */
export function renderBatchFold(state) {
  const lines = [`批次 ${state.batch}`]
  if (state.legacyTier) lines.push(`档位（旧事件）：${state.legacyTier}`)
  if (state.intent) lines.push(`意图：${state.intent}`)
  const progress = state.stageStates
    .map(stage => `${stage.id}${stage.done ? (stage.legacy ? '（旧事件）' : '✓') : '…'}`)
    .join(' → ')
  lines.push(`进度：${progress}`)
  lines.push(state.gates.length > 0 ? `门报 ${state.gates.length} 轮（修复轮数 ${state.fixRounds}；采纳 ${state.adoption.adopted}／拒收 ${state.adoption.rejected}／双报重叠 ${state.adoption.overlap}）` : '门报：无')
  if (state.latestReview) {
    lines.push(`最近复盘：${state.latestReview.retro ?? '—'}${state.latestReview.efficacy ? `（门效能：${state.latestReview.efficacy}）` : ''}`)
  }
  if (state.latestCommit) lines.push(`提交：${state.latestCommit.commit ?? '—'}／推送 ${state.latestCommit.pushed ?? '—'}`)
  lines.push(`下一阶段：${state.next ?? '完工'}`)
  for (const warning of state.warnings) lines.push(`注意：${warning}`)
  return lines.join('\n')
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

/**
 * 收官清账：review 落账后重写台账文件＝滤掉该批全部行（含刚写的 review 行）。
 * 已完成批在台账不留档（复盘仪式已退役，无消费者）；并发追加由 replaceIfVersion 兜住，
 * 版本失配整趟重读重滤，不覆盖他人新行；解析不动的行原样保留（破坏性重写不放大坏行）。
 */
async function purgeBatchRows({ port, path, signal }, batch) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readEvents({ port, path, signal })
    if (current.observed.kind === 'absent') return
    const kept = current.text
      .split('\n')
      .filter((line) => {
        if (line.trim() === '') return true
        let event
        try {
          event = JSON.parse(line)
        } catch {
          return true
        }
        return event?.batch !== batch
      })
    try {
      const intent = { kind: 'replaceIfVersion', version: current.observed.version }
      await port.writeText(current.target, kept.join('\n'), intent, signal)
      return
    } catch (error) {
      if (attempt === 0 && error?.code === 'FS_STALE_VERSION') continue
      throw error
    }
  }
}

function assertSingleLine(value, label) {
  if (!isNonBlankString(value)) throw new Error(`${label} 必须是非空字符串`)
  if (String(value).includes('\n')) throw new Error(`${label} 必须是单行（台账事件按行追加，多行会拆成坏行）`)
  return value
}

/** 字符串数组：裁决字段的形状校验，空值不猜（缺省才给空数组）。 */
function assertStringList(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim() !== '')) {
    throw new Error(`${label} 必须是字符串数组（不得含空串）`)
  }
  return [...value]
}

/** findings 计数：非负整数。计数不四舍五入、不从别处推导。 */
function assertCount(value, label) {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负整数（findings 计数只记调用方给的数）`)
  }
  return value
}

/** perFormCounts：[{form,count}] 逐项校验（form 非空串、count 非负整数）。 */
function assertPerFormCounts(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('perFormCounts 必须是 [{form,count}] 数组')
  return value.map((item, index) => {
    if (!isObject(item) || !isNonBlankString(item.form)) {
      throw new Error(`perFormCounts[${index}]: form 必须是非空字符串`)
    }
    return { form: item.form, count: assertCount(item.count, `perFormCounts[${index}].count`) }
  })
}

/** gate 的施工段缺省：两个门各判一段（方案证伪判方案，证伪门判净 diff）。 */
function defaultSegment(gate) {
  return gate === GATE_LABELS.planChallenge ? '方案' : '净 diff'
}

/**
 * 台账六动作的入口：start／gate／commit／review 追加事件，status／list 只读推导。
 * 数据面每趟现读（事后改 templates.md 即换规则指纹，不用重启）。
 *
 * 除「改已有批次要先立项」这条引用完整性外不做工作流判断：gate 只校验门名与裁决字段形状，
 * 不要求两道门都过；commit 不拒无门批；review 不要求先 commit（台账只记事实）。
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
  const foldOf = list => foldBatch(list.filter(event => isObject(event) && event.batch === batch), data)
  const eventsOfBatch = state => state.starts.concat(state.gates, state.commits, state.reviews)
  if (action === 'list') {
    const batches = [...new Set(events.map(event => event.batch).filter(isNonBlankString))]
    if (batches.length === 0) {
      const emptyText = '台账还没有批次：dispatch_batch action=start 立项。'
      return { ok: true, rows: [], emptyText, text: emptyText }
    }
    const rows = batches.map(name => foldBatch(events.filter(event => event.batch === name), data))
    return {
      ok: true,
      rows: rows.map(state => ({ batch: state.batch, next: state.next ?? '完工', text: renderBatchRow(state) })),
      text: rows.map(renderBatchRow).join('\n'),
    }
  }
  if (action === 'status') {
    if (!isNonBlankString(batch)) {
      const batches = [...new Set(events.map(event => event.batch).filter(isNonBlankString))]
      if (batches.length === 0) {
        const emptyText = '台账还没有批次：dispatch_batch action=start 立项，status 才有东西可查。'
        return { ok: true, rows: [], emptyText, text: emptyText }
      }
      const rows = batches.map(name => foldBatch(events.filter(event => event.batch === name), data))
      return {
        ok: true,
        rows: rows.map(state => ({ batch: state.batch, next: state.next ?? '完工', text: renderBatchRow(state) })),
        text: rows.map(renderBatchRow).join('\n'),
      }
    }
    const state = foldOf(events)
    if (state.starts.length === 0) {
      throw new Error(`台账里没有批次「${batch}」的 start 事件（先 dispatch_batch action=start 立项）`)
    }
    return { ok: true, batch: state.batch, next: state.next ?? '完工', events: eventsOfBatch(state), text: renderBatchFold(state) }
  }
  if (!isNonBlankString(batch)) throw new Error(`${action} 必须带 batch（批次名）`)

  if (action === 'start') {
    const intent = assertSingleLine(params.intent, 'intent')
    const decisions = assertStringList(params.decisions, 'decisions')
    const subject = isGiven(params.subject) ? assertSingleLine(params.subject, 'subject') : undefined
    const event = startEvent({ batch, intent, subject, decisions, rules })
    const noteText = await appendStartOnce({ port, path, event, signal })
    const fresh = await readEvents({ port, path, signal })
    const after = foldOf(fresh.events)
    return { ok: true, batch, next: after.next ?? '完工', events: eventsOfBatch(after), text: `${noteText}\n${renderBatchFold(after)}` }
  }

  const state = foldOf(events)
  if (state.starts.length === 0) {
    throw new Error(`批次 ${batch} 未立项（台账无 start 事件）——先 dispatch_batch action=start 立项`)
  }

  if (action === 'gate') {
    if (!GATE_NAMES.includes(params.gate)) {
      throw new Error(`gate 必须是门名之一（${GATE_NAMES.join('／')}），实为 ${JSON.stringify(params.gate)}——台账按门名分流，未知门会让门报永远对不上号`)
    }
    const segment = isNonBlankString(params.segment) ? assertSingleLine(params.segment, 'segment') : defaultSegment(params.gate)
    const event = gateEvent({
      batch,
      gate: params.gate,
      segment,
      recommended: assertStringList(params.recommended, 'recommended'),
      forms: assertStringList(params.forms, 'forms'),
      perFormCounts: assertPerFormCounts(params.perFormCounts),
      adopted: assertCount(params.adopted, 'adopted'),
      rejected: assertCount(params.rejected, 'rejected'),
      overlap: assertCount(params.overlap, 'overlap'),
      missed: isGiven(params.missed) ? assertSingleLine(params.missed, 'missed') : '',
      note: isGiven(params.note) ? assertSingleLine(params.note, 'note') : '',
      rules,
    })
    const noteText = await appendGateEvent({ port, path, event, signal })
    const fresh = await readEvents({ port, path, signal })
    const after = foldOf(fresh.events)
    return { ok: true, batch, next: after.next ?? '完工', events: eventsOfBatch(after), text: `${noteText}\n${renderBatchFold(after)}` }
  }

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
  if (action === 'review') await purgeBatchRows({ port, path, signal }, batch)
  const after = foldOf(events.concat(event))
  return {
    ok: true,
    batch: after.batch,
    next: after.next ?? '完工',
    events: eventsOfBatch(after),
    text: renderBatchFold(after),
  }
}

/**
 * 立项落账：同批已有 start 就不重复写（重跑不制造重复立项行）。
 */
export async function appendStartOnce({ port, path, event, signal }) {
  const current = await readEvents({ port, path, signal })
  const exists = current.events
    .map(normalizeEvent)
    .some(item => item.kind === 'start' && item.batch === event.batch)
  if (exists) {
    return `批次 ${event.batch} 已登记（start 存在）：本次不重复落账（改登记先过主会话裁决）`
  }
  await appendEvent({ port, path, signal }, event, current)
  return `已落 start 事件：批次 ${event.batch}｜规则指纹 ${event.rules}`
}

/** 门报落账：gate 事件一条一轮（不合并），裁决完必须记。 */
export async function appendGateEvent({ port, path, event, signal }) {
  const current = await readEvents({ port, path, signal })
  await appendEvent({ port, path, signal }, event, current)
  return `已落 gate 事件：批次 ${event.batch}｜门 ${event.gate}｜段 ${event.segment}`
}
