/**
 * 批次台账（六动作）：事件构造、旧事件兼容读、集合式状态推导、台账读写、字段校验。
 *
 * 台账是唯一真相（状态永远从事件现推），且**只记事实**：这里既钉 start/gate 的写入面与形状校验，
 * 也钉「不设闸、不设提醒」——无门可提交、review 不要求先 commit、折叠视图不出门禁警示。
 * 旧六阶段 advance 事件读得出来、不参与任何判断（只作归档展示）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
	BATCH_ACTIONS,
	appendGateEvent,
	appendStartOnce,
	commitEvent,
	foldBatch,
	gateEvent,
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
import { createNodeFsPort } from '../lib/fs-port.js'
import { GATE_LABELS, SUBJECT_PLACEHOLDER } from '../lib/dispatch/vocab.js'
import { tempRoot } from './helpers.js'

const { data, raw } = loadDispatchData()
const at = (minute) => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`
const startOf = (batch, overrides = {}) =>
	startEvent({ batch, intent: '方案先行落地', rules: 'rule00000001', now: at(0), ...overrides })
/** 旧流程的 start 事件（带档位登记）：夹具直接造原始形状，生产构造器已不收这些键。 */
const legacyStartOf = (batch, tier = 'L') => ({
	t: at(0), action: 'start', batch, tier, triage: `${tier}｜旧流程分诊`, intent: `${batch} 旧意图`, subject: '（待写）', decisions: [], rules: 'oldrules00001',
})

test('动作词表：start／gate／commit／review／status／list 六件，顺序固定', () => {
	assert.deepEqual(BATCH_ACTIONS, ['start', 'gate', 'commit', 'review', 'status', 'list'])
})

test('事件构造：start 写占位 subject、gate 缺省裁决字段、commit/review 各就位', () => {
	const start = startOf('b1')
	assert.deepEqual(start, {
		t: at(0),
		action: 'start',
		batch: 'b1',
		intent: '方案先行落地',
		subject: SUBJECT_PLACEHOLDER,
		decisions: [],
		rules: 'rule00000001',
	})
	const gate = gateEvent({ batch: 'b1', gate: GATE_LABELS.challenge, segment: '净 diff', adopted: 2, rejected: 1, now: at(1) })
	assert.equal(gate.action, 'gate')
	assert.equal(gate.adopted, 2)
	assert.deepEqual(gate.perFormCounts, [])
	assert.equal(gate.segment, '净 diff')
	const commit = commitEvent({ batch: 'b1', commit: 'abc1234', pushed: 'ok' })
	assert.equal(commit.action, 'commit')
	assert.equal(commit.pushed, 'ok')
	const review = reviewEvent({ batch: 'b1', retro: '本批收', efficacy: '证伪门拦住一个假值' })
	assert.equal(review.action, 'review')
	assert.equal(review.efficacy, '证伪门拦住一个假值')
})

