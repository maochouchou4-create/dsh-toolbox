/**
 * 装配层动态冒烟（node:test，零宿主依赖）：把宿主包说明符用 registerHooks 指到夹具替身上，
 * 动态 import 装配层，真调 execute 与 output.render。
 *
 * 钉的是接线单测照不到的缺口：注册函数把 ctx 传错了地方、execute 里少接一个端口、描述挂在
 * 错的工具上——这些只有真执行一次才现形（历史上装配层整条工具抛 ReferenceError 而全部纯函数
 * 用例全绿）。台账写入也在这里验：六动作经 execute 落盘；纪律注入块也在这里验「真的注册进了
 * systemPrompt.context、真的现读数据文件」。
 *
 * hooks 是进程级的，故本文件里注册之后不要再 import 别的宿主相关模块；node --test 每个测试
 * 文件一个进程，互不影响。
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createNodeFsPort } from '../lib/fs-port.js'
import { DISPATCH_DATA_DIR, DISPATCH_DIR, FIXTURES_DIR, tempRoot } from './helpers.js'

const STUBBED = new Map([
	['@deepseek-ai/dsh-tools', join(FIXTURES_DIR, 'host-dsh-tools-stub.mjs')],
	['@deepseek-ai/schemastery', join(FIXTURES_DIR, 'host-schemastery-stub.mjs')],
	['@deepseek-ai/dsh-llm', join(FIXTURES_DIR, 'host-dsh-llm-stub.mjs')],
])
registerHooks({
	resolve(specifier, context, nextResolve) {
		const target = STUBBED.get(specifier)
		if (target === undefined) return nextResolve(specifier, context)
		return { url: pathToFileURL(target).href, shortCircuit: true, format: 'module' }
	},
})

const { configShape, registerDispatchBatch } = await import('../lib/dispatch/index.js')
const { registerDiscipline } = await import('../lib/dispatch/discipline.js')
const { loadDispatchData } = await import('../lib/dispatch/data.js')
const { KIND_ACTIONS, LIFECYCLE_KINDS, GATE_LABELS } = await import('../lib/dispatch/vocab.js')

const dispatchSource = ['index.js', 'parameters.js', 'batch.js', 'data.js', 'vocab.js', 'discipline.js']
	.map((file) => readFileSync(join(DISPATCH_DIR, file), 'utf8'))
	.join('\n')

/** 宿主 fs 服务的替身：包一层本仓 node 端口（writeText 的形参补到五个）；stat 缺失按宿主契约回 undefined。 */
const hostFsOf = () => {
	const node = createNodeFsPort()
	return {
		resolve: (path) => node.resolve(path),
		stat: async (target, signal) => {
			const info = await node.stat(target, signal)
			return info.kind === 'present' ? info : undefined
		},
		readText: (target, signal) => node.readText(target, signal),
		listDir: (target, signal) => node.listDir(target, signal),
		readByteRange: async () => new Uint8Array(),
		writeText: (target, content, intent, signal, sandboxPolicy) => node.writeText(target, content, intent, signal, sandboxPolicy),
	}
}

/** 宿主上下文替身：tools.register 收下定义，systemPrompt.context 收下注入件；get 返回 undefined（生产同形）。 */
const ctxOf = () => {
	const registered = []
	const contexts = []
	const warnings = []
	return {
		ctx: {
			fs: hostFsOf(),
			get: () => undefined,
			inject: () => {},
			logger: { warn: (message) => warnings.push(message), error: () => {} },
			systemPrompt: { context: (definition) => contexts.push(definition) },
			tools: { register: (definition) => registered.push(definition) },
		},
		registered,
		contexts,
		warnings,
	}
}

let root
let ledger
before((t) => {
	root = tempRoot(t, 'dispatch-assembly')
	ledger = join(root, 'data', 'dispatch-ledger.jsonl')
})

const mount = (register) => {
	const handle = ctxOf()
	register(handle.ctx, { dispatchDataDir: '', dispatchLedgerPath: ledger })
	assert.equal(handle.registered.length, 1, '一次注册只装一件')
	return handle.registered[0]
}

const exec = (tool, args) => tool.execute(args, { agent: undefined, signal: undefined })

const ledgerLines = () =>
	existsSync(ledger)
		? readFileSync(ledger, 'utf8').trimEnd().split('\n').filter(Boolean).map((line) => JSON.parse(line))
		: []

const startArgs = (overrides = {}) => ({
	action: 'start',
	batch: 'smoke-batch',
	intent: '把方案先行的立项出稿落地',
	...overrides,
})

