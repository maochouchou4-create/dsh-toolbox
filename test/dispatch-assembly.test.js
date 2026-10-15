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
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createNodeFsPort } from '../lib/fs-port.js'
import { transcribe } from '../lib/see-image/vision.js'
import { objectShape, stringList } from '../lib/tool-schema.js'
import { dispatchStages, mainBatchTypes } from '../lib/dispatch/core.js'
import { loadDispatchData } from '../lib/dispatch/data.js'
import { DISPATCH_DATA_DIR, DISPATCH_DIR, FIXTURES_DIR, tempRoot } from './helpers.js'

const STUBBED = new Map([
	['@deepseek-ai/dsh-tools', join(FIXTURES_DIR, 'host-dsh-tools-stub.mjs')],
	['@deepseek-ai/schemastery', join(FIXTURES_DIR, 'host-schemastery-stub.mjs')],
	// see_image 从 dsh-llm 导入 BlockAssembler：静态自查要注册那一件，而注册期不需要真攒块器
	['@deepseek-ai/dsh-llm', join(FIXTURES_DIR, 'host-dsh-llm-stub.mjs')],
])
registerHooks({
	resolve(specifier, context, nextResolve) {
		const target = STUBBED.get(specifier)
		if (target === undefined) return nextResolve(specifier, context)
		return { url: pathToFileURL(target).href, shortCircuit: true, format: 'module' }
	},
})

const { registerDispatch, registerDispatchBatch, registerDispatchLessons, configShape } = await import('../lib/dispatch/index.js')
const { registerMemory } = await import('../lib/memory/index.js')
const { registerSeeImage } = await import('../lib/see-image/index.js')

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

/**
 * 宿主上下文的替身：tools.register 收下定义（五个注册入口都要它），fs 走本仓 node 端口，
 * logger 与 systemPrompt 在此只为让 memory 的注册入口跑完——它注册期要挂一段注入块文本，
 * 那段文本本文件的用例都不执行，故给空实现即可。get 返回 undefined 是「按需服务取不到」的
 * 正常态（沙箱策略缺失时生产也走这条），不是替身偷懒。
 */
const ctxOf = () => {
	const registered = []
	return {
		ctx: {
			fs: hostFsOf(),
			get: () => undefined,
			logger: { warn: () => {} },
			systemPrompt: { context: () => {} },
			tools: { register: (definition) => registered.push(definition) },
		},
		registered,
	}
}

