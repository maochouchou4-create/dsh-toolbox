/**
 * dispatch 装配器的纯函数核心：批型→形态组合（配对表查表＋特殊行语义）、节奏谓词匹配、
 * brief 模板装配、参数契约校验。零宿主依赖、零文件读取——五份数据（forms/pairing/templates/
 * lifecycle/planSpec）由调用方现读后作为一个对象传进来，于是本文件能被 node:test 直接喂真
 * JSON 单测（与 lib/memory/core.js 同款分层：纯逻辑在此，IO 在 data.js，工具装配在 index.js）。
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
 * GATE_LABELS 的反查：复核阶段的 id（＝门别名）→ 该去读配对表的哪一列。导出台账也要用同一张
 * 表（batch.js 的门禁推导）——各算一份的话，哪天门列加一道就有一处推不出门禁，而台账那句
 * 「判不出这批走不走这道门」与真判不出长得一样。
 */
export const GATE_COLUMN_BY_LABEL = Object.fromEntries(Object.entries(GATE_LABELS).map(([column, label]) => [label, column]))

/**
 * lifecycle 行的 kind 取值：复核阶段按配对表逐形态各出一路 brief，其余阶段单路出稿
 * （方案/施工模板不带角色句，逐形态渲染只会产出多份逐字相同的文本）。导出供加载期校验：
 * 「这一行是不是复核阶段」两处各判一次就会各错一次。
 */
export const REVIEW_KIND = '复核'

/**
 * 数值型槽位（参数面 type:'number' 的那几个）：空判据 isBlank 对它们无效——0 是有效取值（零行
 * 净 diff 正是免派那一档），不能用「给了但空」那套判据把它读成没给。类型在 validateParams
 * 里点名，不留到 rhythm 谓词那里才表现成「没命中」的空结果。导出供加载期按字段类别分形态（枚举
 * 组收字符串数组、规模组收 {min:N}/{max:N} 区间）——规模参数就是这批数值槽位，两处各列一份就会有一处
 * 漏了某个字段，而漏的那处谓词按一种永不可能的形态比对，那条规则静默失效。
 */
export const NUMERIC_PARAMS = ['diffLines', 'changedFiles']

/**
 * rhythm 谓词里可出现的字段：出现哪个字段就拿本次调用的同名参数去比（导出供加载期规格引用）。
 * 末两项是规模参数（数值槽位单源），取值形态与前三个不同——它们按 {min:N}/{max:N} 区间比，不按枚举比
 * （见 matchRhythm）。
 */
export const RHYTHM_FIELDS = ['batchType', 'stage', 'provider', ...NUMERIC_PARAMS]

/**
 * 装配族（dispatch_plan/review/build/verify）参数的全体名字（导出供加载期核 requires 的取值域、
 * 参数面核键集并集）：四件的参数面各自是这份清单的子集，谁声明谁消费由参数面按消费集现算。
 * stage 不在其中——它不是调用方参数：装配层按工具契约把阶段常量注进 params（见 ASSEMBLER_CONTRACTS
 * 与装配层 execute 的注入点），调用方传 stage 由 execute 的未知键守卫拒收。RHYTHM_FIELDS 仍含
 * stage，因为注入后的 params 会被节奏谓词读——两份清单各管一头，不互为子集。
 */
export const PARAM_FIELDS = [
	'batchType', 'subject', 'intent', 'baseBatchType', 'batch',
	'decisions', 'addons', 'anchors', 'forbidden', 'verifyCmd', 'rootCause', 'provider',
	'diffLines', 'changedFiles',
]

/**
 * 与阶段无关的槽位：provider 由 rhythm 谓词读，任何一趟传了都算数，故不按模板占位差分；规模
 * 参数（diffLines/changedFiles）同理——它们只喂节奏谓词，不进任何模板；batch 是台账回填的入口，
 * 装配层拿到它就去拉该批的拍板清单/批型/意图，与这一趟出不出稿无关。
 * decisions 不在这里——它在派发/施工模板里成行，方案任务书那一趟没有它（方案是给用户拍板的
 * 输入，不是已拍板的载体），按占位差分才是「这一趟真的消费了吗」的答案。
 */
const UNIVERSAL_PARAMS = ['provider', 'batch', 'diffLines', 'changedFiles']

/**
 * 台账回填契约（core 与 batch.js 共用的单源，回填遍历按它走；batch.js 只 import 不另立一份）：
 * BACKFILL_FIELDS＝start 事件里「可回填给装配调用」的槽位基础集，顺序照 startEvent 的字段序；
 * BACKFILL_EXCLUDE＝按阶段排除的回填格——门二那一趟的 subject 语义是净 diff 生成命令，与台账
 * 登记的方案路径是两个对象，回填它等于把两样东西混进一格。排除只作用于回填遍历，不作用于
 * schema required 派生（schemaRequiredOf 只减 BACKFILL_FIELDS）：门二的 subject 因此是「schema
 * 不拦、运行期必填、台账不补」的三重口径，三种状态各有各的出处。
 */
