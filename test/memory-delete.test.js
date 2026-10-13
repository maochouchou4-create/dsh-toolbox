/**
 * dsh-memory delete 动作单测（node:test，零宿主依赖）：删文＋跨层 wikilink 引用报告、
 * 被删条目的派生索引行随之退场。
 * 夹具仍经 upsert 建条目（建条目只有写侧一条通道），delete 本身是同步函数——它的 I/O
 * 按设计留在 node:fs，一次调用内无 await 点。「会话策略拒写时三个动作全拒」那条跨动作
 * 用例留在 memory-write.test.js：它三个动作都碰，拆开就不是同一个用例了。
 * 每个用例独立临时根，互不共享状态。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeMemory } from '../lib/memory/assemble.js'
import { deleteEntry } from '../lib/memory/delete.js'
import { createNodeFsPort } from '../lib/memory/fs-port.js'
import { upsertEntry } from '../lib/memory/write.js'

let base
const port = createNodeFsPort()

before(() => {
	base = join(tmpdir(), `dsh-memory-delete-test-${process.pid}`)
	mkdirSync(base, { recursive: true })
})

after(() => {
	rmSync(base, { recursive: true, force: true })
})

/** 条目正文夹具：frontmatter 两键＋正文。 */
const entry = (title, description, body = '正文') => `---\ntitle: ${title}\ndescription: ${description}\n---\n\n${body}\n`

test('deleteEntry：删文＋跨层 wikilink 引用报告（delete 族同步走 node:fs）', async () => {
	const root = join(base, 'delete-case')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'gone.md', content: entry('被删条目', '触发词') })
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'stays.md', content: entry('留下条目', '触发词', '引用 [[gone]] 一处，另有 [[toolkit]] 不可计作别条引用') })
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'tool.md', content: entry('工具条目', '触发词') })
	const r = deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'gone.md' })
	assert.equal(existsSync(join(r.dir, 'gone.md')), false)
	assert.equal(r.references.length, 1)
	assert.ok(r.references[0].includes(join('stays.md:6')))
	assert.equal(r.scanError, '')
	assert.throws(() => deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'gone.md' }), /不存在/)
	assert.throws(() => deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'Bad_Name.md' }), /kebab/)
	assert.throws(() => deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'memory.md' }), /保留名/)
	// 前缀子串不误报：[[toolkit]] 不构成对 tool.md 的引用
	const rt = deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'tool.md' })
	assert.equal(rt.references.length, 0, '[[toolkit]] 是另一个 stem，不得计作 [[tool]] 的引用')
})

test('deleteEntry：引用扫描逐文件降级（病态文件只废自己那份，余下目录照扫）', async () => {
	const root = join(base, 'delete-degrade')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'gone.md', content: entry('被删条目', '触发词') })
	// 病态件放在先扫的 habit 层、引用件放在后扫的 workspace 层：目录枚举顺序由层决定，
	// 与 readdir 的返回序无关，所以「abort 后余下目录全停」这件事必现，断言不靠运气
	mkdirSync(join(root, 'profile', 'x.md'), { recursive: true })
	await upsertEntry({ port, memoryRoot: root, layer: 'workspace', cwd: '/home/nvse/probe', file: 'stays.md', content: entry('留下条目', '触发词', '引用 [[gone]] 一处') })
	const r = deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'gone.md' })
	assert.equal(existsSync(join(r.dir, 'gone.md')), false, '主操作照常成功，降级只作用于附属报告')
	assert.ok(r.scanError.includes(join('profile', 'x.md')), `降级文件名要进 scanError，实际 ${r.scanError}`)
	assert.equal(r.references.length, 1, '病态文件之后的层仍须扫完')
	assert.ok(r.references[0].includes(join('stays.md:6')))
})

test('deleteEntry：被删条目的索引行随之退场（索引是派生的，无文件即无行）', async () => {
	const root = join(base, 'delete-derived')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'gone.md', content: entry('被删条目', '触发词') })
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'stays.md', content: entry('留下条目', '触发词') })
	assert.ok(composeMemory({ memoryRoot: root }).includes('- [被删条目](gone.md)'))
	deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'gone.md' })
	const text = composeMemory({ memoryRoot: root })
	assert.ok(!text.includes('gone.md'), '删条目后派生索引行必须消失')
	assert.ok(text.includes('- [留下条目](stays.md) — 触发词'))
})
