/**
 * dsh-memory 纯函数核心（读侧）：slug 计算、失控保护读取、索引扫描生成、注入块组装。
 * 零宿主依赖（仅 node:* 内建），可独立单测；cordis 胶水在 lib/index.js，写侧在 write.js，
 * 条目 frontmatter 契约与索引行派生在 frontmatter.js（本文件与 write.js 共用同一份判定）。
 * 除文件读取外全部保持纯度——宿主按投影去重依赖这一点：
 * 内容不变不重复注入、变更自动顶替。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { deriveIndexLine, isEntryName, parseFrontmatter } from './frontmatter.js'

/**
 * 失控保护上限（字符，非字节；中文按字符计）。
 * 仅防单文件疯长静默吃上下文的病态路径；日常不设上限，治理靠用户定期收敛。
 * 块级总量无上限（至多 3 个文件，各自有截断标注兜底，README 已披露）。
 */
export const RUNAWAY_CEILING = 65536

/**
 * 索引注入预算：索引常驻每装配，超预算时截断并显式标注，逼收敛而不是静默吃上下文
 * （条目文件不走此预算，仍只有失控保护）。行/字符双限，任一超限即截断。
 * 逐层施加（两层各一份预算，合计无上限）。当前语料两层合计约 22 条、2.6K 字符，
 * 离定档还有近一倍余量；要改档先跑 `npm run check:memory` 看实测，别拿注释里的
 * 旧数字当尺子。
 */
export const INDEX_LINE_BUDGET = 40
export const INDEX_CHAR_BUDGET = 5000

/**
 * 单条索引行的字符上限：每轮都读的常驻材料，长行即长 token 支出。
 * 它同时是 description 的上限推论（派生前缀长度随 title 浮动），故不再单设
 * description 预算——两个上限会互相矛盾（短 title 放得下、长 title 放不下）。
 */
export const INDEX_LINE_CHAR_BUDGET = 160

/** 记忆根默认值的唯一事实源（Config 默认、apply 回退、compose 回退共用）。 */
export const DEFAULT_MEMORY_ROOT = '~/.dsh/memory'

/** 展开路径开头的 `~/`。 */
export function expandHome(path) {
	if (typeof path !== 'string' || path.length === 0) return path
	if (path === '~') return homedir()
	if (path.startsWith('~/')) return join(homedir(), path.slice(2))
	return path
}

/**
 * 记忆根归一成绝对路径（Config 进插件的单一收敛点，在 registerMemory 里调用）：
 * 相对路径在不同后端会被不同基目录解析——写侧走宿主 fs 后端自己的基目录，读侧与
 * delete/lint 走 process.cwd()，两套语义迟早把读写分家。相对就按解析时的 cwd 定死，
 * 那也是读侧原本的口径。
 */
export function absoluteMemoryRoot(memoryRoot) {
	return resolve(expandHome(memoryRoot))
}

/** 记忆根下的两个固定子位置。 */
export function resolveRoot(memoryRoot) {
	const root = expandHome(memoryRoot)
	return { profile: join(root, 'profile'), workspaces: join(root, 'workspaces') }
}

/**
 * 工作区绝对路径 → 桶名 slug。
 * 规则：把 `/` `\` `:` 全部替换为 `-`，折叠连续 `-`，去首尾 `-`；不小写化。
 * 例：/home/nvse/code → home-nvse-code；D:\code → D-code。
 * 入参非字符串或空串＝编程错误，抛 TypeError（Fail Fast）；
 * 替换后得空串（如路径全是分隔符）返回 ''，由调用方省略该层并告警。
 */
export function workspaceSlug(cwd) {
	if (typeof cwd !== 'string' || cwd.length === 0) {
		throw new TypeError(`workspaceSlug expects a non-empty cwd string, got: ${typeof cwd}`)
	}
	return cwd.replace(/[\\/:]+/g, '-').replace(/^-+|-+$/g, '')
}

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
		return { status: 'read-error', message: error instanceof Error ? error.message : String(error) }
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

