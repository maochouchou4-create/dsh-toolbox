/**
 * dispatch 核心层：方案文档任务与复核 brief 的组装与渲染（纯函数，data 进、结构化值出）。
 *
 * 「render 直出可派参数」在这里就能断言：workflowArgs 的形态不依赖宿主，node 直调即可（验收#3）。
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
	renderChallengeResult,
	renderPlanSpec,
	renderTaskResult,
	stageRows,
	taskParamNames,
	validateChallenge,
} from '../lib/dispatch/core.js'
import { loadDispatchData } from '../lib/dispatch/data.js'
import { GATE_LABELS } from '../lib/dispatch/vocab.js'

const { data } = loadDispatchData()

const taskOf = (overrides = {}) => ({
	batch: 'smoke-batch',
	intent: '把方案先行的立项出稿落地',
	anchors: ['loadDispatchData', 'SAFETY_CARRIER_IDS'],
	...overrides,
})

const challengeOf = (overrides = {}) => ({
	batch: 'smoke-batch',
	subject: 'git diff 5c6416f..HEAD',
	intent: '把方案先行的立项出稿落地',
	...overrides,
})

test('生命周期行按 order 排序（顺序是状态机的第二处表述，这里钉住）', () => {
	assert.deepEqual(stageRows(data).map((row) => row.id), ['立项', '门报', '提交', '复盘'])
})

test('立项出稿（单形态）：登记行＋方案骨架一次成文，末行门报，直出可派参数', () => {
	const value = assembleTask(data, taskOf())
	assert.ok(value.prompt.includes('定稿自查'), '方案骨架（定稿自查清单）必须进 prompt')
	assert.match(value.prompt, /^你是方案起草者/, '首行给方案先行的角色口径')
	assert.match(value.prompt, /意图：把方案先行的立项出稿落地/)
	assert.match(value.prompt, /锚点（符号名，禁行号）：loadDispatchData、SAFETY_CARRIER_IDS/)
	assert.match(value.prompt, /末行门报：/)
	assert.match(value.prompt, /提交归主会话：完工＝自证＋汇报即止，不 commit 不 push/)
	const noSubject = assembleTask(data, taskOf({ subject: undefined }))
	assert.doesNotMatch(noSubject.prompt, /对象（方案文档/, '未传 subject 时对象行整行省略（可选行）')
	const withSubject = assembleTask(data, taskOf({ subject: '/x/方案.md 的「批2」节' }))
	assert.match(withSubject.prompt, /对象（方案文档绝对路径＋批次节指针）：\/x\/方案\.md 的「批2」节/, '传了 subject 必进登记行——施工者靠它找方案原文')
	assert.deepEqual(value.workflowArgs, { label: '方案 smoke-batch', prompt: value.prompt })
	const rendered = renderTaskResult(value)
	assert.ok(
		rendered.includes(JSON.stringify(value.workflowArgs, null, 2)),
		'派发参数必须逐字可粘贴（node 直调即得，不等宿主重启）',
	)
	assert.match(rendered, /── 派发参数（subagent 直接可用；workflow 用 args\.workflowArgs）──/)
	assert.match(rendered, new RegExp(`── ${value.gateReportLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})

test('立项缺参即错：生命周期 requires 机判（缺哪个点名哪个）', () => {
	assert.throws(() => assembleTask(data, { batch: 'b' }), /批次缺必填参数：intent、anchors/)
	assert.throws(
		() => assembleTask(data, { batch: 'b', intent: 'i' }),
		/批次缺必填参数：anchors/,
	)
	assert.throws(() => checkStageRequirements(data, '立项', { batch: 'b' }), /批次缺必填参数：intent、anchors/)
	assert.throws(() => checkStageRequirements(data, '门报', { batch: 'b' }), /批次缺必填参数：subject/)
	assert.throws(() => checkStageRequirements(data, '不存在'), /未知阶段/)
	assert.equal(checkStageRequirements(data, '提交', {}).id, '提交', '提交阶段的要求由 dispatch_batch 收，core 不拦')
})

test('决策卡：按模板逐卡渲染，缺字段即错（≤6 行由模板形状保证）', () => {
	const value = assembleTask(
		data,
		taskOf({
			decisionCards: [
				{
					question: '门组合从哪份资产读？',
					options: 'lifecycle.json 的 gates 行／代码常量',
					recommendation: 'lifecycle.json 的 gates 行',
					reason: '同一事实的第二处落点＝口径分裂的种子',
					impact: '单源进 lifecycle.json，代码只读不抄',
				},
			],
		}),
	)
	assert.equal(value.decisionCards.length, 1)
	assert.match(value.decisionCards[0], /^决策卡1：门组合从哪份资产读？/)
	assert.match(value.decisionCards[0], /- 选项：lifecycle\.json 的 gates 行／代码常量/)
	assert.throws(
		() => assembleTask(data, taskOf({ decisionCards: [{ question: '缺四格' }] })),
		/decisionCards\[0\]\.options 必须是非空字符串/,
	)
})

test('证伪门 brief：缺省一路标准形态（证伪复核），继承横切判据原文与对象命令', () => {
	const value = assembleChallenge(data, challengeOf({ decisions: ['决策A：按推荐', '决策B：不重开'] }))
	assert.equal(value.gate, GATE_LABELS.challenge)
	assert.equal(value.segment, '净 diff')
	assert.deepEqual(value.briefs.map((brief) => brief.form), ['证伪复核'])
	const text = value.briefs[0].text
	assert.match(text, /你是独立证伪者/)
	assert.match(text, /不读施工汇报/)
	assert.ok(text.includes(data.templates['横切判据']), 'brief 必须逐字继承横切判据')
	assert.match(text, /git diff 5c6416f\.\.HEAD/)
	assert.match(text, /施工段标记：净 diff/)
	assert.match(text, /拍板清单（不得重开）：决策A：按推荐；决策B：不重开/, '拍板清单必须进 brief（不得重开的口径不能让复核者靠猜）')
	assert.deepEqual(value.workflowArgs.map((entry) => entry.label), ['证伪门 smoke-batch·证伪复核'])
	assert.equal(value.workflowArgs[0].prompt, text)
})

test('forms 追加语义：点名安全专项＝追加不替换，五问随形态进 brief', () => {
	const value = assembleChallenge(data, challengeOf({ forms: ['安全专项'] }))
	assert.deepEqual(value.briefs.map((brief) => brief.form), ['证伪复核', '安全专项'], '缺省标准形态保留，点名追加')
	const safety = value.briefs.find((brief) => brief.form === '安全专项')
	assert.match(safety.text, /鉴权/)
	assert.match(safety.text, /上传/)
	assert.equal(value.workflowArgs.length, 2)
	// 点名已在缺省名单里的形态＝去重不重复
	const deduped = assembleChallenge(data, challengeOf({ forms: ['证伪复核'] }))
	assert.deepEqual(deduped.briefs.map((brief) => brief.form), ['证伪复核'])
})

test('forms 点名异门形态即错：方案证伪不挂证伪门', () => {
	assert.throws(
		() => assembleChallenge(data, challengeOf({ forms: ['方案证伪'] })),
		/forms 点名的形态「方案证伪」不属于门「证伪门」/,
	)
})

test('方案证伪 brief：对象是方案路径，段标记＝方案', () => {
	const value = assembleChallenge(
		data,
		challengeOf({ gate: GATE_LABELS.planChallenge, subject: '/home/nvse/code/实施方案/x.md' }),
	)
	assert.equal(value.gate, GATE_LABELS.planChallenge)
	assert.equal(value.segment, '方案')
	assert.deepEqual(value.briefs.map((brief) => brief.form), ['方案证伪'])
	assert.match(value.briefs[0].text, /你是方案证伪者/)
	assert.ok(value.briefs[0].text.includes(data.templates['横切判据']))
})

test('复核参数校验：占位 subject、未知门、未激活形态、非法裁决数各自报错', () => {
	assert.throws(() => assembleChallenge(data, challengeOf({ subject: '（待写）' })), /先补记方案路径/)
	assert.throws(() => assembleChallenge(data, challengeOf({ subject: 'a\nb' })), /subject 必须是单行/)
	assert.throws(() => assembleChallenge(data, challengeOf({ gate: '门三' })), /未知门/)
	assert.throws(() => assembleChallenge(data, challengeOf({ forms: ['不存在的形态'] })), /forms 含未激活形态/)
	assert.throws(() => assembleChallenge(data, challengeOf({ adjudicate: true, adopted: -1 })), /adopted 必须是非负整数/)
	assert.throws(
		() => assembleChallenge(data, challengeOf({ adjudicate: true, perFormCounts: [{ form: '证伪复核', count: -2 }] })),
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

test('参数面覆盖：task/challenge 的参数并集盖住生命周期引用的全部字段', () => {
	assert.equal(assertParamCoverage(), true)
	assert.ok(taskParamNames().includes('subject'), '立项登记 subject 供方案证伪回填')
	assert.ok(challengeParamNames().includes('adjudicate'))
	assert.deepEqual(new Set(taskParamNames()).size, taskParamNames().length, '参数名不许重复')
	assert.deepEqual(new Set(challengeParamNames()).size, challengeParamNames().length, '参数名不许重复')
})

test('渲染：证伪门 brief 段头与一轮为限声明；裁决分支改成门报记账文案', () => {
	const brief = renderChallengeResult(assembleChallenge(data, challengeOf()))
	assert.match(brief, /门：证伪门｜形态：证伪复核｜段标记：净 diff/)
	assert.match(brief, /一轮为限：本轮报完即收/)
	assert.match(brief, /── 复核 brief：证伪复核 ──/)
	const adjudication = renderChallengeResult({
		...assembleChallenge(data, challengeOf()),
		adjudication: { recorded: true, forms: ['证伪复核'], adopted: 2, rejected: 1, overlap: 0, missed: '漏了迁移脚本', note: '值假' },
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
