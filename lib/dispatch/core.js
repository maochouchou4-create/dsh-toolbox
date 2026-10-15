/**
 * dispatch 装配器的纯函数核心：批型→形态组合（配对表查表＋特殊行语义）、节奏谓词匹配、
 * brief 模板装配、参数契约校验。零宿主依赖、零文件读取——三份数据（forms/pairing/
 * templates）由调用方现读后作为一个对象传进来，于是本文件能被 node:test 直接喂真 JSON
 * 单测（与 lib/memory/core.js 同款分层：纯逻辑在此，IO 在 data.js，工具装配在 index.js）。
 *
 * 判断一件不做：批型终判、要不要加挂、findings 怎么裁决全归主会话。这里只有查表、套模板、
 * 校参数；配对表是起点不是上限——命中全派，主会话可增删（最大化口径）。
 */

/**
 * gate 列→门别名（导出供加载期做门别交叉核：gate1 列只收门一形态）。同一份映射代码与加载
 * 期各拿一份，就是把「哪列是哪道门」这件事悄悄分家一次。
 */
export const GATE_LABELS = { gate1: '门一', gate2: '门二' }

/**
 * stage→这一趟 combo 要出的 gate 列。两个门阶段各出自己那一列；施工阶段出空——复核组合
 * 是复核阶段的产物，施工不预告，门二调用时现取。它同时判「批型条件必填是否成立」：
 * needsBase 行的组合按 baseBatchType 取原批型主行，而组合只在门阶段取。
 *
 * stage 词表与下面两张表的单一真相源是 `lib/dispatch/data/lifecycle.json` 的 stages[]
 * （requires／gate／kind 派生这三张表）；那份数据面就位前，本文件的表过渡自持。
 */
const COMBO_GATES_BY_STAGE = { 门一: ['gate1'], 门二: ['gate2'], 施工: [] }

/** stage 级必填参数矩阵（批型条件必填不在此表——它归配对特殊行的 needsBase/needsRootCause）。 */
const STAGE_REQUIRES = {
	门一: ['batchType', 'subject', 'intent'],
	门二: ['batchType', 'subject', 'intent'],
	施工: ['batchType', 'subject', 'intent', 'anchors'],
}

/** stage 词表（导出给加载期校验：节奏谓词里的 stage 取值对着它核，拼错＝规则永不触发）。 */
export const STAGES = Object.keys(STAGE_REQUIRES)

/** rhythm 谓词里可出现的字段：出现哪个字段就拿本次调用的同名参数去比（导出供加载期规格引用）。 */
export const RHYTHM_FIELDS = ['batchType', 'stage', 'provider']

/** 列表型参数槽位：传 null／非数组是最常见的错法，报错要点名，而不是让它撞上模板替换抛裸 TypeError。 */
const LIST_PARAMS = ['addons', 'decisions', 'anchors']

/**
 * 模板占位：〔…〕。省略规则写在占位文字里（「空则本行省略」），代码只执行它——同一份模板
 * 在不同语义下的省略行不同，规则跟着数据走，代码不另设一份策略。
 */
const PLACEHOLDER = /〔([^〕]*)〕/g
const OPTIONAL_MARK = '空则本行'

/** 行号锚点形态（如 `lib/dispatch/core.js:42`）：锚点以符号名为准，带行号的一律机器告警。 */
const LINE_NUMBER_ANCHOR = /:\d/

/** 施工阶段名＝模板键「施工」＝施工 brief 的 form 标签：一个 token 三处同源，故不另设别名。 */
const CONSTRUCTION_STAGE = '施工'

const isBlank = (value) =>
	value === undefined || value === null
	|| (typeof value === 'string' && value.trim() === '')
	|| (Array.isArray(value) && value.length === 0)

/** 值转成一句人能读的原文，类型错误信息用；undefined 没有 JSON 形态，退回 String()。 */
const describe = (value) => {
	const text = JSON.stringify(value)
	return text === undefined ? String(value) : text
}

const lines = (text) => text.split('\n').filter((line) => line.trim() !== '')

/**
 * 入参形状错时报出签名本身：最常见的错法是只传了 params（以为 data 是隐含的），
 * 那时报出来的是 data.pairing undefined 的 TypeError，读不出是哪一次调用出的问题。
 */
