/**
 * 装配层动态冒烟（node:test，零宿主依赖）：把两个宿主包说明符用 registerHooks 指到夹具替身上，
 * 动态 import 装配层，真调一次 execute 与 output.render。
 *
 * 这条用例钉的是一道**结构性缺口**：接线单测（imports.test.js）查的是导入名在不在导出面里，而
 * 「注册函数有没有把 ctx 传进 execute 用得到的地方」只有执行一次才知道——装配层曾经整条工具
 * 100% 抛 ReferenceError（execute 里引用了一个没进签名的变量），而那一百多个纯函数用例全绿：
 * 它们根本不 import 这个模块。凡是只有动态执行才暴露的接错（少传一个 ctx、少接一个端口、
 * 描述与参数面挂在错的工具上）都要在这条用例上红。
 *
 * hooks 是进程级的，故本文件里注册之后不要再 import 别的宿主相关模块；node --test 每个测试文件
 * 一个进程，互不影响。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createNodeFsPort } from '../lib/fs-port.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const STUBBED = new Map([
	['@deepseek-ai/dsh-tools', join(fixtures, 'host-dsh-tools-stub.mjs')],
	['@deepseek-ai/schemastery', join(fixtures, 'host-schemastery-stub.mjs')],
])
registerHooks({
	resolve(specifier, context, nextResolve) {
		const target = STUBBED.get(specifier)
		if (target === undefined) return nextResolve(specifier, context)
		return { url: pathToFileURL(target).href, shortCircuit: true, format: 'module' }
	},
})

const { registerDispatch, registerDispatchBatch, registerDispatchLessons, configShape } = await import('../lib/dispatch/index.js')

let root
let tools
let ledger

/** 宿主 fs 服务的替身：包一层本仓的 node 端口，并把 writeText 的形参补到五个（端口按洞位判契约）。
 *  stat 的缺失按**宿主契约**回 undefined（createHostFsPort 那层再归一成 {kind:'absent'}）——替身
 *  若照抄端口的归一形状，端口会把它当成「在场但没有 version」，第一次读就撞 ENOENT。 */
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
		writeText: (target, content, intent, signal, sandboxPolicy) => node.writeText(target, content, intent, signal),
	}
}

const ctxOf = () => {
	const registered = []
	return { ctx: { fs: hostFsOf(), get: () => undefined, tools: { register: (definition) => registered.push(definition) } }, registered }
}

before(() => {
	root = mkdtempSync(join(tmpdir(), 'dsh-dispatch-assembly-'))
	ledger = join(root, 'dispatch-ledger.jsonl')
})

after(() => {
	rmSync(root, { recursive: true, force: true })
})

