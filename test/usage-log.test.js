/**
 * 使用日志的单测：事件构造两态（成功瘦行只留参数键集与耗时、失败胖行保留 args 与 error）、
 * 值级截断边界、profile 归因键、落点与分片口径、14 天轮转（判龄看档名日期不看 mtime、只删已
 * 提交到 HEAD 的档、写入与注册两处都清）、at 必传校验、白名单过滤、订阅落盘与耗时起收表、两机
 * 分片、机器段值域与缺席的三条处置、手记工具的注册面与落盘形状。落点全按记忆根推——真实家目录
 * 不参与测试。轮转夹具是真 git 仓：删除资格就是「在 HEAD 里且工作区一致」。
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
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FIXTURES_DIR, tempRoot } from './helpers.js'
import { resolveLedgerPath } from '../lib/dispatch/batch.js'
import { DEFAULT_MEMORY_ROOT, resolveRoot } from '../lib/memory-root.js'
import {
	appendUsageLine,
	handleToolResult,
	pruneUsageLog,
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

/** 相对 AT 的日档名（轮转夹具）：offset 是本地日历日偏移，按本地分量现拼——写死字面量在别的时区
 * 会造出「名字里是 15 天前、实际算下来是 14 天」的夹具，用例就失去判别力。 */
const dayFileName = (offset, machine = MACHINE) => {
	const day = new Date(AT.getFullYear(), AT.getMonth(), AT.getDate() + offset)
	return `${localDay(day)}.${machine}.jsonl`
}

/** 本地日与 UTC 日不同的时刻：按本机时区偏移现挑（偏移为正＝本地在前，取 UTC 深夜；为负＝本地
 * 在后，取 UTC 凌晨）。偏移为 0 的时区里两者恒等，那时这条判别力退化——由「文件名取本地分量」
 * 那句兜住，不假装还有第二层判别力。 */
const TZ_OFFSET_MINUTES = -new Date().getTimezoneOffset()
const LOCAL_EDGE_AT = new Date(Date.UTC(2026, 0, 2, TZ_OFFSET_MINUTES >= 0 ? 23 : 1, 0))

/** 直接起 git：轮转的删除资格（在 HEAD 里且工作区一致）只能拿真仓验，替身证明不了 git 判定本身。 */
const git = (root, ...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })

/** 轮转夹具根＝已初始化的空仓。身份与签名在仓内写死：公司机／CI 的全局 git 配置不同，夹具红得
 * 莫名其妙时会先去怀疑产品代码。 */
const gitRoot = (t, label) => {
	const root = tempRoot(t, label)
	mkdirSync(root, { recursive: true })
	assert.equal(git(root, 'init', '-q').status, 0, '夹具仓建不起来，后面的轮转断言就没有意义')
	git(root, 'config', 'user.email', 'test@example.com')
	git(root, 'config', 'user.name', 'test')
	return root
}

/** 把当前夹具全部提交：这是「档可以被轮转」的前提，不是用例的点缀。 */
const commitAll = (root, message = 'fixture') => {
	assert.equal(git(root, 'add', '-A').status, 0)
	const result = git(root, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message)
	assert.equal(result.status, 0, `夹具提交失败：${result.stderr}`)
}

/** 捕获 console.warn：轮转跳过超龄档时没有 logger 面，这一条是「没删」唯一的显形处。 */
const captureConsoleWarn = (t) => {
	const warnings = []
	t.mock.method(console, 'warn', (message) => warnings.push(message))
	return warnings
}

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