function requireData(data) {
	if (data?.pairing === undefined || data?.forms === undefined || data?.templates === undefined) {
		throw new Error('数据入参缺形——本模块签名一律是 (data, params)，data 须含 forms/pairing/templates 三份现读 JSON')
	}
}

/** 某一趟要出的 gate 列；未知 stage 显式拒绝，不按缺省阶段出稿。 */
function comboGatesForStage(stage) {
	const gates = COMBO_GATES_BY_STAGE[stage]
	if (gates === undefined) throw new Error(`未知 stage「${stage ?? ''}」——本工具的阶段词表＝${STAGES.join('、')}`)
	return gates
}

/** stage 级必填参数（导出供单测核对模板占位与必填矩阵对不对得上）。 */
export function stageRequires(stage) {
	return STAGE_REQUIRES[stage]
}

function findRow(data, batchType) {
	return data.pairing.rows.find((row) => row.batchType === batchType)
}

/**
 * 未命中批型时把全部行名交回主会话自选，并分清两类行：主行（含特殊行）能作 batchType，
 * addon 行只能经 addons 加挂。只列不分就是让调用方对着名单再猜一次。
 */
function unknownBatchTypeError(data, batchType) {
	const isAddon = (row) => row.kind === 'addon'
	const names = (rows) => rows.map((row) => row.batchType).join('、')
	return new Error(
		`未知批型「${batchType ?? ''}」不是配对表的行名——可用主行：${names(data.pairing.rows.filter((row) => !isAddon(row)))}`
		+ `；addon 行（用 addons 参数加挂，不作 batchType）：${names(data.pairing.rows.filter(isAddon))}`,
	)
}

/** 主行：未命中即报错（猜错批型＝漏派形态，比多列一遍行名贵）；addon 行当主批型也报错。 */
function mainRowOf(data, batchType) {
	const row = findRow(data, batchType)
	if (row === undefined) throw unknownBatchTypeError(data, batchType)
	if (row.kind === 'addon') {
		throw new Error(`「${batchType}」是加挂行不是批型——请传主批型作 batchType，用 addons 参数加挂`)
	}
	return row
}

/** 加挂行：只收 kind='addon' 的行——主行/特殊行进 addons 会被并集并进去，等于绕过主批型判定。 */
function addonRowOf(data, name) {
	const row = findRow(data, name)
	if (row === undefined) throw new Error(`addons 含配对表里没有的行名「${name}」`)
	if (row.kind !== 'addon') throw new Error(`「${name}」是主批型/特殊行——addons 只收加挂行`)
	return row
}

/**
 * 某一 gate 上该行给出哪些形态，连同「是哪一行给出的」。formNotes 是「行×形态」的限定句，
 * 按真正提供这个形态的那一行取——修复批的组合来自 baseBatchType 那一行，取主行的限定句
 * 就是把一句话安到别的批型头上。
 * 行内自带就取自带的，空的按行上的 needsBase 处理（落回 baseBatchType 取原批型主行），或
 * 显式说明这个批型不走这道门。几处都拒绝：缺原批型、原批型不是主行、原批型行名不存在、
 * 原批型在这一列也是空的——静默出稿的代价是漏派一整门复核。
 */
function formsOfRow(data, row, gate, baseBatchType) {
	const forms = row[gate]
	if (forms !== null && forms !== undefined) return { row, forms }
	if (row.needsBase !== true) {
		throw new Error(`批型「${row.batchType}」不走${GATE_LABELS[gate]}——该行的${GATE_LABELS[gate]}是空的且行上未标 needsBase（即不经 baseBatchType 取组合），请改用配对表给这个批型定的阶段`)
	}
	if (isBlank(baseBatchType)) {
		throw new Error(`批型「${row.batchType}」的${GATE_LABELS[gate]}需 baseBatchType（行上标了 needsBase＝按原批型主行取组合）——特殊行缺原批型即拒绝出稿，不猜`)
	}
	const base = findRow(data, baseBatchType)
	if (base === undefined) throw new Error(`baseBatchType「${baseBatchType}」不是配对表的行名`)
	if (base.kind === 'addon') throw new Error(`baseBatchType「${baseBatchType}」是加挂行不是主批型——加挂走 addons 参数，baseBatchType 只收主行`)
	const baseForms = base[gate]
	if (baseForms === null || baseForms === undefined) {
		throw new Error(`baseBatchType「${baseBatchType}」的${GATE_LABELS[gate]}也是空的——「按原批型主行取组合」这条解析走不通，换一个原批型`)
	}
	return { row: base, forms: baseForms }
}

