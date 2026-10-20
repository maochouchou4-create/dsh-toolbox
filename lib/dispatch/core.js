/**
 * 跑批工作流 v2 核心层：分诊、任务书、证伪门 brief 的组装与渲染。
 *
 * 这一层是纯函数（data 进、结构化值出），不碰台账、不碰宿主——render 文本在 tool 的
 * render 里直出，node 直调即可断言（验收要求里的「直出可派参数」不需要重启宿主）。
 */
import { ASSEMBLER_CONTRACTS, PLACEHOLDER_REGISTRY, SAFETY_CARRIER_IDS, renderTemplate } from './data.js'
import {
  BACKFILL_FIELDS,
  DIFF_BUDGET_FALLBACK,
  GATE_COLUMN_BY_LABEL,
  GATE_LABELS,
  GATE_NAMES,
  LIFECYCLE_KINDS,
  PARAM_FIELDS,
  SUBJECT_PLACEHOLDER,
  TIERS,
} from './vocab.js'

export {
  ASSEMBLER_CONTRACTS,
  BACKFILL_FIELDS,
  GATE_COLUMN_BY_LABEL,
  GATE_LABELS,
  GATE_NAMES,
  LIFECYCLE_KINDS,
  PLACEHOLDER_REGISTRY,
  SUBJECT_PLACEHOLDER,
  TIERS,
}
export { renderTemplate }

/** 分诊/参数/数据引起的输入错误：一律抛，不兜底。 */
export class DispatchInputError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DispatchInputError'
  }
}

/** 工具 schema 之外的参数：模型多看一行 AGENTS 就会多塞，必须当场拒绝而不是静默丢。 */
export class UnknownParamError extends DispatchInputError {
  constructor(name, tool) {
    super(`未知参数 ${name}（${tool} 不认识该槽位；schema 与 AGENTS 注入不同步？）`)
    this.name = 'UnknownParamError'
    this.param = name
  }
}

const GATE_FORMS = {
  [GATE_LABELS.planChallenge]: '方案证伪',
  [GATE_LABELS.challenge]: '证伪门',
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isSingleLine(value) {
  return isNonEmptyString(value) && !value.includes('\n')
}

function byOrder(a, b) {
  return a.order - b.order
}

/** 生命周期行（按 order 排序）。 */
export function stageRows(data) {
  return [...data.lifecycle.stages].sort(byOrder)
}

/** 档位行；未知档位即错（配对表是闭集）。 */
export function tierRow(data, tier) {
  const row = data.pairing.tiers.find(item => item.tier === tier)
  if (!row) throw new DispatchInputError(`未知档位 ${String(tier)}；配对表只认 ${TIERS.join('/')}`)
  return row
}

/** diff 预算阈值：单源在「diff 超阈」硬触发行，缺行时用兜底常量。 */
export function diffBudgetOf(data) {
  const row = data.pairing.hardTriggers.find(item => Number.isSafeInteger(item.threshold))
  return row ? row.threshold : DIFF_BUDGET_FALLBACK
}

/** 语义域硬触发：分诊行里出现关键词即命中（判定依据记在分诊行，这里只做机械识别）。 */
export function semanticTriggerOf(data, text) {
  const row = data.pairing.hardTriggers.find(item => item.id === '语义域')
  if (!row || !isNonEmptyString(text)) return null
  const keywords = String(row.match).replace(/^涉/, '').split('／').filter(Boolean)
  const hits = keywords.filter(keyword => text.includes(keyword))
  if (hits.length === 0) return null
  return { trigger: row.id, keywords: hits, form: row.form ?? null }
}

/** 本批门组合：方案证伪（施工前）→ 证伪门（施工后），语义域命中追加安全专项。 */
export function gatesFor(data, tier, { triage = '' } = {}) {
  const row = tierRow(data, tier)
  const semantic = semanticTriggerOf(data, triage)
  const planForms = [...(row.planChallenge ?? [])]
  const challengeForms = [...(row.challenge ?? [])]
  if (semantic?.form && !challengeForms.includes(semantic.form)) challengeForms.push(semantic.form)
  return {
    tier: row.tier,
    planChallenge: planForms,
    challenge: challengeForms,
    semantic,
    taskBook: row.taskBook,
  }
}

/** 门组合的人话形式（分诊行/渲染行共用一个口径）。 */
export function gateComboText(gates) {
  if (gates.planChallenge.length === 0 && gates.challenge.length === 0) return '无（本档免复核门）'
  const plan = `${gates.planChallenge.length} 路`
  const challenge = `${gates.challenge.length} 路`
  const extra = gates.challenge.filter(id => SAFETY_CARRIER_IDS.includes(id))
  const suffix = extra.length > 0 ? `（含${extra.join('/')}）` : ''
  return `方案证伪 ${plan}／证伪门 ${challenge}${suffix}`
}

/** 断言参数名合法：模型多塞的槽位当场报错，不静默丢。 */
export function assertKnownParams(tool, params, allowed) {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw new UnknownParamError(key, tool)
  }
}

