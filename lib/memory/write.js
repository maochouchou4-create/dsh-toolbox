/**
 * dsh-memory 写侧（memory 工具的核心实现）：条目增删改＋体检。
 *
 * 设计：索引行不是数据，是条目 frontmatter 的派生视图——不落盘、不手写。写侧因此
 * 只写条目文件本身：先校验 frontmatter 契约（恰好 title＋description 两键），再把
 * 这一轮将出现在注入里的那一行原样回给调用方核对。目录里那份无锁读改写的 MEMORY.md
 * 随之消失，一整类并发丢写竞态是没了文件而不是被堵上。
 * 拦截类问题（frontmatter 契约／文件名／层／桶／失控保护／同名）直接 throw；
 * 风格类问题（日期戳、派生行超长）进 warnings 提示不拦截。
 *
 * I/O 分两路，是取舍不是遗漏。写入侧（upsert/edit）走注入的 fs 端口（fs-port.js）：
 * 生产接宿主 ctx.fs（连带会话文件策略、原子发布与中断信号），测试接 node:fs 替身，
 * 故两函数是 async；端口同时是会话策略的唯一问口（assertWritable），所以写侧不必
 * 认识 SandboxPolicy。读侧（composeMemory）与体检、删除两族留在 node:fs：宿主沙箱
 * 只围栏 writeText/editText，读与列目录本就不受策略约束，走端口只是白付 async
 * 成本；删除族则因宿主 fs 契约没有删除能力而无处可去——但它仍接端口问一句能不能写。
 *
 * 已知未解：旧工具偶发抛「oldString 不能为空」（同一 payload 重试即过，实测复现过
 * 两次）。本文件对非空串的校验没有竞态面——那条错只可能由入参本身为空触发，
 * 而重试即过说明入参在两次调用间并不相同。据此无法在本文件内定位根因，不猜。
 * 规避姿势：撞到该错原样重试一次；重试仍报再 read 条目核对 payload 是不是被中途改写。
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
	DEFAULT_MEMORY_ROOT,
	INDEX_CHAR_BUDGET,
	INDEX_LINE_BUDGET,
	INDEX_LINE_CHAR_BUDGET,
	RUNAWAY_CEILING,
	describeError,
	resolveRoot,
	workspaceSlug,
} from './core.js'
import { RESERVED_FILES, RESERVED_STEMS, assertEntryFrontmatter, deriveIndexLine, isEntryName, isReservedFile, parseFrontmatter } from './frontmatter.js'

/** WRITING.md：不写日期戳（时序归 git）——风格告警用。 */
const DATE_RE = /\d{4}-\d{2}-\d{2}/

