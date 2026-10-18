/**
 * dispatch 族的工具参数面：装配四件（dispatch_plan/review/build/verify，各自一张表）与批次
 * 台账工具（dispatch_batch）各一张。四张表的字段名与形状在这一处；必填性由 core.schemaRequiredOf
 * 按 lifecycle 单源派生（回填面那几格不标），运行期的逐格点名仍归 core.validateParams——schema
 * 与运行期是先后两道闸，不是两份真相源，谁声明谁消费由 declaredSlots 从消费集现算。
 *
 * 描述里凡出现「哪几个批型／谁带条件」一律现读数据拼，不手抄：那些名单是模型唯一的选型依据，
 * 手抄一份等于配对表或 forms 改名、加行后描述还停在旧名单。手抄的只有固定语义（对象两态、
 * 规则本身的写法），那些不是清单而是语义。
 */
import {
	CONDITION_PARAMS, CONSTRUCTION_STAGE, GATE_LABELS, PARAM_FIELDS,
	consumedParams, mainBatchTypes, schemaRequiredOf, specialHolders, stageVocabulary, SUBJECT_PLACEHOLDER,
} from './core.js'
import { objectList } from '../tool-schema.js'
import { BATCH_ACTIONS } from './batch.js'

/** 行名清单拼串：描述里那几处名单都要逐字成句，故只此一处拼法。 */
const names = (list) => list.join('、')

/**
 * 带某条件的批型行名单：判定处是 core 的槽位表（CONDITION_PARAMS[field].holders），
 * 不在本文件按条件字段名再 filter 一遍。描述里这份名单是模型选 baseBatchType/rootCause 的
 * 唯一依据，它与「谁带这个条件」的真实判定必须是同一份——两处各写一遍，改条件时描述会停在
 * 旧名单，模型照旧名单传值就撞「未消费/未知批型」。
 */
const conditionHolders = (data, field) => CONDITION_PARAMS[field].holders(data)

/**
 * 条件字段名（配对行上那个标记的键名）现读自同一张槽位表，本文件一个字面量都不留：字段名与
 * 判定放一处，改名时两边一起变。test/dispatch-parameters.test.js 的源码守卫把这一条钉住
 * （注释行同样不许出现那个名字，否则注释能退回成第二处判定说明）。
 */
const conditionWord = (field) => CONDITION_PARAMS[field].condition

/** 加挂行名＝全表行名减主行：主行词表（core 的 mainBatchTypes）是「哪些行算主行」的唯一判定处。 */
const addonNames = (rows, main) => rows.map((row) => row.batchType).filter((name) => !main.includes(name))

/**
 * 一件装配工具声明哪些参数槽位：消费集（模板占位＋必填矩阵＋组合那一路＋通用槽位，批型取
 * undefined＝无条件档）并上批型条件槽位（有门列→baseBatchType、施工→rootCause），再按
 * PARAM_FIELDS 定序。导出供测试核对四张表的键集与它是同一份推导，而不是测试各抄一份名单。
 */
export function declaredSlots(data, stage) {
	const slots = new Set(consumedParams(data, stage, undefined))
	for (const [field, rule] of Object.entries(CONDITION_PARAMS)) {
		if (rule.applies(data, stage)) slots.add(field)
	}
	return PARAM_FIELDS.filter((field) => slots.has(field))
}

/**
 * 一件装配工具的参数面（宿主 defineTool 吃的那张 parameters 表）：键集＝declaredSlots，
 * required＝schemaRequiredOf（lifecycle requires − 回填基础集；四件里只有施工的 anchors 过这道），
 * 个别字段的描述按阶段差分（verify 的 subject、batch 的回填口径）。
 *
 * 各工具只收自己消费的槽位，多收一个＝调用方传了没被读的参数还当它生效；少收一个＝模型传了
 * 收不到的那一格。两向都由 declaredSlots 单源兜着，本函数不再各阶段手写一份键清单。
 */