function requireFields(params, fields, stageName) {
  const missing = fields.filter(field => {
    const value = params[field]
    if (Array.isArray(value)) return value.length === 0
    if (typeof value === 'string') return value.trim().length === 0
    return value === undefined || value === null
  })
  if (missing.length > 0) {
    throw new DispatchInputError(
      `批次缺必填参数：${missing.join('、')}（生命周期「${stageName}」要求；空值即错，不兜底）`,
    )
  }
}

function checkTriage(params) {
  if (!isSingleLine(params.triage)) {
    throw new DispatchInputError('分诊行必须是单行（格式：档位｜判定依据）——多行分诊没法进台账')
  }
  if (!params.triage.startsWith(params.tier)) {
    throw new DispatchInputError(`分诊行必须以档位 ${params.tier} 开头（实为「${params.triage.slice(0, 12)}…」）`)
  }
}

function checkBudget(params) {
  for (const field of ['changedFiles', 'diffLines']) {
    if (params[field] === undefined) continue
    if (!Number.isSafeInteger(params[field]) || params[field] < 0) {
      throw new DispatchInputError(`${field} 必须是非负整数（diff 预算机判用）`)
    }
  }
}

/** diff 预算判定：超阈强制升 L，越阈不降档。未提供的键不落对象——出口要过 lossless 校验，undefined 值键过不了。 */
export function judgeDiffBudget(data, params) {
  const threshold = diffBudgetOf(data)
  const { changedFiles, diffLines } = params
  const budget = { threshold }
  if (changedFiles !== undefined) budget.changedFiles = changedFiles
  if (diffLines !== undefined) budget.diffLines = diffLines
  if (changedFiles === undefined && diffLines === undefined) {
    return { ...budget, verdict: 'UNJUDGED', reason: '未提供 changedFiles/diffLines，按分诊行人工判定' }
  }
  if (diffLines === undefined) {
    return { ...budget, verdict: 'UNJUDGED', reason: '只给了 changedFiles，阈值按行数判，缺 diffLines' }
  }
  const verdict = diffLines > threshold ? 'OVER' : 'WITHIN'
  return {
    ...budget,
    verdict,
    reason: verdict === 'OVER' ? `diffLines ${diffLines} 超过阈值 ${threshold} 行` : `diffLines ${diffLines} ≤ 阈值 ${threshold} 行`,
  }
}

function normalizedDecisionCards(cards) {
  if (cards === undefined) return []
  if (!Array.isArray(cards)) throw new DispatchInputError('decisionCards 必须是对象数组')
  return cards.map((card, index) => {
    if (!isObject(card)) throw new DispatchInputError(`decisionCards[${index}] 必须是对象`)
    for (const key of ['question', 'options', 'recommendation', 'reason', 'impact']) {
      if (!isNonEmptyString(card[key])) {
        throw new DispatchInputError(`decisionCards[${index}].${key} 必须是非空字符串`)
      }
    }
    if (!Array.isArray(card.options) && !isNonEmptyString(card.options)) {
      throw new DispatchInputError(`decisionCards[${index}].options 必须是字符串或字符串数组`)
    }
    return card
  })
}