export const BACKFILL_FIELDS = ['batchType', 'baseBatchType', 'intent', 'subject', 'decisions']
export const BACKFILL_EXCLUDE = { [GATE_LABELS.gate2]: ['subject'] }

/**
 * 台账 subject 的占位字面量：start 时还不知道方案路径就先这么登记，回填把它当「没登记」处理
 * （不比对、不用它补、有显式值照显式的出），并在输出里提醒补记。字面量单源供批 4 的 start 门
 * 与写侧校验引用，两处各写一份『（待写）』就会有一处先漂。
 */
export const SUBJECT_PLACEHOLDER = '（待写）'

/** 组合解析那一路读的三项：有门列的阶段才走那条路，主批型、加挂、原批型都在那儿被读。 */
const COMBO_PARAMS = ['batchType', 'addons']

/**
 * 批型条件槽位：消费与否既看阶段也看批型行上的条件（needsBase/needsRootCause 那两个既有语义），
 * 于是「谁消费它」必须连条件一起点名，光说阶段名与事实相反（门一传 rootCause 被拒，而施工的
 * 修复批确实要它）。applies＝这一趟有没有那个位置；holders＝配了那个条件的批型行。
 *
 * 导出：holders 是「哪些行带这个条件」的唯一判定处，参数面要在描述里现读这份名单。参数面早先
 * 自己按条件字段名 filter 一遍，同一个判定落了两处——改条件字段名（或给某行加条件）时描述里的
 * 名单会停在旧口径，而那份名单是模型选 baseBatchType 的唯一依据。condition 一并留着：holders
 * 为空时要说人话要报「配对表里没有任何一行标 needsBase」，那个字段名也出自这张表。
 */
export const CONDITION_PARAMS = {
	baseBatchType: {
		condition: 'needsBase',
		applies: (data, stage) => comboGatesForStage(data, stage).length > 0,
		holders: (data) => data.pairing.rows.filter((row) => row.needsBase === true).map((row) => row.batchType),
		unusedBecause: '此门主行列非空，不需要 baseBatchType',
	},
	rootCause: {
		condition: 'needsRootCause',
		applies: (data, stage) => stage === CONSTRUCTION_STAGE,
		holders: (data) => data.pairing.rows.filter((row) => row.needsRootCause === true).map((row) => row.batchType),
		unusedBecause: '这一趟的批型行没标 needsRootCause，施工模板不追加根因分类那三行',
	},
}

/**
 * 某些槽位「这一趟为什么不该要它」得说人话：光列消费它的阶段，模型会当成漏了而反复重试。
 * 这里只放语义解释（规则本身怎么定的），阶段名单一律现算。
 */
const UNCONSUMED_EXPLANATIONS = {
	decisions: '方案是给用户拍板的输入，不是已拍板的载体：拍板清单随派发/施工阶段的 brief 下发',
}

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

/**
 * 根因分类那一档只在施工阶段消费：修复批增量三行挂在施工模板后面，门阶段与方案都不带它。
 *
 * 导出：数据加载期拿它与 lifecycle 阶段词表互验。改这份字面量而不改 lifecycle.json 时，
 * 施工阶段的根因三行会静默停发——那三行挂在 needsRootCause 的批型上，不点名 stage 的任何
 * 校验都看不出来，而少掉三行的 brief 照样出稿，看着完整。
 */
export const CONSTRUCTION_STAGE = '施工'

/**
 * 提交那一行的 kind：台账判「在飞」与门禁推进都按它筛行，而落空/落重的症状都是静默的——少了
 * 则记到收尾的批次永远算在飞，多了则提交这一步能被推到没有下一行的 order。
 *
 * 与 CONSTRUCTION_STAGE 同款理由（字面量单源，数据加载期互验）：代码里不按 stage id 硬编码，
 * 也不按 kind 硬编码到第二处，只认这份常量；数据面那一侧由 data.js 的装载期校验按它核「恰有
 * 一行」。
 */
export const COMMIT_KIND = '提交'

/**
 * 方案阶段的 id：拆分后它以「工具」而非「参数」的形式出现（dispatch_plan），id 字面量仍要给
 * ASSEMBLER_CONTRACTS 与 lifecycle 互验用，不能散在装配层各处。
 */
export const PLAN_STAGE = '方案'

/**
 * 复盘阶段的 id：台账写侧按它记收尾事件，复盘辅助按它认全仓销账点——两处各写字面量就会有一处
 * 先漂（漂了的症状是静默的：lessons 筛不到复盘事件就永远走全量路，统计照常出稿）。与
 * CONSTRUCTION_STAGE 同款理由：字面量单源在这里，LIFECYCLE_KINDS 与 lessons.js 都引这一份。
 */
export const RETROSPECTIVE_STAGE = '复盘'

