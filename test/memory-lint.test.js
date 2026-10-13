/**
 * dsh-memory lint 动作单测（node:test，零宿主依赖）：frontmatter 契约／预算边界／
 * 日期戳与超长／失控保护／接线与桶／病态输入逐处降级。
 * 体检按设计全程留在 node:fs（本层无写动作，故不接端口、不 async），用例不碰 upsert。
 * 每个用例独立临时根，互不共享状态。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INDEX_CHAR_BUDGET, INDEX_LINE_BUDGET, INDEX_LINE_CHAR_BUDGET, RUNAWAY_CEILING } from '../lib/memory/core.js'
import { lintMemory } from '../lib/memory/lint.js'

let base

before(() => {
	base = join(tmpdir(), `dsh-memory-lint-test-${process.pid}`)
	mkdirSync(base, { recursive: true })
})

after(() => {
	rmSync(base, { recursive: true, force: true })
})

/** 条目正文夹具：frontmatter 两键＋正文。 */
const entry = (title, description, body = '正文') => `---\ntitle: ${title}\ndescription: ${description}\n---\n\n${body}\n`

test('lintMemory：frontmatter 契约/超长/日期戳/死链/超预算全覆盖，干净夹具 ok', () => {
	const root = join(base, 'lint-case')
	const profile = join(root, 'profile')
	const bucket = join(root, 'workspaces', 'D-code')
	mkdirSync(bucket, { recursive: true })
	mkdirSync(profile, { recursive: true })
	writeFileSync(join(profile, 'good.md'), entry('好条目', '触发词', 'x 引 [[missing]]'), 'utf8')
	writeFileSync(join(profile, 'bare.md'), '没有 frontmatter\n', 'utf8')
	writeFileSync(join(profile, 'extra.md'), '---\nname: extra\ntitle: 多余键\ndescription: 触发词\n---\n\n正文\n', 'utf8')
	// 工作层：超预算索引（条目数超行预算）
	for (let i = 0; i < INDEX_LINE_BUDGET + 3; i += 1) writeFileSync(join(bucket, `f${String(i).padStart(3, '0')}.md`), entry(`条目${i}`, '触发词'), 'utf8')
	const report = lintMemory({ memoryRoot: root, cwd: 'D:\\code' })
	assert.equal(report.ok, false)
	assert.ok(report.warnings.some((w) => w.includes('frontmatter 不合规') && w.includes('bare.md')))
	assert.ok(report.warnings.some((w) => w.includes('frontmatter 不合规') && w.includes('extra.md') && w.includes('多余键')))
	assert.ok(report.warnings.some((w) => w.includes('死 wikilink [[missing]]')))
	assert.ok(report.warnings.some((w) => w.includes('派生索引超预算')))
	assert.ok(!report.warnings.some((w) => w.includes('孤儿条目') || w.includes('死索引行')), '索引是派生的，这两类检查已退役')

	const cleanRoot = join(base, 'lint-clean')
	mkdirSync(join(cleanRoot, 'profile'), { recursive: true })
	writeFileSync(join(cleanRoot, 'profile', 'only.md'), entry('唯一条目', '触发词'), 'utf8')
	const clean = lintMemory({ memoryRoot: cleanRoot })
	assert.equal(clean.ok, true)
	assert.deepEqual(clean.warnings, [])
})

test('lintMemory：恰满行/恰满字符预算都不误报超预算（边界只拦超出侧）', () => {
	// 判定是 `>`（lint.js:89），差一个字符就是误报；两个预算各钉一次边界
	const lineRoot = join(base, 'lint-edge-lines')
	const lineDir = join(lineRoot, 'profile')
	mkdirSync(lineDir, { recursive: true })
	for (let i = 0; i < INDEX_LINE_BUDGET; i += 1) {
		writeFileSync(join(lineDir, `f${String(i).padStart(3, '0')}.md`), entry(`条目${i}`, '触发词'), 'utf8')
	}
	const atLine = lintMemory({ memoryRoot: lineRoot })
	assert.ok(!atLine.warnings.some((w) => w.includes('派生索引超预算')), `恰 ${INDEX_LINE_BUDGET} 行不误报`)
	writeFileSync(join(lineDir, 'overflow.md'), entry('溢出一条', '触发词'), 'utf8')
	assert.ok(lintMemory({ memoryRoot: lineRoot }).warnings.some((w) => w.includes('派生索引超预算')), `第 ${INDEX_LINE_BUDGET + 1} 行即报`)

	// 字符预算用单条打满：派生行 ＝ 固定前缀 ＋ description，每多一字索引总长恰好多一字符
	const charRoot = join(base, 'lint-edge-chars')
	const charDir = join(charRoot, 'profile')
	mkdirSync(charDir, { recursive: true })
	const prefixLength = '- [长条目](long.md) — '.length
	const atBudget = '词'.repeat(INDEX_CHAR_BUDGET - prefixLength)
	writeFileSync(join(charDir, 'long.md'), entry('长条目', atBudget), 'utf8')
	const atChar = lintMemory({ memoryRoot: charRoot })
	assert.ok(!atChar.warnings.some((w) => w.includes('派生索引超预算')), `派生行恰 ${INDEX_CHAR_BUDGET} 字符不误报`)
	writeFileSync(join(charDir, 'long.md'), entry('长条目', `${atBudget}词`), 'utf8')
	assert.ok(lintMemory({ memoryRoot: charRoot }).warnings.some((w) => w.includes('派生索引超预算')), '多一字符即报')
})

