/**
 * dispatch 现读面数据加载器：每次调用经 node:fs 现读三份 JSON，装配层把读到的这一份交给
 * core.js 的纯函数。零宿主依赖——装配层与端口之外的文件按仓级 AGENTS.md 的硬边界一律零
 * 宿主依赖，于是本文件能被 node:test 直接加载，「改文件后下次调用取新值」钉的就是它。
 *
 * 现读不缓存：形态库、配对表、模板就是 dispatch 的规则面，改完 JSON 下次调用即生效；
 * 把它们改成 import 静态化或加一层缓存，会把这条保证悄悄换成「改了不生效还不报错」。
 * 需要重启的只有代码改动。
 *
 * 形状校验自带而不用 schemastery：schemastery 是宿主 peerDep，裸仓不可 import，引了它
 * 本文件就没法被单测加载——而它正是现读这条保证的唯一测点。规格集中在 DATA_FILES 一处，
 * 将来换校验库＝改那一处。
 *
 * 坏数据 fail fast：坏 JSON、形状不合、悬空引用，一律带文件名（与字段路径）抛错，不静默
 * 出稿；「拼错即静默失效」的几处同样拦下：门别交叉核（gate1 列混进门二形态）、节奏谓词取
 * 值不存在于词表、模板占位未在 core 登记表在册。反方向的不对称（forms 有定义、配对表没有行
 * 引用）只收进 warnings：那不是坏数据，是刻意留着的预期孤儿——设计七维由 git-commit 门禁
 * 固定路承载、证伪复核为二轮手动指派，两者的 notes 写明了来由，把它们拦成错误只会逼人删规则。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GATE_LABELS, RHYTHM_FIELDS, STAGES, isRegisteredPlaceholder, placeholderTokens } from './core.js'
import { isNonBlankString } from '../value.js'

/** 数据目录：模块同目录的 ./data/（按 import.meta.url 解析，与进程 cwd 无关）。 */
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url))

/** 配对行在这两列上列形态；悬空引用只可能出现在这两列，双向校验也只扫这两列。 */
const GATE_COLUMNS = Object.keys(GATE_LABELS)

/**
 * 三份数据的形状规格（顶层与行级逐层核对）。约定两条，读规格不必回头问代码：
 * ①键名前缀 `?`＝该字段可缺省；②标记串是类型（见 checkValue 的分支，规格里出现
 * 未登记的标记即抛错——规格写错会静默跳过校验，那比没有校验更坏）。
 * 字段集与 lib/dispatch/data/*.json 一一对应；多出未声明的字段同样报错（多出来的键
 * 多半是拼错或遗留，不该静默通过）。
 */
const DATA_FILES = [
	{
		name: 'forms',
		file: 'forms.json',
		shape: {
			principles: ['string'],
			forms: [{
				id: 'string',
				gate: 'string',
				catches: 'string',
				role: 'string',
				'?extras': 'string',
				'?notes': 'string',
			}],
			rejected: ['string'],
		},
	},
	{
		name: 'pairing',
		file: 'pairing.json',
		shape: {
			rows: [{
				batchType: 'string',
				'?kind': 'enum(addon,special)',
				'?needsBase': 'boolean',
				'?needsRootCause': 'boolean',
				// null 与空数组不同义：null＝这一趟不走这道门（按 needsBase 落回原批型），
				// 空数组＝这道门上就是这个批型一个形态都没有（主行为空＝疑似漏配，收进 warnings）
				gate1: 'string[]|null',
				gate2: 'string[]|null',
				'?note': 'string',
				// 行×形态的批型限定句；键必须是 forms 定义过的形态 id（在 checkCrossLinks 里核），
				// 值是逐字文本（core.assembleBrief 原样附在该形态路的角色句后面）
				'?formNotes': 'stringMap',
			}],
			rhythm: [{
				when: Object.fromEntries(RHYTHM_FIELDS.map((field) => [`?${field}`, 'string[]'])),
				note: 'string',
			}],
		},
	},
	{
		name: 'templates',
		file: 'templates.json',
		shape: {
			门一: 'string',
			门二: 'string',
			施工: 'string',
			修复批增量: 'string',
			方案任务书: 'string',
			横切判据: 'string',
			checklist: 'string',
			裁决: 'string',
			事件字段: 'string',
		},
	},
]

const shapeError = (where, expected, actual) =>
	new Error(`dispatch 数据形状不合：${where} 须是 ${expected}，实得 ${JSON.stringify(actual)}`)

