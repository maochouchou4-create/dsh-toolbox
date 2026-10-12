/**
 * dsh-memory 读侧单测（node:test，零宿主依赖）：slug、读取状态、索引预算、组装。
 * 夹具在临时目录搭建，测后清理；写侧（upsert/delete/lint）在 write.test.js。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	INDEX_CHAR_BUDGET,
	INDEX_LINE_BUDGET,
	RUNAWAY_CEILING,
	applyIndexBudget,
	composeMemory,
	readCapped,
	workspaceSlug,
} from '../lib/memory/core.js'

let base
let memoryRoot

before(() => {
	base = join(tmpdir(), `dsh-memory-test-${process.pid}`)
	memoryRoot = join(base, 'memory')
	mkdirSync(base, { recursive: true })
})

after(() => {
	rmSync(base, { recursive: true, force: true })
})

test('workspaceSlug：分隔符归一、折叠、去首尾、不小写', () => {
	assert.equal(workspaceSlug('/home/nvse/code'), 'home-nvse-code')
	assert.equal(workspaceSlug('D:\\code'), 'D-code')
	assert.equal(workspaceSlug('/a//b'), 'a-b')
	assert.equal(workspaceSlug('C:/Users/mcc'), 'C-Users-mcc')
	assert.equal(workspaceSlug('/home/nvse/code.local'), 'home-nvse-code.local')
})

test('workspaceSlug：全分隔符路径归化为空串（调用方省略该层）', () => {
	assert.equal(workspaceSlug('///'), '')
	assert.equal(workspaceSlug('\\/:'), '')
})

test('workspaceSlug：空串与非字符串抛 TypeError（Fail Fast）', () => {
	assert.throws(() => workspaceSlug(''), TypeError)
	assert.throws(() => workspaceSlug(undefined), TypeError)
	assert.throws(() => workspaceSlug(null), TypeError)
	assert.throws(() => workspaceSlug(42), TypeError)
})

test('readCapped：文件不存在返回 missing（常态，非错误）', () => {
	assert.deepEqual(readCapped(join(base, 'no-such-file.md')), { status: 'missing' })
})

test('readCapped：小文件 ok 且不截断', () => {
	const p = join(base, 'small.md')
	writeFileSync(p, '内容很短', 'utf8')
	const r = readCapped(p)
	assert.equal(r.status, 'ok')
	assert.equal(r.truncated, false)
	assert.equal(r.origChars, '内容很短'.length)
	assert.equal(r.text, '内容很短')
})

test('readCapped：超失控保护时头部截断并显式标注', () => {
	const p = join(base, 'huge.md')
	writeFileSync(p, 'x'.repeat(RUNAWAY_CEILING + 5000), 'utf8')
	const r = readCapped(p)
	assert.equal(r.status, 'ok')
	assert.equal(r.truncated, true)
	assert.equal(r.origChars, RUNAWAY_CEILING + 5000)
	assert.ok(r.text.includes(`仅注入前 ${RUNAWAY_CEILING} 字符`), '截断标注必须显式在场')
	assert.ok(r.text.length > RUNAWAY_CEILING && r.text.length < RUNAWAY_CEILING + 200, '只多出标注行')
})

test('readCapped：文件在但读失败返回 read-error（目录当文件喂入＝EISDIR 确定性触发）', () => {
	const dir = join(base, 'a-directory')
	mkdirSync(dir)
	const r = readCapped(dir)
	assert.equal(r.status, 'read-error')
	assert.ok(typeof r.message === 'string' && r.message.length > 0)
})

test('composeMemory：空树返回空串（不注入）', () => {
	assert.equal(composeMemory({ memoryRoot, cwd: '/home/nvse/code' }), '')
})

test('composeMemory：三层齐备时单串含头＋规则＋习惯层＋工作层，块序正确', () => {
	const profile = join(memoryRoot, 'profile')
	const bucket = join(memoryRoot, 'workspaces', 'home-nvse-code')
	mkdirSync(profile, { recursive: true })
	mkdirSync(bucket, { recursive: true })
	writeFileSync(join(profile, 'WRITING.md'), '写侧纪律正文', 'utf8')
	writeFileSync(join(profile, 'MEMORY.md'), '习惯层索引正文', 'utf8')
	writeFileSync(join(bucket, 'MEMORY.md'), '工作层索引正文', 'utf8')

	const text = composeMemory({ memoryRoot, cwd: '/home/nvse/code' })
	const headerAt = text.indexOf('[记忆索引]')
	const rulesAt = text.indexOf('## 记忆书写（写侧纪律）')
	const profileAt = text.indexOf('## 习惯层（跨机同步）')
	const workspaceAt = text.indexOf('## 工作层（本工作区·本机专属）')
	assert.ok(headerAt !== -1 && rulesAt !== -1 && profileAt !== -1 && workspaceAt !== -1)
	assert.ok(headerAt < rulesAt && rulesAt < profileAt && profileAt < workspaceAt, '块序：头→规则→习惯→工作')
	assert.ok(text.includes('写侧纪律正文') && text.includes('习惯层索引正文') && text.includes('工作层索引正文'))
	assert.ok(text.includes(`基目录：${profile}`) && text.includes(`基目录：${bucket}`))
})

test('composeMemory：cwd 对应桶不存在时无工作层块、其余照常', () => {
	const text = composeMemory({ memoryRoot, cwd: '/home/nvse/other' })
	assert.ok(text.includes('## 习惯层（跨机同步）'))
	assert.ok(!text.includes('## 工作层'))
})

test('composeMemory：cwd 缺失（全局预览装配）时无工作层块、其余照常', () => {
	const text = composeMemory({ memoryRoot })
	assert.ok(text.includes('## 习惯层（跨机同步）'))
	assert.ok(!text.includes('## 工作层'))
})

test('composeMemory：slug 归化为空的 cwd 时无工作层块', () => {
	const text = composeMemory({ memoryRoot, cwd: '///' })
	assert.ok(!text.includes('## 工作层'))
})

test('composeMemory：缺 WRITING.md 时规则块省略、习惯层照常（互不牵连）', () => {
	rmSync(join(memoryRoot, 'profile', 'WRITING.md'), { force: true })
	const text = composeMemory({ memoryRoot, cwd: '/home/nvse/code' })
	assert.ok(!text.includes('记忆书写'))
	assert.ok(text.includes('习惯层索引正文'))
})

test('composeMemory：桶存在但缺 MEMORY.md → onIssue 报 bucket-without-index、无工作层块', () => {
	const bucket = join(memoryRoot, 'workspaces', 'home-nvse-bare')
	mkdirSync(bucket, { recursive: true })
	const issues = []
	const text = composeMemory({ memoryRoot, cwd: '/home/nvse/bare', onIssue: (kind, path) => issues.push([kind, path]) })
	assert.deepEqual(issues.filter(([kind]) => kind === 'bucket-without-index').length, 1)
	assert.ok(!text.includes('home-nvse-bare'))
})

test('composeMemory：读失败 → onIssue 报 read-error、该层省略其余照常', () => {
	// 习惯层 MEMORY.md 用目录顶替文件＝确定性 EISDIR
	const profile = join(memoryRoot, 'profile')
	rmSync(join(profile, 'MEMORY.md'), { force: true })
	mkdirSync(join(profile, 'MEMORY.md'))
	const issues = []
	const text = composeMemory({ memoryRoot, cwd: '/home/nvse/code', onIssue: (kind, path, detail) => issues.push([kind, path, detail]) })
	const readErrors = issues.filter(([kind]) => kind === 'read-error')
	assert.equal(readErrors.length, 1)
	assert.ok(readErrors[0][2].length > 0, 'detail 携带错误信息')
	assert.ok(!text.includes('习惯层索引正文'))
	// 清理：把目录换回文件供后续用例
	rmSync(join(profile, 'MEMORY.md'), { recursive: true })
	writeFileSync(join(profile, 'MEMORY.md'), '习惯层索引正文', 'utf8')
})

test('composeMemory：onIssue 缺省时不抛（旁路诊断可选）', () => {
	assert.doesNotThrow(() => composeMemory({ memoryRoot, cwd: '/home/nvse/bare' }))
})

test('composeMemory：memoryRoot 支持 ~ 展开', () => {
	assert.equal(composeMemory({ memoryRoot: '~/.dsh-memory-test-nonexistent' }), '')
})

/* ===================== 索引预算 ===================== */

