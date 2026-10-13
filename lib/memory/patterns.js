/**
 * dsh-memory 三动作（write／delete／lint）共用的文本判据**与告警文案**：条目文件名形态、
 * description 日期戳与派生索引行超长、wikilink 引用形态与遍历。
 *
 * 这里既有判定也有文案：告警是写条目的模型与读体检报告的人直接读的文本，所以文案与判定必须
 * 同源——判定在两个动作里各写一份时，弱的那份连文案一起弱下去，而弱的那份总是只扫全库、
 * 不扫刚落盘那一条的那一侧。
 *
 * 依赖集只有同层的 core.js（预算常量）与 frontmatter.js（保留名与纪律文件名）：不碰宿主包、
 * 不碰 node:fs，故本模块零 IO、可独立单测。模块头不写「零依赖」这类会随改动静默变假的说法。
 *
 * 收这一层的理由是依赖方向：「被谁用到」不构成依赖。让体检去 import 删除模块（方向倒挂），
 * 或两个动作各写一份同一判据（同一件事两种答案），都是把共用件留在错误的位置；下沉到三方
 * 都能向下指的地方，方向才是单向的。相应地，只有一个动作用的判定下沉到那个动作——留在这
 * 里的每条都至少有两个调用方。
 */
import { INDEX_LINE_CHAR_BUDGET } from './core.js'
import { RESERVED_FILES, WRITING_FILE, isReservedFile } from './frontmatter.js'

/**
 * 写侧纪律：不写日期戳（时序归 git）。刻意不导出：导出了它，下一个消费者就能绕开
 * styleWarnings 自己判一次，而那正是本模块收掉的那份重复；要验这个正则的行为就验
 * styleWarnings 的对外输出，不验中间件。
 */
const DATE_RE = /\d{4}-\d{2}-\d{2}/

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
 *
 * 两个入参都必填：缺 indexLine 是编程错误（派生行在调用前刚算出来就在手上），故让它
 * TypeError，不给默认值——给了空串就会报成「派生行 0 字符」，把一条接线错误说成一条内容问题。
 */
export function styleWarnings({ description, indexLine }) {
	const warnings = []
	if (DATE_RE.test(description)) warnings.push(`description 含日期戳（${WRITING_FILE}：不写日期戳，时序归 git）`)
	if (indexLine.length > INDEX_LINE_CHAR_BUDGET) {
		warnings.push(`派生索引行 ${indexLine.length} 字符超 ${INDEX_LINE_CHAR_BUDGET}——收敛 description（整行上限即 description 上限的推论）`)
	}
	return warnings
}

/**
 * wikilink 提取（`[[stem]]`／`[[stem|别名]]`／`[[stem#锚]]` 取 stem）。同样刻意不导出：
 * 裸正则配 matchAll 拿到的匹配没有行号，而行号正是 forEachWikilinkMatch 比它多给的东西——
 * 导出它，下一个消费者就会走回那份没有行号的遍历。
 */
const WIKILINK_RE = /\[\[([^\]|#]+)/g

/**
 * 遍历一篇文本里的全部 wikilink，逐处回调 `(提取到的原始串, 行号)`。行号从 1 起，
 * 与引用报告里「文件:行」的写法对齐。
 *
 * 只共用遍历，不共用降级：两个调用方的失败粒度不同（删条目逐文件降级、体检逐条目降级），
 * 把降级也并进来就得替调用方挑一种粒度，而挑错那一种的表现是「这份报告少了几处」——
 * 比「这几处没扫到」更难发现。cb 里抛的异常照原样冒给调用方的 try，粒度由它们自己挂。
 *
 * 行号在这里算而不在调用方切行：切行后 matchAll 只能看到本行内的匹配，两个调用方就会
 * 各写一份自己的行号拼法。匹配下标单调递增，故整篇只扫一遍换行。
 *
 * 这里按 `\n` 计而 frontmatter.js 的 frontmatterLines 另有一套 CRLF 归一，两套并存不冲突：
 * 本行的号只服务人读的「文件:行」定位（删条目报告里读者拿去编辑器里跳），CRLF 与否差不出
 * 一行；那边归一服务的是 frontmatter 解析判据（围栏与键行认不认），答的是另一个问题。
 * 两边答案不同不是缺陷，是两个问题。
 */
export function forEachWikilinkMatch(text, cb) {
	let line = 1
	let scannedTo = 0
	for (const match of text.matchAll(WIKILINK_RE)) {
		for (let i = scannedTo; i < match.index; i += 1) {
			if (text[i] === '\n') line += 1
		}
		scannedTo = match.index
		cb(match[1], line)
	}
}

/**
 * 条目文件名的**写侧口径**：可接受的规范形——小写 kebab（两层现有条目全部满足），
 * MEMORY.md/WRITING.md 为保留名。write／edit／delete 三动作的 file 入参都走它。
 *
 * 与 frontmatter.js 的 isEntryName 是同一问题的两侧：那边答「盘上有哪些 `.md` 要当条目看」
 * （读侧，宽），这边答「调用方可以拿什么名字来写／删」（规范形，窄）。宽窄不同是有意的，
 * 理由写在那边的注释里。
 */
const ENTRY_FILE_RE = /^[a-z0-9][a-z0-9-]*\.md$/
export function assertEntryFile(file) {
	if (typeof file !== 'string' || !ENTRY_FILE_RE.test(file)) {
		throw new Error(`条目文件名须为小写中划线 kebab 形如 topic-name.md，收到 "${file}"`)
	}
	if (isReservedFile(file)) {
		throw new Error(`"${file}" 是保留名（${[...RESERVED_FILES].join('/')} 不可作条目）`)
	}
}
