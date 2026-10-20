/**
 * 复盘辅助（dispatch_lessons）：点位判定、跨批统计、建议草稿、只读门面。
 *
 * review 事件＝全仓销账点：其后仍有事件的批进增量窗口，之前的只进全量累计。统计必须能按
 * 规则指纹分组（配对表改过之后，旧批 findings 率不能和新口径平均）——这是建议可信的前提。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
	buildSuggestions,
	collectStats,
	judgeDue,
	pointOf,
	renderLessonsResult,
	runLessons,
} from '../lib/dispatch/lessons.js'
import { gateEvent, reviewEvent, startEvent } from '../lib/dispatch/batch.js'
import { loadDispatchData } from '../lib/dispatch/data.js'
import { createNodeFsPort, createReadOnlyPort } from '../lib/fs-port.js'
import { GATE_LABELS } from '../lib/dispatch/vocab.js'
import { tempRoot } from './helpers.js'

const { data } = loadDispatchData()
const at = (minute) => `2026-01-01T0${Math.floor(minute / 60)}:${String(minute % 60).padStart(2, '0')}:00.000Z`
const startOf = (batch, minute, overrides = {}) =>
	startEvent({ batch, tier: 'M', triage: 'M｜内部实现', intent: '意图', rules: 'rule00000001', now: at(minute), ...overrides })
const gateOf = (batch, minute, overrides = {}) =>
	gateEvent({ batch, gate: GATE_LABELS.challenge, tier: 'M', segment: '净 diff', now: at(minute), ...overrides })

test('点位判据取 lifecycle 复盘行的 point（阈值单源，不在代码里抄）', () => {
	assert.deepEqual(pointOf(data), { minBatches: 5, minTiers: 3, upperBatches: 8, stage: '复盘' })
	assert.throws(() => pointOf({ lifecycle: { stages: [{ id: '复盘' }] } }), /缺 point 字段/)
})

test('空台账统计：全零、无销账点、采纳率为 null（不是 0——没数据不等于拒收）', () => {
	const stats = collectStats([])
	assert.equal(stats.batches, 0)
	assert.equal(stats.cutoff, null)
	assert.equal(stats.incrementCount, 0)
	assert.equal(stats.gateRounds, 0)
	assert.equal(stats.adoptionRate, null)
	assert.equal(stats.avgFixRounds, 0)
	assert.deepEqual(stats.uselessForms, [])
	assert.deepEqual(stats.versions, [])
})

test('跨批统计：增量窗口按最近 review 切、采纳/拒收/重叠累加、修复轮数＝门轮数−1', () => {
	const events = [
		startOf('b1', 0),
		gateOf('b1', 1, { adopted: 2, rejected: 1, perFormCounts: [{ form: '证伪门', count: 3 }] }),
		reviewEvent({ batch: 'b1', retro: '第一批收', efficacy: '拦住假值', now: at(2) }),
		startOf('b2', 3, { tier: 'L', triage: 'L｜跨文件重写' }),
		gateOf('b2', 4, { forms: ['证伪门', '安全专项'], adopted: 1, rejected: 1, missed: '迁移脚本' }),
		gateOf('b2', 5, { adopted: 0, rejected: 0, overlap: 2 }),
	]
	const stats = collectStats(events)
	assert.equal(stats.batches, 2)
	assert.equal(stats.cutoff, at(2))
	assert.equal(stats.incrementCount, 1, 'b1 在销账点之前，不进增量')
	assert.deepEqual(stats.incrementTypes, ['L'])
	assert.deepEqual(stats.allTypes.sort(), ['L', 'M'])
	assert.equal(stats.gateRounds, 3)
	assert.equal(stats.adopted, 3)
	assert.equal(stats.rejected, 2)
	assert.equal(stats.overlap, 2)
	assert.equal(stats.missedBatches, 1)
	assert.equal(stats.avgFixRounds, 0.5, 'b1 无门 0 轮、b2 证伪门 2 轮 → (0+1)/2')
	assert.equal(stats.maxFixRounds, 1)
	assert.equal(stats.adoptionRate, 3 / 5)
	assert.deepEqual(stats.formFindings, [{ form: '证伪门', count: 3 }])
	assert.deepEqual(stats.uselessForms, [], '安全专项只实派 1 次，还不到零拦截观测下限 2 次')
	assert.deepEqual(stats.versions, [{ rules: 'rule00000001', batchCount: 2 }])
	assert.deepEqual(stats.efficacy.length, 1)
})

test('零拦截形态：实派 ≥2 次且 findings 0 条才进降级候选（不跨版本平均靠分组展示）', () => {
	const events = []
	for (let index = 0; index < 3; index += 1) {
		events.push(startOf(`b${index}`, index * 10, { rules: index < 2 ? 'oldrules0001' : 'newrules0002' }))
		events.push(gateOf(`b${index}`, index * 10 + 1, { forms: ['证伪门'], perFormCounts: [{ form: '证伪门', count: 0 }] }))
	}
	const stats = collectStats(events)
	assert.deepEqual(stats.uselessForms, [{ form: '证伪门', dispatched: 3 }])
	assert.deepEqual(stats.versions.map((item) => item.rules), ['oldrules0001', 'newrules0002'])
})

test('点位判定：增量批数与档位覆盖同时达标才算到点；全量超上限强制提示', () => {
	const point = pointOf(data)
	const base = { incrementCount: 5, incrementTypes: ['M', 'L', 'S'], batches: 5 }
	assert.equal(judgeDue(base, point).due, true)
	assert.equal(judgeDue({ ...base, incrementTypes: ['M'] }, point).due, false, '档位覆盖不够')
	assert.equal(judgeDue({ ...base, incrementCount: 4 }, point).due, false, '批数不够')
	const forced = judgeDue({ ...base, incrementCount: 0, incrementTypes: [], batches: 8 }, point)
	assert.equal(forced.due, true)
	assert.equal(forced.forcedByVolume, true)
	assert.match(judgeDue({ ...base, cutoff: null }, point).reason, /还没有 review 事件/)
})

test('建议草稿：未到点位只给一句攒批提示；force 时逐条给方向', () => {
	const point = pointOf(data)
	const early = collectStats([startOf('b1', 0), gateOf('b1', 1)])
	const notDue = buildSuggestions(early, point, false)
	assert.equal(notDue.length, 1)
	assert.match(notDue[0], /未到复盘点位：增量 1 批／需 5 批/)

	const stats = {
		incrementCount: 6,
		incrementTypes: ['M', 'L', 'S'],
		batches: 6,
		cutoff: at(0),
		gateRounds: 4,
		adopted: 1,
		rejected: 4,
		overlap: 2,
		adoptionRate: 0.2,
		missedBatches: 1,
		avgFixRounds: 2,
		maxFixRounds: 3,
		uselessForms: [{ form: '证伪门', dispatched: 3 }],
		formFindings: [],
		versions: [],
		efficacy: ['b1：拦住假值'],
	}
	const suggestions = buildSuggestions(stats, point, true).join('\n')
	assert.match(suggestions, /证伪门：全量台账实派 3 次、findings 0 条 → 建议降级或删除/)
	assert.match(suggestions, /漏网 1 批/)
	assert.match(suggestions, /修复轮数均值 2\.0/)
	assert.match(suggestions, /双报重叠 2／4 轮/)
	assert.match(suggestions, /采纳率 20%/)
	assert.match(suggestions, /门效能记录/)

	const clean = buildSuggestions({ ...stats, uselessForms: [], missedBatches: 0, avgFixRounds: 1, overlap: 0, adopted: 9, rejected: 1, adoptionRate: 0.9, efficacy: [] }, point, true)
	assert.deepEqual(clean, ['无可采建议：本轮维持现配对表（先把台账攒厚，单批样本不足以改规则）。'])
})

test('只读门面：runLessons 逐趟现读、不写盘（端口的写方法一次都没被调）', async (t) => {
	const dir = tempRoot(t, 'lessons')
	const path = join(dir, 'data', 'dispatch-ledger.jsonl')
	mkdirSync(dirname(path), { recursive: true })
	await runLessons({ port: createNodeFsPort(), path })
	const empty = await runLessons({ port: createNodeFsPort(), path })
	assert.equal(empty.due, false)
	assert.match(empty.stats, /复盘口径：上次复盘〔无（全量）〕｜增量 0 批｜全量 0 批/)
	assert.match(empty.stats, /点位判据：攒 5–8 批、覆盖 ≥3 档位 → 未到点位/)
	assert.match(empty.suggestions[0], /未到复盘点位/)

	const events = [
		startOf('b1', 0),
		gateOf('b1', 1),
		reviewEvent({ batch: 'b1', retro: '收', now: at(2) }),
	]
	writeFileSync(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`)
	const calls = { write: 0 }
	const guarded = createReadOnlyPort({
		...createNodeFsPort(),
		async writeText() {
			calls.write += 1
			throw new Error('复盘工具不该写盘')
		},
	})
	const value = await runLessons({ port: guarded, path })
	assert.equal(calls.write, 0)
	assert.equal(value.due, false)
	assert.match(value.stats, /复盘口径：上次复盘〔2026-01-01T00:02:00.000Z〕｜增量 0 批｜全量 1 批/)
})

test('force 出建议即使未到点位；渲染含建议清单与「只出建议」声明', async (t) => {
	const dir = tempRoot(t, 'lessons-force')
	const path = join(dir, 'data', 'dispatch-ledger.jsonl')
	const value = await runLessons({ port: createNodeFsPort(), path, force: true })
	assert.equal(value.due, true)
	const text = renderLessonsResult(value)
	assert.match(text, /到复盘点位：以下是配对规则修订建议草稿（只出建议，采纳归主会话）。/)
	assert.match(text, /^· /m)
})
