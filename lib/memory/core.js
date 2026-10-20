/**
 * dsh-memory 的纯函数核心：注入预算常量、段路由（段目录落点）、条目寻址解析、索引预算化。
 * 零宿主依赖（只用 node:path），可独立单测；cordis 胶水在 lib/index.js，记忆根归一与 store
 * 落点在 lib/memory-root.js，条目名与保留名判定在 naming.js，条目 frontmatter 契约与索引行
 * 派生在 frontmatter.js，三动作共用的文本判据在 patterns.js，写侧在 write.js，读侧的条目
 * 读取与注入块组装在 assemble.js。
 *
 * 「段」（segment）＝注入块里的一段与它在盘上的落位：shared＝store 顶层（两机共享），
 * 机器 id＝store/machines/<id>/（该机私有）。归属由目录位置表达，条目本身不带归属字段，
 * 也不由运行时 cwd 推算——那是「换个目录记忆就换一份」那类坑的来源。
 *
 * 本文件不含文件读取，这是导入图上的一条硬边界：写侧要用段路由与预算常量，两者都在这里，
 * 于是写侧的传递闭包必然经过本模块与 lib/memory-root.js——把读取一并收进来，
 * 「upsert/edit 的 I/O 只经 fs 端口」就只剩「这两个文件零直连」这一跳的断言，而共享件里
 * 加一行 import node:fs 就能绕过去。纯度同时是宿主按投影去重依赖的性质：内容不变不重复
 * 注入、变更自动顶替。
 */
import { join } from 'node:path'

/**
 * 共享段的段值（保留字）：段值域＝shared ∪ 机器 id。它既是 store 顶层那一层的名字语义，
 * 也是机器名的负向断言——机器名不可叫 shared，否则本机段与共享段落进同一个目录，
 * 「两段各自查重、两段都注入」的隔离整套失效，而症状是两个不同机器的条目互相撞名。
 */
export const SHARED_SEGMENT = 'shared'

/**
 * 机器 id 形态：小写字母数字起头、只含小写字母数字与中划线，且不是保留字 shared。
 *
 * 值域的唯一判定源——参数面 schema 的 pattern、全形式 file_path 的解析、scope 与
 * config.machine 的校验全引这一份。各写一份时的症状是「schema 收下了 core 拒收的值」，
 * 而报错出现在离病因很远的地方（写盘时才发现目录名里有反斜杠）。
 *
 * 负向前瞻排除 shared 而不是在别处补一条判等：漏一处就是本机段与共享段同目录。
 */
export const MACHINE_ID_RE = /^(?!shared$)[a-z0-9][a-z0-9-]*$/

/** 机器私有段的父目录名：store 下唯一被展开为段的子目录（data/ 等不进段列表）。 */
export const MACHINES_DIR = 'machines'

/** 段值的展示标签（注入、体检、离线自检的行首前缀）：共享段是 shared，机器段带 machine:。 */
export const segmentKind = (scope) => (scope === SHARED_SEGMENT ? SHARED_SEGMENT : `machine:${scope}`)

/**
 * 机器身份是否已配置：未配置＝注入只有共享段、写入缺省落共享段、体检判红。
 * 单源在这里：读侧（注入要不要装本机段）、写侧（scope 缺省）与体检（判红）问的是同一件事，
 * 各写一份判据时的症状是某一侧把空串当成了机器名，于是本机段落进 store/machines//。
 */
export const isMachineConfigured = (machine) => typeof machine === 'string' && machine.trim().length > 0

/**
 * 段值校验（shared 或机器 id）：resolveScopeDir 的值域守门在这里而不只在参数面——
 * 调用方传进来的段值都到得了这儿。机器身份不走这里——它没有 shared 这个合法值，
 * 见 assertMachineId。报错带合法值形态而不是只说「非法」：读者是模型，要在一次重试里改对。
 */
function assertScopeValue(scope) {
	if (scope === SHARED_SEGMENT || (typeof scope === 'string' && MACHINE_ID_RE.test(scope))) return
	throw new Error(`未知 scope「${scope ?? ''}」：值＝${SHARED_SEGMENT}（共享段，store 顶层）或机器 id（小写字母数字与中划线，${SHARED_SEGMENT} 为保留字）`)
}

/**
 * 机器 id 校验：只认 MACHINE_ID_RE，保留字 shared 必拒。
 *
 * 与 assertScopeValue 是两个值域而不是一个：scope 含保留字 shared（它要能表达「共享段」），
 * 机器 id 不含。凡是要的是机器身份（config.machine、注入的 machine、离线自检的第二个实参）
 * 都走这一个入口——借 assertScopeValue 顺带校验会把 shared 放行成机器名，本机段与共享段
 * 于是落进同一个目录，症状是注入块里同一段内容出现两遍、对机段整段漏装，而不是报错。
 */