/** wikilink 提取（`[[stem]]`／`[[stem|别名]]`／`[[stem#锚]]` 取 stem）。 */
const WIKILINK_RE = /\[\[([^\]|#]+)/g

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

/** 层路由：habit → 习惯层目录；workspace → 按 cwd 归化的工作层桶（缺 cwd 报错，防误写错层）。 */
export function resolveLayerDir({ memoryRoot, layer, cwd }) {
	const root = resolveRoot(memoryRoot ?? DEFAULT_MEMORY_ROOT)
	if (layer === 'habit') return root.profile
	if (layer === 'workspace') {
		if (typeof cwd !== 'string' || cwd.length === 0) {
			throw new Error('工作层需要会话 cwd；无会话上下文时只能写习惯层')
		}
		const slug = workspaceSlug(cwd)
		if (slug.length === 0) throw new Error(`cwd 归化桶名为空：${cwd}`)
		return join(root.workspaces, slug)
	}
	throw new Error(`未知层 "${layer}"（habit | workspace）`)
}

/**
 * 端口 stat 的判定收口：「在」不等于「是文件」。同名目录撞上条目名时，
 * 不许它一路走到某次读写才炸成后端原生的英文错误（宿主口径 FS_NOT_REGULAR_FILE）。
 */
function assertRegularFile(observed, path) {
	if (observed.kind === 'present' && observed.type !== 'file') {
		throw codedError(`路径不是普通文件（${observed.type}）：${path}——记忆条目只能是文件`, 'FS_NOT_REGULAR_FILE')
	}
}

/** 宿主词表里的失败要带 code：裸 Error 拿不到，harness 的 toolErrorResult 与模型都看不见类型。 */
function codedError(message, code) {
	const error = new Error(message)
	error.code = code
	return error
}

/** 两层全部在场目录（habit + 各工作桶）；delete 的引用清扫与 lint 的体检共用。 */
function listLayerDirs(root) {
	const dirs = []
	if (existsSync(root.profile)) dirs.push({ kind: 'habit', dir: root.profile })
	if (existsSync(root.workspaces)) {
		for (const entry of readdirSync(root.workspaces, { withFileTypes: true })) {
			if (entry.isDirectory()) dirs.push({ kind: `workspace:${entry.name}`, dir: join(root.workspaces, entry.name) })
		}
	}
	return dirs
}

/** 全库已知条目 stem 集（wikilink 判死链用；含保留 stem，不误报）。 */
function knownStems(layerDirs) {
	const stems = new Set(RESERVED_STEMS)
	for (const { dir } of layerDirs) {
		for (const name of readdirSync(dir)) {
			if (name.endsWith('.md')) stems.add(name.replace(/\.md$/, ''))
		}
	}
	return stems
}

/** 风格类提示（不拦截）：日期戳、派生行超长。 */
function entryWarnings({ description, indexLine }) {
	const warnings = []
	if (DATE_RE.test(description)) warnings.push('description 含日期戳（WRITING.md：不写日期戳，时序归 git）')
	if (indexLine.length > INDEX_LINE_CHAR_BUDGET) {
		warnings.push(`派生索引行 ${indexLine.length} 字符超 ${INDEX_LINE_CHAR_BUDGET}——收敛 description（整行上限即 description 上限的推论）`)
	}
	return warnings
}

/**
 * 层内同名拦截：派生行以 title 为准，两个文件共用一个 title 会让注入块里的两行
 * 无法区分（链接目标仍各自正确，所以这只是可读性问题，但索引行是人读的那一层）。
 * 必须在写盘前查完——拦截类承诺「不落盘」，先写后查会留下要人工收拾的重名对。
 *
 * 逐条整篇读是这份检查的代价：端口没有「只读文件头」的原语，为它加一个就要动刚
 * 定档的端口契约，而一次写入才发生一次（工作层整层约 145K 字符，页缓存内几毫秒）。
 * 宁可每次写多读一遍，也不为省这点 I/O 把契约撑大。
 *
 * 同层条目 frontmatter 不合规时不当作「无同名」：那个条目的 title 不可知，无从证明
 * 新 title 是空的，按 Parse, don't validate 就得报出来而不是放行——否则撞名条目躲在
 * 坏条目后面就再也拦不住。
 */
async function assertTitleFree({ port, dir, title, file, signal }) {
	const dirTarget = await port.resolve(dir)
	if ((await port.stat(dirTarget, signal)).kind !== 'present') return
	for (const entry of await port.listDir(dirTarget, signal)) {
		if (entry.type !== 'file' || !isEntryName(entry.name) || entry.name === file) continue
		const parsed = parseFrontmatter(await port.readText(await port.resolve(join(dir, entry.name)), signal))
		if (!parsed.ok) {
			throw new Error(`同层条目「${entry.name}」的 frontmatter 不合规（${parsed.error}），同名判定不可信——先修好它再写`)
		}
		if (parsed.frontmatter.title === title) {
			throw new Error(`层内已有同名条目「${title}」（${entry.name}）——先 delete 再改名`)
		}
	}
}

/**
 * 写条目（upsert）：校验 frontmatter 契约 → 派生索引行 → 同名拦截 → 落盘。
 * 拦截：非 kebab 文件名、content 空/超失控保护、frontmatter 缺失或越界
 * （缺键/空值/第三键/title 带方括号/多行折行）、层内同名、会话策略不许写
 * （问端口，不自己认 SandboxPolicy）。
 * 提示（warnings）：description 含日期戳、派生索引行超长。
 * 版本守卫：调用方传入 entryVersion 时照该版本写（editEntry 读条目时透传），
 * 期间被别人改过即抛错。write 缺省不护——它的语义是「以我这份为准」，
 * 并发两次 write 谁后到谁赢属调用方自己的选择。
 */
export async function upsertEntry({ port, memoryRoot, cwd, layer, file, content, entryVersion, signal }) {
	assertEntryFile(file)
	port.assertWritable()
	if (typeof content !== 'string' || content.trim().length === 0) throw new Error('content 不能为空')
	if (content.length > RUNAWAY_CEILING) {
		throw new Error(`content ${content.length} 字符超失控保护 ${RUNAWAY_CEILING}——先收敛再写（拆条目或精简）`)
	}
	const { title, description } = assertEntryFrontmatter(content, file)
	const indexLine = deriveIndexLine({ title, description, file })
	const dir = resolveLayerDir({ memoryRoot, layer, cwd })
	await assertTitleFree({ port, dir, title, file, signal })
	const guard = entryVersion === undefined ? undefined : { kind: 'replaceIfVersion', version: entryVersion }
	await port.writeText(await port.resolve(join(dir, file)), content.endsWith('\n') ? content : `${content}\n`, guard, signal)
	return { layer, dir, file, indexLine, warnings: entryWarnings({ description, indexLine }) }
}

/**
 * 改条目（外科手术式替换）：对现存正文做字面 old→new 替换后整文落盘，索引行按改完的
 * frontmatter 重算（内容是数据、索引行是派生，天然跟着走）。
 * 提供 edit 而非只有 write 的原因：改几行就全文重发是纯传输成本（输出 token 按整条计），
 * 且重抄不变段落本身有引入漂移的风险；校验不降级——替换结果走 upsert 同一条拦截链
 * （frontmatter 契约/空文/失控保护/同名）。
 * 契约：oldString 字面精确匹配（不命中即拦——提醒先 read 再改；多处命中未声明
 * replaceAll 即拦防误伤）；newString 按字面写入，其中的模式符号（$$、$&、$'、$`）
 * 一律不解释——正文写正则笔记时不会被展开成匹配前后文；正文入口把 \r\n 归一为 \n（git checkout 的 CRLF 形态下
 * 跨行 oldString 才可达，落盘统一 LF）；尾部空行原样保留（upsert 只补一个 \n，
 * 多出的尾空行是作者形态，替换不该动它）。
 * 正文落盘带版本守卫：读条目时观察到的版本透传给 upsert 的 entryVersion，于是并发
 * 两次 edit 同一条目时后者抛 FS_STALE_VERSION，而不是静默吃掉前者刚落的正文还
 * 报成功（readText 与 replaceIfVersion 之间那段窗口正是竞态所在）。
 * 替换先在内存里算完再交 upsert 落盘：编辑后空文、失控保护、frontmatter 契约这些
 * 拦截必须发生在写盘之前，先写后验会留下半截改动。
 */
export async function editEntry({ port, memoryRoot, cwd, layer, file, oldString, newString, replaceAll, signal }) {
	assertEntryFile(file)
	port.assertWritable()
	if (typeof oldString !== 'string' || oldString.length === 0) {
		throw new Error('oldString 不能为空（字面精确匹配的原文片段；命中不了就 read 条目现文再改）')
	}
	if (typeof newString !== 'string') throw new Error('newString 必须为字符串（删除内容传空串）')
	if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
		throw new Error(`replaceAll 须为布尔（多处命中全换开关），收到 ${typeof replaceAll} 类型`)
	}
	const dir = resolveLayerDir({ memoryRoot, layer, cwd })
	const entryPath = join(dir, file)
	const entryTarget = await port.resolve(entryPath)
	const entryObserved = await port.stat(entryTarget, signal)
	assertRegularFile(entryObserved, entryPath)
	if (entryObserved.kind !== 'present') throw new Error(`条目不存在：${entryPath}`)
	const normalized = (await port.readText(entryTarget, signal)).replace(/\r\n/g, '\n')
	const tail = /\n+$/.exec(normalized)?.[0] ?? ''
	const body = normalized.slice(0, normalized.length - tail.length)
	const hits = body.split(oldString).length - 1
	if (hits === 0) throw new Error('oldString 在正文中未命中——先 read 条目现文再改，勿凭印象')
	if (hits > 1 && !replaceAll) throw new Error(`oldString 命中 ${hits} 处——收窄 oldString 或显式 replaceAll`)
	// 字面替换走 split/join：String.replace 的字符串替换会解释 newString 里的 $ 模式
	// （`$` 插入匹配前文、`$'` 插入匹配后文、`$&` 插回命中段、$$ 转义），条目正文里
	// 出现 ``$` `` 这类写法（写规则类正文很常见）会被静默放大成整条内容复制。
	// 唯一命中已由上面的 hits 校验保证（多处未声明 replaceAll 即拦），故两条分支合一。
	const nextBody = body.split(oldString).join(newString)
	const nextContent = nextBody + tail
	if (nextContent.trim().length === 0) throw new Error('编辑后正文为空——整条删除走 delete')
	const result = await upsertEntry({ port, memoryRoot, cwd, layer, file, content: nextContent, entryVersion: entryObserved.version, signal })
	// replacements 报实际改动处数（newString 与 oldString 全等时命中≠改动，报 0）
	return { ...result, replacements: nextBody === body ? 0 : hits }
}

/**
 * 删条目：删正文即退场——索引行是派生的，目录里没有文件就没有这一行，别的条目正文里
 * 指向它的 [[wikilink]] 逐处报告（措辞改写需要判断力，留给调用方按报告修——
 * 机械替换会破坏行文）。
 *
 * 本路径的 I/O 有意不过宿主 fs 通道：宿主 FileSystem 契约里没有删除能力（成员全量
 * 见 dsh-fs 的抽象类定义），端口化到这里无处可去，故与 lint 族同留 node:fs。但它
 * 仍然接端口、只问一句「能不能写」——问的是策略判断，一个字的 I/O 都不经端口；
 * 四个 action 同一口径，不能因为走的是 node:fs 就让只读会话照样删掉条目。越界
 * 围栏对本路径不生效，其可查前提（本机全部会话为 danger-full-access）记在
 * fs-port.js 的模块头。signal 同理不参与：实现全同步，一次调用内无让出点。
 */
export function deleteEntry({ port, memoryRoot, cwd, layer, file }) {
	assertEntryFile(file)
	port.assertWritable()
	const dir = resolveLayerDir({ memoryRoot, layer, cwd })
	const entryPath = join(dir, file)
	if (!existsSync(entryPath)) throw new Error(`条目不存在：${entryPath}`)
	rmSync(entryPath)
	const stem = file.replace(/\.md$/, '')
	const references = []
	let scanError = ''
	try {
		for (const { dir: layerDir } of listLayerDirs(resolveRoot(memoryRoot ?? DEFAULT_MEMORY_ROOT))) {
			for (const name of readdirSync(layerDir)) {
				if (!isEntryName(name)) continue
				const lines = readFileSync(join(layerDir, name), 'utf8').split('\n')
				for (let i = 0; i < lines.length; i += 1) {
					// 与 lint 同口径：WIKILINK_RE 提取 stem 后全等比较（前缀子串会把 [[toolkit]] 误报成对 tool 的引用）
					for (const match of lines[i].matchAll(WIKILINK_RE)) {
						if (match[1].trim() === stem) references.push(`${join(layerDir, name)}:${i + 1}`)
					}
				}
			}
		}
	} catch (error) {
		// 主操作（删文）已成功；引用扫描是附属报告，失败降级不回滚不整崩
		scanError = `引用扫描失败：${describeError(error)}`
	}
	return { layer, dir, file, references, scanError }
}

/**
 * 体检：条目 frontmatter 契约（缺/多余键）、description 日期戳与派生行超长、
 * 派生索引超预算、条目超失控保护、wikilink 死链、接线（习惯层目录、当前 cwd 桶）。
 * 索引是派生的，故没有「死索引行」「孤儿条目」两类检查：每个 .md 天生在场。
 * 返回 { ok, warnings[] }；warnings 为空＝健康。单个文件/目录读不动时逐处降级
 * 报 warning 继续——体检自身不许崩（病态输入只该损失覆盖面，不该停摆整盘）。
 */
export function lintMemory({ memoryRoot, cwd } = {}) {
	const root = resolveRoot(memoryRoot ?? DEFAULT_MEMORY_ROOT)
	const warnings = []
	if (!existsSync(root.profile)) warnings.push(`习惯层接线缺失：${root.profile} 不存在（接线见 README）`)
	let layerDirs
	try {
		layerDirs = listLayerDirs(root)
	} catch (error) {
		warnings.push(`层清点失败（体检中止）：${describeError(error)}`)
		return { ok: false, warnings }
	}
	let stems
	try {
		stems = knownStems(layerDirs)
	} catch (error) {
		stems = new Set(RESERVED_STEMS)
		warnings.push(`条目清点失败，死链判定降级：${describeError(error)}`)
	}
	for (const { kind, dir } of layerDirs) {
		let names
		try {
			// 保留文件不是条目：既不派生索引行，也不受 frontmatter 契约与失控保护约束
			names = readdirSync(dir).filter(isEntryName)
		} catch (error) {
			warnings.push(`${kind}：目录读取失败——${dir}（${describeError(error)}）`)
			continue
		}
		const indexLines = []
		for (const name of names) {
			let text
			try {
				text = readFileSync(join(dir, name), 'utf8')
			} catch (error) {
				warnings.push(`${kind}：条目读取失败——${name}（${describeError(error)}）`)
				continue
			}
			// CRLF 归一收在 parseFrontmatter 内的单点；这里量的是解析结果，不是原始字节
			const parsed = parseFrontmatter(text)
			if (!parsed.ok) {
				warnings.push(`${kind}：条目 frontmatter 不合规（该条目不进索引）——${name}（${parsed.error}）`)
			} else {
				const indexLine = deriveIndexLine({ ...parsed.frontmatter, file: name })
				indexLines.push(indexLine)
				if (DATE_RE.test(parsed.frontmatter.description)) warnings.push(`${kind}：description 含日期戳——${name}`)
				if (indexLine.length > INDEX_LINE_CHAR_BUDGET) {
					warnings.push(`${kind}：派生索引行 ${indexLine.length} 字符超 ${INDEX_LINE_CHAR_BUDGET}——${name}`)
				}
			}
			if (text.length > RUNAWAY_CEILING) warnings.push(`${kind}：条目超失控保护（写侧拦新增，存量请收敛）——${name}`)
			for (const match of text.matchAll(WIKILINK_RE)) {
				const stem = match[1].trim()
				if (stem.length > 0 && !stems.has(stem)) warnings.push(`${kind}：死 wikilink [[${stem}]]——${name}`)
			}
		}
		const indexText = indexLines.join('\n')
		if (indexLines.length > INDEX_LINE_BUDGET || indexText.length > INDEX_CHAR_BUDGET) {
			warnings.push(`${kind}：派生索引超预算（${indexLines.length} 行/${indexText.length} 字符，注入会被截断）`)
		}
	}
	if (typeof cwd === 'string' && cwd.length > 0) {
		const slug = workspaceSlug(cwd)
		if (slug.length > 0 && !existsSync(join(root.workspaces, slug))) {
			warnings.push(`当前工作区尚无桶（${slug}）——新工作区常态；首次 write 自动建桶`)
		}
	}
	return { ok: warnings.length === 0, warnings }
}
