/**
 * dispatch 族的工具参数面（宿主 defineTool 吃的那张 parameters 表，本工具与批次台账工具各一
 * 张）：字段名与形状在这一处，字段的必填性由 core.validateParams 按 lifecycle 单源判定并点名缺
 * 哪几个——schema 里再抄一遍必填矩阵就是两份真相源，改一处就有一处对不上。
 *
 * schema 只标一个 required：stage（调用形态参数，且台账回填面不含它，宿主层拦形态错误是好事）。
 * 回填面那四格（batchType/intent/subject/decisions）一律不标：宿主按 schema 拦必填发生在进 execute
 * 之前，而这些值本来就该由台账回填补上，标了 required 就是回填永远到不了。batchType 早先按同款
 * 理由（方案阶段不判批型，标了等于逼模型为了过 schema 编一个批型）不标，这次把同一口径补齐到
 * intent/subject。少标了不会漏拦截——core.validateParams 那道门照旧按数据点名。
 *
 * 描述里凡出现「哪几个阶段／哪几个批型要填它」，一律现读数据拼，不手抄：那些名单是模型唯一
 * 的选型依据，手抄一份等于配对表或 lifecycle 改名、加行后描述还停在旧名单，模型照旧名单
 * 传值就撞「未知批型／未知 stage」。手抄的只有两类——固定两态的对象语义（方案路径 vs 净 diff
 * 命令）与规则本身的写法，那些不是清单而是语义。
 */
import { CONDITION_PARAMS, dispatchStages, mainBatchTypes, specialHolders, stageVocabulary, stagesConsuming } from './core.js'
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

/** 加挂行名＝全表行名减主行：主行词表（core 的 mainBatchTypes）是「哪些行算主行」的唯一判定处。 */
const addonNames = (rows, main) => rows.map((row) => row.batchType).filter((name) => !main.includes(name))

/** 「哪几个阶段要填它」现读：core 的槽位消费集（模板占位＋必填矩阵＋组合那一路）。 */
const stages = (data, field) => stagesConsuming(data, field).join('/')

/**
 * 组装参数面。三个槽位的描述带现读清单，其余是固定语义：batchType（判批型阶段与主行名单）、
 * subject（两态语义）、anchors/forbidden/verifyCmd（消费它的那几个阶段）、rootCause（带
 * needsRootCause 的批型在施工要它）、diffLines/changedFiles（规模参数，只喂节奏谓词）。
 */
export function dispatchParameters(data) {
	const rows = data.pairing.rows
	const main = mainBatchTypes(data)
	const needsBase = conditionHolders(data, 'baseBatchType')
	const plainSpecial = specialHolders(data).filter((name) => !needsBase.includes(name))
	const addon = addonNames(rows, main)
	const rootCause = conditionHolders(data, 'rootCause')
	return {
		stage: { type: 'string', required: true, description: dispatchStages(data).join(' | ') },
		batchType: {
			type: 'string',
			description: [
				`批型（${stages(data, 'batchType')}阶段必填，方案阶段不判批型；配对表主行行名：${names(main)}`,
				needsBase.length > 0 ? `需 baseBatchType 的特殊行：${names(needsBase)}` : null,
				plainSpecial.length > 0 ? `不带 baseBatchType 的特殊行：${names(plainSpecial)}（门二固定双路起步）` : null,
				`addon 行不作 batchType，用 addons 参数加挂：${names(addon)}）`,
				'缺省可由 batch 回填（见 batch 参数）',
			].filter((part) => part !== null).join('；'),
		},
		subject: { type: 'string', description: '对象：方案/门一/施工＝方案绝对路径＋批次节指针；门二＝净 diff 生成命令；缺省可由 batch 回填（见 batch 参数）' },
		intent: { type: 'string', description: '本批意图一句话（设计判断要知道目标才谈得上最优）；缺省可由 batch 回填（见 batch 参数）' },
		baseBatchType: { type: 'string', description: '特殊行依赖的批型：needsBase 行按原批型取组合，修复批＝原批型、新功能·形态未定＝落点批型；只在这一趟的组合可能落回原批型时消费（有门列，且该行标 needsBase 或主行该列为空），否则收到即报错' },
		batch: { type: 'string', description: '批次名（dispatch_batch start 登记过的）——传入则从台账拉该批的 batchType/intent/subject/decisions 四项自动填充（对象那格是每阶段必填，正是登记一次、每路 brief 指同一对象的场合），先回填再校验、只填这一趟消费的那些槽位；显式参数优先，与台账不一致即报错' },
		decisions: { type: 'array', items: { type: 'string' }, description: `拍板清单（不得重开），逐条原文；${stages(data, 'decisions')}阶段逐条成行（直做/机械批无拍板可空，模板该行整体省略），方案那一趟不消费它——方案是给用户拍板的输入，不是已拍板的载体；缺省可由 batch 回填（见 batch 参数）` },
		addons: { type: 'array', items: { type: 'string' }, description: '加挂行行名（与主行组合并集；混合批＝主批型＋各成分批型的加挂并集）。不判批型的阶段不消费它' },
		anchors: { type: 'array', items: { type: 'string' }, description: `锚点（符号名，禁行号——含「:数字」形态会告警）。${stages(data, 'anchors')}必填` },
		forbidden: { type: 'string', description: `禁区（本批不许碰的域）。${stages(data, 'forbidden')}可选` },
		verifyCmd: { type: 'string', description: `自验封顶＝一条受影响单测的命令。${stages(data, 'verifyCmd')}可选` },
		rootCause: {
			type: 'string',
			description: [
				rootCause.length > 0 ? `${names(rootCause)}施工必填：「错行|错结构」＋一句机制解释（结构错→整块重写而非点修）` : null,
				'别的阶段与别的批型收到即报错（复核组合在门一/门二、施工模板按 needsRootCause 批型追加那三行）',
			].filter((part) => part !== null).join('；'),
		},
		provider: { type: 'string', description: '子代理的 provider（如 minimax-cn），用于模型路线相关的节奏提示（Flash 拆批上限）；与阶段无关，传了即被 rhythm 谓词读' },
		// 规模参数标 integer：行数与文件数是计数，宿主 schema 层（IntegerValueSchemaSpec）在调用
		// 边界就能拒非整数并点名参数。值域的真检查仍在 core.assertNumericParams（端口直调、脚本
		// 调用与台账回填都不经宿主 schema，那条路只有运行期这道），两处是先后不是二选一
		diffLines: { type: 'integer', description: '本批净 diff 行数（喂节奏谓词的规模参数：非负整数；与 changedFiles 成对给，判据取交集，只给一半按不命中；≤配对表给的阈值时在门二那一趟额外出那条「本规模建议直修不派复核」的提示——提示层不阻断，派不派仍由你裁量）；与阶段无关，不传即没有免派提示' },
		changedFiles: { type: 'integer', description: '本批改动的文件数（规模参数，同 diffLines：非负整数、与 diffLines 成对给；只影响节奏提示，不影响出稿与必填）' },
	}
}

