/**
 * 批次台账（dispatch_batch）的逻辑面：事件构造、集合式状态推导、台账读写、dispatch 的批次
 * 回填与展示文本。工具装配在 ../index.js——本文件连 defineTool 都不 import，因此能被
 * node:test 直接加载，接线单测动态 import 它时也不会撞宿主包。
 *
 * I/O 一律经注入的 fs 端口（../fs-port.js），与 memory 写侧同一条通道：会话文件策略、原子发布
 * 与版本守卫都在那一层，本文件零 node:fs 直连（定性表登记＝false，见 test/imports.test.js）。
 * 端口逐次由调用方构造传入，同 memory 写侧——端口绑在注册期会把不同会话的策略串味。
 *
 * 状态永远从事件现推：不存状态文件、不另设缓存。台账是唯一真相，另存一份「当前状态」就是
 * 两份真相，不一致时没人说得清哪份对；而跨机合并出来的追加行天然乱序（union merge 只保行
 * 不丢行），任何按行序累加出来的状态在这种输入上都会漂——推导因此必须是集合式的，
 * 连「取最后一条 note」这种事都按事件时间取，不按它在文件里的位置取。
 *
 * 数据面按动作各取自己那几份（loadTables({names})）：本文件不假设拿到了五份，五份齐的那条
 * 读法是 dispatch 工具的事。
 *
 * 写侧前提（与 memory 写侧同一条）：台账落在 store 下的 data/，而两机的 store 都在
 * agent-data 仓内、各自常用工作区之内——常规会话的围栏覆盖不到它，写台账不额外要求
 * 全权；只有记忆根真的落在会话工作区之外时，workspace-write 会话才须放宽到记忆根，
 * 与 memory 写工具是同一个前提，不是本工具多要的一份权限。
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createHostFsPort } from '../fs-port.js'
import { resolveRoot } from '../memory-root.js'
import { isNonBlankString } from '../value.js'
import { COMMIT_KIND, GATE_COLUMN_BY_LABEL, BACKFILL_EXCLUDE, BACKFILL_FIELDS, SUBJECT_PLACEHOLDER, consumedParams, mainBatchTypes, stageVocabulary } from './core.js'
import { readDataBytes } from './data.js'

/** 四个动作的词表：工具描述、参数面与未知动作报错共用这一份（三处各抄一份就会有一份说谎）。 */
export const BATCH_ACTIONS = ['start', 'advance', 'status', 'list']

/**
 * 「这次渲染拿不到推导输入」这一类错误：结构化值既没有 events 也没有 rows，而没有任何 action
 * 会产出那种值——它标的是内部不变量被破坏，不是给调用方的用法错误，所以单列成一个类型，
 * 免得跟「数据面坏了」「批次没登记」那类真错误混在同一句堆里。
 */
export class RenderModelMissingError extends Error {
	constructor(message) {
		super(message)
		this.name = 'RenderModelMissingError'
	}
}

/** 台账文件名；它在 store 下的位置固定（store＝两机 git 同步的那一处，台账跟着它才叫共享）。 */
const LEDGER_NAME = 'dispatch-ledger.jsonl'

/**
 * rules 指纹取这两份规则面的原始字节，顺序固定（pairing 在前）：换序＝换指纹，顺序是契约的
 * 一部分而不是实现细节。取这两份是因为它们决定「派谁、怎么套 brief」；模板与 lifecycle 改
 * 动同样会改变出稿内容——指纹只标定「配对与形态这两张表是哪个版本」，跨版本不混算是复盘统计
 * 的口径要求，取全五份会把每次模板微调都变成一次版本跳变。
 */
const RULE_FILES = ['pairing.json', 'forms.json']

/**
 * 坏行报错里回显的那一截：够认出是哪种坏行，又不至于把整份台账的一行塞进报错（80 字符为初始标定）。
 */
const BAD_LINE_SAMPLE = 80

/** 「给没给」的判据（值层面）：非空白字符串与非空数组才算给了（与 core 的槽位判据同一件事，不另立一套）。 */
const isGiven = (value) => (Array.isArray(value) ? value.length > 0 : isNonBlankString(value))

/** 显式口径（键层面）：键在参数里就算传了，哪怕值是空的——传空与不传是两件事，见 backfillFromBatch。 */
const isExplicit = (params, field) => Object.hasOwn(params, field) && params[field] !== undefined && params[field] !== null

/**
 * 时间序按绝对时刻比（Date.parse），不按 ISO 串的码位：事件时间带 ±HH:MM 偏移，两台机器写的
 * 同一时刻可能是两种写法，串比大小会判反先后——跨机合并出来的台账正是这两种写法混在一起。
 * t 的可解析性由 parseLedger 在读面守住，这里的 NaN 不会进来。
 */
export const byTime = (left, right) => Date.parse(left.t) - Date.parse(right.t)

export const sortedByTime = (events) => [...events].sort(byTime)

/**
 * 计数取值：可选字段缺失＝零值（数字缺失作 0，与台账「0 写 0」的写侧口径对称，历史事件不必补写）。
 * 手写坏的行（值是串、负数、NaN）折成 0 参与求和——坏行本身由 parseLedger 的读面报错负责，
 * 报表这层不重复拦一道，也不该让一个坏值把整份统计变成 NaN。
 */
export const countOf = (value) => {
	const count = Number(value)
	return Number.isFinite(count) && count > 0 ? count : 0
}

/**
 * 一组事件的 findings 求和（逐事件 perFormCounts 各值之和）。批次视图与复盘统计共用这一份口径：
 * 两处各求和一次，迟早有一次改坏值策略时只改了一边，而「findings 上报 N」正是两边共用的那个数。
 */
export function sumFoundOf(events) {
	return events.reduce(
		(total, event) => total + [...normalizeFormCounts(event.perFormCounts).values()].reduce((sum, count) => sum + count, 0),
		0,
	)
}

/**
 * combo/recommended 的旧事件是空白分隔的形态 id 串，按空白切**切不干净**：形态 id 本身可以含
 * 空格（「GUI 目检」就是一个），按空白切出来的是半个 id，计数与裁剪差全错。故这里拿形态词表
 * （forms.json 的 id 全集）当词法：逐位向后取**最长**能命中词表的片段——短 id 是长 id 前缀时
 * 按短的切会切出半个 id。
 *
 * 一个已知 id 都拼不出来的那一位单独成段（不往后吞）：那多半是台账里手写的错名或已退场的形态 id，
 * 吞到下一个已知 id 会把「记账有问题」这条证据连同后面的正常 id 一起吞没。词表为空时退化为按空白切
 * 并如实按 token 计数——生产路径总是现读词表（见 lessons 的读侧），那条退化只服务于纯函数调用方，
 * 含空格的 id 在那条路上会被数成两个，这是退化路径的已知代价，不是它的承诺。
 *
 * 拆分后本函数只服务历史事件：写侧落库的是形态 id 串数组，不再需要词法切分。
 */
