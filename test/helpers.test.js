/**
 * 夹具自身的单测（node:test，零宿主依赖）：共用件一旦自己漂了，它服务的那二十几个文件会一起
 * 在与被测对象无关的原因上红，而症状（某个用例读不到目录、事件少一个字段）指向的是夹具不是
 * 生产。所以夹具也守自己那份契约：事件与生产构造器同形、临时根两种时序都活到该活的那一刻、
 * 守卫当场抛、拷贝逐字节相等。
 *
 * 这里刻意**不**断言「夹具照抄了生产」的字面全文，只断言两件事：键集恒等（生产加字段即红），
 * 以及生产构造器自己那份的缺省形态。前者是漂移的信号，后者是夹具敢自己造事件的前提。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { advanceEvent, startEvent } from '../lib/dispatch/batch.js'
import {
	DISPATCH_DATA_DIR,
	DISPATCH_DATA_FILES,
	copyDataFiles,
	isoClock,
	makeEvent,
	memoryTree,
	removeTempRoot,
	requireTestContext,
	seedLedger,
	tempRoot,
	withTempDir,
} from './helpers.js'

const keysOf = (value) => Object.keys(value).sort()

/** 两份夹具各自内部是否仍然严格递增（各造两条，比第 2 条比第 1 条晚）。 */
const isoClockIsLater = (fixture, event) => Date.parse(fixture.advance({ batch: 'b' }).t) > Date.parse(event.t)

test('事件夹具与生产构造器同形：两个构造器的键集恒等（生产加字段即红，不必等某条用例莫名其妙地红）', () => {
	const fixture = makeEvent()
	const started = fixture.start('b1', '纯后端管线批')
	const advanced = fixture.advance({ batch: 'b1', stage: '门一' })
	const realStart = startEvent({ batch: 'b1', batchType: '纯后端管线批', intent: '意图', rules: 'a1b2c3d4', now: new Date(Date.UTC(2026, 0, 1)) })
	const realAdvance = advanceEvent({ batch: 'b1', stage: '门一', rules: 'a1b2c3d4', now: new Date(Date.UTC(2026, 0, 1)) })
	// 键集恒等而不是逐字相等：t 是各家的时钟，值必然不同，逐字比会逼夹具去抄生产的时钟口径
	assert.deepEqual(keysOf(started), keysOf(realStart), `start 事件键集漂了：夹具 ${JSON.stringify(keysOf(started))} vs 生产 ${JSON.stringify(keysOf(realStart))}`)
	assert.deepEqual(keysOf(advanced), keysOf(realAdvance), `advance 事件键集漂了：夹具 ${JSON.stringify(keysOf(advanced))} vs 生产 ${JSON.stringify(keysOf(realAdvance))}`)
	// action 是读侧 fold 的分派键，两边不一致的话夹具造的那份在任何 fold 里都读不出来
	assert.equal(started.action, realStart.action)
	assert.equal(advanced.action, realAdvance.action)
	// 一份夹具一份时钟：两份夹具的第一条事件时间戳**相同**——各自从同一起点数。若改成模块级
	// 共享计数器，第二份夹具的起点就取决于本文件里前面造过几条事件，次序不再是「本夹具写了几条」
	// 而是「这份文件跑到哪儿了」，趋势读法那些用例跟着漂
	const other = makeEvent()
	assert.equal(other.start('b', '纯后端管线批').t, started.t, '两份夹具的时钟各自从同一起点数，互不影响')
	assert.ok(isoClockIsLater(other, started), '而各自内部仍然严格递增')
})

test('isoClock 按写入顺序递增：事件定序靠它，取真实时间会让「哪条在前」随跑动快慢变', () => {
	const iso = isoClock()
	const first = iso()
	const second = iso()
	assert.ok(Date.parse(second) > Date.parse(first), `两次 tick 必须严格递增：${first} → ${second}`)
	// 起点固定：真时间会让同一份夹具在不同机器上排出不同次序
	assert.ok(first.startsWith('2026-01-01T'), `起点是定档的那一天而不是真时间：${first}`)
	assert.match(first, /\+00:00$/, '带显式时区偏移：台账那一列的契约')
})

