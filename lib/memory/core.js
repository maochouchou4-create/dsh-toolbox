/**
 * dsh-memory 的纯函数核心：注入预算常量、记忆根与层路由（slug 与层目录归一）、
 * 索引预算化、错误文案归一。零宿主依赖（只用 node:path 与 lib/paths.js），可独立单测；
 * cordis 胶水在 lib/index.js，条目 frontmatter 契约与索引行派生在 frontmatter.js，
 * 三动作共用的文本判据在 patterns.js，写侧在 write.js，读侧的条目读取与注入块组装在
 * assemble.js。
 *
 * 本文件不含文件读取，这是导入图上的一条硬边界：写侧要用预算常量与层路由，两者都在这里，
 * 于是写侧的传递闭包必然经过本模块——把读取一并收进来，「upsert/edit 的 I/O 只经 fs 端口」
 * 就只剩「本文件零直连」这一跳的断言，而共享件里加一行 import node:fs 就能绕过去。
 * 纯度同时是宿主按投影去重依赖的性质：内容不变不重复注入、变更自动顶替。
 */
import { join, resolve } from 'node:path'
import { expandHome } from '../paths.js'
import { isNonBlankString } from '../value.js'

/**
 * 失控保护上限（字符，非字节；中文按字符计）。
 * 仅防单文件疯长静默吃上下文的病态路径；日常不设上限，治理靠用户定期收敛。
 * 块级总量无上限（至多 3 个文件，各自有截断标注兜底，README 已披露）。
 */
export const RUNAWAY_CEILING = 65536

/**
 * 索引注入预算：索引常驻每装配，超预算时截断并显式标注，逼收敛而不是静默吃上下文
 * （条目文件不走此预算，仍只有失控保护）。行/字符双限，任一超限即截断。
 * 逐层施加（两层各一份预算，合计无上限）。实测与余量不要抄进注释——那是最容易陈旧的
 * 数字；跑验收段那条带参 `npm run check:memory -- <记忆根> <工作区 cwd>` 看当前数。
 */
export const INDEX_LINE_BUDGET = 40
export const INDEX_CHAR_BUDGET = 5000

/**
 * 单条索引行的字符上限：每轮都读的常驻材料，长行即长 token 支出。
 * 它同时是 description 的上限推论（派生前缀长度随 title 浮动），故不再单设
 * description 预算——两个上限会互相矛盾（短 title 放得下、长 title 放不下）。
 */
export const INDEX_LINE_CHAR_BUDGET = 160

/**
 * 注入块整块的字符定档：前三重只管索引，这里管块体合计（含写侧纪律 WRITING.md）。
 * 与前三重的根本差别是运行期**不截**——composeMemory 只逐层施加前三重；截整块会连写侧
 * 纪律一起截掉，规则被静默丢掉比超预算更难查，所以这一重只判红，由
 * scripts/check-memory-index.mjs 离线做。
 *
 * 定档按「还能装几条新条目」而不是百分比：条目派生行长度随 title 浮动，百分比定的线在
 * 语料一变就名不副实（实测均长约 137 字符，4700 的线连一条都装不下，等于每次写记忆都
 * 要抬线——那不叫治理线）。改它之前先跑上面那条命令看实测，再按条目均长换算余量。
 */
export const BLOCK_CHAR_BUDGET = 5000

/** 记忆根默认值的唯一事实源（Config 默认、apply 回退、compose 回退共用）。 */
export const DEFAULT_MEMORY_ROOT = '~/.dsh/memory'

/**
 * Config 值「给了就用」的取值形态：非空白的字符串原样取用，其余（undefined／null／空串／
 * 纯空白／非字符串）回落到缺省值。判据本身问 lib/value.js 那份跨族原语。
 *
 * 记忆侧收这一份是因为四个调用点各写一遍，而它们写的还不是同一个：胶水层的 Config 回退带
 * trim 与空串判定，另三处只有 `??`。差的那份让同一个「空串」在一条路径上被当缺省、在另一条
 * 上被当有效值传下去——于是空串那个值在读写两侧能算出两个不同的记忆根，而症状要到条目写
 * 进了相对路径才发现。
 */
export function nonEmptyOrDefault(value, fallback) {
	return isNonBlankString(value) ? value : fallback
}