test('applyIndexBudget：预算内原样返回', () => {
	const r = applyIndexBudget('# 索引\n- [a](a.md) — **x→查此条**')
	assert.equal(r.truncated, false)
	assert.equal(r.text, '# 索引\n- [a](a.md) — **x→查此条**')
	assert.equal(r.origLines, 2)
})

test('applyIndexBudget：超行预算截断并显式标注', () => {
	const text = Array.from({ length: INDEX_LINE_BUDGET + 5 }, (_, i) => `line-${i}`).join('\n')
	const r = applyIndexBudget(text)
	assert.equal(r.truncated, true)
	assert.ok(r.text.includes(`原文 ${INDEX_LINE_BUDGET + 5} 行`))
	assert.ok(r.text.includes(`仅注入前 ${INDEX_LINE_BUDGET} 行`))
	assert.ok(!r.text.includes(`line-${INDEX_LINE_BUDGET}`), '截断后不含第 201 行')
})

test('applyIndexBudget：行数达标但超字符预算走字符截断', () => {
	// 100 行 × 每行 300 字符 = 30000 字符 > INDEX_CHAR_BUDGET，行数 100 ≤ 200
	const text = Array.from({ length: 100 }, () => '字'.repeat(300)).join('\n')
	const r = applyIndexBudget(text)
	assert.equal(r.truncated, true)
	assert.ok(r.text.includes('仅注入前'))
	assert.ok(r.text.length > INDEX_CHAR_BUDGET && r.text.length < INDEX_CHAR_BUDGET + 200)
})