test('成功调用行：字段集固定为瘦行，只留参数键集与耗时，参数值与结果摘要都不落', () => {
	const content = 'y'.repeat(5000)
	const exec = {
		name: 'memory',
		callId: 'call-1',
		agent: { id: 'session-1' },
		arguments: { action: 'write', content, scope: 'shared' },
	}
	const event = usageCallEvent(exec, { isError: false, value: { ok: true, summary: 'z'.repeat(500) } }, AT, PROFILE, 12)
	assert.deepEqual(
		Object.keys(event),
		['ts', 'type', 'tool', 'callId', 'ok', 'agent', 'profile', 'argKeys', 'ms'],
		'成功行字段集就是读侧契约：多出 args/result/error 任何一格都算胖回去',
	)
	assert.equal(event.ts, '2026-01-02T03:04:05.000Z')
	assert.equal(event.type, 'call')
	assert.equal(event.tool, 'memory')
	assert.equal(event.callId, 'call-1')
	assert.equal(event.ok, true)
	assert.equal(event.agent, 'session-1', 'agent 只记标识')
	assert.equal(event.profile, PROFILE, 'profile 归因键取宿主 profileContext.name')
	assert.deepEqual(event.argKeys, ['action', 'content', 'scope'], '只记键名，顺序随参数对象')
	assert.equal(event.ms, 12, 'ms 由订阅侧测量后传入')
	const line = JSON.stringify(event)
	assert.ok(line.length < 300, `成功行应有界（实得 ${line.length} 字符）——memory 写条目的几千字正文不进日志`)
	assert.ok(!line.includes(content.slice(0, 50)), '参数值不落盘')
	assert.ok(!line.includes('z'.repeat(50)), '结果摘要同样不落成功行')
	assert.ok(!('args' in event) && !('result' in event) && !('error' in event), '瘦行不出现胖行的三格')
	assert.equal(
		usageCallEvent(exec, { isError: false, value: {} }, AT, PROFILE).ms,
		null,
		'没测到耗时记 null 而不是 0——「0 毫秒」与「没测到」是两件事',
	)
	assert.equal(
		usageCallEvent({ name: 'memory', callId: 'call-null', arguments: null }, { isError: false, value: {} }, AT, PROFILE, 1).argKeys,
		null,
		'参数不是普通对象（schema 允许数组/标量）时键集记 null，不兜成空数组',
	)
})

test('失败调用行：保持既有全量形态——args 值级摘要与 error 整块都在，不混入瘦行字段', () => {
	const message = 'e'.repeat(400)
	const info = { kind: 'ToolArgsError', detail: 'f'.repeat(400) }
	const body = 'x'.repeat(500)
	const args = { batch: 'usage-log', diffLines: 3, body, nested: { deep: 'c'.repeat(201) } }
	const event = usageCallEvent(
		{ name: 'dispatch_batch', callId: 'call-2', arguments: args },
		{ isError: true, error: { message, info } },
		AT,
		PROFILE,
		999,
	)
	assert.equal(event.ok, false)
	assert.equal(event.agent, null, '没有 agent 的调用记 null（agent 字段不判主/子）')
	assert.equal(event.profile, PROFILE)
	assert.equal(event.args.batch, 'usage-log', '失败行的普通参数值原样保留')
	assert.equal(event.args.diffLines, 3)
	assert.deepEqual(event.args.body, { len: 500, head: 'x'.repeat(200) }, '失败行保留 args 值级摘要（复盘靠它复现调错现场）')
	assert.deepEqual(event.args.nested.deep, { len: 201, head: 'c'.repeat(200) }, '嵌套里的长串同样截')
	assert.deepEqual(event.result, { value: undefined }, '失败行仍带 result 格（当前形态）')
	assert.deepEqual(event.error, { message, info }, '失败行 error 整块落：message 与结构化 info 都不截断')
	assert.deepEqual(
		JSON.parse(JSON.stringify(event)).error,
		{ message, info },
		'info 是宿主 ToolFailure 的机判失败类别，模型可见 content 不含它——日志是唯一的持久面',
	)
	assert.ok(!('isError' in event.result), 'result 只装产出摘要')
	assert.ok(!('argKeys' in event) && !('ms' in event), '失败行是既有形态原样，不混入瘦行的 argKeys/ms')
})