test('withTempDir：同步回调走同步路径（返回原值、返回前已删），异步回调活到它跑完那一刻', async (t) => {
	// 同步形态：套一层 promise 就把「收尾发生在返回前」这件事改掉了——调用方在同一个 tick 里
	// 接着用返回值（assert.equal 那些）时拿到的不是它
	let syncPath
	const value = withTempDir(t, 'sync-case', (dir) => {
		syncPath = dir
		assert.ok(existsSync(dir), 'fn 跑的时候目录在')
		return 42
	})
	assert.equal(value, 42, '同步回调原样返回值，不套 promise')
	assert.equal(existsSync(syncPath), false, '返回前目录已经删掉（同步路径当场收尾）')

	// 异步形态：早删一步的后果是回调醒来读到的目录已经不在，而症状落在回调自己的断言上，
	// 报出来的是「ENOENT」——指向的是回调，不是夹具
	let asyncPath
	await withTempDir(t, 'async-case', async (dir) => {
		asyncPath = dir
		await Promise.resolve()
		assert.ok(existsSync(dir), '异步回调挂起期间目录必须还在：收尾要等回调跑完')
		await Promise.resolve()
		assert.ok(existsSync(dir), '第二次挂起之后同样还在')
	})
	assert.equal(existsSync(asyncPath), false, '回调跑完之后才删')

	// 抛错那一路：目录照样删，否则一条红了的用例会把整个临时根留在盘上
	let boomPath
	assert.throws(() => withTempDir(t, 'boom-case', (dir) => {
		boomPath = dir
		throw new Error('boom')
	}), /boom/)
	assert.equal(existsSync(boomPath), false, 'fn 抛错时目录照样删')
})

test('removeTempRoot：子目录、文件与符号链接一并删净（中文名不崩，链接只删链接本身）', (t) => {
	const root = tempRoot(t, 'remove-tree')
	// 两个链接的目标都放在临时根之外：判定若用 stat 而非 lstat，就会跟进去把目标那棵树也删掉，
	// 而症状是另一个用例的夹具凭空少文件——指向的是那个用例，不是这里
	const outside = tempRoot(t, 'remove-tree-outside')
	const target = join(outside, '外部目标.md')
	writeFileSync(target, '外部目标\n', 'utf8')
	const outsideDir = join(outside, '外部目录')
	mkdirSync(outsideDir, { recursive: true })
	writeFileSync(join(outsideDir, '目标.md'), '正文\n', 'utf8')
	mkdirSync(join(root, '子目录', '更深'), { recursive: true })
	writeFileSync(join(root, '子目录', '更深', '条目.md'), '正文\n', 'utf8')
	writeFileSync(join(root, '顶层条目.md'), '正文\n', 'utf8')
	symlinkSync(target, join(root, '文件链接.md'))
	// 目录链接用 junction：Windows 上不需要符号链接特权，POSIX 忽略这个类型参数
	symlinkSync(outsideDir, join(root, '目录链接'), 'junction')
	removeTempRoot(root)
	assert.equal(existsSync(root), false, '整棵树删净：中文名文件与目录走的正是 rmSync／recursive rmdir 会整进程 0xC0000409 的那一档')
	assert.equal(existsSync(target), true, '链接只删链接本身，不跟进去删目标')
	assert.ok(existsSync(join(outsideDir, '目标.md')), '目录链接同样只删链接本身：跟进去删会把别处的语料一起带走')
})

test('removeTempRoot：目录本就不在时跳过不抛（收尾路径上的抛错会顶掉用例自己的结果）', (t) => {
	const root = tempRoot(t, 'remove-absent')
	assert.doesNotThrow(() => removeTempRoot(join(root, '从没建过')), '不存在的路径按「已删」跳过，与原先 force 的语义一致')
	removeTempRoot(root)
	assert.doesNotThrow(() => removeTempRoot(root), '删过的树再删一次同样跳过（t.after 与手工删会撞上这一档）')
})

test('临时根脱离 node:test 上下文当场报错：安静建一个没人删的目录，泄漏要到下次有人清 /tmp 才发现', () => {
	const fake = { after: undefined }
	assert.throws(() => requireTestContext(fake, 'tempRoot'), /须在 node:test 的上下文里调/)
	assert.throws(() => requireTestContext(undefined, 'withTempDir'), /须在 node:test 的上下文里调/)
	assert.throws(() => tempRoot(fake, 'no-context'), /须在 node:test 的上下文里调/)
	assert.throws(() => withTempDir(fake, 'no-context', () => {}), /须在 node:test 的上下文里调/)
	// 真上下文原样返回（守卫不改变参数，调用方还指着它登记收尾）
	assert.doesNotThrow(() => {
		// 这里只验「不抛」：真上下文的 after 登记由上面那些用例实跑覆盖
		const t = { after: () => {} }
		assert.equal(requireTestContext(t, 'tempRoot'), t)
	})
})

