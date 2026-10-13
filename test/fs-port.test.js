/**
 * fs 端口单测（node:test，零宿主依赖）：node:fs 适配器的守卫与发布语义，以及宿主
 * 适配器的形状归一、契约版本探测、signal 与 sandboxPolicy 透传。
 *
 * 宿主通道本会话不可运行期验证（宿主改动要重启才激活），这里的宿主适配器用例是
 * 对 ctx.fs 替身对象的调用——能把「守卫、策略、中断有没有真的传下去」钉住，钉不住
 * 真实后端的行为。别把它读成宿主通道已验证。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostFsPort, createNodeFsPort, versionOf } from '../lib/memory/fs-port.js'

let base

before(() => {
	base = join(tmpdir(), `dsh-fs-port-test-${process.pid}`)
	mkdirSync(base, { recursive: true })
})

after(() => {
	rmSync(base, { recursive: true, force: true })
})

/** 每个用例一个独立文件，避免共用同一路径让守卫断言互相污染。 */
const pathFor = (name) => join(base, `${name}.md`)
const writeFixture = (name, content) => {
	const path = pathFor(name)
	// 传 Buffer 时按字节落盘（造非法 UTF-8 用），传字符串时 Node 照常按 utf8 编码
	writeFileSync(path, content)
	return path
}

test('createNodeFsPort：stat 归一 absent/present＋type，无守卫写入建目录并报 operation', async () => {
	const port = createNodeFsPort()
	const path = join(base, 'nested', 'deep', 'file.md')
	const target = await port.resolve(path)
	assert.deepEqual(await port.stat(target), { kind: 'absent' })
	const created = await port.writeText(target, '甲\n')
	assert.equal(created.operation, 'create')
	assert.ok(existsSync(path), '父目录缺失时写入自行补建（对齐宿主原子写的 recursive mkdir）')
	const present = await port.stat(target)
	assert.equal(present.kind, 'present')
	assert.equal(present.type, 'file')
	assert.ok(typeof present.version === 'string' && present.version.length > 0)
	const updated = await port.writeText(target, '乙\n')
	assert.equal(updated.operation, 'update')
	assert.equal(await port.readText(target), '乙\n')
	assert.notEqual(updated.version, created.version, '内容变了版本必须跟着变，否则守卫形同虚设')
	assert.deepEqual(await port.resolve(path), { targetKey: path, displayPath: path })
	// type 必须能区分「在」与「是文件」：同名目录撞条目名时要在这里就看出来，
	// 而不是让写侧某次读写炸成后端原生英文错误
	assert.equal((await port.stat(await port.resolve(base))).type, 'directory')
})

test('createNodeFsPort：replaceIfVersion 版本匹配即写、失配即抛 FS_STALE_VERSION 且不覆盖', async () => {
	const port = createNodeFsPort()
	const path = writeFixture('guard', '原内容\n')
	const target = await port.resolve(path)
	const observed = await port.stat(target)
	const fresh = await port.writeText(target, '新内容\n', { kind: 'replaceIfVersion', version: observed.version })
	assert.equal(fresh.operation, 'update')
	assert.equal(readFileSync(path, 'utf8'), '新内容\n')
	// 拿旧版本再写＝并发方已改过：抛错且文件保持现内容，不静默吃掉对方的改动
	await assert.rejects(() => port.writeText(target, '抢写\n', { kind: 'replaceIfVersion', version: observed.version }), (error) => {
		assert.equal(error.code, 'FS_STALE_VERSION')
		assert.match(error.message, /重试/)
		return true
	})
	assert.equal(readFileSync(path, 'utf8'), '新内容\n')
	// 目标已不存在时 replaceIfVersion 同样按失配拒（不得当成无条件写）
	await rmSync(path)
	await assert.rejects(() => port.writeText(target, '复活\n', { kind: 'replaceIfVersion', version: observed.version }), (error) => error.code === 'FS_STALE_VERSION')
	assert.equal(existsSync(path), false)
})

test('createNodeFsPort：createIfAbsent 走 O_EXCL，已存在抛 FS_NOT_OBSERVED（契约里唯一的 no-replace 硬保证）', async () => {
	const port = createNodeFsPort()
	const target = await port.resolve(pathFor('create-if-absent'))
	const created = await port.writeText(target, '首写\n', { kind: 'createIfAbsent' })
	assert.equal(created.operation, 'create')
	await assert.rejects(() => port.writeText(target, '再写\n', { kind: 'createIfAbsent' }), (error) => {
		assert.equal(error.code, 'FS_NOT_OBSERVED')
		return true
	})
	assert.equal(readFileSync(pathFor('create-if-absent'), 'utf8'), '首写\n')
})