/** 单个值的标记核对；空串与空白串不算「给了」——数据里的空字段多半是漏写不是有意留空。 */
function checkValue(value, marker, where) {
	if (marker.startsWith('enum(')) {
		const allowed = marker.slice('enum('.length, -1).split(',')
		if (!allowed.includes(value)) throw shapeError(where, marker, value)
		return
	}
	if (marker === 'stringMap') {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) throw shapeError(where, marker, value)
		for (const [key, entry] of Object.entries(value)) checkValue(entry, 'string', `${where}.${key}`)
		return
	}
	if (marker === 'string[]|null') {
		if (value === null) return
		checkValue(value, 'string[]', where)
		return
	}
	if (marker === 'string[]') {
		if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
			throw shapeError(where, marker, value)
		}
		return
	}
	if (marker === 'string') {
		if (typeof value !== 'string' || value.trim() === '') throw shapeError(where, marker, value)
		return
	}
	if (marker === 'boolean') {
		if (typeof value !== 'boolean') throw shapeError(where, marker, value)
		return
	}
	throw new Error(`dispatch 数据形状规格里有未登记的标记「${marker}」——规格写错会让本层校验空转`)
}

/**
 * 逐层核对一份数据：数组规格＝元素规格的列表（元素是标记就逐个核类型、是对象就逐个核行），
 * 对象规格里键名前缀 `?` 的字段可缺省、其余缺一即错、多出来即错。
 */
function checkShape(value, spec, where) {
	if (typeof spec === 'string') {
		checkValue(value, spec, where)
		return
	}
	if (Array.isArray(spec)) {
		const item = typeof spec[0] === 'string' ? spec[0] : '对象'
		if (!Array.isArray(value)) throw shapeError(where, `数组（元素为 ${item}）`, value)
		value.forEach((item, index) => checkShape(item, spec[0], `${where}[${index}]`))
		return
	}
	if (typeof value !== 'object' || value === null) throw shapeError(where, '对象', value)
	for (const [key, fieldSpec] of Object.entries(spec)) {
		const optional = key.startsWith('?')
		const name = optional ? key.slice(1) : key
		if (!(name in value)) {
			if (optional) continue
			throw new Error(`dispatch 数据形状不合：${where} 缺字段「${name}」`)
		}
		checkShape(value[name], fieldSpec, `${where}.${name}`)
	}
	for (const key of Object.keys(value)) {
		if (!(key in spec) && !(`?${key}` in spec)) {
			throw new Error(`dispatch 数据形状不合：${where} 多出未声明字段「${key}」`)
		}
	}
}

/** 读一份文件并当场解析＋验形；读不到、不是合法 JSON、形状不合，三种都显式报错不静默跳过。 */
function readDataFile(dataDir, { file, shape }) {
	const path = join(dataDir, file)
	let text
	try {
		text = readFileSync(path, 'utf8')
	} catch (error) {
		throw new Error(`dispatch 数据读取失败：${path}（${error.message}）`)
	}
	let value
	try {
		value = JSON.parse(text)
	} catch (error) {
		throw new Error(`dispatch 数据 ${file} 不是合法 JSON：${error.message}`)
	}
	checkShape(value, shape, file)
	return value
}

/** 空集下限：空数组的规则面装不出任何东西，装得上＝有人把规则整段删了却没报错。 */
function checkNonEmpty(data) {
	for (const [where, list] of [
		['forms.json 的 forms', data.forms.forms],
		['pairing.json 的 rows', data.pairing.rows],
		['pairing.json 的 rhythm', data.pairing.rhythm],
	]) {
		if (list.length === 0) throw new Error(`dispatch 数据空集：${where} 是空数组——规则面装不出任何东西`)
	}
}

/** 唯一性：行名/形态 id 重名时查表取到第一条，重名那条等于悄悄失效。 */
function checkUnique(values, where) {
	const seen = new Set()
	for (const value of values) {
		if (seen.has(value)) throw new Error(`dispatch 数据重复：${where} 里出现两次「${value}」——查表取到第一条，重名那条等于悄悄失效`)
		seen.add(value)
	}
}

/** 节奏谓词可核的词表：batchType 对配对行名、stage 对阶段词表；provider 是两机各自的模型 id，无词表可核。 */
const PREDICATE_VOCABULARIES = {
	batchType: (data) => data.pairing.rows.map((row) => row.batchType),
	stage: () => STAGES,
}

