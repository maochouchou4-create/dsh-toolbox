/**
 * 跑批工作流核心层：方案文档与复核 brief 的组装与渲染。
 *
 * 这一层是纯函数（data 进、结构化值出），不碰台账、不碰宿主——render 文本在 tool 的
 * render 里直出，node 直调即可断言（验收要求里的「直出可派参数」不需要重启宿主）。
 */
import { SAFETY_CARRIER_IDS, renderTemplate } from './data.js'
import { GATE_LABELS, GATE_NAMES, PARAM_FIELDS, SUBJECT_PLACEHOLDER } from './vocab.js'

export { GATE_LABELS }

/** 参数/数据引起的输入错误：一律抛，不兜底。 */
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

/** 立项出稿（单形态）：登记行＋方案骨架一次成文，无分支——进工作流＝方案先行。 */
export function assembleTask(data, params) {
  checkStageRequirements(data, '立项', params)
  const gateReportLine = renderTemplate(data.templates['门报行'], {}, '门报行')
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
  // 登记行：意图/锚点是生命周期必填（checkStageRequirements 已拦），其余各行给值才出现
  const registryLines = [
    `意图：${params.intent}`,
    params.subject ? `对象（方案文档绝对路径＋批次节指针）：${params.subject}` : null,
    `锚点（符号名，禁行号）：${[...(params.anchors ?? [])].join('、')}`,
    params.forbidden ? `禁区：${params.forbidden}` : null,
    params.budget ? `预算：${params.budget}` : null,
    params.acceptance ? `验收命令：${params.acceptance}` : null,
  ].filter(Boolean)
  const prompt = [
    '你是方案起草者（跑批立项＝方案先行：成文后交用户过目，认可再施工）。本批登记：',
    ...registryLines,
    '',
    renderPlanSpec(data),
    '',
    `末行门报：${gateReportLine}`,
    '提交归主会话：完工＝自证＋汇报即止，不 commit 不 push。',
  ].join('\n')
  return {
    batch: params.batch,
    prompt,
    workflowArgs: { label: `方案 ${params.batch}`, prompt },
    gateReportLine,
    decisionCards,
    warnings: [],
  }
}

/** 方案文档骨架（plan-spec 单源）：四节规范＋定稿自查清单＋过目指引。 */
export function renderPlanSpec(data) {
  const blocks = data.planSpec.blocks.map(block => `${block.title}\n${block.body}`).join('\n\n')
  const checklist = data.planSpec.checklist.map((item, index) => `${index + 1}. ${item}`).join('\n')
  return `${blocks}\n\n定稿自查：\n${checklist}\n\n过目：交用户过目，认可再施工；对话里呈现方案内容（过目、预览、要点、白话）必配改前/改后例子对比（不写入本文档）`
}

export function renderTaskResult(value) {
  const lines = []
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
  return lines.join('\n')
}

/** 复核工具的批量参数校验：裁决字段只在 adjudicate=true 时消费。 */
export function validateChallenge(data, params) {
  const gate = params.gate ?? GATE_LABELS.challenge
  if (!GATE_NAMES.includes(gate)) {
    throw new DispatchInputError(`未知门 ${String(gate)}；只认 ${GATE_NAMES.join('/')}`)
  }
  if (params.subject !== undefined && !isSingleLine(params.subject)) {
    throw new DispatchInputError('subject 必须是单行：证伪门＝净 diff 生成命令，方案证伪＝方案路径')
  }
  if (params.subject !== undefined && params.subject.trim() === SUBJECT_PLACEHOLDER) {
    throw new DispatchInputError(`subject 是「${SUBJECT_PLACEHOLDER}」占位：先补记方案路径/净 diff 命令再派复核`)
  }
  if (params.subject === undefined || params.subject.trim() === '') {
    if (gate === GATE_LABELS.planChallenge) {
      throw new DispatchInputError('台账登记是占位/空，请传实际方案路径＋批次节指针')
    }
    throw new DispatchInputError('证伪门的 subject 必传：净 diff 生成命令，如 git diff 起点..HEAD（起点＝施工前基线）')
  }
  if (params.batch !== undefined && !isSingleLine(params.batch)) {
    throw new DispatchInputError('batch 必须是单行批次名')
  }
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

/** 复核 brief：缺省按门给标准形态，forms 点名追加（安全专项只认显式点名），横切判据整段继承。 */
export function assembleChallenge(data, params) {
  const gate = validateChallenge(data, params)
  const formIds = data.forms.forms
    .filter(form => form.gate === gate && !SAFETY_CARRIER_IDS.includes(form.id))
    .map(form => form.id)
  for (const id of params.forms ?? []) {
    if (formIds.includes(id)) continue
    const form = data.forms.forms.find(item => item.id === id)
    if (form.gate !== gate) {
      throw new DispatchInputError(`forms 点名的形态「${id}」不属于门「${gate}」（该形态挂在「${form.gate}」下）`)
    }
    formIds.push(id)
  }
  if (formIds.length === 0) {
    throw new DispatchInputError(`门「${gate}」没有可派形态：forms.json 没有挂在它名下的标准形态（安全专项须显式点名）`)
  }
  const segment = params.segment ?? (gate === GATE_LABELS.planChallenge ? '方案' : '净 diff')
  const crossCut = renderTemplate(data.templates['横切判据'], {}, '横切判据')
  const briefs = formIds.map(id => {
    const form = data.forms.forms.find(item => item.id === id)
    const template = gate === GATE_LABELS.planChallenge ? '方案证伪' : '证伪门'
    const body = renderTemplate(
      data.templates[template],
      {
        横切判据: crossCut,
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
    segment,
    briefs,
    workflowArgs: briefs.map(brief => ({ label: `${label}·${brief.form}`, prompt: brief.text })),
    gateReportLine,
    warnings: [],
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
    lines.push('门效能字段照记，台账 review 收官即随批清账。')
    return lines.join('\n')
  }
  lines.push(`门：${value.gate}｜形态：${value.briefs.map(brief => brief.form).join('／')}｜段标记：${value.segment}`)
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

/** 工具 schema 用的参数表：立项与复核各一套，互不串槽。 */
export function taskParamNames() {
  return [
    'batch',
    'intent',
    'subject',
    'anchors',
    'decisions',
    'forbidden',
    'budget',
    'acceptance',
    'decisionCards',
  ]
}

export function challengeParamNames() {
  return [
    'batch',
    'gate',
    'subject',
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