test('createNodeFsPort：发布走临时件＋原子改名，落盘后不留 .tmp 残件（对齐宿主 writeFileAtomic）', async () => {
	const port = createNodeFsPort()
	await port.writeText(await port.resolve(pathFor('atomic')), '一\n')
	await port.writeText(await port.resolve(pathFor('atomic')), '二\n')
	assert.equal(readFileSync(pathFor('atomic'), 'utf8'), '二\n')
	const leftovers = readdirSync(base).filter((name) => name.endsWith('.tmp'))
	assert.deepEqual(leftovers, [], `临时件没清干净：${leftovers.join(', ')}`)
})

test('createNodeFsPort：目标是目录时写抛 FS_NOT_REGULAR_FILE（与宿主同码，不放原生 ENOTEMPTY 出去）', async () => {
	const port = createNodeFsPort()
	const dir = join(base, 'not-a-file')
	mkdirSync(dir, { recursive: true })
	const target = await port.resolve(dir)
	for (const intent of [undefined, { kind: 'createIfAbsent' }, { kind: 'replaceIfVersion', version: 'v-1' }]) {
		await assert.rejects(() => port.writeText(target, 'x\n', intent), (error) => {
			assert.equal(error.code, 'FS_NOT_REGULAR_FILE', `守卫 ${intent?.kind ?? '无'} 下也须给宿主那个码`)
			// name 与 code 同源：写侧 edit/upsert 与直连 node:fs 的 delete 共用 fs-guard.js
			// 那一份，同一个故障在四条路径上的错误面才谈得上「一致」
			assert.equal(error.name, 'FsPortError')
			return true
		})
	}
	assert.deepEqual(readdirSync(dir), [], '被拒的写不得动目录内容')
})

test('createNodeFsPort：listDir 映射 file/directory/other 三种 type，目录不存在归一为 []', async () => {
	const port = createNodeFsPort()
	const dir = join(base, 'listdir')
	mkdirSync(join(dir, 'sub'), { recursive: true })
	writeFileSync(join(dir, 'entry.md'), 'x\n', 'utf8')
	symlinkSync(join(dir, 'entry.md'), join(dir, 'link.md'))
	const entries = await port.listDir(await port.resolve(dir))
	assert.deepEqual(
		entries.sort((a, b) => a.name.localeCompare(b.name)),
		[{ name: 'entry.md', type: 'file' }, { name: 'link.md', type: 'other' }, { name: 'sub', type: 'directory' }],
		'三种 type 都要映出来：消费方靠 type 滤掉目录，少映一种就把它当条目读',
	)
	assert.deepEqual(await port.listDir(await port.resolve(join(base, 'no-such-dir'))), [], '缺失目录按无子项归一，与 stat 的 absent 同口径')
})

test('versionOf：五段纳秒级版本串（少一段守卫就漏），且与端口 stat 同一算法', async () => {
	const path = writeFixture('version-shape', '甲\n')
	const stats = statSync(path, { bigint: true })
	const version = versionOf(stats)
	const parts = version.split(':')
	assert.equal(parts.length, 5, `版本串须五段 dev:ino:size:mtimeNs:ctimeNs，收到 "${version}"`)
	assert.ok(parts.every((part) => /^\d+$/.test(part)), `每段须为无符号十进制（须用 bigint stat 才拿得到 mtimeNs/ctimeNs），收到 "${version}"`)
	// 守卫比的就是这个串：端口 stat 暴露的版本必须与本函数逐字一致，否则「在测试端口
	// 验过守卫」不等于守卫真的在比同一份版本
	const port = createNodeFsPort()
	assert.equal((await port.stat(await port.resolve(path))).version, version)
	// 改一个字节版本必变：纳秒精度缺了的话同长度覆写可能看不出变化，守卫就漏了
	writeFileSync(path, '乙\n', 'utf8')
	assert.notEqual(versionOf(statSync(path, { bigint: true })), version)
})

