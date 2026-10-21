/**
 * dispatch 数据面（v2 五份 JSON）的镜像与互验：形状、存活集、跨文件绑死、模板快照，
 * 外加「改锚点字段必红」的变异演示（方案 M8：埋雷体检内置于测试，nip 在数据面而不是人脑）。
 *
 * 镜像为什么放这里：五份 JSON 是规则面，改一个字段就改行为；测试不镜像时，改动只在下次
 * 调用时才现形，而那时已经进了生产。快照用内容指纹而不是逐字副本：逐字副本 200 行、
 * 每次改模板都要抄一遍（抄漏是静默的），指纹只钉「正文有没有变」，改正文就得同步改指纹。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
	ASSEMBLER_CONTRACTS,
	DATA_FILES,
	DispatchDataError,
	SAFETY_CARRIER_IDS,
	TEMPLATE_KEYS,
	loadDispatchData,
	renderTemplate,
} from '../lib/dispatch/data.js'
import { GATE_LABELS, GATE_NAMES, LIFECYCLE_KINDS, TIERS } from '../lib/dispatch/vocab.js'
import { DISPATCH_DATA_DIR, editData, withDataDir } from './helpers.js'

const readJson = (name) => JSON.parse(readFileSync(join(DISPATCH_DATA_DIR, name), 'utf8'))

/** 各份数据的条目数：多一件/少一件都是改规则，这里钉住「盘上到底几件」。 */
const COUNT_SNAPSHOT = {
	forms: 3,
	tiers: 3,
	hardTriggers: 3,
	templates: TEMPLATE_KEYS.length,
	stages: 4,
	blocks: 4,
	checklist: 4,
}

/** 模板正文指纹（sha256 前 16 位）：改正文＝改规则，同步更新这里的指纹。 */
const TEMPLATE_SNAPSHOT = {
	任务书骨架: '525d2eaef132342f',
	证伪门: '14ef69885dfe0cc6',
	方案证伪: 'b6474adc91c1cb9f',
	横切判据: '37ec72bac6ddad5e',
	拍板卡: '4ac0c4f5d0a838e0',
	门报行: 'dc3c008c9dd64aab',
}

const digestOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

test('数据面加载全绿：五份现读、零 issue、零 warning', () => {
	const loaded = loadDispatchData()
	assert.deepEqual(loaded.warnings, [])
	assert.deepEqual(Object.keys(loaded.data).sort(), DATA_FILES.map((entry) => entry.name).sort())
	for (const entry of DATA_FILES) {
		assert.equal(typeof loaded.raw[entry.name], 'string', `${entry.file} 的原始字节要留着（规则指纹取它）`)
	}
})

test('条目数快照：三形态／三档位／三硬触发／四阶段／四节方案规范', () => {
	const { data } = loadDispatchData()
	assert.deepEqual(
		{
			forms: data.forms.forms.length,
			tiers: data.pairing.tiers.length,
			hardTriggers: data.pairing.hardTriggers.length,
			templates: Object.keys(data.templates).length,
			stages: data.lifecycle.stages.length,
			blocks: data.planSpec.blocks.length,
			checklist: data.planSpec.checklist.length,
		},
		COUNT_SNAPSHOT,
	)
})

test('快照键集≡templates 键集≡TEMPLATE_KEYS（三处对账，缺一不可）', () => {
	const { data } = loadDispatchData()
	assert.deepEqual(Object.keys(data.templates).sort(), [...TEMPLATE_KEYS].sort())
	assert.deepEqual(Object.keys(TEMPLATE_SNAPSHOT).sort(), [...TEMPLATE_KEYS].sort())
	assert.deepEqual(
		Object.keys(data.templates).sort(),
		Object.keys(TEMPLATE_SNAPSHOT).sort(),
		'templates.json 与测试快照键集必须一致',
	)
})

test('模板正文指纹：六份模板逐字钉住（改正文＝改规则）', () => {
	const { data } = loadDispatchData()
	const actual = Object.fromEntries(Object.keys(TEMPLATE_SNAPSHOT).map((key) => [key, digestOf(data.templates[key])]))
	assert.deepEqual(actual, TEMPLATE_SNAPSHOT)
})