test('只装一件台账工具：name／description／parameters／output 都在 dispatch_batch 上，退役装配件全不见', () => {
	const tool = mount(registerDispatchBatch)
	assert.equal(tool.name, 'dispatch_batch')
	assert.ok(tool.description.length > 20, '描述太短（模型选型靠它）')
	assert.match(tool.description, /start／gate／commit／review／status／list/, '六动作写进描述')
	assert.match(tool.description, /只记事实/, '台账口径＝只记事实（不设闸、不设提醒）必须写进描述')
	assert.ok(tool.parameters && typeof tool.parameters === 'object')
	assert.equal(typeof tool.output.render, 'function')
	assert.ok(tool.output.schema)
	assert.deepEqual(Object.keys(configShape).sort(), ['dispatchDataDir', 'dispatchLedgerPath'])
	for (const retired of ['registerDispatchTask', 'registerDispatchChallenge', 'dispatch_task', 'dispatch_challenge']) {
		assert.ok(!dispatchSource.includes(retired), `装配层不该再有 ${retired}`)
	}
})

test('退役参数不回流：output.schema 属性面没有档位/分诊/预算旧格', () => {
	const tool = mount(registerDispatchBatch)
	const declared = Object.keys(tool.output.schema.properties)
	for (const retired of ['tier', 'triage', 'triageLine', 'diffBudget', 'taskBook', 'planAppendix']) {
		assert.ok(!declared.includes(retired), `output.schema 还带着 ${retired}`)
	}
	assert.deepEqual(declared.sort(), ['batch', 'emptyText', 'events', 'next', 'ok', 'rows', 'text'])
})

test('描述面口径：批台账六动作、review 收官清账、无档位/分诊/两件旧工具', () => {
	const tool = mount(registerDispatchBatch)
	assert.match(tool.description, /start／gate／commit／review／status／list/)
	assert.match(tool.description, /review 收官即清该批全部行/, '台账口径＝进行中批的工作台')
	assert.doesNotMatch(tool.description, /档位|分诊|S\/M\/L/)
	for (const retired of ['dispatch_task', 'dispatch_challenge', 'dispatch_advance', 'dispatch_lessons']) {
		assert.ok(!tool.description.includes(retired), `描述里还有 ${retired}`)
	}
})

test('dispatch_batch start：经 execute 真落账（意图/拍板清单/规则指纹/占位 subject），同批重跑不重复', async () => {
	const tool = mount(registerDispatchBatch)
	const value = await exec(tool, startArgs({ decisions: ['拍板一：六动作'] }))
	assert.equal(value.ok, true)
	assert.equal(value.next, '门报')
	assert.match(value.text, /已落 start 事件/)
	const events = ledgerLines()
	assert.equal(events.length, 1)
	assert.equal(events[0].action, 'start')
	assert.equal(events[0].intent, '把方案先行的立项出稿落地')
	assert.deepEqual(events[0].decisions, ['拍板一：六动作'])
	assert.equal(events[0].subject, '（待写）')
	assert.match(events[0].rules, /^[0-9a-f]{12}$/)
	assert.ok(!('tier' in events[0]), 'start 事件不带档位格')

	const again = await exec(tool, startArgs())
	assert.match(again.text, /已登记（start 存在）/)
	assert.equal(ledgerLines().length, 1, '重跑不制造重复立项行')
	assert.deepEqual(tool.output.render({}, value), [{ type: 'text', text: value.text }])
})

test('dispatch_batch gate：门名必须∈词表、缺省段位按门分叉、事件落盘后状态前进', async () => {
	const tool = mount(registerDispatchBatch)
	await assert.rejects(
		() => exec(tool, { action: 'gate', batch: 'smoke-batch', gate: '证伪复核' }),
		/gate 必须是门名之一（方案证伪／证伪门）/,
	)
	const plan = await exec(tool, { action: 'gate', batch: 'smoke-batch', gate: GATE_LABELS.planChallenge })
	assert.match(plan.text, /已落 gate 事件：批次 smoke-batch｜门 方案证伪｜段 方案/)
	const final = await exec(tool, {
		action: 'gate',
		batch: 'smoke-batch',
		gate: GATE_LABELS.challenge,
		segment: '净 diff',
		perFormCounts: [{ form: '证伪复核', count: 2 }],
		adopted: 2,
		rejected: 1,
		overlap: 0,
		note: '假值一处',
	})
	assert.equal(final.next, '提交')
	assert.match(final.text, /门报 2 轮（修复轮数 0；采纳 2／拒收 1／双报重叠 0）/)
	const gates = ledgerLines().filter((event) => event.action === 'gate')
	assert.equal(gates.length, 2)
	assert.equal(gates[1].segment, '净 diff')
	assert.deepEqual(gates[1].perFormCounts, [{ form: '证伪复核', count: 2 }])
	assert.match(gates[1].rules, /^[0-9a-f]{12}$/)
})