export function parseFormList(text, vocabulary = new Set()) {
	if (!isNonBlankString(text)) return []
	const known = vocabulary instanceof Set ? vocabulary : new Set(vocabulary)
	const tokens = text.split(/\s+/).filter((token) => token !== '')
	if (known.size === 0) return tokens
	const forms = []
	for (let index = 0; index < tokens.length; index += 1) {
		let matched = null
		for (let end = tokens.length; end > index; end -= 1) {
			const candidate = tokens.slice(index, end).join(' ')
			if (known.has(candidate)) {
				matched = candidate
				index = end - 1
				break
			}
		}
		forms.push(matched ?? tokens[index])
	}
	return forms
}

/**
 * 台账计数格（combo/recommended/perFormCounts）的读侧归一：同一格存在两种形状——拆分前的旧
 * 事件是形态 id 串（combo/recommended）或「形态 id → 数」的对象（perFormCounts），拆分后写侧
 * 落的是数组（combo＝形态 id 串数组、perFormCounts＝[{form,count}]）。统计面不想知道是哪种：
 * 归一成「形态 → 份数」的 Map，读侧每个计数点都走这一份——各点自己再写一遍形状判断，改形状
 * 时必有一处漏改，症状是统计静默零或漏记虚高，报错一个都不会有。
 *
 * 串走 parseFormList（词法切分，键＝切出的 id、各记 1 份）；数组里串条目记 1 份、{form,count}
 * 条目按 count 归一；旧对象按 Object.entries 归一。count 坏值折 0 与 countOf 同一口径：写侧的
 * requirePerFormCounts 才拦形状，读面不重复拦一道，也不该让一个坏值把整份统计变成 NaN。
 * 返回 Map 而非普通对象：键序＝出现序（渲染层还要自己定序，这里不越权），且不受原型键名污染。
 */
export function normalizeFormCounts(value, vocabulary = new Set()) {
	const counts = new Map()
	const bump = (form, count) => counts.set(form, (counts.get(form) ?? 0) + count)
	if (isNonBlankString(value)) {
		for (const form of parseFormList(value, vocabulary)) bump(form, 1)
		return counts
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			if (typeof entry === 'string') {
				bump(entry, 1)
				continue
			}
			const form = entry !== null && typeof entry === 'object' ? entry.form : undefined
			if (!isNonBlankString(form)) continue
			bump(form, countOf(entry.count))
		}
		return counts
	}
	if (typeof value === 'object' && value !== null) {
		for (const [form, count] of Object.entries(value)) bump(form, countOf(count))
	}
	return counts
}

/**
 * 台账路径：config 显式路径优先，空串按 memoryRoot 推导到 store 底目录下的 data/。推导复用
 * memory 的 resolveRoot（同一份「记忆根 → store 目录」归一，含 ~ 展开与绝对化）：store 指向
 * agent-data 仓里的记忆目录，两台机器上都是同一个，台账跟着它走才谈得上两机共享——另写一套
 * 推导等于多一份可能与写侧分家的路径口径。memoryRoot 是 memory 形状的既有键（键单源），
 * 故 dispatch 不再声明。
 */
export function resolveLedgerPath({ configuredPath, memoryRoot }) {
	if (isNonBlankString(configuredPath)) return configuredPath
	return join(resolveRoot(memoryRoot).store, 'data', LEDGER_NAME)
}

/**
 * 规则版本指纹：两份规则文件的原始字节按固定顺序拼一次 sha256，取前 8 位 hex。
 *
 * 取原始字节而不是解析后重新序列化：重排键、改缩进都会改字节，那样的指纹在两机同一份数据上
 * 算不出同一个值，而它的全部用途就是让复盘统计能按规则版本分组。前 8 位＝32 bit 是够用的初
 * 值：规则面经 git 同步，两机并存相邻两个版本的窗口只在「一台 pull 了一台没 pull」那段时间里。
 *
 * 字节由调用方给，且**必须是本趟已经读到的那一份**：另起一次 readDataBytes 读到的是另一个
 * 时刻的文件，中间改过就是另一个版本，而事件里记下「不是本次出稿所依据的那份」的版本号，
 * 比多读一次更坏（复盘会拿它把两个版本并进同一组统计）。所以 advance 取它那一趟读表顺带回
 * 来的字节，start 这趟压根没读 forms，只能现读那两份字节——它宁可为指纹多读一次，也不把
 * 「记账」与「校验形态库」绑在一起（形态库坏了不该让批次登记不了）。
 *
 * 缺哪一份当场点名：拿 undefined 去拼 Buffer 只会抛一个原生 TypeError，读不出缺的是什么。
 */
export function rulesHashOf({ bytes }) {
	if (bytes === null || typeof bytes !== 'object' || Array.isArray(bytes)) {
		throw new Error(`规则指纹：bytes 得是本趟读到的字节表（键＝文件名），实得 ${bytes === null ? 'null' : Array.isArray(bytes) ? 'array' : typeof bytes}——拿 dataDir 或文件名数组来算的是另一种入参，读到的是另一个时刻的文件`)
	}
	const missing = RULE_FILES.filter((file) => bytes[file] === undefined)
	if (missing.length > 0) {
		throw new Error(`规则指纹：这次读到的字节里没有 ${missing.join('、')}——指纹取的是本趟已读的字节（键＝文件名），另读一次拿到的是另一个时刻的文件`)
	}
	return createHash('sha256').update(Buffer.concat(RULE_FILES.map((file) => bytes[file]))).digest('hex').slice(0, 8)
}

/**
 * 事件时间＝ISO-8601 带时区，显式写 ±HH:MM 而不是 toISOString 的 Z：两机读同一份台账时，
 * UTC 记法要心算偏移才看得出先后，而排序正是推导之外的唯一读法。
 */
