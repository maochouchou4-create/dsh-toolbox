/**
 * dsh-memory 纯函数核心（读侧）：slug 计算、失控保护读取、索引预算、注入块组装。
 * 零宿主依赖（仅 node:* 内建），可独立单测；cordis 胶水在 lib/index.js，写侧在 lib/write.js。
 * 全部函数保持纯度（仅依赖入参与文件内容）——宿主按投影去重依赖这一点：
 * 内容不变不重复注入、变更自动顶替。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 失控保护上限（字符，非字节；中文按字符计）。
 * 仅防单文件疯长静默吃上下文的病态路径；日常不设上限，治理靠用户定期收敛。
 * 块级总量无上限（至多 3 个文件，各自有截断标注兜底，README 已披露）。
 */
export const RUNAWAY_CEILING = 65536

/**
 * 索引（MEMORY.md）注入预算：索引常驻每装配，超预算时截断并显式标注，
 * 逼收敛而不是静默吃上下文（条目文件不走此预算，仍只有失控保护）。
 * 行/字符双限，任一超限即截断（对齐 Claude Code auto memory 的索引治理口径）。
 */
export const INDEX_LINE_BUDGET = 200
export const INDEX_CHAR_BUDGET = 25000

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
	// 计行前剥尾换行：文件尾的 \n 不是一行（否则恰 200 行的索引被误判 201 行）
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

/**
 * 组装注入块（单一字符串；全空返回 ''，宿主滤除空块）。
 * 块序：[记忆索引] 头 → 记忆书写规则 → 习惯层 → 工作层。
 * 两个 MEMORY.md 索引走 INDEX_* 预算（截断即治理信号）；WRITING.md 只受失控保护。
 * cwd 缺失（如无会话的全局预览装配）时工作层跳过，其余照常。
 * onIssue(kind, path, detail) 是旁路诊断回调，不影响返回值：
 * - 'read-error'：文件在但读失败、该层省略（胶水层映射 warn）
 * - 'bucket-without-index'：工作区桶目录存在但缺 MEMORY.md（胶水层映射 debug）
 */
export function composeMemory({ memoryRoot, cwd, onIssue } = {}) {
	const report = onIssue ?? (() => {})
	const root = resolveRoot(memoryRoot ?? DEFAULT_MEMORY_ROOT)
	const parts = []

	const pushLayer = (title, baseDir, path, budgetIndex = false) => {
		const read = readCapped(path)
		if (read.status === 'missing') return
		if (read.status === 'read-error') {
			report('read-error', path, read.message)
			return
		}
		// 空索引（仅标题行或空白）＝该层无内容，安静省略，不注入 header-only 噪声块
		if (read.text.replace(/^#[^\n]*\n?/, '').trim().length === 0) return
		const text = budgetIndex ? applyIndexBudget(read.text).text : read.text
		parts.push(`## ${title}\n基目录：${baseDir}\n\n${text}`)
	}

	const rulesPath = join(root.profile, 'WRITING.md')
	const rules = readCapped(rulesPath)
	if (rules.status === 'ok') parts.push(`## 记忆书写（写侧纪律）\n\n${rules.text}`)
	else if (rules.status === 'read-error') report('read-error', rulesPath, rules.message)

	pushLayer('习惯层（跨机同步）', root.profile, join(root.profile, 'MEMORY.md'), true)

	if (typeof cwd === 'string' && cwd.length > 0) {
		const slug = workspaceSlug(cwd)
		if (slug.length > 0) {
			const bucket = join(root.workspaces, slug)
			const indexPath = join(bucket, 'MEMORY.md')
			if (existsSync(bucket) && !existsSync(indexPath)) report('bucket-without-index', indexPath)
			pushLayer('工作层（本工作区·本机专属）', bucket, indexPath, true)
		}
	}

	if (parts.length === 0) return ''
	return `[记忆索引] 索引常驻；条目正文按需读取。\n\n${parts.join('\n\n')}`
}