/**
 * 台账工具（dispatch_batch）的参数面。四个 action 各要不同的必填项，而「这一趟要什么」由台账
 * 逻辑层按 action 判并点名缺哪个——在 schema 上标成四者的并集，模型就会为了一次 status 去编
 * batchType。取值清单（批型主行、阶段词表、形态 id 示例）一律现读拼。
 */
export function batchParameters(data) {
	const main = mainBatchTypes(data)
	const needsBase = names(conditionHolders(data, 'baseBatchType'))
	// 形态表空到解构出 undefined 时，perFormCounts 的示例会渲染成 "undefined": 2 那样的字符串，
	// 照着传的调用方会撞「键不在形态词表内」——当场点名比让示例值带病出稿好
	const [first, second] = data.forms.forms
	if (first === undefined || second === undefined) {
		throw new Error(`dispatch 数据空集：forms.json 的 forms 至少要有两个形态才能给示例（现得 ${data.forms.forms.length} 个）——带 undefined 的示例比没有示例更坏`)
	}
	return {
		action: { type: 'string', required: true, description: BATCH_ACTIONS.join(' | ') },
		batch: { type: 'string', description: '批次名（全仓唯一小写短名）：start/advance/status 必填；status 省略＝列在飞批次及各自下一道未过门' },
		batchType: { type: 'string', description: `start 必填。批型（配对表主行行名：${names(main)}）` },
		baseBatchType: { type: 'string', description: `start 可选。${needsBase}依赖的批型（修复批＝原批型、新功能·形态未定＝落点批型）：记进 start 事件，门禁判定按它落回配对表那一行的门列——判得出这批走不走某道门，判不出才按全门保守告警` },
		intent: { type: 'string', description: 'start 必填。本批意图一句话（设计判断要知道目标才谈得上最优）' },
		subject: { type: 'string', description: 'start 可选。对象：方案绝对路径＋批次节指针' },
		decisions: { type: 'array', items: { type: 'string' }, description: 'start 可选。拍板清单逐条原文，不得重开——登记后每次 dispatch(batch=) 自动带出，主会话不必再手贴' },
		stage: { type: 'string', description: `advance 必填。阶段（取值对着 lifecycle 的阶段词表单源：${stageVocabulary(data).join(' | ')}）` },
		perFormCounts: {
			type: 'object',
			// 宿主只收布尔：object 节点不显式声明 additionalProperties 就整件工具注册失败。值域
			// （findings 数）与键域（形态 id 词表）由运行期的 requireCount / requirePerFormCounts 把着，
			// 这里写成 schema 也拦不住那两道真检查
			additionalProperties: true,
			description: `advance 可选。键＝形态 id、值＝findings 数，如 {"${first.id}": 2, "${second.id}": 3}——结构化落库、读方直取不解析；无复核的阶段省略`,
		},
		combo: { type: 'string', description: 'advance 可选。实派形态 id 空格分隔——与推荐组合的差异即复盘依据' },
		recommended: { type: 'string', description: 'advance 可选。当趟 dispatch 推荐组合 id 空格分隔（主会话未裁剪时＝combo）——复盘统计「裁剪率/采纳率」的分母，事件不自存就永远算不出来' },
		adopted: { type: 'number', description: 'advance 可选。采纳的 findings 数（缺省 0；拒收数＝perFormCounts 总和−adopted，推导不存）' },
		overlap: { type: 'number', description: 'advance 可选。双路重复上报的 findings 数（缺省 0；重叠高＝两路在看同一处）' },
		missed: { type: 'string', description: 'advance 可选。漏网标记：用户事后实测暴露的问题＋本可由哪形态抓到' },
		note: { type: 'string', description: 'advance 可选。自由附注一句——status/list 渲染尾注，空则省略' },
	}
}
