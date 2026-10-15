/**
 * dispatch 现读面数据加载器：每次调用经 node:fs 现读五份 JSON，装配层把读到的这一份交给
 * core.js 的纯函数。零宿主依赖——装配层与端口之外的文件按仓级 AGENTS.md 的硬边界一律零
 * 宿主依赖，于是本文件能被 node:test 直接加载，「改文件后下次调用取新值」钉的就是它。
 *
 * 现读不缓存：形态库、配对表、模板、阶段表、方案规范就是 dispatch 的规则面，改完 JSON 下次
 * 调用即生效；把它们改成 import 静态化或加一层缓存，会把这条保证悄悄换成「改了不生效还不
 * 报错」。需要重启的只有代码改动。
 *
 * 形状校验自带而不用 schemastery：schemastery 是宿主 peerDep，裸仓不可 import，引了它
 * 本文件就没法被单测加载——而它正是现读这条保证的唯一测点。规格集中在 DATA_FILES 一处，
 * 将来换校验库＝改那一处。
 *
 * 坏数据 fail fast：坏 JSON、形状不合、悬空引用，一律带文件名（与字段路径）抛错，不静默
 * 出稿；「拼错即静默失效」的几处同样拦下：门别交叉核（gate1 列混进门二形态）、阶段表六处
 * 专核（见 checkLifecycle）、节奏谓词取值不存在于词表、模板占位未在 core 登记表在册。
 * 反方向的不对称（forms 有定义、配对表没有行引用）只收进 warnings：那不是坏数据，是刻意留着
 * 的预期孤儿——设计七维由 git-commit 门禁固定路承载、证伪复核为二轮手动指派，两者的 notes
 * 写明了来由，把它们拦成错误只会逼人删规则。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GATE_LABELS, PARAM_FIELDS, REVIEW_KIND, RHYTHM_FIELDS, dispatchStages, isRegisteredPlaceholder, placeholderTokens, stageRequires } from './core.js'
import { isNonBlankString } from '../value.js'

/** 数据目录：模块同目录的 ./data/（按 import.meta.url 解析，与进程 cwd 无关）。 */
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url))

/** 配对行在这两列上列形态；悬空引用只可能出现在这两列，双向校验也只扫这两列。 */
const GATE_COLUMNS = Object.keys(GATE_LABELS)

/** 门别名集合：lifecycle 的复核阶段 id 必须落在里面（core 按它反查该读配对表的哪一列）。 */
const GATE_LABELS_BY_LABEL = new Set(Object.values(GATE_LABELS))

/**
 * 五份数据的形状规格（顶层与行级逐层核对）。约定两条，读规格不必回头问代码：
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
		// 键集不写死在这里：模板键里「门一/门二/施工/方案任务书」那几档是 lifecycle 各行的
		// templateKey（或缺省＝stage id），写死一份就是第二真相源（加阶段就得改代码）。
		// 本层只开放「每个键的值都是 string」，键的白名单在 loadDispatchData 里连着 lifecycle
		// 一起核（checkTemplateKeys）。
		shape: 'templateValues',
	},
	{
		name: 'lifecycle',
		file: 'lifecycle.json',
		shape: {
			stages: [{
				id: 'string',
				order: 'number',
				// gate 是「这一行是门阶段」的第二处表述，与 kind＝复核 等价（加载期互验）；
				// produces 是该阶段的产物面，给 dispatch_batch 台账预留——两者本工具都不读
				gate: 'boolean',
				kind: 'string',
				// 模板键缺省＝stage id；键名与阶段不同名的那一档（方案阶段的「方案任务书」）写在这里
				'?templateKey': 'string',
				// stage 级必填参数名——必填规则的单源，core.js 现算；批型条件必填（needsBase/
				// needsRootCause）归配对特殊行语义，不进这张表
				requires: 'string[]',
				produces: 'string[]',
				// 知识文件引用：列出的即该阶段消费的数据（方案阶段那两条 plan-spec 占位与
				// 定稿自查都靠它认出「这一趟吃 plan-spec」）
				uses: 'string[]',
				'?note': 'string',
				// 复盘点位判据（只有复盘那行有）：批数与批型数的门槛＋提示上限，是「该不该现在复盘」
				// 的单源（dispatch_lessons 现读它）。别的阶段带这个字段等于宣告「本阶段也管点位」。
				'?point': { minBatches: 'number', minBatchTypes: 'number', upperBatches: 'number' },
			}],
		},
	},
	{
		name: 'planSpec',
		file: 'plan-spec.json',
		shape: {
			blocks: [{ id: 'string', title: 'string', text: 'string' }],
			checklist: 'string[]',
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
	if (marker === 'number') {
		if (typeof value !== 'number' || !Number.isFinite(value)) throw shapeError(where, marker, value)
		return
	}
	if (marker === 'templateValues') {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) throw shapeError(where, '模板表（对象，值为 string）', value)
		for (const [key, entry] of Object.entries(value)) checkValue(entry, 'string', `${where}.${key}`)
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
		['lifecycle.json 的 stages', data.lifecycle.stages],
		['plan-spec.json 的 blocks', data.planSpec.blocks],
		['plan-spec.json 的 checklist', data.planSpec.checklist],
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

/**
 * 阶段表专核六处，全是「派了却派不出东西／拼错了却不报错」那一类：
 * ①stage id 与 order 各自唯一（重名/重号时查表与排序各取第一条，都是静默失效）；
 * ②order 是正整数（阶段先后与词表顺序都按它排，0/负数/小数排出来的先后是任意的）；
 * ③kind＝复核 的阶段 id 必须落在门别映射里——core 按门名反查该读配对表的哪一列，反查不到
 * 就出空组合，那一门复核等于没派；④gate 与 kind＝复核 等价（同一件事的第二处表述，互验后
 * 不会再各错一次）；⑤requires 无重复且每个名字都在工具参数全集里（凭空的必填名＝向调用方
 * 要一个不存在的参数）；⑥uses 里的 plan-spec.json 与模板里的 plan-spec 占位互为充要
 * （两处各写一次就会各错一次：勾了不用，或用了没勾）。④与⑥只查「有模板键的那些行」——判据
 * 直接读数据（该行的模板键在 templates 里存在），提交/复盘两行现在没有模板所以不进互验，
 * 哪天它们补上模板就自动进来，不用回来改这里的名单。
 */