test('模板结构不变量：任务书带门报行、横切判据带四信号、门报行是三段式', () => {
	const { data } = loadDispatchData()
	assert.match(data.templates['任务书骨架'], /末行门报：〔门报行〕/)
	assert.match(data.templates['横切判据'], /设计四信号：按 AGENTS\.md 设计纪律/)
	assert.match(data.templates['横切判据'], /设计级 finding/)
	assert.match(data.templates['横切判据'], /1000 行/)
	for (const part of ['项编号', '结果 PASS/FAIL', '首条失败']) {
		assert.ok(data.templates['门报行'].includes(part), `门报行缺「${part}」`)
	}
	assert.ok(data.templates['证伪门'].includes('不读施工汇报'))
	assert.ok(data.templates['证伪门'].includes('〔横切判据〕'), '证伪门 brief 必须继承横切判据原文')
	assert.match(data.templates['证伪门'], /砍刀第一问：这个零件能不能不写？/, '砍刀口径须落在证伪门模板里（batch-subagent-process 已宣称并入）')
	assert.ok(data.templates['证伪门'].includes('〔decisions〕'), '拍板清单要进复核 brief（不重开的口径必须让复核者看见）')
	assert.ok(data.templates['方案证伪'].includes('〔横切判据〕'))
})

test('形态存活集：恰好三件，安全专项是五问唯一单源，门与词表对齐', () => {
	const { data } = loadDispatchData()
	const forms = data.forms.forms
	assert.deepEqual(forms.map((form) => form.id).sort(), ['安全专项', '方案证伪', '证伪门'])
	for (const form of forms) {
		assert.ok(GATE_NAMES.includes(form.gate), `${form.id} 的门名不在词表里`)
		assert.ok(form.role.trim().length > 0)
		assert.ok(form.catches.trim().length > 0)
	}
	assert.deepEqual(SAFETY_CARRIER_IDS, ['安全专项'])
	const safety = forms.find((form) => form.id === SAFETY_CARRIER_IDS[0])
	for (const anchor of ['鉴权', '越权', '输入', '上传', 'PII']) {
		assert.ok(safety.role.includes(anchor), `安全专项 role 缺五问锚点「${anchor}」`)
	}
	assert.equal(safety.gate, GATE_LABELS.challenge)
	for (const form of forms.filter((item) => item !== safety)) {
		for (const anchor of ['鉴权', '越权', '输入', '上传', 'PII']) {
			assert.ok(!form.role.includes(anchor), `${form.id} 复述了安全五问「${anchor}」`)
		}
	}
})

test('档位表：S/M/L 三行，门列与 taskBook 自洽；硬触发三件各就各位', () => {
	const { data } = loadDispatchData()
	assert.deepEqual(data.pairing.tiers.map((row) => row.tier), TIERS)
	const byTier = new Map(data.pairing.tiers.map((row) => [row.tier, row]))
	assert.equal(byTier.get('S').taskBook, false)
	assert.equal(byTier.get('S').challenge, null)
	assert.equal(byTier.get('M').taskBook, true)
	assert.deepEqual(byTier.get('M').challenge, ['证伪门'])
	assert.equal(byTier.get('M').planChallenge, null)
	assert.deepEqual(byTier.get('L').challenge, ['证伪门'])
	assert.deepEqual(byTier.get('L').planChallenge, ['方案证伪'])

	const triggers = new Map(data.pairing.hardTriggers.map((row) => [row.id, row]))
	assert.deepEqual([...triggers.keys()].sort(), ['diff 超阈', '公开契约', '语义域'])
	assert.equal(triggers.get('公开契约').upgrade, 'M')
	assert.equal(triggers.get('语义域').upgrade, 'M')
	assert.equal(triggers.get('语义域').form, SAFETY_CARRIER_IDS[0])
	assert.equal(triggers.get('diff 超阈').upgrade, 'L')
	assert.equal(triggers.get('diff 超阈').threshold, 1000)
})

test('生命周期四事件：立项→门报→提交→复盘，复盘行收官即清账', () => {
	const { data } = loadDispatchData()
	const stages = [...data.lifecycle.stages].sort((a, b) => a.order - b.order)
	assert.deepEqual(stages.map((stage) => stage.id), ['立项', '门报', '提交', '复盘'])
	assert.deepEqual(stages.map((stage) => stage.kind), LIFECYCLE_KINDS)
	assert.deepEqual(stages.filter((stage) => stage.gate).map((stage) => stage.id), ['门报'])
	assert.deepEqual(stages.find((stage) => stage.id === '复盘').note, 'dispatch_batch action=review 写 review 事件（复盘行＋门效能字段），收官即清该批全部台账行。')
	assert.deepEqual(stages.find((stage) => stage.id === '立项').requires, ['batch', 'tier', 'triage', 'intent', 'anchors'])
})