/** 任务书渲染：S 档免任务书（只出分诊＋自验口径），M/L 档按模板出稿。 */
export function assembleTask(data, params) {
  const row = tierRow(data, params.tier)
  checkTriage(params)
  checkBudget(params)
  const diffBudget = judgeDiffBudget(data, params)
  if (diffBudget.verdict === 'OVER' && row.tier !== 'L') {
    throw new DispatchInputError(
      `diff 超阈：${diffBudget.reason}，强制升 L（当前档位 ${row.tier}）。请按 tier=L 重出，不降档收。`,
    )
  }
  const gates = gatesFor(data, row.tier, { triage: params.triage })
  const warnings = []
  if (diffBudget.verdict === 'OVER' && row.tier === 'L') warnings.push(`diff 超阈已按 L 档出稿：${diffBudget.reason}`)
  if (gates.semantic) {
    warnings.push(`语义域命中（${gates.semantic.keywords.join('/')}），已加挂${gates.semantic.form}到证伪门`)
  }
  if (row.taskBook && !isNonEmptyString(params.budget)) {
    warnings.push('预算未写：任务书预算行省略（S/M 默认按 ≤30 文件收）')
  }
  const gateReportLine = renderTemplate(data.templates['门报行'], {}, '门报行')
  const triageLine = `分诊：${params.triage}｜门组合：${gateComboText(gates)}｜diff：${diffBudget.verdict}`
  const decisionCards = normalizedDecisionCards(params.decisionCards).map((card, index) =>
    renderTemplate(
      data.templates['拍板卡'],
      {
        编号: String(index + 1),
        问题: card.question,
        选项: Array.isArray(card.options) ? card.options.join('／') : card.options,
        推荐: card.recommendation,
        理由: card.reason,
        影响: card.impact,
      },
      '拍板卡',
    ),
  )
  const anchors = [...(params.anchors ?? [])]
  let prompt
  if (row.taskBook) {
    prompt = renderTemplate(
      data.templates['任务书骨架'],
      {
        intent: params.intent,
        subject: params.subject ?? '',
        anchors: anchors.join('、'),
        forbidden: params.forbidden ?? '',
        budget: params.budget ?? '',
        acceptance: params.acceptance ?? '',
        门报行: gateReportLine,
      },
      '任务书骨架',
    )
  } else {
    prompt = [
      `你是施工者。本批分诊 ${row.tier}（小修）：免任务书，不免记账（start 事件已落）。`,
      `意图：${params.intent}`,
      `锚点（符号名，禁行号）：${anchors.join('、')}`,
      params.acceptance ? `现存断言（必须实跑并贴输出）：${params.acceptance}` : '现存断言：任务书未点名，施工者选一条能覆盖改动的现存断言并贴命令＋退出码',
      '自证：贴「测试命令＋退出码」；改守门断言须变异必红后复原；机械门（测试/lint/typecheck）全绿。',
      '上报：只报现象＋证据＋影响面事实，不附方案。',
      `纪律：贴不出「现存断言命令＋退出码」＝本批升 M；撞设计冲突停下上报；不 commit 不 push。`,
      `末行门报：${gateReportLine}`,
    ].join('\n')
  }
  const planAppendix = row.tier === 'L' ? renderPlanSpec(data) : ''
  const label = row.taskBook ? `施工 ${params.batch}（${row.tier}）` : `施工 ${params.batch}（${row.tier} 小修）`
  return {
    batch: params.batch,
    tier: row.tier,
    taskBook: row.taskBook,
    triage: params.triage,
    triageLine,
    diffBudget,
    gates: { planChallenge: gates.planChallenge, challenge: gates.challenge },
    prompt,
    workflowArgs: { label, prompt },
    gateReportLine,
    decisionCards,
    planAppendix,
    warnings,
  }
}

/** L 档的方案文档骨架（例外件：仅设计未定批写）。 */
export function renderPlanSpec(data) {
  const blocks = data.planSpec.blocks.map(block => `${block.title}\n${block.body}`).join('\n\n')
  const checklist = data.planSpec.checklist.map((item, index) => `${index + 1}. ${item}`).join('\n')
  return `${blocks}\n\n定稿自查：\n${checklist}`
}

