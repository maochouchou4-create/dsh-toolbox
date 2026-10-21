/**
 * 批次台账（v2 四事件）：事件构造、旧事件兼容读、集合式状态推导、回填、台账读写。
 *
 * 台账是唯一真相（状态永远从事件现推），所以这里既钉新事件 schema，也钉「旧六阶段事件读得出来、
 * 但不参与门禁硬判」——旧流程跑过的批不能在新门禁下永远差一道门。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
	BATCH_ACTIONS,
	appendGateEvent,
	appendStartOnce,
	backfillFromBatch,
	commitEvent,
	foldBatch,
	gateEvent,
	mergeBackfill,
	normalizeEvent,
	parseLedger,
	renderBatchFold,
	renderBatchRow,
	resolveLedgerPath,
	reviewEvent,
	rulesFingerprint,
	runBatchAction,
	startEvent,
} from '../lib/dispatch/batch.js'
import { loadDispatchData } from '../lib/dispatch/data.js'
import { validateChallenge } from '../lib/dispatch/core.js'
import { createNodeFsPort } from '../lib/fs-port.js'
import { GATE_LABELS } from '../lib/dispatch/vocab.js'
import { tempRoot } from './helpers.js'

const { data, raw } = loadDispatchData()
const at = (minute) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`
const startOf = (batch, overrides = {}) =>
	startEvent({ batch, tier: 'M', triage: 'M｜内部实现', intent: '把 v2 落地', rules: 'rule00000001', now: at(0), ...overrides })

test('四事件构造：start 写占位 subject、gate 带裁决字段、commit/review 各就位', () => {
	const start = startOf('b1')
	assert.deepEqual(start, {
		t: at(0),
		action: 'start',
		batch: 'b1',
		tier: 'M',
		triage: 'M｜内部实现',
		intent: '把 v2 落地',
		subject: '（待写）',
		decisions: [],
		rules: 'rule00000001',
	})
	const gate = gateEvent({ batch: 'b1', gate: GATE_LABELS.challenge, tier: 'M', segment: '净 diff', adopted: 2, rejected: 1, now: at(1) })
	assert.equal(gate.action, 'gate')
	assert.equal(gate.adopted, 2)
	assert.deepEqual(gate.perFormCounts, [])
	assert.equal(gate.segment, '净 diff')
	assert.equal(commitEvent({ batch: 'b1', commit: 'abc1234', pushed: 'ok' }).action, 'commit')
	const review = reviewEvent({ batch: 'b1', retro: '本批收', efficacy: '证伪门拦住一个假值' })
	assert.equal(review.action, 'review')
	assert.equal(review.efficacy, '证伪门拦住一个假值')
})

test('事件归一：v2 四事件原样收，旧 advance 按 stage 名映射并标 legacy', () => {
	assert.equal(normalizeEvent({ action: 'start', batch: 'b', tier: 'M', triage: 'M｜x' }).kind, 'start')
	assert.equal(normalizeEvent({ action: 'start', batch: 'b', tier: 'M', triage: 'M｜x' }).legacy, false)
	assert.equal(normalizeEvent({ action: 'start', batch: 'b' }).legacy, true, '缺 tier/triage 的旧 start 标 legacy')
	assert.equal(normalizeEvent({ action: 'gate', batch: 'b', gate: '证伪门' }).kind, 'gate')

	const plan = normalizeEvent({ action: 'advance', batch: 'b', stage: '门一', combo: { 锚点核对: 2 } })
	assert.equal(plan.kind, 'gate')
	assert.equal(plan.gate, GATE_LABELS.planChallenge)
	assert.equal(plan.legacy, true)
	assert.deepEqual(plan.forms, ['锚点核对'])
	const design = normalizeEvent({ action: 'advance', batch: 'b', stage: '方案' })
	assert.equal(design.gate, GATE_LABELS.planChallenge)
	const final = normalizeEvent({ action: 'advance', batch: 'b', stage: '门二', formCounts: { 证伪门: 3 } })
	assert.equal(final.gate, GATE_LABELS.challenge)
	assert.deepEqual(final.perFormCounts, [{ form: '证伪门', count: 3 }])
	assert.equal(normalizeEvent({ action: 'advance', batch: 'b', stage: '提交' }).kind, 'commit')
	assert.equal(normalizeEvent({ action: 'advance', batch: 'b', stage: '复盘', note: '收' }).kind, 'review')
	assert.equal(normalizeEvent({ action: 'advance', batch: 'b', stage: '施工' }).kind, 'legacy')
	assert.equal(normalizeEvent({ action: 'advance', batch: 'b' }).kind, 'legacy')
	assert.equal(normalizeEvent({ action: 'something-else', batch: 'b' }).kind, 'legacy')
	assert.throws(() => normalizeEvent('not object'), /必须是对象/)
})

test('台账解析：JSONL／整份数组／fenced 都收，坏行报行号与截断样本', () => {
	assert.deepEqual(parseLedger(''), [])
	assert.deepEqual(parseLedger('  \n '), [])
	const line = JSON.stringify(startOf('b1'))
	assert.deepEqual(parseLedger(`${line}\n${JSON.stringify(startOf('b2'))}`).length, 2)
	assert.deepEqual(parseLedger(`[${line}]`).length, 1)
	assert.deepEqual(parseLedger('```json\n' + line + '\n```').length, 1)
	assert.throws(() => parseLedger(`${line}\n{坏行`), /台账: 第 2 行不是合法 JSON 事件/)
	assert.throws(() => parseLedger('[1]'), /事件必须是对象/)
})

test('规则指纹：同字节同指纹、换规则面即换指纹、缺 raw 退回 unknown', () => {
	const a = rulesFingerprint(raw)
	assert.equal(a, rulesFingerprint({ ...raw }))
	assert.match(a, /^[0-9a-f]{12}$/)
	const changed = rulesFingerprint({ ...raw, pairing: `${raw.pairing} ` })
	assert.notEqual(a, changed)
	assert.equal(rulesFingerprint(null), 'unknown')
})

test('状态推导（全流程）：四阶段走完、门禁已过、修复轮数与采纳数从事件现算', () => {
	const events = [
		startOf('b1', { tier: 'L', triage: 'L｜跨文件重写' }),
		gateEvent({ batch: 'b1', gate: GATE_LABELS.planChallenge, tier: 'L', segment: '方案', now: at(1) }),
		gateEvent({ batch: 'b1', gate: GATE_LABELS.challenge, tier: 'L', segment: '净 diff', adopted: 3, rejected: 1, overlap: 0, now: at(2) }),
		gateEvent({ batch: 'b1', gate: GATE_LABELS.challenge, tier: 'L', segment: '净 diff', adopted: 1, rejected: 0, now: at(3) }),
		commitEvent({ batch: 'b1', commit: 'abc1234', pushed: 'ok', now: at(4) }),
		reviewEvent({ batch: 'b1', retro: '本批收', efficacy: '证伪门拦住假值', now: at(5) }),
	]
	const state = foldBatch(events, data)
	assert.equal(state.batch, 'b1')
	assert.equal(state.tier, 'L')
	assert.deepEqual(state.stageStates.map((stage) => stage.done), [true, true, true, true])
	assert.equal(state.next, null)
	assert.deepEqual(state.gatesAhead, [])
	assert.deepEqual(state.requiredGates, [GATE_LABELS.planChallenge, GATE_LABELS.challenge])
	assert.equal(state.fixRounds, 1, '证伪门 2 轮 − 1 ＝修复轮数 1')
	assert.deepEqual(state.adoption, { adopted: 4, rejected: 1, overlap: 0 })
	assert.equal(state.latestCommit.commit, 'abc1234')
	assert.equal(state.latestReview.retro, '本批收')
	assert.deepEqual(state.warnings, [])
})

test('状态推导（只立项）：下一阶段是门报，未过门禁给提醒', () => {
	const state = foldBatch([startOf('b1')], data)
	assert.equal(state.next, '门报')
	assert.deepEqual(state.gatesAhead, [GATE_LABELS.challenge])
	assert.ok(state.warnings.some((warning) => warning.includes('门禁未过：证伪门')))
})

test('旧事件兼容：legacy 门报能读能算，但不参与门禁硬判（不把旧批永远判成差一道门）', () => {
	const events = [
		startOf('b1', { tier: 'L', triage: 'L｜跨文件重写' }),
		{ action: 'advance', batch: 'b1', stage: '门一', combo: { 锚点核对: 3 }, t: at(1) },
		commitEvent({ batch: 'b1', commit: 'def5678', pushed: 'ok', now: at(2) }),
	]
	const state = foldBatch(events, data)
	assert.equal(state.legacyEvents.length, 1)
	assert.ok(state.warnings.some((warning) => warning.includes('含旧事件（legacy）1 条')))
	assert.ok(!state.warnings.some((warning) => warning.includes('门禁未过')), 'legacy 存在时不硬判门禁')
	assert.equal(state.stageStates.find((stage) => stage.kind === '门报').legacy, true)
})

test('旧批（无 start）：档位未登记降级、先行事件缺立项有提醒，不抛错', () => {
	const state = foldBatch([
		{ action: 'advance', batch: 'old', stage: '门二', combo: { 锚点核对: 1 }, t: at(1) },
	], data)
	assert.equal(state.tier, null)
	assert.ok(state.warnings.some((warning) => warning.includes('档位未登记')))
	assert.ok(state.warnings.some((warning) => warning.includes('没有 start 事件')))
})

test('旧 start（无档位）过 status/list/落账出口：tier 输出必为字符串占位（MCP 出口校验不容 null）', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		await appendStartOnce({ port, path, event: startEvent({ batch: 'b2', tier: undefined, triage: undefined, intent: '旧批' }) })
		const statusOut = await runBatchAction({ port, path, action: 'status', params: { batch: 'b2' } })
		assert.equal(statusOut.tier, '未登记')
		const listOut = await runBatchAction({ port, path, action: 'list' })
		assert.equal(listOut.rows.every((row) => typeof row.tier === 'string'), true)
		await appendStartOnce({ port, path, event: commitEvent({ batch: 'b2', commit: 'abc1234', pushed: 'ok' }) })
		const commitOut = await runBatchAction({ port, path, action: 'commit', params: { batch: 'b2', commit: 'abc1234', pushed: 'ok' } })
		assert.equal(commitOut.tier, '未登记')
	})
})

test('完工批过 review 出口：next 输出必为字符串占位；review 收官即清该批台账行', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		await appendStartOnce({ port, path, event: startOf('b3') })
		await appendGateEvent({ port, path, event: gateEvent({ batch: 'b3', gate: GATE_LABELS.challenge, tier: 'M', segment: '净 diff', adopted: 1, now: at(1) }) })
		await runBatchAction({ port, path, action: 'commit', params: { batch: 'b3', commit: 'def5678', pushed: 'ok' } })
		const reviewOut = await runBatchAction({ port, path, action: 'review', params: { batch: 'b3', retro: '收官', efficacy: '拦一次' } })
		assert.equal(reviewOut.next, '完工')
		// 收官清账：该批全部行（含刚写的 review 行）移出台账文件，status/list 不再认识它
		assert.equal(readLines(path).length, 0, 'review 后台账文件无该批行')
		await assert.rejects(() => runBatchAction({ port, path, action: 'status', params: { batch: 'b3' } }), /没有批次「b3」的 start 事件/)
		const listOut = await runBatchAction({ port, path, action: 'list' })
		assert.equal(listOut.rows.every((row) => typeof row.next === 'string'), true)
	})
})

test('渲染：批次行含档位/已过/下一阶段，单批折叠含进度与门效能', () => {
	const state = foldBatch([
		startOf('b1'),
		gateEvent({ batch: 'b1', gate: GATE_LABELS.challenge, tier: 'M', segment: '净 diff', adopted: 1, now: at(1) }),
		reviewEvent({ batch: 'b1', retro: '收', efficacy: '拦住假值', now: at(2) }),
	], data)
	const row = renderBatchRow(state)
	assert.match(row, /^b1｜M｜已过：立项→门报→复盘｜下一阶段：提交/)
	assert.match(row, /门报 1 轮（修复轮数 0）/)
	const fold = renderBatchFold(state)
	assert.match(fold, /批次 b1｜档位 M/)
	assert.match(fold, /进度：立项✓ → 门报✓ → 提交… → 复盘✓/)
	assert.match(fold, /门报 1 轮（修复轮数 0；采纳 1／拒收 0／双报重叠 0）/)
	assert.match(fold, /最近复盘：收（门效能：拦住假值）/)
	assert.match(fold, /下一阶段：提交/)
})

test('回填：台账登记值逐格回填，占位 subject 跳过并提醒，证伪门不回填 subject', () => {
	const state = foldBatch([startOf('b1', { subject: '/path/plan.md', decisions: ['拍板一'] })], data)
	const { values, notes } = backfillFromBatch(state, GATE_LABELS.planChallenge)
	assert.equal(values.subject, '/path/plan.md')
	assert.deepEqual(values.decisions, ['拍板一'])
	assert.equal(values.tier, 'M')
	assert.deepEqual(notes, [])
	// 方案证伪 subject 未传时从台账 start 事件回填，回填结果过得了校验（件3 链路）
	const merged = mergeBackfill({ args: { batch: 'b1', gate: GATE_LABELS.planChallenge }, state, gate: GATE_LABELS.planChallenge })
	assert.equal(merged.params.subject, '/path/plan.md')
	assert.equal(validateChallenge(data, merged.params), GATE_LABELS.planChallenge)

	const challenge = backfillFromBatch(state, GATE_LABELS.challenge)
	assert.equal(challenge.values.subject, undefined, '证伪门对象是净 diff 命令，不能拿方案路径回填')

	const placeholder = backfillFromBatch(foldBatch([startOf('b2')], data), GATE_LABELS.planChallenge)
	assert.equal(placeholder.values.subject, undefined)
	assert.ok(placeholder.notes.some((note) => note.includes('占位')))
	// 占位回填跳过 → 校验层报「台账登记是占位/空」指回补记，不静默放行（件3 链路）
	assert.throws(
		() => validateChallenge(data, { batch: 'b2', gate: GATE_LABELS.planChallenge, ...placeholder.values }),
		/台账登记是占位\/空，请传实际方案路径＋批次节指针/,
	)
	assert.deepEqual(backfillFromBatch(null, GATE_LABELS.planChallenge), { values: {}, notes: [] })
})

test('回填合并：显式一致通过、显式空值即错、显式与台账冲突即错', () => {
	const state = foldBatch([startOf('b1', { intent: '登记过的意图' })], data)
	const ok = mergeBackfill({ args: { batch: 'b1', tier: 'M' }, state, gate: GATE_LABELS.challenge })
	assert.equal(ok.params.tier, 'M')
	assert.equal(ok.params.intent, '登记过的意图')
	assert.throws(
		() => mergeBackfill({ args: { batch: 'b1', intent: '' }, state, gate: GATE_LABELS.challenge }),
		/显式传了空的 intent/,
	)
	assert.throws(
		() => mergeBackfill({ args: { batch: 'b1', intent: '临时改主意' }, state, gate: GATE_LABELS.challenge }),
		/与批次「b1」台账里登记的不一致/,
	)
})

test('台账路径：显式优先，缺省落 store 下 data/dispatch-ledger.jsonl', () => {
	assert.equal(resolveLedgerPath({ configuredPath: '/tmp/x.jsonl', memoryRoot: '/whatever' }), '/tmp/x.jsonl')
	assert.match(resolveLedgerPath({ memoryRoot: '/root/agent-data' }), /dispatch-ledger\.jsonl$/)
})

/* ---------- 台账读写（真 fs 端口 + 临时根） ---------- */