test('事件归一：新事件无档位即现役，带档位＝旧事件标 legacy；advance 按阶段名映射', () => {
	assert.equal(normalizeEvent({ action: 'start', batch: 'b' }).kind, 'start')
	assert.equal(normalizeEvent({ action: 'start', batch: 'b' }).legacy, false, '新流程不写档位，不带 tier 即现役事件')
	assert.equal(normalizeEvent({ action: 'start', batch: 'b', tier: 'M' }).legacy, true, '带 tier 的旧 start 标 legacy（历史档位只展示）')
	assert.equal(normalizeEvent({ action: 'gate', batch: 'b', gate: '证伪门' }).kind, 'gate')
	assert.equal(normalizeEvent({ action: 'gate', batch: 'b', gate: '证伪门' }).legacy, false)
	assert.equal(normalizeEvent({ action: 'commit', batch: 'b' }).kind, 'commit')
	assert.equal(normalizeEvent({ action: 'review', batch: 'b' }).kind, 'review')

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

test('规则指纹：templates.md 原始字节同字节同指纹、换模板即换指纹、缺 raw 退回 unknown', () => {
	const a = rulesFingerprint(raw)
	assert.equal(a, rulesFingerprint({ ...raw }))
	assert.match(a, /^[0-9a-f]{12}$/)
	const changed = rulesFingerprint({ ...raw, templates: `${raw.templates} ` })
	assert.notEqual(a, changed)
	assert.equal(rulesFingerprint(null), 'unknown')
})

test('状态推导（全流程）：四阶段走完、修复轮数/采纳数从事件现算、无门禁字段', () => {
	const events = [
		startOf('b1'),
		gateEvent({ batch: 'b1', gate: GATE_LABELS.planChallenge, segment: '方案', now: at(1) }),
		gateEvent({ batch: 'b1', gate: GATE_LABELS.challenge, segment: '净 diff', adopted: 3, rejected: 1, overlap: 0, now: at(2) }),
		gateEvent({ batch: 'b1', gate: GATE_LABELS.challenge, segment: '净 diff', adopted: 1, rejected: 0, now: at(3) }),
		commitEvent({ batch: 'b1', commit: 'abc1234', pushed: 'ok', now: at(4) }),
		reviewEvent({ batch: 'b1', retro: '本批收', efficacy: '证伪门拦住假值', now: at(5) }),
	]
	const state = foldBatch(events, data)
	assert.equal(state.batch, 'b1')
	assert.deepEqual(state.stageStates.map((stage) => stage.done), [true, true, true, true])
	assert.equal(state.next, null)
	assert.equal(state.fixRounds, 1, '证伪门 2 轮 − 1 ＝修复轮数 1')
	assert.deepEqual(state.adoption, { adopted: 4, rejected: 1, overlap: 0 })
	assert.equal(state.latestCommit.commit, 'abc1234')
	assert.equal(state.latestReview.retro, '本批收')
	assert.equal(state.legacyTier, null, '新流程事件不带档位')
	assert.ok(!('gatesAhead' in state) && !('requiredGates' in state), '折叠状态不再有门禁推导字段')
	assert.deepEqual(state.warnings, [])
})

test('状态推导（只立项）：下一阶段门报，不出「门禁未过」提醒（台账只记事实）', () => {
	const state = foldBatch([startOf('b1')], data)
	assert.equal(state.next, '门报')
	assert.deepEqual(state.warnings, [])
	assert.ok(!renderBatchRow(state).includes('门禁'), '批次行不挂门禁提醒')
	assert.ok(!renderBatchFold(state).includes('门禁'), '折叠视图不挂门禁提醒')
})

test('双 start：给提醒不抛错（重复立项要人看见）', () => {
	const state = foldBatch([startOf('b1', { intent: '第一次' }), startOf('b1', { intent: '第二次' })], data)
	assert.ok(state.warnings.some((warning) => warning.includes('2 条 start 事件')))
})

test('旧事件兼容：legacy 事件能读能算，只作归档展示', () => {
	const events = [
		legacyStartOf('b1'),
		{ action: 'advance', batch: 'b1', stage: '门一', combo: { 锚点核对: 3 }, t: at(1) },
		commitEvent({ batch: 'b1', commit: 'def5678', pushed: 'ok', now: at(2) }),
	]
	const state = foldBatch(events, data)
	assert.equal(state.legacyEvents.length, 2, '旧流程的 start（带档位）与门报事件都标 legacy')
	assert.equal(state.legacyTier, 'L', '旧事件的档位登记只作展示（legacyTier）')
	assert.ok(state.warnings.some((warning) => warning.includes('含旧事件（legacy）2 条')))
	assert.equal(state.stageStates.find((stage) => stage.kind === '立项').legacy, true)
	assert.equal(state.stageStates.find((stage) => stage.kind === '门报').legacy, true)
	assert.match(renderBatchFold(state), /档位（旧事件）：L/, '历史档位在折叠视图里保留展示')
	assert.match(renderBatchRow(state), /门报（旧）/)
})

test('旧批（无 start）：先行事件缺立项有提醒，不抛错', () => {
	const state = foldBatch([{ action: 'advance', batch: 'old', stage: '门二', combo: { 锚点核对: 1 }, t: at(1) }], data)
	assert.equal(state.legacyTier, null)
	assert.ok(state.warnings.some((warning) => warning.includes('没有 start 事件')))
	assert.equal(typeof state.next, 'string')
})

test('折叠无 data 时按词表兜底：四阶段顺序不变', () => {
	const state = foldBatch([startOf('b1')])
	assert.deepEqual(state.stageStates.map((stage) => stage.id), ['立项', '门报', '提交', '复盘'])
	assert.equal(state.next, '门报')
})

test('渲染：批次行无档位列，单批折叠含进度、门报轮数与门效能', () => {
	const state = foldBatch([
		startOf('b1'),
		gateEvent({ batch: 'b1', gate: GATE_LABELS.challenge, segment: '净 diff', adopted: 1, now: at(1) }),
		reviewEvent({ batch: 'b1', retro: '收', efficacy: '拦住假值', now: at(2) }),
	], data)
	const row = renderBatchRow(state)
	assert.match(row, /^b1｜已过：立项→门报→复盘｜下一阶段：提交/, '行首直接是批次与已过阶段，无档位列')
	assert.match(row, /门报 1 轮（修复轮数 0）/)
	const fold = renderBatchFold(state)
	assert.doesNotMatch(fold, /档位/, '新流程事件不带档位，折叠视图也不出档位行')
	assert.match(fold, /^批次 b1/)
	assert.match(fold, /进度：立项✓ → 门报✓ → 提交… → 复盘✓/)
	assert.match(fold, /门报 1 轮（修复轮数 0；采纳 1／拒收 0／双报重叠 0）/)
	assert.match(fold, /最近复盘：收（门效能：拦住假值）/)
	assert.match(fold, /下一阶段：提交/)
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

test('空台账：list／status 都不炸，文案指向 dispatch_batch action=start 立项', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		const list = await runBatchAction({ port, path, action: 'list' })
		assert.deepEqual(list.rows, [])
		assert.match(list.emptyText, /dispatch_batch action=start 立项/)
		const status = await runBatchAction({ port, path, action: 'status' })
		assert.match(status.text, /dispatch_batch action=start 立项/)
		await assert.rejects(() => runBatchAction({ port, path, action: 'status', params: { batch: 'nope' } }), /没有批次「nope」的 start 事件/)
	})
})

test('start 动作：必填 intent、decisions 形状、subject 缺省占位、同批重跑不重复写', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		await assert.rejects(() => runBatchAction({ port, path, action: 'start', params: { batch: 'b1' } }), /intent 必须是非空字符串/)
		await assert.rejects(() => runBatchAction({ port, path, action: 'start', params: { batch: 'b1', intent: 'a\nb' } }), /intent 必须是单行/)
		await assert.rejects(() => runBatchAction({ port, path, action: 'start', params: { batch: 'b1', intent: 'i', decisions: ['d', ''] } }), /decisions 必须是字符串数组/)
		const first = await runBatchAction({ port, path, action: 'start', params: { batch: 'b1', intent: 'i', decisions: ['d'] } })
		assert.match(first.text, /已落 start 事件/)
		assert.equal(first.next, '门报')
		assert.equal(readLines(path).length, 1)
		assert.equal(readLines(path)[0].subject, SUBJECT_PLACEHOLDER, 'subject 未传写占位')
		const second = await runBatchAction({ port, path, action: 'start', params: { batch: 'b1', intent: 'i' } })
		assert.match(second.text, /已登记（start 存在）/)
		assert.equal(readLines(path).length, 1, '同批重跑不重复写 start')
	})
})

