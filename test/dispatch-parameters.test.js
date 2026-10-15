/**
 * dispatch 工具参数面单测（node:test，零宿主依赖）：参数面是模型选型的唯一依据——它写的
 * 取值清单与必填标注会被原样抄进调用，而那份面在 data 现读拼出来之后，「改了 JSON 描述还在
 * 旧名单」这件事就有了可验的地方。这里核三件：键集与 core 的参数名全集同源、stage 取值清单
 * ＝可服务阶段且按 order 排、batchType 不标必填（方案阶段不判批型，标了等于逼模型编批型）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PARAM_FIELDS, dispatchStages, stageVocabulary, validateParams } from '../lib/dispatch/core.js'
import { dispatchParameters } from '../lib/dispatch/parameters.js'

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'dispatch', 'data')
const readData = (name) => JSON.parse(readFileSync(join(dataDir, name), 'utf8'))
const data = {
	forms: readData('forms.json'),
	pairing: readData('pairing.json'),
	templates: readData('templates.json'),
	lifecycle: readData('lifecycle.json'),
	planSpec: readData('plan-spec.json'),
}

const parameters = dispatchParameters(data)

test('参数面的键集＝core 的参数名全集（两份名单同源，多一个少一个都红）', () => {
	assert.deepEqual(Object.keys(parameters), PARAM_FIELDS)
	for (const field of PARAM_FIELDS) {
		assert.equal(parameters[field].type, ['decisions', 'addons', 'anchors'].includes(field) ? 'array' : 'string', `${field} 的类型`)
	}
})

test('stage 取值清单＝本工具能出稿的阶段，按 lifecycle 的 order 排（提交/复盘归各自的工具，不列）', () => {
	assert.equal(parameters.stage.required, true)
	const listed = parameters.stage.description.split(' | ')
	assert.deepEqual(listed, ['方案', '门一', '施工', '门二'])
	assert.deepEqual(listed, dispatchStages(data), '清单现读：不手抄就停了上一次改 JSON 之前的名字')
	assert.deepEqual(listed, stageVocabulary(data).filter((stage) => listed.includes(stage)), '清单是阶段词表按 order 排后的子集（手抄成别的顺序这里就红）')
	for (const out of ['提交', '复盘']) {
		assert.ok(!listed.includes(out), `${out} 不在本工具的服务范围内，列进去等于让模型照着调一个出不了稿的阶段`)
	}
	assert.ok(!parameters.stage.description.includes(' | 提交'), '清单里不许出现不可达阶段')
})

test('回填面四格都不标必填（宿主按 schema 拦必填发生在进 execute 之前，台账回填就永远到不了；必填判定归 core.validateParams）', () => {
	assert.equal(parameters.batchType.required, undefined)
	assert.deepEqual(parameters.batchType.required, undefined, '手抄回 required:true 这里红')
	assert.equal(parameters.subject.required, undefined, '对象那格能由 batch 回填，schema 标必填＝回填到不了')
	assert.equal(parameters.intent.required, undefined, '意图那格能由 batch 回填，schema 标必填＝回填到不了')
	assert.equal(parameters.decisions.required, undefined)
	assert.equal(parameters.anchors.required, undefined, '阶段级必填由 core.validateParams 按数据点名，schema 里不标')
	assert.equal(parameters.stage.required, true, 'stage 是调用形态参数、不在回填面，宿主层拦形态错误是好事')
	for (const field of ['batchType', 'subject', 'intent', 'decisions']) {
		assert.ok(parameters[field].description.includes('缺省可由 batch 回填'), `${field} 的描述要告诉模型这格可以从台账来，否则不传就以为该编`)
	}
	assert.ok(parameters.batchType.description.startsWith('批型（门一/施工/门二阶段必填'), '必填阶段名单现读自 lifecycle 的 requires')
	for (const row of data.pairing.rows.filter((entry) => entry.kind !== 'addon')) {
		assert.ok(parameters.batchType.description.includes(row.batchType), `主行「${row.batchType}」漏在描述外，模型照着挑不到`)
	}
	for (const row of data.pairing.rows.filter((entry) => entry.kind === 'addon')) {
		assert.ok(parameters.batchType.description.includes(row.batchType), `加挂行「${row.batchType}」漏在描述外，模型改用 addons 时挑不到`)
	}
})

test('描述里的阶段名单与 core 的槽位消费集一致（描述说某阶段可填，契约就得真消费它）', () => {
	assert.match(parameters.anchors.description, /施工必填$/)
	assert.match(parameters.forbidden.description, /施工可选$/)
	assert.match(parameters.verifyCmd.description, /施工可选$/)
	assert.match(parameters.baseBatchType.description, /只在这一趟的组合可能落回原批型时消费（有门列，且该行标 needsBase 或主行该列为空），否则收到即报错/, '条件槽位把条件写进描述：只说「不消费」会让模型在门一/纯后端管线批那一趟反复重试')
	assert.match(parameters.decisions.description, /门一\/施工\/门二阶段逐条成行.*方案那一趟不消费它/, 'decisions 的描述说清哪些阶段消费它')
	assert.match(parameters.rootCause.description, /别的阶段与别的批型收到即报错/)
	assert.match(parameters.subject.description, /门二＝净 diff 生成命令/, '两态语义是规则本身，不是可变的阶段清单')
	assert.throws(() => validateParams(data, { stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: 'y', anchors: ['a'] }), /stage=门一 不消费 anchors——消费它的是施工阶段/, '描述说施工才要 anchors，别的阶段传它就该被拒')
})

test('描述面不残留手抄的阶段名单（加了阶段或改了 requires，描述跟着走）', () => {
	const extended = structuredClone(data)
	extended.lifecycle.stages.push({
		id: '验收', order: 7, gate: false, kind: '验收',
		requires: ['subject', 'intent', 'anchors'], produces: ['验收结论'], uses: [], note: '单测现造的阶段',
	})
	extended.templates.验收 = '验收结论：〔intent〕。〔subject〕〔anchors〕'
	const extendedParameters = dispatchParameters(extended)
	assert.match(extendedParameters.stage.description, /验收$/, '新阶段自动进 stage 取值清单')
	assert.match(extendedParameters.anchors.description, /施工\/验收必填$/, '新阶段要 anchors 后描述里的名单跟着走')
})