const withLedger = async (t, run) => {
	const dir = tempRoot(t, 'ledger')
	const path = join(dir, 'data', 'dispatch-ledger.jsonl')
	mkdirSync(dirname(path), { recursive: true })
	const port = createNodeFsPort()
	return run({ dir, path, port })
}

const readLines = (path) => readFileSync(path, 'utf8').trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line))

test('台账动作词表：commit／review／status／list 四件', () => {
	assert.deepEqual(BATCH_ACTIONS, ['commit', 'review', 'status', 'list'])
})

test('空台账：list／status 都不炸，文案指向 dispatch_task 立项', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		const list = await runBatchAction({ port, path, action: 'list' })
		assert.deepEqual(list.rows, [])
		assert.match(list.emptyText, /dispatch_task 出稿即自动立项/)
		const status = await runBatchAction({ port, path, action: 'status' })
		assert.match(status.text, /dispatch_task 出稿即自动立项/)
		await assert.rejects(() => runBatchAction({ port, path, action: 'status', params: { batch: 'nope' } }), /没有批次「nope」的 start 事件/)
	})
})

test('立项落账：首写追加 start，同批重跑只提醒不重复写', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		const event = startOf('b1')
		const first = await appendStartOnce({ port, path, event })
		assert.match(first, /已落 start 事件/)
		const second = await appendStartOnce({ port, path, event })
		assert.match(second, /已登记（start 存在）/)
		assert.equal(readLines(path).length, 1)
		const status = await runBatchAction({ port, path, action: 'status', params: { batch: 'b1' } })
		assert.equal(status.tier, 'M')
		assert.equal(status.next, '门报')
	})
})

