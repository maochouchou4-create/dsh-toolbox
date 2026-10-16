/**
 * dsh-memory 的纯函数核心：注入预算常量、层路由（层目录落点）与索引预算化。零宿主依赖
 * （只用 node:path），可独立单测；cordis 胶水在 lib/index.js，记忆根归一与桶名在
 * lib/memory-root.js，条目 frontmatter 契约与索引行派生在 frontmatter.js，三动作共用的
 * 文本判据在 patterns.js，写侧在 write.js，读侧的条目读取与注入块组装在 assemble.js。
 *
 * 本文件不含文件读取，这是导入图上的一条硬边界：写侧要用层路由与预算常量，两者都在这里，
 * 于是写侧的传递闭包必然经过本模块与 lib/memory-root.js——把读取一并收进来，
 * 「upsert/edit 的 I/O 只经 fs 端口」就只剩「这两个文件零直连」这一跳的断言，而共享件里
 * 加一行 import node:fs 就能绕过去。纯度同时是宿主按投影去重依赖的性质：内容不变不重复
 * 注入、变更自动顶替。
 */
import { join } from 'node:path'
import { resolveRoot, workspaceSlug } from '../memory-root.js'

/**
 * memory 工具的 action 词表：参数面 enum、描述词表与未知动作报错读这一份（先例＝dispatch
 * 侧 batch.js 的 BATCH_ACTIONS——三处各抄一份就会有一份说谎）。
 */
export const MEMORY_ACTIONS = ['write', 'edit', 'delete', 'lint']

/**
 * 层值词表与其具名引用（单源＝这一个数组，消费点不写裸串）：参数面 schema enum、工具
 * description 的判层句、层路由、lint/checks 的层标签全走它。层值语义：profile＝习惯层
 * （跨机同步，目录 ~/.dsh/memory/profile）；workspace＝工作层（本工作区·本机专属，目录
 * ~/.dsh/memory/workspaces/<桶>）。层值曾叫 habit 而注入索引与描述天天教目录名 profile
 * ——一概念两名，模型照哪个传都有一半概率撞上；值与目录名对齐后只剩一个词。
 */
export const LAYERS = ['profile', 'workspace']
export const PROFILE_LAYER = LAYERS[0]
export const WORKSPACE_LAYER = LAYERS[1]

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
 * 两重不是两条互相竞争的线，是一声先一声后：层线在运行期就截，撞上当场可见（层内那条标注
 * 与块尾那句总结都出自 applyIndexBudget 的 cuts），先响；块线只由离线自检判红，后响。语料
 * 真的把两层都顶满，那是「该收敛了」这个状态本身，不是两条线打架——所以别拿「块线还远」
 * 当压住层线的理由。届时两层各截到自己的线上后块仍可越过块线（层线之和加写侧纪律本来就
 * 大于它），运行期对这个越线不设信号——块尾那句只报层截断，整块判红归 check:memory。
 *
 * 定档按「还能装几条新条目」而不是百分比：条目派生行长度随 title 浮动，百分比定的线在
 * 语料一变就名不副名（早先那条线按旧语料定，语料长起来后余量连一条新条目都装不下，等于
 * 每次写记忆都要抬线——那不叫治理线）。换算式＝**实测块字符数 ＋ N 条×实测条目派生行均长**，
 * N 取你打算让这条线再装几条，向下取整；实测数不进本注释（它是最容易陈旧的那类数字），
 * 改它之前先跑上面那条 check:memory 命令看当前定档与实测，再拿那两个数换算。
 */
export const BLOCK_CHAR_BUDGET = 7300

