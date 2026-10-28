/**
 * 夹具自身的单测（node:test，零宿主依赖）：共用件一旦自己漂了，它服务的那二十几个文件会一起
 * 在与被测对象无关的原因上红，而症状（某个用例读不到目录）指向的是夹具不是生产。所以夹具
 * 也守自己那份契约：临时根两种时序都活到该活的那一刻、守卫当场抛、拷贝逐字节相等。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	DISPATCH_DATA_DIR,
	DISPATCH_DATA_FILES,
	copyDataFiles,
	memoryTree,
	removeTempRoot,
	requireTestContext,
	tempRoot,
	withTempDir,
} from './helpers.js'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))

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

test('临时根单源：test/ 下 mkdtempSync 直调仅许 helpers.js', () => {
	// 扫描面＝本文件所在目录的顶层 .js（非 .js 的文件不在面内），豁免仅 helpers.js——
	// 临时目录的唯一合法落点。helpers 注释里「不要再各写一份」的人脑规则拦不住新增，
	// 换成结构保证。本用例自身也在扫描面内：源码里不得出现「mkdtempSync 后紧跟左括号」
	// 的字面——正则字面量里 mkdtempSync 后是反斜杠、文案用「直调」措辞，都不满足该形态
	const offenders = readdirSync(TEST_DIR)
		.filter((name) => name.endsWith('.js') && name !== 'helpers.js')
		.filter((name) => /\bmkdtempSync\s*\(/.test(readFileSync(join(TEST_DIR, name), 'utf8')))
	assert.deepEqual(offenders, [], `临时根必须走 helpers.js 单源（tempRoot／withTempDir），以下文件直调了 mkdtempSync：${offenders.join('、')}`)
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

test('copyDataFiles：两份逐字节相等（文本面逐字节），跑两遍结果同', (t) => {
	const dir = join(tempRoot(t, 'copy-data'), 'data')
	copyDataFiles(dir)
	const first = new Map(DISPATCH_DATA_FILES.map((file) => [file, readFileSync(join(dir, file))]))
	for (const [file, bytes] of first) {
		assert.ok(bytes.equals(readFileSync(join(DISPATCH_DATA_DIR, file))), `${file} 与盘上逐字节相等：解析再序列化会改缩进与键序，而现读面那些用例比的就是键序敏感的形状`)
	}
	assert.deepEqual(DISPATCH_DATA_FILES.length, 2, '现读面两份（名单从生产侧现读，见 helpers 的 DATA_FILES 对齐）')
	copyDataFiles(dir)
	const second = new Map(DISPATCH_DATA_FILES.map((file) => [file, readFileSync(join(dir, file))]))
	for (const [file, bytes] of first) {
		assert.ok(second.get(file).equals(bytes), `${file} 拷两遍结果同（幂等：第二遍别把第一遍改坏）`)
	}
	// 子集那一档：只拷几份就只建那几份，少拷的那些不该被建出来（建出来＝读到的不是「不存在」）
	const partial = join(tempRoot(t, 'copy-partial'), 'data')
	copyDataFiles(partial, ['templates.md'])
	assert.deepEqual(existsSync(join(partial, 'templates.md')), true)
	assert.deepEqual(existsSync(join(partial, 'discipline.md')), false)
})
