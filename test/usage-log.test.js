/**
 * 使用日志的单测：事件构造（纯函数，含值级截断边界）、profile 归因键、白名单过滤、订阅落盘、
 * 手记工具的注册面与落盘形状。全部落临时根——真实家目录不参与测试。
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
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FIXTURES_DIR, tempRoot } from './helpers.js'
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

before(() => mock.timers.enable({ apis: ['Date'], now: AT }))
after(() => mock.timers.reset())

/** 当日文件里的事件行（文件不在＝空；坏行当场抛，别让解析失败伪装成空日志）。文件名取固定 AT
 * ——写侧被冻在同一时刻，读侧另取一次 now 会在跨零点读到空文件。 */
const readLines = (rootDir) => {
	const file = usageLogFile(rootDir, AT)
	if (!existsSync(file)) return []
	return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
}

/** 监听器与工具注册都收在闭包里，让订阅面能被直调（不经过真宿主）。profileContext 同时给出 home
 * 与 profile 名——后者是事件行的归因键（同机多 profile 并发写同一日文件时唯一的判别面）。 */
const stubCtx = (home, name = PROFILE) => {
	const handlers = new Map()
	const registered = []
	const warnings = []
	return {
		handlers,
		registered,
		warnings,
		ctx: {
			on: (event, handler) => handlers.set(event, handler),
			get: (service) => (service === 'profileContext' && home !== undefined ? { home, name } : undefined),
			logger: { warn: (message) => warnings.push(message) },
			tools: { register: (definition) => registered.push(definition) },
		},
	}
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
	assert.equal(usageProfile(stubCtx('x').ctx), PROFILE)
	assert.equal(usageProfile(stubCtx('x', null).ctx), null, '名字不是非空白串时记 null')
	assert.equal(usageProfile(stubCtx(undefined).ctx), null, 'profileContext 缺席（非 dsh profile 启动）记 null')
})

test('白名单过滤：名单内落盘、名单外忽略（handleToolResult 直调临时根）', (t) => {
	const root = tempRoot(t, 'usage-log-whitelist')
	const names = ['usage_note', 'memory']
	handleToolResult({ name: 'memory', callId: 'c1', arguments: { action: 'lint' } }, { isError: false, value: { ok: true } }, root, names, PROFILE)
	handleToolResult({ name: 'read', callId: 'c2', arguments: { path: 'a.md' } }, { isError: false, value: {} }, root, names, PROFILE)
	const lines = readLines(root)
	assert.equal(lines.length, 1, '名单外的宿主原生工具不落盘')
	assert.equal(lines[0].tool, 'memory')
	assert.equal(lines[0].callId, 'c1')
	assert.equal(lines[0].profile, PROFILE)
})

test('订阅落盘：经 profileContext 求根落临时根，名单内两次调用＋一次手记恰好三行', async (t) => {
	const root = tempRoot(t, 'usage-log-subscribe')
	const stub = stubCtx(root)
	const logDir = usageLogRoot(stub.ctx)
	subscribeUsageLog(stub.ctx, ['memory', 'usage_note'])
	const onResult = stub.handlers.get('tools/result')
	assert.equal(typeof onResult, 'function', '订阅须挂在 tools/result 上')
	onResult({ name: 'memory', callId: 'c1', arguments: { action: 'write' } }, { isError: false, value: { ok: true } })
	onResult({ name: 'pwsh', callId: 'c2', arguments: { command: 'ls' } }, { isError: false, value: {} })
	registerUsageNote(stub.ctx)
	await stub.registered[0].execute({ note: '手记：x 因为 y', tool: 'memory', ok: false })
	onResult({ name: 'usage_note', callId: 'c3', arguments: { note: '手记：x 因为 y' } }, { isError: false, value: { ok: true, file: usageLogFile(logDir, AT) } })
	const lines = readLines(logDir)
	assert.deepEqual(lines.map((line) => line.type), ['call', 'note', 'call'], 'usage_note 自身既落 call 行又落 note 行')
	assert.deepEqual(lines.map((line) => line.tool), ['memory', 'memory', 'usage_note'])
	assert.deepEqual(lines.map((line) => line.profile), [PROFILE, PROFILE, PROFILE], '三行的归因键都来自 profileContext.name')
	assert.deepEqual(stub.warnings, [])
})

test('手记工具注册面：参数三格、output.schema 两组、execute 落当日文件并回文件路径', async (t) => {
	const root = tempRoot(t, 'usage-log-note')
	const stub = stubCtx(root)
	const logDir = usageLogRoot(stub.ctx)
	registerUsageNote(stub.ctx)
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
	assert.deepEqual(value, { ok: true, file: usageLogFile(logDir, AT) })
	assert.match(tool.output.render({}, value)[0].text, /已记入手记/)
	const lines = readLines(logDir)
	assert.equal(lines.length, 1)
	assert.equal(lines[0].type, 'note')
	assert.equal(lines[0].tool, 'see_image')
	assert.equal(lines[0].ok, false)
	assert.equal(lines[0].profile, PROFILE)
	assert.equal(lines[0].note, '坑：x 因为 y')
})

test('旁路失败只经宿主 logger 显形：求根拿不到与订阅本身失败都不冒到调用链', () => {
	const noHome = stubCtx(undefined)
	subscribeUsageLog(noHome.ctx, ['memory'])
	const onResult = noHome.handlers.get('tools/result')
	assert.doesNotThrow(
		() => onResult({ name: 'memory', callId: 'c1', arguments: {} }, { isError: false, value: {} }),
		'监听器抛错不得冒回宿主调用链',
	)
	assert.equal(noHome.warnings.length, 1)
	assert.match(noHome.warnings[0], /使用日志写入失败/)

	const warnings = []
	assert.doesNotThrow(
		() => subscribeUsageLog({ get: () => undefined, logger: { warn: (message) => warnings.push(message) } }, ['memory']),
		'ctx.on 不在场时订阅失败也不得抛',
	)
	assert.equal(warnings.length, 1)
	assert.match(warnings[0], /使用日志订阅失败/)
})
