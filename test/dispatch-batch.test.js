/**
 * 批次台账（dispatch_batch 逻辑面）单测（node:test，零宿主依赖）：全部跑在临时目录的假台账上，
 * I/O 走 fs-port.js 的 node 适配器（与 memory 写侧同一份替身），故本文件同时钉住两件事——
 * 推导规则（集合式、与事件顺序无关）与写语义（末行补换行、版本守卫、start 自举、坏行 fail fast）。
 *
 * 钉的是「哪些守门断言不许被改坏」：幂等检查、乱序不敏感、缺门告警、坏行带行号、末行不粘连、
 * 版本失配——它们各自对应一种真实事故（重复登记、合并乱序、门漏记、台账被手写坏、JSON 粘连、
 * 并发覆盖），改坏其中任何一条时本文件必须先红。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
	advanceEvent,
	appendEvent,
	RenderModelMissingError,
	backfillFromBatch,
	foldBatch,
	isoNow,
	renderBatchResult,
	resolveLedgerPath,
	rulesHashOf,
	runBatchAction,
	startEvent,
} from '../lib/dispatch/batch.js'
import { loadDispatchData, loadDispatchTables, readDataBytes } from '../lib/dispatch/data.js'
import { createNodeFsPort } from '../lib/fs-port.js'

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'dispatch', 'data')
const data = loadDispatchData({ dataDir })
const port = createNodeFsPort()
/** 按动作注入它要的那几份数据面（生产走 data.js 的 loadDispatchTables，测试直接取已读好的真数据）。 */
const loadTables = ({ names }) => Object.fromEntries(names.map((name) => [name, data[name]]))

let root
/** 台账路径随用例换新：共用一个文件时前一条留下的事件会污染后一条的推导结果。 */
let ledger
const freshLedger = (name) => {
	ledger = join(root, `${name}-${Math.random().toString(36).slice(2)}.jsonl`)
	return ledger
}

const START = { batch: 'dispatch-plugin-b4', batchType: '纯后端管线批', intent: '台账落共享层', decisions: ['台账落共享层', 'fold 集合式'] }

const run = (action, params = {}) => runBatchAction({ port, path: ledger, loadTables, dataDir, action, params })
const start = (overrides = {}) => run('start', { ...START, ...overrides })
const advance = (params) => run('advance', params)
/** 追加一条不经 action 分派的事件：跨机合并进来的行、或测试要摆的历史状态，都从这里进盘。 */
const appendRaw = (event) => appendEvent({ port, path: ledger, event })
const lines = () => (existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter((line) => line !== '') : [])
const parsedLines = () => lines().map((line) => JSON.parse(line))

before(() => {
	root = mkdtempSync(join(tmpdir(), 'dsh-dispatch-batch-'))
})

after(() => {
	rmSync(root, { recursive: true, force: true })
})

test('台账路径：显式配置优先，空串按 memoryRoot 推导到习惯层底目录的 data/ 下（两机共享的那一层）', () => {
	assert.equal(resolveLedgerPath({ configuredPath: '/tmp/自定义台账.jsonl', memoryRoot: '/nowhere' }), '/tmp/自定义台账.jsonl')
	assert.equal(resolveLedgerPath({ configuredPath: '', memoryRoot: '/nowhere' }), join('/nowhere', 'profile', 'data', 'dispatch-ledger.jsonl'))
	assert.equal(resolveLedgerPath({ memoryRoot: '~/mem' }), join(process.env.HOME ?? '', 'mem', 'profile', 'data', 'dispatch-ledger.jsonl'), '~ 展开与绝对化走 memory 那份归一，不是自己拼串')
})

test('rules 指纹＝pairing＋forms 的原始字节按固定顺序拼一次 sha256 取前 8 位（两机同字节同值）', () => {
	const expected = createHash('sha256')
		.update(Buffer.concat([readFileSync(join(dataDir, 'pairing.json')), readFileSync(join(dataDir, 'forms.json'))]))
		.digest('hex').slice(0, 8)
	assert.equal(rulesHashOf({ dataDir }), expected, '顺序固定＝pairing 在前、forms 在后；解析后重新序列化会改字节，指纹就不再跨机一致')
	assert.match(rulesHashOf({ dataDir }), /^[0-9a-f]{8}$/)
	assert.equal(rulesHashOf({ dataDir }), rulesHashOf({ dataDir }), '逐次现读，同一份字节给同一个值')
	// 改的是字节不是语义：同一个 JSON 末尾多一个换行，指纹就变——这正是「规则版本」能分组的原因
	const copy = join(root, 'data-copy')
	mkdirSync(copy)
	for (const file of ['pairing.json', 'forms.json']) writeFileSync(join(copy, file), readFileSync(join(dataDir, file)))
	const unchanged = rulesHashOf({ dataDir: copy })
	writeFileSync(join(copy, 'pairing.json'), `${readFileSync(join(copy, 'pairing.json'), 'utf8')}\n`)
	assert.notEqual(rulesHashOf({ dataDir: copy }), unchanged)
})