/**
 * 这一趟的形态组合：每项带来源配对行（限定句按来源行取）。主行命中取该 gate 组合，
 * 加挂行并集叠加去重。
 */
function resolveForms(data, params) {
	const gates = comboGatesForStage(params.stage)
	const sources = [mainRowOf(data, params.batchType)]
	for (const addon of params.addons ?? []) sources.push(addonRowOf(data, addon))
	const picked = []
	for (const source of sources) {
		for (const gate of gates) {
			for (const id of formsOfRow(data, source, gate, params.baseBatchType).forms) {
				if (!picked.some((entry) => entry.form === id)) picked.push({ form: id, row: source })
			}
		}
	}
	return picked
}

/** 批型＋阶段＋加挂 → 推荐形态组合，每形态一句理由（「专抓什么」即理由）。 */
export function computeCombo(data, params = {}) {
	requireData(data)
	return resolveForms(data, params).map(({ form }) => ({ form, reason: formOf(data, form).catches }))
}

/**
 * 节奏提示：`when` 的每个在字段＝「本次调用参数值 ∈ 数组」，字段缺省＝不限，全部在字段
 * 命中才输出该 note，多命中全出，无命中输出空数组。含 provider 字段的条目在未传 provider
 * 时不命中（缺参不命中，不当默认值）。
 */
export function matchRhythm(data, params = {}) {
	requireData(data)
	return data.pairing.rhythm
		.filter((entry) => RHYTHM_FIELDS.every((field) => {
			const allowed = entry.when?.[field]
			if (allowed === undefined) return true
			return Array.isArray(allowed) && allowed.includes(params[field])
		}))
		.map((entry) => entry.note)
}

/** 形态条目；配对表引用了未定义的 id 时显式报错，理由与角色句都从这里取。 */
function formOf(data, form) {
	const found = data.forms.forms.find((entry) => entry.id === form)
	if (found === undefined) throw new Error(`配对表引用了 forms.json 里没有的形态 id「${form}」`)
	return found
}

/** 方案任务书模板的两条占位：登记在此是为了让加载期校验认得模板里的它们（数据面先于接线就位），真被渲染到即报错，不返回半截模板。 */
function notWired() {
	throw new Error('方案任务书模板未接线（lifecycle/plan-spec 数据未上线）')
}

/**
 * 占位登记表：模板里每个 〔…〕 都要在这里有一行，键取占位文字的首段（模板里占位带说明
 * 文字，如〔decisions 逐条；空则本行省略〕登记为 decisions）。加载期由 data.js 核对模板里
 * 的占位是否都在册——未登记的占位留到渲染期才炸，等于规则删了不报错。
 */
const PLACEHOLDER_REGISTRY = {
	形态角色句: (context) => context.role,
	下文四条原文: (context) => context.data.templates.横切判据,
	intent: (context) => context.params.intent,
	subject: (context) => context.params.subject,
	anchors: (context) => (context.params.anchors ?? []).join('、'),
	decisions: (context) => (context.params.decisions ?? []).join('；'),
	forbidden: (context) => context.params.forbidden,
	verifyCmd: (context) => context.params.verifyCmd,
	rootCause: (context) => context.params.rootCause,
	'plan-spec 13 节逐字': notWired,
	'plan-spec checklist': notWired,
}

/** 一段文本里的占位 token（加载期核对登记表用；占位语法只有这一处定义）。 */
export function placeholderTokens(text) {
	return [...text.matchAll(PLACEHOLDER)].map((match) => match[1])
}

/** 占位是否已登记（按前缀匹配，与渲染期同一套规则；两处各判一次就会各错一次）。 */
export function isRegisteredPlaceholder(token) {
	return Object.keys(PLACEHOLDER_REGISTRY).some((prefix) => token.startsWith(prefix))
}

