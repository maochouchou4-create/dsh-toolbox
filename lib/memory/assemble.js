/**
 * dsh-memory 读侧的 I/O 半边：失控保护读取、frontmatter 头读、层目录索引扫描、注入块组装。
 *
 * 从 core.js 分出来的理由写在 core.js 的文件头（写侧导入闭包要穿过那里）：读与写分成两半
 * 是导入图上的硬边界，不是文件大小的偏好。
 *
 * 直连 node:fs 是读侧的既定取舍：宿主沙箱只围栏写入，读与列目录不受策略约束，走端口只是
 * 白付 async 成本（与 delete／lint 同一口径，两处的 why 各自写在本模块）。头读机制本身
 * 在 head-read.js，与端口的 node 适配器共用一份；共享的是机制，「读多少算够」的早退判据
 * 仍留在读侧（端口契约明写「不截到围栏」，带领域知识的早退不进端口）。
 *
 * 依赖边：体检（lint，写侧的离线镜像）与离线自检脚本从这里取层扫描原语——读侧持有，写侧
 * 消费。列目录、命名判据、排序、解析、组判定只有这一份，三处各扫一次就会漂，而漂出来的
 * 症状是某一处沉默、另两处报得出来。方向不可反：读侧不必知道有写侧那两件事。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readFileHead } from '../head-read.js'
import { describeError, workspaceSlug } from '../memory-root.js'
import { RUNAWAY_CEILING, applyIndexBudget, resolveLayerDir } from './core.js'
import {
	FRONTMATTER_HEAD_MAX_BYTES,
	WRITING_FILE,
	deriveIndexLine,
	groupByTitle,
	hasClosedFence,
	isEntryName,
	parseEntry,
	renderCoverageWarning,
	renderDupWarning,
} from './frontmatter.js'

/**
 * 读一个文件，超失控保护时头部截断并显式标注（防静默丢尾）。
 * 三分支返回：
 * - ok：{ status, text, truncated, origChars }
 * - missing：文件不存在（层省略的常态，不是错误）
 * - read-error：文件在但读失败（调用方经 onIssue 上报——静默吞读错误会让「层消失」无从诊断）
 */
export function readCapped(path) {
	if (!existsSync(path)) return { status: 'missing' }
	let text
	try {
		text = readFileSync(path, 'utf8')
	} catch (error) {
		return { status: 'read-error', message: describeError(error) }
	}
	if (text.length <= RUNAWAY_CEILING) {
		return { status: 'ok', text, truncated: false, origChars: text.length }
	}
	const head = text.slice(0, RUNAWAY_CEILING)
	return {
		status: 'ok',
		truncated: true,
		origChars: text.length,
		text: `${head}\n\n…（失控保护截断：原文 ${text.length} 字符，仅注入前 ${RUNAWAY_CEILING} 字符，全文在 ${path}）\n`,
	}
}

/**
 * 只读文件头（读到 frontmatter 闭合为止，最多 FRONTMATTER_HEAD_MAX_BYTES）。
 * 分块累积与末尾解码在 head-read.js 的机制里，这里只给「读到这儿够了没有」的判据：
 * 读侧要的正是带领域知识的围栏早退，而那不进端口。
 *
 * 导出给离线自检脚本：它要与注入侧用同一份读法，否则派生行与它报出的 issue 出自两把
 * 尺子，「同一语料两个镜像」的分叉就又回来了。
 */
export function readEntryHead(path) {
	return readFileHead(path, FRONTMATTER_HEAD_MAX_BYTES, hasClosedFence)
}

