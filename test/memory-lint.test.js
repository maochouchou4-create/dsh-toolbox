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
import { entry } from './helpers.js'

let base

before(() => {
	base = join(tmpdir(), `dsh-memory-lint-test-${process.pid}`)
	mkdirSync(base, { recursive: true })
})

after(() => {
	rmSync(base, { recursive: true, force: true })
})

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

test('lintMemory：层内 title 重名点名撞上的条目，跨层同名不算撞（判据＝同层同 title 字段）', () => {
	const root = join(base, 'lint-dup-title')
	const profile = join(root, 'profile')
	const bucket = join(root, 'workspaces', 'D-code')
	mkdirSync(profile, { recursive: true })
	mkdirSync(bucket, { recursive: true })
	// 同层同 title、文件名各不同：写侧 assertTitleFree 正是按 frontmatter 的 title 字段拦的，
	// 按文件名判的话这一组根本不会被拦——两条判据必须落在同一处
	writeFileSync(join(profile, 'alpha.md'), entry('撞名标题', '触发词甲'), 'utf8')
	writeFileSync(join(profile, 'beta.md'), entry('撞名标题', '触发词乙'), 'utf8')
	writeFileSync(join(profile, 'gamma.md'), entry('独一份', '触发词丙'), 'utf8')
	// 跨层同名不算撞：写侧扫的是一个层目录，工作层同名不挡习惯层写入，按层分组同理
	writeFileSync(join(bucket, 'delta.md'), entry('撞名标题', '触发词丁'), 'utf8')
	const report = lintMemory({ memoryRoot: root, cwd: 'D:\\code' })
	assert.equal(report.ok, false)
	const dup = report.warnings.filter((w) => w.includes('层内 title 重名'))
	assert.equal(dup.length, 1, '只报撞名的那一组')
	assert.ok(dup[0].includes('撞名标题'), '告警须指出撞的是哪个 title')
	assert.ok(dup[0].includes('alpha.md') && dup[0].includes('beta.md'), '告警须点名撞上的两条')
	assert.ok(!dup[0].includes('delta.md'), '跨层同名不进这一组')
	assert.ok(!dup[0].includes('gamma.md'), '未撞名的条目不牵进来')
	// 处置给 edit 不给 delete：报出来的两条是各自带正文的现存条目，title 与文件名本就是
	// 两回事，照着「先删」做丢的是正文（写侧报错同一口径，两边由同一处渲染）
	assert.ok(dup[0].includes(profile), '告警须带层目录路径，否则跨桶同名无从定位到文件')
	assert.ok(dup[0].includes('edit'), '须给出无损的处置：edit 改 frontmatter 的 title 行')
	assert.ok(!dup[0].includes('先 delete 再改名'), '不得复刻「先 delete 再改名」——撞上的不是待写那条的旧版本')
	// frontmatter 不合规的条目 title 不可知，不占坑也不被当成无同名（写侧对它是另一条专门口径）
	writeFileSync(join(profile, 'broken.md'), '没有 frontmatter\n', 'utf8')
	const after = lintMemory({ memoryRoot: root, cwd: 'D:\\code' })
	const afterDup = after.warnings.filter((w) => w.includes('层内 title 重名'))
	assert.equal(afterDup.length, 1, '坏条目不改变撞名判定')
	// 但要说得出「这条的 title 一次都没被比较过」：重名结论只覆盖其余条目，别让读者以为覆盖了整层。
	// 覆盖面缺口独立成条（不挂在撞名那条尾巴上），故在这里查它自己那一条
	const coverage = after.warnings.filter((w) => w.includes('title 判不了'))
	assert.equal(coverage.length, 1, '覆盖面缺口独立成一条，不随撞名组数增减')
	assert.ok(coverage[0].includes('1 条 title 判不了') && coverage[0].includes('broken.md'), '须说得出有几条判不了、是哪些：坏条目的 title 压根没参与比较')
})

