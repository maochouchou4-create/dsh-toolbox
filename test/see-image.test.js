/**
 * see_image 内缝纯函数单测（node:test，零宿主依赖）：魔数嗅探＋流终态映射
 * ＋附件占位符解析（标识归一／存区根解析／前缀定位对象）。
 * 端到端识图质量不在此层（需活宿主＋视觉模型，验收口径见 README）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finishError, parseAttachmentId, resolveAttachmentObject, resolveAttachmentRoot, resolveTarget, sniffImageMediaType, transcribe } from '../lib/see-image/vision.js'

test('sniffImageMediaType 按魔数识别四种受支持图型', () => {
	assert.equal(sniffImageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png')
	assert.equal(sniffImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
	assert.equal(sniffImageMediaType(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1')), 'image/webp')
	assert.equal(sniffImageMediaType(Buffer.from('GIF89a...', 'latin1')), 'image/gif')
	assert.equal(sniffImageMediaType(Buffer.from('GIF87a...', 'latin1')), 'image/gif')
})

test('sniffImageMediaType 拒绝非图与截断头', () => {
	assert.equal(sniffImageMediaType(Buffer.from('hello world, definitely not an image', 'latin1')), null)
	assert.equal(sniffImageMediaType(Buffer.from([0x89, 0x50, 0x4e])), null, 'png 头截断不足 8 字节')
	assert.equal(sniffImageMediaType(Buffer.alloc(0)), null)
})

test('finishError：正常收尾不造错，失败态映射为显式错误', () => {
	assert.equal(finishError({ kind: 'stop' }), undefined)
	assert.equal(finishError({ kind: 'tool-calls' }), undefined, '视觉调用不带工具，其余态不可能出现；即便出现也不算失败')

	const errored = finishError({ kind: 'error', failure: { message: 'upstream 503' } })
	assert.ok(errored instanceof Error)
	assert.match(errored.message, /error.*upstream 503/)

	const aborted = finishError({ kind: 'aborted' })
	assert.match(aborted.message, /aborted.*unknown failure/, '缺 failure 细节时兜底文案')

	const capped = finishError({ kind: 'max-tokens' })
	assert.match(capped.message, /truncated/)
})

const HEX64 = '053eb17e'.padEnd(64, '0')

test('parseAttachmentId：收 sha256: 前缀／裸前缀／完整 64 位，归一小写', () => {
	assert.equal(parseAttachmentId(`sha256:${HEX64}`), HEX64)
	assert.equal(parseAttachmentId('sha256:053eb17e'), '053eb17e')
	assert.equal(parseAttachmentId('053EB17E'), '053eb17e', '裸前缀大写归一')
	assert.equal(parseAttachmentId(HEX64), HEX64)
})

test('parseAttachmentId：sha256:／SHA256:／裸 hex 三种写法等价（同一标识不该有两种结果）', () => {
	assert.equal(parseAttachmentId('SHA256:053eb17e'), '053eb17e', '大写前缀同样剥掉')
	assert.equal(parseAttachmentId('SHA256:053EB17E'), parseAttachmentId('sha256:053eb17e'))
	assert.equal(parseAttachmentId('053EB17E'), parseAttachmentId('sha256:053eb17e'))
	assert.equal(parseAttachmentId('SHA256:053eb17e'), parseAttachmentId('053eb17e'))
})

test('parseAttachmentId：过短／非法字符／空标识显式拒绝', () => {
	assert.throws(() => parseAttachmentId('sha256:053eb1'), /无效的附件标识/)
	assert.throws(() => parseAttachmentId('sha256:zzzzzzzz'), /无效的附件标识/)
	assert.throws(() => parseAttachmentId('sha256:'), /无效的附件标识/)
	assert.throws(() => parseAttachmentId(`${HEX64}ff`), /无效的附件标识/, '超过 64 位拒绝')
})

test('resolveAttachmentRoot：DSH_HOME 优先于默认 ~/.dsh，空白视同未设', () => {
	const fakeHome = join(tmpdir(), 'fake-home')
	assert.equal(resolveAttachmentRoot({}, () => fakeHome), join(fakeHome, '.dsh', 'attachments', 'v1', 'objects'))
	assert.equal(resolveAttachmentRoot({ DSH_HOME: '/custom/dsh' }, () => fakeHome), join('/custom/dsh', 'attachments', 'v1', 'objects'))
	assert.equal(resolveAttachmentRoot({ DSH_HOME: '   ' }, () => fakeHome), join(fakeHome, '.dsh', 'attachments', 'v1', 'objects'), '空白 DSH_HOME 视同未设')
})

test('resolveAttachmentObject：前缀与全量均唯一命中，返回完整路径与 id', () => {
	const root = mkdtempSync(join(tmpdir(), 'objects-'))
	try {
		mkdirSync(join(root, HEX64.slice(0, 2)))
		writeFileSync(join(root, HEX64.slice(0, 2), HEX64), 'x')

		const byPrefix = resolveAttachmentObject(root, '053eb17e')
		assert.equal(byPrefix.id, HEX64)
		assert.equal(byPrefix.path, join(root, HEX64.slice(0, 2), HEX64))

		const byFullId = resolveAttachmentObject(root, HEX64)
		assert.equal(byFullId.id, HEX64)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('resolveAttachmentObject：零命中／歧义／缺桶均显式报错', () => {
	const root = mkdtempSync(join(tmpdir(), 'objects-'))
	try {
		mkdirSync(join(root, HEX64.slice(0, 2)))
		writeFileSync(join(root, HEX64.slice(0, 2), HEX64), 'x')
		assert.throws(() => resolveAttachmentObject(root, '053eb17f'), /没有以 053eb17f 开头的对象/)

		const sibling = '053eb17e'.padEnd(64, 'f')
		writeFileSync(join(root, HEX64.slice(0, 2), sibling), 'x')
		assert.throws(() => resolveAttachmentObject(root, '053eb17e'), /命中 2 个对象.*加长前缀/)

		assert.throws(() => resolveAttachmentObject(root, 'ffffffff'), /没有桶/, '桶不存在时报可诊断路径')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

/** ctx 替身：只实现 resolveTarget 问得到的服务成员，记下每次调用便于断言。 */
const 假Ctx = ({ cwd = '/work/live' } = {}) => {
	const calls = []
	return {
		calls,
		fs: {
			async resolve(path, options) {
				calls.push({ method: 'fs.resolve', path, cwd: options?.cwd })
				return { targetKey: path, displayPath: path }
			},
		},
		workingDirectory: {
			async ensure() {
				calls.push({ method: 'workingDirectory.ensure' })
				return cwd
			},
		},
	}
}