test('值级截断边界：正好 200 原样、空串与非串原样、201 才截', () => {
	// 边界写成字面上的 200：VALUE_MAX_CHARS 改动时这条要跟着一起被看见，不能两处同源改完仍绿
	const exact = 'a'.repeat(200)
	const event = usageCallEvent(
		{ name: 'memory', callId: 'c-boundary', arguments: { exact, empty: '', zero: 0, flag: false, nil: null, over: 'b'.repeat(201) } },
		{ isError: true, error: { message: 'boom' } },
		AT,
		PROFILE,
	)
	assert.equal(event.args.exact, exact, '正好等于上限不截——边界是「超过」而不是「达到」')
	assert.equal(event.args.empty, '', '空串原样')
	assert.equal(event.args.zero, 0, '非串原样：数字')
	assert.equal(event.args.flag, false, '非串原样：布尔')
	assert.equal(event.args.nil, null, '非串原样：null')
	assert.deepEqual(event.args.over, { len: 201, head: 'b'.repeat(200) }, '超过上限一个字符就截')
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
	// 工具名直存、不过 summarize：dispatch_batch 是登记名面最长的一个，够不到值级上限
	const longest = 'dispatch_batch'
	assert.equal(longest.length, 14)
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

test('轮转判据：只看档名里的日期（mtime 不参与）、14 天边界保留、不认识的档名不碰', (t) => {
	const root = gitRoot(t, 'usage-log-prune')
	// 夹具的 mtime 全是「现在」——clone/checkout 出来的仓也是这个样子：判龄若看 mtime，
	// 新克隆一次就会把整个旧历史当成过期档清空
	const names = [dayFileName(-15), dayFileName(-14), dayFileName(0), dayFileName(3, 'work')]
	for (const name of names) writeFileSync(join(root, name), '{"fixture":true}\n')
	const keep = ['notes.txt', '2026-02-30.home.jsonl', `${dayFileName(-15)}.bak`, dayFileName(-15, 'shared')]
	for (const name of keep) writeFileSync(join(root, name), 'not a day file\n')
	// 删除资格＝已提交到 HEAD：夹具得先真的提交，否则删的是唯一一份（见下一条用例）
	commitAll(root)
	const removed = pruneUsageLog(root, AT)
	assert.deepEqual(removed, [dayFileName(-15)], '只删超过 14 天的日档，删掉谁要看得见')
	const left = readdirSync(root)
	assert.ok(!left.includes(dayFileName(-15)), '15 天前的旧日档被清')
	assert.ok(left.includes(dayFileName(-14)), '正好 14 天前在窗口内，保留')
	assert.ok(left.includes(dayFileName(0)), '当日档不动')
	assert.ok(left.includes(dayFileName(3, 'work')), '未来日期与别的机器段都不动（时钟回拨/时区差异造得出来）')
	for (const name of keep) assert.ok(left.includes(name), `不认识的档名「${name}」不碰`)
	// 目录还不存在时没有旧档可清，不是错误（日志目录是首次写入才递归建的）
	assert.deepEqual(pruneUsageLog(join(root, 'absent'), AT), [])
})

test('轮转的删除资格：untracked／有未提交改动／非 git 目录的超龄档都不删，各 warn 一条', (t) => {
	const warnings = captureConsoleWarn(t)
	// ① 仓里但没提交（untracked）：删了就是不可恢复
	const repo = gitRoot(t, 'usage-log-prune-untracked')
	writeFileSync(join(repo, dayFileName(-15)), '{"fixture":true}\n')
	assert.deepEqual(pruneUsageLog(repo, AT), [], 'untracked 的超龄档不删')
	assert.ok(existsSync(join(repo, dayFileName(-15))), '文件还在盘上')
	assert.equal(warnings.length, 1, '跳过要可见：不静默')
	assert.match(warnings[0], /未删除/)
	assert.match(warnings[0], new RegExp(dayFileName(-15)))

	// ② 已提交，但工作区与 HEAD 不一致：删了连当前那一版也没了
	const dirty = gitRoot(t, 'usage-log-prune-dirty')
	const dirtyName = dayFileName(-20)
	writeFileSync(join(dirty, dirtyName), '{"fixture":true}\n')
	commitAll(dirty)
	writeFileSync(join(dirty, dirtyName), '{"edited":true}\n')
	assert.deepEqual(pruneUsageLog(dirty, AT), [], '有未提交改动的超龄档不删')
	assert.ok(existsSync(join(dirty, dirtyName)))
	assert.equal(warnings.length, 2)

	// ③ 根本不在 git 仓内（记忆根取默认根时日志不进任何仓的既有口径）
	const plain = tempRoot(t, 'usage-log-prune-no-git')
	mkdirSync(plain, { recursive: true })
	writeFileSync(join(plain, dayFileName(-15)), '{"fixture":true}\n')
	assert.deepEqual(pruneUsageLog(plain, AT), [], '非 git 目录里的超龄档不删')
	assert.ok(existsSync(join(plain, dayFileName(-15))))
	assert.equal(warnings.length, 3)
})

test('漏传 at 当场抛：appendUsageLine 与 pruneUsageLog 都在入口校验，且不落半行/不误删', (t) => {
	const root = gitRoot(t, 'usage-log-require-at')
	const old = join(root, dayFileName(-20))
	writeFileSync(old, '{"fixture":true}\n')
	commitAll(root)
	// 没有校验时 NaN 参与的比较恒为 false：轮转「一个都不删」却毫无声息——同样不可接受
	assert.throws(() => pruneUsageLog(root, undefined), TypeError, 'prune 入口校验 at')
	assert.throws(() => pruneUsageLog(root, new Date(Number.NaN)), TypeError, '非法 Date 同样拦下')
	assert.ok(existsSync(old), '校验落在删除之前：非法 at 一个档都不删')
	const todayFile = usageLogFile(root, AT, MACHINE)
	assert.throws(() => appendUsageLine(todayFile, { type: 'call' }), TypeError, '写入缝漏传 at 当场抛（catch 只吞轮转的 IO 失败）')
	assert.equal(existsSync(todayFile), false, '校验发生在 mkdir/append 之前，不留半行文件')
})

test('轮转发生在写入时：成功调用落盘顺手清窗口外的日档', (t) => {
	const root = gitRoot(t, 'usage-log-rotate-write')
	writeFileSync(join(root, dayFileName(-15)), '{"fixture":true}\n')
	writeFileSync(join(root, dayFileName(-14)), '{"fixture":true}\n')
	commitAll(root)
	handleToolResult(
		{ name: 'memory', callId: 'c1', arguments: { action: 'lint' } },
		{ isError: false, value: { ok: true } },
		{ rootDir: root, toolNames: ['memory'], profile: PROFILE, machine: MACHINE, ms: 5 },
	)
	assert.ok(!existsSync(join(root, dayFileName(-15))), '写入这一趟就把 15 天前的档清掉')
	assert.ok(existsSync(join(root, dayFileName(-14))), '窗口内的档随写入一起留下')
	assert.equal(readLines(root, MACHINE).length, 1, '当日档照常追加一行')
})

test('轮转发生在注册时：隔很久才开机的机器不必等第一次工具调用才收旧档', (t) => {
	const memoryRoot = gitRoot(t, 'usage-log-rotate-subscribe')
	const logDir = usageLogRoot(memoryRoot)
	mkdirSync(logDir, { recursive: true })
	writeFileSync(join(logDir, dayFileName(-15)), '{"fixture":true}\n')
	writeFileSync(join(logDir, dayFileName(-2)), '{"fixture":true}\n')
	commitAll(memoryRoot)
	const stub = stubCtx()
	subscribeUsageLog(stub.ctx, ['memory'], { memoryRoot, machine: MACHINE })
	assert.ok(!existsSync(join(logDir, dayFileName(-15))), '订阅时就清掉窗口外的旧档')
	assert.ok(existsSync(join(logDir, dayFileName(-2))), '窗口内的档保留')
	assert.deepEqual(stub.warnings, [], '轮转是维护动作，清成功不告警')
})

test('白名单过滤：名单内落盘、名单外忽略（handleToolResult 直调临时根）', (t) => {
	const root = tempRoot(t, 'usage-log-whitelist')
	const names = ['usage_note', 'memory']
	const options = { rootDir: root, toolNames: names, profile: PROFILE, machine: MACHINE, ms: 3 }
	handleToolResult({ name: 'memory', callId: 'c1', arguments: { action: 'lint' } }, { isError: false, value: { ok: true } }, options)
	handleToolResult({ name: 'read', callId: 'c2', arguments: { path: 'a.md' } }, { isError: false, value: {} }, options)
	const lines = readLines(root, MACHINE)
	assert.equal(lines.length, 1, '名单外的宿主原生工具不落盘')
	assert.equal(lines[0].tool, 'memory')
	assert.equal(lines[0].callId, 'c1')
	assert.equal(lines[0].profile, PROFILE)
	assert.deepEqual(lines[0].argKeys, ['action'], '直调缝同样只落参数键集')
	assert.equal(lines[0].ms, 3, '直调缝把调用方测好的耗时原样带进事件')
})

test('订阅落盘：按订阅期的记忆根与机器名落盘，名单内两次调用＋一次手记恰好三行', async (t) => {
	const memoryRoot = tempRoot(t, 'usage-log-subscribe')
	const stub = stubCtx()
	const logDir = usageLogRoot(memoryRoot)
	subscribeUsageLog(stub.ctx, ['memory', 'usage_note'], { memoryRoot, machine: MACHINE })
	const onExecute = stub.handlers.get('tools/execute')
	assert.equal(typeof onExecute, 'function', '计时须挂在 tools/execute 上（tools/result 拿不到开始时刻，ms 只能起收表）')
	const onResult = stub.handlers.get('tools/result')
	assert.equal(typeof onResult, 'function', '订阅须挂在 tools/result 上')
	// cordis waterfall：监听器不调 next() / 不把 next() 的返回值透传，就是否决整条工具执行链。
	// 计时是旁路，接线一错（return undefined）会在真宿主里静默否决所有工具调用——这条断言就是那根线
	const sentinel = { toolCalled: true }
	const execTiming = { name: 'memory', callId: 'c-timing', arguments: {} }
	assert.equal(onExecute(execTiming, () => sentinel), sentinel, '监听器须把 next() 的返回值原样透传')
	// tools/execute 与 tools/result 交来的是同一个执行对象（宿主冻结后原样转交）：计时表按对象取回
	const exec1 = { name: 'memory', callId: 'c1', arguments: { action: 'write', content: 'x'.repeat(1000) } }
	onExecute(exec1, () => Promise.resolve())
	onResult(exec1, { isError: false, value: { ok: true } })
	const exec2 = { name: 'pwsh', callId: 'c2', arguments: { command: 'ls' } }
	onExecute(exec2, () => Promise.resolve())
	onResult(exec2, { isError: false, value: {} })
	registerUsageNote(stub.ctx, { memoryRoot, machine: MACHINE })
	await stub.registered[0].execute({ note: '手记：x 因为 y', tool: 'memory', ok: false })
	const exec3 = { name: 'usage_note', callId: 'c3', arguments: { note: '手记：x 因为 y' } }
	onExecute(exec3, () => Promise.resolve())
	onResult(exec3, { isError: false, value: { ok: true, file: usageLogFile(logDir, AT, MACHINE) } })
	const lines = readLines(logDir, MACHINE)
	assert.deepEqual(lines.map((line) => line.type), ['call', 'note', 'call'], 'usage_note 自身既落 call 行又落 note 行')
	assert.deepEqual(lines.map((line) => line.tool), ['memory', 'memory', 'usage_note'])
	assert.deepEqual(lines.map((line) => line.profile), [PROFILE, PROFILE, PROFILE], '三行的归因键都来自 profileContext.name')
	const [call1, , call3] = lines
	assert.deepEqual(call1.argKeys, ['action', 'content'], '成功行只有参数名——1000 字正文不进日志')
	assert.equal(typeof call1.ms, 'number', '起表后收表，ms 是数字（冻住 Date 不影响 performance.now 的真实耗时）')
	assert.ok(!('args' in call1) && !('result' in call1), '成功行不带参数值与结果摘要')
	assert.deepEqual(call3.argKeys, ['note'], '手记工具自身的调用行同样瘦，手记正文只在 note 行')
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
	// store 被同名文件占住时两处都够不着目录：注册期轮转一条（读不到目录）、写入一条——都只经
	// logger，都不许冒回调用链；两条各自点名自己的动作，读日志的人分得清是哪一步不顺利
	assert.equal(failing.warnings.length, 2)
	assert.match(failing.warnings[0], /旧日档清理失败/)
	assert.match(failing.warnings[1], /使用日志写入失败/)

	// 订阅本身失败：ctx.on 不在场。参数照真实装配形状给全，否则会先撞上「机器名不合格」那条分支
	const warnings = []
	assert.doesNotThrow(
		() => subscribeUsageLog({ get: () => undefined, logger: { warn: (message) => warnings.push(message) } }, ['memory'], { memoryRoot, machine: MACHINE }),
		'ctx.on 不在场时订阅失败也不得抛',
	)
	assert.equal(warnings.length, 1)
	assert.match(warnings[0], /使用日志订阅失败/)
	// options 传 null 同样不许抛：这一句在 apply 的逐工具 try 之外，抛出去＝整包五件都不注册
	const broken = stubCtx()
	assert.doesNotThrow(() => subscribeUsageLog(broken.ctx, ['memory'], null), 'options 为 null 不得抛')
	assert.equal(broken.warnings.length, 1)
	assert.match(broken.warnings[0], /使用日志订阅失败/)
})