test('gate 动作：门名必须∈词表；段位缺省按门分叉；两轮不合并、修复轮数现算', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		await runBatchAction({ port, path, action: 'start', params: { batch: 'b1', intent: 'i' } })
		await assert.rejects(
			() => runBatchAction({ port, path, action: 'gate', params: { batch: 'b1', gate: '证伪复核' } }),
			/gate 必须是门名之一（方案证伪／证伪门）/,
		)
		const plan = await runBatchAction({ port, path, action: 'gate', params: { batch: 'b1', gate: GATE_LABELS.planChallenge } })
		assert.match(plan.text, /已落 gate 事件：批次 b1｜门 方案证伪｜段 方案/)
		await runBatchAction({ port, path, action: 'gate', params: { batch: 'b1', gate: GATE_LABELS.challenge } })
		const second = await runBatchAction({ port, path, action: 'gate', params: { batch: 'b1', gate: GATE_LABELS.challenge, adopted: 2 } })
		assert.match(second.text, /门报 3 轮（修复轮数 1；采纳 2／拒收 0／双报重叠 0）/, '证伪门轮数−1＝修复轮数')
		assert.equal(readLines(path).filter((event) => event.action === 'gate').length, 3, 'gate 一条一轮，不合并')
	})
})

test('gate 裁决字段形状：清单/计数/perFormCounts 的坏形状当场拒，事件不落半行', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		await runBatchAction({ port, path, action: 'start', params: { batch: 'b1', intent: 'i' } })
		const before = readFileSync(path, 'utf8')
		for (const params of [
			{ forms: ['ok', 3] },
			{ forms: [''] },
			{ recommended: '证伪复核' },
			{ adopted: -1 },
			{ rejected: 1.5 },
			{ overlap: '2' },
			{ perFormCounts: [{ form: '证伪复核', count: -2 }] },
			{ perFormCounts: [{ count: 1 }] },
			{ missed: 'a\nb' },
			{ note: 'a\nb' },
			{ segment: 'a\nb' },
		]) {
			await assert.rejects(
				() => runBatchAction({ port, path, action: 'gate', params: { batch: 'b1', gate: GATE_LABELS.challenge, ...params } }),
				undefined,
				`坏形状应拒: ${JSON.stringify(params)}`,
			)
		}
		assert.equal(readFileSync(path, 'utf8'), before, '校验不过不落任何行')
	})
})

