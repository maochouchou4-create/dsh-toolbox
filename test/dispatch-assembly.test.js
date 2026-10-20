/**
 * 装配层动态冒烟（node:test，零宿主依赖）：把宿主包说明符用 registerHooks 指到夹具替身上，
 * 动态 import 装配层，真调 execute 与 output.render。
 *
 * 钉的是接线单测照不到的缺口：注册函数把 ctx 传错了地方、execute 里少接一个端口、描述挂在
 * 错的工具上——这些只有真执行一次才现形（历史上装配层整条工具抛 ReferenceError 而全部纯函数
 * 用例全绿）。台账写入也在这里验：start 出稿即落、gate 裁决即落，都是「自动落账」的实现面。
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
import { WORKFLOW_LINE } from '../lib/memory/assemble.js'
import { DISPATCH_DIR, FIXTURES_DIR, tempRoot } from './helpers.js'

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

const {
	configShape,
	registerDispatchBatch,
	registerDispatchChallenge,
	registerDispatchLessons,
	registerDispatchTask,
} = await import('../lib/dispatch/index.js')

const dispatchSource = ['index.js', 'core.js', 'parameters.js', 'batch.js', 'lessons.js', 'data.js', 'vocab.js']
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

/** 宿主上下文替身：tools.register 收下定义，fs 走 node 端口，get 返回 undefined＝按需服务取不到（生产同形）。 */
const ctxOf = () => {
	const registered = []
	return {
		ctx: {
			fs: hostFsOf(),
			get: () => undefined,
			inject: () => {},
			logger: { warn: () => {}, error: () => {} },
			systemPrompt: { context: () => {} },
			tools: { register: (definition) => registered.push(definition) },
		},
		registered,
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

const taskArgs = (overrides = {}) => ({
	batch: 'smoke-batch',
	tier: 'M',
	triage: 'M｜锚点全是内部实现符号，未触三硬触发',
	intent: '把跑批 v2 落地',
	anchors: ['loadDispatchData', 'SAFETY_CARRIER_IDS'],
	acceptance: 'npm test',
	changedFiles: 12,
	diffLines: 640,
	...overrides,
})

test('四件工具注册得出来：name／description／parameters／output 都挂在正确的一件上', () => {
	const tools = [
		mount(registerDispatchTask),
		mount(registerDispatchChallenge),
		mount(registerDispatchBatch),
		mount(registerDispatchLessons),
	]
	assert.deepEqual(tools.map((tool) => tool.name), ['dispatch_task', 'dispatch_challenge', 'dispatch_batch', 'dispatch_lessons'])
	for (const tool of tools) {
		assert.ok(tool.description.length > 20, `${tool.name} 的描述太短（模型选型靠它）`)
		assert.ok(tool.parameters && typeof tool.parameters === 'object')
		assert.equal(typeof tool.output.render, 'function')
		assert.ok(tool.output.schema)
	}
	const retiredAssemblers = ['plan', 'review', 'build', 'verify'].map((kind) => `registerDispatch${kind[0].toUpperCase()}${kind.slice(1)}`)
	for (const retired of retiredAssemblers) assert.ok(!dispatchSource.includes(retired), `装配层不该再有 ${retired}`)
	assert.deepEqual(Object.keys(configShape).sort(), ['dispatchDataDir', 'dispatchLedgerPath'])
})

test('描述面口径：四件各自点名四事件／档位／证伪门，不残留旧四件字样', () => {
	const task = mount(registerDispatchTask)
	const challenge = mount(registerDispatchChallenge)
	const batch = mount(registerDispatchBatch)
	const lessons = mount(registerDispatchLessons)
	assert.match(task.description, /档位 S\/M\/L/)
	assert.match(task.description, /start 事件/)
	assert.match(challenge.description, /证伪门/)
	assert.match(challenge.description, /gate 事件/)
	assert.match(batch.description, /start／gate／commit／review/)
	assert.match(lessons.description, /复盘节奏/)
	for (const tool of [task, challenge, batch, lessons]) {
		const retiredNames = [...['plan', 'review', 'build', 'verify'].map((kind) => `dispatch_${kind}`), 'dispatch_advance']
		for (const retired of retiredNames) {
			assert.ok(!tool.description.includes(retired), `${tool.name} 描述里还有 ${retired}`)
		}
	}
})

test('dispatch_task（M 档）：直出可派参数并自动落 start（档位/分诊行/拍板清单/规则指纹）', async () => {
	const tool = mount(registerDispatchTask)
	const value = await exec(tool, taskArgs({ decisions: ['拍板一：四事件'] }))
	assert.equal(value.tier, 'M')
	assert.equal(value.taskBook, true)
	assert.match(value.triageLine, /^分诊：M｜/)
	assert.deepEqual(value.workflowArgs, { label: '施工 smoke-batch（M）', prompt: value.prompt })
	assert.ok(value.prompt.includes(value.gateReportLine), '任务书必须带门报行')
	assert.match(value.text, /── 派发参数（subagent 直接可用；workflow 用 args\.workflowArgs）──/)
	const rendered = tool.output.render({}, value)
	assert.deepEqual(rendered, [{ type: 'text', text: value.text }])

	const events = ledgerLines()
	assert.equal(events.length, 1)
	assert.equal(events[0].action, 'start')
	assert.equal(events[0].tier, 'M')
	assert.deepEqual(events[0].decisions, ['拍板一：四事件'])
	assert.match(events[0].rules, /^[0-9a-f]{12}$/)

	const again = await exec(tool, taskArgs())
	assert.ok(again.warnings.some((warning) => warning.includes('已登记（start 存在）')))
	assert.equal(ledgerLines().length, 1, '重跑出稿不制造重复立项行')
})

test('dispatch_task（S 档）：免任务书不免记账——start 照落，指令里带升 M 口径', async () => {
	const tool = mount(registerDispatchTask)
	const value = await exec(tool, taskArgs({ batch: 'smoke-small', tier: 'S', triage: 'S｜单行改注释' }))
	assert.equal(value.taskBook, false)
	assert.match(value.text, /S 档施工指令（免任务书）/)
	assert.match(value.prompt, /贴不出「现存断言命令＋退出码」＝本批升 M/)
	assert.equal(ledgerLines().filter((event) => event.batch === 'smoke-small')[0].tier, 'S')
})

test('dispatch_task：diff 超阈当场拒绝（不降档收），不做半截落账', async () => {
	const tool = mount(registerDispatchTask)
	const before = ledgerLines().length
	await assert.rejects(() => exec(tool, taskArgs({ batch: 'smoke-over', diffLines: 1200 })), /强制升 L/)
	assert.equal(ledgerLines().length, before, '拒绝路径不写台账')
})

test('dispatch_challenge：回填台账登记值出 brief（不读施工汇报），出稿不写 gate', async () => {
	const task = mount(registerDispatchTask)
	await exec(task, taskArgs({ batch: 'smoke-gate', decisions: ['拍板二'] }))
	const before = ledgerLines().length
	const challenge = mount(registerDispatchChallenge)
	const value = await exec(challenge, { batch: 'smoke-gate', subject: 'git diff 8a0a01f..HEAD' })
	assert.equal(value.gate, '证伪门')
	assert.equal(value.tier, 'M', '档位从台账回填')
	assert.deepEqual(value.briefs.map((brief) => brief.form), ['证伪门'])
	assert.ok(value.briefs[0].text.includes('不读施工汇报'))
	assert.equal(value.adjudication.recorded, false)
	assert.equal(ledgerLines().length, before, '出 brief 不落 gate 事件')
	const rendered = challenge.output.render({}, value)
	assert.deepEqual(rendered, [{ type: 'text', text: value.text }])
})

test('dispatch_challenge：adjudicate=true 写 gate 事件（裁决字段＋段标记），落账后状态前进', async () => {
	const challenge = mount(registerDispatchChallenge)
	const value = await exec(challenge, {
		batch: 'smoke-gate',
		subject: 'git diff 8a0a01f..HEAD',
		adjudicate: true,
		perFormCounts: [{ form: '证伪门', count: 2 }],
		adopted: 2,
		rejected: 1,
		overlap: 0,
		missed: '',
		note: '假值一处',
		segment: '净 diff',
	})
	assert.equal(value.adjudication.recorded, true)
	assert.deepEqual(value.adjudication.forms, ['证伪门'])
	assert.match(value.text, /已记门报：批次 smoke-gate｜门 证伪门/)
	const gates = ledgerLines().filter((event) => event.action === 'gate' && event.batch === 'smoke-gate')
	assert.equal(gates.length, 1)
	assert.equal(gates[0].adopted, 2)
	assert.equal(gates[0].rejected, 1)
	assert.deepEqual(gates[0].perFormCounts, [{ form: '证伪门', count: 2 }])
	assert.equal(gates[0].segment, '净 diff')
	assert.match(gates[0].rules, /^[0-9a-f]{12}$/)

	const batch = mount(registerDispatchBatch)
	const status = await exec(batch, { action: 'status', batch: 'smoke-gate' })
	assert.equal(status.next, '提交')
	assert.match(status.text, /门报 1 轮（修复轮数 0；采纳 2／拒收 1／双报重叠 0）/)
	assert.deepEqual(batch.output.render({}, status), [{ type: 'text', text: status.text }])
})

test('dispatch_challenge：与台账登记冲突的显式参数当场拒绝（不许悄悄改口径）', async () => {
	const challenge = mount(registerDispatchChallenge)
	await assert.rejects(
		() => exec(challenge, { batch: 'smoke-gate', subject: 'git diff a..b', tier: 'L' }),
		/与批次「smoke-gate」台账里登记的不一致/,
	)
})

test('dispatch_batch：commit／review 追加事件，list 汇总全量批次', async () => {
	const batch = mount(registerDispatchBatch)
	const committed = await exec(batch, { action: 'commit', batch: 'smoke-gate', commit: 'abc1234', pushed: 'ok' })
	assert.match(committed.text, /提交：abc1234／推送 ok/)
	const reviewed = await exec(batch, { action: 'review', batch: 'smoke-gate', retro: '本批收', efficacy: '证伪门拦住假值' })
	assert.equal(reviewed.next, '完工')
	const list = await exec(batch, { action: 'list' })
	assert.match(list.text, /smoke-gate｜M｜已过：立项→门报→提交→复盘｜下一阶段：完工/)
	assert.match(list.text, /smoke-batch｜M/)
	const events = ledgerLines().filter((event) => event.batch === 'smoke-gate')
	assert.deepEqual(events.map((event) => event.action), ['start', 'gate', 'commit', 'review'])
})

test('dispatch_batch：渲染缺 text 即抛内部不变量错误（render 里不读盘、不重算）', () => {
	const batch = mount(registerDispatchBatch)
	assert.throws(() => batch.output.render({}, {}), /结构化值不带 text/)
})

test('dispatch_lessons：只读执行、输出点位统计与建议（review 事件已是销账点）', async () => {
	const lessons = mount(registerDispatchLessons)
	const value = await exec(lessons, { force: true })
	assert.equal(typeof value.due, 'boolean')
	assert.match(value.stats, /复盘口径：/)
	assert.match(value.stats, /点位判据：攒 5–8 批/)
	assert.ok(Array.isArray(value.suggestions) && value.suggestions.length > 0)
	assert.ok(lessons.output.render({}, value)[0].text.includes(value.suggestions[0]))
})

test('工作流引导行＝四事件口径（注入块首行随 v2 改版，测试即契约）', () => {
	assert.ok(WORKFLOW_LINE.includes('立项→门报→提交→复盘'))
	for (const event of ['start', 'gate', 'commit', 'review']) {
		assert.ok(WORKFLOW_LINE.includes(event), `引导行要点名事件 ${event}`)
	}
	assert.ok(WORKFLOW_LINE.includes('dispatch_task'))
	assert.ok(WORKFLOW_LINE.includes('dispatch_challenge'))
})
