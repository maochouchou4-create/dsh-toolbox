/**
 * dsh-memory 写侧（memory 工具的核心实现）：条目增删改＋体检。
 *
 * 设计：增删改一律「条目文件＋索引行」同批同步更新（两文件先后写、非跨文件
 * 事务——条目先写、索引随后，方向取「索引写坏不脏正文」），配结构化校验，
 * 消灭裸编辑漂移（错桶名、自拟格式、索引塞事实、删条目留死链——都是纯手写
 * 时代实证翻过的车）。拦截类问题（文件名/链接一致/失控保护）直接 throw；
 * 风格类问题（日期戳、触发器尾注）进 warnings 提示不拦截。目录约定与读侧共用
 * core.js 的同一事实源。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	DEFAULT_MEMORY_ROOT,
	INDEX_CHAR_BUDGET,
	INDEX_LINE_BUDGET,
	RUNAWAY_CEILING,
	resolveRoot,
	workspaceSlug,
} from './core.js'

/** 条目行（索引里的）：`- [标题](file.md) — 其余`；非条目行返回 null。 */
const INDEX_LINE_RE = /^\s*[-*]\s+\[([^\]]+)\]\(([^()\s]+\.md)\)\s*(.*)$/
export function parseIndexLine(line) {
	if (typeof line !== 'string') return null
	// CRLF 容忍收在此单点：git checkout 产出的索引行带 \r 尾，而 `$` 不认 \r 前的行尾、
	// `.` 也不吃 \r——不剥会把整行解析成 null，edit（必须命中否则报错）硬失败、
	// delete/lint 漏报假阳性，三处同根因不各设特判
	const m = INDEX_LINE_RE.exec(line.endsWith('\r') ? line.slice(0, -1) : line)
	if (!m) return null
	return { title: m[1], file: m[2], rest: m[3] }
}

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
	if (file === 'memory.md' || file === 'writing.md') {
		throw new Error(`"${file}" 是保留名（MEMORY.md/WRITING.md 不可作条目）`)
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

/** 全库已知条目 stem 集（wikilink 判死链用；含 MEMORY/WRITING 保留 stem，不误报）。 */
function knownStems(layerDirs) {
	const stems = new Set(['MEMORY', 'WRITING'])
	for (const { dir } of layerDirs) {
		for (const name of readdirSync(dir)) {
			if (name.endsWith('.md')) stems.add(name.replace(/\.md$/, ''))
		}
	}
	return stems
}

/**
 * 写条目（upsert）：先写条目正文（事实源），再同步索引行。
 * 拦截：非 kebab 文件名、content 空/超失控保护、indexLine 非链接行或链错文件。
 * 提示（warnings）：索引行含日期戳、缺「→查此条」触发式尾注。
 */
export function upsertEntry({ memoryRoot, cwd, layer, file, content, indexLine }) {
	assertEntryFile(file)
	if (typeof content !== 'string' || content.trim().length === 0) throw new Error('content 不能为空')
	if (content.length > RUNAWAY_CEILING) {
		throw new Error(`content ${content.length} 字符超失控保护 ${RUNAWAY_CEILING}——先收敛再写（拆条目或精简）`)
	}
	if (typeof indexLine !== 'string' || indexLine.trim().length === 0) {
		throw new Error('indexLine 不能为空（索引行是触发器，随条目原子同步）')
	}
	const parsed = parseIndexLine(indexLine)
	if (!parsed) throw new Error(`indexLine 须为列表链接行「- [标题](${file}) — **触发词→查此条**」，收到：${indexLine}`)
	if (parsed.file !== file) throw new Error(`indexLine 链接目标 ${parsed.file} 与条目文件 ${file} 不一致`)
	const warnings = []
	if (DATE_RE.test(indexLine)) warnings.push('索引行含日期戳（WRITING.md：不写日期戳，时序归 git）')
	if (!indexLine.includes('查此条')) warnings.push('索引行缺「→查此条」触发式尾注（建议按 WRITING.md 触发器风格）')
	const dir = resolveLayerDir({ memoryRoot, layer, cwd })
	const indexPath = join(dir, 'MEMORY.md')
	const header = layer === 'habit'
		? '# 习惯层索引（使用习惯，跨机同步）'
		: '# 工作层索引（本机专属，不跨机）'
	const raw = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : `${header}\n`
	// 同名异文件冲突必须在写盘前拦截——拦截类承诺「不落盘」，先写后查会留孤儿条目。
	for (const line of raw.split('\n')) {
		const p = parseIndexLine(line)
		if (p && p.title === parsed.title && p.file !== file) {
			throw new Error(`索引已有同名条目「${parsed.title}」链到 ${p.file}——先 delete 再改名`)
		}
	}
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, file), content.endsWith('\n') ? content : `${content}\n`, 'utf8')
	const kept = []
	let indexAction = 'added'
	for (const line of raw.split('\n')) {
		const p = parseIndexLine(line)
		if (p && p.file === file) {
			kept.push(indexLine)
			indexAction = 'replaced'
		} else {
			kept.push(line)
		}
	}
	if (indexAction === 'added') {
		while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
		kept.push('', indexLine)
	}
	writeFileSync(indexPath, `${kept.join('\n').replace(/\n*$/, '')}\n`, 'utf8')
	return { layer, dir, file, indexPath, indexAction, warnings }
}