test('dispatch_batch status/list：出口恒为字符串字段（MCP 出口校验不容 null）', async () => {
	const tool = mount(registerDispatchBatch)
	const status = await exec(tool, { action: 'status', batch: 'smoke-batch' })
	assert.equal(typeof status.next, 'string')
	assert.match(status.text, /批次 smoke-batch/)
	const list = await exec(tool, { action: 'list' })
	assert.ok(list.rows.length >= 1)
	assert.ok(list.rows.every((row) => typeof row.next === 'string'))
	assert.deepEqual(tool.output.render({}, status), [{ type: 'text', text: status.text }])
})

test('dispatch_batch commit/review：commit 追加事件，review 收官即清该批台账行（别批原样保留）', async () => {
	const tool = mount(registerDispatchBatch)
	await exec(tool, startArgs({ batch: 'smoke-keep', intent: '别批' }))
	const committed = await exec(tool, { action: 'commit', batch: 'smoke-batch', commit: 'abc1234', pushed: 'ok' })
	assert.match(committed.text, /提交：abc1234／推送 ok/)
	assert.deepEqual(
		ledgerLines().filter((event) => event.batch === 'smoke-batch').map((event) => event.action),
		['start', 'gate', 'gate', 'commit'],
	)
	const reviewed = await exec(tool, { action: 'review', batch: 'smoke-batch', retro: '本批收', efficacy: '证伪门拦住假值' })
	assert.equal(reviewed.next, '完工')
	assert.deepEqual(ledgerLines().filter((event) => event.batch === 'smoke-batch'), [], 'review 后台账文件无该批行')
	const list = await exec(tool, { action: 'list' })
	assert.doesNotMatch(list.text, /smoke-batch/, '已收官批从 list 消失')
	assert.match(list.text, /smoke-keep/, '别批的行保留')
})

test('dispatch_batch 未知参数：传了就点名报错，不静默忽略', async () => {
	const tool = mount(registerDispatchBatch)
	await assert.rejects(
		() => exec(tool, startArgs({ tier: 'M', triage: 'M｜触公开契约', changedFiles: 5 })),
		/未知参数「tier、triage、changedFiles」——本工具没有这个参数/,
	)
	await assert.rejects(() => exec(tool, { action: 'start', batch: 'x' }), /intent 必须是非空字符串/)
})

test('dispatch_batch：渲染缺 text 即抛内部不变量错误（render 里不读盘、不重算）', () => {
	const tool = mount(registerDispatchBatch)
	assert.throws(() => tool.output.render({}, {}), /结构化值不带 text/)
})

test('纪律注入：注册 name/order 正确，text 现读两文件并渲染模板绝对路径（阶段序与 lifecycle 互验）', () => {
	const handle = ctxOf()
	registerDiscipline(handle.ctx, { dispatchDataDir: '' })
	assert.equal(handle.registered.length, 0, '纪律注入不是工具，不进 tools.register')
	assert.equal(handle.contexts.length, 1)
	const block = handle.contexts[0]
	assert.equal(block.name, 'dispatch:discipline')
	assert.equal(block.order, 130)
	assert.equal(typeof block.text, 'function', 'text 必须是现读回调（改纪律不必发版重启）')

	const text = block.text()
	assert.deepEqual(handle.warnings, [], '真数据加载不该有 warning')
	assert.ok(text.length > 0, '注入块不能为空（哨兵一：读失败静默缺席是最坏故障）')
	assert.ok(text.includes(join(DISPATCH_DATA_DIR, 'templates.md')), '模板指针必须是现算的绝对路径')
	assert.ok(!text.includes('{templates}'), '占位符必须被渲染掉，模型看不到花括号')

	const { data } = loadDispatchData()
	assert.ok(text.includes(data.discipline.replace('{templates}', join(DISPATCH_DATA_DIR, 'templates.md')).split('\n')[0].replace(/^#\s*/, '# ')), '块体就是 discipline.md 原文（现读）')
	let last = -1
	for (const kind of LIFECYCLE_KINDS) {
		const at = text.indexOf(KIND_ACTIONS[kind] === undefined ? kind : `action=${KIND_ACTIONS[kind]}`)
		assert.ok(at >= 0 && at > last, `阶段「${kind}」在注入块里的顺序必须与 lifecycle 阶段表一致`)
		last = at
	}
	for (const [kind, label] of Object.entries({ 方案证伪: GATE_LABELS.planChallenge, 证伪门: GATE_LABELS.challenge })) {
		assert.ok(text.includes(label), `注入块要点名门「${kind}」`)
	}
})

test('纪律注入失败路径：数据目录读不到→text() 空串＋warn 一条（静默缺席要留痕）', () => {
	const handle = ctxOf()
	registerDiscipline(handle.ctx, { dispatchDataDir: join(root, 'missing-data') })
	assert.equal(handle.contexts.length, 1)
	assert.equal(handle.contexts[0].text(), '')
	assert.equal(handle.warnings.length, 1)
	assert.match(handle.warnings[0], /\[dispatch\]/, 'warn 文案带模块前缀，便于宿主日志检索')
})