export function assertMachineId(machine) {
	if (typeof machine === 'string' && MACHINE_ID_RE.test(machine)) return
	throw new Error(`未知机器 id「${machine ?? ''}」：值＝小写字母数字起头、只含小写字母数字与中划线，${SHARED_SEGMENT} 是保留字不可作机器名`)
}

/**
 * 段路由：shared → store 顶层；机器 id → store/machines/<id>/。
 * 读侧组装注入块与写侧定落点问同一份：段位置写成两套映射，读侧装出来的段与写侧写进去的
 * 段迟早对不上，而那症状是「条目写进去了但注不进来」，比报错更难查。
 *
 * 入参是 resolveRoot 的产物而不是记忆根串：归一只发生一次，各调用方拿同一份产物，
 * 而不是各自重算一遍根再拼子目录。
 *
 * 段值域在这里守而不是只在参数面守：config.machine 与全形式 file_path 都到得了这儿，
 * 它们不过参数面的 schema；值域留一个入口，`..` 这类输入就有缝可钻。
 */
export function resolveScopeDir(root, scope) {
	assertScopeValue(scope)
	return scope === SHARED_SEGMENT ? root.store : join(root.store, MACHINES_DIR, scope)
}

/**
 * machines/ 下的机器段目录名：预取的 withFileTypes 列表 → 目录名数组（按码元排序）。
 * 段清点（segments.js）与注入指纹（assemble.js）各拼一遍时，后续任一处加过滤条件
 * （如跳过符号链接）两处就分家，症状是「注入漏了一段、体检还在扫它」。
 *
 * 入参是预取的目录项而不是 store 路径：读不动的策略两侧不同（清点要把 ENOTDIR 抛给体检
 * 认领，指纹按空清单算），而 core.js 是零 node:fs 的硬边界——I/O 与错误策略都留在调用方。
 */
export function machineSegmentNames(entries) {
	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * 失控保护上限（字符，非字节；中文按字符计）。
 * 仅防单文件疯长静默吃上下文的病态路径；日常不设上限，治理靠用户定期收敛。
 * 块级总量无上限（至多规则文件加两个段，各自有截断标注兜底，README 已披露）。
 */
export const RUNAWAY_CEILING = 65536

/**
 * 索引注入预算：索引常驻每装配，超预算时截断并显式标注，逼收敛而不是静默吃上下文
 * （条目文件不走此预算，仍只有失控保护）。行/字符双限，任一超限即截断。
 * 逐段施加（每段各一份预算，合计无上限）。实测与余量不要抄进注释——那是最容易陈旧的
 * 数字；跑验收段那条带参 `npm run check:memory -- <记忆根> <机器id>` 看当前数。
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
 * 与前三重的根本差别是运行期**不截**——composeMemory 只逐段施加前三重；截整块会连写侧
 * 纪律一起截掉，规则被静默丢掉比超预算更难查，所以这一重只判红，由
 * scripts/check-memory-index.mjs 离线做。
 *
 * 两重不是两条互相竞争的线，是一声先一声后：段线在运行期就截，撞上当场可见（段内那条标注
 * 与块尾那句总结都出自 applyIndexBudget 的 cuts），先响；块线只由离线自检判红，后响。语料
 * 真的把两段都顶满，那是「该收敛了」这个状态本身，不是两条线打架——所以别拿「块线还远」
 * 当压住段线的理由。届时段各截到自己的线上后块仍可越过块线（段线之和加写侧纪律本来就
 * 大于它），运行期对这个越线不设信号——块尾那句只报段截断，整块判红归 check:memory。
 *
 * 定档按「还能装几条新条目」而不是百分比：条目派生行长度随 title 浮动，百分比定的线在
 * 语料一变就名不副名（早先那条线按旧语料定，语料长起来后余量连一条新条目都装不下，等于
 * 每次写记忆都要抬线——那不叫治理线）。换算式＝**实测块字符数 ＋ N 条×实测条目派生行均长**，
 * N 取你打算让这条线再装几条，向下取整；实测数不进本注释（它是最容易陈旧的那类数字），
 * 改它之前先跑上面那条 check:memory 命令看当前定档与实测，再拿那两个数换算。
 */
export const BLOCK_CHAR_BUDGET = 7300

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
 * 面：块尾总结取 truncated/cutLabel，段内标注取 keptLabel；keptLines/keptChars/cuts 主要
 * 给测试与诊断直读——从 text 里反解这些等于拿渲染文案当数据面。
 *
 * 截断口径单源就在这个函数里：段内那条标注用 keptLabel（只说装进去多少），块尾那句总结用
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
		text: `${out}\n\n…（索引超预算截断：原文 ${lines.length} 行/${text.length} 字符，仅注入前 ${keptLabel}——跑 npm run check:memory -- <记忆根> <机器id> 定位收敛）\n`,
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