test('事件时间＝ISO-8601 带显式时区偏移（两机读同一份台账不必心算 UTC 偏移才看先后）', () => {
	assert.match(isoNow(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
})

test('start 自举：台账与其目录都不存在时建出来，其余 action 遇台账缺失显式报错', async () => {
	const nested = join(root, 'bootstrap', '深层', 'dispatch-ledger.jsonl')
	assert.equal(existsSync(nested), false)
	const started = await runBatchAction({ port, path: nested, loadTables, dataDir, action: 'start', params: START })
	assert.equal(started.ok, true)
	assert.equal(existsSync(nested), true, '目录与文件都由这次 write 补建')
	assert.equal(readFileSync(nested, 'utf8').split('\n').filter((line) => line !== '').length, 1)
	for (const action of ['status', 'list']) {
		await assert.rejects(
			() => runBatchAction({ port, path: join(root, '尚未登记.jsonl'), loadTables, dataDir, action, params: {} }),
			/批次未登记（先 dispatch_batch start；start 是唯一的自举入口/,
		)
	}
	await assert.rejects(
		() => runBatchAction({ port, path: join(root, '尚未登记.jsonl'), loadTables, dataDir, action: 'advance', params: { batch: 'x', stage: '门一' } }),
		/批次未登记（先 dispatch_batch start/,
	)
})

test('start 幂等按本机可见性：本机台账已有同批 start 即报错不追加（防同机重复登记）', async () => {
	freshLedger('幂等')
	await start()
	await assert.rejects(() => start(), /本机台账已有 start 事件/)
	assert.equal(lines().length, 1, '被拒的那次不得落盘')
})

test('start 的必填与词表：batch/intent 缺一即点名，batchType 须是配对表主行（addon 行不作批型）', async () => {
	freshLedger('start校验')
	for (const [params, expected] of [
		[{ ...START, batch: '' }, /start 的 batch（批次名/],
		[{ ...START, intent: '  ' }, /start 的 intent/],
		[{ ...START, batchType: '涉鉴权/上传/输入' }, /不是配对表的主行行名/],
	]) {
		await assert.rejects(() => start(params), expected)
	}
	assert.deepEqual(lines(), [], '被拒的 start 一行都不许写')
	await start()
	const [event] = parsedLines()
	assert.deepEqual(event.decisions, START.decisions, '拍板清单逐条原文落盘')
	assert.equal(event.rules, rulesHashOf({ dataDir }), '工具自动记规则版本，调用方不用也不许自己填')
	assert.equal(event.subject, '', '未传的字符串缺省写空串而不是省略——读方不必猜「没传」还是「传了空」')
})

test('advance 追加事件，缺省数字字段写 0/空串不省略（读方统计不猜语义）', async () => {
	freshLedger('advance')
	await start()
	await advance({ batch: START.batch, stage: '门一', combo: '锚点核对 事实校准', recommended: '锚点核对 事实校准', perFormCounts: { 锚点核对: 2, 事实校准: 0 }, adopted: 2, overlap: 1 })
	const [, event] = parsedLines()
	assert.deepEqual(event.perFormCounts, { 锚点核对: 2, 事实校准: 0 }, '零也写进去：漏记与零不是一回事')
	assert.equal(event.missed, '')
	assert.equal(event.note, '')
	assert.equal(event.recommended, '锚点核对 事实校准', '推荐组合逐事件记：复盘算裁剪率的分母靠它')
	assert.equal(event.rules, rulesHashOf({ dataDir }))
})

test('advance 的参数边界：stage 对词表、perFormCounts 对形态词表、计数非负、批次未登记即拒', async () => {
	freshLedger('advance校验')
	await start()
	await assert.rejects(() => advance({ batch: START.batch, stage: '评审' }), /未知 stage「评审」.*取值对着 lifecycle 的阶段词表/)
	await assert.rejects(() => advance({ batch: START.batch, stage: '门一', perFormCounts: { 拼错的形态: 1 } }), /perFormCounts 的键「拼错的形态」不在形态词表内/)
	await assert.rejects(() => advance({ batch: START.batch, stage: '门一', perFormCounts: { 锚点核对: '两条' } }), /须是非负有限数/)
	await assert.rejects(() => advance({ batch: START.batch, stage: '门一', adopted: -1 }), /须是非负有限数/)
	await assert.rejects(() => advance({ batch: '没登记的批次', stage: '门一' }), /批次未登记（先 start）/)
	await assert.rejects(() => run('记一笔'), /未知 action「记一笔」/)
	assert.equal(lines().length, 1, '被拒的 advance 一行都不许写')
})

test('status：这一批的下一步与在飞集合从事件现推（记到门一即下一步施工）', async () => {
	freshLedger('status')
	await start()
	await start({ batch: '已收尾批次', batchType: '直做批', intent: '收尾' })
	await advance({ batch: START.batch, stage: '门一', perFormCounts: { 锚点核对: 2 }, adopted: 1 })
	await advance({ batch: '已收尾批次', stage: '提交' })
	const named = await run('status', { batch: START.batch })
	assert.equal(named.next, '施工', 'next＝furthest 之后 order 最小者')
	const inflight = await run('status', {})
	assert.equal(inflight.events, undefined, '多批视图的结构化值不带事件——一百分批就是几百 KB 的上下文')
	const inflightText = renderBatchResult(inflight, data)
	assert.ok(inflightText.includes(START.batch), `在飞批次要在视图里：${inflightText}`)
	assert.ok(!inflightText.includes('已收尾批次'), '记到提交那一步的批次不在飞，不进 status 的默认视图')
	await assert.rejects(() => run('status', { batch: '查无此批' }), /批次未登记（先 start）/)
})

test('修复批双 advance→status 显示二轮（门二次数＝复核轮数，轮数即事件条数）', async () => {
	freshLedger('二轮')
	await start({ batchType: '修复批' })
	await advance({ batch: START.batch, stage: '门二', perFormCounts: { '设计七维·终审': 2 }, adopted: 2 })
	await advance({ batch: START.batch, stage: '门二', perFormCounts: { '设计七维·终审': 1 }, adopted: 1, missed: '用户实测发现边界没兜住', note: '二轮：错结构' })
	const status = await run('status', { batch: START.batch })
	const text = renderBatchResult(status, data)
	assert.ok(text.includes('门二 第 2 轮'), `轮数现读成 2：\n${text}`)
	assert.ok(text.includes('采纳 3'), '两轮采纳数合计')
	assert.ok(text.includes('漏网'), text)
	assert.ok(text.includes('二轮：错结构'), 'note 尾注随行')
	assert.equal(foldBatch(status.events, data).stages.find((row) => row.id === '门二').rounds, 2)
})

test('缺门一 advance→status 出告警「门一 缺记录」（记了门二却没有门一）', async () => {
	freshLedger('缺门')
	await start()
	await advance({ batch: START.batch, stage: '门二', perFormCounts: { '设计七维·终审': 3 }, adopted: 3 })
	const status = await run('status', { batch: START.batch })
	const text = renderBatchResult(status, data)
	assert.ok(text.includes('门一 缺记录'), `furthest 之前的门没有 advance 事件要出告警：\n${text}`)
	assert.equal(foldBatch(status.events, data).warnings.filter((warning) => warning.includes('门一 缺记录')).length, 1)
})

test('一条 advance 都没有的批次不甩「缺记录」告警（还没走到那一步不是漏记）', async () => {
	freshLedger('刚start')
	await start()
	const state = foldBatch(parsedLines(), data)
	assert.deepEqual(state.warnings, [])
	assert.equal(state.next.id, data.lifecycle.stages[0].id, '下一步＝阶段表头一站')
	assert.deepEqual(state.gatesAhead, [], '没有 furthest 可作参照时不逐门报未过——那会在每次 start 时甩一串假警')
})

test('双 start 取 t 最小者并出告警（跨机并发登记的正常吸收态，不是事故）', async () => {
	freshLedger('双start')
	await start()
	await appendRaw({ t: '2030-01-01T00:00:00+08:00', batch: START.batch, action: 'start', batchType: '机械搬运/小修', intent: '另一台登记的', rules: 'deadbeef' })
	const status = await run('status', { batch: START.batch })
	const state = foldBatch(status.events, data)
	assert.equal(state.batchType, '纯后端管线批', '取 t 最小的那条')
	assert.equal(state.intent, '台账落共享层')
	assert.ok(renderBatchResult(status, data).includes('2 条 start 事件'))
})

test('乱序写入→推导结果不变（union 合并只保行不保序，推导必须是集合式的）', async () => {
	const events = [
		startEvent({ ...START, rules: 'a1b2c3d4', now: new Date('2026-10-15T10:00:00Z') }),
		advanceEvent({ batch: START.batch, stage: '门一', rules: 'a1b2c3d4', combo: '锚点核对', recommended: '锚点核对', perFormCounts: { 锚点核对: 2 }, adopted: 1, now: new Date('2026-10-15T10:10:00Z') }),
		advanceEvent({ batch: START.batch, stage: '施工', rules: 'a1b2c3d4', note: '施工完成', now: new Date('2026-10-15T10:20:00Z') }),
	]
	freshLedger('乱序')
	for (const event of [...events].reverse()) await appendRaw(event)
	const scrambled = await run('status', { batch: START.batch })
	freshLedger('正序')
	for (const event of events) await appendRaw(event)
	const ordered = await run('status', { batch: START.batch })
	assert.deepEqual(scrambled.events.map((event) => event.stage ?? event.action), ordered.events.map((event) => event.stage ?? event.action), '展示按 t 排，倒着写的两台机器读出来是同一份次序')
	assert.equal(renderBatchResult(scrambled, data), renderBatchResult(ordered, data), '两种行序推出来的状态文本逐字相同')
})

test('双批次隔离：一个批次的事件不进另一个批次的推导', async () => {
	freshLedger('双批次')
	await start()
	await start({ batch: '另一个批次', batchType: '机械搬运/小修', intent: '别的活', decisions: ['别的拍板'] })
	await advance({ batch: START.batch, stage: '门一', perFormCounts: { 锚点核对: 1 }, adopted: 1 })
	const first = await run('status', { batch: START.batch })
	const second = await run('status', { batch: '另一个批次' })
	assert.equal(first.events.every((event) => event.batch === START.batch), true)
	assert.equal(second.next, '方案', '另一个批次一条 advance 都没有')
	assert.equal(foldBatch(second.events, data).decisions[0], '别的拍板')
	const list = await run('list', {})
	assert.equal(list.events, undefined, 'list 的结构化值不带事件：全量事件进上下文是负担，渲染那一份由 execute 算成 rows 摘要')
	// rows 是多批视图的渲染输入（宿主深拷贝结构化值再交给 render，按对象身份的缓存必然 miss），
	// 也是程序侧直接可读的摘要——消费者不必自己 fold 一遍
	assert.equal(Array.isArray(list.rows), true, 'list 带 rows 摘要')
	assert.deepEqual(Object.keys(list.rows[0]).sort(), ['batch', 'batchType', 'gatesAhead', 'lastT', 'next', 'note', 'progress', 'warnings'])
	assert.deepEqual(new Set(list.rows.map((row) => row.batch)), new Set([START.batch, '另一个批次']), '两批各一行，互不串批')
	assert.equal(typeof list.rows[0].progress, 'string')
	assert.deepEqual(list.rows[0].warnings, [])
	const listText = renderBatchResult(list, data)
	assert.equal(new Set(listText.split('\n').filter((line) => line !== '').map((line) => line.split('｜')[0])).size, 2, '两批两行，互不串行')
})

test('list：全量批次一行一条，含批次名/批型/阶段进度/下一步/最近事件时间（note 空则省略）', async () => {
	freshLedger('list')
	await start()
	await start({ batch: '收尾批次', batchType: '直做批', intent: '收尾', subject: 'README' })
	await advance({ batch: START.batch, stage: '门一', perFormCounts: { 锚点核对: 2 }, adopted: 2, note: '门一过了' })
	const text = renderBatchResult(await run('list', {}), data)
	const rows = text.split('\n').filter((line) => line !== '')
	assert.equal(rows.length, 2, '一行一批次')
	const row = rows.filter((line) => line.startsWith(START.batch))[0]
	assert.ok(row.includes('纯后端管线批'), `批型要在这行里：${row}`)
	assert.ok(row.includes('门一已过'), `阶段进度要在这行里：${row}`)
	assert.ok(row.includes('下一步 施工'), row)
	assert.match(row, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/, '最近事件时间在行里')
	assert.ok(row.includes('门一过了'), 'note 尾注带出')
	const bare = rows.filter((line) => line.startsWith('收尾批次'))[0]
	assert.ok(!bare.endsWith('｜'), `note 空则整段省略，不留空尾巴：${bare}`)
})

test('每行都是可解析的一行 JSON（追加式文件的唯一不变量，含换行与引号的附注）', async () => {
	freshLedger('可解析')
	await start()
	await advance({ batch: START.batch, stage: '门一', perFormCounts: { 锚点核对: 2 }, adopted: 2 })
	await advance({ batch: START.batch, stage: '施工', note: '含引号与换行的附注："一"\n第二行' })
	const events = parsedLines()
	assert.equal(events.length, 3)
	for (const [index, event] of events.entries()) {
		assert.equal(typeof event.action, 'string', `第 ${index + 1} 行不是事件`)
	}
	assert.equal(events[2].note, '含引号与换行的附注："一"\n第二行', '转义后仍是原文一行')
	assert.ok(readFileSync(ledger, 'utf8').endsWith('\n'), '每行自带换行收尾，末行不为下一台留半行')
})

test('末行无换行的台账：append 后旧末行不粘连（先补 \\n 是规范性写入）', async () => {
	freshLedger('末行')
	await start()
	const withNewline = readFileSync(ledger, 'utf8')
	writeFileSync(ledger, withNewline.slice(0, -1), 'utf8')
	assert.equal(readFileSync(ledger, 'utf8').endsWith('\n'), false, '夹具：末行没有换行（人手写或另一台工具写出来的台账就长这样）')
	await advance({ batch: START.batch, stage: '门一', perFormCounts: { 锚点核对: 1 }, adopted: 1 })
	const parsed = parsedLines()
	assert.equal(parsed.length, 2, '两行：粘连会让第二行不可解析、第一行末尾多出一截')
	assert.equal(parsed[0].t, JSON.parse(withNewline).t, '旧末行原样保持')
})

test('版本失配报错：台账在写前被改过（并发）即拒，且别人的那一行不被覆盖', async () => {
	freshLedger('版本')
	await start()
	const racing = {
		...port,
		writeText: async (target, content, intent, signal) => {
			appendFileSync(target.targetKey, '{"t":"2030-01-01T00:00:00+08:00","batch":"别人","action":"start"}\n', 'utf8')
			return port.writeText(target, content, intent, signal)
		},
	}
	await assert.rejects(
		() => runBatchAction({ port: racing, path: ledger, loadTables, dataDir, action: 'advance', params: { batch: START.batch, stage: '门一' } }),
		(error) => {
			assert.equal(error.code, 'FS_STALE_VERSION', `版本失配须按 code 断（消费方不能 instanceof）：实得 ${error.message}`)
			return true
		},
	)
	assert.ok(readFileSync(ledger, 'utf8').includes('"batch":"别人"'), '别人的那一行不得被这次写覆盖掉')
})

test('台账含坏行→status/list 报错带行号（审计面不静默跳过）', async () => {
	freshLedger('坏行')
	await start()
	appendFileSync(ledger, '{这一行不是 JSON\n', 'utf8')
	for (const action of ['status', 'list']) {
		await assert.rejects(
			() => run(action, { batch: START.batch }),
			/批次台账第 2 行不是合法 JSON/,
			`${action} 遇坏行要报出行号：审计面少一条事件却照常出稿，读的人看不出来`,
		)
	}
	freshLedger('非对象行')
	await start()
	appendFileSync(ledger, '"我是一行字符串"\n', 'utf8')
	await assert.rejects(() => run('status', { batch: START.batch }), /第 2 行不是一个事件对象/)
})

test('回填：台账里的 batchType/intent/decisions 自动进参数，只填这一趟消费的那些槽位', () => {
	const events = [startEvent({ ...START, rules: 'a1b2c3d4' })]
	const review = backfillFromBatch(data, { stage: '门一', batch: START.batch, subject: '方案.md §批 4' }, events)
	assert.deepEqual(review.filled, ['batchType', 'intent', 'decisions'])
	assert.equal(review.params.batchType, '纯后端管线批')
	assert.deepEqual(review.params.decisions, START.decisions)
	// 方案那一趟不消费 decisions/batchType：填了就会撞 core 的「不消费即报错」
	const planning = backfillFromBatch(data, { stage: '方案', batch: START.batch, subject: '方案.md' }, events)
	assert.deepEqual(planning.filled, ['intent'], '只有 intent 进这一趟；batchType/decisions 台账里有也不填')
	assert.equal(planning.params.batchType, undefined)
	assert.equal(planning.params.decisions, undefined)
})

test('回填：台账登记的对象那格也进参数（每阶段都必填，正是登记一次、每路 brief 指同一对象的场合）', () => {
	const events = [startEvent({ ...START, subject: '方案.md §批 4', rules: 'a1b2c3d4' })]
	const review = backfillFromBatch(data, { stage: '门一', batch: START.batch }, events)
	assert.deepEqual(review.filled, ['batchType', 'intent', 'subject', 'decisions'], '四格全从台账补齐：这一趟没显式传就补')
	assert.equal(review.params.subject, '方案.md §批 4')
	const planning = backfillFromBatch(data, { stage: '方案', batch: START.batch }, events)
	assert.deepEqual(planning.filled, ['intent', 'subject'], '方案那一趟消费 subject/intent，batchType/decisions 台账里有也不填')
	assert.throws(() => backfillFromBatch(data, { stage: '门一', batch: START.batch, subject: '另一个方案.md' }, events), /与批次.*台账里登记的不一致/, '对象那格同样显式优先：两个来源说岔即报错')
})

test('回填：显式参数优先，与台账不一致即报错；台账没登记的批次不静默出稿', () => {
	const events = [startEvent({ ...START, rules: 'a1b2c3d4' })]
	const same = backfillFromBatch(data, { stage: '门一', batch: START.batch, batchType: START.batchType, decisions: START.decisions, intent: START.intent }, events)
	assert.deepEqual(same.filled, [], '与台账一致的显式值照用，不重复填也不报冲突')
	assert.throws(() => backfillFromBatch(data, { stage: '门一', batch: START.batch, intent: '另一句意图' }, events), /与批次.*台账里登记的不一致/)
	assert.throws(() => backfillFromBatch(data, { stage: '门一', batch: START.batch, decisions: ['另一份拍板'] }, events), /与批次.*台账里登记的不一致/)
	assert.throws(() => backfillFromBatch(data, { stage: '门一', batch: '查无此批' }, events), /批次未登记（先 dispatch_batch start）/)
})

test('回填：显式传空值即报错，不当没传（传空＝否定，与「没提这一格」在台账有登记时是两回事）', () => {
	const events = [startEvent({ ...START, rules: 'a1b2c3d4' })]
	assert.throws(() => backfillFromBatch(data, { stage: '门一', batch: START.batch, decisions: [] }, events), /显式传了空的 decisions/, '空数组被静默换成台账那份，调用方会以为自己否定过')
	assert.throws(() => backfillFromBatch(data, { stage: '门一', batch: START.batch, intent: '   ' }, events), /显式传了空的 intent/, '空白串同理：它在 core 那边是非空白判定的「没给」，静默取台账就是替调用方改了口径')
	// 这一趟不消费的槽位：交给 core 报「不消费即报错」，那条比「值为空」更指得准
	assert.deepEqual(
		backfillFromBatch(data, { stage: '方案', batch: START.batch, subject: 'x', decisions: [] }, events).filled,
		['intent'],
		'方案那一趟不消费 decisions，值是空不是问题：不回填，由 core 判它该不该收',
	)
})

test('回填输出≡把台账那几格显式传一遍的输出（两条路出的稿逐字相同）', async () => {
	const events = [startEvent({ ...START, subject: '方案.md §批 4', rules: 'a1b2c3d4' })]
	const backfilled = backfillFromBatch(data, { stage: '门一', batch: START.batch }, events).params
	const explicit = { stage: '门一', batch: START.batch, subject: '方案.md §批 4', batchType: START.batchType, intent: START.intent, decisions: START.decisions }
	const { assembleDispatch } = await import('../lib/dispatch/core.js')
	assert.deepEqual(assembleDispatch(data, backfilled), assembleDispatch(data, explicit), '显式传参与台账回填是同一份事实的两种来路，出稿不许有差别')
})

test('start/advance 的返回值＝写前读到的全量＋新事件（渲染不靠新事件那一行独角戏）', async () => {
	freshLedger('回全量')
	const started = await start()
	assert.equal(started.events.length, 1)
	assert.equal(renderBatchResult(started, data).includes(`批次 ${START.batch}（纯后端管线批）`), true, 'start 的返回值自己就能渲染出批型：只回新事件的话那是「批型未登记」')
	await advance({ batch: START.batch, stage: '门一', perFormCounts: { 锚点核对: 1 }, adopted: 1 })
	// 台账里已经有事件之后再 start：返回值要含写前那一份，否则第二次登记拿到的仍是「只有自己那一行」
	const second = await start({ batch: '第二个批次', batchType: '直做批', intent: '另一个活' })
	assert.deepEqual(second.events.map((event) => event.batch), ['第二个批次'], '只回本批那些：别批的行回进来，渲染会把另一个批次的 start 当成这一批的起点')
	const advanced = await advance({ batch: START.batch, stage: '门一', perFormCounts: { 锚点核对: 2 }, adopted: 2 })
	assert.deepEqual(advanced.events.map((event) => event.action), ['start', 'advance', 'advance'], '同一批的三条事件都在')
	const text = renderBatchResult(advanced, data)
	assert.ok(text.includes('意图：台账落共享层'), `丢意图行的渲染会让人以为登记时没写：${text}`)
	assert.ok(text.includes('门一 第 2 轮（采纳 3／重叠 0／拒收 0）'), text)
	assert.ok(!text.includes('缺记录'), `门一刚记过就不该甩假告警：${text}`)
	assert.ok(text.includes('下一步：施工'), text)
})

test('同一 stage 两轮的 note/missed 按事件时间取末：倒着写与正着写渲染逐字相同', async () => {
	const events = [
		startEvent({ ...START, rules: 'a1b2c3d4', now: new Date('2026-10-15T10:00:00Z') }),
		advanceEvent({ batch: START.batch, stage: '门二', rules: 'a1b2c3d4', perFormCounts: { '设计七维·终审': 2 }, adopted: 2, missed: '第一轮漏：边界', note: '一轮：错行', now: new Date('2026-10-15T10:10:00Z') }),
		advanceEvent({ batch: START.batch, stage: '门二', rules: 'a1b2c3d4', perFormCounts: { '设计七维·终审': 1 }, adopted: 1, missed: '二轮漏：并发', note: '二轮：错结构', now: new Date('2026-10-15T10:20:00Z') }),
	]
	freshLedger('note正序')
	for (const event of events) await appendRaw(event)
	const ordered = renderBatchResult(await run('status', { batch: START.batch }), data)
	freshLedger('note逆序')
	for (const event of [...events].reverse()) await appendRaw(event)
	const scrambled = renderBatchResult(await run('status', { batch: START.batch }), data)
	assert.equal(scrambled, ordered, '按行序取末的写法在这里会得出两份不同的文本——同一台账两种状态')
	assert.ok(ordered.includes('二轮：错结构') && !ordered.includes('一轮：错行'), `时间上最后的那条才是尾注：${ordered}`)
	assert.ok(ordered.includes('漏网：二轮漏：并发'), ordered)
})

test('免门的批型不收「门一 缺记录」（配对表该列为 null＝这个批型没有那道门，不是漏记）', async () => {
	freshLedger('免门')
	await start({ batchType: '直做批' })
	await advance({ batch: START.batch, stage: '门二', perFormCounts: { '设计七维·终审': 2 }, adopted: 2 })
	const status = await run('status', { batch: START.batch })
	const text = renderBatchResult(status, data)
	assert.ok(!text.includes('门一 缺记录'), `直做批的 gate1 是 null，每次都甩这条就是假警：${text}`)
	assert.equal(foldBatch(status.events, data).gatesAhead.includes('门一'), false, '门禁未过同理不列这个批型没有的门')
	// 三态：判不出的（needsBase 行按 baseBatchType 落回）照旧告警，且告警里注明保守
	freshLedger('保守告警')
	await start({ batchType: '修复批' })
	await advance({ batch: START.batch, stage: '门二', perFormCounts: { '设计七维·终审': 1 }, adopted: 1 })
	const warned = renderBatchResult(await run('status', { batch: START.batch }), data)
	assert.ok(warned.includes('门一 缺记录') && warned.includes('保守告警'), `判不出走不走就按全门告警并注明：${warned}`)
	// 对照：真有那道门的批型同一形状照旧报
	freshLedger('有门')
	await start()
	await advance({ batch: START.batch, stage: '门二', perFormCounts: { '设计七维·终审': 1 }, adopted: 1 })
	assert.ok(renderBatchResult(await run('status', { batch: START.batch }), data).includes('门一 缺记录'))
})

test('next 为 null 时结构化值里不带该键（schema 里它是可选的，留个 null 会被读成「有下一步但是空」）', async () => {
	freshLedger('末站')
	await start()
	await advance({ batch: START.batch, stage: '复盘' })
	const status = await run('status', { batch: START.batch })
	assert.equal(status.next, undefined)
	assert.match(renderBatchResult(status, data), /下一步：无（已记到阶段表末端）/)
})

test('事件时间按绝对时刻定序（两台机器写的同一时刻两种偏移写法，串比大小会判反）', async () => {
	// 两台机器各登了一次（跨机合并进来的两行）：按串比，'2026-10-15T02:00:00Z' 看着比
	// '2026-10-15T09:30:00+08:00' 小，可它其实是 10:00+08:00，晚了 31 分钟——该取的那条判反了
	const home = { t: '2026-10-15T02:00:00Z', batch: START.batch, action: 'start', batchType: START.batchType, intent: START.intent, subject: '', decisions: START.decisions, rules: 'a1b2c3d4' }
	const peer = { t: '2026-10-15T09:30:00+08:00', batch: START.batch, action: 'start', batchType: '机械搬运/小修', intent: '另一台先登记的', subject: '', decisions: [], rules: 'deadbeef' }
	freshLedger('时区')
	await appendRaw(home)
	await appendRaw(peer)
	const state = foldBatch(await run('status', { batch: START.batch }).then((value) => value.events), data)
	assert.equal(state.intent, '另一台先登记的', `按绝对时刻，09:30+08:00 在 02:00Z（＝10:00+08:00）之前：${JSON.stringify(state.starts.map((event) => event.t))}`)
	assert.equal(state.batchType, '机械搬运/小修')
})

test('空态分两种说法：台账一条事件都没有 vs 台账有批次但全收尾了', async () => {
	const emptyPath = join(root, '空台账.jsonl')
	writeFileSync(emptyPath, '', 'utf8')
	const emptyList = await runBatchAction({ port, path: emptyPath, loadTables, dataDir, action: 'list', params: {} })
	assert.match(renderBatchResult(emptyList, data), /台账里还没有任何批次（先 dispatch_batch start 登记）/, '在、但一条事件也没有')
	freshLedger('收尾')
	await start()
	await advance({ batch: START.batch, stage: '提交' })
	assert.match(renderBatchResult(await run('status', {}), data), /没有在飞批次（全部已提交或已复盘）/, '混成一句「没有批次」会把「活干完了」读成「该登记没登记」')
})

test('零值读法：缺字段的老事件与写全字段的新事件推导出同一份状态（缺省数字作 0、串作空串）', () => {
	const full = [
		startEvent({ ...START, rules: 'a1b2c3d4', now: new Date('2026-10-15T10:00:00Z') }),
		advanceEvent({ batch: START.batch, stage: '门一', rules: 'a1b2c3d4', combo: '锚点核对', recommended: '锚点核对', perFormCounts: { 锚点核对: 0 }, adopted: 0, overlap: 0, missed: '', note: '', now: new Date('2026-10-15T10:10:00Z') }),
	]
	const zeroed = full.map((event) => ({
		t: event.t,
		batch: event.batch,
		action: event.action,
		...(event.action === 'start' ? { batchType: event.batchType, intent: event.intent, subject: event.subject, decisions: event.decisions, rules: event.rules } : { stage: event.stage }),
	}))
	// starts/advances 是原样回显的事件本身（省略了字段当然不等），推导出来的那些量才要同值
	const derived = (state) => {
		const { starts, advances, ...rest } = state
		return rest
	}
	assert.deepEqual(derived(foldBatch(zeroed, data)), derived(foldBatch(full, data)), '写侧保证「缺省写 0/空串不省略」，读侧仍要能吃按老口径或手写省掉字段的行')
})

test('advance 的 adopted 不得多于本趟 findings 总数（恒等式在写入前就守住，不等推导时算成 0）', async () => {
	freshLedger('adopted上界')
	await start()
	await assert.rejects(
		() => advance({ batch: START.batch, stage: '门一', perFormCounts: { 锚点核对: 2 }, adopted: 3 }),
		/adopted=3 超过本趟 findings 总数 2/,
	)
	await assert.doesNotReject(() => advance({ batch: START.batch, stage: '门一', perFormCounts: { 锚点核对: 2 }, adopted: 2 }))
	assert.equal(lines().length, 2, '被拒的那次不落盘')
})

test('台账里的行不是事件（缺 batch 或缺时间）时报错带行号，不当半条事件往下算', async () => {
	freshLedger('缺字段')
	await start()
	appendFileSync(ledger, '{"t":"2026-10-15T10:00:00+08:00","action":"start","batchType":"直做批"}\n', 'utf8')
	await assert.rejects(() => run('status', { batch: START.batch }), /第 2 行不是一条事件（缺非空 batch/)
	freshLedger('缺时间')
	await start()
	appendFileSync(ledger, '{"batch":"谁写的","action":"start","batchType":"直做批"}\n', 'utf8')
	await assert.rejects(() => run('list', {}), /第 2 行不是一条事件（缺可解析的事件时间 t/)
})

test('start 自建台账走的是 createIfAbsent 分支（在场走 replaceIfVersion，缺席不是无条件覆写）', async () => {
	const fresh = join(root, 'createIfAbsent.jsonl')
	const intents = []
	const spy = {
		...port,
		writeText: async (target, content, intent, signal) => {
			intents.push(intent?.kind)
			return port.writeText(target, content, intent, signal)
		},
	}
	await runBatchAction({ port: spy, path: fresh, loadTables, dataDir, action: 'start', params: START })
	assert.deepEqual(intents, ['createIfAbsent'], '台账不在场时用独占创建：探针到发布之间另一台建好的文件不会被这份内容整篇盖掉')
	freshLedger('在场')
	await runBatchAction({ port: spy, path: ledger, loadTables, dataDir, action: 'start', params: START })
	intents.length = 0
	await runBatchAction({ port: spy, path: ledger, loadTables, dataDir, action: 'advance', params: { batch: START.batch, stage: '门一' } })
	assert.deepEqual(intents, ['replaceIfVersion'], '在场走带版本守卫的替换：并发 append 不会被整篇重写抹掉')
})

test('rules 指纹真现读：同一个 dataDir，两次调用之间改了文件，指纹就变', () => {
	const copy = join(root, 'data-现读')
	mkdirSync(copy)
	for (const file of ['pairing.json', 'forms.json']) writeFileSync(join(copy, file), readFileSync(join(dataDir, file)))
	const before = rulesHashOf({ dataDir: copy })
	writeFileSync(join(copy, 'forms.json'), `${readFileSync(join(copy, 'forms.json'), 'utf8')}\n`)
	const after = rulesHashOf({ dataDir: copy })
	assert.notEqual(after, before, '现读不缓存：缓存住的指纹会让事件里的规则版本永远停在注册那一刻')
})

test('性质断言：furthest 单调不减、门禁未过只缩不涨、告警条数＝缺记的门数', () => {
	const seeds = [
		advanceEvent({ batch: START.batch, stage: '方案', rules: 'a1b2c3d4', now: new Date('2026-10-15T10:00:00Z') }),
		advanceEvent({ batch: START.batch, stage: '门一', rules: 'a1b2c3d4', perFormCounts: { 锚点核对: 1 }, adopted: 1, now: new Date('2026-10-15T10:05:00Z') }),
		advanceEvent({ batch: START.batch, stage: '施工', rules: 'a1b2c3d4', now: new Date('2026-10-15T10:10:00Z') }),
		advanceEvent({ batch: START.batch, stage: '门二', rules: 'a1b2c3d4', perFormCounts: { '设计七维·终审': 1 }, adopted: 1, now: new Date('2026-10-15T10:15:00Z') }),
		advanceEvent({ batch: START.batch, stage: '提交', rules: 'a1b2c3d4', now: new Date('2026-10-15T10:20:00Z') }),
	]
	const gates = data.lifecycle.stages.filter((row) => row.gate === true)
	const opened = startEvent({ ...START, rules: 'a1b2c3d4', now: new Date('2026-10-15T09:00:00Z') })
	let previous = null
	for (const step of seeds) {
		const events = [opened, ...seeds.slice(0, seeds.indexOf(step) + 1)]
		const state = foldBatch(events, data)
		const missing = state.stages.filter((row) => row.gate === true && row.order < state.furthest.order && row.rounds === 0).length
		assert.equal(
			state.warnings.filter((warning) => warning.includes('缺记录')).length,
			missing,
			`记到${state.furthest.id}时，${missing} 道更早的门缺记录，告警条数必须对得上（不多报＝假警，少报＝漏记）`,
		)
		if (previous !== null) {
			assert.ok(state.furthest.order >= previous.furthest.order, 'furthest 单调不减：追加事件不可能让已推进的阶段退回去')
			assert.ok(state.gatesAhead.length <= previous.gatesAhead.length, '门禁未过只缩不涨')
		}
		previous = state
	}
	assert.ok(gates.length > 0, '性质断言的前提：阶段表里真有门阶段，否则下面全是空转')
})

test('在飞集合＝「furthest 为空 或 furthest.order < 提交行的 order」，数据里没有提交行即当场抛（前提由加载器保证，纯函数层不兜底）', async () => {
	freshLedger('在飞')
	await start()
	await start({ batch: '另一个批次', batchType: '机械搬运/小修', intent: '别的活' })
	await advance({ batch: START.batch, stage: '提交' })
	await advance({ batch: '另一个批次', stage: '方案' })
	const view = renderBatchResult(await run('status', {}), data)
	assert.ok(!view.includes(`批次 ${START.batch}`), '记到提交那一步的批次不在飞')
	assert.ok(view.includes('另一个批次'), '只记到方案的批次在飞')
	const events = parsedLines()
	const committed = data.lifecycle.stages.filter((row) => row.kind === '提交').map((row) => row.order)
	const expected = new Set(
		[...grouped(events)].filter(([, rows]) => {
			const state = foldBatch(rows, data)
			return state.furthest === null || state.furthest.order < Math.max(...committed)
		}).map(([name]) => name),
	)
	assert.deepEqual(new Set(expected), new Set(['另一个批次']), '公式本身：提交行的 order 取自 lifecycle（kind 标着，不按 id 硬编码）')
	assert.deepEqual(
		[...grouped(events)].filter(([, rows]) => foldBatch(rows, data).furthest === null).map(([name]) => name),
		[],
		'每个批次都至少记了一条 start，没有 furthest 为空的那一类',
	)
	// 数据里没有提交行时当场抛而不是退化全量：那份数据加载期就被拦（data.checkLifecycle 核「恰有
	// 一行」），故这格靠注入绕过加载器的表驱动。口径记录在此——兜底会把「数据坏了」表现成「所有
	// 批次都还堵着」，那正是提交前自查读不出来的一种静默
	const truncated = { ...data, lifecycle: { stages: data.lifecycle.stages.filter((row) => row.kind !== '提交') } }
	await assert.rejects(
		runBatchAction({
			port,
			path: ledger,
			dataDir,
			action: 'status',
			params: {},
			loadTables: ({ names }) => Object.fromEntries(names.map((name) => [name, name === 'lifecycle' ? truncated.lifecycle : data[name]])),
		}),
		/lifecycle 无 kind='提交' 行（或不止一行），实得 0 行.*数据未过加载校验/,
		'缺提交行不兜底：退化全量的症状是所有批次都还堵着，而真正的原因是数据没过加载校验',
	)
	await assert.rejects(
		runBatchAction({
			port,
			path: ledger,
			dataDir,
			action: 'status',
			params: {},
			loadTables: ({ names }) => Object.fromEntries(names.map((name) => [name, name === 'lifecycle'
				? {
					stages: [...data.lifecycle.stages, {
						...data.lifecycle.stages.find((row) => row.kind === '提交'),
						id: '提交流',
						order: 7,
					}],
				}
				: data[name]])),
		}),
		/实得 2 行/,
		'两行提交同样当场抛：多出来的那行会把提交这一步推到没有下一行的 order，加载期那道拦的是同一件事',
	)
})

/** 按 batch 切事件（与逻辑面 groupByBatch 同口径，测试侧自己切一遍，免得为了断言去导私货）。 */
function grouped(events) {
	const groups = new Map()
	for (const event of events) {
		if (!groups.has(event.batch)) groups.set(event.batch, [])
		groups.get(event.batch).push(event)
	}
	return groups.entries()
}

test('append 不变式：已写入的行逐字不变（最常见的「末尾有换行」那条路径也在内）', async () => {
	freshLedger('不变式')
	await start()
	const first = readFileSync(ledger, 'utf8')
	await advance({ batch: START.batch, stage: '门一', perFormCounts: { 锚点核对: 1 }, adopted: 1, note: '门一过了' })
	const after = readFileSync(ledger, 'utf8')
	assert.ok(after.startsWith(first), '末行带换行时不得往旧内容里插字符——重写旧行会毁掉两台机器各自的审计链')
	assert.equal(after.slice(first.length).split('\n').filter((line) => line !== '').length, 1)
	assert.deepEqual(parsedLines().map((event) => event.action), ['start', 'advance'])
})

test('渲染模型缺失抛一个专用的错，不静默出一份空视图（多批视图的结构化值不带事件）', () => {
	// 专用错误类是装配层重跑的开关：它只对「这次渲染拿不到推导所需的东西」重跑一次只读查询，
	// 把数据面真坏了这类错误也当成模型缺失重跑一遍，只会把两个故障叠在一起查
	assert.throws(() => renderBatchResult({ ok: true }, data), RenderModelMissingError, '多批视图拿不到推导所需的东西，抛专用错让装配层重跑')
	assert.throws(() => renderBatchResult({ ok: true, batch: START.batch }, data), RenderModelMissingError, '单批视图带了 batch 却没带事件，同一个错')
	const opened = startEvent({ ...START, rules: 'a1b2c3d4' })
	assert.match(renderBatchResult({ ok: true, batch: START.batch, events: [opened] }, data), /批次 dispatch-plugin-b4（纯后端管线批）/, '单批视图能从结构化值本身复算：它带事件')
})

test('在飞视图的门禁列表按批型的门列裁：furthest 停在方案时，免门一的批型不列门一（order 不再替判据挡着）', async () => {
	freshLedger('在飞免门')
	await start({ batchType: '机械搬运/小修' })
	await advance({ batch: START.batch, stage: '方案' })
	const state = foldBatch((await run('status', { batch: START.batch })).events, data)
	assert.equal(state.furthest.id, '方案', '只记到方案：门一与门二都在它之后，这时批型门列才真的参与裁剪')
	assert.equal(state.gatesAhead.includes('门一'), false, `机械搬运/小修的 gate1 是 null，不列：${JSON.stringify(state.gatesAhead)}`)
	assert.equal(state.gatesAhead.includes('门二'), true, '它有门二：该列的要列')
	assert.ok(renderBatchResult(await run('status', {}), data).includes('门禁未过 '), '在飞视图把未过的门名摆出来')
})

test('needsBase 的批型按 start 登记的 baseBatchType 落回门列判（修复批门禁＝原批型的门禁，判得出就不告警）', async () => {
	// 原批型有门一 ⇒ 这批走门一：门一没记就该报
	freshLedger('落回有门')
	await start({ batchType: '修复批', baseBatchType: '纯后端管线批' })
	await advance({ batch: START.batch, stage: '门二', perFormCounts: { 设计七维·终审: 1 }, adopted: 1 })
	const withGate = renderBatchResult(await run('status', { batch: START.batch }), data)
	assert.ok(withGate.includes('门一 缺记录') && !withGate.includes('保守告警'), `落回原批型判出门一要走，就照常报缺记录：${withGate}`)
	// 原批型免门一 ⇒ 判出这批不走门一：不报（恒保守全门＝每次 status 甩假警）
	freshLedger('落回免门')
	await start({ batchType: '修复批', baseBatchType: '机械搬运/小修' })
	await advance({ batch: START.batch, stage: '门二', perFormCounts: { 设计七维·终审: 1 }, adopted: 1 })
	const exempt = renderBatchResult(await run('status', { batch: START.batch }), data)
	assert.ok(!exempt.includes('门一 缺记录'), `落回的那一行 gate1 是 null，不报：${exempt}`)
	// 没登记 baseBatchType ⇒ 判不出，照旧保守告警并注明
	freshLedger('落回缺省')
	await start({ batchType: '修复批' })
	await advance({ batch: START.batch, stage: '门二', perFormCounts: { 设计七维·终审: 1 }, adopted: 1 })
	assert.ok(renderBatchResult(await run('status', { batch: START.batch }), data).includes('保守告警'))
	// start 把这一格记进事件（不给就是空串，缺省字段不省略）
	freshLedger('落回入账')
	const started = await start({ batchType: '修复批', baseBatchType: '跨端契约批' })
	assert.equal(parsedLines()[0].baseBatchType, '跨端契约批', '登记的值要落在 start 事件里——门禁推导读的就是它')
	assert.equal(started.events[0].baseBatchType, '跨端契约批')
	await assert.rejects(() => start({ batch: '别的批次', batchType: '修复批', baseBatchType: '不存在的批型' }), /不是配对表的主行行名/, '错字当场拒：等门禁推导时才显形，看到的是「判不出」，与真判不出长得一样')
})

test('foldBatch 直喂乱序数组：内部自己按事件时间定序（不经 queryAction 的预排序）', () => {
	const rows = [
		advanceEvent({ batch: START.batch, stage: '门一', rules: 'a1b2c3d4', perFormCounts: { 锚点核对: 1 }, adopted: 1, note: '第二轮的注', now: new Date('2026-10-15T12:00:00+08:00') }),
		startEvent({ ...START, rules: 'a1b2c3d4', now: new Date('2026-10-15T10:00:00+08:00') }),
		advanceEvent({ batch: START.batch, stage: '门一', rules: 'a1b2c3d4', perFormCounts: { 锚点核对: 2 }, adopted: 1, note: '第一轮的注', now: new Date('2026-10-15T11:00:00+08:00') }),
	]
	const ordered = foldBatch(rows, data)
	const shuffled = foldBatch([rows[2], rows[0], rows[1]], data)
	assert.deepEqual(shuffled, ordered, '同一组事件换任何顺序进来，推导结果逐字段相同')
	assert.equal(ordered.lastT, '2026-10-15T12:00:00+08:00', 'lastT 取时间最末那条，不取文件里最后一行')
	assert.equal(ordered.latestNote, '第二轮的注', '尾注同样按时间取末')
})

test('门别判定读的是 lifecycle 数据：把那行改成非门阶段，门禁推导跟着变（不按代码里那张自持表）', () => {
	// 门行判定与门列反查都取自 lifecycle 那几行。代码里另抄一份「门一是门一、门二是门二」的自持
	// 表，真数据与临时数据就此分家，而分家的那处不报错——门一照样被当成更早的门推、门二照样被
	// 当成 ahead 门列出去，而这条用例正是按那份自持表写的才留得住它
	const opened = startEvent({ ...START, rules: 'a1b2c3d4', now: new Date('2026-10-15T09:00:00Z') })
	const reviewed = advanceEvent({ batch: START.batch, stage: '门二', rules: 'a1b2c3d4', perFormCounts: { '设计七维·终审': 1 }, adopted: 1, now: new Date('2026-10-15T11:00:00Z') })
	const derelisted = structuredClone(data)
	const gate1 = derelisted.lifecycle.stages.find((row) => row.id === '门一')
	gate1.kind = '施工'
	gate1.gate = false
	const state = foldBatch([opened, reviewed], derelisted)
	assert.equal(state.warnings.filter((warning) => warning.includes('门一')).length, 0, '门一那行不再是门阶段：它不再被当作「更早的门」推缺记录')
	assert.deepEqual(state.gatesAhead, ['提交'], '门行集合只按数据里的 gate 算，不按写死的门名名单')
	const real = foldBatch([opened, reviewed], data)
	assert.ok(real.warnings.some((warning) => warning.includes('门一 缺记录')), '真数据里门一就是门阶段：同一组事件照旧报缺记录（上面那条不是恒真断言）')
})

test('门别反查表两门都在：落回的门列为空才免门，反查不到的那道门一律保守当走', () => {
	// 反查表少一门 → stageId 反查不到列就出 yes，免门批型照甩假警。落在「落回行该列为 null」
	// 这一档上才看得出差别：只查有门列的那种，反查表少写一门照样全绿
	const events = [
		startEvent({ ...START, batchType: '修复批', baseBatchType: '新功能·形态未定', rules: 'a1b2c3d4', now: new Date('2026-10-15T09:00:00Z') }),
		advanceEvent({ batch: START.batch, stage: '提交', rules: 'a1b2c3d4', now: new Date('2026-10-15T11:00:00Z') }),
	]
	const state = foldBatch(events, data)
	assert.ok(state.warnings.some((warning) => warning.includes('门一 缺记录')), '落回行 gate1 非空 ⇒ 这批走门一 ⇒ 该报缺记录')
	assert.ok(!state.warnings.some((warning) => warning.includes('门二 缺记录')), '落回行 gate2 是 null ⇒ 这批不走门二 ⇒ 不报（反查表少一门的话这里会变成一条假警）')
})

test('foldBatch 的阶段序按 order 排：lifecycle 的行序打乱也不改推导结果', () => {
	// 行序与阶段先后是两件事：JSON 里谁写在前面不承重，按行序排就等于多一份真相源
	const scrambled = structuredClone(data)
	scrambled.lifecycle.stages.reverse()
	const events = [
		startEvent({ ...START, rules: 'a1b2c3d4', now: new Date('2026-10-15T09:00:00Z') }),
		advanceEvent({ batch: START.batch, stage: '门一', rules: 'a1b2c3d4', perFormCounts: { 锚点核对: 1 }, adopted: 1, now: new Date('2026-10-15T10:00:00Z') }),
	]
	const ordered = foldBatch(events, data)
	const out = foldBatch(events, scrambled)
	assert.deepEqual(out.stages.map((row) => row.id), ordered.stages.map((row) => row.id), '阶段行仍按 order 排（方案→门一→施工→门二→提交→复盘）')
	assert.deepEqual(out.stages.map((row) => row.order), ordered.stages.map((row) => row.order))
	assert.equal(out.furthest.id, ordered.furthest.id, 'furthest 取「已记录里 order 最大者」，不取最后一行')
	assert.equal(out.next.id, ordered.next.id, 'next 是 furthest 之后 order 最小者')
	assert.deepEqual(out.gatesAhead, ordered.gatesAhead)
	assert.deepEqual(out.warnings, ordered.warnings)
	assert.notDeepEqual(scrambled.lifecycle.stages.map((row) => row.id), data.lifecycle.stages.map((row) => row.id), '前提：夹具的行序确实被打乱了（否则上面全是恒真断言）')
})

test('台账事件字段＝README「追加面的台账事件字段」记的那份清单：键集逐字对账', () => {
	// 事件字段的清单落点是 README（数据面 pages 删掉后那里是唯一一处），纯文档就会被改漂。
	// 键集是唯一可机判的那半：字段增删改名，文档还留着旧清单时这里先红
	const started = startEvent({ batch: START.batch, batchType: START.batchType, intent: START.intent })
	const advanced = advanceEvent({ batch: START.batch, stage: '门一', rules: 'a1b2c3d4' })
	assert.deepEqual(Object.keys(started).sort(), ['action', 'baseBatchType', 'batch', 'batchType', 'decisions', 'intent', 'rules', 'subject', 't'], 'start 事件＝公共四字段＋batchType/baseBatchType/intent/subject/decisions')
	assert.deepEqual(Object.keys(advanced).sort(), ['action', 'adopted', 'batch', 'combo', 'missed', 'note', 'overlap', 'perFormCounts', 'recommended', 'rules', 'stage', 't'], 'advance 事件＝公共四字段＋stage/combo/recommended/perFormCounts/adopted/overlap/missed/note')
	// 缺省写零值不省略：省略等于让读方在「没统计到」与「统计出零」之间猜（README 同一段的话）
	assert.equal(started.baseBatchType, '')
	assert.equal(started.subject, '')
	assert.deepEqual(started.decisions, [])
	assert.equal(advanced.combo, '')
	assert.equal(advanced.recommended, '')
	assert.deepEqual(advanced.perFormCounts, {})
	assert.equal(advanced.adopted, 0)
	assert.equal(advanced.overlap, 0)
	assert.equal(advanced.missed, '')
	assert.equal(advanced.note, '')
})

test('list 降序：最近动过的批次排前面（排序键是 lastT）', async () => {
	// 显式给 t 而不是连着跑三次：事件时间是秒级 ISO，同一秒写下的三条 lastT 相等，
	// 排出来看着「对」其实是平局的插入序——那种用例钉不住排序键
	freshLedger('list序')
	await appendRaw(startEvent({ batch: '先动的批', batchType: START.batchType, intent: '先', rules: 'a1b2c3d4', now: new Date('2026-10-15T10:00:00+08:00') }))
	await appendRaw(startEvent({ batch: '后动的批', batchType: START.batchType, intent: '后', rules: 'a1b2c3d4', now: new Date('2026-10-15T11:00:00+08:00') }))
	await appendRaw(advanceEvent({ batch: '先动的批', stage: '门一', rules: 'a1b2c3d4', perFormCounts: { 锚点核对: 1 }, adopted: 1, now: new Date('2026-10-15T12:00:00+08:00') }))
	const rows = renderBatchResult(await run('list', {}), data).split('\n').filter((line) => line !== '')
	assert.deepEqual(rows.map((line) => line.split('｜')[0]), ['先动的批', '后动的批'], '最近动的排前面：排序键是 lastT（12:00 那批在前），不是批名也不是登记顺序')
})

test('拒收恒等式在非零形状下也成立：渲染出的「拒收 N」＝findings 总数−采纳（推导不落盘）', async () => {
	freshLedger('拒收')
	await start()
	await advance({ batch: START.batch, stage: '门一', perFormCounts: { 锚点核对: 3, 事实校准: 1 }, adopted: 2, overlap: 1 })
	const state = foldBatch((await run('status', { batch: START.batch })).events, data)
	const stage = state.stages.find((row) => row.id === '门一')
	assert.equal(stage.found, 4)
	assert.equal(stage.adopted, 2)
	assert.equal(stage.rejected, 2, '4−2＝2')
	const text = renderBatchResult(await run('status', { batch: START.batch }), data)
	assert.ok(text.includes('拒收 2'), `渲染那一份也走同一恒等式：${text}`)
	assert.ok(text.includes('重叠 1'), text)
})

test('start 撞上半合并的台账（本批 advance 已并到、start 行还没并到）：返回值带那两条，渲染看得到已记的行', async () => {
	freshLedger('半合并')
	await appendRaw(advanceEvent({ batch: START.batch, stage: '门一', rules: 'a1b2c3d4', perFormCounts: { 锚点核对: 2 }, adopted: 2, note: '对头那台记的门一' }))
	const started = await start()
	assert.equal(started.events.length, 2, '写前读到的本批事件＋刚追加的 start 事件，一条不少')
	assert.deepEqual(started.events.map((event) => event.action), ['advance', 'start'], '按事件时间排：返回行的次序与 status 单批视图同一口径，程序侧不用各自再排')
	const text = renderBatchResult(started, data)
	assert.ok(text.includes('已记录：门一 第 1 轮') && text.includes('对头那台记的门一'), `渲染按这批自己的事件推导，不靠 start 那一行独角戏：${text}`)
	assert.ok(!text.includes('批型未登记'), text)
})

test('批型不在配对表（手写行/跨机旧行）⇒ 门禁判不出：告警按全门来并在文案里注明', async () => {
	freshLedger('未登记批型')
	await appendRaw(startEvent({ batch: START.batch, batchType: '早已下线的批型', intent: '老行', rules: 'a1b2c3d4' }))
	await appendRaw(advanceEvent({ batch: START.batch, stage: '门二', rules: 'a1b2c3d4', perFormCounts: { 旧形态: 1 }, adopted: 1 }))
	const state = foldBatch((await run('status', { batch: START.batch })).events, data)
	assert.deepEqual(state.warnings, state.warnings.filter((warning) => warning.includes('门一 缺记录')))
	assert.ok(state.warnings.some((warning) => warning.includes('判不出') && warning.includes('保守告警')), `判不出要说判不出，别让人以为真缺记录：${JSON.stringify(state.warnings)}`)
	assert.deepEqual(state.gatesAhead, ['提交'], '判不出的门按最坏算＝算在未过门里')
})

test('list 不带 batch 参数：带了即报错（与 dispatch「不消费的槽位收到值即报错」同一契约）', async () => {
	freshLedger('list带批')
	await start()
	await assert.rejects(() => run('list', { batch: START.batch }), /list 无 batch 参数/)
})

test('写动作的返回值直接渲染得出来（渲染模型与 status/list 同款，render 不现读台账）', async () => {
	freshLedger('写动作渲染')
	const started = await start()
	assert.ok(renderBatchResult(started, data).includes('下一步：方案'), `登记完那一趟渲染出的是状态本身：${renderBatchResult(started, data)}`)
	const advanced = await advance({ batch: START.batch, stage: '门一', perFormCounts: { 锚点核对: 1 }, adopted: 1, note: '过了' })
	const text = renderBatchResult(advanced, data)
	assert.ok(text.includes('已记录：门一 第 1 轮') && text.includes('下一步：施工') && text.includes('附注：过了'), text)
	assert.equal(advanced.next, '施工', 'next 进结构化值')
	// 渲染不现读台账：execute 那一次已经把推导好的状态挂在结果上，渲染是纯投影。台账删掉之后
	// 照样渲染得出来——渲染时再去读一次，那份文本就是「读到什么算什么」，同一批两次渲染能不一样
	rmSync(ledger, { force: true })
	assert.match(renderBatchResult(started, data), /批次 dispatch-plugin-b4（纯后端管线批）/, '台账已删仍渲染得出：状态挂在 execute 那一次的结果上')
	assert.match(renderBatchResult(advanced, data), /已记录：门一 第 1 轮/, '同上')
})

test('逐阶段那两格 note/missed 不再各存一份（渲染读的是跨阶段取末的 latestNote/latestMissed）', async () => {
	freshLedger('尾注单一')
	await start()
	await advance({ batch: START.batch, stage: '门一', perFormCounts: { 锚点核对: 1 }, adopted: 1, note: '门一的注' })
	await advance({ batch: START.batch, stage: '施工', perFormCounts: { 设计七维·终审: 1 }, adopted: 1, note: '施工的注' })
	const state = foldBatch((await run('status', { batch: START.batch })).events, data)
	assert.equal(state.latestNote, '施工的注')
	for (const stage of state.stages) {
		assert.equal(Object.hasOwn(stage, 'note'), false, `${stage.id} 的 note 字段没了——多一个能与 latestNote 分家的值`)
		assert.equal(Object.hasOwn(stage, 'missed'), false, `${stage.id} 的 missed 字段没了`)
	}
	assert.deepEqual(state.stages.map((stage) => stage.id).length > 0, true)
})

test('数据面读不出来时点名文件与原因（两处读法各带一条，别让坏数据悄悄过去）', async () => {
	assert.throws(() => loadDispatchTables({ dataDir, names: ['没这份表'] }), /现读面没有名为「没这份表」的数据文件/)
	const empty = join(root, '空数据目录')
	mkdirSync(empty, { recursive: true })
	assert.throws(() => loadDispatchTables({ dataDir: empty, names: ['pairing'] }), /dispatch 数据读取失败/, '目录在、表不在：点名路径，不返回空表')
	assert.throws(() => readDataBytes({ dataDir: empty, files: ['pairing.json'] }), /dispatch 数据读取失败.*pairing\.json/s)
	assert.throws(() => rulesHashOf({ dataDir: empty }), /dispatch 数据读取失败/, '指纹那条读法也点同一个名——两条读法坏在同一处时看得见是哪一处')
})
