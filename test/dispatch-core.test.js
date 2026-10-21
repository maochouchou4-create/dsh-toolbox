/**
 * dispatch 核心层（v2）：分诊档位、三硬触发、diff 预算机判、任务书与证伪门 brief 的组装与渲染。
 *
 * 这一层是纯函数（data 进、结构化值出），所以「render 直出可派参数」在这里就能断言：
 * workflowArgs 的形态不依赖宿主，node 直调即可（验收#3）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	DispatchInputError,
	UnknownParamError,
	assertKnownParams,
	assertParamCoverage,
	assembleChallenge,
	assembleTask,
	challengeParamNames,
	checkStageRequirements,
	diffBudgetOf,
	gateComboText,
	gatesFor,
	judgeDiffBudget,
	renderChallengeResult,
	renderPlanSpec,
	renderTaskResult,
	semanticTriggerOf,
	stageRows,
	taskParamNames,
	tierRow,
	validateChallenge,
} from '../lib/dispatch/core.js'
import { loadDispatchData } from '../lib/dispatch/data.js'
import { GATE_LABELS, TIERS } from '../lib/dispatch/vocab.js'

const { data } = loadDispatchData()

const taskOf = (overrides = {}) => ({
	batch: 'smoke-batch',
	tier: 'M',
	triage: 'M｜锚点全是内部实现符号，未触三硬触发',
	intent: '把 v2 四件工具落地',
	anchors: ['loadDispatchData', 'SAFETY_CARRIER_IDS'],
	...overrides,
})

const challengeOf = (overrides = {}) => ({
	batch: 'smoke-batch',
	subject: 'git diff 8a0a01f..HEAD',
	tier: 'M',
	intent: '把 v2 四件工具落地',
	triage: 'M｜锚点全是内部实现符号',
	...overrides,
})

test('档位表是闭集：未知档位即错，提示只认 S/M/L', () => {
	for (const tier of TIERS) assert.equal(tierRow(data, tier).tier, tier)
	assert.throws(() => tierRow(data, 'XL'), DispatchInputError)
	assert.throws(() => tierRow(data, 'XL'), /未知档位 XL/)
})

test('生命周期行按 order 排序（顺序是状态机的第二处表述，这里钉住）', () => {
	assert.deepEqual(stageRows(data).map((row) => row.id), ['立项', '门报', '提交', '复盘'])
})

test('diff 预算阈值取「diff 超阈」硬触发行（单源，不在代码里抄 1000）', () => {
	assert.equal(diffBudgetOf(data), 1000)
	const row = data.pairing.hardTriggers.find((item) => item.id === 'diff 超阈')
	assert.equal(diffBudgetOf(data), row.threshold)
})

test('diff 预算机判：缺数＝UNJUDGED、等于阈值＝WITHIN、超一行＝OVER', () => {
	assert.equal(judgeDiffBudget(data, {}).verdict, 'UNJUDGED')
	assert.equal(judgeDiffBudget(data, { changedFiles: 4 }).verdict, 'UNJUDGED', '只给 changedFiles 不判（阈值按行）')
	const within = judgeDiffBudget(data, { changedFiles: 4, diffLines: 1000 })
	assert.equal(within.verdict, 'WITHIN')
	assert.match(within.reason, /≤ 阈值 1000/)
	const over = judgeDiffBudget(data, { changedFiles: 9, diffLines: 1001 })
	assert.equal(over.verdict, 'OVER')
	assert.match(over.reason, /超过阈值 1000 行/)
})

test('语义域硬触发：分诊行命中关键词即返回命中词与加挂形态', () => {
	assert.equal(semanticTriggerOf(data, ''), null)
	assert.equal(semanticTriggerOf(data, 'M｜改的是内部常量'), null)
	const hit = semanticTriggerOf(data, 'M｜新增上传入口与鉴权判定')
	assert.equal(hit.trigger, '语义域')
	assert.deepEqual(hit.keywords, ['鉴权', '上传'])
	assert.equal(hit.form, '安全专项')
})

test('门组合：S 无门、M 证伪门一路、L 加方案证伪；语义域命中加挂安全专项', () => {
	const s = gatesFor(data, 'S', { triage: 'S｜单行改注释' })
	assert.deepEqual(s.planChallenge, [])
	assert.deepEqual(s.challenge, [])
	assert.equal(s.taskBook, false)

	const m = gatesFor(data, 'M', { triage: 'M｜内部实现' })
	assert.deepEqual(m.planChallenge, [])
	assert.deepEqual(m.challenge, ['证伪门'])

	const l = gatesFor(data, 'L', { triage: 'L｜跨文件重写' })
	assert.deepEqual(l.planChallenge, ['方案证伪'])
	assert.deepEqual(l.challenge, ['证伪门'])

	const semantic = gatesFor(data, 'M', { triage: 'M｜涉鉴权' })
	assert.deepEqual(semantic.challenge, ['证伪门', '安全专项'])
	assert.equal(semantic.semantic.form, '安全专项')

	assert.equal(gateComboText(s), '无（本档免复核门）')
	assert.equal(gateComboText(m), '方案证伪 0 路／证伪门 1 路')
	assert.match(gateComboText(semantic), /（含安全专项）/)
})

test('任务书（M 档）：≤15 行、末行门报、直出可派参数与门组合', () => {
	const value = assembleTask(data, taskOf())
	assert.equal(value.tier, 'M')
	assert.equal(value.taskBook, true)
	assert.ok(value.prompt.split('\n').length <= 15, '任务书骨架 ≤15 行')
	assert.match(value.prompt, /锚点（符号名，禁行号）：loadDispatchData、SAFETY_CARRIER_IDS/)
	assert.match(value.prompt, /末行门报：/)
	assert.match(value.prompt, /不 commit 不 push/)
	assert.deepEqual(value.gates, { planChallenge: [], challenge: ['证伪门'] })
	assert.match(value.triageLine, /^分诊：M｜/)
	assert.match(value.triageLine, /门组合：方案证伪 0 路／证伪门 1 路/)
	assert.match(value.triageLine, /diff：UNJUDGED/)
	const noSubject = assembleTask(data, taskOf({ subject: undefined }))
	assert.doesNotMatch(noSubject.prompt, /对象（规格正文/, '未传 subject 时对象行整行省略（可选行）')
	const withSubject = assembleTask(data, taskOf({ subject: '/x/方案.md 的「批2」节' }))
	assert.match(withSubject.prompt, /对象（规格正文）：\/x\/方案\.md 的「批2」节/, '传了 subject 必进任务书——施工者靠它找规格正文')
	assert.deepEqual(value.workflowArgs, { label: '施工 smoke-batch（M）', prompt: value.prompt })
	const rendered = renderTaskResult(value)
	assert.ok(
		rendered.includes(JSON.stringify(value.workflowArgs, null, 2)),
		'派发参数必须逐字可粘贴（node 直调即得，不等宿主重启）',
	)
})

test('任务书（S 档）：免任务书不免记账指令，行数更短且不写「任务书」', () => {
	const value = assembleTask(data, taskOf({ tier: 'S', triage: 'S｜单行改注释' }))
	assert.equal(value.taskBook, false)
	assert.match(value.prompt, /免任务书，不免记账/)
	assert.match(value.prompt, /贴不出「现存断言命令＋退出码」＝本批升 M/)
	assert.match(value.workflowArgs.label, /（S 小修）/)
	assert.ok(value.prompt.split('\n').length <= 10)
})

test('任务书（L 档）：附方案规范四节与定稿自查（例外件）', () => {
	const value = assembleTask(data, taskOf({ tier: 'L', triage: 'L｜跨文件重写' }))
	assert.ok(value.planAppendix.length > 0)
	assert.match(value.planAppendix, /定稿自查/)
	assert.match(value.planAppendix, /二、方案与落点（按批分组）/)
	assert.match(value.planAppendix, /过目：交用户过目，认可再施工；对话里呈现方案内容（过目、预览、要点、白话）必配改前\/改后例子对比（不写入本文档）/, '方案模板末尾带过目指引行')
	const rendered = renderTaskResult(value)
	assert.match(rendered, /── 方案文档（L 档例外件/)
})

test('diff 超阈：M/S 档直接拒绝并强制升 L，L 档放行但留警告', () => {
	assert.throws(
		() => assembleTask(data, taskOf({ changedFiles: 40, diffLines: 1200 })),
		/强制升 L（当前档位 M）/,
	)
	assert.throws(() => assembleTask(data, taskOf({ tier: 'S', triage: 'S｜小修', diffLines: 1200 })), /强制升 L/)
	const value = assembleTask(data, taskOf({ tier: 'L', triage: 'L｜跨文件重写', diffLines: 1200 }))
	assert.ok(value.warnings.some((warning) => warning.includes('diff 超阈已按 L 档出稿')))
	assert.equal(value.diffBudget.verdict, 'OVER')
})

test('分诊行形态校验：必须单行、必须以档位开头（多行分诊进不了台账）', () => {
	assert.throws(() => assembleTask(data, taskOf({ triage: 'M｜第一行\n第二行' })), /必须是单行/)
	assert.throws(() => assembleTask(data, taskOf({ triage: 'L｜写错档位' })), /必须以档位 M 开头/)
	assert.throws(() => assembleTask(data, taskOf({ triage: '  ' })), /必须是单行/)
})

test('diff 预算取值范围：负数与非整数即错', () => {
	assert.throws(() => assembleTask(data, taskOf({ diffLines: -1 })), /diffLines 必须是非负整数/)
	assert.throws(() => assembleTask(data, taskOf({ changedFiles: 1.5 })), /changedFiles 必须是非负整数/)
})

test('决策卡：按模板逐卡渲染，缺字段即错（≤6 行由模板形状保证）', () => {
	const value = assembleTask(
		data,
		taskOf({
			decisionCards: [
				{
					question: '分诊档位按什么算？',
					options: '按文件数／按净 diff 行数',
					recommendation: '按净 diff 行数',
					reason: '行数与施工量强相关',
					impact: '口径进了 pairing.json 硬触发行',
				},
			],
		}),
	)
	assert.equal(value.decisionCards.length, 1)
	assert.match(value.decisionCards[0], /^决策卡1：分诊档位按什么算？/)
	assert.match(value.decisionCards[0], /- 选项：按文件数／按净 diff 行数/)
	assert.throws(
		() => assembleTask(data, taskOf({ decisionCards: [{ question: '缺四格' }] })),
		/decisionCards\[0\]\.options 必须是非空字符串/,
	)
})

test('证伪门 brief（M 档）：一路证伪门，继承横切判据原文与任务对象命令', () => {
	const value = assembleChallenge(data, challengeOf({ decisions: ['决策A：按推荐', '决策B：不重开'] }))
	assert.equal(value.gate, GATE_LABELS.challenge)
	assert.equal(value.tier, 'M')
	assert.equal(value.segment, '净 diff')
	assert.deepEqual(value.briefs.map((brief) => brief.form), ['证伪门'])
	const text = value.briefs[0].text
	assert.match(text, /你是独立证伪者/)
	assert.match(text, /不读施工汇报/)
	assert.ok(text.includes(data.templates['横切判据']), 'brief 必须逐字继承横切判据')
	assert.match(text, /git diff 8a0a01f\.\.HEAD/)
	assert.match(text, /施工段标记：净 diff/)
	assert.match(text, /拍板清单（不得重开）：决策A：按推荐；决策B：不重开/, '拍板清单必须进 brief（不得重开的口径不能让复核者靠猜）')
	assert.deepEqual(value.workflowArgs.map((entry) => entry.label), ['证伪门 smoke-batch·证伪门'])
	assert.equal(value.workflowArgs[0].prompt, text)
})

test('方案证伪 brief（L 档）：对象是方案路径，段标记＝方案', () => {
	const value = assembleChallenge(
		data,
		challengeOf({ tier: 'L', triage: 'L｜跨文件重写', gate: GATE_LABELS.planChallenge, subject: '/home/nvse/code/实施方案/x.md' }),
	)
	assert.equal(value.gate, GATE_LABELS.planChallenge)
	assert.equal(value.segment, '方案')
	assert.deepEqual(value.briefs.map((brief) => brief.form), ['方案证伪'])
	assert.match(value.briefs[0].text, /你是方案证伪者/)
	assert.ok(value.briefs[0].text.includes(data.templates['横切判据']))
})

test('语义域命中：证伪门组合追加安全专项，brief 带安全五问 role 与 extras', () => {
	const value = assembleChallenge(data, challengeOf({ triage: 'M｜涉上传与鉴权' }))
	assert.deepEqual(value.briefs.map((brief) => brief.form), ['证伪门', '安全专项'])
	const safety = value.briefs.find((brief) => brief.form === '安全专项')
	assert.match(safety.text, /鉴权/)
	assert.match(safety.text, /上传/)
	assert.ok(value.warnings.some((warning) => warning.includes('安全专项已加挂')))
	assert.equal(value.workflowArgs.length, 2)
})

test('复核参数校验：占位 subject、未知门、未激活形态、非法裁决数各自报错', () => {
	assert.throws(() => assembleChallenge(data, challengeOf({ subject: '（待写）' })), /先补记方案路径/)
	assert.throws(() => assembleChallenge(data, challengeOf({ subject: 'a\nb' })), /subject 必须是单行/)
	assert.throws(() => assembleChallenge(data, challengeOf({ gate: '门三' })), /未知门/)
	assert.throws(() => assembleChallenge(data, challengeOf({ forms: ['不存在的形态'] })), /forms 含未激活形态/)
	assert.throws(() => assembleChallenge(data, challengeOf({ adjudicate: true, adopted: -1 })), /adopted 必须是非负整数/)
	assert.throws(
		() => assembleChallenge(data, challengeOf({ adjudicate: true, perFormCounts: [{ form: '证伪门', count: -2 }] })),
		/perFormCounts\[0\]\.count 必须是非负整数/,
	)
	assert.equal(validateChallenge(data, challengeOf()), GATE_LABELS.challenge)
})

test('subject 收口：方案证伪缺 subject 报台账占位/空，证伪门缺 subject 报必传带示例形状', () => {
	// 方案证伪：subject 未传（台账占位/空被回填跳过后落到这里）→ 指回台账补记
	assert.throws(
		() => validateChallenge(data, { batch: 'b1', gate: GATE_LABELS.planChallenge }),
		/台账登记是占位\/空，请传实际方案路径＋批次节指针/,
	)
	// 证伪门：subject 不回填，必传且文案带命令形状示例
	assert.throws(
		() => validateChallenge(data, { batch: 'b1', gate: GATE_LABELS.challenge }),
		/subject 必传：净 diff 生成命令，如 git diff 起点\.\.HEAD/,
	)
	// 回填成功形状：subject 一旦补齐（显式或台账回填）两门都放行
	assert.equal(
		validateChallenge(data, { batch: 'b1', gate: GATE_LABELS.planChallenge, subject: '/x/方案.md 的「批2」节' }),
		GATE_LABELS.planChallenge,
	)
	assert.equal(validateChallenge(data, { batch: 'b1', gate: GATE_LABELS.challenge, subject: 'git diff main..HEAD' }), GATE_LABELS.challenge)
})

test('未知参数当场拒绝（不静默丢）：参数名不在声明面即 UnknownParamError', () => {
	assert.doesNotThrow(() => assertKnownParams('dispatch_task', { batch: 'x' }, ['batch']))
	assert.throws(
		() => assertKnownParams('dispatch_task', { nope: 1 }, ['batch']),
		(error) => error instanceof UnknownParamError && /未知参数 nope/.test(error.message),
	)
})

test('生命周期 requires 的机判：立项缺 intent 即错，门报缺 subject 即错', () => {
	assert.throws(() => checkStageRequirements(data, '立项', { batch: 'b', tier: 'M' }), /批次缺必填参数：triage、intent、anchors/)
	assert.throws(() => checkStageRequirements(data, '门报', { batch: 'b', tier: 'M' }), /批次缺必填参数：subject/)
	assert.throws(() => checkStageRequirements(data, '不存在'), /未知阶段/)
	assert.equal(checkStageRequirements(data, '提交', {}).id, '提交', '提交阶段的要求由 dispatch_batch 收，core 不拦')
})

test('参数面覆盖：task/challenge 的参数并集盖住生命周期引用的全部字段', () => {
	assert.equal(assertParamCoverage(), true)
	assert.ok(taskParamNames().includes('subject'), '立项登记 subject 供方案证伪回填')
	assert.ok(challengeParamNames().includes('adjudicate'))
	assert.deepEqual(new Set(taskParamNames()).size, taskParamNames().length, '参数名不许重复')
})

test('渲染：任务书带派发参数段与 JSON 可粘贴，S 档走「免任务书」标题', () => {
	const m = renderTaskResult(assembleTask(data, taskOf()))
	assert.match(m, /── 派发参数（subagent 直接可用；workflow 用 args\.workflowArgs）──/)
	assert.match(m, /"label": "施工 smoke-batch（M）"/)
	const s = renderTaskResult(assembleTask(data, taskOf({ tier: 'S', triage: 'S｜小修' })))
	assert.match(s, /── S 档施工指令（免任务书）──/)
})

test('渲染：证伪门 brief 段头与一轮为限声明；裁决分支改成门报记账文案', () => {
	const brief = renderChallengeResult(assembleChallenge(data, challengeOf()))
	assert.match(brief, /门：证伪门｜形态：证伪门｜段标记：净 diff/)
	assert.match(brief, /一轮为限：本轮报完即收/)
	assert.match(brief, /── 复核 brief：证伪门 ──/)
	const adjudication = renderChallengeResult({
		...assembleChallenge(data, challengeOf()),
		adjudication: { recorded: true, forms: ['证伪门'], adopted: 2, rejected: 1, overlap: 0, missed: '漏了迁移脚本', note: '值假' },
	})
	assert.match(adjudication, /已记门报：批次 smoke-batch｜门 证伪门/)
	assert.match(adjudication, /采纳 2／拒收 1／双报重叠 0/)
	assert.match(adjudication, /漏网：漏了迁移脚本/)
	assert.match(adjudication, /门效能字段照记/)
})

test('方案规范渲染：四节标题＋编号自查', () => {
	const text = renderPlanSpec(data)
	for (const block of data.planSpec.blocks) assert.ok(text.includes(block.title))
	assert.match(text, /定稿自查：\n1\. /)
	assert.match(text, /4\. /)
})

test('未写预算时 M 档给提醒（任务书预算行省略，但口径要提示）', () => {
	const value = assembleTask(data, taskOf())
	assert.ok(value.warnings.some((warning) => warning.includes('预算未写')))
	const withBudget = assembleTask(data, taskOf({ budget: '文件≤30' }))
	assert.ok(!withBudget.warnings.some((warning) => warning.includes('预算未写')))
})