/**
 * 记忆根归一成绝对路径（Config 进插件的单一收敛点，在 registerMemory 里调用）：
 * 相对路径在不同后端会被不同基目录解析——写侧走宿主 fs 后端自己的基目录，读侧走本
 * 进程 cwd，两套语义迟早把读写分家。归一后两侧拿到的都是同一个绝对根。
 * 条目分桶不在这里定：读侧取会话已提交目录（working-directory 服务的 get）、工具侧
 * 取同一份（ensure），两条路径共用一个来源，谁也不许自己认 process.cwd()。
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
 * 层路由：habit → 习惯层目录；workspace → 按 cwd 归一的工作层桶（缺 cwd 报错，防误写错层）。
 * 读侧组装注入块与写侧定落点问同一份：层位置写成两套映射，读侧装出来的层与写侧写进去的
 * 层迟早对不上，而那症状是「条目写进去了但注不进来」，比报错更难查。
 */
export function resolveLayerDir({ memoryRoot, layer, cwd }) {
	const root = resolveRoot(nonEmptyOrDefault(memoryRoot, DEFAULT_MEMORY_ROOT))
	if (layer === 'habit') return root.profile
	if (layer === 'workspace') {
		if (typeof cwd !== 'string' || cwd.length === 0) {
			throw new Error('工作层需要会话 cwd；无会话上下文时只能写习惯层')
		}
		const slug = workspaceSlug(cwd)
		if (slug.length === 0) throw new Error(`cwd 归一桶名为空：${cwd}`)
		return join(root.workspaces, slug)
	}
	throw new Error(`未知层 "${layer}"（habit | workspace）`)
}

/**
 * 超字符预算时的切点：取预算内最后一个换行之前的那几行，行尾补 …。
 * 换行两侧都是码元边界，所以按换行回退顺带保证不劈开代理对——半个 emoji 进注入块
 * 比少注入一行更难认。首行就超预算时无换行可回退（一条索引行长到这个地步，说明
 * description 该收敛），此时退回按预算硬切，只把落在高代理项上的那个码元摘掉：
 * 丢掉整行会让这条索引彻底不可见（连标题都没了，而标题正是召回入口）。
 * 返回 chars＝注入的原文长度（不含 …），供截断标注报实际注入量。
 */
function cutAtLineBoundary(text) {
	const window = text.slice(0, INDEX_CHAR_BUDGET)
	const breakAt = window.lastIndexOf('\n')
	if (breakAt !== -1) {
		const head = window.slice(0, breakAt)
		return { chars: head.length, text: `${head}…` }
	}
	const last = window.charCodeAt(window.length - 1)
	const head = last >= 0xd800 && last <= 0xdbff ? window.slice(0, -1) : window
	return { chars: head.length, text: `${head}…` }
}

/** 索引预算化；未超限时 text 原样返回（保持纯度，不落盘）。 */
export function applyIndexBudget(text) {
	// 计行前剥尾换行：生成器不产尾 \n，但作者手贴的块会带；不剥则恰满预算被误判超一行
	const lines = text.replace(/\n$/, '').split('\n')
	const overLines = lines.length > INDEX_LINE_BUDGET
	let out = overLines ? lines.slice(0, INDEX_LINE_BUDGET).join('\n') : text
	const overChars = out.length > INDEX_CHAR_BUDGET
	// 字符分支的切点与行分支同一形态：行尾留 … 标出「这里被切了」，块尾再补一条标注。
	// 按码元硬切会产出半个 emoji 或一行无标注的碎片，而碎片会被当条目读进去
	const cut = overChars ? cutAtLineBoundary(out) : undefined
	if (cut !== undefined) out = cut.text
	if (!overLines && !overChars) {
		return { text, truncated: false, origLines: lines.length, origChars: text.length }
	}
	const kept = cut === undefined ? `${INDEX_LINE_BUDGET} 行` : `${cut.chars} 字符`
	return {
		text: `${out}\n\n…（索引超预算截断：原文 ${lines.length} 行/${text.length} 字符，仅注入前 ${kept}——用 memory 工具 lint 定位收敛）\n`,
		truncated: true,
		origLines: lines.length,
		origChars: text.length,
	}
}

/**
 * 错误文案归一，读侧与写侧共用一份：同一个错误两处各拼一次，拼歪了就是两种口径的
 * 诊断文案，比诊断本身更费解。
 */
export const describeError = (error) => (error instanceof Error ? error.message : String(error))