test('门报落账：gate 一条一轮不合并；commit/review 追加后状态前进', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		await appendStartOnce({ port, path, event: startOf('b1') })
		await appendGateEvent({ port, path, event: gateEvent({ batch: 'b1', gate: GATE_LABELS.challenge, tier: 'M', segment: '净 diff', adopted: 2, now: at(1) }) })
		await appendGateEvent({ port, path, event: gateEvent({ batch: 'b1', gate: GATE_LABELS.challenge, tier: 'M', segment: '修正轮', adopted: 1, now: at(2) }) })
		let status = await runBatchAction({ port, path, action: 'status', params: { batch: 'b1' } })
		assert.match(status.text, /门报 2 轮（修复轮数 1；采纳 3／拒收 0／双报重叠 0）/)

		await runBatchAction({ port, path, action: 'commit', params: { batch: 'b1', commit: 'abc1234', pushed: 'ok' } })
		const reviewed = await runBatchAction({
			port,
			path,
			action: 'review',
			params: { batch: 'b1', retro: '本批收', efficacy: '证伪门拦住假值' },
		})
		assert.equal(reviewed.next, '完工')
		assert.match(reviewed.text, /最近复盘：本批收（门效能：证伪门拦住假值）/, 'review 响应仍回放该批一生（内存态，读的是本次事件）')
		assert.equal(readLines(path).length, 0, 'review 收官即清该批全部行（含刚写的 review 行）')

		const listed = await runBatchAction({ port, path, action: 'list' })
		assert.doesNotMatch(listed.text, /b1/, '已收官批从 list 消失')
	})
})