test('createNodeFsPort：stat 的失败只吞 ENOENT/ENOTDIR，其余原样上抛（不得一律当 absent）', async () => {
	const port = createNodeFsPort()
	await assert.rejects(
		() => port.stat({ targetKey: undefined }),
		(error) => {
			assert.equal(error.code, 'ERR_INVALID_ARG_TYPE', '非 ENOENT/ENOTDIR 的失败须原样上抛，不得吞成 absent（＝谎报文件不在）')
			return true
		},
	)
})

/** ctx.fs 替身：记录每个调用并保留形参数（契约版本探测读的就是它），形状按宿主抽象契约裁剪。 */
function makeHostFsStub() {
	const calls = []
	return {
		calls,
		async resolve(path) {
			calls.push({ method: 'resolve', args: [path] })
			return { targetKey: `key:${path}`, displayPath: path }
		},
		async stat(target, signal) {
			calls.push({ method: 'stat', args: [target, signal] })
			return target.displayPath.endsWith('absent.md') ? undefined : { version: 'v-1', type: 'file', size: 12 }
		},
		async readText(target, signal) {
			calls.push({ method: 'readText', args: [target, signal] })
			return '宿主内容'
		},
		// 字节窗口：宿主只认「取哪一段」，越界返回空，不按文件大小报错
		async readByteRange(target, range, signal) {
			calls.push({ method: 'readByteRange', args: [target, range, signal] })
			return new TextEncoder().encode('宿主字节').subarray(0, range.length)
		},
		async listDir(target, signal) {
			calls.push({ method: 'listDir', args: [target, signal] })
			// 宿主 FsDirEntry 带 target/version/size，端口只该透出 name+type
			return [{ name: 'a.md', type: 'file', target: { targetKey: 'key:/x/a.md' }, version: 'v-1', size: 12 }]
		},
		async writeText(target, content, intent, signal, policy) {
			calls.push({ method: 'writeText', args: [target, content, intent, signal, policy] })
			return { operation: 'update', version: 'v-2', before: '旧', after: '新' }
		},
	}
}

test('assertWritable：只读策略拒写并给宿主词表的 code，两个适配器同款语义', () => {
	const readOnly = { mode: 'read-only', workspaceRoot: '/tmp', sessionId: 'session-1' }
	const pair = [
		['node', createNodeFsPort({ sandboxPolicy: readOnly })],
		['host', createHostFsPort({ fs: makeHostFsStub(), policy: { resolve: () => readOnly } })],
	]
	for (const [label, port] of pair) {
		assert.throws(() => port.assertWritable(), (error) => {
			assert.equal(error.code, 'FS_SANDBOX_DENIED', `${label} 端口的只读拒写须带 code`)
			assert.match(error.message, /不允许写记忆/)
			assert.doesNotMatch(error.message, /workspace-write 或更高/, '围栏范围是会话 cwd，照着改仍被拒，不得这么引导')
			return true
		}, `${label} 端口：只读策略下必须拒写`)
	}
	// 非只读与策略缺省都放行（策略不在端口时不做二次否决，交后端自己的默认解析）
	for (const port of [createNodeFsPort(), createNodeFsPort({ sandboxPolicy: { mode: 'workspace-write' } }), createHostFsPort({ fs: makeHostFsStub() }), createHostFsPort({ fs: makeHostFsStub(), policy: undefined })]) {
		assert.equal(port.assertWritable(), undefined)
	}
})

test('createHostFsPort：stat 的 undefined 归一 absent、type 透传，readText/resolve 直传并带 signal', async () => {
	const stub = makeHostFsStub()
	const port = createHostFsPort({ fs: stub })
	const abort = new AbortController().signal
	assert.deepEqual(await port.stat(await port.resolve('/x/absent.md'), abort), { kind: 'absent' })
	assert.deepEqual(await port.stat(await port.resolve('/x/present.md'), abort), { kind: 'present', version: 'v-1', type: 'file' })
	assert.equal(await port.readText(await port.resolve('/x/present.md'), abort), '宿主内容')
	assert.deepEqual(await port.resolve('/x/a.md'), { targetKey: 'key:/x/a.md', displayPath: '/x/a.md' })
	for (const call of stub.calls) {
		if (call.method === 'stat' || call.method === 'readText') {
			assert.equal(call.args[1], abort, `${call.method} 的第 2 位必须是同一个 AbortSignal 引用`)
		}
	}
})

