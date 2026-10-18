/**
 * 使用日志的单测：事件构造（纯函数，含值级截断边界）、profile 归因键、落点与分片口径、白名单
 * 过滤、订阅落盘、两机分片、机器段值域与缺席的三条处置、手记工具的注册面与落盘形状。落点全按
 * 记忆根推——真实家目录不参与测试。
 *
 * 进程时钟整个文件冻结在 AT：写侧（订阅监听器与手记 execute）自己取 new Date()、读侧按固定 AT
 * 对应的文件名找当日文件；不冻住就是「写侧取一次 now、读侧再取一次」，跨零点那一下读空报假红。
 * 只冻 Date、不碰 setTimeout，收尾 reset。
 *
 * recorder.js 零宿主依赖，静态 import；note.js 要 defineTool，裸仓装不上宿主包，故把
 * @deepseek-ai/dsh-tools 指到替身（与 dispatch-assembly 同款；node --test 每文件一进程，hooks
 * 不串到别的文件）。
 */
import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FIXTURES_DIR, tempRoot } from './helpers.js'
import { resolveLedgerPath } from '../lib/dispatch/batch.js'
import { DEFAULT_MEMORY_ROOT, resolveRoot } from '../lib/memory-root.js'
import {
	handleToolResult,
	subscribeUsageLog,
	usageCallEvent,
	usageLogFile,
	usageLogRoot,
	usageNoteEvent,
	usageProfile,
	NOTE_MAX_CHARS,
} from '../lib/usage-log/recorder.js'

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier !== '@deepseek-ai/dsh-tools') return nextResolve(specifier, context)
		return { url: pathToFileURL(join(FIXTURES_DIR, 'host-dsh-tools-stub.mjs')).href, shortCircuit: true, format: 'module' }
	},
})

const { registerUsageNote } = await import('../lib/usage-log/note.js')

const AT = new Date('2026-01-02T03:04:05.000Z')
const PROFILE = 'test-profile'
const MACHINE = 'home'

/** 分片基准＝本地日历日（刻意口径：复盘按「当天」读文件，跨零点读相邻两个；ts 才是 UTC）。
 * 期望名一律用本文件的本地分量现拼，不写死字面量——写死的话在 UTC-8 之类偏移下直接红。 */
const localDay = (at) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
const utcDay = (at) => at.toISOString().slice(0, 10)

/** 本地日与 UTC 日不同的时刻：按本机时区偏移现挑（偏移为正＝本地在前，取 UTC 深夜；为负＝本地
 * 在后，取 UTC 凌晨）。偏移为 0 的时区里两者恒等，那时这条判别力退化——由「文件名取本地分量」
 * 那句兜住，不假装还有第二层判别力。 */
const TZ_OFFSET_MINUTES = -new Date().getTimezoneOffset()
const LOCAL_EDGE_AT = new Date(Date.UTC(2026, 0, 2, TZ_OFFSET_MINUTES >= 0 ? 23 : 1, 0))

before(() => mock.timers.enable({ apis: ['Date'], now: AT }))
after(() => mock.timers.reset())

/** 当日文件里的事件行（文件不在＝空；坏行当场抛，别让解析失败伪装成空日志）。文件名取固定 AT
 * ——写侧被冻在同一时刻，读侧另取一次 now 会在跨零点读到空文件。
 *
 * machine 无默认值：写侧的机器段若被写死成某个字面量，读侧的默认参会跟着同一份假设，判别链两端
 * 同源——写错了也读得到、也就绿。每个读点显式给出它期望的机器段。 */
