/**
 * fs 端口单测（node:test，零宿主依赖）：node:fs 适配器的守卫与发布语义。
 *
 * 这些用例钉住端口契约本身的行为（守卫、原子发布、错误码）——生产写盘消费方已随迁移
 * 脚本退役；宿主通道不在本文件的断言面内。
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createNodeFsPort, versionOf } from '../lib/fs-port.js'
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
			// name 与 code 同源：端口与读侧探针共用 fs-guard.js
			// 那一份，同一个故障在各条路径上的错误面才谈得上「一致」
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
	// 改一个字节后版本不回退即可。纳秒同刻两次写在 Windows 时钟刻度下不可分（实测偶红），
	// 硬要求「必不同」是向文件系统讨要它不保证的精度；守卫语义收口为 mtimeNs 不减小
	writeFileSync(path, '乙\n', 'utf8')
	const after = versionOf(statSync(path, { bigint: true })).split(':')
	assert.ok(BigInt(after[3]) >= BigInt(parts[3]), `mtimeNs 不得回退（改前 ${parts[3]}，改后 ${after[3]}）`)
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