/** assembler 替身：只实现 transcribe 用到的三个成员（宿主 BlockAssembler 裸仓不可 import）。 */
const 假Assembler = (blocks, finish = { kind: 'stop' }) => {
	const pushed = []
	return { pushed, finish, blocks: () => blocks, push: (chunk) => pushed.push(chunk) }
}

const 假流 = async function* (chunks) {
	for (const chunk of chunks) yield chunk
}

test('resolveTarget：path 分支按会话活目录解析，sourceName 取 basename、attachmentId 空', async () => {
	const ctx = 假Ctx()
	const r = await resolveTarget(ctx, { path: 'shots/a.png' }, { agent: { session: { id: 's1' } }, signal: 'SIG' }, '/objects')
	assert.equal(r.target.displayPath, 'shots/a.png')
	assert.equal(r.sourceName, 'a.png', '存附件时的文件名取 basename，不是整条路径')
	assert.equal(r.attachmentId, undefined, 'path 分支没有 sha256 可回显')
	assert.deepEqual(ctx.calls, [
		{ method: 'workingDirectory.ensure' },
		{ method: 'fs.resolve', path: 'shots/a.png', cwd: '/work/live' },
	])
})

test('resolveTarget：非 agent 调用不问活目录（cwd 交由 fs 服务默认解析）', async () => {
	const ctx = 假Ctx()
	ctx.workingDirectory.ensure = async () => {
		throw new Error('无会话上下文时不该问活目录')
	}
	const r = await resolveTarget(ctx, { path: '/abs/b.png' }, { agent: undefined, signal: undefined }, '/objects')
	assert.equal(r.sourceName, 'b.png')
	assert.deepEqual(ctx.calls, [{ method: 'fs.resolve', path: '/abs/b.png', cwd: undefined }])
})

test('resolveTarget：attachment 分支按前缀定位对象，sourceName 与 attachmentId 同为完整 id', async () => {
	const root = mkdtempSync(join(tmpdir(), 'objects-'))
	try {
		mkdirSync(join(root, HEX64.slice(0, 2)))
		writeFileSync(join(root, HEX64.slice(0, 2), HEX64), 'x')
		const ctx = 假Ctx()
		const r = await resolveTarget(ctx, { attachment: `SHA256:053eb17e` }, { agent: undefined, signal: undefined }, root)
		assert.equal(r.target.displayPath, join(root, HEX64.slice(0, 2), HEX64))
		assert.equal(r.sourceName, HEX64)
		assert.equal(r.attachmentId, HEX64, '占位符分支回显完整 id，调用方据此拼 sha256: 前缀')
		assert.deepEqual(ctx.calls, [{ method: 'fs.resolve', path: join(root, HEX64.slice(0, 2), HEX64), cwd: undefined }])
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

test('resolveTarget：path 与 attachment 都给或都不给即拦（两条入口互斥）', async () => {
	const ctx = 假Ctx()
	await assert.rejects(() => resolveTarget(ctx, {}, { agent: undefined, signal: undefined }, '/objects'), /二选一/)
	await assert.rejects(() => resolveTarget(ctx, { path: 'a.png', attachment: '053eb17e' }, { agent: undefined, signal: undefined }, '/objects'), /二选一/)
	assert.deepEqual(ctx.calls, [], '互斥校验在碰 I/O 之前')
})

test('transcribe：喂流取正文（只留 text 块并去空白），chunks 逐个进 assembler', async () => {
	const assembler = 假Assembler([{ type: 'text', text: '  图里有三行字  ' }, { type: 'reasoning', text: '思考不算正文' }])
	const chunks = [{ type: 'text-delta', index: 0, text: 'a' }, { type: 'text-delta', index: 0, text: 'b' }]
	assert.equal(await transcribe({ stream: 假流(chunks), assembler }), '图里有三行字')
	assert.deepEqual(assembler.pushed, chunks)
})

test('transcribe：终态出错与空正文都抛（空转述比失败更难被调用方察觉）', async () => {
	await assert.rejects(() => transcribe({
		stream: 假流([]),
		assembler: 假Assembler([], { kind: 'error', failure: { message: 'upstream 503' } }),
	}), /upstream 503/)
	await assert.rejects(() => transcribe({
		stream: 假流([]),
		assembler: 假Assembler([], { kind: 'max-tokens' }),
	}), /truncated/)
	await assert.rejects(() => transcribe({ stream: 假流([]), assembler: 假Assembler([]) }), /空正文/)
	await assert.rejects(() => transcribe({ stream: 假流([]), assembler: 假Assembler([{ type: 'reasoning', text: '只有思考' }]) }), /空正文/)
})