test('createHostFsPort：writeText 第 4 位是同一个 AbortSignal、第 5 位是同一个策略对象，守卫按位透传', async () => {
	const stub = makeHostFsStub()
	const sandboxPolicy = { mode: 'workspace-write', workspaceRoot: '/w', sessionId: 'session-9' }
	const port = createHostFsPort({ fs: stub, policy: { resolve: () => sandboxPolicy } })
	const target = await port.resolve('/x/a.md')
	const intent = { kind: 'replaceIfVersion', version: 'v-1' }
	const abort = new AbortController().signal
	await port.writeText(target, '新', intent, abort)
	const call = stub.calls.find((item) => item.method === 'writeText')
	assert.equal(call.args[3], abort, '第 4 位必须是同一个 AbortSignal 引用（原实现恒为 undefined，中断静默失效）')
	assert.equal(call.args[4], sandboxPolicy, '第 5 位必须是解出的那个策略对象本身（同一引用，不是副本）')
	assert.equal(call.args[2], intent, '写入守卫按位透传，不得被适配器吞掉')
})

test('createHostFsPort：策略按会话解析（agent 缺席交后端默认解析），签名对不上就在构造期拒', () => {
	const policy = { resolve: (request) => ({ mode: 'workspace-write', sessionId: request?.session?.id ?? 'none' }) }
	const agent = { session: { id: 'session-7' } }
	assert.equal(createHostFsPort({ fs: makeHostFsStub(), policy, agent }).assertWritable(), undefined)
	assert.equal(createHostFsPort({ fs: makeHostFsStub(), policy, agent: undefined }).assertWritable(), undefined, '无会话上下文＝resolve({})')
	// 策略洞位被删（如宿主本地后端的 4 形参 writeText）或压根不是 fs 服务：策略会被
	// 静默丢弃，越界写入得逞——这种错必须在构造期炸，不能等第一次记忆写入
	assert.throws(() => createHostFsPort({ fs: { resolve: async () => ({}), writeText: async (target, content, intent, signal) => ({}) } }), /契约版本不匹配/)
	assert.throws(() => createHostFsPort({ fs: {} }), /契约版本不匹配/)
})

test('createHostFsPort：listDir 只透 name+type 并按位传 signal，缺失目录的 FS_NOT_FOUND 归一为 []', async () => {
	const stub = makeHostFsStub()
	const port = createHostFsPort({ fs: stub })
	const abort = new AbortController().signal
	assert.deepEqual(await port.listDir(await port.resolve('/x'), abort), [{ name: 'a.md', type: 'file' }], 'target/version/size 是宿主契约细节，端口不替消费方决定 target')
	assert.equal(stub.calls.find((call) => call.method === 'listDir').args[1], abort, 'listDir 的 signal 同样按位透传')
	// 契约写着「目录不存在返回 []」，宿主后端对缺失目录抛 FS_NOT_FOUND：不归一的话
	// 下一个照契约写的消费方在宿主通道上会拿到一个契约里根本没有的错误码
	const throwCode = (code) => async () => {
		throw Object.assign(new Error(`cannot list: ${code}`), { code })
	}
	const missing = createHostFsPort({ fs: { ...stub, listDir: throwCode('FS_NOT_FOUND') } })
	assert.deepEqual(await missing.listDir(await missing.resolve('/nope')), [])
	const other = createHostFsPort({ fs: { ...stub, listDir: throwCode('EACCES') } })
	const denied = await other.resolve('/x')
	await assert.rejects(() => other.listDir(denied), (error) => error.code === 'EACCES', '非缺失类错误原样上抛，不得一并吞成空目录')
})

test('createHostFsPort：宿主缺 listDir 在构造期就炸（拦截静默失效不得等到第一次写入）', () => {
	// writeText 形参给足五个，好让这条只考 listDir 那道关（形参不足会先撞上 arity 检查）
	assert.throws(() => createHostFsPort({ fs: { writeText: async (target, content, intent, signal, sandboxPolicy) => ({}) } }), /listDir/)
})

test('createHostFsPort：宿主缺 readByteRange 在构造期就炸（端口构造失败＝整个写侧不可用，不许是「慢一点」）', () => {
	// 形参给足五个、listDir 也在场，好让这条只考 readByteRange 那道关
	const base = { writeText: async (target, content, intent, signal, sandboxPolicy) => ({}), listDir: async () => [] }
	assert.throws(() => createHostFsPort({ fs: base }), /readByteRange/)
})