/** 索引预算化；未超限时 text 原样返回（保持纯度，不落盘）。 */
export function applyIndexBudget(text) {
	// 计行前剥尾换行：生成器不产尾 \n，但作者手贴的块会带；不剥则恰满预算被误判超一行
	const lines = text.replace(/\n$/, '').split('\n')
	const overLines = lines.length > INDEX_LINE_BUDGET
	let out = overLines ? lines.slice(0, INDEX_LINE_BUDGET).join('\n') : text
	const overChars = out.length > INDEX_CHAR_BUDGET
	if (overChars) out = out.slice(0, INDEX_CHAR_BUDGET)
	if (!overLines && !overChars) {
		return { text, truncated: false, origLines: lines.length, origChars: text.length }
	}
	const kept = overLines && !overChars ? `${INDEX_LINE_BUDGET} 行` : `${out.length} 字符`
	return {
		text: `${out}\n\n…（索引超预算截断：原文 ${lines.length} 行/${text.length} 字符，仅注入前 ${kept}——用 memory 工具 lint 定位收敛）\n`,
		truncated: true,
		origLines: lines.length,
		origChars: text.length,
	}
}

/** 前置分块大小与读取上限：frontmatter 恒在文件头部，读到闭合就停，不必整篇读入。 */
const HEAD_CHUNK_BYTES = 2048
const HEAD_MAX_BYTES = 65536

// 按 \r?\n 切而不是 \n：Windows 家机 git checkout 产出的 CRLF 条目，按 \n 切出来
// 每行尾都带 \r，闭合围栏永不命中，提前退出恒不成立——每轮每条都要读到 64KB 上限
const hasClosedFence = (text) => {
	const lines = text.split(/\r?\n/)
	return lines[0] === '---' && lines.indexOf('---', 1) !== -1
}

/**
 * 只读文件头（读到 frontmatter 闭合为止，最多 HEAD_MAX_BYTES）。
 * 分块累积 Buffer、只在末尾解码：按块解码会把跨块的多字节字符劈成替换符，
 * 派生出的索引行就会带乱码——那是每轮都进上下文的常驻材料，不能有这种噪声。
 */
function readFrontmatterHead(path) {
	const handle = openSync(path, 'r')
	try {
		const buffer = Buffer.alloc(HEAD_CHUNK_BYTES)
		const chunks = []
		let total = 0
		while (total < HEAD_MAX_BYTES) {
			const read = readSync(handle, buffer, 0, HEAD_CHUNK_BYTES, total)
			if (read === 0) break
			chunks.push(Buffer.from(buffer.subarray(0, read)))
			total += read
			if (hasClosedFence(Buffer.concat(chunks).toString('utf8'))) break
		}
		return Buffer.concat(chunks).toString('utf8')
	} finally {
		closeSync(handle)
	}
}

/**
 * 错误文案归一，读侧与写侧共用一份：同一个错误两处各拼一次，拼歪了就是两种口径的
 * 诊断文案，比诊断本身更费解。
 */
export const describeError = (error) => (error instanceof Error ? error.message : String(error))

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
	const root = resolveRoot(memoryRoot ?? DEFAULT_MEMORY_ROOT)
	const parts = []

	const pushLayer = (title, dir) => {
		if (!existsSync(dir)) return
		const block = buildIndexBlock(dir, report)
		if (block === null) return
		parts.push(`## ${title}\n基目录：${dir}\n\n${applyIndexBudget(block).text}`)
	}

	const rulesPath = join(root.profile, 'WRITING.md')
	const rules = readCapped(rulesPath)
	if (rules.status === 'ok') parts.push(`## 记忆书写（写侧纪律）\n\n${rules.text}`)
	else if (rules.status === 'read-error') report('read-error', rulesPath, rules.message)

	pushLayer('习惯层（跨机同步）', root.profile)

	if (typeof cwd === 'string' && cwd.length > 0) {
		const slug = workspaceSlug(cwd)
		if (slug.length > 0) pushLayer('工作层（本工作区·本机专属）', join(root.workspaces, slug))
	}

	if (parts.length === 0) return ''
	return `[记忆索引] 索引常驻；条目正文按需读取。\n\n${parts.join('\n\n')}`
}