test('lintMemory：有 title 判不了的条目而本层不撞名，覆盖面缺口照样单独立一条（挂在撞名尾巴上时不撞名就一个字都不说）', () => {
	const root = join(base, 'lint-coverage-alone')
	const profile = join(root, 'profile')
	mkdirSync(profile, { recursive: true })
	writeFileSync(join(profile, 'good.md'), entry('独一份', '触发词'), 'utf8')
	writeFileSync(join(profile, 'broken.md'), '没有 frontmatter\n', 'utf8')
	const report = lintMemory({ memoryRoot: root })
	assert.equal(report.warnings.filter((w) => w.includes('层内 title 重名')).length, 0, '本层不撞名就不该报撞名')
	const coverage = report.warnings.filter((w) => w.includes('title 判不了'))
	assert.equal(coverage.length, 1, '覆盖面缺口与有无撞名无关，各说各的')
	assert.ok(coverage[0].includes('broken.md') && coverage[0].includes('重名结论只覆盖其余条目'), coverage[0])
})

test('lintMemory：层目录清点抛错即中止并点名（workspaces 是文件＝确定性触发）', () => {
	const root = join(base, 'lint-layer-enum-fail')
	mkdirSync(join(root, 'profile'), { recursive: true })
	writeFileSync(join(root, 'profile', 'only.md'), entry('唯一条目', '触发词'), 'utf8')
	// workspaces 放文件而不是目录：层清点那一步只判存在性，于是它「在场」而 readdirSync 抛
	// ENOTDIR。清点失败与逐处降级不同——层目录清单都没有，逐层体检无从谈起，只能中止
	writeFileSync(join(root, 'workspaces'), '不是目录\n', 'utf8')
	const report = lintMemory({ memoryRoot: root })
	assert.equal(report.ok, false)
	assert.deepEqual(report.warnings.map((w) => w.split('：')[0]), ['层清点失败（体检中止）'], '中止型失败须单独立一条，且不得再往下报别的')
	assert.ok(report.warnings[0].includes('ENOTDIR'), '须带上底层错误信息，否则读者无从判断是自己没接线还是盘坏了')
})

test('lintMemory：条目清点失败退回保留 stem 集（死链判定降级），同一次里目录读取失败各报一条', () => {
	// 先钉对照：接线正常时，同层在场的条目不是死链（否则后面那条误报证明不了降级生效）
	const healthy = join(base, 'lint-stems-healthy')
	const healthyBucket = join(healthy, 'workspaces', 'home-nvse-code')
	mkdirSync(healthyBucket, { recursive: true })
	writeFileSync(join(healthyBucket, 'present.md'), entry('在场条目', '触发词'), 'utf8')
	writeFileSync(join(healthyBucket, 'linker.md'), entry('引用条目', '触发词', '见 [[present]] 一处'), 'utf8')
	assert.equal(lintMemory({ memoryRoot: healthy }).warnings.filter((w) => w.includes('死 wikilink')).length, 0, '对照：stem 集完整时在场条目不判死链')

	const root = join(base, 'lint-stems-degraded')
	const bucket = join(root, 'workspaces', 'home-nvse-code')
	mkdirSync(bucket, { recursive: true })
	writeFileSync(join(bucket, 'present.md'), entry('在场条目', '触发词'), 'utf8')
	writeFileSync(join(bucket, 'linker.md'), entry('引用条目', '触发词', '见 [[present]] 一处'), 'utf8')
	// 习惯层是文件：全库 stem 清点与逐层列目录读的都是它，同一个病态输入一次点着两条出口
	// （层清点那一步不抛——它只判 profile 存在，而文件也算存在）
	writeFileSync(join(root, 'profile'), '不是目录\n', 'utf8')
	const report = lintMemory({ memoryRoot: root })
	assert.ok(report.warnings.some((w) => w.includes('条目清点失败') && w.includes('死链判定降级')), 'stem 清点失败须点名它降级到哪一步')
	assert.ok(report.warnings.some((w) => w.includes('目录读取失败') && w.includes(join(root, 'profile'))), '层目录读不动须报到层与路径')
	// 降级真的生效：stems 退回保留集，于是同层在场的条目被误报成死链。这条误报不是缺陷而是
	// 症状——「覆盖面已经不可知」若一点声音都没有，降级就等于静默
	assert.ok(report.warnings.some((w) => w.includes('死 wikilink [[present]]')), 'stems 不可知时，在场条目被判死链＝降级生效的可见症状')
	assert.ok(!report.warnings.some((w) => w.includes('条目读取失败')), '读文件那一步没病，别混报')
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