/**
 * 拆分后四件装配工具的注册契约：工具名↔阶段一一对应，装配层按它把阶段常量注进 params——
 * core 全程只认 params.stage（调用方的注入载体），不知道也不该知道工具名的存在。导出供：
 * ① 装配层按这份表逐件注册（一件一行，工具级隔离现机制承重，四件并一行注册＝隔离没了）；
 * ② 数据加载期把四个阶段 id 与 lifecycle 互验（方案/门一/门二此前无任何机器核，缺行会到
 * 出稿时才炸，还报得不像数据问题）。改动这份表而不改 lifecycle.json（或反之）即加载期报错。
 */
export const ASSEMBLER_CONTRACTS = [
	{ name: 'dispatch_plan', stage: PLAN_STAGE },
	{ name: 'dispatch_review', stage: GATE_LABELS.gate1 },
	{ name: 'dispatch_build', stage: CONSTRUCTION_STAGE },
	{ name: 'dispatch_verify', stage: GATE_LABELS.gate2 },
]

/**
 * lifecycle 行的 kind 取值域，装载期那道的形状规格按它现读拼（枚举名单抄进 data.js 就是第二份
 * 真相源：加了新 kind 而形状规格没跟上，那一行加载即失败，加了形状规格而 core 没跟上就静默落域外）。
 * 顺序即阶段表里的顺序，报错句读起来与 lifecycle.json 对得上。
 */
export const LIFECYCLE_KINDS = ['方案', REVIEW_KIND, CONSTRUCTION_STAGE, COMMIT_KIND, RETROSPECTIVE_STAGE]

const isBlank = (value) =>
	value === undefined || value === null
	|| (typeof value === 'string' && value.trim() === '')
	|| (Array.isArray(value) && value.length === 0)

/**
 * 值转成一句人能读的原文，类型错误信息用；undefined 没有 JSON 形态，退回 String()。
 * 非有限数（NaN／Infinity）同样退回 String()：JSON.stringify 把它们打成 null，报错于是指向
 * 「实得 null」——与调用方真正传进去的值毫无关系，指错方向比不指更费事。
 */
const describe = (value) => {
	if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
	const text = JSON.stringify(value)
	return text === undefined ? String(value) : text
}

const lines = (text) => text.split('\n').filter((line) => line.trim() !== '')

/**
 * 入参形状错时报出签名本身：最常见的错法是只传了 params（以为 data 是隐含的），
 * 那时报出来的是 data.pairing undefined 的 TypeError，读不出是哪一次调用出的问题。
 */
function requireData(data) {
	if (data?.pairing === undefined || data?.forms === undefined || data?.templates === undefined
		|| data?.lifecycle === undefined || data?.planSpec === undefined) {
		throw new Error('数据入参缺形——本模块签名一律是 (data, params)，data 须含 forms/pairing/templates/lifecycle/planSpec 五份现读 JSON')
	}
}

/**
 * stage 词表（导出给加载期校验：节奏谓词里的 stage 取值对着它核，拼错＝规则永不触发）。
 * 按 lifecycle 的 order 排，与阶段先后同一口径——现读不缓存，加 stage＝改 JSON 不改代码。
 */
export function stageVocabulary(data) {
	return [...data.lifecycle.stages]
		.sort((left, right) => left.order - right.order)
		.map((row) => row.id)
}

/** 某一趟的阶段行；未知 stage 显式拒绝，不按缺省阶段出稿。拆分后 stage 由装配层按工具契约注入，运行期到不了这里除非注入面自身漂了——名单照契约表现算，不手抄工具名。 */
function stageRowOf(data, stage) {
	const row = data.lifecycle.stages.find((entry) => entry.id === stage)
	if (row === undefined) {
		const servable = ASSEMBLER_CONTRACTS.map((contract) => `${contract.name}＝${contract.stage}`).join('、')
		throw new Error(`未知 stage「${stage ?? ''}」——装配四件各服务一个固定阶段（${servable}）；提交/复盘由 dispatch_batch/dispatch_lessons 服务（那两个工具各占胶水 FEATURES 一行，那一行没启用时调它们会报未知工具）`)
	}
	return row
}

/**
 * 这一趟 combo 要出的 gate 列：kind＝复核 的阶段出它对应的那一列，其余阶段出空——复核组合
 * 是复核阶段的产物，方案/施工不预告，门二调用时现取。它同时判「批型条件必填是否成立」：
 * needsBase 行的组合按 baseBatchType 取原批型主行，而组合只在门阶段取。
 *
 * 复核阶段的 id 不在门别映射内时出空而不是报错：门别映射是代码侧那张固定表，而 lifecycle 是
 * 数据面，临时数据（单测现造的阶段副本）不必先扩代码就能被认下；真数据里这种行由 data.js
 * 的加载期校验拦下，不靠本函数兜。
 */
function comboGatesForStage(data, stage) {
	if (stageRowOf(data, stage).kind !== REVIEW_KIND) return []
	const column = GATE_COLUMN_BY_LABEL[stage]
	return column === undefined ? [] : [column]
}

/** stage 级必填参数（导出供单测核对模板占位与必填矩阵对不对得上）。 */
export function stageRequires(data, stage) {
	return stageRowOf(data, stage).requires
}