test('装配契约与生命周期对齐：task→立项/start、challenge→门报/gate', () => {
	const { data } = loadDispatchData()
	assert.deepEqual(ASSEMBLER_CONTRACTS.map((contract) => contract.name), ['dispatch_task', 'dispatch_challenge'])
	for (const contract of ASSEMBLER_CONTRACTS) {
		const stage = data.lifecycle.stages.find((row) => row.id === contract.stage)
		assert.ok(stage, `${contract.name} 指向的阶段不存在`)
		assert.equal(stage.gate, contract.event === 'gate')
	}
})

test('模板渲染：空值整行省略、未知占位符与缺值都当场报错', () => {
	assert.equal(renderTemplate('a\n〔门报行〕\nb', { 门报行: '' }), 'a\nb')
	assert.equal(renderTemplate('〔tier〕档', { tier: 'M' }), 'M档')
	assert.throws(() => renderTemplate('〔没登记〕', {}), /未知占位符/)
	assert.throws(() => renderTemplate('〔tier〕', {}), /缺占位符值/)
})

test('模板行数上限：任务书骨架超 15 行、拍板卡超 6 行都在加载期报错（带实际行数）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'templates.json', (value) => {
			const lines = value['任务书骨架'].split('\n').length
			value['任务书骨架'] = `${value['任务书骨架']}\n${Array.from({ length: 16 - lines }, (_, i) => `多余行 ${i + 1}`).join('\n')}`
		})
		assert.throws(
			() => loadDispatchData(dir),
			(error) => /「任务书骨架」16 行，超过 15 行上限/.test(error.message),
		)
	})
	withDataDir(t, (dir) => {
		editData(dir, 'templates.json', (value) => {
			value['拍板卡'] = `${value['拍板卡']}\n- 多余行 1\n- 多余行 2`
		})
		assert.throws(
			() => loadDispatchData(dir),
			(error) => /「拍板卡」7 行，超过 6 行上限/.test(error.message),
		)
	})
})

test('埋雷体检（变异演示）：改锚点字段数据面必红，复原后回绿', (t) => {
	withDataDir(t, (dir) => {
		const before = loadDispatchData(dir)
		assert.equal(before.data.forms.forms.length, 3)

		editData(dir, 'forms.json', (value) => {
			const safety = value.forms.find((form) => form.id === SAFETY_CARRIER_IDS[0])
			safety.role = safety.role.replace('鉴权', '权限')
		})
		assert.throws(() => loadDispatchData(dir), /缺五问锚点「鉴权」/)

		editData(dir, 'templates.json', (value) => {
			value['任务书骨架'] = value['任务书骨架'].replace('〔门报行〕', '〔没登记的口子〕')
		})
		assert.throws(() => loadDispatchData(dir), /未知占位符/)

		editData(dir, 'pairing.json', (value) => {
			value.tiers = value.tiers.filter((row) => row.tier !== 'M')
		})
		assert.throws(() => loadDispatchData(dir), /缺档位行 M/)
	})
})

test('跨文件互验：档位门的形态挂错门即红（数据与词表绑死）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (value) => {
			value.tiers.find((row) => row.tier === 'M').challenge = ['方案证伪']
		})
		assert.throws(() => loadDispatchData(dir), /列与门不符/)
	})
})

test('数据文件缺失即红：读不到不当空表处理', (t) => {
	withDataDir(t, (dir) => {
		rmSync(join(dir, 'templates.json'))
		assert.throws(() => loadDispatchData(dir), /读不到数据文件/)
	})
})

test('坏 JSON 即红：报出文件名与解析原因', (t) => {
	withDataDir(t, (dir) => {
		writeFileSync(join(dir, 'pairing.json'), '{ not json')
		assert.throws(() => loadDispatchData(dir), /pairing\.json 不是合法 JSON/)
	})
})

test('DispatchDataError 是加载期唯一错误类型（调用方只 catch 这一种）', () => {
	try {
		loadDispatchData(join(DISPATCH_DATA_DIR, 'missing'))
		assert.fail('应抛 DispatchDataError')
	} catch (error) {
		assert.ok(error instanceof DispatchDataError)
		assert.match(error.message, /读不到数据文件/)
	}
})

test('未被引用的形态给 warning 而不是 issue（懒加载件也要被看见）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'forms.json', (value) => {
			value.forms.push({
				id: '待激活件',
				gate: GATE_LABELS.challenge,
				catches: '尚未接线的检查项',
				role: '你是待激活的证伪者',
			})
		})
		const loaded = loadDispatchData(dir)
		assert.ok(loaded.warnings.some((warning) => warning.includes('待激活件')))
	})
})