test('createNodeFsPort：readHead 至多取 maxBytes 字节，文件更短就返回全长（端口不做带领域知识的早退）', async () => {
	const port = createNodeFsPort()
	const short = writeFixture('head-short', '短文件全文\n')
	assert.equal(await port.readHead(await port.resolve(short), 4096), '短文件全文\n', '短于上限时返回全长，不因为上限大就报错或截断')
	const long = writeFixture('head-long', `${'头'.repeat(20)}\n正文\n`)
	const head = await port.readHead(await port.resolve(long), 24)
	assert.equal(head, '头'.repeat(8), '只取前 maxBytes 字节')
	assert.ok(!head.includes('正文'), '上限之外的正文字节不进结果')
})

test('createNodeFsPort：readHead 跨块边界的中文不产生替换符（只在末尾解码这一条口径的立身之本）', async () => {
	const port = createNodeFsPort()
	// 每个汉字 3 字节：分块 2048 落在第 682 个字之后，那个字必然被劈在两块之间
	const content = '中'.repeat(4000)
	const path = writeFixture('head-chunk-boundary', content)
	const head = await port.readHead(await port.resolve(path), content.length * 3)
	assert.equal(head, content, '分块读到的字节先合并、后解码')
	assert.ok(!head.includes('�'), '按块解码会把跨块字符劈成替换符，而这份字符串直接进注入材料')
})

test('createNodeFsPort：readHead 的窗口切在多字节字符中间时剪掉那半个字（不是宽容，是常态）', async () => {
	const port = createNodeFsPort()
	// 窗口以块为界，块边界落进汉字中间的概率约 3/4——几乎每次头读都会遇到。剪掉的是
	// 窗口边而不是内容：半个字既不是合法 UTF-8，也不该以替换符的形式进注入材料
	const content = '中'.repeat(4000)
	const path = writeFixture('head-cut-inside-char', content)
	for (const maxBytes of [2049, 2050, 2051, 2052, 2999]) {
		const head = await port.readHead(await port.resolve(path), maxBytes)
		assert.ok(!head.includes('�'), `maxBytes=${maxBytes} 切进字符中间时不得产出替换符`)
		assert.equal(head, content.slice(0, Math.floor(maxBytes / 3)), `maxBytes=${maxBytes} 的头应是完整的那些字`)
	}
})

test('createNodeFsPort：readHead 遇到非法 UTF-8 按 FS_NOT_TEXT 抛（不静默产出 U+FFFD）', async () => {
	const port = createNodeFsPort()
	// 头读的下游是同名判定：变形后的 title 会让它拿一个谁也没写过的串去比，而同一文件
	// 走 readText 当场就报非文本——两条路径对同一个坏文件的答案必须一致
	const path = writeFixture('head-bad-utf8', Buffer.concat([Buffer.from('title: 标题\n', 'utf8'), Buffer.from([0xff, 0xfe])]))
	const target = await port.resolve(path)
	await assert.rejects(() => port.readHead(target, 4096), (error) => {
		assert.equal(error.code, 'FS_NOT_TEXT')
		assert.match(error.message, /head-bad-utf8/, '报错要指名是哪个文件，否则只能靠读全文定位')
		return true
	})
})

test('createNodeFsPort：readHead 对缺失文件原样上抛（不得把 ENOENT 吞成空串谎报「头已闭合」）', async () => {
	const port = createNodeFsPort()
	const missing = await port.resolve(pathFor('never-created'))
	await assert.rejects(() => port.readHead(missing, 2048), (error) => {
		assert.equal(error.code, 'ENOENT')
		return true
	})
})

test('createHostFsPort：readHead 走 readByteRange 的 offset 0 与给定 length，signal 按位透传', async () => {
	const stub = makeHostFsStub()
	const port = createHostFsPort({ fs: stub })
	const abort = new AbortController().signal
	const head = await port.readHead(await port.resolve('/x/a.md'), 2048, abort)
	const call = stub.calls.find((item) => item.method === 'readByteRange')
	assert.deepEqual(call.args[1], { offset: 0, length: 2048 }, '头读就是第 0 字节起的窗口；长度按消费方给的原样传')
	assert.equal(call.args[2], abort, 'signal 与 readText/listDir 同款按位透传（插洞位不会被探到）')
	assert.equal(head, '宿主字节', '字节按 UTF-8 解码成字符串交给消费方')
	assert.equal(stub.calls.some((item) => item.method === 'readText'), false, '头读不得绕道 readText')
})