/**
 * schema 层 required 的派生公式（单测直调比对，不手抄名单）：lifecycle requires 是必填的单源，
 * 其中回填基础集（BACKFILL_FIELDS）那几格不标 required——宿主按 schema 拦必填发生在进 execute
 * 之前，而那些值本来就该由台账回填补上，标了 required 回填就永远到不了；运行期必填判定仍归
 * validateParams（回填之后按数据点名），两层是先后关系不是二选一。BACKFILL_EXCLUDE 不参与
 * 这道派生：门二的 subject 不在回填面里，也就不该从 required 里减掉。
 */
export function schemaRequiredOf(data, stage) {
	return stageRequires(data, stage).filter((field) => !BACKFILL_FIELDS.includes(field))
}

/**
 * 该 stage 走哪张模板；顺带当单路 brief 的 form 标签（门一/门二逐形态出路由形态 id 命名）。
 * 模板键取自 lifecycle 行的 templateKey，缺省＝stage id：键名与阶段不同名的那一档（方案阶段
 * 的模板键是「方案任务书」）写在数据里，代码不再带那张表——加一个键名不同的阶段＝改 JSON。
 */
export function templateKeyOf(data, stage) {
	const row = stageRowOf(data, stage)
	return row.templateKey ?? row.id
}

/** 该 stage 是否消费 plan-spec 数据（判据＝lifecycle 行的 uses 引用了它，不按阶段名硬编码）。 */
function usesPlanSpec(data, stage) {
	return (stageRowOf(data, stage).uses ?? []).includes('plan-spec.json')
}

/**
 * 能出稿的阶段＝lifecycle 里有、且 templates 里有着模板的那些（导出供节奏谓词的 stage 字段
 * 词表与数据面校验）。拆分后 stage 不再是工具参数，这份名单不再拼进任何参数描述；提交/复盘
 * 两行在 lifecycle 里先成文，但它们服务的是台账与复盘两个工具，不含模板故被本名单滤掉。
 */
export function dispatchStages(data) {
	return stageVocabulary(data).filter((stage) => data.templates[templateKeyOf(data, stage)] !== undefined)
}

/**
 * 配对表行的 kind 取值：加挂行只经 addons 加挂、不作 batchType；特殊行用 needsBase/
 * needsRootCause 表达批型条件。收成常量是因为「哪些行算主行」要被 core 的查表、参数面与台账的
 * 词表、加载期的谓词词表五处判同一件事，字面量各写一份就有一处拼错，而拼错的那处把加挂行当
 * 批型报了出去。
 */
const ADDON_KIND = 'addon'
const SPECIAL_KIND = 'special'

const isAddonRow = (row) => row.kind === ADDON_KIND

/**
 * 主行词表（非加挂行的行名）：batchType 只收主行。参数面与台账的取值清单、加载期的谓词词表、
 * 查表报错时列给调用方的名字清单都取这一份——「哪些行算主行」这件事此前在这几处各判一次。
 */
export function mainBatchTypes(data) {
	return data.pairing.rows.filter((row) => !isAddonRow(row)).map((row) => row.batchType)
}

/** 特殊行词表（kind＝special）：带批型条件的那几行，参数面按「带不带 baseBatchType」分开列。 */
export function specialHolders(data) {
	return data.pairing.rows.filter((row) => row.kind === SPECIAL_KIND).map((row) => row.batchType)
}

function findRow(data, batchType) {
	return data.pairing.rows.find((row) => row.batchType === batchType)
}

/**
 * 未命中批型时把全部行名交回主会话自选，并分清两类行：主行（含特殊行）能作 batchType，
 * addon 行只能经 addons 加挂。只列不分就是让调用方对着名单再猜一次。
 */
function unknownBatchTypeError(data, batchType) {
	const addons = data.pairing.rows.filter(isAddonRow).map((row) => row.batchType)
	return new Error(
		`未知批型「${batchType ?? ''}」不是配对表的行名——可用主行：${mainBatchTypes(data).join('、')}`
		+ `；addon 行（用 addons 参数加挂，不作 batchType）：${addons.join('、')}`,
	)
}

/** 主行：未命中即报错（猜错批型＝漏派形态，比多列一遍行名贵）；addon 行当主批型也报错。 */
function mainRowOf(data, batchType) {
	const row = findRow(data, batchType)
	if (row === undefined) throw unknownBatchTypeError(data, batchType)
	if (isAddonRow(row)) {
		throw new Error(`「${batchType}」是加挂行不是批型——请传主批型作 batchType，用 addons 参数加挂`)
	}
	return row
}