test('台账写侧守卫：未立项不能提交、空批次不能提交、多行值即错', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		await assert.rejects(
			() => runBatchAction({ port, path, action: 'commit', params: { batch: 'b1', commit: 'a', pushed: 'ok' } }),
			/未立项（台账无 start 事件）/,
		)
		await appendStartOnce({ port, path, event: startOf('b1') })
		await assert.rejects(
			() => runBatchAction({ port, path, action: 'commit', params: { batch: 'b1', commit: 'a\nb', pushed: 'ok' } }),
			/commit 必须是单行/,
		)
		await assert.rejects(() => runBatchAction({ port, path, action: 'review', params: { batch: 'b1' } }), /retro 必须是非空字符串/)
		await assert.rejects(() => runBatchAction({ port, path, action: 'nope' }), /未知台账动作/)
	})
})

test('旧事件写入不改写：追加后原有行逐字保留（兼容读的写侧保证）', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		const legacy = JSON.stringify({ t: at(1), action: 'advance', batch: 'old', stage: '门二', combo: { 锚点核对: 2 } })
		await appendStartOnce({ port, path, event: startOf('b1') })
		const before = readFileSync(path, 'utf8')
		await runBatchAction({ port, path, action: 'commit', params: { batch: 'b1', commit: 'abc1234', pushed: 'ok' } })
		const after = readFileSync(path, 'utf8')
		assert.ok(after.startsWith(before), '追加不改写既有行')
		assert.ok(after.endsWith('\n'))
		assert.equal(after.includes(legacy), false)
	})
})