export function renderTaskResult(value) {
  const lines = []
  lines.push(value.triageLine)
  lines.push(
    value.diffBudget.verdict === 'UNJUDGED'
      ? `diff 预算：未机判（${value.diffBudget.reason}）`
      : `diff 预算：changedFiles=${value.diffBudget.changedFiles ?? '—'}／diffLines=${value.diffBudget.diffLines}／阈值 ${value.diffBudget.threshold} → ${value.diffBudget.verdict}`,
  )
  lines.push('')
  lines.push(value.taskBook ? '── 任务书 ──' : '── S 档施工指令（免任务书）──')
  lines.push(value.prompt)
  lines.push('')
  lines.push('── 派发参数（subagent 直接可用；workflow 用 args.workflowArgs）──')
  lines.push(JSON.stringify(value.workflowArgs, null, 2))
  lines.push('')
  lines.push(`── ${value.gateReportLine}`)
  for (const warning of value.warnings) lines.push(`注意：${warning}`)
  if (value.decisionCards.length > 0) {
    lines.push('')
    lines.push('── 决策卡（仅架构级/产品语义级）──')
    for (const card of value.decisionCards) lines.push(card)
  }
  if (value.planAppendix) {
    lines.push('')
    lines.push('── 方案文档（L 档例外件：设计未定批才写，成文后走方案证伪）──')
    lines.push(value.planAppendix)
  }
  return lines.join('\n')
}

/** 复核工具的批量参数校验：裁决字段只在 adjudicate=true 时消费。 */
export function validateChallenge(data, params) {
  const gate = params.gate ?? GATE_LABELS.challenge
  if (!GATE_NAMES.includes(gate)) {
    throw new DispatchInputError(`未知门 ${String(gate)}；只认 ${GATE_NAMES.join('/')}`)
  }
  if (!isSingleLine(params.subject)) {
    throw new DispatchInputError('subject 必须是单行：证伪门＝净 diff 生成命令，方案证伪＝方案路径')
  }
  if (params.subject.trim() === SUBJECT_PLACEHOLDER) {
    throw new DispatchInputError(`subject 是「${SUBJECT_PLACEHOLDER}」占位：先补记方案路径/净 diff 命令再派复核`)
  }
  if (params.batch !== undefined && !isSingleLine(params.batch)) {
    throw new DispatchInputError('batch 必须是单行批次名')
  }
  if (params.tier !== undefined) tierRow(data, params.tier)
  for (const id of params.forms ?? []) {
    if (!data.forms.forms.some(form => form.id === id)) {
      throw new DispatchInputError(`forms 含未激活形态「${id}」（forms.json 只收 ${data.forms.forms.map(form => form.id).join('/')}）`)
    }
  }
  if (params.adjudicate) {
    for (const field of ['adopted', 'rejected', 'overlap']) {
      if (params[field] === undefined) continue
      if (!Number.isSafeInteger(params[field]) || params[field] < 0) {
        throw new DispatchInputError(`${field} 必须是非负整数（findings 裁决口径）`)
      }
    }
    for (const [index, item] of (params.perFormCounts ?? []).entries()) {
      if (!isObject(item) || !isNonEmptyString(item.form)) {
        throw new DispatchInputError(`perFormCounts[${index}] 必须是 {form, count}`)
      }
      if (!Number.isSafeInteger(item.count) || item.count < 0) {
        throw new DispatchInputError(`perFormCounts[${index}].count 必须是非负整数`)
      }
    }
    if (typeof params.segment === 'string' && params.segment.trim().length === 0) {
      throw new DispatchInputError('segment 给了就必须是非空施工段标记')
    }
  }
  return gate
}

/** 证伪门 brief：每形态一段，继承横切判据原文，不读施工汇报。 */
export function assembleChallenge(data, params) {
  const gate = validateChallenge(data, params)
  const row = params.tier ? tierRow(data, params.tier) : null
  const gates = params.tier ? gatesFor(data, params.tier, { triage: params.triage ?? '' }) : null
  const fallbackForms = data.forms.forms
    .filter(form => form.gate === gate && !SAFETY_CARRIER_IDS.includes(form.id))
    .map(form => form.id)
  const formIds = gate === GATE_LABELS.planChallenge
    ? (gates?.planChallenge ?? fallbackForms)
    : (gates?.challenge ?? fallbackForms)
  const segment = params.segment ?? (gate === GATE_LABELS.planChallenge ? '方案' : '净 diff')
  const crossCut = renderTemplate(data.templates['横切判据'], {}, '横切判据')
  const warnings = []
  if (gates?.semantic) warnings.push(`语义域命中（${gates.semantic.keywords.join('/')}），${gates.semantic.form}已加挂`)
  const forms = formIds.map(id => data.forms.forms.find(form => form.id === id)).filter(Boolean)
  if (forms.length === 0) {
    throw new DispatchInputError(
      `门「${gate}」没有可派形态：检查配对表 ${params.tier ?? '（缺档位）'} 行的 ${GATE_COLUMN_BY_LABEL[gate]} 列`,
    )
  }
  const briefs = forms.map(form => {
    const template = gate === GATE_LABELS.planChallenge ? '方案证伪' : '证伪门'
    const body = renderTemplate(
      data.templates[template],
      {
        横切判据: crossCut,
        tier: params.tier ?? row?.tier ?? '',
        segment,
        intent: params.intent ?? '',
        decisions: (params.decisions ?? []).join('；'),
        subject: params.subject,
      },
      template,
    )
    const extras = form.extras ? `\n${form.extras}` : ''
    return { form: form.id, text: `${form.role}\n${body}${extras}` }
  })
  const gateReportLine = renderTemplate(data.templates['门报行'], {}, '门报行')
  const label = `${gate} ${params.batch ?? ''}`.trim()
  return {
    batch: params.batch ?? null,
    gate,
    tier: params.tier ?? null,
    segment,
    triageLine: params.triage ? `分诊：${params.triage}` : null,
    briefs,
    workflowArgs: briefs.map(brief => ({ label: `${label}·${brief.form}`, prompt: brief.text })),
    gateReportLine,
    warnings,
  }
}