/** 加挂行：只收 kind＝addon 的行——主行/特殊行进 addons 会被并集并进去，等于绕过主批型判定。 */
function addonRowOf(data, name) {
	const row = findRow(data, name)
	if (row === undefined) throw new Error(`addons 含配对表里没有的行名「${name}」`)
	if (!isAddonRow(row)) throw new Error(`「${name}」是主批型/特殊行——addons 只收加挂行`)
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
	if (isAddonRow(base)) throw new Error(`baseBatchType「${baseBatchType}」是加挂行不是主批型——加挂走 addons 参数，baseBatchType 只收主行`)
	const baseForms = base[gate]
	if (baseForms === null || baseForms === undefined) {
		throw new Error(`baseBatchType「${baseBatchType}」的${GATE_LABELS[gate]}也是空的——「按原批型主行取组合」这条解析走不通，换一个原批型`)
	}
	return { row: base, forms: baseForms }
}

/**
 * 这一趟判不判批型：stage 级必填矩阵里有 batchType 才判。方案阶段不判——那一趟产出的是方案
 * 规范骨架，没有行可查、有行也无处安放，于是 combo 与 brief 路由都是空的。
 */
function judgesBatchType(data, stage) {
	return stageRequires(data, stage).includes('batchType')
}

/**
 * 这一趟的形态组合：每项带来源配对行（限定句按来源行取）。主行命中取该 gate 组合，
 * 加挂行并集叠加去重。不判批型的阶段直接出空——行都取不出来，组合无从谈起。
 */