function checkLifecycle(data) {
	const { lifecycle, templates } = data
	const withTemplate = lifecycle.stages.filter((row) => templates[row.templateKey ?? row.id] !== undefined)
	checkUnique(lifecycle.stages.map((row) => row.id), 'lifecycle.json 的 stage id')
	checkUnique(lifecycle.stages.map((row) => row.order), 'lifecycle.json 的 order')
	for (const row of lifecycle.stages) {
		if (!Number.isInteger(row.order) || row.order < 1) {
			throw new Error(`dispatch 数据取值不合：lifecycle.json 的 stage「${row.id}」order 须是正整数，实得 ${JSON.stringify(row.order)}——阶段先后与词表顺序都按它排`)
		}
		checkUnique(row.requires, `lifecycle.json 的 stage「${row.id}」的 requires`)
		for (const field of row.requires) {
			if (!PARAM_FIELDS.includes(field)) {
				throw new Error(`dispatch 数据取值域外：lifecycle.json 的 stage「${row.id}」requires 含「${field}」，参数名全集＝${PARAM_FIELDS.join('、')}——凭空的必填名等于向调用方要一个不存在的参数`)
			}
		}
		if (row.kind === REVIEW_KIND && !GATE_LABELS_BY_LABEL.has(row.id)) {
			throw new Error(`dispatch 数据门别不明：lifecycle.json 的复核阶段「${row.id}」不在门别映射 ${[...GATE_LABELS_BY_LABEL].join('、')} 内——core 按门名反查该读配对表的哪一列，反查不到就出空组合`)
		}
		if (!withTemplate.includes(row)) continue
		if (row.gate !== (row.kind === REVIEW_KIND)) {
			throw new Error(`dispatch 数据门别表述不一致：lifecycle.json 的 stage「${row.id}」gate=${row.gate} 而 kind='${row.kind}'——gate 须等于「kind 是复核」（${GATE_LABELS_BY_LABEL.has(row.id) ? '复核阶段该置 true' : '非复核阶段该置 false'}），两处各写一次就会各错一次`)
		}
		const declared = row.uses.includes('plan-spec.json')
		const placed = placeholderTokens(templates[row.templateKey ?? row.id]).some((token) => token.startsWith('plan-spec'))
		if (declared !== placed) {
			throw new Error(`dispatch 数据引用不一致：lifecycle.json 的 stage「${row.id}」${declared ? 'uses 声明了 plan-spec.json，模板里却没有 plan-spec 占位' : '模板里有 plan-spec 占位，uses 却没声明 plan-spec.json'}——勾了不用与用了没勾都是同一处规则的两份表述`)
		}
	}
}

/**
 * 模板键的白名单＝「lifecycle 各行的模板键」＋那几张不是阶段模板的辅助页（修复批增量、横切
 * 判据、自检清单、裁决、事件字段）。多出来的键多半是拼错或遗留：它在任何阶段都不会被读到，
 * 留着等于让人以为写了就生效。
 */
const TEMPLATE_AUX_KEYS = ['修复批增量', '横切判据', 'checklist', '裁决', '事件字段']