export function isoNow(now = new Date()) {
	const pad = (value) => String(value).padStart(2, '0')
	const offset = -now.getTimezoneOffset()
	const sign = offset >= 0 ? '+' : '-'
	const day = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join('-')
	const clock = [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join(':')
	return `${day}T${clock}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

/**
 * 台账是审计面：读的时候一行一事件逐行解析，坏行当场报错并带行号。静默跳过坏行等于让 status
 * 对着一份缺了行的世界说话，而读的人看不出来——事件缺一条，推导出来的「下一步」就跟着错。
 * 空行跳过（末行多一个换行不算一条事件）。
 *
 * 最小事件形状也在这里核：batch 与 t 是整份推导的地基（按 batch 切分、按 t 定序、算双 start
 * 取哪条），缺任一个的「合法 JSON」就不是事件，而是别的什么东西混进了台账——那行后面若还有
 * 半个对象，它同样解析不出来，而那时报错指向的是别的行号。
 */
function parseLedger(text) {
	const events = []
	for (const [index, line] of text.split('\n').entries()) {
		if (line.trim() === '') continue
		const where = `批次台账第 ${index + 1} 行`
		const sample = line.slice(0, BAD_LINE_SAMPLE)
		let value
		try {
			value = JSON.parse(line)
		} catch (error) {
			throw new Error(`${where}不是合法 JSON（${error.message}）——台账一行一事件，坏行不静默跳过；请修那一行或从 git 历史取回`)
		}
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			throw new Error(`${where}不是一个事件对象（实得 ${sample}）——一行一事件 JSON，不是一段文本`)
		}
		if (!isNonBlankString(value.batch)) {
			throw new Error(`${where}不是一条事件（缺非空 batch——按批次切分与双 start 取值都靠它，实得 ${sample}）`)
		}
		if (!isNonBlankString(value.t) || Number.isNaN(Date.parse(value.t))) {
			throw new Error(`${where}不是一条事件（缺可解析的事件时间 t，实得 ${sample}）——跨机合并后按 t 定先后，判不出先后的台账等于没有时间轴`)
		}
		events.push(value)
	}
	return events
}

/**
 * 读台账全量事件。文件缺失时返回 undefined 而不是空数组：空数组是「在、但一条事件都没有」的
 * 合法态（start 自举建出的就是它），两者混在一处，start 的自举与 status 的报错就分不开。
 */
export async function readLedgerEvents({ port, path, signal }) {
	const target = await port.resolve(path)
	if ((await port.stat(target, signal)).kind !== 'present') return undefined
	return parseLedger(await port.readText(target, signal))
}

/**
 * 追加一行事件：读全文 → 末行无换行先补一个 → 拼上一行 JSON → 带版本守卫写回。
 *
 * 先补换行是规范性写入：追加式文件里两行 JSON 直接相邻会长成一行不可解析的内容，而那行的
 * 位置正是别人正在读的那一段。
 *
 * 守卫按活源契约分两种：文件在场走 replaceIfVersion（拿写前 stat 的 version）——台账被两台
 * 机器同时 append 时，后一台若拿的是写前版本还整篇重写，会把前一台刚加的行抹掉；文件不在场
 * 走 createIfAbsent——端口把缺失归一成 {kind:'absent'}（没有 version 可传，拿 undefined 去比
 * 版本会恒判失配），而无条件覆写更糟：探针到发布之间另一台刚建好的文件会被这份基于空全文拼出
 * 的内容整篇盖掉，独占创建把那个窗口变成一次显式失败。start 是唯一走到这条分支的动作。
 */
export async function appendEvent({ port, path, event, signal }) {
	const target = await port.resolve(path)
	const info = await port.stat(target, signal)
	const present = info.kind === 'present'
	const text = present ? await port.readText(target, signal) : ''
	const separator = text === '' || text.endsWith('\n') ? '' : '\n'
	const intent = present ? { kind: 'replaceIfVersion', version: info.version } : { kind: 'createIfAbsent' }
	await port.writeText(target, `${text}${separator}${JSON.stringify(event)}\n`, intent, signal)
}

/** start 事件：字段与 dispatch_batch 的 start 参数一字同源，缺省项归一成空串/空数组（不省略）。 */
export function startEvent({ batch, batchType, baseBatchType = '', intent, subject = '', decisions = [], rules, now }) {
	return { t: isoNow(now), batch, action: 'start', batchType, baseBatchType, intent, subject, decisions: [...decisions], rules }
}

/**
 * advance 事件：数字与短串缺省即写 0/空串，数组格缺省即写空数组，不省略——省略等于让读方在
 * 「没统计到」与「统计出零」之间猜，采纳率与修复轮数正是从这些字段算出来的。数组格落库形态：
 * combo/recommended＝形态 id 串数组，perFormCounts＝[{form, count}]（旧事件里的串/对象形状由
 * 读侧 normalizeFormCounts 兼容，写侧只产这一种）。
 */
export function advanceEvent({
	batch, stage, rules, combo = [], recommended = [], perFormCounts = [],
	adopted = 0, overlap = 0, missed = '', note = '', now,
}) {
	return {
		t: isoNow(now), batch, action: 'advance', stage, rules,
		combo: [...combo], recommended: [...recommended], perFormCounts: perFormCounts.map((entry) => ({ ...entry })),
		adopted, overlap, missed, note,
	}
}

/** 必填文本：缺省与空白都点名报错（台账是审计面，缺字段的事件写进去就查不出谁漏了）。 */
function requireText(value, where) {
	if (!isNonBlankString(value)) throw new Error(`批次台账：${where} 必填且非空`)
	return value
}

/** 计数槽位的边界：非负有限数。缺省即 0，写进去的是「这一趟没有人报这项」，不是「没统计」。 */
function requireCount(value, where) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new Error(`批次台账：${where} 须是非负有限数（缺省 0），实得 ${JSON.stringify(value)}`)
	}
	return value
}

/**
 * 形态 id 列表参数（combo/recommended）的形状边界：[{form: 形态 id}] 数组。串元素也收（宿主
 * schema 只在注册期按快照拦，端口直调的调用方可能按事件落库形状直接给 id 串）——落库统一成
 * id 串数组。词表对着运行期现读的形态表核：拼错的 id 不会有人当场发现，它要到复盘那列变成
 * 一个对不上的数时才显形。
 */
function requireFormList(value, vocabulary, where) {
	if (value === undefined) return []
	if (!Array.isArray(value)) {
		throw new Error(`批次台账：${where} 须是 [{form: 形态 id}] 数组（可省略），实得 ${JSON.stringify(value)}`)
	}
	const forms = []
	for (const entry of value) {
		const form = typeof entry === 'string' ? entry : (entry !== null && typeof entry === 'object' ? entry.form : undefined)
		if (!isNonBlankString(form) || !vocabulary.includes(form)) {
			throw new Error(`批次台账：${where} 的形态「${form ?? JSON.stringify(entry)}」不在形态词表内——可用 id＝${vocabulary.join('、')}`)
		}
		forms.push(form)
	}
	return forms
}

/**
 * perFormCounts 的形状边界：[{form: 形态 id, count: findings 数}] 数组（旧对象形状在写侧明确
 * 拒收并点名新形状——写侧宽容旧形状会让「台账里两种形状并存」从历史事实变成进行时，读侧的
 * 兼容只为历史事件服务）。结构化落库是为了让复盘直取不解析读文本，形状失守就等于统计口径
 * 无声地偏了。词表对着运行期现读的形态表核：新形态加进 forms.json 后下一次 advance 就认，
 * schema 上的 enum 是注册期快照、拦不住也不必拦住它。
 */
function requirePerFormCounts(value, vocabulary) {
	if (value === undefined) return []
	if (!Array.isArray(value)) {
		throw new Error(`批次台账：perFormCounts 须是 [{form: 形态 id, count: findings 数}] 数组（无复核的阶段可省略；「形态 id→数」的对象是旧事件形状，写侧不再收），实得 ${JSON.stringify(value)}`)
	}
	const counts = []
	for (const entry of value) {
		const form = entry !== null && typeof entry === 'object' ? entry.form : undefined
		if (!isNonBlankString(form) || !vocabulary.includes(form)) {
			throw new Error(`批次台账：perFormCounts 的形态「${form ?? JSON.stringify(entry)}」不在形态词表内——可用 id＝${vocabulary.join('、')}`)
		}
		counts.push({ form, count: requireCount(entry.count, `perFormCounts 的「${form}」的 count`) })
	}
	return counts
}

/**
 * batchType 那一趟的词表：配对表主行行名（addon 行不作 batchType）。取 core 的 mainBatchTypes
 * ——台账与 dispatch 对「哪些行算批型」必须是同一份判定，两边各判一次就有一边把加挂行放进来。
 */
function requireBatchType(pairing, value) {
	const main = mainBatchTypes({ pairing })
	if (!main.includes(value)) {
		throw new Error(`批次台账：batchType「${value ?? ''}」不是配对表的主行行名——可用：${main.join('、')}`)
	}
	return value
}

/**
 * 这批在这道门上走不走，三态而不是布尔：'yes' 走、'no' 免门（配对表该列为 null 且行不 needsBase）、
 * 'unknown' 判不出（批型不在配对表，或该行标 needsBase 而台账里没记 baseBatchType）。三态是因为
 * 第三种不能当第一种也不能当第二种：把判不出的当免门，漏记就静默了；把判不出的当有门，免门批型
 * 会每次甩一条假警。故调用方对 'no' 放行、对 'unknown' 出告警并在告警里注明。
 *
 * needsBase 的行按它依赖的那个批型落回门列（修复批的门禁是原批型的门禁，新功能·形态未定的门二
 * 是落点批型的门禁）：登记时记了 baseBatchType 就判得出 yes/no，记了等于把「恒保守全门」这个
 * 保守值换成真答案——修复批是我们自己在用的批型，老实按全门告警等于每次 status 都甩假警。
 *
 * 门名→列的映射取 core 那张反查表（与出稿侧同一份）：这张表此前在这里另算一次，两处各算就
 * 有一处漏掉新门，而漏掉的那处不报错——stageId 反查不到列就出 'yes'，免门批型照样每次告警。
 */
function gateVerdict(stageId, batchType, baseBatchType, pairing) {
	const column = GATE_COLUMN_BY_LABEL[stageId]
	if (column === undefined) return 'yes'
	const row = pairing.rows.find((entry) => entry.batchType === batchType)
	if (row === undefined) return 'unknown'
	if (row[column] !== null) return 'yes'
	if (row.needsBase !== true) return 'no'
	const base = isNonBlankString(baseBatchType) ? pairing.rows.find((entry) => entry.batchType === baseBatchType) : undefined
	if (base === undefined) return 'unknown'
	return base[column] === null ? 'no' : 'yes'
}

/**
 * 集合式状态推导（与事件顺序无关）：per-stage 轮数＝该 stage 的 advance 事件数（门二次数＝复核
 * 轮数）；furthest＝已记录 advance 的 stage 里 order 最大者；furthest 之前每个「该批型真的有」
 * 的门行没有 advance 事件＝告警「门 X 缺记录」；next＝furthest 之后 order 最小者；双 start 取
 * t 最小者＋告警。
 *
 * 这里的轮数是「这一趟跑了几次」，复盘那边报的「修复轮数」是它减一（第一趟是复核、不是修复）——
 * 两个口径差这一位是两种问法，不该谁抄谁：这里答「跑了几趟」，那边答「修了几轮」。
 *
 * 门行告警只在有 furthest 可作参照时出：一条 advance 都没有的批次不是「缺记录」，是还没走到
 * 那一步——那时全部门都空着，据此报一遍等于每次 start 都甩一串假警。
 *
 * 一切「最后一条」按事件时间取，不按它在文件里的位置取：union 合并出来的行序与时间序无关，
 * 按位置取同一台账会得出两种状态（note/missed 尾注、逐字段零值读法都受这条约束）。
 */
export function foldBatch(events, data) {
	const { lifecycle, pairing } = data
	// 阶段行按 order 排这件事单源在 stageVocabulary（core 的词表就是它排出来的），此处照那份
	// 次序取行：另写一份排序就多一个第二真相源，而两处排序哪天分叉，台账的门序会与派发说的不一致
	const stageRows = new Map(lifecycle.stages.map((row) => [row.id, row]))
	const ordered = stageVocabulary(data).map((id) => stageRows.get(id))
	const starts = sortedByTime(events.filter((event) => event.action === 'start'))
	const advances = events.filter((event) => event.action === 'advance')
	const orderedAdvances = sortedByTime(advances)
	const warnings = []
	if (starts.length > 1) {
		warnings.push(`该批次有 ${starts.length} 条 start 事件（跨机并发登记的正常吸收态，不是事故），取 t 最小的一条：${starts.map((event) => event.t).join('、')}`)
	}
	const start = starts[0]
	const batchType = start?.batchType ?? ''
	const sumOf = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0)
	/** 一组事件里某短字段的最后一次非空取值：按事件时间取末，与行序无关。 */
	const lastText = (rows, field) => sortedByTime(rows).map((event) => event[field]).filter((value) => isNonBlankString(value)).at(-1) ?? ''
	const stageState = ordered.map((row) => {
		const rows = advances.filter((event) => event.stage === row.id)
		const found = sumFoundOf(rows)
		const adopted = sumOf(rows, (event) => countOf(event.adopted))
		return {
			id: row.id,
			order: row.order,
			gate: row.gate,
			rounds: rows.length,
			found,
			adopted,
			overlap: sumOf(rows, (event) => countOf(event.overlap)),
			// 拒收数不落盘：它恒等于 findings 总数减采纳数，存下来就多一个能与上面两个字段分家的数。
			// 逐阶段的 note/missed 同理不留在 stageState 里：渲染读的是跨阶段取末的 latestNote/
			// latestMissed，再摆一份逐阶段的只会有一个和它分家的时候（上一条是第几轮写的）
			rejected: Math.max(0, found - adopted),
		}
	})
	const progressed = stageState.filter((row) => row.rounds > 0)
	const furthest = progressed.at(-1) ?? null
	if (furthest !== null) {
		for (const row of stageState) {
			if (row.gate !== true || row.order >= furthest.order || row.rounds > 0) continue
			const verdict = gateVerdict(row.id, batchType, start?.baseBatchType, pairing)
			if (verdict === 'no') continue
			warnings.push(verdict === 'unknown'
				? `${row.id} 缺记录——台账已记到${furthest.id}，却没有它的 advance 事件（该批型这道门按 baseBatchType 落回或批型未在配对表登记，判不出它走不走，按全门保守告警）`
				: `${row.id} 缺记录——台账已记到${furthest.id}，却没有它的 advance 事件（跨机各记一半时会出现这条，按缺记录补记）`)
		}
	}
	const next = (furthest === null ? ordered[0] : ordered.find((row) => row.order > furthest.order)) ?? null
	const gatesAhead = furthest === null
		? []
		: stageState
			.filter((row) => row.gate === true && row.order > furthest.order && gateVerdict(row.id, batchType, start?.baseBatchType, pairing) !== 'no')
			.map((row) => row.id)
	return {
		batch: start?.batch ?? events[0]?.batch ?? null,
		batchType,
		intent: start?.intent ?? '',
		subject: start?.subject ?? '',
		decisions: start?.decisions ?? [],
		starts,
		// advances 一并按事件时间排：状态是事件集合的函数，集合的同一份换个行进次序就该推出同一个值
		advances: orderedAdvances,
		stages: stageState,
		furthest,
		next,
		gatesAhead,
		/** 尾注/漏网取全批最后一次非空取值（跨阶段），与逐阶段那两列同一条时间序口径。 */
		latestNote: lastText(orderedAdvances, 'note'),
		latestMissed: lastText(orderedAdvances, 'missed'),
		warnings,
		lastT: orderedAdvances.at(-1)?.t ?? starts.at(-1)?.t ?? '',
	}
}

/** 按批次切事件；输出按批次的首次出现排序（同一份台账的读法，不必再按批名重排一次）。 */
function groupByBatch(events) {
	const groups = new Map()
	for (const event of events) {
		const name = event.batch
		if (!groups.has(name)) groups.set(name, [])
		groups.get(name).push(event)
	}
	return groups
}

/**
 * 「在飞」＝还没走到提交那一步的批次。提交那一行在 lifecycle 里以 kind 标着，代码不按 id 硬编码
 * （阶段词表是数据面，抄一份 id 进代码就是第二个真相源）。
 *
 * 那行找不到即当场抛，不退化成「全量列出」：数据一律经加载器进来，而加载器已互验「恰有一行
 * kind=提交」，故这个分支在生产路径上到不了；留着它等于用兜底替代那条数据保证——真到了就说明
 * 数据没过加载校验，而兜底会把「数据坏了」表现成「所有批次都还堵着」，比抛更难查。
 *
 * 判据读的是 foldByBatch 折好的那一份，不自己再折：同一次查询里「在飞」与行摘要问的是同一个
 * fold，各折一次纯属把状态算两遍。
 */
function inflightBatches(folded, data) {
	const commits = data.lifecycle.stages.filter((row) => row.kind === COMMIT_KIND)
	if (commits.length !== 1) {
		throw new Error(`lifecycle 无 kind='${COMMIT_KIND}' 行（或不止一行），实得 ${commits.length} 行——在飞集合按这一行划边界；数据未过加载校验（data.checkLifecycle 已拦「恰有一行」），先修数据别让这一层兜着`)
	}
	const done = commits[0].order
	return [...folded.values()].filter((state) => state.furthest === null || state.furthest.order < done)
}

/** start：登记批次。幂等按本机可见性——追加前查本机台账里已有的同批 start，命中即报错不追加。 */
async function startAction({ port, path, loadTables, dataDir, params, now, signal }) {
	const { tables: { lifecycle, pairing } } = loadTables({ names: ['lifecycle', 'pairing'] })
	const batch = requireText(params.batch, 'start 的 batch（批次名：全仓唯一小写短名）')
	const batchType = requireBatchType(pairing, requireText(params.batchType, 'start 的 batchType'))
	const intent = requireText(params.intent, 'start 的 intent（一句话）')
	// needsBase 批型缺 baseBatchType＝登记期报错而不是沿用「判不出→保守全门」：门禁推导那个保守值
	// 是给「历史台账没记」留的兜底，登记时能要却不要求，等于每张这种台账都带一个可避免的保守态——
	// 治在源头（登记时给齐），不在读侧替它圆。
	const row = pairing.rows.find((entry) => entry.batchType === batchType)
	if (row?.needsBase === true && !isGiven(params.baseBatchType)) {
		throw new Error(`批次台账：批型「${batchType}」标了 needsBase（组合与门禁按 baseBatchType 落回原批型主行），start 必须显式登记 baseBatchType——缺它这张台账判不出该批走不走各道门`)
	}
	// 给了就核词表：错字落进台账要等到门禁推导（按 baseBatchType 落回门列）时才显形，那时看到的是
	// 一句「判不出这批走不走这道门」，与真正判不出长得一样。非 needsBase 批型缺省不禁——没登记
	// 就是判不出，保守告警
	const baseBatchType = isGiven(params.baseBatchType) ? requireBatchType(pairing, params.baseBatchType) : ''
	const recorded = (await readLedgerEvents({ port, path, signal })) ?? []
	const existing = sortedByTime(recorded.filter((event) => event.action === 'start' && event.batch === batch))
	if (existing.length > 0) {
		throw new Error(`批次「${batch}」本机台账已有 start 事件（${existing[0].t}）——重复登记报错，不追加第二条；跨机并发时两台各自看不到对方的登记，各自追加合法，合并后 status 按双 start 吸收`)
	}
	const event = startEvent({
		batch, batchType, baseBatchType, intent,
		subject: isGiven(params.subject) ? params.subject : '',
		decisions: params.decisions ?? [],
		rules: rulesHashOf({ bytes: readDataBytes({ dataDir, files: RULE_FILES }) }),
		now,
	})
	await appendEvent({ port, path, event, signal })
	return writeResult({ batch, recorded, event, data: { lifecycle, pairing } })
}

/** advance：记一次阶段完成。它不幂等——修复批同一阶段记多轮正是「轮数」这个统计量的来源。 */
async function advanceAction({ port, path, loadTables, dataDir, events, params, now, signal }) {
	// 这一趟要读 pairing 与 forms，规则指纹要的也正是这两份的字节，指纹便取同一次读的（见 rulesHashOf）
	const { tables: { lifecycle, pairing, forms }, bytes } = loadTables({ names: ['lifecycle', 'pairing', 'forms'] })
	const batch = requireText(params.batch, 'advance 的 batch（start 登记过的批次名）')
	const vocabulary = stageVocabulary({ lifecycle })
	const stage = requireText(params.stage, 'advance 的 stage')
	if (!vocabulary.includes(stage)) {
		throw new Error(`批次台账：未知 stage「${stage}」——取值对着 lifecycle 的阶段词表单源：${vocabulary.join('、')}`)
	}
	if (!events.some((event) => event.action === 'start' && event.batch === batch)) {
		throw new Error(`批次「${batch}」未在台账登记（台账里没有它的 start 事件）——批次未登记（先 start）`)
	}
	// 形态 id 词表现读 forms.json：新形态进表后下一次 advance 就认（schema 的 enum 是注册期快照，
	// 拦不住也不必拦住它——两层各管各的）
	const formVocabulary = forms.forms.map((form) => form.id)
	const perFormCounts = requirePerFormCounts(params.perFormCounts, formVocabulary)
	const combo = requireFormList(params.combo, formVocabulary, 'advance 的 combo（实派形态）')
	const recommended = requireFormList(params.recommended, formVocabulary, 'advance 的 recommended（当趟推荐组合）')
	const adopted = requireCount(params.adopted ?? 0, 'advance 的 adopted')
	// found 经归一求和而非按形状直取：写侧刚核完的数组与旧形状不会在这里分叉——求和口径只有一份
	const found = [...normalizeFormCounts(perFormCounts).values()].reduce((total, count) => total + count, 0)
	if (adopted > found) {
		throw new Error(`批次台账：advance 的 adopted=${adopted} 超过本趟 findings 总数 ${found}——采纳数不可能多于上报数，写进去会让「拒收＝总数−采纳」这个恒等式算成 0，错的输入在那时才显形`)
	}
	const event = advanceEvent({
		batch, stage,
		rules: rulesHashOf({ bytes }),
		combo, recommended, perFormCounts,
		adopted,
		overlap: requireCount(params.overlap ?? 0, 'advance 的 overlap'),
		missed: isGiven(params.missed) ? params.missed : '',
		note: isGiven(params.note) ? params.note : '',
		now,
	})
	await appendEvent({ port, path, event, signal })
	return writeResult({ batch, recorded: events, event, data: { lifecycle, pairing } })
}

/**
 * 写动作（start/advance）的返回值。两个动作的形状必须一样，理由有三层：①回「这一批的全量」而
 * 不只回新事件——调用方拿到的结构化值就是那一次状态推导的输入，只给新事件渲染出来是「批型未登
 * 记／丢了意图行／轮数按 1 算」的一台独角戏；写前读到的那一份与刚追加的这行同属一次写窗口
 * （appendEvent 带版本守卫），中途有别人改过会当场抛失配而不是给出半旧半新的状态。②只回本批
 * 那些——台账是各批共用的，把别批的行一并回进来，渲染会把另一个批次的 start 当成这一批的起点
 * （fold 取事件里 t 最小的那条 start），出来的批型与意图都是别人的。③按事件时间排序，与 status
 * 单批视图同一口径，程序侧消费这两路不用各自再排一次。
 *
 */
function writeResult({ batch, recorded, event, data }) {
	const events = sortedByTime([...recorded.filter((row) => row.batch === batch), event])
	const state = foldBatch(events, data)
	const value = { ok: true, batch, events }
	if (state.next !== null) value.next = state.next.id
	// 与 status 单批视图同一形态：这里折的第一次出 next，withRenderText→renderBatchResult 里
	// 对同一批事件再折一次出文本——渲染是同步纯投影、拿不到这里的折叠结果，微秒级，攒批后按台账量再议
	return withRenderText(value, data)
}

/** 两种空态文案：「一条事件都没有」与「有批次但全收尾了」是两件事，混成一句会把该登记没登记读成活干完了。 */
const EMPTY_LEDGER = '台账里还没有任何批次（先 dispatch_batch start 登记）'
const NOTHING_INFLIGHT = '没有在飞批次（全部已提交或已复盘）'

/**
 * 查询面：status 与 list 同一条读法，只读不写；给不给 batch 决定看的是这一批还是全量。
 *
 * 结构化值带什么按视图定，两条路各自的推导输入都在值自己身上（宿主深拷贝冻结后才交给 render，
 * 按对象身份的缓存必然 miss，见 withRenderText）：单批视图带 events（一批就那些事件，有界，
 * 程序侧要能自己复算），多批视图带 rows 摘要（一批一行短摘要，带 events 的话一百分批就是几百 KB）。
 * 空态按原始事件量分两种说法：「台账里一条事件都没有」与「台账里有批次但全收尾了」是两件事，
 * 混成一句「没有批次」会把「该登记没登记」读成「活干完了」——判据在 execute 那一次，渲染照值说话。
 */
function queryAction({ action, params, events, data }) {
	if (action === 'list') {
		// 与 dispatch 的「不消费的槽位收到值即报错」同一契约：list 是无参动作，带 batch 进来
		// 只有一个含义——模型把「查这一批」说成了 list。静默忽略等于回一份全量清单，回调方以为
		// 自己拿到的是那一批，而清单里每一行都像在说「你要找的批次在这里」
		if (isGiven(params.batch)) {
			throw new Error(`批次台账：list 无 batch 参数（收到「${params.batch}」）——单批查询用 status(batch=)；不消费的槽位收到值即报错，静默忽略等于回一份全量清单冒充那一批`)
		}
		const rows = batchRows(foldByBatch(events, data)).map(rowOf)
		const value = { ok: true, rows }
		// 空态那句话进结构化值而不是只活在文本里：宿主按 schema 判字段，程序侧读的是值。list
		// 走全量，rows 空即台账一条事件都没有——有过事件就必有批、有批就必出行，故只有一种说法
		if (rows.length === 0) value.emptyText = EMPTY_LEDGER
		return withRenderText(value, data)
	}
	if (isGiven(params.batch)) {
		const rows = events.filter((event) => event.batch === params.batch)
		if (!rows.some((event) => event.action === 'start')) {
			throw new Error(`批次「${params.batch}」未在台账登记（台账里没有它的 start 事件）——批次未登记（先 start）`)
		}
		const ordered = sortedByTime(rows)
		// 单批视图这一次 fold 不是重复计算：多批视图的 fold 结果在 execute 结束时就随值走了，
		// 渲染那条路上不再有折叠可用（渲染是同步纯投影），而它量级在微秒级——真要省，得先把
		// 「折叠结果也进值」这条与 dispatch_lessons 的形态对齐，那是攒批后按台账量再议的事
		const state = foldBatch(ordered, data)
		return withRenderText({ ok: true, batch: params.batch, next: state.next?.id, events: ordered }, data)
	}
	// 在飞与行摘要共用同一次 fold：这两个集合问的是同一个函数对同一份事件的同一个答案，
	// 各折一次时状态算两遍，两处还能各自漂（那才是要防的 bug，眼下纯属白算）
	const folded = foldByBatch(events, data)
	const inflight = new Set(inflightBatches(folded, data).map((state) => state.batch))
	const scoped = new Map([...folded].filter(([name]) => inflight.has(name)))
	const value = { ok: true, rows: batchRows(scoped).map(rowOf) }
	if (value.rows.length === 0) value.emptyText = events.length === 0 ? EMPTY_LEDGER : NOTHING_INFLIGHT
	return withRenderText(value, data)
}

/**
 * 按批切事件，各批折一次：批名 → 该批的 fold 结果。
 *
 * 这张表是**单次调用内**的局部量，随这一次查询走完就扔——它与渲染那条「宿主把结构化值深拷贝
 * 冻结后再交给 render，按对象身份挂上去的推导模型必然 miss」毫无关系，两条别混成一条。
 */
function foldByBatch(events, data) {
	return new Map([...groupByBatch(events)].map(([name, rows]) => [name, foldBatch(rows, data)]))
}

/** 按批切出状态摘要，最近动过的排前面（降序）——用批的人先看的是还在动的那几批。 */
function batchRows(folded) {
	const rows = [...folded.values()]
	rows.sort((left, right) => byTime({ t: right.lastT }, { t: left.lastT }))
	return rows
}

/**
 * 四个动作的统一入口（工具 execute 直接调它）。ok 恒真：台账这一族的问题一律 throw（坏行、
 * 版本失配、必填缺失），不靠返回值表达失败——返回 ok:false 而文本里不写原因，调用方无从知道
 * 是没登记还是记失败，那与静默出错没有区别。
 *
 * dataDir 只用来给 start 现读规则面那两份字节（它这趟不读 forms，指纹要的那两份里少一份在手上）
 * ；loadTables 由调用方注入（现读那一份在装配层，它知道 dataDir 从哪来），交回
 * { tables, bytes }：bytes 是这一趟读到的原始字节（键＝文件名），advance 的规则指纹就用它。
 */
export async function runBatchAction({ port, path, loadTables, dataDir, action, params = {}, now, signal }) {
	if (!BATCH_ACTIONS.includes(action)) {
		throw new Error(`未知 action「${action ?? ''}」（${BATCH_ACTIONS.join(' | ')}）`)
	}
	if (action === 'start') return startAction({ port, path, loadTables, dataDir, params, now, signal })
	const events = await readLedgerEvents({ port, path, signal })
	if (events === undefined) {
		throw new Error(`批次台账不存在：${path}——批次未登记（先 dispatch_batch start；start 是唯一的自举入口，其余 action 不建台账）`)
	}
	if (action === 'advance') return advanceAction({ port, path, loadTables, dataDir, events, params, now, signal })
	return queryAction({ action, params, events, data: loadTables({ names: ['lifecycle', 'pairing'] }).tables })
}

/**
 * dispatch 的批次回填：给了批次名就先从台账把这一批的批型/原批型/意图/对象/拍板清单带进参数
 * ——「这批的事实跟批次走」的落点，主会话登记一次，此后每路 brief 自动带「不得重开」与同一份
 * 对象指针。stage 由装配层按工具契约显式传入（参数面里没有 stage 这个调用方槽位）。
 *
 * 五条口径：①显式参数优先，与台账不一致即报错（两个来源说同一件事说岔了，静默取一个等于让主
 * 会话以为自己改过）；②显式传空值（''、'  '、[]）即报错，不当没传——「显式说这次没有」与
 * 「没提这一格」在台账有登记时是两回事，静默取台账会让调用方以为自己否定过；③只填这一趟真正
 * 消费的那些槽位——台账里有、这一趟不消费的不填，填了正好撞上 core 的「不消费即报错」
 * （方案那一趟就不消费 decisions 与 batchType）；④BACKFILL_EXCLUDE 按阶段排除的格（门二的
 * subject）整格跳过——那格在本工具的语义是净 diff 命令，与台账登记的方案路径是两个对象；
 * ⑤台账 subject 是「（待写）」占位＝按未登记处理：不比对、不用它补、显式值照显式的出，并出
 * 一条提醒请主会话定了对象后补记（占位是登记时的诚实，不是可回填的值）。
 */
export function backfillFromBatch(data, params, events, stage) {
	const start = sortedByTime(events.filter((event) => event.action === 'start' && event.batch === params.batch))[0]
	if (start === undefined) {
		throw new Error(`批次「${params.batch}」未在台账登记（台账里没有它的 start 事件）——批次未登记（先 dispatch_batch start）`)
	}
	// batchType 先定：槽位消费集判「这一趟消费不消费 decisions」要看批型条件那几行（baseBatchType 那类）
	const effective = isGiven(params.batchType) ? params.batchType : start.batchType
	const consumed = consumedParams(data, stage, effective)
	const exclude = BACKFILL_EXCLUDE[stage] ?? []
	const merged = { ...params }
	const filled = []
	const notes = []
	for (const field of BACKFILL_FIELDS) {
		if (exclude.includes(field)) continue
		const ledger = start[field]
		if (field === 'subject' && ledger === SUBJECT_PLACEHOLDER) {
			notes.push(`批次「${params.batch}」的台账 subject 是占位「${SUBJECT_PLACEHOLDER}」＝对象未登记——本次按显式参数出稿（没给会报缺必填），定了对象请 dispatch_batch 补记`)
			continue
		}
		if (!isGiven(ledger)) continue
		if (isExplicit(params, field)) {
			// 这一趟不消费就交给 core 报「不消费即报错」——那条比「值为空」更指得准
			if (!consumed.has(field)) continue
			if (!isGiven(params[field])) {
				throw new Error(`显式传了空的 ${field}（${JSON.stringify(params[field])}）——台账里这一格登记着「${JSON.stringify(ledger)}」；要么按台账来（删掉该参数），要么改成非空值，空值会被当成否定的意思，而出稿方不会知道`)
			}
			if (JSON.stringify(params[field]) !== JSON.stringify(ledger)) {
				throw new Error(`参数 ${field} 与批次「${params.batch}」台账里登记的不一致：传值 ${JSON.stringify(params[field])}，台账 ${JSON.stringify(ledger)}——两个来源说同一件事说岔了；删掉该参数改由台账回填，或改台账口径后再调`)
			}
			continue
		}
		if (!consumed.has(field)) continue
		merged[field] = ledger
		filled.push(field)
	}
	return { params: merged, filled, notes }
}

/**
 * dispatch 的批次回填（装配层那一段）：给了批次名就拉台账回填，没给即原样返回；返回值带
 * notes（占位提醒那类非致命提示），由装配层并进输出的 warnings。
 *
 * 「先回填后校验」的顺序是契约的一部分：intent、subject、batchType 本可来自台账，先校验就是先报
 * 「缺必填」，而那几格正是每阶段必填的。端口只在真要回填时才构造（纯 dispatch 调用不该
 * 付 IO 与策略解析的代价），逐次构造的理由同 memory 写侧：会话文件策略按会话解析，绑在注册期
 * 会串味。函数搬到本文件是为了让这条顺序能被纯函数级单测钉住（装配层里它隔着 defineTool，
 * 静态断言钉不到执行次序）。
 */
export async function withBatchBackfill({ ctx, args, exec, data, ledgerPath, stage }) {
	if (!isNonBlankString(args.batch)) return { params: args, notes: [] }
	const port = createHostFsPort({ fs: ctx.fs, policy: ctx.get('sandboxPolicy'), agent: exec.agent })
	const events = await readLedgerEvents({ port, path: ledgerPath, signal: exec.signal })
	if (events === undefined) {
		throw new Error(`批次台账不存在：${ledgerPath}——批次未登记（先 dispatch_batch start）`)
	}
	return backfillFromBatch(data, args, events, stage)
}

/** 阶段进度一句话：已记过的阶段各一段，轮数大于一才显式写出（写「1 轮」是噪声不是信息）。 */
const progressText = (state) => {
	const done = state.stages.filter((row) => row.rounds > 0)
	if (done.length === 0) return '未记阶段'
	return done.map((row) => `${row.id}已过${row.rounds > 1 ? ` ${row.rounds} 轮` : ''}`).join('、')
}

const withWarning = (lines, warning) => [...lines, `⚠ ${warning}`]

/**
 * 一批一行的数据化摘要：多批视图的结构化值带它（带 events 就是几百 KB 的上下文负担），渲染与
 * 程序侧消费者都从它出，两个地方各折一次就会漂——次序与取值全取 fold 那一份。
 *
 * 字段与 renderBatchRow 用的是同一套：progress 那句在这里就算好（它是 stageState 的投影，
 * 展示层不该自己再拼一遍阶段文案），next/gatesAhead 是 id 数组而不是对象——结构化值里塞活对象
 * 等于把数据面复制一份进上下文。
 */
function rowOf(state) {
	return {
		batch: state.batch,
		batchType: state.batchType,
		progress: progressText(state),
		next: state.next === null ? null : state.next.id,
		gatesAhead: [...state.gatesAhead],
		lastT: state.lastT,
		note: state.latestNote,
		warnings: [...state.warnings],
	}
}

/** 一批一行的状态摘要文本（多批视图用）：次序与取值全取 rowOf 那份，不在这里二次归纳。 */
function renderBatchRow(row) {
	const parts = [
		row.batch,
		row.batchType || '批型未登记',
		row.progress,
		row.next === null ? '下一步 无' : `下一步 ${row.next}`,
		row.gatesAhead.length > 0 ? `门禁未过 ${row.gatesAhead.join('、')}` : null,
		row.lastT,
		row.note,
	].filter((part) => part !== null && part !== '')
	const lines = [parts.join('｜')]
	for (const warning of row.warnings) lines.push(`⚠ ${warning}`)
	return lines.join('\n')
}

/** 单批视图的展示文本：一条批次一行块，告警逐条带出（模型消费的是文本，结构化值里不含告警）。 */
function renderBatchBlock(state) {
	const lines = [`批次 ${state.batch}（${state.batchType || '批型未登记'}）`]
	if (state.intent !== '') lines.push(`意图：${state.intent}`)
	const recorded = state.stages.filter((row) => row.rounds > 0)
	if (recorded.length > 0) {
		lines.push(`已记录：${recorded.map((row) => `${row.id} 第 ${row.rounds} 轮（采纳 ${row.adopted}／重叠 ${row.overlap}／拒收 ${row.rejected}）`).join('；')}`)
	}
	lines.push(state.next === null ? '下一步：无（已记到阶段表末端）' : `下一步：${state.next.id}`)
	if (state.gatesAhead.length > 0) lines.push(`门禁未过：${state.gatesAhead.join('、')}`)
	if (state.lastT !== '') lines.push(`最近事件：${state.lastT}`)
	if (state.latestNote !== '') lines.push(`附注：${state.latestNote}`)
	if (state.latestMissed !== '') lines.push(`漏网：${state.latestMissed}`)
	return state.warnings.reduce(withWarning, lines).join('\n')
}

/**
 * 值自带渲染输入：把展示文本并进这一次返回值，工具的 render 于是只投影这一个字段——
 * 读盘与折叠都留在 execute 这趟里做一次，装配层不再为渲染重读一次数据面。
 *
 * 为什么文本进值而不是让 render 现算：宿主把 execute 的结构化值 snapshotToolValue＋
 * deepFreeze 之后才交给 render（dsh-tools lib/index.js 的 createSuccessResult），render 是同步
 * 纯投影（返回值紧接着被结构化快照），在里面读盘或重跑查询都做不到；而按对象身份把推导结果挂
 * 在一个 WeakMap 上（曾经的做法）在真宿主上永远 miss。值自带是唯一可靠的通道——与 dispatch_lessons
 * 同一形态（那边 stats/suggestions 直接进值，render 只排版）。
 */
function withRenderText(value, data) {
	return { ...value, text: renderBatchResult(value, data) }
}

/**
 * 展示文本：一律从**结构化值本身**复算——单批视图（value.batch 有值）从它自带的 events 折一遍，
 * 多批视图从它自带的 rows 逐条映射，两条路都不碰 I/O、不看对象身份。
 *
 * 调用点是 execute（withRenderText），不是工具的 render：算式与值同源，两者不可能各说一套；
 * 而文本落进值之后，渲染那条路上一次读盘与一次折叠都没有了。
 *
 * 既无 events 又无 rows 是内部不变量被破坏（没有任何 action 会产出那种值），抛专用错而不是
 * 静默出一份空视图——那份空文本看不出是丢了推导输入。
 */
export function renderBatchResult(value, data) {
	if (value.batch !== undefined && value.batch !== null) {
		if (data === undefined || !Array.isArray(value.events)) {
			throw new RenderModelMissingError('台账渲染：单批视图的结构化值不带 events，推导输入丢了（内部不变量被破坏）')
		}
		return renderBatchBlock(foldBatch(value.events, data))
	}
	if (!Array.isArray(value.rows)) {
		throw new RenderModelMissingError('台账渲染：多批视图的结构化值不带 rows 摘要，推导输入丢了（内部不变量被破坏）')
	}
	if (value.rows.length === 0) return value.emptyText ?? EMPTY_LEDGER
	return value.rows.map(renderBatchRow).join('\n')
}