function resolveForms(data, params) {
	if (!judgesBatchType(data, params.stage)) return []
	const gates = comboGatesForStage(data, params.stage)
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
 * 一个在字段是否命中。`when` 的取值两种形态：字符串数组＝枚举（本次参数值 ∈ 数组）；
 * `{min:N}`/`{max:N}`＝规模区间（min 是「本次值 ≥ N」、max 是「≤ N」，两键至少一键，只对数值
 * 参数成立——字符串与数字无从比较；一键都不给的对象由加载期拦下，见 data.js 的 minMaxBound）。
 * 字段缺省＝不限，在字段而本次没给＝不命中（缺参不命中，不当默认值：没传规模与规模超了是两回事）。
 */
const rhythmValueMatches = (allowed, value) => {
	if (Array.isArray(allowed)) return allowed.includes(value)
	if (typeof value !== 'number') return false
	return (allowed.min === undefined || value >= allowed.min)
		&& (allowed.max === undefined || value <= allowed.max)
}

/**
 * 节奏提示：`when` 的每个在字段都要命中才输出该 note，多命中全出，无命中输出空数组。
 *
 * 输出只是提示层：不命中不拦这一趟出稿，派不派仍归主会话裁量（机判给下限——它给的是「这一趟
 * 值不值得加门」，而派不派的代价与漏网的风险不对称，那笔账归主会话）。
 */
export function matchRhythm(data, params = {}) {
	requireData(data)
	return data.pairing.rhythm
		.filter((entry) => RHYTHM_FIELDS.every((field) => {
			const allowed = entry.when?.[field]
			if (allowed === undefined) return true
			return rhythmValueMatches(allowed, params[field])
		}))
		.map((entry) => entry.note)
}

/** 形态条目；配对表引用了未定义的 id 时显式报错，理由与角色句都从这里取。 */
function formOf(data, form) {
	const found = data.forms.forms.find((entry) => entry.id === form)
	if (found === undefined) throw new Error(`配对表引用了 forms.json 里没有的形态 id「${form}」`)
	return found
}

/**
 * 方案任务书的两条占位接 plan-spec 数据：13 节逐字成文、自查清单逐条成行。任务书模板不自带
 * 正文——正文长在数据里，编辑者改 plan-spec.json 即改任务书，不必回模板里贴第二遍。
 */
const planSections = (context) => context.data.planSpec.blocks
	.map((block) => `## ${block.title}\n${block.text}`)
	.join('\n\n')

/** 自查条目一行一条：挤成一段就没人逐条勾，而这份清单的全部用处就是逐条勾。 */
const planChecklist = (context) => context.data.planSpec.checklist.join('\n')

/**
 * 占位登记表：模板里每个 〔…〕 都要在这里有一行，键取占位文字的首段（模板里占位带说明
 * 文字，如〔decisions 逐条；空则本行省略〕登记为 decisions）。加载期由 data.js 核对模板里
 * 的占位是否都在册——未登记的占位留到渲染期才炸，等于规则删了不报错。
 *
 * 两张必读链辅助页分成复核版与施工版是有意分工：复核者只读禁写，施工者要动工，把「只读禁写」
 * 灌给施工者等于给一条它做不到的约束；合成一版则施工者收不到任何一条。差异只落在那一句上，
 * 正文逐字同形，差异一旦写错方向由那两条守门测试（复核版带只读禁写／施工版不带）各自变红。
 */
const PLACEHOLDER_REGISTRY = {
	形态角色句: (context) => context.role,
	下文四条原文: (context) => context.data.templates.横切判据,
	'AGENTS 必读链·复核': (context) => context.data.templates['AGENTS 必读链·复核'],
	'AGENTS 必读链·施工': (context) => context.data.templates['AGENTS 必读链·施工'],
	intent: (context) => context.params.intent,
	subject: (context) => context.params.subject,
	anchors: (context) => (context.params.anchors ?? []).join('、'),
	decisions: (context) => (context.params.decisions ?? []).join('；'),
	forbidden: (context) => context.params.forbidden,
	verifyCmd: (context) => context.params.verifyCmd,
	rootCause: (context) => context.params.rootCause,
	'plan-spec 各节逐字': planSections,
	'plan-spec checklist': planChecklist,
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
 * 做取舍。brief 缺一句固定段是要漏网复核的，渲染器因此不做空值兜底。占位值与模板尾
 * 各自带终止符时叠加成连续终止符，行级归一压回一个——装配噪声，不是调用方的错。压的那
 * 一个取**占位值自己那个**（值先替换进去，故它在串上在前）：值问的是问号就该留问号，模板尾
 * 那个固定句号是兜底不是语义。终止符不限句号（「？。」「！！」一类同属叠字）。
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
		.map((line) => line.replace(PLACEHOLDER, (_, token) => resolvePlaceholder(context, token))
			.replace(/[。？！!?]{2,}/g, (run) => run[0]))
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
	return comboGatesForStage(data, stage).some((gate) => row[gate] === null || row[gate] === undefined)
}

/** needsRootCause 说这类批型要有根因分类；只有施工阶段消费它（门阶段与方案任务书的模板无〔rootCause〕占位）。 */
function needsRootCauseForStage(data, batchType, stage) {
	return stage === CONSTRUCTION_STAGE && findRow(data, batchType)?.needsRootCause === true
}

/**
 * 该 stage 这一趟实际渲染的模板正文：带 needsRootCause 的批型在底模板后追加修复增量那三行，
 * 槽位是否被消费也按这份拼接后的正文判（只看底模板会漏掉〔rootCause〕那一行）。模板缺失
 * 返回 undefined，报错交给调用它的那一层。
 */
function templateBody(data, stage, batchType) {
	const base = data.templates[templateKeyOf(data, stage)]
	if (base === undefined) return undefined
	if (!needsRootCauseForStage(data, batchType, stage)) return base
	const increment = data.templates['修复批增量']
	return increment === undefined ? base : `${base}\n${increment}`
}

/**
 * 这一趟本工具出不出稿：lifecycle 有它、templates 也有按它的模板键写的模板才出。不出的阶段
 * 点名说清「它归各自的工具服务」并把该行 uses 摆出来（那写着是哪个载体），而不是只说模板
 * 没找到——模型照着后者去补一份模板，方向就错了。
 */
function requireServableStage(data, stage) {
	const row = stageRowOf(data, stage)
	const key = row.templateKey ?? row.id
	if (data.templates[key] !== undefined) return
	throw new Error(`stage「${stage}」本工具不装配该阶段：lifecycle 有它，templates.json 没有按模板键「${key}」写的模板——那类阶段归各自的工具服务${row.uses.length === 0 ? '' : `（该行 uses 指的载体＝${row.uses.join('、')}）`}`)
}

/** 该 stage 的模板正文；不出稿的阶段与缺修复增量都显式报错（见 assembleBrief 的 fail fast）。 */
function briefTemplate(data, params) {
	requireServableStage(data, params.stage)
	if (needsRootCauseForStage(data, params.batchType, params.stage) && data.templates['修复批增量'] === undefined) {
		throw new Error('templates.json 缺「修复批增量」——带 needsRootCause 的批型在施工阶段要追加这三行')
	}
	return templateBody(data, params.stage, params.batchType)
}

/**
 * 该形态路 brief 的开头：角色句，带 extras 的形态把 extras 接在角色句后；行上有这个形态的
 * formNotes 时，限定句紧跟角色句——它是这个形态在这个批型下的执行口径，放在角色句后面
 * 才是它作用的位置。
 *
 * 角色句逐字落在首句是承重约束不是排版偏好：消融实证里去掉角色设定，复核质量掉得最狠——没进
 * 角色的复核者退回通用视角，出的东西对哪个形态都成立。角色句由 forms 逐字带入、装配只此一处，
 * 在渲染层另拼一次就会与这一份分家。
 */
function briefHead(data, entry, row) {
	const note = row.formNotes?.[entry.id]
	if (note !== undefined) return `${entry.role}\n批型限定：${note}。`
	if (entry.extras !== undefined) return `${entry.role}\n${entry.extras}`
	return entry.role
}

/**
 * 每路 brief＝{form, text}。复核阶段（lifecycle 行 kind＝复核）逐形态各一路（形态角色句逐字
 * 带入，批型限定与 extras 都只附在该形态那路）；其余阶段单路、以模板键命名——方案/施工模板
 * 不带角色句，逐形态渲染只会产出多份逐字相同的文本。
 * 复核阶段出一路都没有＝静默空转（briefs 空数组，调用方以为派了门复核），当场报错并点名两种
 * 常见成因：必填矩阵漏了判批型参数（于是 combo 空）、配对行该列为空（于是这一门没形态）。
 */
export function assembleBrief(data, params) {
	requireData(data)
	validateParams(data, params)
	const template = briefTemplate(data, params)
	if (stageRowOf(data, params.stage).kind !== REVIEW_KIND) {
		return [{ form: templateKeyOf(data, params.stage), text: renderTemplate(data, params, template, '') }]
	}
	const briefs = resolveForms(data, params).map(({ form, row }) => {
		const entry = formOf(data, form)
		return { form, text: renderTemplate(data, params, template, briefHead(data, entry, row)) }
	})
	if (briefs.length === 0) {
		throw new Error(`stage=${params.stage} 复核阶段无可派组合——检查该 stage 的 requires 是否漏了判批型参数（漏了 combo 就是空的）、配对行该列是否为空（空列＝这一门没形态可派）`)
	}
	return briefs
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
 * 这一趟消费哪些参数槽位（导出供参数面与测试核）：stage 级必填＋模板占位＋组合那一路读的
 * 三项＋全阶段通用槽位。三处各判一次就会各错一次——漏判＝调用方传了个没被读的参数还当它生效，
 * 多判＝真的消费了却被拒。batchType 这一趟判不判批型由 requires 决定，故它经必填集或组合集
 * 进来，二者都不含时才是「不消费」（方案阶段那一档）。
 */
export function consumedParams(data, stage, batchType) {
	const slots = [...stageRequires(data, stage), ...UNIVERSAL_PARAMS]
	// 槽位名按「占位文字以该参数名开头」认，与占位登记表的前缀规则同一套；占位文字后缀怎么写
	// （空格分句、；分句）不由本函数操心。
	for (const token of placeholderTokens(templateBody(data, stage, batchType) ?? '')) {
		for (const slot of PARAM_FIELDS) if (token.startsWith(slot)) slots.push(slot)
	}
	if (comboGatesForStage(data, stage).length > 0) for (const field of COMBO_PARAMS) slots.push(field)
	// baseBatchType 是批型条件槽位：有门列只是一半，另一半是这一趟真的可能落回原批型主行
	// （行标 needsBase，或主行在该列为空）——两者都不成立时它读不到，报「不消费」才与事实相符
	if (needsBaseForStage(data, batchType, stage) || baseBatchTypeReadable(data, batchType, stage)) slots.push('baseBatchType')
	// 模板里还有形态角色句、横切判据、plan-spec 那几个占位——它们不是参数而是数据源，
	// 留在集合里只会让「消费集＝参数槽位」这句话失真（拼错的占位由加载期那条用例查）
	return new Set(slots)
}

/** 这一趟的主行该列为空（行没标 needsBase 却被 baseBatchType 接住的那一档）。 */
function baseBatchTypeReadable(data, batchType, stage) {
	const row = findRow(data, batchType)
	return comboGatesForStage(data, stage).some((gate) => row?.[gate] === null || row?.[gate] === undefined)
}

/**
 * 消费某个槽位的那些阶段（导出供工具参数面把「哪几个阶段要填它」现读拼进描述，不手抄名单）。
 * 批型条件槽位的答案随批型变，参数面问它时给的是「哪个阶段带着哪个条件会要它」。
 */
export function stagesConsuming(data, field) {
	return dispatchStages(data).filter((stage) => consumedParams(data, stage).has(field))
}

/**
 * 不消费某槽位时怎么跟调用方说：三种说法按「离事实多近」排——
 * ①这一趟有那个位置、只是这个批型用不上（点名为什么）；②这个槽位带批型条件（点名谁带条件消费它）；
 * ③纯阶段级或无人消费（点名阶段名单）。笼统一句「不消费」会让模型反复重试同一个参数。
 */
function unconsumedReason(data, stage, batchType, field) {
	const explanation = UNCONSUMED_EXPLANATIONS[field]
	if (explanation !== undefined) return `${explanation}，删掉它`
	const rule = CONDITION_PARAMS[field]
	if (rule !== undefined) {
		const holders = rule.holders(data)
		// holders 为空时不许走「点名谁带条件消费它」那句：那句会把空名单印成「消费它的是那一类
		// 批型」，看上去有个集合其实没人——配对表里没有一行标这个条件时，那是个真事实，说出来
		if (rule.applies(data, stage)) {
			return holders.length > 0
				? `${rule.unusedBecause}——消费它的是${holders.join('、')}那一类批型，删掉它或改调那一类`
				: `${rule.unusedBecause}——配对表里没有任何一行标 ${rule.condition}，删掉它`
		}
		if (holders.length > 0) {
			const stages = dispatchStages(data).filter((entry) => rule.applies(data, entry))
			return `消费它的是${stages.join('/')}+${rule.condition} 批型（${holders.join('、')}），删掉它或改调那一类`
		}
	}
	const consumers = stagesConsuming(data, field)
	if (consumers.length > 0) return `消费它的是${consumers.join('/')}阶段，删掉它或改调其中之一`
	return '已上线的阶段都不消费它，删掉它'
}

/**
 * 数值槽位的类型与取值域边界：给了就得是非负安全整数（0 合法——零行净 diff 正是免派那一档，空判据
 * 读不出它）。不收这条检查的话，传「5」这种字符串数字只会表现为 rhythm 少出一条提示，而那一路
 * 没有报错可指：调用方看不出是类型错还是阈值不对。负数与小数比那更糟——它们按规模区间一比照样
 * 「命中」，一条看着成立实则按一个不存在的规模出的免派建议就这么发了出去。
 *
 * 安全整数而不是「整数」：行数与文件数是计数，超过 2^53−1 的数在双精度里已经不是「数出来的
 * 行数」——Number.isInteger(1.7976931348623157e308) 为真，于是那种值会安静地被当成一个合法规模
 * 拿去比规模区间，谁都看不出它从一开始就不是计数。判据放在这里是因为宿主 schema 那道只管类型。
 */
function assertNumericParams(params) {
	for (const field of NUMERIC_PARAMS) {
		if (isBlank(params[field])) continue
		const value = params[field]
		if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
			throw new Error(`参数「${field}」须是非负安全整数（0 也算「给了」，上限 2^53−1），实得 ${describe(value)}`)
		}
	}
}

/**
 * 运行期参数校验：缺必填即拒绝出稿（fail fast，错误信息点名缺哪几个）。必填＝stage 级矩阵
 * （lifecycle 行的 requires，单源）＋批型条件必填（读配对行的 needsBase/needsRootCause），
 * 两层都过才出稿；类型边界也在这一层收口——必填槽位传了非字符串（0/false/对象）点名拒，
 * 不让它飘进模板替换。反向也查一遍：这一趟消费不到的槽位收到值即报错，并按上面的三种说法
 * 点名（现算，不按阶段名硬编码）——静默忽略等于让调用方以为自己改了批型、组合或根因分类，
 * 那类错法在出稿结果里看不出来，只在几天后表现为「怎么没照我说的做」。params.stage 是装配层
 * 按工具契约注入的阶段常量（不是调用方槽位），本函数照读它定锚。
 */
export function validateParams(data, params = {}) {
	requireData(data)
	assertListParams(params)
	assertNumericParams(params)
	const stage = params.stage
	requireServableStage(data, stage)
	const required = stageRequires(data, stage)
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
		// batchType 在方案那一趟不是槽位（出稿不问批型），报错里就不点名它
		const scope = isBlank(params.batchType) ? `stage=${stage}` : `stage=${stage}／batchType=${params.batchType}`
		throw new Error(`${scope} 缺必填参数：${missing.join('、')}——缺必填不出稿`)
	}
	const consumed = consumedParams(data, stage, params.batchType)
	for (const field of PARAM_FIELDS) {
		if (consumed.has(field) || isBlank(params[field])) continue
		throw new Error(`stage=${stage} 不消费 ${field}——${unconsumedReason(data, stage, params.batchType, field)}`)
	}
}