function resolvePlaceholder(context, token) {
	for (const [prefix, resolve] of Object.entries(PLACEHOLDER_REGISTRY)) {
		if (token.startsWith(prefix)) return resolve(context)
	}
	throw new Error(`模板占位未登记：〔${token}〕——渲染器不猜占位语义`)
}

/** 一行里的「空则本行」可选占位；多于一个即报错（见 renderTemplate）。 */
function optionalTokensOf(line) {
	return [...line.matchAll(PLACEHOLDER)].map((match) => match[1]).filter((token) => token.includes(OPTIONAL_MARK))
}

/**
 * 渲染一份 brief：逐行处理，行内出现「空则本行」的占位且取值为空即整行丢，其余占位
 * 按登记表代入。一行里出现多个可选占位即报错：删不删这行没有唯一答案，渲染器不替模板
 * 做取舍。brief 缺一句固定段是要漏网复核的，渲染器因此不做空值兜底。
 */
function renderTemplate(data, params, template, role) {
	const context = { data, params, role }
	return template
		.split('\n')
		.filter((line) => {
			const optional = optionalTokensOf(line)
			if (optional.length > 1) throw new Error(`模板一行里出现多个「空则本行」可选占位（${optional.join('、')}）——可选占位须独占一行，否则这行删不删没有唯一答案`)
			if (optional.length === 0) return true
			return !isBlank(resolvePlaceholder(context, optional[0]))
		})
		.map((line) => line.replace(PLACEHOLDER, (_, token) => resolvePlaceholder(context, token)))
		.join('\n')
}

/**
 * 批型的两个条件必填，读配对行上的字段（needsBase/needsRootCause）而不按批型名硬编码——
 * 这类语义随配对表演进，代码内置表会让「改了 JSON 没改代码」变成静默分家。
 * needsBase 只在这一趟要出的组合门里存在空列时才成立：新功能·形态未定的门一自带形态，
 * 那一趟不落回 baseBatchType，也就不该向主会话要它（要了不用＝契约撒谎）。
 */
function needsBaseForStage(data, batchType, stage) {
	const row = findRow(data, batchType)
	if (row?.needsBase !== true) return false
	return comboGatesForStage(stage).some((gate) => row[gate] === null || row[gate] === undefined)
}

/** needsRootCause 说这类批型要有根因分类；只有施工阶段消费它（门一/门二模板无〔rootCause〕占位）。 */
function needsRootCauseForStage(data, batchType, stage) {
	return stage === CONSTRUCTION_STAGE && findRow(data, batchType)?.needsRootCause === true
}

/** 该 stage 的模板；带 needsRootCause 的批型在施工模板上追加根因分类／红灯先行／变异抽查三行。 */
function briefTemplate(data, params) {
	const base = data.templates[params.stage]
	if (base === undefined) throw new Error(`templates.json 没有 stage「${params.stage}」的模板`)
	if (!needsRootCauseForStage(data, params.batchType, params.stage)) return base
	const increment = data.templates['修复批增量']
	if (increment === undefined) throw new Error('templates.json 缺「修复批增量」——带 needsRootCause 的批型在施工阶段要追加这三行')
	return `${base}\n${increment}`
}

/**
 * 该形态路 brief 的开头：角色句，带 extras 的形态把 extras 接在角色句后；行上有这个形态的
 * formNotes 时，限定句紧跟角色句——它是这个形态在这个批型下的执行口径，放在角色句后面
 * 才是它作用的位置。
 */
function briefHead(data, entry, row) {
	const note = row.formNotes?.[entry.id]
	if (note !== undefined) return `${entry.role}\n批型限定：${note}。`
	if (entry.extras !== undefined) return `${entry.role}\n${entry.extras}`
	return entry.role
}

/**
 * 每路 brief＝{form, text}。两个门阶段逐形态各一路（形态角色句逐字带入，批型限定与 extras
 * 都只附在该形态那路）；施工阶段一路——施工模板不带角色句，逐形态渲染只会产出多份逐字
 * 相同的文本。
 */