before((t) => {
	root = tempRoot(t, 'dispatch-assembly')
	ledger = join(root, 'dispatch-ledger.jsonl')
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
	// 输出 schema 顶层闭集：text 是必填那一格。少了 required:true，值里没带 text 时宿主不会
	// 当场拒，而是把这份值递到 render——那时抛的是渲染层的错，报的还是同一件事，查起来却绕了一圈
	assert.equal(batchTool.output.schema.properties.text.required, true, 'text 在输出 schema 里必填（顶层闭集，多带/少带字段都是契约变更）')
	assert.equal(batchTool.output.schema.properties.text.type, 'string')
	assert.equal(batchTool.output.schema.additionalProperties, false, '顶层闭集：execute 交出表以外的字段即契约变更')
	for (const [名字, 值] of [['status(batch)', status], ['list', list]]) {
		assert.equal(值.text, (await batchTool.output.render({}, structuredClone(值)))[0].text, `${名字}：render 投影的就是值里那份 text`)
	}
	assert.throws(
		() => batchTool.output.render({ action: 'status', batch: 'smoke-batch' }, { ok: true, batch: 'smoke-batch', events: [] }),
		/batchToolRender|不带 text/u,
		'值里没有 text 即抛，不静默出空文本：空文本看不出是值少了一格',
	)

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
	const source = readFileSync(join(DISPATCH_DIR, 'index.js'), 'utf8')
	assert.ok(
		/createReadOnlyPort\(createHostFsPort\(/.test(source),
		'复盘那一趟的端口须过只读门面：装配层把原端口传下去就等于没有这层保证',
	)
})

test('宿主 schema 编译的静态自查：全仓五件工具的每个 object 节点都显式声明 additionalProperties，工厂产物同样过这道', () => {
	// 这一条是替身够不到的那层：夹具的 defineTool 原样交回定义，把宿主的 schema 编译替身吃掉了，
	// 而真宿主在 object 节点没显式声明 additionalProperties 时整件工具注册失败（「unsupported JSON
	// schema」）——不在这里静态钉住，就只能等下次宿主启动才发现那一件整件缺席（缺席的是整件工具，
	// 不是某个字段被拒，从症状上看不出是 schema 的问题）。
	// 覆盖面＝本包登记的全部工具（胶水 FEATURES 那五件）：漏注册一件，下面那次遍历对它空转而本
	// 条照样全绿，故工具名单照写不抄、并且断言它与胶水的 FEATURES 一致（imports.test.js 那条核 FEATURES）
	const memoryCtx = ctxOf()
	registerMemory(memoryCtx.ctx, { memoryRoot: join(root, 'memory-registration') })
	const seeImageCtx = ctxOf()
	registerSeeImage(seeImageCtx.ctx, {})
	const ctx = ctxOf()
	registerDispatch(ctx.ctx, { dispatchDataDir: '', dispatchLedgerPath: ledger })
	const batchCtx = ctxOf()
	registerDispatchBatch(batchCtx.ctx, { dispatchDataDir: '', dispatchLedgerPath: ledger })
	const lessonsCtx = ctxOf()
	registerDispatchLessons(lessonsCtx.ctx, { dispatchDataDir: '', dispatchLedgerPath: ledger })
	const definitions = [memoryCtx, seeImageCtx, ctx, batchCtx, lessonsCtx].flatMap((one) => one.registered)
	assert.deepEqual(
		definitions.map((definition) => definition.name).sort(),
		['dispatch', 'dispatch_batch', 'dispatch_lessons', 'memory', 'see_image'],
		'五件都在扫描面里：本包多注册一件工具而这张名单没跟上，下面的遍历对它空转而本条照样全绿',
	)
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
	for (const definition of definitions) {
		walk(definition.parameters, `${definition.name}.parameters`)
		walk(definition.output.schema, `${definition.name}.output.schema`)
	}
	// 工厂产物单独过一次：那两件是三族输出 schema 汇进去的地方，它哪天坏了，上面五件会一起红而
	// 报错路径指向的是消费方（看不出是哪一档形状先坏的）。开口那一档也过——它就是当前 BATCH
	// 输出里事件行/摘要行在用的形状
	walk(objectShape({ form: { type: 'string' } }), 'objectShape(缺省)')
	walk(objectShape(undefined, { additionalProperties: true }), 'objectShape(显式开口)')
	walk(stringList(), 'stringList()')
	assert.deepEqual(bare, [], '有 object 节点没显式 additionalProperties（路径前缀即工具名）')

	// 开口那一档的两个刻度：缺省必须是闭集（意外字段被拒），显式开口不得顺带吐一个空 properties
	// 键进宿主 schema——那是把「形状规格」变成第二个真相源，宿主照着编出来的类型会跟着变形
	assert.equal(objectShape({}).additionalProperties, false, 'objectShape 缺省闭集：开口是个决定，不是个缺省值')
	const open = objectShape(undefined, { additionalProperties: true })
	assert.equal(open.additionalProperties, true)
	assert.ok(!('properties' in open), '空壳 object 节点不带 properties 键（键集由写侧事件构造处决定）')
	// 「每次新对象」这条须在**同参**上比。拿不同入参比（objectShape({}) 与 objectShape(undefined)）
	// 对「同参 memo 一份单例」恒真：那正是要防的写法，而两次入参不同，样本本来就不可能同一份，
	// 比出来的 green 说明不了任何事。同参两次身份不同、深相等——前者防共用，后者防「每次造一个
	// 形状不一样的东西」
	assert.notEqual(objectShape({}), objectShape({}), 'objectShape 同参两次不得是同一份对象：共用一份时某处就地改写会顺着对象身份漏到别族')
	assert.notEqual(stringList(), stringList(), 'stringList 同理：它此前是 dispatch/index.js 的模块级 const，返回共用份时某族就地改写会顺着对象身份漏到另外两族')
	assert.deepEqual(objectShape({}), objectShape({}), '同参两次深相等：每次新对象是身份不同，不是形状不同')
	// 假值 fail fast：null/0/'' 都曾经能过（落进 properties 或被 spread 吞掉），症状是宿主照着一份
	// 不是键值包的东西编 schema，或者编出来少一截字段——两个都不在那条用例的名字上
	for (const bad of [null, 0, '']) {
		assert.throws(() => objectShape(bad), /properties 包须是键值对象/, `objectShape(${JSON.stringify(bad)}) 要当场报错：拼错的入参不该安静造出一份形状不对的 schema`)
	}
})

test('参数面 enum 与生产词表现读对齐：stage＝dispatchStages、batchType＝mainBatchTypes（addon 行只进描述）', () => {
	// 加 enum 的收益在宿主调用边界（dsh-tools 的 defineTool 先 validate(args)，不过就抛
	// ToolArgsError 并把合法值清单带出来），而夹具的 defineTool 替身把那层吃掉了——所以这条断言
	// 钉的是「enum 收的范围对不对」这一侧，且两侧都对着**生产函数**核。手抄一份派生式就是判据的
	// 第三处表述：lifecycle 调序（dispatchStages 按 order 排）时它与生产说岔，症状是「数据没改错、
	// 测试先红」，而报错指向的是一个不存在的方向。enum 从描述升进 schema 之后参数面这一格就是判据
	// 本身，故两端同一个函数。
	const ctx = ctxOf()
	registerDispatch(ctx.ctx, { dispatchDataDir: '', dispatchLedgerPath: ledger })
	const parameters = ctx.registered[0].parameters
	const data = loadDispatchData()
	for (const field of ['stage', 'batchType']) {
		assert.ok(Array.isArray(parameters[field].enum) && parameters[field].enum.length > 0, `${field} 的词表要进 schema（宿主 StringValueSchemaSpec 收 enum，且逐值核）`)
		assert.ok(parameters[field].enum.every((value) => typeof value === 'string'), `${field}.enum 的成员须全是字符串`)
	}
	// stage 只收出得了稿的那几个阶段（提交/复盘归 dispatch_batch/dispatch_lessons，本工具对它们报
	// 未知 stage，收进来等于放行一个必然在运行期才报的值）。收哪几个由 dispatchStages 单源定，故
	// 这里不再手抄「哪几个该在」那份名单——它会随数据调序而与生产说岔。
	assert.deepEqual(parameters.stage.enum, dispatchStages(data), 'stage enum 逐字等于 dispatchStages(data)：出得了稿的阶段，按 order 排')
	// batchType 收配对表主行行名（含 needsBase/needsRootCause 的特殊行，只排除 addon 行）
	assert.deepEqual(parameters.batchType.enum, mainBatchTypes(data), 'batchType enum 逐字等于 mainBatchTypes(data)：特殊行在内、addon 行不在')
	// addon 行不是 batchType 的合法值：收进 enum 就是让模型照着合法调用传一个必然被运行期拒的名字。
	// 名单从数据面现读（配对表增删 addon 行时这条跟着走），不在测试里手抄一份
	const addonNames = data.pairing.rows.filter((row) => row.kind === 'addon').map((row) => row.batchType)
	assert.ok(addonNames.length > 0, '配对表里真得有几行 addon，否则这条断言空转')
	for (const name of addonNames) {
		assert.ok(!parameters.batchType.enum.includes(name), `batchType enum 收了 addon 行「${name}」——加挂行只能经 addons 参数，不作 batchType`)
		assert.ok(parameters.batchType.description.includes(name) && parameters.batchType.description.includes('addons'), `描述里要点名 addon 行「${name}」并说清走 addons 参数：它不在 enum 里，模型只能从描述那条通道知道往哪填`)
	}
})

test('替身攒块器与 see_image 的消费面吻合：push 喂流、finish 判终态、blocks() 取正文（vision.js 真消费面实跑）', async () => {
	// 静态自查那层照不到消费面：它只看注册期定型的 schema，而 see_image 真正攒块是在 execute 里。
	// 替身先前给的是 add()/blocks 属性/text 取值器——三个成员没有一个是 vision.js 调的那个形状，
	// 于是任何走到消费面的用例都会在第一条 chunk 上炸，而报错指向 lib/see-image/vision.js。
	// 方法面照真宿主（dsh-llm 的 BlockAssembler）逐字对齐：push 是方法、blocks 是方法、finish 是
	// 取值器（没有 finish chunk 时给 {kind:'stop'}，不是 finish() 方法也不是 undefined）
	const { BlockAssembler } = await import('@deepseek-ai/dsh-llm')
	const assembler = new BlockAssembler()
	assert.equal(typeof assembler.push, 'function', 'push(chunk) 是方法：vision.js 逐 chunk 喂它')
	assert.equal(typeof assembler.blocks, 'function', 'blocks() 是方法不是属性：vision.js 取正文靠调它')
	assert.deepEqual(assembler.finish, { kind: 'stop' }, 'finish 是取值器且缺省给 stop：终态映射按它判空转述与出错')

	// 真消费面实跑：下面这段流与 assembler 就是 see_image execute 里那两次调用的形状（execute 还要
	// 宿主通道的 llm 服务，故这里钉到 transcribe 那一层——它在同一条路上，且是唯一碰 assembler 的地方）
	assert.equal(await transcribe({
		stream: streamOf([
			{ type: 'block-start', index: 0, blockType: 'text' },
			{ type: 'text-delta', index: 0, text: '  图里写着 ' },
			{ type: 'text-delta', index: 0, text: '三行字  ' },
			{ type: 'finish', reason: { kind: 'stop' } },
		]),
		assembler,
	}), '图里写着 三行字', 'text-delta 攒起来、去空白后交出正文')
	await assert.rejects(
		() => transcribe({ stream: streamOf([{ type: 'block-start', index: 0, blockType: 'reasoning' }]), assembler: new BlockAssembler() }),
		/空正文/,
		'没有 text 块即空转述：这条消费面同样要走到（只有方法名对而行为没验，等于替身与消费面各说各话）',
	)
})

/**
 * 替身与真宿主在攒块语义上的三处对拍，逐条一个用例。它们都不是「方法名在不在」那一层：宿主那边
 * 换了语义而替身没跟，用例照样全绿，而症状是某条视觉输出少了半句或整段转述变空——那两样在生产
 * 里都表现为「转述结果不如预期」，没有一个指向「攒块器没对齐」。
 * 参照是真宿主 dsh-llm 的 BlockAssembler.push（lib/index.js）。
 */
const streamOf = (chunks) => (async function* () {
	for (const chunk of chunks) yield chunk
})()

test('替身攒块语义对拍①：裸 text-delta（无 block-start）也攒出正文（真宿主按 delta 种类自动建块）', async () => {
	const { BlockAssembler } = await import('@deepseek-ai/dsh-llm')
	// 真宿主对「没开过块的 index」是 ensure 自动建块（块类型按 delta 种类定），不是丢弃：丢掉的话
	// 适配层走 delta-only 协议时正文恒空，而症状是「视觉模型明明回了字、转述却是空正文」
	const description = await transcribe({
		stream: streamOf([
			{ type: 'text-delta', index: 0, text: '裸 delta ' },
			{ type: 'text-delta', index: 0, text: '也出正文' },
		]),
		assembler: new BlockAssembler(),
	})
	assert.equal(description, '裸 delta 也出正文')
})

test('替身攒块语义对拍②：裸 block-end（无 block-start）以整块交出正文', async () => {
	const { BlockAssembler } = await import('@deepseek-ai/dsh-llm')
	const description = await transcribe({
		stream: streamOf([{ type: 'block-end', index: 0, block: { type: 'text', text: '整块正文' } }]),
		assembler: new BlockAssembler(),
	})
	assert.equal(description, '整块正文')
})

test('替身攒块语义对拍③：block-end 的整块优先于此前累积的 text，收尾后到达的 delta 不改变正文', async () => {
	const { BlockAssembler } = await import('@deepseek-ai/dsh-llm')
	// **这条只钉可观测的那一半**：blocks() 在 partial 已收尾时交出整块，所以「收尾后到达的 delta
	// 不改正文」与「整块优先于累积 text」是同一条事实的两个说法。宿主那边那条 delta 守卫
	// （partial.block 存在即 return）本身在这条消费面上**不可观测**——去掉它之后 blocks() 交出的
	// 仍是那一整块（实测过：带守卫与不带守卫，输出逐字相同），它防的是畸形流把半成品撑大或写脏，
	// 属内部状态那一层。所以别把这条用例当成「守卫在」的证据：它能变红的情形是 blocks() 改成
	// 优先累积 text，那时它该红。
	const description = await transcribe({
		stream: streamOf([
			{ type: 'block-start', index: 0, blockType: 'text' },
			{ type: 'text-delta', index: 0, text: '累积的半成品' },
			{ type: 'block-end', index: 0, block: { type: 'text', text: '正文（定稿）' } },
			{ type: 'text-delta', index: 0, text: '迟到的碎片' },
		]),
		assembler: new BlockAssembler(),
	})
	assert.equal(description, '正文（定稿）', '整块优先于累积 text，收尾后到达的 delta 不进正文')
})

test('替身攒块语义对拍④：不认识的 chunk 类型当场抛错（真宿主是 assertNever，替身吞掉即协议漂移无声）', async () => {
	const { BlockAssembler } = await import('@deepseek-ai/dsh-llm')
	// 静默吞掉的症状最难查：适配层改了 chunk 协议而替身不报，跑出来是「少了一段转述」而不是任何
	// 报错；真宿主那一侧是 assertNever 抛的，替身也该在同一条路上炸
	await assert.rejects(
		() => transcribe({
			stream: streamOf([{ type: 'brand-new-chunk-type', index: 0 }]),
			assembler: new BlockAssembler(),
		}),
		/替身不认识的 chunk 类型.*brand-new-chunk-type/,
		'未知 chunk 类型要当场抛：吞掉的话协议漂移无声，症状是转述少一段而不是报错',
	)
})

test('模板坏了不连坐台账工具：注册期只读配对表/形态表/阶段表，status 照常可用', () => {
	// 断的是「模板坏了 → 台账查询一起失败」这条连坐：台账记的是已经发生的批次，与出稿模板无关。
	// 对照组是 dispatch 工具——它出稿要用模板，模板坏了就该注册失败（缺了它不如缺席）
	const brokenData = join(root, 'data-broken')
	cpSync(DISPATCH_DATA_DIR, brokenData, { recursive: true })
	writeFileSync(join(brokenData, 'templates.json'), '{ 这不是 JSON')
	const batchCtx = ctxOf()
	registerDispatchBatch(batchCtx.ctx, { dispatchDataDir: brokenData, dispatchLedgerPath: ledger })
	assert.equal(batchCtx.registered.length, 1, '模板坏了，台账工具照样注册')
	assert.throws(() => registerDispatch(ctxOf().ctx, { dispatchDataDir: brokenData }), /dispatch 数据/, '对照组：dispatch 的出稿面真要用模板，坏了就该注册失败')
})