/** 行号锚点告警：带 `:数字` 的锚点逐条点名。行号会随文件变动漂移，符号名才 grep 得到。 */
function anchorWarnings(anchors = []) {
	const withLineNumber = anchors.filter((anchor) => LINE_NUMBER_ANCHOR.test(anchor))
	if (withLineNumber.length === 0) return []
	return [`锚点含行号形态：${withLineNumber.join('、')}——锚点以符号名为准（行号随文件变动漂移、grep 不到），请改成符号名`]
}

/**
 * 规模参数半给告警：节奏谓词是「when 里各字段都要命中」的交集，而盘上每条规模判据都同时收
 * diffLines 与 changedFiles。只给一半时那条免派提示静默不出——调用方看到的是「按这个规模判，
 * 该出的提示没出」，看不出是自己少传了一个参数。点名比让它自己猜省：真该不出的那几种规模，
 * 交集判据照常把它按不命中处理，两件事各说各的。
 */
function scaleWarnings(params) {
	const given = NUMERIC_PARAMS.filter((field) => !isBlank(params[field]))
	if (given.length === 0 || given.length === NUMERIC_PARAMS.length) return []
	return [`规模参数只给了 ${given.join('、')}——免派判据取交集（${NUMERIC_PARAMS.join(' 与 ')} 成对给），只给一半按不命中：本次不出免派提示`]
}

/**
 * 该 stage 的自检清单：派 brief 那一族出 templates.checklist 那四条；消费 plan-spec 的阶段
 * （方案）出空——定稿自查那 11 条已经由方案任务书模板尾逐条渲染过，这里再返回一份等于同一次
 * 输出里出现同一份内容两遍，收件的人要自己判断哪份才是该勾的。判据仍是「这一趟吃 plan-spec」
 * 这条数据，不按阶段名硬编码。
 */
function checklistOf(data, stage) {
	if (usesPlanSpec(data, stage)) return []
	return lines(data.templates.checklist)
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
		checklist: checklistOf(data, params.stage),
		rejected: [...data.forms.rejected],
		warnings: [...anchorWarnings(params.anchors), ...scaleWarnings(params)],
		adjudication: lines(data.templates.裁决),
	}
}