/**
 * 从 MEMORY.md 现索引里取该条目的行（edit 缺省沿用）；无索引行返回空串＝孤儿。
 */
function findIndexLine(dir, file) {
	const indexPath = join(dir, 'MEMORY.md')
	if (!existsSync(indexPath)) return ''
	for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
		const p = parseIndexLine(line)
		if (p && p.file === file) return line.trim()
	}
	return ''
}

/**
 * 改条目（外科手术式替换）：对现存正文做字面 old→new 替换后整文落盘，索引行可选同笔换。
 * 提供 edit 而非只有 write 的原因：改几行就全文重发是纯传输成本（输出 token 按整条计），
 * 且重抄不变段落本身有引入漂移的风险；校验不降级——替换结果走 upsert 同一条拦截链
 * （空文/失控保护/索引一致）。
 * 契约：oldString 字面精确匹配（不命中即拦——提醒先 read 再改；多处命中未声明
 * replaceAll 即拦防误伤）；newString 按字面写入，其中的模式符号（$$、$&、$'、$`）
 * 一律不解释——正文写正则笔记时不会被展开成匹配前后文；正文入口把 \r\n 归一为 \n（git checkout 的 CRLF 形态下
 * 跨行 oldString 才可达，落盘统一 LF）；尾部空行原样保留（upsert 只补一个 \n，
 * 多出的尾空行是作者形态，替换不该动它）；indexLine 缺省（undefined/null）＝沿用
 * 现索引行且 indexAction 报 kept，显式传字符串＝同笔校验替换（空串在 upsert 拦）。
 */
export function editEntry({ memoryRoot, cwd, layer, file, oldString, newString, indexLine, replaceAll }) {
	assertEntryFile(file)
	if (typeof oldString !== 'string' || oldString.length === 0) throw new Error('oldString 不能为空')
	if (typeof newString !== 'string') throw new Error('newString 必须为字符串（删除内容传空串）')
	if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
		throw new Error(`replaceAll 须为布尔（多处命中全换开关），收到 ${typeof replaceAll} 类型`)
	}
	const dir = resolveLayerDir({ memoryRoot, layer, cwd })
	const entryPath = join(dir, file)
	if (!existsSync(entryPath)) throw new Error(`条目不存在：${entryPath}`)
	const normalized = readFileSync(entryPath, 'utf8').replace(/\r\n/g, '\n')
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
	const keepIndexLine = typeof indexLine !== 'string'
	const resolvedIndexLine = keepIndexLine ? findIndexLine(dir, file) : indexLine
	// 孤儿判定只管「缺省沿用而索引里没有」；显式传的字符串（含空串）直送 upsert
	// 在同一拦截点报「indexLine 不能为空」——两个 action 对同类输入同脾气
	if (keepIndexLine && !resolvedIndexLine) throw new Error('该条目无索引行（孤儿）——用 write 重建，或 edit 附带 indexLine')
	const result = upsertEntry({ memoryRoot, cwd, layer, file, content: nextContent, indexLine: resolvedIndexLine })
	// 缺省沿用＝语义上未动（渲染不得谎报「已同步」）；replacements 报实际改动处数
	// （newString 与 oldString 全等时命中≠改动，报 0）
	if (keepIndexLine && result.indexAction === 'replaced') result.indexAction = 'kept'
	return { ...result, replacements: nextBody === body ? 0 : hits }
}

/**
 * 删条目：删正文＋清索引行；其余条目正文里指向它的 [[wikilink]] 逐处报告
 * （措辞改写需要判断力，留给调用方按报告修——机械替换会破坏行文）。
 */
