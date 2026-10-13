/**
 * dsh-memory 三动作（write／delete／lint）共用的文本判据：条目文件名形态、description
 * 日期戳与派生索引行超长、wikilink 引用形态与遍历。纯正则与纯判定，零依赖、可独立单测。
 *
 * 收这一层的理由是依赖方向：「被谁用到」不构成依赖。让体检去 import 删除模块（方向倒挂），
 * 或两个动作各写一份同一判据（同一件事两种答案），都是把共用件留在错误的位置；下沉到三方
 * 都能向下指的地方，方向才是单向的。相应地，只有一个动作用的判定下沉到那个动作——留在这
 * 里的每条都至少有两个调用方。
 */
import { INDEX_LINE_CHAR_BUDGET } from './core.js'
import { RESERVED_FILES, isReservedFile } from './frontmatter.js'

/** WRITING.md：不写日期戳（时序归 git）——写侧风格告警与体检判同一份。 */
export const DATE_RE = /\d{4}-\d{2}-\d{2}/

/**
 * 风格类提示（不拦截）的单一判定源：日期戳与派生索引行超长。写侧（write.js 的 warnings）
 * 与体检侧（lint.js 的 warning）都问它。
 *
 * 体检是写侧的离线镜像，镜像不得比本体弱：两份判定各写一次时弱的那份总是体检侧
 * （日期戳不指向规范出处、超长不给收敛方向），而体检恰是唯一会扫全库存量的一侧——
 * 弱的那份要等人工去 lint 才看得见，写侧只报得见刚写的那一条。
 *
 * 返回的文案不带定位：写侧的文件名由工具结果给出，体检侧由层与条目名给出，
 * 各调用点补自己的前缀（见两处调用）。
 */
export function styleWarnings({ description, indexLine }) {
	const warnings = []
	if (DATE_RE.test(description)) warnings.push('description 含日期戳（WRITING.md：不写日期戳，时序归 git）')
	if (indexLine.length > INDEX_LINE_CHAR_BUDGET) {
		warnings.push(`派生索引行 ${indexLine.length} 字符超 ${INDEX_LINE_CHAR_BUDGET}——收敛 description（整行上限即 description 上限的推论）`)
	}
	return warnings
}

/** wikilink 提取（`[[stem]]`／`[[stem|别名]]`／`[[stem#锚]]` 取 stem）——删除的引用扫描与体检的死链判定同源。 */
export const WIKILINK_RE = /\[\[([^\]|#]+)/g

/** 条目文件名：小写 kebab（两层现有条目全部满足）；MEMORY.md/WRITING.md 为保留名。 */
const ENTRY_FILE_RE = /^[a-z0-9][a-z0-9-]*\.md$/
export function assertEntryFile(file) {
	if (typeof file !== 'string' || !ENTRY_FILE_RE.test(file)) {
		throw new Error(`条目文件名须为小写中划线 kebab 形如 topic-name.md，收到 "${file}"`)
	}
	if (isReservedFile(file)) {
		throw new Error(`"${file}" 是保留名（${[...RESERVED_FILES].join('/')} 不可作条目）`)
	}
}
