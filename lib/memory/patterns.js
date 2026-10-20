/**
 * dsh-memory 的共享文本判据**与告警文案**：description 日期戳与派生索引行超长的风格告警、
 * wikilink 引用形态与遍历、正文节标题判定族。
 *
 * 这里既有判定也有文案：告警是写条目的模型与读体检报告的人直接读的文本，所以文案与判定必须
 * 同源——判定在两处各写一份时，弱的那份连文案一起弱下去，而弱的那份总是只扫全库、
 * 不扫刚落盘那一条的那一侧。
 *
 * 依赖集只有预算常量（core.js）、行归一与围栏定位（frontmatter.js）与纪律文件名
 * （naming.js）：不碰宿主包、不碰 node:fs，故本模块零 IO、可独立单测。模块头
 * 不写「零依赖」这类会随改动静默变假的说法。
 *
 * 收这一层的理由是依赖方向：「被谁用到」不构成依赖。让体检去 import 已退役的写侧模块
 * （方向倒挂），或两处各写一份同一判据（同一件事两种答案），都是把共用件留在错误的位置；
 * 下沉到多方都能向下指的地方，方向才是单向的。
 */
import { INDEX_LINE_CHAR_BUDGET } from './core.js'
import { findFenceEnd, frontmatterLines } from './frontmatter.js'
import { WRITING_FILE } from './naming.js'

/**
 * 写侧纪律：不写日期戳（时序归 git）。刻意不导出：导出了它，下一个消费者就能绕开
 * styleWarnings 自己判一次，而那正是本模块收掉的那份重复；要验这个正则的行为就验
 * styleWarnings 的对外输出，不验中间件。
 */
const DATE_RE = /\d{4}-\d{2}-\d{2}/

/**
 * 风格类提示（不拦截）的单一判定源：日期戳与派生索引行超长。离线自检（scripts/checks.mjs
 * 的 entry-date-stamp 项）问它；派生行超长那一半由 entry-index-line 项按行预算直接判，
 * 不经这里重复报。
 *
 * 返回的文案不带定位：检查侧由段与条目名给出定位，调用点补自己的前缀。每条带 kind
 * （'date-stamp'｜'index-line-length'）——消费方按 kind 拣选，不按文案子串挑：文案一改
 * 拣选就漂，同一件事就会双报或漏报。
 *
 * 两个入参都必填：缺 indexLine 是编程错误（派生行在调用前刚算出来就在手上），故让它
 * TypeError，不给默认值——给了空串就会报成「派生行 0 字符」，把一条接线错误说成一条内容问题。
 */
export function styleWarnings({ description, indexLine }) {
	const warnings = []
	if (DATE_RE.test(description)) {
		warnings.push({ kind: 'date-stamp', text: `description 含日期戳（${WRITING_FILE}：不写日期戳，时序归 git）` })
	}
	if (indexLine.length > INDEX_LINE_CHAR_BUDGET) {
		warnings.push({
			kind: 'index-line-length',
			text: `派生索引行 ${indexLine.length} 字符超 ${INDEX_LINE_CHAR_BUDGET}——收敛 description（整行上限即 description 上限的推论）`,
		})
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
 * 与死链报告里「文件:行」的写法对齐。
 *
 * 只共用遍历，不共用降级：调用方的失败粒度不同（体检逐条目降级），把降级并进来就得替
 * 调用方挑一种粒度，而挑错那一种的表现是「这份报告少了几处」——比「这几处没扫到」更难
 * 发现。cb 里抛的异常照原样冒给调用方的 try，粒度由它们自己挂。
 *
 * 行号在这里算而不在调用方切行：切行后 matchAll 只能看到本行内的匹配，调用方就会
 * 各写一份自己的行号拼法。匹配下标单调递增，故整篇只扫一遍换行。
 *
 * 这里按 `\n` 计而 frontmatter.js 的 frontmatterLines 另有一套 CRLF 归一，两套并存不冲突：
 * 本行的号只服务人读的「文件:行」定位（读者拿去编辑器里跳），CRLF 与否差不出一行；那边
 * 归一服务的是 frontmatter 解析判据（围栏与键行认不认），答的是另一个问题。两边答案不同
 * 不是缺陷，是两个问题。
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
 * 正文按节组织的契约（`## 标题` 行）与它的三件判定：节标题清单、节长量、节重名。
 * 收进本模块的理由与上面两节相同——正文按节这件事有多个消费面（注入侧判重名告警、
 * 离线自检判重名与量节长），各写一遍「什么算一节」就会有一份认得 `##　全角空格`
 * 而另一份不认，症状是同一篇条目在一处眼里有节、在另一处眼里没有。
 *
 * 节的判定刻意窄：只认 `## `（两井一空格）开头、标题去空白后非空的行——`###` 与更深的
 * 标题是节内层级不是节，`##`（无空格）与 `## `（空标题）是病态写法不算节。标题按去空白
 * 后的串参与比对（尾随空格不构成「另一个标题」）。
 *
 * 扫描范围先剥 frontmatter 再算行号：frontmatter 行里出现 `## ` 形态的行本来就会被
 * frontmatter 契约拦下，但「写侧拦得住的」不该由这里的判定再赌一遍——剥掉之后行号与
 * 「frontmatter 之后第几行」严格一致，量节长时不必再想围栏在哪。
 */
const SECTION_HEADING_RE = /^## (.+)$/

/**
 * 一篇条目的节标题清单：[{ title, line }]，line 是该 `## ` 行在归一后行数组中的下标
 * （0 起）。title 已去首尾空白；量节长的调用方用同一口径（下一节标题行号即本节终点）。
 */
export function sectionHeadings(text) {
	const lines = frontmatterLines(text)
	const fenceEnd = findFenceEnd(lines)
	const bodyStart = fenceEnd === -1 ? 0 : fenceEnd + 1
	const headings = []
	for (let offset = 0; bodyStart + offset < lines.length; offset += 1) {
		const matched = SECTION_HEADING_RE.exec(lines[bodyStart + offset])
		const title = matched?.[1].trim()
		if (title !== undefined && title.length > 0) headings.push({ title, line: bodyStart + offset })
	}
	return headings
}

/** 节重名判定：同篇条目内去空白后同名的节标题 ≥2 时返回那批标题（其余返回空数组）。 */
export function duplicateSectionHeadings(text) {
	const counts = new Map()
	for (const { title } of sectionHeadings(text)) counts.set(title, (counts.get(title) ?? 0) + 1)
	return [...counts].filter(([, count]) => count > 1).map(([title]) => title)
}

/** 节重名告警的共享正文（注入侧告警与离线自检的 issue detail 各补自己的定位）。 */
export const sectionDupNotice = (title) => `节重名「${title}」——条目内 ## 标题须唯一（标题是条目内唯一的节锚，重名即指不出是哪一节）`