test('applyIndexBudget：恰 200 行＋尾换行不误报（upsert 产物形态）', () => {
	const text = `${Array.from({ length: INDEX_LINE_BUDGET }, (_, i) => `- [e${i}](e${i}.md) — **x→查此条**`).join('\n')}\n`
	const r = applyIndexBudget(text)
	assert.equal(r.truncated, false)
	assert.equal(r.origLines, INDEX_LINE_BUDGET)
})

test('composeMemory：header-only 空索引的层安静省略（不注入噪声块）', () => {
	const root = join(base, 'empty-index-case')
	const profile = join(root, 'profile')
	const bucket = join(root, 'workspaces', 'home-nvse-empty')
	mkdirSync(profile, { recursive: true })
	mkdirSync(bucket, { recursive: true })
	writeFileSync(join(profile, 'WRITING.md'), '写侧纪律正文', 'utf8')
	writeFileSync(join(profile, 'MEMORY.md'), '# 习惯层索引（使用习惯，跨机同步）\n', 'utf8')
	writeFileSync(join(bucket, 'MEMORY.md'), '# 工作层索引（本机专属，不跨机）\n\n', 'utf8')
	const text = composeMemory({ memoryRoot: root, cwd: '/home/nvse/empty' })
	assert.ok(text.includes('写侧纪律正文'), '规则块照常')
	assert.ok(!text.includes('## 习惯层（跨机同步）'), 'header-only 习惯层省略')
	assert.ok(!text.includes('## 工作层'), 'header-only 工作层省略')
})

test('composeMemory：索引超预算时注入块带截断标注（预算走索引不走失控保护）', () => {
	const root = join(base, 'budget-case')
	const profile = join(root, 'profile')
	mkdirSync(profile, { recursive: true })
	writeFileSync(join(profile, 'MEMORY.md'), Array.from({ length: INDEX_LINE_BUDGET + 10 }, (_, i) => `- [e${i}](e${i}.md) — **x→查此条**`).join('\n'), 'utf8')
	const text = composeMemory({ memoryRoot: root, cwd: '/home/nvse/none' })
	assert.ok(text.includes('索引超预算截断'))
	assert.ok(!text.includes(`[e${INDEX_LINE_BUDGET}]`), '第 201 条索引行不注入')
	assert.ok(existsSync(join(profile, 'MEMORY.md')), '预算只作用于注入串，不动磁盘')
})