export function deleteEntry({ memoryRoot, cwd, layer, file }) {
	assertEntryFile(file)
	const dir = resolveLayerDir({ memoryRoot, layer, cwd })
	const entryPath = join(dir, file)
	if (!existsSync(entryPath)) throw new Error(`条目不存在：${entryPath}`)
	rmSync(entryPath)
	const indexPath = join(dir, 'MEMORY.md')
	let indexRemoved = false
	if (existsSync(indexPath)) {
		const kept = []
		for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
			const p = parseIndexLine(line)
			if (p && p.file === file) {
				indexRemoved = true
				continue
			}
			kept.push(line)
		}
		writeFileSync(indexPath, `${kept.join('\n').replace(/\n*$/, '')}\n`, 'utf8')
	}
	const stem = file.replace(/\.md$/, '')
	const references = []
	let scanError = ''
	try {
		for (const { dir: layerDir } of listLayerDirs(resolveRoot(memoryRoot ?? DEFAULT_MEMORY_ROOT))) {
			for (const name of readdirSync(layerDir)) {
				if (!name.endsWith('.md') || name === 'MEMORY.md' || name === 'WRITING.md') continue
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
		// 主操作（删文＋清索引）已成功；引用扫描是附属报告，失败降级不回滚不整崩
		scanError = `引用扫描失败：${error instanceof Error ? error.message : String(error)}`
	}
	return { layer, dir, file, indexPath, indexRemoved, references, scanError }
}

/**
 * 体检：死索引行（链的文件不在）、孤儿条目（无索引行）、死 wikilink、
 * 索引超预算、条目超失控保护、索引行日期戳、接线（习惯层目录、当前 cwd 桶）。
 * 返回 { ok, warnings[] }；warnings 为空＝健康。单个文件/目录读不动时逐处降级
 * 报 warning 继续——体检自身不许崩（病态输入只该损失覆盖面，不该停摆整盘）。
 */
const describeError = (error) => (error instanceof Error ? error.message : String(error))

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
		stems = new Set(['MEMORY', 'WRITING'])
		warnings.push(`条目清点失败，死链判定降级：${describeError(error)}`)
	}
	for (const { kind, dir } of layerDirs) {
		let names
		try {
			names = readdirSync(dir).filter((name) => name.endsWith('.md'))
		} catch (error) {
			warnings.push(`${kind}：目录读取失败——${dir}（${describeError(error)}）`)
			continue
		}
		if (!names.includes('MEMORY.md')) {
			if (names.some((name) => name !== 'WRITING.md')) warnings.push(`${kind}：缺 MEMORY.md（有条目无索引）`)
			continue
		}
		const indexPath = join(dir, 'MEMORY.md')
		let indexText
		try {
			indexText = readFileSync(indexPath, 'utf8')
		} catch (error) {
			warnings.push(`${kind}：索引读取失败——${indexPath}（${describeError(error)}）`)
			continue
		}
		// 计行前剥尾换行：upsert 产物必带尾 \n，不剥则恰 200 行被误判超预算
		const lineCount = indexText.replace(/\n$/, '').split('\n').length
		if (lineCount > INDEX_LINE_BUDGET || indexText.length > INDEX_CHAR_BUDGET) {
			warnings.push(`${kind}：索引超预算（${lineCount} 行/${indexText.length} 字符，注入会被截断）`)
		}
		const indexed = new Set()
		for (const line of indexText.split('\n')) {
			const p = parseIndexLine(line)
			if (!p) continue
			indexed.add(p.file)
			if (!names.includes(p.file)) warnings.push(`${kind}：死索引行——${p.file} 不存在`)
			if (DATE_RE.test(line)) warnings.push(`${kind}：索引行含日期戳——${p.file}`)
		}
		for (const name of names) {
			if (name === 'MEMORY.md' || name === 'WRITING.md') continue
			if (!indexed.has(name)) warnings.push(`${kind}：孤儿条目（无索引行）——${name}`)
		}
		for (const name of names) {
			if (name === 'MEMORY.md') continue
			let text
			try {
				text = readFileSync(join(dir, name), 'utf8')
			} catch (error) {
				warnings.push(`${kind}：条目读取失败——${name}（${describeError(error)}）`)
				continue
			}
			if (name !== 'WRITING.md' && text.length > RUNAWAY_CEILING) {
				warnings.push(`${kind}：条目超失控保护（写侧拦新增，存量请收敛）——${name}`)
			}
			for (const match of text.matchAll(WIKILINK_RE)) {
				const stem = match[1].trim()
				if (stem.length > 0 && !stems.has(stem)) warnings.push(`${kind}：死 wikilink [[${stem}]]——${name}`)
			}
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
