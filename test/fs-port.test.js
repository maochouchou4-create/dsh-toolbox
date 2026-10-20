/**
 * fs 端口单测（node:test，零宿主依赖）：node:fs 适配器的守卫与发布语义，以及宿主
 * 适配器的形状归一、契约版本探测、signal 与 sandboxPolicy 透传。
 *
 * 宿主通道本会话不可运行期验证（宿主改动要重启才激活），这里的宿主适配器用例是
 * 对 ctx.fs 替身对象的调用——能把「守卫、策略、中断有没有真的传下去」钉住，钉不住
 * 真实后端的行为。别把它读成宿主通道已验证。
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHostFsPort, createNodeFsPort, createReadOnlyPort, versionOf } from '../lib/fs-port.js'
import { tempRoot } from './helpers.js'

let base

before((t) => {
	base = tempRoot(t, 'fs-port')
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
	// 而不是让消费方某次读写炸成后端原生英文错误
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
			// name 与 code 同源：写盘消费方（dispatch 台账、迁移脚本）与读侧探针共用
			// fs-guard.js 那一份，同一个故障在各条路径上的错误面才谈得上「一致」
			assert.equal(error.name, 'FsPortError')
			return true
		})
	}
	assert.deepEqual(readdirSync(dir), [], '被拒的写不得动目录内容')
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
		async writeText(target, content, intent, signal, policy) {
			calls.push({ method: 'writeText', args: [target, content, intent, signal, policy] })
			return { operation: 'update', version: 'v-2', before: '旧', after: '新' }
		},
	}
}

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

test('createHostFsPort：writeText 第 4 位是同一个 AbortSignal、第 5 位是解出的策略对象，守卫按位透传', async () => {
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

test('createHostFsPort：策略按会话解析——resolve 收到 agent.session 本体，缺 agent 收到 {}', async () => {
	// 「按会话解析」的可验证形态是策略**看会话 id 决定回什么**：只按「有没有 agent」分支的
	// 实现（漏传 agent.session）在这条断言下同样绿，因为带 agent 的那一支恰好命中只读会话。
	// 故只读与否由会话 id 决定，agent 缺席时 resolve 收到的是 {} ——同一个 policy、同一个
	// 构造器，两种入参给出两种答案。端口自己不否决写：解出什么就原样下传给后端裁决。
	const seenRequests = []
	const resolvedPolicies = []
	const policy = {
		resolve: (request) => {
			seenRequests.push(request)
			const resolved = { mode: request?.session?.id === 'session-ro' ? 'read-only' : 'workspace-write' }
			resolvedPolicies.push(resolved)
			return resolved
		},
	}
	const stub = makeHostFsStub()
	const withAgent = createHostFsPort({ fs: stub, policy, agent: { session: { id: 'session-ro', extra: 1 } } })
	await withAgent.writeText({ targetKey: '/x/a.md', displayPath: '/x/a.md' }, 'x\n')
	assert.deepEqual(seenRequests[0], { session: { id: 'session-ro', extra: 1 } }, 'agent.session 必须原样透进 policy.resolve：漏传时只读会话永远判不出来，越界写入将得逞')
	assert.equal(resolvedPolicies[0].mode, 'read-only', '只读会话解出只读策略')
	// 解出的对象按引用下传（第 5 位就是它本身）：后端拿到的策略由会话决定，端口不加工
	const writeCall = stub.calls.find((call) => call.method === 'writeText')
	assert.equal(writeCall.args[4], resolvedPolicies[0], '下传的必须是 resolve 返回的那个对象本身（同一引用）')
	// agent 缺席＝resolve({})，端口不在这一层二次否决——解出什么下传什么
	const withoutAgent = createHostFsPort({ fs: makeHostFsStub(), policy, agent: undefined })
	await withoutAgent.writeText({ targetKey: '/x/b.md', displayPath: '/x/b.md' }, 'x\n')
	assert.deepEqual(seenRequests[1], {}, '无会话上下文时 resolve 收到空请求（不是 undefined——后端按形状取 session）')
})

test('createHostFsPort：缺策略洞位的宿主报「不带 sandboxPolicy 洞位」，缺方法的才报「契约版本不匹配」（文案指错方向即排查从错处岔开）', () => {
	// writeText.length === 4 就是宿主本地后端那一版：它没挂 dsh-fs-sandbox，压根没有策略
	// 洞位。报「契约版本不匹配」会把人引去查宿主版本与升级，而正确处置是给这个 profile 挂上
	// dsh-fs-sandbox 后端——两种根因两种处置，文案必须落在真实的那一个上。替身四方法齐备
	// 是为了过形状那道关、单独考语义门
	const fourArg = { ...makeHostFsStub(), writeText: async (target, content, intent, signal) => ({}) }
	assert.throws(
		() => createHostFsPort({ fs: fourArg }),
		(error) => {
			assert.match(error.message, /不带 sandboxPolicy 洞位/)
			assert.match(error.message, /dsh-fs-sandbox/, '须点出该挂哪个后端，否则读者无从处置')
			assert.doesNotMatch(error.message, /契约版本不匹配/, '缺洞位与缺方法是两回事，文案不得混用')
			return true
		},
	)
	// 缺方法那几条才是真的契约版本不匹配：文案归它们，不许被这次改动一并带走。
	// writeText 也在其中——它在就不谈洞位，不在就是 fs 服务本身不对
	assert.throws(() => createHostFsPort({ fs: {} }), /契约版本不匹配：缺 writeText 方法/, '缺 writeText 报 fs 服务缺失，不得混进沙箱洞位那条')
	// 方法在、只是少形参：走语义门那条，报的是洞位不在而不是缺方法
	assert.throws(() => createHostFsPort({ fs: { ...makeHostFsStub(), writeText: () => ({}) } }), /不带 sandboxPolicy 洞位/, '0 形参 writeText 仍在场，报洞位而非缺方法')
})

test('createHostFsPort：缺 resolve/stat/readText 同样在构造期就报（此前包装函数照样建得起来，缺席要到第一个用点才炸裸 TypeError）', () => {
	// 缺这三个方法时端口构造得出来，消费方的第一个动作（写盘取 target、版本判定、读回）
	// 就撞上裸 TypeError「hostFs.resolve is not a function」——既不是带 code 的 FsError，
	// 也不带契约口径，读的人无从知道是宿主形状不对
	for (const method of ['resolve', 'stat', 'readText']) {
		assert.throws(
			() => createHostFsPort({ fs: without(makeHostFsStub(), method) }),
			(error) => {
				assert.match(error.message, new RegExp(`契约版本不匹配：缺 ${method} 方法`), error.message)
				// 抛的是带契约口径的 Error，不是调用点上的裸 TypeError（那条文案里恰好引用了
				// 裸 TypeError 的原文，故只能按错误类型判）
				assert.equal(error.constructor.name, 'Error', '构造期报的是契约口径，不是那个裸 TypeError')
				return true
			},
			`缺 ${method} 必须构造期就炸`,
		)
	}
	// 报错还要指出它会在哪一步炸：读者据此知道去查哪个调用点，不必先复现一遍裸 TypeError
	assert.throws(() => createHostFsPort({ fs: without(makeHostFsStub(), 'resolve') }), /写盘的第一个动作/)
	assert.throws(() => createHostFsPort({ fs: without(makeHostFsStub(), 'stat') }), /版本判定/)
	assert.throws(() => createHostFsPort({ fs: without(makeHostFsStub(), 'readText') }), /读回/)
})

/** 替身去掉一个方法：缺方法必须整条构造期报，故这里走「不在表里」而不是留个 undefined。 */
function without(stub, method) {
	const copy = { ...stub }
	delete copy[method]
	return copy
}

test('createReadOnlyPort：只透读三件且冻结，写方法在返回对象上不存在（写路径摸不到而非拒绝写）', async () => {
	const port = createNodeFsPort()
	const target = await port.resolve(writeFixture('ro-facade', '只读面\n'))
	const readOnly = createReadOnlyPort(port)
	for (const method of ['resolve', 'stat', 'readText']) {
		assert.equal(typeof readOnly[method], 'function', `读方法 ${method} 须在白名单内透出`)
	}
	assert.equal(readOnly.writeText, undefined, '写方法不得出现在只读门面上——「记得别写」是纪律，纪律会松；摸不到才是结构保证')
	assert.ok(Object.isFrozen(readOnly), '门面须冻结：事后补方法等于把白名单变成摆设')
	assert.equal(await readOnly.readText(target), '只读面\n')
	assert.throws(() => readOnly.writeText(target, '越界\n'), TypeError, '门面上调写＝TypeError（undefined is not a function），不是静默成功')
})