test('lintMemory：派生索引行超长与 description 日期戳各报一项（warning 不阻断）', () => {
	const root = join(base, 'lint-long')
	const dir = join(root, 'profile')
	mkdirSync(dir, { recursive: true })
	const long = '词'.repeat(INDEX_LINE_CHAR_BUDGET)
	writeFileSync(join(dir, 'long.md'), entry('长条目', long), 'utf8')
	writeFileSync(join(dir, 'dated.md'), entry('带日期戳的条目', '2026-01-02 记'), 'utf8')
	const report = lintMemory({ memoryRoot: root })
	assert.equal(report.ok, false)
	assert.ok(report.warnings.some((w) => w.includes('超') && w.includes(String(INDEX_LINE_CHAR_BUDGET)) && w.includes('long.md')))
	assert.ok(report.warnings.some((w) => w.includes('日期戳') && w.includes('dated.md')))
	// 文案与写侧共用一份，体检侧拿到的必须带写侧那两段引导语（体检是写侧的离线镜像，
	// 镜像不得比本体弱）：日期戳指向纪律出处，超长给收敛方向
	assert.ok(report.warnings.some((w) => w.includes('日期戳') && w.includes('WRITING.md')), '日期戳告警须指向写侧纪律出处')
	assert.ok(report.warnings.some((w) => w.includes('收敛 description')), '派生行超长告警须给收敛方向')
})

test('lintMemory：缺习惯层接线/日期戳/失控保护/无桶提示', () => {
	const root = join(base, 'lint-wire')
	mkdirSync(join(root, 'workspaces', 'D-code'), { recursive: true })
	writeFileSync(join(root, 'workspaces', 'D-code', 'loose.md'), entry('散条目', '触发词'), 'utf8')
	const report = lintMemory({ memoryRoot: root, cwd: 'D:\\code' })
	assert.ok(report.warnings.some((w) => w.includes('习惯层接线缺失')), '根无 profile 目录')
	const noBucket = lintMemory({ memoryRoot: root, cwd: 'D:\\other' })
	assert.ok(noBucket.warnings.some((w) => w.includes('尚无桶')), '新工作区常态提示')
	// 条目超失控保护：lint 唯一体检项断言（写侧另有拦截测试）
	const hugeRoot = join(base, 'lint-huge')
	const hugeDir = join(hugeRoot, 'profile')
	mkdirSync(hugeDir, { recursive: true })
	writeFileSync(join(hugeDir, 'big.md'), `${entry('大条目', '触发词')}${'x'.repeat(RUNAWAY_CEILING)}\n`, 'utf8')
	const huge = lintMemory({ memoryRoot: hugeRoot })
	assert.ok(huge.warnings.some((w) => w.includes('失控保护') && w.includes('big.md')))
})

test('lintMemory：病态输入逐处降级报 warning，体检自身不崩（EISDIR 确定性触发）', () => {
	const root = join(base, 'lint-degraded')
	const profile = join(root, 'profile')
	mkdirSync(profile, { recursive: true })
	writeFileSync(join(profile, 'good.md'), entry('好条目', '触发词'), 'utf8')
	// x.md 名字的目录：readdirSync 列出它，readFileSync 抛 EISDIR——确定性病态输入
	mkdirSync(join(profile, 'x.md'))
	const report = lintMemory({ memoryRoot: root })
	assert.equal(report.ok, false)
	assert.ok(report.warnings.some((w) => w.includes('条目读取失败') && w.includes('x.md')))
	assert.ok(!report.warnings.some((w) => w.includes('frontmatter 不合规') && w.includes('good.md')), '好条目不受邻近病态牵连')
})
