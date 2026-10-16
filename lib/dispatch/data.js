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
 * 专核（见 checkLifecycle）、节奏谓词取值不存在于词表、模板占位未在 core 登记表在册、
 * 安全五问在两处角色句里写得不一样。
 * 反方向的不对称（forms 有定义、配对表没有行引用）只收进 warnings：那不是坏数据，是刻意留着
 * 的预期孤儿——设计七维由 git-commit 门禁固定路承载、证伪复核为二轮手动指派，两者的 notes
 * 写明了来由，把它们拦成错误只会逼人删规则。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASSEMBLER_CONTRACTS, COMMIT_KIND, GATE_COLUMN_BY_LABEL, GATE_LABELS, LIFECYCLE_KINDS, NUMERIC_PARAMS, PARAM_FIELDS, REVIEW_KIND, RHYTHM_FIELDS, dispatchStages, isRegisteredPlaceholder, mainBatchTypes, placeholderTokens, stageRequires } from './core.js'
import { isNonBlankString } from '../value.js'

/** 数据目录：模块同目录的 ./data/（按 import.meta.url 解析，与进程 cwd 无关）。 */
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url))

/**
 * 数据目录归一：留空/非串＝模块同目录的 ./data/。三处读取入口与 Config 那层各自写一遍同式判断，
 * 改判据（例如将来认相对路径）时就有入口忘了改，而漏改的那处会静默读另一个目录。
 */
export const resolveDataDir = (configured) => (isNonBlankString(configured) ? configured : DEFAULT_DATA_DIR)

/** 配对行在这两列上列形态；悬空引用只可能出现在这两列，双向校验也只扫这两列。 */
const GATE_COLUMNS = Object.keys(GATE_LABELS)

/**
 * 零读者字段里「顶层列表」那一类的名单（本工具一个都不读，故盘面不摆，也不进 dispatch-data 的
 * 计数快照——那一维不进快照是因为没人读，不是因为漏了一维）。名单单源在此：形状规格与那条用例
 * 的对账断言读的是同一份，各抄一份时症状是「多出来的那一维没人对账」而两边都全绿。
 */
export const ZERO_READER_LIST_FIELDS = ['principles']

/** 门别名集合：lifecycle 的复核阶段 id 必须落在里面（core 按它反查该读配对表的哪一列）。 */
const GATE_LABELS_BY_LABEL = new Set(Object.keys(GATE_COLUMN_BY_LABEL))

/**
 * 五份数据的形状规格（顶层与行级逐层核对）。约定两条，读规格不必回头问代码：
 * ①键名前缀 `?`＝该字段可缺省；②标记串是类型（见 checkValue 的分支，规格里出现
 * 未登记的标记即抛错——规格写错会静默跳过校验，那比没有校验更坏）。
 * 字段集与 lib/dispatch/data/*.json 一一对应；多出未声明的字段同样报错（多出来的键
 * 多半是拼错或遗留，不该静默通过）。
 *
 * 零读者字段分两层，各有各的守法，合起来才是「它不在盘上」这件事：
 * ①形状按可缺省登记（`?` 前缀），守的是**写回不炸装载**——改成必填只会逼着每份数据补一段没人读
 *   的文案，而少补一份的那份数据直接加载失败、整件工具缺席；
 * ②**不写回盘上**不由形状规格保证：它是一条全称否定（「谁再写进去也不出事」那种宣称），只有
 *   对着真盘面的反向断言钉得住——写回去即红，红的时候自问「它有消费者吗」。
 * 顶层列表那一类的名单在 ZERO_READER_LIST_FIELDS（单源：形状规格与测试的对账断言读同一份）；
 * 行级那两类（lifecycle 各行的 produces 与 note、pairing 行上的 note）不参与键集推导，逐行恒
 * 缺席由 dispatch-data 的用例反钉。同名的另两处 note 不是零读者：forms 的 notes 进孤儿告警、
 * rhythm 的 note 进不可达条目的报错文案，故一个可缺省、另一个必填。
 *
 * 名单本身也是单源：测试夹具要拷一份「现读面有哪些文件」，手抄一份就多一处与本数组分家的可能
 * （增一份文件时夹具那份不会跟着动，症状是临时目录里读不到它而报错指向别处）。
 */