test('commit/gate 未立项即拒、多行值即拒；未知动作即拒', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		await assert.rejects(
			() => runBatchAction({ port, path, action: 'commit', params: { batch: 'b1', commit: 'a', pushed: 'ok' } }),
			/未立项（台账无 start 事件）/,
		)
		await assert.rejects(
			() => runBatchAction({ port, path, action: 'gate', params: { batch: 'b1', gate: '证伪门' } }),
			/未立项（台账无 start 事件）/,
			'gate 对未立项批放行会留清不掉的孤儿行（review 是唯一清账路径、对无 start 批抛错）',
		)
		await runBatchAction({ port, path, action: 'start', params: { batch: 'b1', intent: 'i' } })
		await assert.rejects(
			() => runBatchAction({ port, path, action: 'commit', params: { batch: 'b1', commit: 'a\nb', pushed: 'ok' } }),
			/commit 必须是单行/,
		)
		await assert.rejects(() => runBatchAction({ port, path, action: 'review', params: { batch: 'b1' } }), /retro 必须是非空字符串/)
		await assert.rejects(() => runBatchAction({ port, path, action: 'nope' }), /未知台账动作/)
	})
})

test('无硬闸：无门报也可 commit；未 commit 也可 review（台账只记事实）', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		await runBatchAction({ port, path, action: 'start', params: { batch: 'a', intent: '无门直提' } })
		const commit = await runBatchAction({ port, path, action: 'commit', params: { batch: 'a', commit: 'abc1234', pushed: 'ok' } })
		assert.equal(commit.ok, true)

		await runBatchAction({ port, path, action: 'start', params: { batch: 'b', intent: '不提交直接复盘' } })
		const review = await runBatchAction({ port, path, action: 'review', params: { batch: 'b', retro: '收', efficacy: 'e' } })
		assert.equal(review.ok, true)
	})
})

test('review 收官即清该批台账行；响应仍回放该批一生（内存态）', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		await runBatchAction({ port, path, action: 'start', params: { batch: 'b3', intent: 'i' } })
		await runBatchAction({ port, path, action: 'gate', params: { batch: 'b3', gate: GATE_LABELS.challenge, adopted: 1 } })
		await runBatchAction({ port, path, action: 'commit', params: { batch: 'b3', commit: 'def5678', pushed: 'ok' } })
		const reviewOut = await runBatchAction({ port, path, action: 'review', params: { batch: 'b3', retro: '收官', efficacy: '拦一次' } })
		assert.equal(reviewOut.next, '完工')
		assert.match(reviewOut.text, /最近复盘：收官（门效能：拦一次）/)
		assert.equal(readLines(path).length, 0, 'review 后台账文件无该批行')
		await assert.rejects(() => runBatchAction({ port, path, action: 'status', params: { batch: 'b3' } }), /没有批次「b3」的 start 事件/)
		const listOut = await runBatchAction({ port, path, action: 'list' })
		assert.equal(listOut.rows.length, 0)
	})
})

test('旧事件写入不改写：追加后原有行逐字保留', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		await appendStartOnce({ port, path, event: startOf('b1') })
		const before = readFileSync(path, 'utf8')
		await appendGateEvent({ port, path, event: gateEvent({ batch: 'b1', gate: GATE_LABELS.challenge, segment: '净 diff' }) })
		const after = readFileSync(path, 'utf8')
		assert.ok(after.startsWith(before), '追加不改写既有行')
		assert.ok(after.endsWith('\n'))
	})
})

test('status/list 的 next 出口恒为字符串（MCP 出口校验不容 null）', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		await appendStartOnce({ port, path, event: startOf('b2') })
		const statusOut = await runBatchAction({ port, path, action: 'status', params: { batch: 'b2' } })
		assert.equal(typeof statusOut.next, 'string')
		const listOut = await runBatchAction({ port, path, action: 'list' })
		assert.equal(listOut.rows.every((row) => typeof row.next === 'string'), true)
		const commitOut = await runBatchAction({ port, path, action: 'commit', params: { batch: 'b2', commit: 'abc1234', pushed: 'ok' } })
		assert.equal(typeof commitOut.next, 'string')
	})
})