/**
 * 扫一层目录：列出条目、逐条读入（读法由调用方给）、解析 frontmatter、派生索引行，
 * 并判出层内 title 重名与覆盖面缺口。三处消费者——注入装配、体检、离线自检——的差异只在
 * 「怎么读一条」与「读到之后各自再判什么」，列目录、命名判据、排序、解析、组判定这五件事是
 * 同一件事，各写一遍就迟早在某一面漂，而漂出来的症状是同一组撞名在体检里报了而注入侧没报。
 *
 * read(path) → 文本，由调用方给：注入侧与离线自检要的是头（frontmatter 恒在头部几百字节，
 * 条目正文可以到几十 KB），体检要的是整篇（wikilink 与失控保护查的是正文）。读法是消费方
 * 的知识，扫层不是——所以它进参数，不进本函数。
 *
 * report(issue, path, detail) 是旁路诊断出口，issue 取值就是下面那五种，四处口径一致：
 * - 'read-error'：层目录列不动 / 条目 stat 或读失败 / 条目名被非普通文件占用
 * - 'entry-frontmatter'：条目缺或不合规 frontmatter，该条目不进索引
 * - 'layer-title-dup'：层内 title 撞名，那几行在注入索引里按 title 分不出谁是谁
 * - 'layer-title-coverage'：本层有几条 title 判不了，重名结论只覆盖其余条目
 * 组判定在循环外一次做完（撞名与覆盖面都是「整层」的性质，循环里报就等于每条条目报一次），
 * 文案问 frontmatter.js 那份共享渲染点，写侧报错、体检 warning、离线自检报告三处同源。
 *
 * 列不动目录时返回 null：调用方对「这一层什么都判不出来」的反应各不相同（注入侧省略整层、
 * 体检报一条 warning、离线自检收一条 issue），把反应留在调用方，扫描只负责把事实交出去。
 *
 * 不做跨调用缓存：每轮装配的真实负载是「条目数 × 一个 2KB 分块」（页缓存内亚毫秒），换来的
 * 却是模块级可变状态——纯度没了、缓存键还得自己算一份版本标识（弱于端口那份就等于索引会停在
 * 旧值），而失效点只能挂在写侧成功之后。收益不抵这三样成本。
 */
export function scanLayer(dir, options = {}) {
	// 第二参带缺省空对象：漏参最常见的裸调写法也要落到下面的点名消息，而不是解构 undefined
	// 的原生 TypeError（报不出漏的是什么）
	const { read, report = () => {} } = options
	// 读法是必填参数，且它的缺失是调用方的编程错误而不是语料的病态：降级出口（report）收的是
	// 「这一层/这一条读不动」，把漏参也走那条路的话，三处消费者各自安静地少扫一层——体检少报一轮、
	// 离线自检少一层、装配少一块，而没有任何一处说得出会真正的原因。故当场抛，且抛在列目录之前：
	// 空层与漏参两种情况必须一眼分得开。
	if (typeof read !== 'function') {
		throw new Error(`scanLayer 的 read（读法）是必填参数，漏传或传了非函数是编程错误，不是条目病态（实得 ${read === undefined ? 'undefined' : typeof read}）——读法是消费方的知识（注入与离线自检要头、体检要整篇），扫层不替它选；降级出口只收语料的病态`)
	}
	let dirents
	try {
		// 按名排序而不是信 readdir 的返回序：注入块逐次装配要可比，两次装配读同一份语料
		// 必须给出同一个组序。排法是按码元比较（与 Array.prototype.sort 的默认比较同序），
		// 别换成 localeCompare：同一份语料在两台机器上会给出不同的组序
		dirents = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	} catch (error) {
		report('read-error', dir, describeError(error))
		return null
	}
	const names = dirents.map((dirent) => dirent.name)
	const entries = []
	for (const dirent of dirents) {
		if (!isEntryName(dirent.name)) continue
		const path = join(dir, dirent.name)
		// 逐条 stat 是 Dirent 出来之前的老办法：readdir 自带类型，真文件那一条不必再问盘。
		// 但 Dirent 是 lstat 口径——软链条目一律不是「文件」，直接按它判就会把指向普通文件的
		// 软链从索引里整个抹掉。端口的 listDir 既有取舍是「跟随 stat」，这里沿用同一取舍：
		// 只对判不出是不是普通文件的条目补那一次 stat，真文件一条都不补
		let isFile = dirent.isFile()
		if (!isFile) {
			try {
				isFile = statSync(path).isFile()
			} catch (error) {
				report('read-error', path, describeError(error))
				continue
			}
		}
		// 名字是 .md 却不是普通文件（同名目录）：当条目处理不了，从索引省略并报出去，
		// 静默跳过会让人以为那条目不存在
		if (!isFile) {
			report('read-error', path, '条目名被非普通文件占用，已从索引省略')
			continue
		}
		let text
		try {
			text = read(path)
		} catch (error) {
			report('read-error', path, describeError(error))
			continue
		}
		// 解析结果既派生索引行、也留给循环外的组判定：同一段文本只解一次
		const parsed = parseEntry({ name: dirent.name, text })
		entries.push({
			name: dirent.name,
			text,
			parsed,
			indexLine: parsed.ok ? deriveIndexLine({ ...parsed.frontmatter, file: dirent.name }) : null,
		})
		if (!parsed.ok) report('entry-frontmatter', path, parsed.error)
	}
	const { dups, unparsable } = groupByTitle(entries.map((entry) => entry.parsed))
	for (const { title, names: dupNames } of dups) {
		report('layer-title-dup', join(dir, dupNames[0]), renderDupWarning({ dir, title, names: dupNames }))
	}
	// 覆盖面缺口每层单独一条：无撞名时也得说——只报在撞名那条尾巴上，这层不撞名就一个字都不说
	if (unparsable.length > 0) report('layer-title-coverage', dir, renderCoverageWarning({ unparsable }))
	return { names, entries, lines: entries.map((entry) => entry.indexLine).filter((line) => line !== null) }
}