const readLines = (rootDir, machine) => {
	const file = usageLogFile(rootDir, AT, machine)
	if (!existsSync(file)) return []
	return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

/** 监听器与工具注册都收在闭包里，让订阅面能被直调（不经过真宿主）。profileContext 只给 profile 名
 * ——事件行的归因键；日志落点已不由宿主 home 决定，那一格不再需要。name 传 null 造「服务在但名字
 * 不是非空白串」，用 absentProfileCtx 造「服务整块缺席」。 */
const stubCtx = (name = PROFILE) => {
	const handlers = new Map()
	const registered = []
	const warnings = []
	return {
		handlers,
		registered,
		warnings,
		ctx: {
			on: (event, handler) => handlers.set(event, handler),
			get: (service) => (service === 'profileContext' ? { name } : undefined),
			logger: { warn: (message) => warnings.push(message) },
			tools: { register: (definition) => registered.push(definition) },
		},
	}
}

/** profileContext 整块缺席的上下文（非 dsh profile 启动）：stubCtx 的缺省参数会把 undefined 吃掉。 */
const absentProfileCtx = () => {
	const stub = stubCtx()
	stub.ctx.get = () => undefined
	return stub
}

test('调用行构造：值级截断落在字符边界，嵌套里的长串同样截', () => {
	const exec = {
		name: 'memory',
		callId: 'call-1',
		agent: { id: 'session-1' },
		arguments: {
			atLimit: 'a'.repeat(200),
			overLimit: 'b'.repeat(201),
			empty: '',
			nested: { deep: 'c'.repeat(201) },
			flagged: false,
		},
	}
	const event = usageCallEvent(exec, { isError: false, value: { ok: true, summary: 'd'.repeat(201) } }, AT, PROFILE)
	assert.equal(event.ts, '2026-01-02T03:04:05.000Z')
	assert.equal(event.type, 'call')
	assert.equal(event.tool, 'memory')
	assert.equal(event.callId, 'call-1')
	assert.equal(event.ok, true)
	assert.equal(event.agent, 'session-1', 'agent 只记标识')
	assert.equal(event.profile, PROFILE, 'profile 归因键取宿主 profileContext.name')
	assert.equal(event.args.atLimit, 'a'.repeat(200), '正好到上限整体保留')
	assert.deepEqual(event.args.overLimit, { len: 201, head: 'b'.repeat(200) })
	assert.equal(event.args.empty, '')
	assert.deepEqual(event.args.nested.deep, { len: 201, head: 'c'.repeat(200) }, '嵌套对象里的长串同样截')
	assert.equal(event.args.flagged, false, '非字符串值原样')
	assert.deepEqual(event.result, { value: { ok: true, summary: { len: 201, head: 'd'.repeat(200) } } })
	assert.ok(!('isError' in event.result), 'result 不带内层 isError——顶层 ok 就是同一个事实')
	assert.ok(!('error' in JSON.parse(JSON.stringify(event))), '成功行不出现 error 键')
})

test('调用行构造：失败行 error 整块 { message, info } 不截断，agent 缺席记 null', () => {
	const message = 'e'.repeat(400)
	const info = { kind: 'ToolArgsError', detail: 'f'.repeat(400) }
	const event = usageCallEvent(
		{ name: 'dispatch_plan', callId: 'call-2', arguments: {} },
		{ isError: true, error: { message, info } },
		AT,
		PROFILE,
	)
	assert.equal(event.ok, false)
	assert.equal(event.agent, null, '没有 agent 的调用记 null（agent 字段不判主/子）')
	assert.equal(event.profile, PROFILE)
	assert.deepEqual(event.error, { message, info }, '失败行 error 整块落：message 与结构化 info 都不截断')
	assert.deepEqual(
		JSON.parse(JSON.stringify(event)).error,
		{ message, info },
		'info 是宿主 ToolFailure 的机判失败类别，模型可见 content 不含它——日志是唯一的持久面',
	)
	assert.ok(!('isError' in event.result), 'result 只装产出摘要')
})

test('手记行构造：note 上限 500、tool 缺省 usage_note、ok 未给记 null', () => {
	const bare = usageNoteEvent({ note: '坑：x 因为 y' }, AT, PROFILE)
	assert.equal(bare.type, 'note')
	assert.equal(bare.tool, 'usage_note', '不针对某一件时缺省 usage_note')
	assert.equal(bare.ok, null, '没表态与 false 是两件事，中性手记不记成成功')
	assert.equal(bare.note, '坑：x 因为 y')
	assert.equal(bare.profile, PROFILE, '手记行同样带归因键')
	const tied = usageNoteEvent({ note: 'n'.repeat(501), tool: 'memory', ok: false }, AT, PROFILE)
	assert.equal(tied.tool, 'memory')
	assert.equal(tied.ok, false)
	assert.deepEqual(tied.note, { len: 501, head: 'n'.repeat(500) }, '手记上限 500，独立于值级 200')
	// 工具名直存、不过 summarize：登记名面最长 16 字符（dispatch_lessons），够不到值级上限
	const longest = 'dispatch_lessons'
	assert.equal(longest.length, 16)
	assert.equal(usageNoteEvent({ note: 'x', tool: longest }, AT, PROFILE).tool, longest, '工具名直存，不出现 { len, head } 形态')
})

test('profile 归因键：profileContext 给名字取该值，缺席或非串记 null（不猜）', () => {
	assert.equal(usageProfile(stubCtx().ctx), PROFILE)
	assert.equal(usageProfile(stubCtx(null).ctx), null, '名字不是非空白串时记 null')
	assert.equal(usageProfile(absentProfileCtx().ctx), null, 'profileContext 缺席（非 dsh profile 启动）记 null')
})

test('落点：日志目录＝store 数据域下的 usage-log，与台账同父目录、文件名带机器段', (t) => {
	const memoryRoot = tempRoot(t, 'usage-log-root')
	const store = resolveRoot(memoryRoot).store
	assert.equal(usageLogRoot(memoryRoot), join(store, 'data', 'usage-log'))
	const ledger = resolveLedgerPath({ configuredPath: '', memoryRoot })
	assert.equal(dirname(ledger), dirname(usageLogRoot(memoryRoot)), '台账与日志同父目录——复盘一处读齐两族的前提')
	// 文件名按本地日历日拼，不写死字面量：公司机与 CI 的时区不同，硬编码 '2026-01-02' 在
	// UTC-8 之类偏移下就是 1 月 1 日（复盘按「当天」读文件，这条口径必须是本地日）
	assert.equal(basename(usageLogFile(usageLogRoot(memoryRoot), AT, MACHINE)), `${localDay(AT)}.${MACHINE}.jsonl`, '文件名＝<本地日期>.<机器段>.jsonl')
})

test('分片口径：按本地日历日，不按 UTC（跨零点读相邻两个文件的前提）', () => {
	// 找一个「本地日 ≠ UTC 日」的时刻：只有这种时刻能分辨两种基准。时区偏移为 0 时两者恒等，
	// 那种环境下这条断言退化成同一条，剩余判别力由「文件名取本地分量」那句承担
	assert.equal(basename(usageLogFile('.', LOCAL_EDGE_AT, MACHINE)), `${localDay(LOCAL_EDGE_AT)}.${MACHINE}.jsonl`)
	if (localDay(LOCAL_EDGE_AT) !== utcDay(LOCAL_EDGE_AT)) {
		assert.notEqual(localDay(LOCAL_EDGE_AT), utcDay(LOCAL_EDGE_AT))
		assert.ok(!basename(usageLogFile('.', LOCAL_EDGE_AT, MACHINE)).startsWith(utcDay(LOCAL_EDGE_AT)), '写成 UTC 日期就在这条上翻红')
	}
})

test('记忆根缺席：沿用 resolveRoot 的默认根（落默认根下的 store，不进任何 git 仓）', () => {
	// 只断言路径归一，不真写：默认根是本机真实家目录，用例往里落文件就成了别人的残留
	assert.equal(usageLogRoot(undefined), join(resolveRoot(DEFAULT_MEMORY_ROOT).store, 'data', 'usage-log'), '空记忆根取默认根而不是进程 cwd（与台账同款行为）')
})

test('白名单过滤：名单内落盘、名单外忽略（handleToolResult 直调临时根）', (t) => {
	const root = tempRoot(t, 'usage-log-whitelist')
	const names = ['usage_note', 'memory']
	handleToolResult({ name: 'memory', callId: 'c1', arguments: { action: 'lint' } }, { isError: false, value: { ok: true } }, root, names, PROFILE, MACHINE)
	handleToolResult({ name: 'read', callId: 'c2', arguments: { path: 'a.md' } }, { isError: false, value: {} }, root, names, PROFILE, MACHINE)
	const lines = readLines(root, MACHINE)
	assert.equal(lines.length, 1, '名单外的宿主原生工具不落盘')
	assert.equal(lines[0].tool, 'memory')
	assert.equal(lines[0].callId, 'c1')
	assert.equal(lines[0].profile, PROFILE)
})

test('订阅落盘：按订阅期的记忆根与机器名落盘，名单内两次调用＋一次手记恰好三行', async (t) => {
	const memoryRoot = tempRoot(t, 'usage-log-subscribe')
	const stub = stubCtx()
	const logDir = usageLogRoot(memoryRoot)
	subscribeUsageLog(stub.ctx, ['memory', 'usage_note'], { memoryRoot, machine: MACHINE })
	const onResult = stub.handlers.get('tools/result')
	assert.equal(typeof onResult, 'function', '订阅须挂在 tools/result 上')
	onResult({ name: 'memory', callId: 'c1', arguments: { action: 'write' } }, { isError: false, value: { ok: true } })
	onResult({ name: 'pwsh', callId: 'c2', arguments: { command: 'ls' } }, { isError: false, value: {} })
	registerUsageNote(stub.ctx, { memoryRoot, machine: MACHINE })
	await stub.registered[0].execute({ note: '手记：x 因为 y', tool: 'memory', ok: false })
	onResult({ name: 'usage_note', callId: 'c3', arguments: { note: '手记：x 因为 y' } }, { isError: false, value: { ok: true, file: usageLogFile(logDir, AT, MACHINE) } })
	const lines = readLines(logDir, MACHINE)
	assert.deepEqual(lines.map((line) => line.type), ['call', 'note', 'call'], 'usage_note 自身既落 call 行又落 note 行')
	assert.deepEqual(lines.map((line) => line.tool), ['memory', 'memory', 'usage_note'])
	assert.deepEqual(lines.map((line) => line.profile), [PROFILE, PROFILE, PROFILE], '三行的归因键都来自 profileContext.name')
	assert.deepEqual(stub.warnings, [])
})

test('两机分片：同一份目录下两个机器段各写各的文件、互不覆盖', (t) => {
	const memoryRoot = tempRoot(t, 'usage-log-two-machines')
	const logDir = usageLogRoot(memoryRoot)
	// 两个订阅各代表一台机器：同一 memoryRoot、不同 machine
	for (const [machine, callId] of [['home', 'c-home'], ['work', 'c-work']]) {
		const stub = stubCtx()
		subscribeUsageLog(stub.ctx, ['memory'], { memoryRoot, machine })
		stub.handlers.get('tools/result')({ name: 'memory', callId, arguments: {} }, { isError: false, value: {} })
	}
	// 两侧各恰好一行、且各只装自己那条：机器段若被忽略（两机落同一个文件），那一份会是两行，
	// 只断言「另一台没有多余行」分不出这件事——必须两边都核行数与内容
	const homeLines = readLines(logDir, 'home')
	const workLines = readLines(logDir, 'work')
	assert.equal(homeLines.length, 1, 'home 那一份恰好一行')
	assert.equal(workLines.length, 1, 'work 那一份恰好一行')
	assert.equal(homeLines[0].callId, 'c-home', 'home 的文件里只有 home 的调用')
	assert.equal(workLines[0].callId, 'c-work', 'work 的文件里只有 work 的调用')
	assert.notEqual(usageLogFile(logDir, AT, 'home'), usageLogFile(logDir, AT, 'work'), '机器段不同＝文件名不同')
})

test('机器段值域：非 MACHINE_ID_RE 的值当场抛，且不落任何文件', async (t) => {
	const memoryRoot = tempRoot(t, 'usage-log-bad-machine')
	const logDir = usageLogRoot(memoryRoot)
	// 每一档在值域外的理由不同：穿越（`..`）、建子目录（分隔符）、大小写（Windows 上与真机名同文件）、
	// 空格（路径里合法但段值不合法）、保留字（与共享段同名的第三类值）
	for (const machine of ['a/../../../../escape', 'a/b', '../esc', 'Bad Name', 'HOME', 'shared', '', '  ']) {
		const stub = stubCtx()
		registerUsageNote(stub.ctx, { memoryRoot, machine })
		await assert.rejects(
			async () => stub.registered[0].execute({ note: '坑：x' }),
			/machine/,
			`machine=${JSON.stringify(machine)} 须被值域拦下（穿出目录／静默建子目录／与真机名撞文件）`,
		)
	}
	assert.equal(existsSync(logDir), false, '拦在落盘之前，不留半截文件或空的子目录')
	// 订阅侧同一份判据：不合格不挂监听器、一条 warn（不兜底、不 sanitize）
	const stub = stubCtx()
	subscribeUsageLog(stub.ctx, ['memory'], { memoryRoot, machine: 'a/b' })
	assert.equal(stub.handlers.size, 0, '值域不合格时不挂监听器')
	assert.equal(stub.warnings.length, 1)
	assert.equal(existsSync(logDir), false)
})

test('机器名缺席：订阅侧不挂监听器、只 warn 一条（不造第三种机器段值）', (t) => {
	const memoryRoot = tempRoot(t, 'usage-log-no-machine')
	const stub = stubCtx()
	const logDir = usageLogRoot(memoryRoot)
	subscribeUsageLog(stub.ctx, ['memory'], { memoryRoot })
	// 告警在挂监听器之前就发：整场不调本包工具也要看得见配置坏了（留到第一条事件再判＝零可见）
	assert.equal(stub.handlers.size, 0, '机器名缺席时压根不订阅')
	assert.equal(stub.warnings.length, 1, '订阅期判一次就够，整场值不会变，故只有一条')
	assert.match(stub.warnings[0], /machine/)
	assert.match(stub.warnings[0], /不记使用日志/)
	assert.equal(existsSync(logDir), false, '一条都不记，连目录都不建')
})

test('手记工具注册面：参数三格、output.schema 两组、execute 落当日文件并回文件路径', async (t) => {
	const memoryRoot = tempRoot(t, 'usage-log-note')
	const stub = stubCtx()
	const logDir = usageLogRoot(memoryRoot)
	registerUsageNote(stub.ctx, { memoryRoot, machine: MACHINE })
	assert.equal(stub.registered.length, 1, '注册且只注册一件')
	const tool = stub.registered[0]
	assert.equal(tool.name, 'usage_note')
	assert.deepEqual(Object.keys(tool.parameters), ['note', 'tool', 'ok'])
	assert.equal(tool.parameters.note.required, true, 'note 必填')
	assert.ok(
		tool.parameters.note.description.includes(String(NOTE_MAX_CHARS)),
		'参数描述里的上限按 NOTE_MAX_CHARS 单源渲染（这里是手抄的数字，常数一改描述就与截断行为分家）',
	)
	assert.deepEqual(Object.keys(tool.output.schema.properties), ['ok', 'file'])
	assert.equal(tool.output.schema.additionalProperties, false, '输出 schema 顶层闭集')
	assert.equal(typeof tool.output.render, 'function', '宿主 defineTool 强制 output.render 在场，漏了整件工具注册失败')
	const value = await tool.execute({ note: '坑：x 因为 y', tool: 'see_image', ok: false })
	assert.deepEqual(value, { ok: true, file: usageLogFile(logDir, AT, MACHINE) })
	assert.match(tool.output.render({}, value)[0].text, /已记入手记/)
	const lines = readLines(logDir, MACHINE)
	assert.equal(lines.length, 1)
	assert.equal(lines[0].type, 'note')
	assert.equal(lines[0].tool, 'see_image')
	assert.equal(lines[0].ok, false)
	assert.equal(lines[0].profile, PROFILE)
	assert.equal(lines[0].note, '坑：x 因为 y')
})

test('机器名不合格：手记当场抛（显式请求不许被静默成「记下了」）', async (t) => {
	const memoryRoot = tempRoot(t, 'usage-log-note-no-machine')
	for (const machine of [undefined, '', '  ']) {
		const stub = stubCtx()
		registerUsageNote(stub.ctx, { memoryRoot, machine })
		await assert.rejects(
			async () => stub.registered[0].execute({ note: '坑：x' }),
			/machine/,
			`machine=${JSON.stringify(machine)} 时 execute 须抛（与 recorder 的旁路 fail soft 相反的处置）`,
		)
	}
	// config 整个没传同样不许静默成功：注册期不抛（去掉 `= {}` 会经 apply 的 try 吞成工具消失），
	// 但 execute 侧必须让调用方看见
	const bare = stubCtx()
	registerUsageNote(bare.ctx)
	await assert.rejects(async () => bare.registered[0].execute({ note: '坑：x' }), /machine/, 'config 缺席时 execute 同样须抛')
	assert.equal(existsSync(usageLogRoot(memoryRoot)), false, '抛错与「没落盘」同在一处，不留半截文件')
})

test('旁路失败只经宿主 logger 显形：写入失败与订阅本身失败都不冒到调用链', (t) => {
	// 写失败用「store 被一个同名文件占住」造：mkdir 在文件底下建目录必炸，与盘满／权限同一类
	const memoryRoot = tempRoot(t, 'usage-log-write-fail')
	writeFileSync(join(memoryRoot, 'memory'), 'not a directory')
	const failing = stubCtx()
	subscribeUsageLog(failing.ctx, ['memory'], { memoryRoot, machine: MACHINE })
	const onResult = failing.handlers.get('tools/result')
	assert.doesNotThrow(
		() => onResult({ name: 'memory', callId: 'c1', arguments: {} }, { isError: false, value: {} }),
		'监听器抛错不得冒回宿主调用链',
	)
	assert.equal(failing.warnings.length, 1)
	assert.match(failing.warnings[0], /使用日志写入失败/)

	// 订阅本身失败：ctx.on 不在场。参数照真实装配形状给全，否则会先撞上「机器名不合格」那条分支
	const warnings = []
	assert.doesNotThrow(
		() => subscribeUsageLog({ get: () => undefined, logger: { warn: (message) => warnings.push(message) } }, ['memory'], { memoryRoot, machine: MACHINE }),
		'ctx.on 不在场时订阅失败也不得抛',
	)
	assert.equal(warnings.length, 1)
	assert.match(warnings[0], /使用日志订阅失败/)
	// options 传 null 同样不许抛：这一句在 apply 的逐工具 try 之外，抛出去＝整包九件都不注册
	const broken = stubCtx()
	assert.doesNotThrow(() => subscribeUsageLog(broken.ctx, ['memory'], null), 'options 为 null 不得抛')
	assert.equal(broken.warnings.length, 1)
	assert.match(broken.warnings[0], /使用日志订阅失败/)
})
