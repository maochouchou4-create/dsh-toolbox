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
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { RUNAWAY_CEILING, applyIndexBudget, describeError, resolveLayerDir, workspaceSlug } from './core.js'
import {
	FRONTMATTER_HEAD_MAX_BYTES,
	deriveIndexLine,
	hasClosedFence,
	isEntryName,
	parseFrontmatter,
} from './frontmatter.js'
import { readFileHead } from './head-read.js'

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
 */
function readFrontmatterHead(path) {
	return readFileHead(path, FRONTMATTER_HEAD_MAX_BYTES, hasClosedFence)
}

/**
 * 扫一层目录生成索引块（不落盘）。无条目返回 null＝该层无内容，调用方省略整层。
 * 条目按文件名排序，保证注入块逐次装配稳定可比（readdir 顺序不作数）。
 * 单个文件读不动或 frontmatter 不合规都只报 onIssue 继续——一个坏条目不该让整层索引消失。
 * 导出给 scripts/check-memory-index.mjs：离线自检得用与注入侧同一份扫描判定，
 * 脚本自己重写一遍就变成「用另一套尺子量这把尺子」。
 *
 * 不做跨调用缓存：每轮装配的真实负载是「条目数 × 一个 2KB 分块」（现语料 22 条、
 * 约 44KB，页缓存内亚毫秒），换来的却是模块级可变状态——纯度没了、缓存键还得自己
 * 算一份版本标识（弱于端口那份就等于索引会停在旧值），而失效点只能挂在写侧成功
 * 之后。收益不抵这三样成本。
 */
export function buildIndexBlock(dir, report = () => {}) {
	let names
	try {
		names = readdirSync(dir)
	} catch (error) {
		report('read-error', dir, describeError(error))
		return null
	}
	const lines = []
	for (const name of names.sort()) {
		if (!isEntryName(name)) continue
		const path = join(dir, name)
		let isFile
		try {
			isFile = statSync(path).isFile()
		} catch (error) {
			report('read-error', path, describeError(error))
			continue
		}
		// 名字是 .md 却不是普通文件（同名目录）：当条目处理不了，从索引省略并报出去，
		// 静默跳过会让人以为那条目不存在
		if (!isFile) {
			report('read-error', path, '条目名被非普通文件占用，已从索引省略')
			continue
		}
		let line = null
		try {
			const parsed = parseFrontmatter(readFrontmatterHead(path))
			if (parsed.ok) {
				line = deriveIndexLine({ ...parsed.frontmatter, file: name })
			} else {
				report('entry-frontmatter', path, parsed.error)
			}
		} catch (error) {
			report('read-error', path, describeError(error))
		}
		if (line !== null) lines.push(line)
	}
	return lines.length === 0 ? null : lines.join('\n')
}

/**
 * 组装注入块（单一字符串；全空返回 ''，宿主滤除空块）。
 * 块序：[记忆索引] 头 → 记忆书写规则 → 习惯层 → 工作层。
 * 两层索引扫目录现场生成、走 INDEX_* 预算（截断即治理信号）；WRITING.md 只受失控保护。
 * cwd 缺失（如无会话的全局预览装配）时工作层跳过，其余照常。
 * onIssue(kind, path, detail) 是旁路诊断回调，不影响返回值：
 * - 'read-error'：文件在但读失败、该条目/该层省略（胶水层映射 warn）
 * - 'entry-frontmatter'：条目缺/不合规 frontmatter，该条目不进索引（胶水层映射 warn）
 */
export function composeMemory({ memoryRoot, cwd, onIssue } = {}) {
	const report = onIssue ?? (() => {})
	const parts = []
	const habitDir = resolveLayerDir({ memoryRoot, layer: 'habit' })

	const pushLayer = (title, dir) => {
		if (!existsSync(dir)) return
		const block = buildIndexBlock(dir, report)
		if (block === null) return
		parts.push(`## ${title}\n基目录：${dir}\n\n${applyIndexBudget(block).text}`)
	}

	const rulesPath = join(habitDir, 'WRITING.md')
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
