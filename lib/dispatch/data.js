/**
 * 跑批工作流 v2 数据面：五份 JSON 的加载、形状校验与跨文件互验。
 *
 * 只读文件、不做 I/O 之外的事；跨文件互验在这里一次做全——数据面之间的绑死关系
 * （配对表指向形态、形态指向门、模板占位符、生命周期参数）只要有一条对不上就加载失败，
 * 不给下游留下「运行期才发现」的半截数据。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GATE_LABELS,
  GATE_NAMES,
  LIFECYCLE_KINDS,
  PARAM_FIELDS,
  TIERS,
} from './vocab.js'

/** 仓内数据目录：data.js 同目录下的 data/。 */
export const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data')

/** 数据文件清单（加载顺序即报错顺序）。 */
export const DATA_FILES = [
  { name: 'forms', file: 'forms.json', shape: 'forms' },
  { name: 'pairing', file: 'pairing.json', shape: 'pairing' },
  { name: 'templates', file: 'templates.json', shape: 'templates' },
  { name: 'lifecycle', file: 'lifecycle.json', shape: 'lifecycle' },
  { name: 'planSpec', file: 'plan-spec.json', shape: 'planSpec' },
]

/** 安全专项是五问（鉴权/越权/输入/上传/日志脱敏）的唯一载体；其他形态不得各记一份。 */
export const SAFETY_CARRIER_IDS = ['安全专项']

/** 安全形态必须覆盖的五问锚点（角色句里逐条出现）。 */
const SAFETY_ANCHORS = ['鉴权', '越权', '输入', '上传', 'PII']

/**
 * 装配工具契约：哪件工具在哪一阶段落哪种事件。台账层按 event 字段分流，
 * 生命周期层按 stage 字段对账——两份数据面（代码常量与 lifecycle.json）靠这个表互相钉住。
 */
export const ASSEMBLER_CONTRACTS = [
  { name: 'dispatch_task', stage: '立项', event: 'start' },
  { name: 'dispatch_challenge', stage: '门报', event: 'gate' },
]

/** 模板键全集：templates.json 必须恰好提供这些键（不多不少）。 */
export const TEMPLATE_KEYS = [
  '任务书骨架',
  '证伪门',
  '方案证伪',
  '横切判据',
  '拍板卡',
  '门报行',
]

/** 各模板可用的占位符：越表写进模板＝加载失败。 */
/** 模板行数上限：结构保证（加载期卡），防模板随版本越写越长。 */
export const TEMPLATE_LINE_LIMITS = { 任务书骨架: 15, 拍板卡: 6 }

export const PLACEHOLDER_REGISTRY = {
  intent: '任务意图一句话',
  anchors: '锚点符号清单',
  forbidden: '禁区',
  budget: '预算说明',
  acceptance: '验收命令',
  门报行: '门报行 schema',
  tier: '档位 S/M/L',
  triage: '分诊一行',
  segment: '施工段标记',
  subject: '复核对象；证伪门＝净 diff 生成命令，方案证伪＝方案路径',
  decisions: '拍板清单（不得重开）逐条原文',
  横切判据: '横切判据全文',
  编号: '决策卡编号',
  问题: '决策卡问题',
  选项: '决策卡选项',
  推荐: '决策卡推荐',
  理由: '决策卡理由',
  影响: '决策卡影响',
}

/** 占位符语法：全角方括号包住的名字（与模板正文里的全角标点不冲突）。 */
const PLACEHOLDER_RE = /〔([^〔〕]+)〕/g

/** 加载期错误：读不到文件、JSON 语义错、跨文件对不上。 */
export class DispatchDataError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DispatchDataError'
  }
}

export function isRegisteredPlaceholder(token) {
  return Object.prototype.hasOwnProperty.call(PLACEHOLDER_REGISTRY, token)
}

/**
 * 行级渲染模板：占位符为空串时整行省略（可选行），未提供值为错（缺参数必须炸）。
 */