export function assembleBrief(data, params) {
	requireData(data)
	validateParams(data, params)
	const template = briefTemplate(data, params)
	if (params.stage === CONSTRUCTION_STAGE) {
		return [{ form: CONSTRUCTION_STAGE, text: renderTemplate(data, params, template, '') }]
	}
	return resolveForms(data, params).map(({ form, row }) => {
		const entry = formOf(data, form)
		return { form, text: renderTemplate(data, params, template, briefHead(data, entry, row)) }
	})
}

/**
 * 列表槽位的类型边界：可省略，给了就得是字符串数组（空数组＝这一项没有条目）。传 null／
 * 非数组／元素非串一律点名报错——null 与「没传」在 JSON 里长得一样，静默当没传等于让主
 * 会话以为自己加挂了什么东西。
 */
function assertListParams(params) {
	for (const field of LIST_PARAMS) {
		const value = params[field]
		if (value === undefined) continue
		if (Array.isArray(value) && value.every((item) => typeof item === 'string')) continue
		throw new Error(`参数「${field}」须是字符串数组（可省略；空数组＝没有条目），实得 ${describe(value)}`)
	}
}

/**
 * 参数契约校验：缺必填即拒绝出稿（fail fast，错误信息点名缺哪几个）。必填＝stage 级矩阵
 * ＋批型条件必填（读配对行的 needsBase/needsRootCause），两层都过才出稿；类型边界也在这
 * 一层收口——必填槽位传了非字符串（0/false/对象）点名拒，不让它飘进模板替换。
 * 不消费 baseBatchType 的阶段（施工）收到它即报错：组合门在门一/门二，静默忽略一个参数
 * 等于让调用方以为自己改了组合。
 */
export function validateParams(data, params = {}) {
	requireData(data)
	assertListParams(params)
	const stage = params.stage
	const required = STAGE_REQUIRES[stage]
	if (required === undefined) throw new Error(`未知 stage「${stage ?? ''}」——本工具的阶段词表＝${STAGES.join('、')}`)
	const slots = [...required]
	if (needsBaseForStage(data, params.batchType, stage)) slots.push('baseBatchType')
	if (needsRootCauseForStage(data, params.batchType, stage)) slots.push('rootCause')
	const missing = []
	for (const field of slots) {
		if (isBlank(params[field])) {
			missing.push(field)
		} else if (!LIST_PARAMS.includes(field) && typeof params[field] !== 'string') {
			throw new Error(`参数「${field}」须是字符串，实得 ${describe(params[field])}`)
		}
	}
	if (missing.length > 0) {
		throw new Error(`stage=${stage}／batchType=${params.batchType} 缺必填参数：${missing.join('、')}——缺必填不出稿`)
	}
	if (!isBlank(params.baseBatchType) && comboGatesForStage(stage).length === 0) {
		throw new Error(`stage=${stage} 不消费 baseBatchType——组合门在门一/门二，删掉它或改调门二`)
	}
}

/** 行号锚点告警：带 `:数字` 的锚点逐条点名。行号会随文件变动漂移，符号名才 grep 得到。 */
function anchorWarnings(anchors = []) {
	const withLineNumber = anchors.filter((anchor) => LINE_NUMBER_ANCHOR.test(anchor))
	if (withLineNumber.length === 0) return []
	return [`锚点含行号形态：${withLineNumber.join('、')}——锚点以符号名为准（行号随文件变动漂移、grep 不到），请改成符号名`]
}

/**
 * dispatch 的完整输出：先校参数（不校就出稿＝brief 少固定段而没人知道），再装配三件套。
 * checklist 与 adjudication 在输出 schema 里是 string[]，模板却是整块文本：按行拆成逐条
 * （裁决段逐条过、自检四条逐条过，整块塞进一个元素等于把数组类型退化成包装）。
 */
export function assembleDispatch(data, params) {
	requireData(data)
	validateParams(data, params)
	return {
		combo: computeCombo(data, params),
		briefs: assembleBrief(data, params),
		rhythm: matchRhythm(data, params),
		checklist: lines(data.templates.checklist),
		rejected: [...data.forms.rejected],
		warnings: anchorWarnings(params.anchors),
		adjudication: lines(data.templates.裁决),
	}
}