/**
 * 一层目录的注入索引块（不落盘）。无条目返回 null＝该层无内容，调用方省略整层。
 * 扫描本体在 scanLayer，本函数只做「行数组 → 注入块那一段字符串」这一步。
 */
function indexBlockOf(scan) {
	return scan === null || scan.lines.length === 0 ? null : scan.lines.join('\n')
}

/**
 * 组装注入块（单一字符串；全空返回 ''，宿主滤除空块）。
 * 块序：[记忆索引] 头 → 记忆书写规则 → 习惯层 → 工作层。
 * 两层索引扫目录现场生成、走 INDEX_* 预算（截断即治理信号）；WRITING.md 只受失控保护。
 * cwd 缺失（如无会话的全局预览装配）时工作层跳过，其余照常。
 * onIssue(kind, path, detail) 是旁路诊断回调，不影响返回值：
 * - 'read-error'：文件在但读失败、该条目/该层省略（胶水层映射 warn）
 * - 'entry-frontmatter'：条目缺/不合规 frontmatter，该条目不进索引（胶水层映射 warn）
 * - 'layer-title-dup'：层内 title 撞名，那几行在注入索引里按 title 分不出谁是谁（胶水层映射 warn）
 * - 'layer-title-coverage'：本层有几条 title 判不了，重名结论只覆盖其余条目（胶水层映射 warn）
 */
export function composeMemory({ memoryRoot, cwd, onIssue } = {}) {
	const report = onIssue ?? (() => {})
	const parts = []
	const habitDir = resolveLayerDir({ memoryRoot, layer: 'habit' })

	const pushLayer = (title, dir) => {
		if (!existsSync(dir)) return
		const block = indexBlockOf(scanLayer(dir, { read: readEntryHead, report }))
		if (block === null) return
		parts.push(`## ${title}\n基目录：${dir}\n\n${applyIndexBudget(block).text}`)
	}

	const rulesPath = join(habitDir, WRITING_FILE)
	const rules = readCapped(rulesPath)
	if (rules.status === 'ok') parts.push(`## 记忆书写（写侧纪律）\n\n${rules.text}`)
	else if (rules.status === 'read-error') report('read-error', rulesPath, rules.message)

	pushLayer('习惯层（跨机同步）', habitDir)

	// 层位置问 resolveLayerDir 一份（读侧与写侧认同一套映射）；这里多出的判定是装配侧的
	// 「这一层在不在本次块里」——缺 cwd 或桶名归一后为空即省略整层，不是错误、不报 issue
	if (typeof cwd === 'string' && cwd.length > 0 && workspaceSlug(cwd).length > 0) {
		pushLayer('工作层（本工作区·本机专属）', resolveLayerDir({ memoryRoot, layer: 'workspace', cwd }))
	}

	if (parts.length === 0) return ''
	return `[记忆索引] 索引常驻；条目正文按需读取。\n\n${parts.join('\n\n')}`
}