export function renderChallengeResult(value) {
  const lines = []
  if (value.adjudication) {
    const adjudication = value.adjudication
    lines.push(
      `已记门报：批次 ${value.batch}｜门 ${value.gate}｜findings 实派 ${adjudication.forms.length} 形态｜采纳 ${adjudication.adopted}／拒收 ${adjudication.rejected}／双报重叠 ${adjudication.overlap}｜段标记 ${value.segment}`,
    )
    if (adjudication.missed) lines.push(`漏网：${adjudication.missed}`)
    if (adjudication.note) lines.push(`附注：${adjudication.note}`)
    lines.push('门效能交复盘（dispatch_lessons 读 adopted/rejected/overlap 趋势）。')
    return lines.join('\n')
  }
  lines.push(`门：${value.gate}｜形态：${value.briefs.map(brief => brief.form).join('／')}｜段标记：${value.segment}`)
  if (value.triageLine) lines.push(value.triageLine)
  lines.push('一轮为限：本轮报完即收，不追加重派。')
  for (const brief of value.briefs) {
    lines.push('')
    lines.push(`── 复核 brief：${brief.form} ──`)
    lines.push(brief.text)
  }
  lines.push('')
  lines.push('── 派发参数（workflow agent() 直接可用）──')
  lines.push(JSON.stringify(value.workflowArgs, null, 2))
  lines.push('')
  lines.push(`── ${value.gateReportLine}`)
  for (const warning of value.warnings) lines.push(`注意：${warning}`)
  return lines.join('\n')
}

/** 工具 schema 用的参数表：任务书与复核各一套，互不串槽。 */
export function taskParamNames() {
  return [
    'batch',
    'tier',
    'triage',
    'intent',
    'subject',
    'anchors',
    'decisions',
    'forbidden',
    'budget',
    'acceptance',
    'changedFiles',
    'diffLines',
    'decisionCards',
  ]
}

export function challengeParamNames() {
  return [
    'batch',
    'gate',
    'subject',
    'tier',
    'triage',
    'intent',
    'decisions',
    'segment',
    'adjudicate',
    'forms',
    'recommended',
    'perFormCounts',
    'adopted',
    'rejected',
    'overlap',
    'missed',
    'note',
  ]
}

/** 生命周期 requires 的机判（task/challenge 共用）。 */
export function checkStageRequirements(data, stageId, params) {
  const row = data.lifecycle.stages.find(stage => stage.id === stageId)
  if (!row) throw new DispatchInputError(`未知阶段 ${stageId}`)
  requireFields(params, row.requires, row.id)
  return row
}

/** 参数面自检：task/challenge 的工具参数并集必须覆盖 PARAM_FIELDS 里被生命周期引用的字段。 */
export function assertParamCoverage() {
  const names = new Set([...taskParamNames(), ...challengeParamNames()])
  const lifecycleFields = new Set(PARAM_FIELDS.filter(field => field !== 'batch'))
  for (const field of lifecycleFields) {
    if (!names.has(field)) {
      throw new DispatchInputError(`PARAM_FIELDS 含 ${field}，但 task/challenge 的工具参数都没接——生命周期 requires 会落空`)
    }
  }
  return true
}