test('装配层冒烟：三件工具注册得出来，且 execute 真被调过一次（纯函数用例照不到的那一层）', async () => {
	const dispatchCtx = ctxOf()
	const batchCtx = ctxOf()
	const lessonsCtx = ctxOf()
	registerDispatch(dispatchCtx.ctx, { dispatchDataDir: '', dispatchLedgerPath: ledger })
	registerDispatchBatch(batchCtx.ctx, { dispatchDataDir: '', dispatchLedgerPath: ledger })
	registerDispatchLessons(lessonsCtx.ctx, { dispatchDataDir: '', dispatchLedgerPath: ledger })
	const dispatchTool = dispatchCtx.registered[0]
	const batchTool = batchCtx.registered[0]
	const lessonsTool = lessonsCtx.registered[0]
	assert.equal(dispatchTool.name, 'dispatch')
	assert.equal(batchTool.name, 'dispatch_batch')
	assert.equal(lessonsTool.name, 'dispatch_lessons')
	assert.deepEqual(Object.keys(configShape), ['dispatchDataDir', 'dispatchLedgerPath'], 'Config 两个键：数据目录与台账路径')

	const exec = { signal: undefined, agent: { session: 'smoke' } }
	const lines = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').split('\n').filter((line) => line !== '') : []
	// 不带 batch 的老路径也要能跑通——回填那段在 execute 里，它引用错一个变量就是这条全红
	const plain = await dispatchTool.execute({ stage: '门一', batchType: '纯后端管线批', subject: 'README', intent: '冒烟' }, exec)
	assert.ok(plain.briefs.length > 0, '装配层 execute 要真能出稿：这条路径曾经 100% 抛 ReferenceError，而纯函数用例全绿')
	assert.equal(plain.combo.length > 0, true)

	const started = await batchTool.execute({ action: 'start', batch: 'smoke-batch', batchType: '纯后端管线批', intent: '台账落共享层', subject: 'README 装配层' }, exec)
	assert.equal(started.ok, true)
	// 两个写动作的返回值也要渲染得出来：它们曾只回新事件、渲染回落去现读数据面而抛错，
	// 而 render 那条路在纯函数用例里照不到（要宿主才有的 output.render 接线）
	assert.match((await batchTool.output.render({ action: 'start', batch: 'smoke-batch' }, started))[0].text, /批次 smoke-batch（纯后端管线批）/, 'start 那一趟的返回值渲染得出来')
	const advanced = await batchTool.execute({ action: 'advance', batch: 'smoke-batch', stage: '方案', note: '方案已定稿' }, exec)
	assert.match((await batchTool.output.render({ action: 'advance', batch: 'smoke-batch' }, advanced))[0].text, /已记录：方案 第 1 轮/, 'advance 那一趟的返回值渲染得出来')
	const status = await batchTool.execute({ action: 'status', batch: 'smoke-batch' }, exec)
	assert.equal(status.next, '门一')
	assert.match((await batchTool.output.render({ action: 'status', batch: 'smoke-batch' }, status))[0].text, /批次 smoke-batch（纯后端管线批）/)
	const list = await batchTool.execute({ action: 'list' }, exec)
	assert.match((await batchTool.output.render({ action: 'list' }, list))[0].text, /smoke-batch/, '多批视图的渲染模型挂在 execute 那一次的结果上（同对象直取，不用重跑）')

	const beforeCount = lines().length
	// 真宿主实测：它把 execute 的结构化值深拷贝一遍再交给 render（dsh-tools lib/index.js 的
	// snapshotToolValue＋deepFreeze），按对象身份的缓存在那条路上必然 miss（曾经有个 WeakMap
	// 渲染模型，真宿主上永远不命中）。现在两条视图的推导输入都在值自己身上：单批与写动作带
	// events，多批带 rows 摘要——深拷贝后渲染照常出文本。
	const clonedList = await batchTool.execute({ action: 'list' }, exec).then((value) => structuredClone(value))
	assert.ok(Array.isArray(clonedList.rows) && clonedList.rows.length > 0, '多批视图的结构化值带 rows 摘要：渲染的推导输入在值自己身上')
	assert.match((await batchTool.output.render({ action: 'list' }, clonedList))[0].text, /smoke-batch/, '多批视图深拷贝后照样渲染出正确文本（从值里的 rows 映射，不再依赖对象身份）')
	const clonedInflight = await batchTool.execute({ action: 'status' }, exec).then((value) => structuredClone(value))
	assert.match((await batchTool.output.render({ action: 'status' }, clonedInflight))[0].text, /smoke-batch/, '不带批次的 status 同理')
	assert.deepEqual(
		(await batchTool.output.render({ action: 'list' }, clonedList))[0].text,
		(await batchTool.output.render({ action: 'list' }, structuredClone(clonedList)))[0].text,
		'深拷贝几次文本都一样：渲染不碰对象身份，也不碰台账',
	)
	const single = await batchTool.execute({ action: 'status', batch: 'smoke-batch' }, exec).then((value) => structuredClone(value))
	assert.match((await batchTool.output.render({ action: 'status', batch: 'smoke-batch' }, single))[0].text, /批次 smoke-batch（纯后端管线批）/, '单批视图深拷贝后靠结构化值自带的 events 复算，渲染照常')
	assert.match((await batchTool.output.render({ action: 'start', batch: 'smoke-batch' }, structuredClone(started)))[0].text, /批次 smoke-batch（纯后端管线批）/, '写动作深拷贝后同样靠 events 渲染')
	assert.equal(lines().length, beforeCount, '渲染这条路上没有写台账')

	// 跨工具那一趟：dispatch 带批次名跑一趟，回填把台账里的对象与意图补上
	const cross = await dispatchTool.execute({ stage: '门一', batch: 'smoke-batch' }, exec)
	assert.ok(cross.briefs[0].text.includes('对象：README 装配层。'), `回填的对象要进 brief：${cross.briefs[0].text}`)
	assert.ok(cross.briefs[0].text.includes('本批意图一句话：台账落共享层。'), `回填的意图要进 brief：${cross.briefs[0].text}`)

	// 复盘那一趟：读的是刚才写进同一台账的事件——端口、路径、词法三段接线错任何一段都在这里红
	const pending = await lessonsTool.execute({}, exec)
	assert.equal(pending.due, false, '一个批次不到复盘点（批数与批型数双门槛）')
	assert.match((await lessonsTool.output.render({}, structuredClone(pending)))[0].text, /^未到复盘点（/)
	const forced = await lessonsTool.execute({ force: true }, exec)
	assert.equal(forced.due, true)
	assert.ok(forced.suggestions.length > 0, 'force 跳过点位也要出草稿')
	assert.match(
		(await lessonsTool.output.render({ force: true }, structuredClone(forced)))[0].text,
		/建议给主会话裁决，不自动改配对表/,
		'复盘的返回值深拷贝后照样渲染（渲染输入在值自己身上）',
	)
	assert.equal(lines().length, beforeCount, '复盘这一趟不写台账：出建议，不落盘')
})