test('start 可选字段形状：subject 多行拒、decisions 非数组拒（校验不过不落行）', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		await assert.rejects(
			() => runBatchAction({ port, path, action: 'start', params: { batch: 'b1', intent: 'i', subject: 'a\nb' } }),
			/subject 必须是单行/,
		)
		await assert.rejects(
			() => runBatchAction({ port, path, action: 'start', params: { batch: 'b1', intent: 'i', decisions: '拍板一' } }),
			/decisions 必须是字符串数组/,
		)
		await assert.rejects(() => runBatchAction({ port, path, action: 'start', params: { batch: '', intent: 'i' } }), /batch/)
		assert.equal(existsSync(path) ? readLines(path).length : 0, 0, '校验不过不落半行')
	})
})

test('gate 事件保真：显式段位/清单/计数/备注原样落盘，rules 取当趟模板指纹', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		await runBatchAction({ port, path, action: 'start', params: { batch: 'b1', intent: 'i' } })
		await runBatchAction({
			port,
			path,
			action: 'gate',
			params: {
				batch: 'b1',
				gate: GATE_LABELS.planChallenge,
				segment: '方案 v2',
				forms: ['方案证伪', '安全专项'],
				recommended: ['方案证伪'],
				perFormCounts: [{ form: '方案证伪', count: 3 }],
				adopted: 2,
				rejected: 1,
				overlap: 0,
				missed: '漏网：无',
				note: '前提攻击两轮',
			},
		})
		const event = readLines(path).find((line) => line.action === 'gate')
		assert.equal(event.segment, '方案 v2')
		assert.deepEqual(event.forms, ['方案证伪', '安全专项'])
		assert.deepEqual(event.recommended, ['方案证伪'])
		assert.deepEqual(event.perFormCounts, [{ form: '方案证伪', count: 3 }])
		assert.equal(event.missed, '漏网：无')
		assert.equal(event.note, '前提攻击两轮')
		assert.match(event.rules, /^[0-9a-f]{12}$/)
	})
})

test('折叠按门分流：方案证伪多次不推进修复轮数，修复轮数只数证伪门', () => {
	const events = [
		startOf('b1'),
		gateEvent({ batch: 'b1', gate: GATE_LABELS.planChallenge, segment: '方案', now: at(1) }),
		gateEvent({ batch: 'b1', gate: GATE_LABELS.planChallenge, segment: '方案', now: at(2) }),
		gateEvent({ batch: 'b1', gate: GATE_LABELS.challenge, segment: '净 diff', now: at(3) }),
	]
	const state = foldBatch(events, data)
	assert.equal(state.fixRounds, 0, '证伪门只有 1 轮 → 修复 0 轮（方案证伪的 2 轮不计入）')
	assert.equal(state.latestGate.gate, GATE_LABELS.challenge)
	assert.match(renderBatchRow(state), /门报 3 轮（修复轮数 0）/)
})

test('渲染：无门报时批次行写「门报：无」，下一阶段恒为字符串', () => {
	const state = foldBatch([startOf('b1')], data)
	const row = renderBatchRow(state)
	assert.match(row, /门报：无/)
	assert.equal(typeof state.next, 'string')
})

test('commit 可选字段 note 原样落盘；review 清账后响应仍回放门效能', async (t) => {
	await withLedger(t, async ({ path, port }) => {
		await runBatchAction({ port, path, action: 'start', params: { batch: 'b1', intent: 'i' } })
		await runBatchAction({ port, path, action: 'commit', params: { batch: 'b1', commit: 'abc1234', pushed: 'ok', note: '分两次推' } })
		assert.match(readFileSync(path, 'utf8'), /"note":"分两次推"/, 'commit 的 note 要原样落盘（不落＝字段静默丢失）')
		await runBatchAction({ port, path, action: 'review', params: { batch: 'b1', retro: '收', efficacy: '', note: '复盘附注' } })
		const lines = readLines(path)
		assert.equal(lines.length, 0, 'review 清账（review 行随批清掉，门效能由响应文本回放）')
	})
})

test('解析：CRLF 台账也收（旧 Windows 机器写出来的行尾）', () => {
	const line = JSON.stringify(startOf('b1'))
	const text = `${line}\r\n${JSON.stringify(startOf('b2'))}\r\n`
	assert.equal(parseLedger(text).length, 2, '行尾多出的 \\r 不该让整份台账解析失败')
})