/**
 * 层路由：profile → 习惯层目录；workspace → 按 cwd 归一的工作层桶（缺 cwd 报错，防误写错层）。
 * 读侧组装注入块与写侧定落点问同一份：层位置写成两套映射，读侧装出来的层与写侧写进去的
 * 层迟早对不上，而那症状是「条目写进去了但注不进来」，比报错更难查。
 *
 * 层值域不在这里守：值域由参数面的 schema enum 声明，宿主在调用边界按它拦（报错自带合法值
 * 清单），值错到不了本函数——这里再留一条未知层分支就是永远走不到的死代码。层值走具名常量
 * （PROFILE_LAYER/WORKSPACE_LAYER），与 LAYERS 同源。
 *
 * 条目分桶的来源不在这里定，也不该由这里定：读侧与工具侧都取会话 header.cwd（口径见
 * lib/working-dir.js），两条路径共用一个来源，谁也不许自己认 process.cwd()——
 * 本函数只把传进来的 cwd 归一成桶名，不去问它从哪来。根与桶名本身问 lib/memory-root.js
 * 那一份（dispatch 的台账与离线自检脚本也用它，故它不该埋在 memory 目录里）。
 */
export function resolveLayerDir({ memoryRoot, layer, cwd }) {
	const root = resolveRoot(memoryRoot)
	if (layer === PROFILE_LAYER) return root.profile
	if (layer === WORKSPACE_LAYER) {
		if (typeof cwd !== 'string' || cwd.length === 0) {
			throw new Error('工作层需要会话 cwd；无会话上下文时只能写习惯层')
		}
		const slug = workspaceSlug(cwd)
		if (slug.length === 0) throw new Error(`cwd 归一桶名为空：${cwd}`)
		return join(root.workspaces, slug)
	}
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

/**
 * 索引预算化；未超限时 text 原样返回（保持纯度，不落盘）。
 *
 * 除了 text 还报出实际装进去多少（keptLines/keptChars）以及 cuts/keptLabel/cutLabel。消费
 * 面：块尾总结取 truncated/cutLabel，层内标注取 keptLabel；keptLines/keptChars/cuts 主要
 * 给测试与诊断直读——从 text 里反解这些等于拿渲染文案当数据面。
 *
 * 截断口径单源就在这个函数里：层内那条标注用 keptLabel（只说装进去多少），块尾那句总结用
 * cutLabel（说从多少切到多少）。两处各写一遍格式，早晚一句说行、一句说字符；两重都撞上时该
 * 说的是两重都撞了——cuts 就是那份「都撞上了」的清单，keptLabel/cutLabel 都从它派生。
 */
export function applyIndexBudget(text) {
	// 计行前剥尾换行：生成器不产尾 \n，但作者手贴的块会带；不剥则恰满预算被误判超一行
	const lines = text.replace(/\n$/, '').split('\n')
	const overLines = lines.length > INDEX_LINE_BUDGET
	const keptLines = overLines ? INDEX_LINE_BUDGET : lines.length
	let out = overLines ? lines.slice(0, keptLines).join('\n') : text
	const overChars = out.length > INDEX_CHAR_BUDGET
	// 字符分支的切点与行分支同一形态：行尾留 … 标出「这里被切了」，块尾再补一条标注。
	// 按码元硬切会产出半个 emoji 或一行无标注的碎片，而碎片会被当条目读进去
	const cut = overChars ? cutAtLineBoundary(out) : undefined
	if (cut !== undefined) out = cut.text
	const keptChars = cut === undefined ? out.length : cut.chars
	const cuts = []
	if (overLines) cuts.push({ dimension: '行', before: lines.length, after: keptLines })
	if (overChars) cuts.push({ dimension: '字符', before: text.length, after: keptChars })
	if (cuts.length === 0) {
		return { text, truncated: false, origLines: lines.length, origChars: text.length, keptLines, keptChars, cuts, keptLabel: '', cutLabel: '' }
	}
	const keptLabel = cuts.map((one) => `${one.after} ${one.dimension}`).join('、')
	const cutLabel = cuts.map((one) => `${one.before}→${one.after} ${one.dimension}`).join('、')
	return {
		text: `${out}\n\n…（索引超预算截断：原文 ${lines.length} 行/${text.length} 字符，仅注入前 ${keptLabel}——用 memory 工具 lint 定位收敛）\n`,
		truncated: true,
		origLines: lines.length,
		origChars: text.length,
		keptLines,
		keptChars,
		cuts,
		keptLabel,
		cutLabel,
	}
}