export function assemblerParameters(data, stage) {
	const main = mainBatchTypes(data)
	const baseHolders = conditionHolders(data, 'baseBatchType')
	const plainSpecial = specialHolders(data).filter((name) => !baseHolders.includes(name))
	const addon = addonNames(data.pairing.rows, main)
	const rootCauseHolders = conditionHolders(data, 'rootCause')
	const isVerify = stage === GATE_LABELS.gate2
	const required = new Set(schemaRequiredOf(data, stage))

	const specs = {
		batchType: {
			type: 'string',
			// 词表从描述升进 schema：模型传错批型由宿主参数校验当场拦下，报错自带合法值清单——
			// 那是运行期 fail fast 兜不出的一层，它只在 execute 之后才说话，而模型已经花掉一轮。
			// 两端现读加载期同一份词表（mainBatchTypes 已含带批型条件的特殊行、只排除 addon 行——
			// addon 不是 batchType 的合法值，它只经 addons 参数加挂）。描述里的词表句保留：enum 是
			// 给校验器读的，描述那份是模型选型时读的文字，两条通道各有读者，删一条就少一类召回。
			enum: main,
			description: [
				`批型（配对表主行行名：${names(main)}`,
				baseHolders.length > 0 ? `需 baseBatchType 的特殊行：${names(baseHolders)}` : null,
				plainSpecial.length > 0 ? `不带 baseBatchType 的特殊行：${names(plainSpecial)}（门二固定双路起步）` : null,
				`addon 行不作 batchType，用 addons 参数加挂：${names(addon)}）`,
				'缺省可由 batch 回填（见 batch 参数）',
			].filter((part) => part !== null).join('；'),
		},
		subject: {
			type: 'string',
			// 对象的两态语义是本文件少数手抄项：它是「两个对象共用一个槽位名」的固定约定，不是
			// 任何数据表里现读得出的清单。verify 那态与台账回填的关系由 BACKFILL_EXCLUDE 在
			// 回填遍历处执行，这里只把口径说给调用方听。
			description: isVerify
				? '对象＝净 diff 生成命令（复核者照它生成要审的 diff，如 git diff 起点..HEAD）；不从台账回填——台账 subject 登记的是方案路径，与净 diff 命令是两个对象；本工具必填'
				: '对象：方案绝对路径＋批次节指针；缺省可由 batch 回填（见 batch 参数）',
		},
		intent: { type: 'string', description: '本批意图一句话（设计判断要知道目标才谈得上最优）；缺省可由 batch 回填（见 batch 参数）' },
		baseBatchType: { type: 'string', description: `特殊行依赖的批型：${conditionWord('baseBatchType')} 行按原批型取组合，修复批＝原批型、新功能·形态未定＝落点批型；只在这一趟的组合可能落回原批型时消费（有门列，且该行标 ${conditionWord('baseBatchType')} 或主行该列为空），否则收到即报错；缺省可由 batch 回填（见 batch 参数）` },
		batch: {
			type: 'string',
			description: [
				`批次名（dispatch_batch start 登记过的）——传入则从台账拉该批的登记值回填本工具消费的那些槽位（先回填再校验；显式参数优先，与台账不一致即报错；台账对象格是「${SUBJECT_PLACEHOLDER}」占位＝按未登记处理并提醒补记）`,
				isVerify ? 'subject 不在此列（本工具的对象是净 diff 命令，见 subject 参数）' : null,
			].filter((part) => part !== null).join('；'),
		},
		decisions: { type: 'array', items: { type: 'string' }, description: '拍板清单（不得重开），逐条原文；直做/机械批无拍板可空，模板该行整体省略；缺省可由 batch 回填（见 batch 参数）' },
		addons: { type: 'array', items: { type: 'string' }, description: '加挂行行名（与主行组合并集；混合批＝主批型＋各成分批型的加挂并集）。加挂行并非每道门都可用，可用门以配对表各行 gate 列为准' },
		anchors: { type: 'array', items: { type: 'string' }, description: '锚点（符号名，禁行号——含「:数字」形态会告警）。施工必填' },
		forbidden: { type: 'string', description: '禁区（本批不许碰的域）。施工可选' },
		verifyCmd: { type: 'string', description: '自验封顶＝一条受影响单测的命令。施工可选' },
		rootCause: {
			type: 'string',
			// holders 为空时那半句点名收起来：印出「施工必填：」却不说是谁＝空名单冒充集合
			description: [
				rootCauseHolders.length > 0 ? `${names(rootCauseHolders)}施工必填：「错行|错结构」＋一句机制解释（结构错→整块重写而非点修）` : null,
				`别的批型收到即报错（施工模板按 ${conditionWord('rootCause')} 批型追加那三行）`,
			].filter((part) => part !== null).join('；'),
		},
		provider: { type: 'string', description: '子代理的 provider；与阶段无关，传了即被 rhythm 谓词读' },
		// 规模参数标 integer：行数与文件数是计数，宿主 schema 层（IntegerValueSchemaSpec）在调用
		// 边界就能拒非整数并点名参数。值域的真检查仍在 core.assertNumericParams（端口直调、脚本
		// 调用与台账回填都不经宿主 schema，那条路只有运行期这道），两处是先后不是二选一。
		diffLines: { type: 'integer', description: '本批净 diff 行数（喂节奏谓词的规模参数：非负安全整数，上限 2^53−1；与 changedFiles 成对给，判据取交集，只给一半按不命中；≤配对表给的阈值时在门二那一趟额外出那条「本规模建议直修不派复核」的提示——提示层不阻断，派不派仍由你裁量）；与阶段无关，不传即没有免派提示' },
		changedFiles: { type: 'integer', description: '本批改动的文件数（规模参数，同 diffLines：非负安全整数、上限 2^53−1、与 diffLines 成对给；只影响节奏提示，不影响出稿与必填）' },
	}

	const surface = {}
	for (const field of declaredSlots(data, stage)) {
		const spec = { ...specs[field] }
		// required 只出自 schemaRequiredOf（lifecycle 单源），specs 里手写 required 就是第二份必填矩阵
		if (required.has(field)) spec.required = true
		surface[field] = spec
	}
	return surface
}