export function renderTemplate(text, values, where = '模板') {
  if (typeof text !== 'string' || text.length === 0) {
    throw new DispatchDataError(`${where}: 模板必须是字符串`)
  }
  const out = []
  for (const line of text.split('\n')) {
    const tokens = [...line.matchAll(PLACEHOLDER_RE)].map(match => match[1])
    let empty = false
    for (const token of tokens) {
      if (!isRegisteredPlaceholder(token)) {
        throw new DispatchDataError(`${where}: 未知占位符 〔${token}〕`)
      }
      if (!Object.prototype.hasOwnProperty.call(values, token)) {
        throw new DispatchDataError(`${where}: 缺占位符值 〔${token}〕`)
      }
      if (values[token] === '') empty = true
    }
    if (empty) continue
    out.push(line.replace(PLACEHOLDER_RE, (_, token) => values[token]))
  }
  return out.join('\n')
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

class Checker {
  constructor() {
    this.issues = []
    this.warnings = []
  }

  issue(message) {
    this.issues.push(message)
  }

  warn(message) {
    this.warnings.push(message)
  }

  members(where, item, required, optional = []) {
    if (!isObject(item)) {
      this.issue(`${where}: 必须是对象`)
      return false
    }
    let ok = true
    for (const key of required) {
      if (!(key in item)) {
        this.issue(`${where}: 缺字段 ${key}`)
        ok = false
      }
    }
    for (const key of Object.keys(item)) {
      if (!required.includes(key) && !optional.includes(key)) {
        this.issue(`${where}: 未知字段 ${key}`)
        ok = false
      }
    }
    return ok
  }

  nonEmpty(where, value, label) {
    if (!isNonEmptyString(value)) {
      this.issue(`${where}: ${label} 必须是非空字符串`)
      return false
    }
    return true
  }

  stringArray(where, value, label, { allowEmpty = true } = {}) {
    if (!isStringArray(value) || (!allowEmpty && value.length === 0)) {
      this.issue(`${where}: ${label} 必须是字符串数组${allowEmpty ? '' : '且非空'}`)
      return false
    }
    if (!value.every(item => item.trim().length > 0)) {
      this.issue(`${where}: ${label} 不得含空串`)
      return false
    }
    return true
  }

  unique(where, values, label) {
    const seen = new Set()
    for (const value of values) {
      if (seen.has(value)) this.issue(`${where}: ${label} 重复：${value}`)
      seen.add(value)
    }
  }
}

function checkForms(data, checker) {
  if (!checker.members('forms.json', data, ['forms', 'rejected'])) return
  const forms = data.forms
  if (!Array.isArray(forms) || forms.length === 0) {
    checker.issue('forms.json: forms 必须是非空数组')
    return
  }
  const ids = []
  forms.forEach((form, index) => {
    const where = `forms.json: forms[${index}]`
    if (!checker.members(where, form, ['id', 'gate', 'catches', 'role'], ['extras', 'notes'])) return
    ids.push(form.id)
    checker.nonEmpty(where, form.id, 'id')
    if (!GATE_NAMES.includes(form.gate)) {
      checker.issue(`${where}: gate 必须是门名之一（${GATE_NAMES.join('/')}），实为 ${String(form.gate)}`)
    }
    checker.nonEmpty(where, form.catches, 'catches')
    checker.nonEmpty(where, form.role, 'role')
    if ('extras' in form) checker.nonEmpty(where, form.extras, 'extras')
    if ('notes' in form) checker.nonEmpty(where, form.notes, 'notes')
  })
  checker.unique('forms.json', ids, '形态 id')
  checkSafetyForms(forms, checker)
  checker.stringArray('forms.json', data.rejected, 'rejected')
  return ids
}

function checkSafetyForms(forms, checker) {
  const carriers = forms.filter(form => /安全/.test(form.id))
  if (carriers.length !== 1 || carriers[0].id !== SAFETY_CARRIER_IDS[0]) {
    checker.issue(
      `forms.json: 安全形态必须恰好一件且 id=${SAFETY_CARRIER_IDS[0]}（实为 ${carriers.map(c => c.id).join('/') || '无'}）`,
    )
    return
  }
  const carrier = carriers[0]
  for (const anchor of SAFETY_ANCHORS) {
    if (!String(carrier.role).includes(anchor)) {
      checker.issue(`forms.json: ${carrier.id} 的 role 缺五问锚点「${anchor}」`)
    }
  }
  if (carrier.gate !== GATE_LABELS.challenge) {
    checker.issue(`forms.json: ${carrier.id} 必须挂在门「${GATE_LABELS.challenge}」下`)
  }
  for (const form of forms) {
    if (form === carrier) continue
    for (const anchor of SAFETY_ANCHORS) {
      if (String(form.role).includes(anchor)) {
        checker.issue(`forms.json: ${form.id} 复述了安全五问锚点「${anchor}」——五问只许 ${carrier.id} 一处定义`)
      }
    }
  }
}

function checkPairing(data, checker, formIds) {
  if (!checker.members('pairing.json', data, ['tiers', 'hardTriggers'])) return
  const tiers = data.tiers
  if (!Array.isArray(tiers) || tiers.length === 0) {
    checker.issue('pairing.json: tiers 必须是非空数组')
    return
  }
  const tierIds = []
  const formsById = new Map((formIds ?? []).map(id => [id, id]))
  tiers.forEach((row, index) => {
    const where = `pairing.json: tiers[${index}]`
    if (!checker.members(where, row, ['tier', 'taskBook', 'challenge', 'planChallenge', 'note'])) return
    tierIds.push(row.tier)
    if (!TIERS.includes(row.tier)) {
      checker.issue(`${where}: tier 必须是档位词表 ${TIERS.join('/')} 之一，实为 ${String(row.tier)}`)
    }
    if (typeof row.taskBook !== 'boolean') checker.issue(`${where}: taskBook 必须是布尔值`)
    checker.nonEmpty(where, row.note, 'note')
    for (const [column, header] of [
      ['challenge', '阶段门'],
      ['planChallenge', '方案证伪'],
    ]) {
      const value = row[column]
      if (value === null) continue
      if (!Array.isArray(value) || value.length === 0) {
        checker.issue(`${where}: ${column} 必须是形态 id 数组或 null`)
        continue
      }
      checker.stringArray(where, value, column, { allowEmpty: false })
      checker.unique(`${where} ${column}`, value, '形态 id')
      if (!formsById.size) continue
      for (const id of value) {
        if (!formsById.has(id)) {
          checker.issue(`${where}: ${column} 指向未激活形态「${id}」（forms.json 无此件）`)
        }
      }
    }
    if (row.taskBook === false && (row.challenge?.length || row.planChallenge?.length)) {
      checker.issue(`${where}: 免任务书的档位不得配复核门（S 档是「免任务书不免记账」，不是免门）`)
    }
    if (row.taskBook === true && !(row.challenge?.length)) {
      checker.issue(`${where}: 有任务书的档位必须至少配一道证伪门`)
    }
    if (row.planChallenge?.length && !row.challenge?.length) {
      checker.issue(`${where}: 配了方案证伪就必须配证伪门（一轮为限的只在施工后）`)
    }
  })
  checker.unique('pairing.json', tierIds, '档位')
  for (const tier of TIERS) {
    if (!tierIds.includes(tier)) checker.issue(`pairing.json: 缺档位行 ${tier}（三档缺一即残表）`)
  }
  checkHardTriggers(data.hardTriggers, checker, tierIds, formsById)
  checkGateColumns(tiers, formIds, checker, data.hardTriggers)
}

function checkHardTriggers(triggers, checker, tierIds, formsById) {
  if (!Array.isArray(triggers) || triggers.length === 0) {
    checker.issue('pairing.json: hardTriggers 必须是非空数组')
    return
  }
  const ids = []
  let withThreshold = 0
  triggers.forEach((row, index) => {
    const where = `pairing.json: hardTriggers[${index}]`
    if (!checker.members(where, row, ['id', 'match', 'upgrade', 'note'], ['form', 'threshold'])) return
    ids.push(row.id)
    checker.nonEmpty(where, row.id, 'id')
    checker.nonEmpty(where, row.match, 'match')
    checker.nonEmpty(where, row.note, 'note')
    if (!tierIds.includes(row.upgrade)) {
      checker.issue(`${where}: upgrade 必须是已声明档位之一，实为 ${String(row.upgrade)}`)
    }
    if ('form' in row) {
      if (!formsById.has(row.form)) {
        checker.issue(`${where}: form 指向未激活形态「${row.form}」`)
      }
      if (row.form === SAFETY_CARRIER_IDS[0] && row.id !== '语义域') {
        checker.issue(`${where}: 安全专项只能由「语义域」触发行加挂`)
      }
    }
    if ('threshold' in row) {
      withThreshold += 1
      if (!Number.isSafeInteger(row.threshold) || row.threshold <= 0) {
        checker.issue(`${where}: threshold 必须是正整数`)
      }
      if (row.id !== 'diff 超阈') {
        checker.issue(`${where}: 只有「diff 超阈」触发行带 threshold`)
      }
    }
  })
  checker.unique('pairing.json', ids, '硬触发 id')
  if (withThreshold !== 1) {
    checker.issue(`pairing.json: 带 threshold 的硬触发行必须恰好一条（实为 ${withThreshold}）`)
  }
  const semantic = triggers.find(row => row.id === '语义域')
  if (!semantic || semantic.form !== SAFETY_CARRIER_IDS[0]) {
    checker.issue(`pairing.json: 「语义域」触发行必须带 form=${SAFETY_CARRIER_IDS[0]}`)
  }
}

function checkGateColumns(tiers, formIds, checker, triggers = []) {
  const referenced = new Set()
  for (const row of tiers) {
    for (const id of row.challenge ?? []) referenced.add(id)
    for (const id of row.planChallenge ?? []) referenced.add(id)
  }
  for (const row of triggers) {
    if (row.form) referenced.add(row.form)
  }
  for (const id of formIds ?? []) {
    if (!referenced.has(id)) {
      checker.warn(`forms.json: 形态「${id}」未被任何档位行引用（懒加载件？确认后删或接进配对表）`)
    }
  }
}

function checkTemplates(data, checker) {
  for (const key of TEMPLATE_KEYS) {
    if (!(key in data)) checker.issue(`templates.json: 缺模板键「${key}」`)
  }
  for (const key of Object.keys(data)) {
    if (!TEMPLATE_KEYS.includes(key)) checker.issue(`templates.json: 未知模板键「${key}」`)
  }
  const dummy = Object.fromEntries(Object.keys(PLACEHOLDER_REGISTRY).map(token => [token, 'x']))
  for (const key of Object.keys(data)) {
    if (!TEMPLATE_KEYS.includes(key)) continue
    const text = data[key]
    if (!isNonEmptyString(text)) {
      checker.issue(`templates.json: 「${key}」必须是非空字符串`)
      continue
    }
    try {
      const rendered = renderTemplate(text, dummy, `templates.json: ${key}`)
      if (!rendered.trim()) checker.issue(`templates.json: 「${key}」渲染后为空`)
    } catch (error) {
      checker.issue(error.message)
    }
  }
  // 行数上限是结构保证而不是人脑规则：任务书骨架（≤15 行）与决策卡（≤6 行）是靠「别写长」
  // 的约定维持的，模板作者改一版就可能越线；加载期直接量行数，越线抛错并带实际行数。
  for (const [key, limit] of Object.entries(TEMPLATE_LINE_LIMITS)) {
    const text = data[key]
    if (!isNonEmptyString(text)) continue
    const lines = text.split('\n').length
    if (lines > limit) {
      checker.issue(`templates.json: 「${key}」${lines} 行，超过 ${limit} 行上限——先砍内容再改模板（超长模板会把纪律稀释成背景）`)
    }
  }
}

function checkLifecycle(data, checker, pairing) {
  if (!checker.members('lifecycle.json', data, ['stages'])) return
  const stages = data.stages
  if (!Array.isArray(stages) || stages.length === 0) {
    checker.issue('lifecycle.json: stages 必须是非空数组')
    return
  }
  const ids = []
  const orders = []
  const kinds = []
  stages.forEach((row, index) => {
    const where = `lifecycle.json: stages[${index}]`
    if (!checker.members(where, row, ['id', 'order', 'kind', 'gate', 'requires', 'uses'], ['note'])) return
    ids.push(row.id)
    orders.push(row.order)
    kinds.push(row.kind)
    checker.nonEmpty(where, row.id, 'id')
    if (!Number.isSafeInteger(row.order) || row.order <= 0) checker.issue(`${where}: order 必须是正整数`)
    if (!LIFECYCLE_KINDS.includes(row.kind)) {
      checker.issue(`${where}: kind 必须是四事件阶段名之一（${LIFECYCLE_KINDS.join('/')}），实为 ${String(row.kind)}`)
    }
    if (typeof row.gate !== 'boolean') checker.issue(`${where}: gate 必须是布尔值`)
    if (row.gate !== (row.kind === '门报')) {
      checker.issue(`${where}: gate 标记必须与 kind 一致（只有「门报」是门）`)
    }
    checker.stringArray(where, row.requires, 'requires')
    checker.stringArray(where, row.uses, 'uses')
    for (const field of row.requires ?? []) {
      if (!PARAM_FIELDS.includes(field)) {
        checker.issue(`${where}: requires 含未知参数 ${field}（PARAM_FIELDS 之外）`)
      }
    }
    if (row.kind === '提交') {
      for (const field of row.requires ?? []) {
        checker.issue(`${where}: 提交阶段的参数由 dispatch_batch 收，不该出现在 requires`)
      }
    }
  })
  checker.unique('lifecycle.json', ids, '阶段 id')
  checker.unique('lifecycle.json', orders, 'order')
  checker.unique('lifecycle.json', kinds, 'kind')
  const sorted = [...orders].sort((a, b) => a - b)
  sorted.forEach((order, index) => {
    if (order !== index + 1) checker.issue(`lifecycle.json: order 必须从 1 连续编号（首个断点 ${order}）`)
  })
  if (!kinds.includes('提交')) checker.issue('lifecycle.json: 缺提交阶段（哪怕参数少也必须是状态机的一员）')
  checkAssemblerStages(stages, checker)
  checkPlanSpecTier(pairing, checker)
}

function checkAssemblerStages(stages, checker) {
  for (const contract of ASSEMBLER_CONTRACTS) {
    const row = stages.find(stage => stage.id === contract.stage)
    if (!row) {
      checker.issue(`lifecycle.json: 装配契约 ${contract.name} 指向的阶段「${contract.stage}」不存在`)
      continue
    }
    if ((row.kind === '门报') !== (contract.event === 'gate')) {
      checker.issue(`lifecycle.json: 装配契约 ${contract.name} 的事件类型与阶段「${contract.stage}」不符`)
    }
  }
}

function checkPlanSpecTier(pairing, checker) {
  const tiers = pairing?.tiers ?? []
  const planTiers = tiers.filter(row => row.planChallenge?.length)
  if (planTiers.length === 0) {
    checker.issue('pairing.json: 方案证伪没有挂到任何档位（L 档必须有方案证伪列）')
  }
}

function checkPlanSpec(data, checker) {
  if (!checker.members('plan-spec.json', data, ['blocks', 'checklist'])) return
  if (!Array.isArray(data.blocks) || data.blocks.length === 0) {
    checker.issue('plan-spec.json: blocks 必须是非空数组')
    return
  }
  const ids = []
  data.blocks.forEach((block, index) => {
    const where = `plan-spec.json: blocks[${index}]`
    if (!checker.members(where, block, ['id', 'title', 'body'])) return
    ids.push(block.id)
    checker.nonEmpty(where, block.id, 'id')
    checker.nonEmpty(where, block.title, 'title')
    checker.nonEmpty(where, block.body, 'body')
  })
  checker.unique('plan-spec.json', ids, '块 id')
  checker.stringArray('plan-spec.json', data.checklist, 'checklist', { allowEmpty: false })
}

function checkCrossFile(data, checker) {
  const formById = new Map((data.forms?.forms ?? []).map(form => [form.id, form]))
  for (const row of data.pairing?.tiers ?? []) {
    for (const [column, header] of [
      ['challenge', GATE_LABELS.challenge],
      ['planChallenge', GATE_LABELS.planChallenge],
    ]) {
      for (const id of row[column] ?? []) {
        const form = formById.get(id)
        if (form && form.gate !== header) {
          checker.issue(
            `跨文件: 档位 ${row.tier} 的 ${column} 列指向形态「${id}」，但该形态属门「${form.gate}」，列与门不符`,
          )
        }
      }
    }
  }
  const semantic = (data.pairing?.hardTriggers ?? []).find(row => row.id === '语义域')
  const safety = formById.get(SAFETY_CARRIER_IDS[0])
  if (semantic && safety && safety.gate !== GATE_LABELS.challenge) {
    checker.issue(`跨文件: 语义域硬触发行加挂的「${safety.id}」必须挂在「${GATE_LABELS.challenge}」下`)
  }
}

/**
 * 加载并校验五份数据。任何形状/互验问题都以 DispatchDataError 抛出（不猜、不兜底）；
 * 非阻断问题（如未被引用的形态）走 warnings 返回给工具渲染面。
 */
export function loadDispatchData(configured) {
  const dir = resolveDataDir(configured)
  const checker = new Checker()
  const loaded = {}
  const raw = {}
  for (const entry of DATA_FILES) {
    const path = join(dir, entry.file)
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      throw new DispatchDataError(`读不到数据文件 ${path}: ${error.message}`)
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw new DispatchDataError(`数据文件 ${entry.file} 不是合法 JSON: ${error.message}`)
    }
    loaded[entry.name] = parsed
    raw[entry.name] = text
  }
  const checkerForms = new Checker()
  const formIds = checkForms(loaded.forms, checkerForms)
  const checkerPairing = new Checker()
  checkPairing(loaded.pairing, checkerPairing, formIds)
  const checkerTemplates = new Checker()
  checkTemplates(loaded.templates, checkerTemplates)
  const checkerLifecycle = new Checker()
  checkLifecycle(loaded.lifecycle, checkerLifecycle, loaded.pairing)
  const checkerPlan = new Checker()
  checkPlanSpec(loaded.planSpec, checkerPlan)
  const checkerCross = new Checker()
  checkCrossFile(loaded, checkerCross)
  for (const part of [checkerForms, checkerPairing, checkerTemplates, checkerLifecycle, checkerPlan, checkerCross]) {
    checker.issues.push(...part.issues)
    checker.warnings.push(...part.warnings)
  }
  if (checker.issues.length > 0) {
    throw new DispatchDataError(`数据面校验失败（${checker.issues.length} 条）：\n- ${checker.issues.join('\n- ')}`)
  }
  return {
    data: {
      forms: loaded.forms,
      pairing: loaded.pairing,
      templates: loaded.templates,
      lifecycle: loaded.lifecycle,
      planSpec: loaded.planSpec,
    },
    warnings: checker.warnings,
    raw,
  }
}

/**
 * 覆盖默认数据目录的解析：显式目录优先，缺省用仓内 data/。
 * 空串按未配置处理——宿主 Config 的默认值就是 ''，把它当目录会让 join('', 'x.json') 落到
 * 进程 cwd 上（症状是「插件装了但读不到数据」，而错误信息指向真实存在的文件名）。
 */
export function resolveDataDir(configured) {
  return typeof configured === 'string' && configured.trim() !== '' ? configured : DEFAULT_DATA_DIR
}
