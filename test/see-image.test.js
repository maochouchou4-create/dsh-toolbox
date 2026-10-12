/**
 * see_image 内缝纯函数单测（node:test，零宿主依赖）：魔数嗅探＋流终态映射。
 * 端到端识图质量不在此层（需活宿主＋视觉模型，验收口径见 README）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finishError, sniffImageMediaType } from '../lib/see-image/vision.js'

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