/**
 * 跨文件引用与取值核对（含双向不对称的两侧）：悬空引用与门别不合抛错；「配对表没有行引用
 * 到的形态」与「主行的 gate 列疑似漏配成空数组」收进 warnings——前者是刻意留着的预期孤儿
 * （notes 写明来由），后者是编 JSON 时的手滑，删一行代价小、拦住代价大。
 */
function checkCrossLinks(data) {
	const { forms, pairing } = data
	const formsById = new Map(forms.forms.map((form) => [form.id, form]))
	const referenced = new Set()
	const warnings = []
	for (const row of pairing.rows) {
		for (const column of GATE_COLUMNS) {
			const columnForms = row[column]
			if (Array.isArray(columnForms) && columnForms.length === 0 && row.needsBase !== true) {
				warnings.push(`批型「${row.batchType}」的 ${column}（${GATE_LABELS[column]}）是空数组——若有意免派该门请写 null，空数组疑似漏配`)
			}
			for (const id of columnForms ?? []) {
				const entry = formsById.get(id)
				if (entry === undefined) {
					throw new Error(`dispatch 数据悬空引用：pairing.json 的批型「${row.batchType}」${column} 指向 forms.json 未定义的形态「${id}」`)
				}
				if (entry.gate !== GATE_LABELS[column]) {
					throw new Error(`dispatch 数据门别不合：批型「${row.batchType}」的 ${column}（${GATE_LABELS[column]}）列了 gate='${entry.gate}' 的形态「${id}」——${GATE_LABELS[column]}列只收 gate='${GATE_LABELS[column]}' 的形态`)
				}
				referenced.add(id)
			}
		}
		for (const id of Object.keys(row.formNotes ?? {})) {
			if (!formsById.has(id)) {
				throw new Error(`dispatch 数据悬空引用：pairing.json 的批型「${row.batchType}」formNotes 限定了 forms.json 未定义的形态「${id}」——限定句安在没定义的形态上，等于永远渲染不到`)
			}
		}
	}
	for (const entry of pairing.rhythm) {
		for (const [field, vocabulary] of Object.entries(PREDICATE_VOCABULARIES)) {
			for (const value of entry.when?.[field] ?? []) {
				const words = vocabulary(data)
				if (!words.includes(value)) {
					throw new Error(`dispatch 数据谓词取值不存在：pairing.json 的 rhythm 条目 when.${field} 含「${value}」，词表＝${words.join('、')}——拼错的谓词永不命中，等于这条节奏规则静默失效`)
				}
			}
		}
	}
	warnings.push(...forms.forms
		.filter((form) => !referenced.has(form.id))
		.map((form) => `形态「${form.id}」已定义但配对表无任何行引用（孤儿）${form.notes === undefined ? '' : `：${form.notes}`}`))
	return warnings
}

/** 模板占位须在 core.js 的占位登记表里在册：未登记的占位留到渲染期才炸，等于规则删了不报错。 */
function checkPlaceholders(templates) {
	for (const [key, text] of Object.entries(templates)) {
		for (const token of placeholderTokens(text)) {
			if (!isRegisteredPlaceholder(token)) {
				throw new Error(`dispatch 数据占位未登记：templates.json 的「${key}」模板含未登记的占位〔${token}〕——渲染器不猜占位语义`)
			}
		}
	}
}

/**
 * 读一份完整的现读面数据（forms/pairing/templates 三份，加一份数据面 warnings）。
 * dataDir 省略或留空＝模块同目录的 ./data/；Config 的 dispatchDataDir 显式覆写走同一条路。
 * warnings 是数据面告警，与 core.js 按本次调用产出的告警（行号锚点等）是两回事，装配层
 * 把两者合进同一份输出。
 */
export function loadDispatchData({ dataDir } = {}) {
	const dir = isNonBlankString(dataDir) ? dataDir : DEFAULT_DATA_DIR
	const data = {}
	for (const entry of DATA_FILES) data[entry.name] = readDataFile(dir, entry)
	checkNonEmpty(data)
	checkUnique(data.forms.forms.map((form) => form.id), 'forms.json 的形态 id')
	checkUnique(data.pairing.rows.map((row) => row.batchType), 'pairing.json 的批型行名')
	data.warnings = checkCrossLinks(data)
	checkPlaceholders(data.templates)
	return data
}