export const DATA_FILES = [
	{
		name: 'forms',
		file: 'forms.json',
		shape: {
			'?principles': ['string'],
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
				// 谓词字段的清单单源在 core 的 RHYTHM_FIELDS；形态按字段类别分两组守门：枚举组
				// （batchType/stage/provider）收字符串数组，规模组（数值槽位 diffLines/changedFiles）
				// 收 {max:非负整数} 区间。五个字段合收一种 union 就会放过「provider 写成区间」
				// 「diffLines 写成数组」这类错——它们各自加载通过又永不命中，属静默失效而非坏数据，
				// 而静默失效正是加载期该拦的那一类。取值对着词表核（见 checkCrossLinks）只管
				// batchType/stage：provider 是两机各自的模型 id，规模字段比的是数量，都无词表可核
				when: Object.fromEntries(RHYTHM_FIELDS.map((field) => [`?${field}`, NUMERIC_PARAMS.includes(field) ? 'maxBound' : 'string[]'])),
				note: 'string',
			}],
		},
	},
	{
		name: 'templates',
		file: 'templates.json',
		// 键集不写死在这里：模板键里「门一/施工/方案任务书」那几档是 lifecycle 各行的
		// templateKey（或缺省＝stage id——门二那行指向门一就是合一后的落点），写死一份就是
		// 第二真相源（加阶段就得改代码）。
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
				// gate 是「这一行是门阶段」的第二处表述，与 kind＝复核 等价。判组合出不出走的是
				// kind（core 的 comboGatesForStage 只认它），gate 那一份由 dispatch_batch 的门禁
				// 推导读——两处各判一次就会各错一次，故加载期互验
				gate: 'boolean',
				// kind 决定这一行被按哪种语义读（复核门反查配对列、提交行被台账拿来划在飞边界），
				// 落域外的值两侧都读不出：组合出空、在飞算错，而加载期一声不响。取值域现读 core 的
				// 词表，不在这里抄一份名单
				kind: `enum(${LIFECYCLE_KINDS.join(',')})`,
				// 模板键缺省＝stage id；键名与阶段不同名的那一档（方案阶段的「方案任务书」、门二
				// 复用门一那份）写在这里，将来两门真要分叉也是改这一行而不是加第二份模板
				'?templateKey': 'string',
				// stage 级必填参数名——必填规则的单源，core.js 现算；批型条件必填（needsBase/
				// needsRootCause）归配对特殊行语义，不进这张表
				requires: 'string[]',
				'?produces': 'string[]',
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

/** 字符串列表：数组且每项是非空串（空串与空白串不算「给了」——数据里的空字段多半是漏写不是有意留空）。 */
const isStringList = (value) => Array.isArray(value)
	&& value.every((item) => typeof item === 'string' && item.trim() !== '')

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
	// 规模谓词的取值：{max:N} 区间对象，只认 max 一个键——多写一个键在这里拦住，而不是让它
	// 静默按 max 生效（写了「min:0」却只比 max 的规则，差一步就是提示按一条不存在的口径出）
	if (marker === 'maxBound') {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) throw shapeError(where, marker, value)
		checkShape(value, { max: '非负整数' }, where)
		return
	}
	// 这里的「非负整数」有意比 core.assertNumericParams 的「非负安全整数」宽一档：这一侧量的是
	// 自配规则（JSON 里的 {max:N}），值域错的后果是那条规则永不命中或恒命中，而它只由本仓维护者
	// 改；那一侧收的是调用方现传的规模，天文数字是模型随手能给的，故按可精确表示的计数收。两侧
	// 各守自己那道口子，不为对称而统一——统一到宽的那侧就等于把输入侧的洞开到配置侧
	if (marker === '非负整数') {
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw shapeError(where, marker, value)
		return
	}
	if (marker === 'string[]') {
		if (!isStringList(value)) throw shapeError(where, marker, value)
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

/** 读一份文件并当场解析＋验形，顺带交出这一趟读到的原始字节；读不到、不是合法 JSON、形状不合，三种都显式报错不静默跳过。 */
function readDataFileWithBytes(dataDir, { file, shape }) {
	const path = join(dataDir, file)
	let bytes
	try {
		bytes = readFileSync(path)
	} catch (error) {
		throw new Error(`dispatch 数据读取失败：${path}（${error.message}）`)
	}
	let value
	try {
		value = JSON.parse(bytes.toString('utf8'))
	} catch (error) {
		throw new Error(`dispatch 数据 ${file} 不是合法 JSON：${error.message}`)
	}
	checkShape(value, shape, file)
	return { value, bytes }
}

/** 只要解析并验过形的那一份（整读路径走这里）。 */
function readDataFile(dataDir, entry) {
	return readDataFileWithBytes(dataDir, entry).value
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
 * 阶段表专核，逐条都是「派了却派不出东西／拼错了却不报错」那一类：
 * ①stage id 与 order 各自唯一（重名/重号时查表与排序各取第一条，都是静默失效）；
 * ②order 是正整数（阶段先后与词表顺序都按它排，0/负数/小数排出来的先后是任意的）；
 * ③kind 落在 core 的词表内（形状规格那道，域外的值两侧都读不出）；
 * ④core 的 ASSEMBLER_CONTRACTS 四个阶段 id 都落在 stage id 内（装配四件各按契约阶段出稿，
 * 改 id 不改 core 时缺的那行要到出稿时才炸；施工缺行另带根因三行静默停发的后果）；
 * ⑤恰有一行 kind＝提交（台账按这一行划「在飞」边界，少了记到收尾的批次永远算在飞，多了提交
 * 这一步能被推到没有下一行的 order）；
 * ⑥requires 无重复且每个名字都在工具参数全集里（凭空的必填名＝向调用方要一个不存在的参数）；
 * ⑦kind＝复核 的阶段 id 必须落在门别映射里——core 按门名反查该读配对表的哪一列，反查不到
 * 就出空组合，那一门复核等于没派；⑧gate 与 kind＝复核 等价（同一件事的第二处表述，互验后
 * 不会再各错一次）；⑨uses 里的 plan-spec.json 与模板里的 plan-spec 占位互为充要
 * （两处各写一次就会各错一次：勾了不用，或用了没勾）。⑧与⑨只查「有模板键的那些行」——判据
 * 直接读数据（该行的模板键在 templates 里存在），提交/复盘两行现在没有模板所以不进那两段互验，
 * 哪天它们补上模板就自动进来，不用回来改这里的名单。
 */
function checkLifecycle(data) {
	const { lifecycle, templates } = data
	const withTemplate = lifecycle.stages.filter((row) => templates[row.templateKey ?? row.id] !== undefined)
	checkUnique(lifecycle.stages.map((row) => row.id), 'lifecycle.json 的 stage id')
	checkUnique(lifecycle.stages.map((row) => row.order), 'lifecycle.json 的 order')
	const commitRows = lifecycle.stages.filter((row) => row.kind === COMMIT_KIND)
	if (commitRows.length !== 1) {
		throw new Error(`dispatch 数据取值不一致：lifecycle.json 的 stage 里 kind='${COMMIT_KIND}' 的行须恰有一行，实得 ${commitRows.length} 行（现存 ${lifecycle.stages.map((row) => row.id).join('、')}）——dispatch_batch 判「在飞」与门禁推进都按这一行划边界：少了则记到收尾的批次永远算在飞，多了则提交这一步能被推到没有下一行的 order`)
	}
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
	// core 那侧的阶段名与词表互验，放在逐行核之后：行级坏（重名/门别不明）先报更指得准的那条，
	// 这道管的是「四件的契约阶段整行缺席」。拆分后装配四件各服务一个固定阶段（ASSEMBLER_CONTRACTS），
	// 四个阶段 id 逐一与 lifecycle 对表：方案/门一/门二此前没有任何机器核，缺行要到出稿时才炸
	// 还报得不像数据问题；施工缺行的具体后果＝根因分类那一档按 stage id 匹配落空，施工 brief
	// 末尾那三行静默停发而其余部分照样出稿。点名报，因为两边都得改
	const missingStages = ASSEMBLER_CONTRACTS.filter((contract) => !lifecycle.stages.some((row) => row.id === contract.stage))
	if (missingStages.length > 0) {
		const detail = missingStages.map((contract) => `${contract.name}＝${contract.stage}`).join('、')
		throw new Error(`dispatch 数据取值不一致：装配工具的阶段行在 lifecycle.json 里缺席（${detail}；现存 ${lifecycle.stages.map((row) => row.id).join('、')}）——四件各按契约阶段出稿，缺行要到出稿时才炸；改 id 要同时改 core（施工缺行还会让根因分类那三行静默停发）`)
	}
}

/**
 * 模板键的白名单＝「lifecycle 各行的模板键」＋那几张不是阶段模板的辅助页（修复批增量、横切
 * 判据、自检清单、裁决、两张必读链）。多出来的键多半是拼错或遗留：它在任何阶段都不会被读到，
 * 留着等于让人以为写了就生效。
 */
const TEMPLATE_AUX_KEYS = ['修复批增量', '横切判据', 'checklist', '裁决', 'AGENTS 必读链·复核', 'AGENTS 必读链·施工']

/** 两张必读链页之间那处唯一的分工差异：复核这一路的 brief 只读，禁写。摘掉它，余下须整篇同形。 */
const REVIEW_ONLY_CLAUSE = '；只读禁写'
const REVIEW_CHAIN_KEY = 'AGENTS 必读链·复核'
const CONSTRUCTION_CHAIN_KEY = 'AGENTS 必读链·施工'

/**
 * 两页除了那一句分工，逐字同形——这不是风格偏好：两份页各写一次必读链与硬约束口径，改一处
 * 忘了另一处，复核那一路的子代理与施工那一路就会对着两份不同的 AGENTS 读同一批文件，而两边的
 * brief 各自看着完整。逐行比某一行比不出这个（差异只该落在分工那一句，其余行照样会漂），故整篇
 * 比、只把分工那一句摘掉。
 *
 * 摘之前先核那句的落位：摘的是「全部出现处」，所以写反（落在施工页）或写重（同一页出现两次）
 * 都会被摘干净后比出「两页同形」而全绿——分工句是这两页唯一的语义差，它走位了那道整篇比对就
 * 正好瞎在那一处。方向与次数都点名报。
 */
function checkChainPair(templates) {
	for (const key of [REVIEW_CHAIN_KEY, CONSTRUCTION_CHAIN_KEY]) {
		if (templates[key] === undefined) {
			throw new Error(`dispatch 数据缺模板键「${key}」——两张必读链辅助页成对消费（复核一路只读禁写、施工一路可写），缺一张时那一路的 brief 少掉必读链与硬约束两句，而键白名单只查「多出来的键」，不报「少写的键」`)
		}
	}
	const occurrences = (text) => text.split(REVIEW_ONLY_CLAUSE).length - 1
	const reviewCount = occurrences(templates[REVIEW_CHAIN_KEY])
	const constructionCount = occurrences(templates[CONSTRUCTION_CHAIN_KEY])
	if (reviewCount !== 1 || constructionCount !== 0) {
		throw new Error(`dispatch 数据两页分工句走位：「${REVIEW_ONLY_CLAUSE}」须在「${REVIEW_CHAIN_KEY}」里恰一次、在「${CONSTRUCTION_CHAIN_KEY}」里不出现，实得前者 ${reviewCount} 次／后者 ${constructionCount} 次——下面那道整篇比对摘的是全部出现处，这一句走位或写重都恰好被摘干净而比出「两页同形」：写反了等于让施工那一路拿到一条做不到的只读约束，写重了等于把那句连同整行从比对里抹掉`)
	}
	const review = templates[REVIEW_CHAIN_KEY].split(REVIEW_ONLY_CLAUSE).join('')
	const construction = templates[CONSTRUCTION_CHAIN_KEY]
	if (review === construction) return
	const left = review.split('\n')
	const right = construction.split('\n')
	// 按两边较长的一侧找第一处不同：只在一侧较短的那些下标上找会漏掉「末尾多出几行」——那正是
	// 有人往一张页尾巴上追加一句时发生的形状
	let at = -1
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		if (left[index] !== right[index]) { at = index; break }
	}
	const where = at === -1 ? `行数不同（复核 ${left.length} 行／施工 ${right.length} 行）` : `第 ${at + 1} 行起`
	throw new Error(`dispatch 数据两页漂移：「${REVIEW_CHAIN_KEY}」与「${CONSTRUCTION_CHAIN_KEY}」除「${REVIEW_ONLY_CLAUSE}」外须整篇逐字相同，${where}（复核：${JSON.stringify(left[at] ?? left.at(-1))}／施工：${JSON.stringify(right[at] ?? right.at(-1))}）——两份页各写一次必读链口径，改一处忘了另一处，复核与施工的子代理就会对着两份口径读同一批文件`)
}

function checkTemplateKeys(data) {
	checkChainPair(data.templates)
	const allowed = new Set([
		...TEMPLATE_AUX_KEYS,
		...data.lifecycle.stages.map((row) => row.templateKey ?? row.id),
	])
	for (const key of Object.keys(data.templates)) {
		if (!allowed.has(key)) {
			throw new Error(`dispatch 数据多出未声明的模板键「${key}」——模板键须是某条 lifecycle 行的 templateKey（或缺省＝stage id），或那几张辅助页（${TEMPLATE_AUX_KEYS.join('、')}）；多出来的键没有任何阶段会读到它`)
		}
	}
	// 反向也查：显式指了 templateKey 却没写那份模板。「缺省＝stage id」的那种不出稿（提交/复盘两行
	// 本就没有模板）由 requireServableStage 在出稿时点名，那句读不出是这一趟不该出稿；显式指了键却
	// 没写模板则是拼错键名，同样只会在出稿时露出来，而那时的报错句与「忘了写模板」一模一样。
	for (const row of data.lifecycle.stages) {
		if (row.templateKey === undefined) continue
		if (data.templates[row.templateKey] === undefined) {
			throw new Error(`dispatch 数据悬空引用：lifecycle.json 的 stage「${row.id}」指了 templateKey「${row.templateKey}」，templates.json 里没有这一键——键名拼错与模板忘了写在这里长得一样`)
		}
	}
}

/**
 * 节奏谓词可核的词表：batchType 对配对表主行行名（addon 行不作 batchType，传它当谓词值那条
 * 规则永不命中）；stage 对本工具能出稿的阶段（提交/复盘归各自的工具，以它们为谓词值同样不可
 * 达）；provider 是两机各自的模型 id，无词表可核。规模参数（diffLines/changedFiles）不在表里
 * ——它们收 {max:N} 区间，比的是数量不是词表中的名字，无词表可核。
 */
const PREDICATE_VOCABULARIES = {
	batchType: mainBatchTypes,
	stage: dispatchStages,
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

/**
 * 安全五问核心子串：两端各取一个短语作锚，在单条 role 串内唯一定位这一段的起止，取中间那一整串
 * （五问本体）。锚点挑短语而不是标点——标点随写法漂（顿号、全角分号、括号），锚漂一次这段校验就
 * 跟着失效，而它守的正是「悄悄失效」那一类：五问在两处角色句里各写一次，写岔一条就是漏查一面。
 * 锚点的「唯一定位」只在单条 role 内成立（全仓另有一处在别的形态里），故计数也只按本条 role 数。
 */
const SAFETY_HEAD = '此用户能操作此资源吗'
const SAFETY_TAIL = 'PII 与 token 进日志吗'

/** 逐条承载五问的形态（单源，测试也认这一份）：这两个 id 是安全那一面唯一的念法来源。 */
export const SAFETY_CARRIER_IDS = ['安全专项', '安全清单行']

const SAFETY_ANCHORS = [SAFETY_HEAD, SAFETY_TAIL]

const occurrencesOf = (text, needle) => text.split(needle).length - 1

/** 形态是否带任一锚点（用来核「有锚的形态是不是该有的那几个」）。 */
const carriesAnchor = (role) => SAFETY_ANCHORS.some((anchor) => role.includes(anchor))

/** 两端锚点之间那一整串；任一端缺失返回 null（缺一端＝那一条五问没写全）。 */
function safetyCoreOf(role) {
	const start = role.indexOf(SAFETY_HEAD)
	const end = role.indexOf(SAFETY_TAIL, start === -1 ? 0 : start)
	if (start === -1 || end === -1) return null
	return role.slice(start, end + SAFETY_TAIL.length)
}

/**
 * 安全五问一致性专核，三道门：
 * ①载体点名：SAFETY_CARRIER_IDS 里的每个 id 都要在 forms 里，且角色句两端锚点齐全——「靠数一数
 *   有几个带锚的形态」守不住这件事，把两个锚点整体改掉就只剩零个或一个，校验自己跟自己比，
 *   恒真放行；
 * ②反向点名：带锚的角色句必须都在那名单里——多出一个载体等于安全那一面有了第三种念法，而它
 *   不受同形校验保护，两边迟早写岔；
 * ③同形与唯一定位：两端锚点在各自 role 内各出现一次（只数锚不数切出来的那一串：把同一段五问
 *   追加一份改写过的小节，切片只数到一次，那一段就这么混进去了），且两份切出的核心串逐字相同。
 *
 * 两份角色句本就该不同——前缀框定语是门别分工（安全专项只查五条、安全清单行逐项过问且答得出
 * 才放行），那种差异不归这条校验管，它管的是中间那串五问本身。五问逐字同形的要求来自它是
 * 同一份规则的两处表述：两份各改一次，迟早只有一处改到。
 */
function checkSafetyQuestions(forms) {
	const byId = new Map(forms.forms.map((form) => [form.id, form]))
	for (const id of SAFETY_CARRIER_IDS) {
		const form = byId.get(id)
		if (form === undefined) {
			throw new Error(`dispatch 数据安全五问载体丢失：forms.json 里没有形态「${id}」——安全那一面的唯一念法没了，复核者无人可派那一路`)
		}
		if (!carriesAnchor(form.role)) {
			throw new Error(`dispatch 数据取值不合：forms.json 的形态「${id}」的安全五问两端锚点不齐（起「${SAFETY_HEAD}」止「${SAFETY_TAIL}」，两个锚点都得在）——锚点整体被改掉时按锚点找载体的判定会跟着失效，这条校验要显式钉住载体本身`)
		}
	}
	const unexpected = forms.forms.filter((form) => carriesAnchor(form.role) && !SAFETY_CARRIER_IDS.includes(form.id))
	if (unexpected.length > 0) {
		throw new Error(`dispatch 数据意外的五问载体：forms.json 的形态「${unexpected[0].id}」的角色句带五问锚点，但它不在载体名单（${SAFETY_CARRIER_IDS.join('、')}）内——多一份念法不受同形校验保护，两边迟早写岔`)
	}
	const cores = new Map()
	for (const id of SAFETY_CARRIER_IDS) {
		const role = byId.get(id).role
		for (const anchor of SAFETY_ANCHORS) {
			const count = occurrencesOf(role, anchor)
			if (count !== 1) {
				throw new Error(`dispatch 数据取值不合：forms.json 的形态「${id}」的安全五问锚点「${anchor}」在角色句里出现 ${count} 次（须恰好一次）——出现多次说明同一段五问被写了两遍（追加的小节迟早与本体写岔），出现 0 次即这一段没写全`)
			}
		}
		cores.set(id, safetyCoreOf(role))
	}
	const [first, ...rest] = SAFETY_CARRIER_IDS
	for (const id of rest) {
		if (cores.get(id) !== cores.get(first)) {
			throw new Error(`dispatch 数据两处表述不一致：forms.json 的形态「${id}」与「${first}」的安全五问核心串不逐字相同（${JSON.stringify(cores.get(id))} vs ${JSON.stringify(cores.get(first))}）——五问是同一份规则的两处表述，改一处就要同改另一处`)
		}
	}
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
 * 只取指定的那几份（按调用方给的顺序，不带跨文件校验），一次读齐两样：解析并验过形的表，
 * 以及这一趟读到的原始字节（键＝文件名）。台账四个动作各要自己那几份——start 只要配对表
 * （批型词表），advance 要阶段表与形态表（阶段词表、形态 id 词表），status/list 要阶段表与
 * 配对表（阶段序、门别、这批型有没有那道门）。把五份连同跨文件校验带一遍不是更严，是白付：
 * 动作不读的那些份坏了也会让台账查询失败，而那与本次查询无关。
 *
 * 字节这一半是给规则指纹用的：指纹要按「规则面当时是这份字节」算（见 batch.js 的
 * rulesHashOf），另起一次读拿到的是另一个时刻的文件——中间改过就是另一个版本，而指纹的全部
 * 用途正是让复盘统计按规则版本分组。advance 本来就要读 pairing 与 forms，指纹便顺手取同一
 * 趟的字节，不必为指纹再读一遍。
 *
 * 读取与形状校验仍走本文件那一份读法（另开一条就是同一份数据两套校验，坏数据会在某条路上
 * 悄悄过去）；跨文件校验只在 loadDispatchData 那条整读路径上。
 */
export function loadDispatchTablesWithBytes({ dataDir, names }) {
	const dir = resolveDataDir(dataDir)
	const tables = {}
	const bytes = {}
	for (const name of names) {
		const entry = DATA_FILES.find((file) => file.name === name)
		if (entry === undefined) throw new Error(`dispatch 现读面没有名为「${name}」的数据文件——名字抄错会读成空表`)
		const read = readDataFileWithBytes(dir, entry)
		tables[name] = read.value
		bytes[entry.file] = read.bytes
	}
	return { tables, bytes }
}

/** 只要表的那一半（读法与校验同上一条，多解一份字节的场合用不上）。 */
export function loadDispatchTables({ dataDir, names }) {
	return loadDispatchTablesWithBytes({ dataDir, names }).tables
}

/**
 * 取若干份数据文件的原始字节（Buffer，按调用方给的顺序）：台账事件里的 rules 字段要的是
 * 「规则面当时是这份字节」的指纹，解析后重新序列化会改字节（键序、缩进、空白），那样的指纹
 * 在两台机器的同一份数据上算不出同一个值，而它的用途正是跨机可重放。这里只读不解析不验形
 * （要形状校验的读法是 loadDispatchData），读取失败与现读面同一句报错，两条路不各说一套。
 */
export function readDataBytes({ dataDir, files }) {
	const dir = resolveDataDir(dataDir)
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
	const dir = resolveDataDir(dataDir)
	const data = {}
	for (const entry of DATA_FILES) data[entry.name] = readDataFile(dir, entry)
	checkNonEmpty(data)
	checkUnique(data.forms.forms.map((form) => form.id), 'forms.json 的形态 id')
	checkUnique(data.pairing.rows.map((row) => row.batchType), 'pairing.json 的批型行名')
	checkLifecycle(data)
	checkSafetyQuestions(data.forms)
	checkTemplateKeys(data)
	checkUnique(data.planSpec.blocks.map((block) => block.id), 'plan-spec.json 的节 id')
	data.warnings = checkCrossLinks(data)
	checkPlaceholders(data.templates)
	return data
}
