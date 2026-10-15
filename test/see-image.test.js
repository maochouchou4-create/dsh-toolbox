/**
 * see_image 内缝单测（node:test，零宿主依赖）：魔数嗅探＋流终态映射＋附件占位符解析
 * （标识归一／存区根解析／前缀定位对象）＋两个编排函数（入口定位、转写取正文）。
 * 端到端识图质量不在此层（需活宿主＋视觉模型，验收口径见 README）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { finishError, parseAttachmentId, resolveAttachmentObject, resolveAttachmentRoot, resolveTarget, sniffImageMediaType, transcribe } from '../lib/see-image/vision.js'
import { tempRoot } from './helpers.js'

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

test('resolveAttachmentRoot：DSH home 由胶水层注入，~ 展开／带尾斜杠都归一，为空显式拒绝', () => {
	// 求根语义（$DSH_HOME、~ 展开）归宿主 resolveDshHome 那一份，本仓不复刻：
	// 旧实现自己推时漏了 ~ 展开，DSH_HOME='~/.dsh' 那种写法会算出字面量相对路径，
	// 与宿主实际写入分家——症状是「宿主存了图，这里却查不到桶」
	assert.equal(resolveAttachmentRoot(join(tmpdir(), 'dsh-home')), join(tmpdir(), 'dsh-home', 'attachments', 'v1', 'objects'))
	assert.equal(resolveAttachmentRoot('~/.dsh'), join(homedir(), '.dsh', 'attachments', 'v1', 'objects'), '注入值带 ~ 时展开，不产出相对路径')
	assert.equal(resolveAttachmentRoot('/custom/dsh/'), join('/custom/dsh', 'attachments', 'v1', 'objects'), '带尾斜杠归一，不多出一层空目录名')
	assert.throws(() => resolveAttachmentRoot(''), /DSH home/, '空值显式拒绝，不静默退回某个默认目录')
	assert.throws(() => resolveAttachmentRoot('   '), /DSH home/, '空白视同未设，同样显式拒绝')
	assert.throws(() => resolveAttachmentRoot(undefined), /DSH home/)
})

test('resolveAttachmentObject：前缀与全量均唯一命中，返回完整路径与 id', (t) => {
	const root = tempRoot(t, 'objects')
	mkdirSync(join(root, HEX64.slice(0, 2)))
	writeFileSync(join(root, HEX64.slice(0, 2), HEX64), 'x')

	const byPrefix = resolveAttachmentObject(root, '053eb17e')
	assert.equal(byPrefix.id, HEX64)
	assert.equal(byPrefix.path, join(root, HEX64.slice(0, 2), HEX64))

	const byFullId = resolveAttachmentObject(root, HEX64)
	assert.equal(byFullId.id, HEX64)
})

test('resolveAttachmentObject：零命中／歧义／缺桶均显式报错', (t) => {
	const root = tempRoot(t, 'objects')
	mkdirSync(join(root, HEX64.slice(0, 2)))
	writeFileSync(join(root, HEX64.slice(0, 2), HEX64), 'x')
	assert.throws(() => resolveAttachmentObject(root, '053eb17f'), /没有以 053eb17f 开头的对象/)

	const sibling = '053eb17e'.padEnd(64, 'f')
	writeFileSync(join(root, HEX64.slice(0, 2), sibling), 'x')
	assert.throws(() => resolveAttachmentObject(root, '053eb17e'), /命中 2 个对象.*加长前缀/)

	assert.throws(() => resolveAttachmentObject(root, 'ffffffff'), /没有桶/, '桶不存在时报可诊断路径')
})

/** 存区根取用函数：只有占位符分支会问它（求根失败不许拖垮磁盘路径入口）。 */
const 取根 = () => {
	throw new Error('磁盘路径入口不该问存区根')
}

/** ctx 替身：只实现 resolveTarget 问得到的服务成员，记下每次调用便于断言。 */
const 假Ctx = () => {
	const calls = []
	return {
		calls,
		fs: {
			async resolve(path, options) {
				calls.push({ method: 'fs.resolve', path, cwd: options?.cwd })
				return { targetKey: path, displayPath: path }
			},
		},
	}
}

/** 带会话活目录的执行上下文替身：cwd 走会话 header（宿主 rc.2 的口径，见 lib/working-dir.js）。 */
const 假Exec = (cwd) => ({ agent: cwd === undefined ? undefined : { session: { header: { cwd } } }, signal: 'SIG' })

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
	const r = await resolveTarget(ctx, { path: 'shots/a.png' }, 假Exec('/work/live'), 取根)
	assert.equal(r.target.displayPath, 'shots/a.png')
	assert.equal(r.sourceName, 'a.png', '存附件时的文件名取 basename，不是整条路径')
	assert.equal(r.attachmentId, undefined, 'path 分支没有 sha256 可回显')
	assert.deepEqual(ctx.calls, [{ method: 'fs.resolve', path: 'shots/a.png', cwd: '/work/live' }], '磁盘路径入口不碰存区根（取根函数被问就会抛）')
})

test('resolveTarget：无会话上下文的调用不带 cwd（交由 fs 服务默认解析）', async () => {
	const ctx = 假Ctx()
	const r = await resolveTarget(ctx, { path: '/abs/b.png' }, 假Exec(undefined), 取根)
	assert.equal(r.sourceName, 'b.png')
	assert.deepEqual(ctx.calls, [{ method: 'fs.resolve', path: '/abs/b.png', cwd: undefined }])
})

test('resolveTarget：attachment 分支按前缀定位对象，sourceName 与 attachmentId 同为完整 id', async (t) => {
	const root = tempRoot(t, 'objects')
	mkdirSync(join(root, HEX64.slice(0, 2)))
	writeFileSync(join(root, HEX64.slice(0, 2), HEX64), 'x')
	const ctx = 假Ctx()
	const r = await resolveTarget(ctx, { attachment: `SHA256:053eb17e` }, { agent: undefined, signal: undefined }, () => root)
	assert.equal(r.target.displayPath, join(root, HEX64.slice(0, 2), HEX64))
	assert.equal(r.sourceName, HEX64)
	assert.equal(r.attachmentId, HEX64, '占位符分支回显完整 id，调用方据此拼 sha256: 前缀')
	assert.deepEqual(ctx.calls, [{ method: 'fs.resolve', path: join(root, HEX64.slice(0, 2), HEX64), cwd: undefined }], '占位符入口同样不问会话活目录')
})

test('resolveTarget：path 与 attachment 都给或都不给即拦（两条入口互斥）', async () => {
	const ctx = 假Ctx()
	await assert.rejects(() => resolveTarget(ctx, {}, { agent: undefined, signal: undefined }, 取根), /二选一/)
	await assert.rejects(() => resolveTarget(ctx, { path: 'a.png', attachment: '053eb17e' }, { agent: undefined, signal: undefined }, 取根), /二选一/)
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