test('复盘那一趟拿到的是只读门面：宿主 fs 的 writeText 就算会写也摸不到（边界是结构性的，不是纪律）', async () => {
	// 同一份 ctx 只把 writeText 换成会抛的替身：装配层要是把原端口原样传下去，往哪儿写都拦不住，
	// 而「只出建议不落盘」正是这套工具最贵的那条边界——它一破，复盘就开始自动改配对表
	const registered = []
	const ctx = {
		fs: {
			...hostFsOf(),
			// 五个形参照契约写齐（端口按洞位判形状），但一被调用就炸：这样「真的写了」与「碰都没碰」
			// 在同一份替身上分得开——门面漏传时代码走不到这里，两处都摸不到才是那个断点
			writeText: (target, content, intent, signal, sandboxPolicy) => {
				throw new Error('复盘工具不许写')
			},
		},
		get: () => undefined,
		tools: { register: (definition) => registered.push(definition) },
	}
	registerDispatchLessons(ctx, { dispatchDataDir: '', dispatchLedgerPath: ledger })
	const value = await registered[0].execute({ force: true }, { signal: undefined, agent: { session: 'smoke' } })
	assert.equal(value.due, true, '只读门面上照样跑得出复盘结果')
	assert.ok(value.suggestions.length > 0)
	// 接线那一步本身：门面造出来了不等于真传下去了，而「这一趟一次都没写」只证明现在没写。
	// 少了这行，把原端口原样传下去也不会红——那时边界又退回「靠记着别写」
	const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'dispatch', 'index.js'), 'utf8')
	assert.ok(
		/createReadOnlyPort\(createHostFsPort\(/.test(source),
		'复盘那一趟的端口须过只读门面：装配层把原端口传下去就等于没有这层保证',
	)
})

test('宿主 schema 编译的静态自查：三件工具的每个 object 节点都显式声明 additionalProperties', () => {
	// 这一条是替身够不到的那层：夹具的 defineTool 原样交回定义，把宿主的 schema 编译替身吃掉了，
	// 而真宿主在 object 节点没显式声明 additionalProperties 时整件工具注册失败（「unsupported JSON
	// schema」）——不在这里静态钉住，就只能等下次宿主启动才发现 dispatch_batch 整件缺席
	const ctx = ctxOf()
	registerDispatch(ctx.ctx, { dispatchDataDir: '', dispatchLedgerPath: ledger })
	const batchCtx = ctxOf()
	registerDispatchBatch(batchCtx.ctx, { dispatchDataDir: '', dispatchLedgerPath: ledger })
	const lessonsCtx = ctxOf()
	registerDispatchLessons(lessonsCtx.ctx, { dispatchDataDir: '', dispatchLedgerPath: ledger })
	for (const definition of [ctx.registered[0], batchCtx.registered[0], lessonsCtx.registered[0]]) {
		const bare = []
		const walk = (node, where) => {
			if (node === null || typeof node !== 'object') return
			if (Array.isArray(node)) {
				node.forEach((item, index) => walk(item, `${where}[${index}]`))
				return
			}
			if (node.type === 'object' && typeof node.additionalProperties !== 'boolean') bare.push(where)
			for (const [key, value] of Object.entries(node)) walk(value, `${where}.${key}`)
		}
		walk(definition.parameters, `${definition.name}.parameters`)
		walk(definition.output.schema, `${definition.name}.output.schema`)
		assert.deepEqual(bare, [], `${definition.name} 有 object 节点没显式 additionalProperties`)
	}
})

test('模板坏了不连坐台账工具：注册期只读配对表/形态表/阶段表，status 照常可用', () => {
	// 断的是「模板坏了 → 台账查询一起失败」这条连坐：台账记的是已经发生的批次，与出稿模板无关。
	// 对照组是 dispatch 工具——它出稿要用模板，模板坏了就该注册失败（缺了它不如缺席）
	const brokenData = join(root, 'data-broken')
	cpSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'dispatch', 'data'), brokenData, { recursive: true })
	writeFileSync(join(brokenData, 'templates.json'), '{ 这不是 JSON')
	const batchCtx = ctxOf()
	registerDispatchBatch(batchCtx.ctx, { dispatchDataDir: brokenData, dispatchLedgerPath: ledger })
	assert.equal(batchCtx.registered.length, 1, '模板坏了，台账工具照样注册')
	assert.throws(() => registerDispatch(ctxOf().ctx, { dispatchDataDir: brokenData }), /dispatch 数据/, '对照组：dispatch 的出稿面真要用模板，坏了就该注册失败')
})
