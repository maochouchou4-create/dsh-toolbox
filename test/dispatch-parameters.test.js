/**
 * dispatch 参数面（v2 两件装配＋台账一件）：schema 声明是模型选型的唯一依据——它写的取值
 * 清单与必填标注会被原样抄进调用，所以这里钉三件事：键集与 core 名单一字不差、必填标注与
 * 生命周期 requires 对齐、退役参数不得回流（旧四件的 stage/baseBatchType/rootCause 不再有槽位）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	assertParamCoverage,
	challengeParamNames,
	taskParamNames,
} from '../lib/dispatch/core.js'
import { batchParameters, challengeParameters, taskParameters } from '../lib/dispatch/parameters.js'
import { loadDispatchData } from '../lib/dispatch/data.js'
import { BACKFILL_FIELDS, GATE_NAMES, PARAM_FIELDS, TIERS } from '../lib/dispatch/vocab.js'

const { data } = loadDispatchData()
const task = taskParameters()
const challenge = challengeParameters()
const batch = batchParameters()
const requiredOf = (parameters) =>
	Object.entries(parameters)
		.filter(([, spec]) => spec.required === true)
		.map(([name]) => name)
		.sort()

test('键集对账：parameters.js 与 core 的名单逐名一致（顺序也同，模型看到的就是这个序）', () => {
	assert.deepEqual(Object.keys(task), taskParamNames())
	assert.deepEqual(Object.keys(challenge), challengeParamNames())
	assert.equal(new Set(taskParamNames()).size, taskParamNames().length)
	assert.equal(new Set(challengeParamNames()).size, challengeParamNames().length)
})

test('生命周期 → schema 必填：立项五格全必填，门报只有 batch 必填（subject/tier 都按门分叉）', () => {
	const startRequires = data.lifecycle.stages.find((stage) => stage.id === '立项').requires
	assert.deepEqual(requiredOf(task), [...startRequires].sort())
	const gateRequires = data.lifecycle.stages.find((stage) => stage.id === '门报').requires
	const derived = gateRequires.filter((field) => !['tier', 'triage', 'intent', 'decisions', 'subject'].includes(field))
	assert.deepEqual(requiredOf(challenge), [...derived].sort(), '必填＝requires − 台账可回填集 − subject（subject 按门分叉：方案证伪从台账回填，证伪门由 core 校验报必传）')
	assert.ok(!challenge.tier.required, 'tier 必须可缺省——它从台账回填')
	assert.ok(!challenge.subject.required, 'subject 不做 schema 级必填——必传与否取决于门，在 core 校验层报错')
})

test('参数覆盖：task/challenge 并集盖住生命周期引用的全部字段（不落空）', () => {
	assert.equal(assertParamCoverage(), true)
	const declared = new Set([...taskParamNames(), ...challengeParamNames()])
	for (const field of PARAM_FIELDS) {
		if (field === 'batch') continue
		assert.ok(declared.has(field), `PARAM_FIELDS 的 ${field} 没有工具接`)
	}
})

test('取值词表进描述：档位三档、门名两名都写在对应参数说明里（模型照抄不错）', () => {
	for (const tier of TIERS) assert.ok(task.tier.description.includes(tier))
	assert.match(task.tier.description, /S 小修/)
	for (const gate of GATE_NAMES) assert.ok(challenge.gate.description.includes(gate))
	assert.match(challenge.gate.description, /缺省/)
	assert.ok(batch.action.description.startsWith('commit｜review｜status｜list'))
})

test('退役参数不得回流：旧四件的阶段/批型/根因槽位一个都不许有', () => {
	for (const retired of ['stage', 'baseBatchType', 'rootCause', 'tools', 'action', 'tools', 'planSpec']) {
		assert.ok(!(retired in task), `dispatch_task 不该再有 ${retired}`)
		assert.ok(!(retired in challenge), `dispatch_challenge 不该再有 ${retired}`)
	}
	for (const name of ['stage', 'advance', 'gateName', 'perForm']) {
		assert.ok(!(name in batch), `dispatch_batch 不该再有 ${name}`)
	}
})

test('值类型：规模与裁决数字是 number、adjudicate 是 boolean、清单是 array', () => {
	assert.equal(task.changedFiles.type, 'number')
	assert.equal(task.diffLines.type, 'number')
	assert.equal(task.anchors.type, 'array')
	assert.equal(task.decisionCards.type, 'array')
	assert.equal(challenge.adjudicate.type, 'boolean')
	assert.equal(challenge.label, undefined)
	for (const field of ['adopted', 'rejected', 'overlap']) assert.equal(challenge[field].type, 'number')
	assert.equal(challenge.perFormCounts.type, 'array')
	assert.equal(challenge.forms.type, 'array')
})

test('台账参数面：commit/review 各要两格、status 动作要 action（必填唯一）', () => {
	assert.deepEqual(requiredOf(batch), ['action'])
	assert.ok(batch.commit && batch.pushed && batch.retro && batch.efficacy)
	assert.match(batch.retro.description, /复盘行（action=review 必填，单行）：本批结论＋下一轮口径/)
	assert.match(batch.action.description, /commit/)
})
