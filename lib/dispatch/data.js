/**
 * 跑批工作流数据面：纪律原文与模板正文（两份人读 markdown）的加载与校验。
 *
 * 只做读文件与校验，不做 I/O 之外的事：纪律文本的结构约束在加载期一次查全——有一条对不上
 * 就加载失败，不给下游留下「运行期才发现」的半截数据。
 *
 * 模板只验存在与可读，骨架不在加载期验：它的结构断言（八节标题唯一、五问只落安全小节内）
 * 住在 test/dispatch-data.test.js。加载期不拦换来的是失败面可见——手滑改坏模板时纪律照样
 * 注入（最坏是规则文本旧了一版），红的是那条测试、指回改坏的那一处；若在这里拦，注入会
 * fail-safe 静默缺席，症状变成「流程没人提」，改坏的位置反而更难找。
 *
 * 两份 markdown 都不解析成结构化数据：模板是人读的，也就没有「渲染器」与「占位符语法」
 * 需要两处同步——规则正文改一个字，下一回合注入即见。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓内数据目录：data.js 同目录下的 data/。 */
const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data')

/** 数据文件清单（加载顺序即报错顺序）；测试夹具现读它派生拷贝清单。 */
export const DATA_FILES = [
  { name: 'discipline', file: 'discipline.md' },
  { name: 'templates', file: 'templates.md' },
]

/** 纪律文本里的模板文件占位：注入层渲染成 templates.md 的绝对路径。 */
export const TEMPLATES_PLACEHOLDER = '{templates}'

/** 加载期错误：读不到文件、结构不合规。 */
export class DispatchDataError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DispatchDataError'
  }
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
}

/**
 * 纪律文本：注入块的行为约束。非空、模板占位符恰有一处（否则模板路径渲染不出来或渲染两遍）。
 */
function checkDiscipline(text, checker) {
  if (!isNonEmptyString(text)) {
    checker.issue('discipline.md: 必须是非空文本')
    return
  }
  const placeholders = countOf(text, TEMPLATES_PLACEHOLDER)
  if (placeholders !== 1) {
    checker.issue(`discipline.md: 模板占位 ${TEMPLATES_PLACEHOLDER} 必须恰好出现一次（实为 ${placeholders} 次）——注入层靠它渲染模板路径`)
  }
}

/**
 * 加载并校验两份数据。任何结构问题都以 DispatchDataError 抛出（不猜、不兜底）。
 * `configured` 参数化仅测试用：生产注入恒走默认目录（discipline.js 的 text 回调无参调本函数）。
 */
export function loadDispatchData(configured) {
  const dir = resolveDataDir(configured)
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
    data[entry.name] = text
  }
  const disciplineCheck = new Checker()
  checkDiscipline(data.discipline, disciplineCheck)
  if (disciplineCheck.issues.length > 0) {
    throw new DispatchDataError(`数据面校验失败（${disciplineCheck.issues.length} 条）：\n- ${disciplineCheck.issues.join('\n- ')}`)
  }
  return { data }
}

/**
 * 覆盖默认数据目录的解析：显式目录优先，缺省用仓内 data/。参数化仅测试用（生产注入不再传目录）。
 * 空串按未配置处理——宿主 Config 的默认值就是 ''，把它当目录会让 join('', 'x.md') 落到
 * 进程 cwd 上（症状是「插件装了但读不到数据」，而错误信息指向真实存在的文件名）。
 */
export function resolveDataDir(configured) {
  return typeof configured === 'string' && configured.trim() !== '' ? configured : DEFAULT_DATA_DIR
}
