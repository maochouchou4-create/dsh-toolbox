/**
 * 跑批工作流数据面：阶段表（JSON）＋纪律原文与模板正文（两份人读 markdown）的加载与校验。
 *
 * 只做读文件与校验，不做 I/O 之外的事；跨文件绑死关系（阶段表＝状态机单源、纪律文本的
 * 阶段序列与阶段表互认、安全五问单载体）在加载期一次查全——有一条对不上就加载失败，
 * 不给下游留下「运行期才发现」的半截数据。
 *
 * 两份 markdown 只验结构与存在性，不解析成结构化数据：模板是人读的，也就没有「渲染器」
 * 与「占位符语法」需要两处同步——规则正文改一个字，下一回合注入即见。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KIND_ACTIONS, LIFECYCLE_KINDS } from './vocab.js'

/** 仓内数据目录：data.js 同目录下的 data/。 */
const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data')

/** 数据文件清单（加载顺序即报错顺序）；测试夹具现读它派生拷贝清单。 */
export const DATA_FILES = [
  { name: 'lifecycle', file: 'lifecycle.json', format: 'json' },
  { name: 'discipline', file: 'discipline.md', format: 'text' },
  { name: 'templates', file: 'templates.md', format: 'text' },
]

/**
 * 安全五问的唯一载体：整节标题（含五问锚点）在 templates.md 出现且仅出现一次。这里只留标题
 * 前缀做定位——完整标题与整节只在 templates.md 里有一份，别处（README、纪律注入、别的模板）
 * 复述即由 test/dispatch-data.test.js 的全仓计数断言判红。
 */
export const SAFETY_SECTION_MARKER = '## 安全专项五问'

/** 安全形态必须逐条覆盖的五问锚点（只在安全专项小节内出现）。 */
export const SAFETY_ANCHORS = ['鉴权', '越权', '输入', '上传', 'PII']

/** 模板正文的骨架：每节标题在此出现且仅出现一次（缺节＝模板迁移漏内容）。 */
export const TEMPLATE_SECTIONS = [
  '## 方案文档规范',
  '## 方案证伪 brief（施工前，对象＝方案文档）',
  '## 复核形态词表（选形单源：保底每批必派，其余按触发列「改了什么派什么」）',
  '## 证伪门 brief（提交前，对象＝净 diff）',
  '## 横切判据',
  '## 门报行',
  '## 不做清单（形态口径）',
]

/** 纪律文本的行数上限：注入块每回合都在场，越写越长＝把行为约束稀释成背景。 */
export const DISCIPLINE_LINE_LIMIT = 12

/** 纪律文本里的模板文件占位：注入层渲染成 templates.md 的绝对路径。 */
export const TEMPLATES_PLACEHOLDER = '{templates}'

/** 加载期错误：读不到文件、JSON 语义错、跨文件绑死对不上。 */
export class DispatchDataError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DispatchDataError'
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function countOf(text, token) {
  return text.split(token).length - 1
}

class Checker {
  constructor() {
    this.issues = []
  }

  issue(message) {
    this.issues.push(message)
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
        this.issue(`${where}: 未知字段 ${key}（阶段表只留 id/order/kind，别的语义不再由它承载）`)
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

  unique(where, values, label) {
    const seen = new Set()
    for (const value of values) {
      if (seen.has(value)) this.issue(`${where}: ${label} 重复：${value}`)
      seen.add(value)
    }
  }
}

/** 阶段表：状态机单源。四步、四 kind、顺序固定——阶段增删改序都要走代码同批改。 */
function checkLifecycle(data, checker) {
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
    if (!checker.members(where, row, ['id', 'order', 'kind'])) return
    ids.push(row.id)
    orders.push(row.order)
    kinds.push(row.kind)
    checker.nonEmpty(where, row.id, 'id')
    if (!Number.isSafeInteger(row.order) || row.order <= 0) checker.issue(`${where}: order 必须是正整数`)
    if (!LIFECYCLE_KINDS.includes(row.kind)) {
      checker.issue(`${where}: kind 必须是四阶段名之一（${LIFECYCLE_KINDS.join('/')}），实为 ${String(row.kind)}`)
    }
  })
  checker.unique('lifecycle.json', ids, '阶段 id')
  checker.unique('lifecycle.json', orders, 'order')
  checker.unique('lifecycle.json', kinds, 'kind')
  const sorted = [...orders].sort((a, b) => a - b)
  sorted.forEach((order, index) => {
    if (order !== index + 1) checker.issue(`lifecycle.json: order 必须从 1 连续编号（首个断点 ${order}）`)
  })
  const byOrder = stages
    .filter(row => isObject(row) && Number.isSafeInteger(row.order))
    .sort((a, b) => a.order - b.order)
  const orderedKinds = byOrder.map(row => row.kind)
  if (orderedKinds.join('→') !== LIFECYCLE_KINDS.join('→')) {
    checker.issue(
      `lifecycle.json: 阶段顺序必须是 ${LIFECYCLE_KINDS.join('→')}（实为 ${orderedKinds.join('→') || '空'}）——状态机四步不可重排`,
    )
  }
}

/**
 * 纪律文本：注入块的行为约束。占位符必须恰有一处（否则模板路径渲染不出来或渲染两遍），
 * 四个台账动作按阶段序出现（与阶段表互验：改阶段表而漏改纪律文本，加载即红）。
 */