function checkTemplateKeys(data) {
	const allowed = new Set([
		...TEMPLATE_AUX_KEYS,
		...data.lifecycle.stages.map((row) => row.templateKey ?? row.id),
	])
	for (const key of Object.keys(data.templates)) {
		if (!allowed.has(key)) {
			throw new Error(`dispatch 数据多出未声明的模板键「${key}」——模板键须是某条 lifecycle 行的 templateKey（或缺省＝stage id），或那几张辅助页（${TEMPLATE_AUX_KEYS.join('、')}）；多出来的键没有任何阶段会读到它`)
		}
	}
}

/**
 * 节奏谓词可核的词表：batchType 对配对表主行行名（addon 行不作 batchType，传它当谓词值那条
 * 规则永不命中）；stage 对本工具能出稿的阶段（提交/复盘归各自的工具，以它们为谓词值同样不可
 * 达）；provider 是两机各自的模型 id，无词表可核。
 */
const PREDICATE_VOCABULARIES = {
	batchType: (data) => data.pairing.rows.filter((row) => row.kind !== 'addon').map((row) => row.batchType),
	stage: (data) => dispatchStages(data),
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
	const predicateVocabulary = Object.fromEntries(
		Object.entries(PREDICATE_VOCABULARIES).map(([field, vocabulary]) => [field, vocabulary(data)]),
	)
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
		for (const [field, words] of Object.entries(predicateVocabulary)) {
			for (const value of entry.when?.[field] ?? []) {
				if (!words.includes(value)) {
					throw new Error(`dispatch 数据谓词取值不存在：pairing.json 的 rhythm 条目 when.${field} 含「${value}」，词表＝${words.join('、')}——拼错的谓词永不命中，等于这条节奏规则静默失效`)
				}
			}
		}
		// 两个在字段的交集可达：stage 与 batchType 各限一批而两者不相交时，这条规则在任何一次
		// 调用里都不可能同时成立（{batchType:[修复批],stage:[方案]}：方案那一趟不判批型）
		const reachable = dispatchStages(data).filter((stage) => {
			const stages = entry.when?.stage
			if (stages !== undefined && !stages.includes(stage)) return false
			return entry.when?.batchType === undefined || stageRequires(data, stage).includes('batchType')
		})
		if (reachable.length === 0) {
			throw new Error(`dispatch 数据谓词永不可达：pairing.json 的 rhythm 条目「${entry.note}」的 when（${JSON.stringify(entry.when ?? {})}）在本工具任何一次可达调用下都不会同时成立——谓词值各自合法但交集为空，等于这条节奏规则静默失效`)
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
 * 只取指定的那几份（按调用方给的顺序，不带跨文件校验）：台账四个动作各要自己那几份——
 * start 只要配对表（批型词表），advance 要阶段表与形态表（阶段词表、形态 id 词表），
 * status/list 要阶段表与配对表（阶段序、门别、这批型有没有那道门）。把五份连同跨文件校验
 * 带一遍不是更严，是白付：动作不读的那些份坏了也会让台账查询失败，而那与本次查询无关。
 * 读取与形状校验仍走本文件那一份读法（另开一条就是同一份数据两套校验，坏数据会在某条路上
 * 悄悄过去）；跨文件校验只在 loadDispatchData 那条整读路径上。
 */
export function loadDispatchTables({ dataDir, names }) {
	const dir = isNonBlankString(dataDir) ? dataDir : DEFAULT_DATA_DIR
	const entries = names.map((name) => {
		const entry = DATA_FILES.find((file) => file.name === name)
		if (entry === undefined) throw new Error(`dispatch 现读面没有名为「${name}」的数据文件——名字抄错会读成空表`)
		return [name, readDataFile(dir, entry)]
	})
	return Object.fromEntries(entries)
}

/**
 * 取若干份数据文件的原始字节（Buffer，按调用方给的顺序）：台账事件里的 rules 字段要的是
 * 「规则面当时是这份字节」的指纹，解析后重新序列化会改字节（键序、缩进、空白），那样的指纹
 * 在两台机器的同一份数据上算不出同一个值，而它的用途正是跨机可重放。这里只读不解析不验形
 * （要形状校验的读法是 loadDispatchData），读取失败与现读面同一句报错，两条路不各说一套。
 */
export function readDataBytes({ dataDir, files }) {
	const dir = isNonBlankString(dataDir) ? dataDir : DEFAULT_DATA_DIR
	const bytes = {}
	for (const file of files) {
		const path = join(dir, file)
		try {
			bytes[file] = readFileSync(path)
		} catch (error) {
			throw new Error(`dispatch 数据读取失败：${path}（${error.message}）`)
		}
	}
	return bytes
}

/**
 * 读一份完整的现读面数据（forms/pairing/templates/lifecycle/planSpec 五份，加一份数据面 warnings）。
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
	checkLifecycle(data)
	checkTemplateKeys(data)
	checkUnique(data.planSpec.blocks.map((block) => block.id), 'plan-spec.json 的节 id')
	data.warnings = checkCrossLinks(data)
	checkPlaceholders(data.templates)
	return data
}
