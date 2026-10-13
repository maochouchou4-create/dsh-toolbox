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
import { finishError, parseAttachmentId, resolveAttachmentObject, resolveAttachmentRoot, sniffImageMediaType } from '../lib/see-image/vision.js'

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