function checkDiscipline(text, checker, stages) {
  if (!isNonEmptyString(text)) {
    checker.issue('discipline.md: 必须是非空文本')
    return
  }
  const lines = text.replace(/\n$/, '').split('\n').length
  if (lines > DISCIPLINE_LINE_LIMIT) {
    checker.issue(`discipline.md: ${lines} 行，超过 ${DISCIPLINE_LINE_LIMIT} 行上限——纪律每回合都在场，先砍内容再改文本`)
  }
  const placeholders = countOf(text, TEMPLATES_PLACEHOLDER)
  if (placeholders !== 1) {
    checker.issue(`discipline.md: 模板占位 ${TEMPLATES_PLACEHOLDER} 必须恰好出现一次（实为 ${placeholders} 次）——注入层靠它渲染模板路径`)
  }
  let last = -1
  for (const stage of stages) {
    const action = KIND_ACTIONS[stage.kind]
    if (!action) continue
    const token = `action=${action}`
    const at = text.indexOf(token)
    if (at === -1) {
      checker.issue(`discipline.md: 缺阶段动作 ${token}（纪律与阶段表「${stage.id}」脱节——改阶段表要同批改纪律文本）`)
      continue
    }
    if (at < last) {
      checker.issue(`discipline.md: 阶段动作 ${token} 的顺序与阶段表不一致（纪律文本要按 ${LIFECYCLE_KINDS.join('→')} 写）`)
    }
    last = Math.max(last, at)
  }
}

/**
 * 模板正文：六节骨架＋安全五问＋不做清单，每节标题恰一次；五问锚点只许落在安全专项
 * 小节内（别处复述即加载失败——单数载体的结构保证）。
 */
function checkTemplates(text, checker) {
  if (!isNonEmptyString(text)) {
    checker.issue('templates.md: 必须是非空文本')
    return
  }
  for (const section of TEMPLATE_SECTIONS) {
    const count = countOf(text, section)
    if (count !== 1) checker.issue(`templates.md: 节标题「${section}」必须恰好出现一次（实为 ${count} 次）`)
  }
  // 安全五问整节的标题前缀全篇恰一次：整节（含五问锚点）全仓只许这么一份，别处复述即红
  const markerCount = countOf(text, SAFETY_SECTION_MARKER)
  if (markerCount !== 1) {
    checker.issue(`templates.md: 安全专项整节「${SAFETY_SECTION_MARKER}…」必须恰好出现一次（实为 ${markerCount} 次）`)
    if (markerCount === 0) return
  }
  const markerAt = text.indexOf(SAFETY_SECTION_MARKER)
  if (markerAt === -1) return
  const nextSectionAt = text.indexOf('\n## ', markerAt + 1)
  const safetySection = text.slice(markerAt, nextSectionAt === -1 ? text.length : nextSectionAt)
  for (const anchor of SAFETY_ANCHORS) {
    if (!safetySection.includes(anchor)) {
      checker.issue(`templates.md: 安全专项小节缺五问锚点「${anchor}」`)
    }
    const outside = text.slice(0, markerAt) + text.slice(markerAt + safetySection.length)
    if (outside.includes(anchor)) {
      checker.issue(`templates.md: 五问锚点「${anchor}」在安全专项小节之外也出现了——五问只许一处定义`)
    }
  }
}

function orderedStages(lifecycle) {
  if (!isObject(lifecycle) || !Array.isArray(lifecycle.stages)) return []
  return lifecycle.stages
    .filter(row => isObject(row) && Number.isSafeInteger(row.order))
    .sort((a, b) => a.order - b.order)
}

/**
 * 加载并校验三份数据。任何形状/绑死问题都以 DispatchDataError 抛出（不猜、不兜底）。
 */
export function loadDispatchData(configured) {
  const dir = resolveDataDir(configured)
  const raw = {}
  const data = {}
  for (const entry of DATA_FILES) {
    const path = join(dir, entry.file)
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      throw new DispatchDataError(`读不到数据文件 ${path}: ${error.message}`)
    }
    if (text.trim() === '') throw new DispatchDataError(`数据文件 ${entry.file} 是空的（${path}）`)
    let parsed = text
    if (entry.format === 'json') {
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        throw new DispatchDataError(`数据文件 ${entry.file} 不是合法 JSON: ${error.message}`)
      }
    }
    data[entry.name] = parsed
    raw[entry.name] = text
  }
  const lifecycleCheck = new Checker()
  checkLifecycle(data.lifecycle, lifecycleCheck)
  const disciplineCheck = new Checker()
  checkDiscipline(data.discipline, disciplineCheck, orderedStages(data.lifecycle))
  const templatesCheck = new Checker()
  checkTemplates(data.templates, templatesCheck)
  const issues = []
  for (const checker of [lifecycleCheck, disciplineCheck, templatesCheck]) {
    issues.push(...checker.issues)
  }
  if (issues.length > 0) {
    throw new DispatchDataError(`数据面校验失败（${issues.length} 条）：\n- ${issues.join('\n- ')}`)
  }
  return {
    data: {
      lifecycle: data.lifecycle,
      discipline: data.discipline,
      templates: data.templates,
    },
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