test('seedLedger：一行一事件往返逐字等价，同名再写＝整份替换（不是追加）', (t) => {
	const root = tempRoot(t, 'seed-ledger')
	const events = [makeEvent().start('b1', '纯后端管线批'), makeEvent().advance({ batch: 'b1', stage: '门一' })]
	const path = seedLedger(root, 'ledger', events)
	assert.equal(readFileSync(path, 'utf8'), events.map((event) => `${JSON.stringify(event)}\n`).join(''), '落盘字节＝事件逐行序列化（尾部带换行：追加时要靠它补分隔）')
	assert.deepEqual(readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), events, '读回逐字等价')
	const replaced = [makeEvent().start('b1', '用户可见功能批')]
	seedLedger(root, 'ledger', replaced)
	assert.deepEqual(readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)), replaced, '同名再写整份替换：夹具种的是「一份台账」，追加语义由写侧的 appendEvent 管')
	assert.ok(!existsSync(join(root, 'nothing.jsonl')), '不产多余文件')
})

test('memoryTree：名字空或带分隔符当场拒（拼错的层级会造出一棵没人预期的树）', (t) => {
	const base = tempRoot(t, 'memory-tree')
	// 空名：join(base, '') 落回 base，于是「各自的树」全部叠在同一棵上，用例之间互相污染
	assert.throws(() => memoryTree(base, ''), /非空/, '空名要当场拒：join 会把它落回 base，多个用例的树叠成一棵')
	assert.throws(() => memoryTree(base, '   '), /非空/, '空白名同样拒')
	// 带分隔符：造出一棵比调用方想的那棵深的树，而报错点在某个用例读不到自己那一段时
	assert.throws(() => memoryTree(base, 'a/b'), /路径分隔符/, '名字里带分隔符要当场拒：层级是调用方拼的，不是夹具拼的')
	assert.throws(() => memoryTree(base, '../escape'), /路径分隔符|路径穿越/, '名字里带 .. 同样拒')
	assert.throws(() => memoryTree(base, 'case-machine', 'a/b'), /路径分隔符/, '机器 id 同样受一层限制（它是段目录名）')
	const { root, store, machineDir } = memoryTree(base, 'case', 'home')
	assert.deepEqual(
		[store, machineDir],
		[join(root, 'memory'), join(root, 'memory', 'machines', 'home')],
		'给了机器 id 就建私有段，不给的那一档是 undefined（调用方据此知道这条用例只碰共享段）',
	)
	assert.ok(existsSync(store) && existsSync(machineDir))
	assert.equal(memoryTree(base, 'no-machine').machineDir, undefined)
})

test('copyDataFiles：五份逐字节相等（解析过再写的形状对不上就红），跑两遍结果同', (t) => {
	const dir = join(tempRoot(t, 'copy-data'), 'data')
	copyDataFiles(dir)
	const first = new Map(DISPATCH_DATA_FILES.map((file) => [file, readFileSync(join(dir, file))]))
	for (const [file, bytes] of first) {
		assert.ok(bytes.equals(readFileSync(join(DISPATCH_DATA_DIR, file))), `${file} 与盘上逐字节相等：解析再序列化会改缩进与键序，而现读面那些用例比的就是键序敏感的形状`)
	}
	assert.deepEqual(DISPATCH_DATA_FILES.length, 5, '现读面五份（名单从生产侧现读，见 helpers 的 DATA_FILES 对齐）')
	copyDataFiles(dir)
	const second = new Map(DISPATCH_DATA_FILES.map((file) => [file, readFileSync(join(dir, file))]))
	for (const [file, bytes] of first) {
		assert.ok(second.get(file).equals(bytes), `${file} 拷两遍结果同（幂等：第二遍别把第一遍改坏）`)
	}
	// 子集那一档：台账读几份就只拷几份，少拷的那些不该被建出来（建出来＝读到的不是「不存在」）
	const partial = join(tempRoot(t, 'copy-partial'), 'data')
	copyDataFiles(partial, ['forms.json'])
	assert.deepEqual(existsSync(join(partial, 'forms.json')), true)
	assert.deepEqual(existsSync(join(partial, 'plan-spec.json')), false)
})