/**
 * 台账工具（dispatch_batch）的参数面。四个 action 各要不同的必填项，而「这一趟要什么」由台账
 * 逻辑层按 action 判并点名缺哪个——在 schema 上标成四者的并集，模型就会为了一次 status 去编
 * batchType。取值清单（批型主行、阶段词表、形态 id）一律现读拼。
 */
export function batchParameters(data) {
	const main = mainBatchTypes(data)
	const baseHolders = names(conditionHolders(data, 'baseBatchType'))
	// 形态表空到解构出 undefined 时，perFormCounts 的示例会渲染成 undefined 拼出的串，照着传的
	// 调用方会撞「形态不在词表内」——当场点名比让示例值带病出稿好
	const [first, second] = data.forms.forms
	if (first === undefined || second === undefined) {
		throw new Error(`dispatch 数据空集：forms.json 的 forms 至少要有两个形态才能给示例（现得 ${data.forms.forms.length} 个）——带 undefined 的示例比没有示例更坏`)
	}
	const formIds = data.forms.forms.map((form) => form.id)
	// 形态 id 的 enum 是注册期快照：宿主在 defineTool 编译时把它固化，盘上 forms.json 后来加了
	// 新形态要等宿主重启才会进这份名单——取舍显式认领：enum 拦的是「词表内笔误」这一最常见档，
	// 新形态那一档由运行期的词表核（requireFormList/requirePerFormCounts 现读 forms.json）兜住，
	// 不为它放弃调用边界的当场拦截。
	const formEnum = { type: 'string', enum: formIds }
	return {
		action: { type: 'string', required: true, description: BATCH_ACTIONS.join(' | ') },
		batch: { type: 'string', description: '批次名（全仓唯一小写短名）：start/advance/status 必填；status 省略＝列在飞批次及各自下一道未过门' },
		batchType: {
			type: 'string',
			// 词表同样从描述升进 schema：模型传错批型由宿主在调用边界当场拦下（理由见
			// assemblerParameters 那段注）。两件工具认的必须是同一份批型名——台账按名字索引，两边
			// 认的不同时「start 登记的批型」与「装配出的稿」指向两个东西，而症状是门禁判据
			// 落在空组合上，报错还看不出是名字没对上
			enum: main,
			description: `start 必填。批型（配对表主行行名：${names(main)}）`,
		},
		baseBatchType: { type: 'string', description: `start 可选。${baseHolders}依赖的批型（修复批＝原批型、新功能·形态未定＝落点批型）：记进 start 事件，门禁判定按它落回配对表那一行的门列——判得出这批走不走某道门，判不出才按全门保守告警；标了 ${conditionWord('baseBatchType')} 的批型 start 必须显式给（登记期报错，不靠后续补救）` },
		intent: { type: 'string', description: 'start 必填。本批意图一句话（设计判断要知道目标才谈得上最优）' },
		subject: { type: 'string', description: `start 可选。对象：方案绝对路径＋批次节指针（还没定就登记「${SUBJECT_PLACEHOLDER}」占位，装配工具回填时按未登记处理并提醒补记）` },
		decisions: { type: 'array', items: { type: 'string' }, description: 'start 可选。拍板清单逐条原文，不得重开——登记后每次装配调用（batch=）自动带出，主会话不必再手贴' },
		stage: {
			type: 'string',
			// 这一件收**全量**阶段词表而不是装配四件各服务的那一个：advance 要把提交与复盘记进
			// 台账，而那两步正是生命周期里正当的一步——按装配那档收会把「记到收尾」挡在门外，
			// 且报错只会说「不在词表内」，看不出是收窄了哪一档
			enum: stageVocabulary(data),
			description: `advance 必填。阶段（取值对着 lifecycle 的阶段词表单源：${stageVocabulary(data).join(' | ')}）`,
		},
		perFormCounts: {
			// 数组对形状（{form, count} 逐条）：宿主硬要求 object 节点显式声明 additionalProperties，
			// 形状工厂把这一条管到每个条目。条目内 required 标形状级的「这两键必须成对给」（先例＝
			// index.js 的 briefs/combo 条目）；count 收 number 不收 integer：值域（非负有限数）由运行期
			// 的 requirePerFormCounts 现读 forms.json 把着，schema 收窄到整数等于在调用边界另立一条
			// 与运行期不一致的域。键域（形态 id 词表）同由运行期兜住，schema 的 enum/形状拦不住也不必拦住那两道
			...objectList({ form: { ...formEnum, required: true }, count: { type: 'number', required: true } }),
			description: `advance 可选。[{form: 形态 id, count: findings 数}]，如 [{"form":"${first.id}","count":2},{"form":"${second.id}","count":3}]——结构化落库、读方直取不解析；无复核的阶段省略（旧事件里「形态 id→数」的对象形状仍可读，读方已归一）。形态 id enum 是注册期快照：盘上 forms.json 新加的形态要等宿主重启才进名单，运行期词表核照常现读，不为快照放弃调用边界的当场拦截`,
		},
		combo: {
			...objectList({ form: formEnum }),
			description: 'advance 可选。实派形态 [{form: 形态 id}]——落库存形态 id 串数组；与推荐组合的差异即复盘依据',
		},
		recommended: {
			...objectList({ form: formEnum }),
			description: 'advance 可选。当趟装配的推荐组合 [{form: 形态 id}]（主会话未裁剪时＝combo）——复盘统计「裁剪率/采纳率」的分母，事件不自存就永远算不出来',
		},
		adopted: { type: 'number', description: 'advance 可选。采纳的 findings 数（缺省 0；拒收数＝perFormCounts 总和−adopted，推导不存）' },
		overlap: { type: 'number', description: 'advance 可选。双路重复上报的 findings 数（缺省 0；重叠高＝两路在看同一处）' },
		missed: { type: 'string', description: 'advance 可选。漏网标记：用户事后实测暴露的问题＋本可由哪形态抓到' },
		note: { type: 'string', description: 'advance 可选。自由附注一句——status/list 渲染尾注，空则省略' },
	}
}
