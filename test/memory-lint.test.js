/**
 * dsh-memory lint 动作单测（node:test，零宿主依赖）：frontmatter 契约／预算边界／
 * 日期戳与超长／失控保护／接线与机器身份／病态输入逐处降级。
 * 体检按设计全程留在 node:fs（本层无写动作，故不接端口、不 async），用例不碰 upsert。
 * 每个用例独立临时根，互不共享状态。
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { INDEX_CHAR_BUDGET, INDEX_LINE_BUDGET, INDEX_LINE_CHAR_BUDGET, RUNAWAY_CEILING } from '../lib/memory/core.js'
import { lintMemory } from '../lib/memory/lint.js'
import { entry, memoryTree, tempRoot } from './helpers.js'

let base

before((t) => {
	base = tempRoot(t, 'memory-lint')
})

test('lintMemory：frontmatter 契约/超长/日期戳/死链/超预算全覆盖，干净夹具 ok', () => {
	const { root, store, machineDir } = memoryTree(base, 'lint-case', 'home')
	writeFileSync(join(store, 'good.md'), entry('好条目', '触发词', 'x 引 [[missing]]'), 'utf8')
	writeFileSync(join(store, 'bare.md'), '没有 frontmatter\n', 'utf8')
	writeFileSync(join(store, 'extra.md'), '---\nname: extra\ntitle: 多余键\ndescription: 触发词\n---\n\n正文\n', 'utf8')
	// 本机段：超预算索引（条目数超行预算）
	for (let i = 0; i < INDEX_LINE_BUDGET + 3; i += 1) writeFileSync(join(machineDir, `f${String(i).padStart(3, '0')}.md`), entry(`条目${i}`, '触发词'), 'utf8')
	const report = lintMemory({ memoryRoot: root, machine: 'home' })
	assert.equal(report.ok, false)
	assert.equal(report.machine, 'home', '配置了机器身份＝身份字段在场（写入失败时重试不用再猜是哪台）')
	assert.ok(report.warnings.some((w) => w.includes('frontmatter 不合规') && w.includes('bare.md')))
	assert.ok(report.warnings.some((w) => w.includes('frontmatter 不合规') && w.includes('extra.md') && w.includes('多余键')))
	assert.ok(report.warnings.some((w) => w.includes('死 wikilink [[missing]]')))
	assert.ok(report.warnings.some((w) => w.includes('派生索引超预算')))
	assert.ok(!report.warnings.some((w) => w.includes('孤儿条目') || w.includes('死索引行')), '索引是派生的，这两类检查已退役')

	const cleanRoot = join(base, 'lint-clean')
	mkdirSync(join(cleanRoot, 'memory'), { recursive: true })
	writeFileSync(join(cleanRoot, 'memory', 'only.md'), entry('唯一条目', '触发词'), 'utf8')
	const clean = lintMemory({ memoryRoot: cleanRoot, machine: 'home' })
	assert.equal(clean.ok, true)
	assert.deepEqual(clean.warnings, [])
})

test('lintMemory：机器身份未配置判红且身份字段缺席（不是 null——宿主验返回值 null 会报错）', () => {
	const { root } = memoryTree(base, 'lint-no-machine')
	writeFileSync(join(root, 'memory', 'only.md'), entry('唯一条目', '触发词'), 'utf8')
	const report = lintMemory({ memoryRoot: root })
	assert.equal(report.ok, false, '未配置机器身份＝配置不完整，判红促修')
	assert.ok(report.warnings.some((w) => w.includes('机器身份未配置') && w.includes('config.machine')))
	assert.ok(!Object.hasOwn(report, 'machine'), '未配置时机器字段整键缺席：给 undefined 也算带了这个键（与「配了但没读到」混同）')
	// 配了机器身份的那一趟没有这一条，且身份字段在场——两个方向各钉一次
	const configured = lintMemory({ memoryRoot: root, machine: 'home' })
	assert.ok(!configured.warnings.some((w) => w.includes('机器身份未配置')))
	assert.equal(configured.machine, 'home')
})

test('lintMemory：恰满行/恰满字符预算都不误报超预算（边界只拦超出侧）', () => {
	// 判定是 `>`（lint.js 的派生索引超预算那一处），差一个字符就是误报；两个预算各钉一次边界
	const lineRoot = join(base, 'lint-edge-lines')
	const lineDir = join(lineRoot, 'memory')
	mkdirSync(lineDir, { recursive: true })
	for (let i = 0; i < INDEX_LINE_BUDGET; i += 1) {
		writeFileSync(join(lineDir, `f${String(i).padStart(3, '0')}.md`), entry(`条目${i}`, '触发词'), 'utf8')
	}
	const atLine = lintMemory({ memoryRoot: lineRoot, machine: 'home' })
	assert.ok(!atLine.warnings.some((w) => w.includes('派生索引超预算')), `恰 ${INDEX_LINE_BUDGET} 行不误报`)
	writeFileSync(join(lineDir, 'overflow.md'), entry('溢出一条', '触发词'), 'utf8')
	assert.ok(lintMemory({ memoryRoot: lineRoot, machine: 'home' }).warnings.some((w) => w.includes('派生索引超预算')), `第 ${INDEX_LINE_BUDGET + 1} 行即报`)

	// 字符预算用单条打满：派生行 ＝ 固定前缀 ＋ description，每多一字索引总长恰好多一字符
	const charRoot = join(base, 'lint-edge-chars')
	const charDir = join(charRoot, 'memory')
	mkdirSync(charDir, { recursive: true })
	const prefixLength = '- [长条目](long.md) — '.length
	const atBudget = '词'.repeat(INDEX_CHAR_BUDGET - prefixLength)
	writeFileSync(join(charDir, 'long.md'), entry('长条目', atBudget), 'utf8')
	const atChar = lintMemory({ memoryRoot: charRoot, machine: 'home' })
	assert.ok(!atChar.warnings.some((w) => w.includes('派生索引超预算')), `派生行恰 ${INDEX_CHAR_BUDGET} 字符不误报`)
	writeFileSync(join(charDir, 'long.md'), entry('长条目', `${atBudget}词`), 'utf8')
	assert.ok(lintMemory({ memoryRoot: charRoot, machine: 'home' }).warnings.some((w) => w.includes('派生索引超预算')), '多一字符即报')
})

test('lintMemory：派生索引行超长与 description 日期戳各报一项（warning 不阻断）', () => {
	const root = join(base, 'lint-long')
	const dir = join(root, 'memory')
	mkdirSync(dir, { recursive: true })
	const long = '词'.repeat(INDEX_LINE_CHAR_BUDGET)
	writeFileSync(join(dir, 'long.md'), entry('长条目', long), 'utf8')
	writeFileSync(join(dir, 'dated.md'), entry('带日期戳的条目', '2026-01-02 记'), 'utf8')
	const report = lintMemory({ memoryRoot: root, machine: 'home' })
	assert.equal(report.ok, false)
	assert.ok(report.warnings.some((w) => w.includes('超') && w.includes(String(INDEX_LINE_CHAR_BUDGET)) && w.includes('long.md')))
	assert.ok(report.warnings.some((w) => w.includes('日期戳') && w.includes('dated.md')))
	// 文案与写侧共用一份，体检侧拿到的必须带写侧那两段引导语（体检是写侧的离线镜像，
	// 镜像不得比本体弱）：日期戳指向纪律出处，超长给收敛方向
	assert.ok(report.warnings.some((w) => w.includes('日期戳') && w.includes('WRITING.md')), '日期戳告警须指向写侧纪律出处')
	assert.ok(report.warnings.some((w) => w.includes('收敛 description')), '派生行超长告警须给收敛方向')
})

test('lintMemory：缺共享段接线与条目超失控保护各报一条', () => {
	const bare = join(base, 'lint-no-store')
	mkdirSync(bare, { recursive: true })
	const noStore = lintMemory({ memoryRoot: bare, machine: 'home' })
	assert.ok(noStore.warnings.some((w) => w.includes('共享段接线缺失')), '根下没有 store 目录（接线缺失）')

	// store 在场而机器段缺席**不报错**：空目录与首跑不可区分，那一条判给离线自检
	// （check:memory 的 machine-arg），体检不做
	const noMachineDir = join(base, 'lint-no-machine-dir')
	mkdirSync(join(noMachineDir, 'memory'), { recursive: true })
	writeFileSync(join(noMachineDir, 'memory', 'only.md'), entry('唯一条目', '触发词'), 'utf8')
	assert.deepEqual(lintMemory({ memoryRoot: noMachineDir, machine: 'home' }).warnings, [], 'store 在场且语料健康＝零 warning：机器段缺席这件事体检一个字都不说')

	// 条目超失控保护：lint 唯一体检项断言（写侧另有拦截测试）
	const hugeRoot = join(base, 'lint-huge')
	const hugeDir = join(hugeRoot, 'memory')
	mkdirSync(hugeDir, { recursive: true })
	writeFileSync(join(hugeDir, 'big.md'), `${entry('大条目', '触发词')}${'x'.repeat(RUNAWAY_CEILING)}\n`, 'utf8')
	const huge = lintMemory({ memoryRoot: hugeRoot, machine: 'home' })
	assert.ok(huge.warnings.some((w) => w.includes('失控保护') && w.includes('big.md')))
})

test('lintMemory：段内 title 重名点名撞上的条目，跨段同名不算撞（判据＝同段同 title 字段）', () => {
	const { root, store, machineDir } = memoryTree(base, 'lint-dup-title', 'home')
	// 同段同 title、文件名各不同：写侧 assertTitleFree 正是按 frontmatter 的 title 字段拦的，
	// 按文件名判的话这一组根本不会被拦——两条判据必须落在同一处
	writeFileSync(join(store, 'alpha.md'), entry('撞名标题', '触发词甲'), 'utf8')
	writeFileSync(join(store, 'beta.md'), entry('撞名标题', '触发词乙'), 'utf8')
	writeFileSync(join(store, 'gamma.md'), entry('独一份', '触发词丙'), 'utf8')
	// 跨段同名不算撞：写侧扫的是一个段目录，本机段同名不挡共享段写入，按段分组同理
	writeFileSync(join(machineDir, 'delta.md'), entry('撞名标题', '触发词丁'), 'utf8')
	const report = lintMemory({ memoryRoot: root, machine: 'home' })
	assert.equal(report.ok, false)
	const dup = report.warnings.filter((w) => w.includes('段内 title 重名'))
	assert.equal(dup.length, 1, '只报撞名的那一组')
	assert.ok(dup[0].includes('撞名标题'), '告警须指出撞的是哪个 title')
	assert.ok(dup[0].includes('alpha.md') && dup[0].includes('beta.md'), '告警须点名撞上的两条')
	assert.ok(!dup[0].includes('delta.md'), '跨段同名不进这一组')
	assert.ok(!dup[0].includes('gamma.md'), '未撞名的条目不牵进来')
	// 处置给 edit 不给 delete：报出来的两条是各自带正文的现存条目，title 与文件名本就是
	// 两回事，照着「先删」做丢的是正文（写侧报错同一口径，两边由同一处渲染）
	assert.ok(dup[0].includes(store), '告警须带段目录路径，否则跨段同名无从定位到文件')
	assert.ok(dup[0].includes('edit'), '须给出无损的处置：edit 改 frontmatter 的 title 行')
	assert.ok(!dup[0].includes('先 delete 再改名'), '不得复刻「先 delete 再改名」——撞上的不是待写那条的旧版本')
	// frontmatter 不合规的条目 title 不可知，不占坑也不被当成无同名（写侧对它是另一条专门口径）
	writeFileSync(join(store, 'broken.md'), '没有 frontmatter\n', 'utf8')
	const after = lintMemory({ memoryRoot: root, machine: 'home' })
	const afterDup = after.warnings.filter((w) => w.includes('段内 title 重名'))
	assert.equal(afterDup.length, 1, '坏条目不改变撞名判定')
	// 但要说得出「这条的 title 一次都没被比较过」：重名结论只覆盖其余条目，别让读者以为覆盖了整段。
	// 覆盖面缺口独立成条（不挂在撞名那条尾巴上），故在这里查它自己那一条
	const coverage = after.warnings.filter((w) => w.includes('title 判不了'))
	assert.equal(coverage.length, 1, '覆盖面缺口独立成一条，不随撞名组数增减')
	assert.ok(coverage[0].includes('1 条 title 判不了') && coverage[0].includes('broken.md'), '须说得出有几条判不了、是哪些：坏条目的 title 压根没参与比较')
})

test('lintMemory：有 title 判不了的条目而本段不撞名，覆盖面缺口照样单独立一条（挂在撞名尾巴上时不撞名就一个字都不说）', () => {
	const { root, store } = memoryTree(base, 'lint-coverage-alone')
	writeFileSync(join(store, 'good.md'), entry('独一份', '触发词'), 'utf8')
	writeFileSync(join(store, 'broken.md'), '没有 frontmatter\n', 'utf8')
	const report = lintMemory({ memoryRoot: root, machine: 'home' })
	assert.equal(report.warnings.filter((w) => w.includes('段内 title 重名')).length, 0, '本段不撞名就不该报撞名')
	const coverage = report.warnings.filter((w) => w.includes('title 判不了'))
	assert.equal(coverage.length, 1, '覆盖面缺口与有无撞名无关，各说各的')
	assert.ok(coverage[0].includes('broken.md') && coverage[0].includes('重名结论只覆盖其余条目'), coverage[0])
})

test('lintMemory：节重名逐条点名（判据＝条目内 ## 标题重复），无节条目不报（存量常态不制造噪音）', () => {
	const { root, store, machineDir } = memoryTree(base, 'lint-section-dup', 'home')
	// 同条目内两个 ## 同名：edit 按节锚定以标题为锚，重名即分不清锚在哪——任何时刻都是真问题
	writeFileSync(
		join(store, 'dup.md'),
		entry('重名节条目', '触发词', '## 状态\n\n第一处\n\n## 备注\n\n夹层\n\n## 状态\n\n第二处\n'),
		'utf8',
	)
	// 无节条目是语料迁移收口前的存量常态（edit 改它们的 frontmatter 还指望这条路畅通），
	// 新检查只查「节重名」不查「无节」——报了就是整屏噪音
	writeFileSync(join(store, 'flat.md'), entry('无节条目', '触发词', '没有节结构的正文'), 'utf8')
	// 单节与多节不同名都不报；各段各查各的
	writeFileSync(join(machineDir, 'ok.md'), entry('多节条目', '触发词', '## 甲\n\n一\n\n## 乙\n\n二\n'), 'utf8')
	const report = lintMemory({ memoryRoot: root, machine: 'home' })
	const dup = report.warnings.filter((w) => w.includes('节重名'))
	assert.equal(dup.length, 1, '只报真有重名的那一条')
	assert.ok(dup[0].includes('状态') && dup[0].includes('dup.md'), '告警须指出重名的节标题与所在条目')
	assert.ok(dup[0].startsWith('shared：'), '告警带段前缀（kind 单源＝core 的段标签），定位形态与其余 warning 一致')
	assert.ok(dup[0].includes('按节锚定'), '文案须说清为什么重名碍事（按节锚定以标题为锚）')
	assert.ok(!report.warnings.some((w) => w.includes('无节') || (w.includes('节') && w.includes('flat.md'))), '无节条目不报')
	assert.ok(!report.warnings.some((w) => w.includes('节重名') && w.includes('ok.md')), '不同名的多节条目不报')
})

test('lintMemory：段清点抛错即中止并点名（machines 是文件＝确定性触发）', () => {
	const root = join(base, 'lint-segment-enum-fail')
	mkdirSync(join(root, 'memory'), { recursive: true })
	writeFileSync(join(root, 'memory', 'only.md'), entry('唯一条目', '触发词'), 'utf8')
	// machines 放文件而不是目录：段清点那一步只判存在性，于是它「在场」而 readdirSync 抛
	// ENOTDIR。清点失败与逐处降级不同——段目录清单都没有，逐段体检无从谈起，只能中止
	writeFileSync(join(root, 'memory', 'machines'), '不是目录\n', 'utf8')
	const report = lintMemory({ memoryRoot: root, machine: 'home' })
	assert.equal(report.ok, false)
	assert.deepEqual(report.warnings.map((w) => w.split('：')[0]), ['段清点失败（体检中止）'], '中止型失败须单独立一条，且不得再往下报别的')
	assert.ok(report.warnings[0].includes('ENOTDIR'), '须带上底层错误信息，否则读者无从判断是自己没接线还是盘坏了')
})

test('lintMemory：条目清点失败与段目录读取失败各报一条（同一次里两条出口都点到）', () => {
	// 先钉对照：同一份语料在正常接线下的结论一片干净——下面那趟只把 store 换成文件，两条
	// warning 才归因得到那个病态输入上
	const healthy = join(base, 'lint-stems-healthy')
	const healthyDir = join(healthy, 'memory', 'machines', 'home')
	mkdirSync(healthyDir, { recursive: true })
	writeFileSync(join(healthyDir, 'present.md'), entry('在场条目', '触发词'), 'utf8')
	writeFileSync(join(healthyDir, 'linker.md'), entry('引用条目', '触发词', '见 [[present]] 一处'), 'utf8')
	assert.deepEqual(lintMemory({ memoryRoot: healthy, machine: 'home' }).warnings, [], '对照：这份语料在正常接线下零 warning（在场条目不是死链、无预算与契约问题）')

	// store 是文件：段清点只判存在性（文件也算「在场」），而全库 stem 清点与逐段列目录读的都是它，
	// 同一个病态输入一次点着两条出口（段清点那一步不抛——它不 readdir store 本身，只 readdir machines/）
	const root = join(base, 'lint-stems-degraded')
	mkdirSync(root, { recursive: true })
	writeFileSync(join(root, 'memory'), '不是目录\n', 'utf8')
	const report = lintMemory({ memoryRoot: root, machine: 'home' })
	assert.ok(report.warnings.some((w) => w.includes('条目清点失败') && w.includes('死链判定降级')), 'stem 清点失败须点名它降级到哪一步')
	assert.ok(report.warnings.some((w) => w.includes('目录读取失败') && w.includes(join(root, 'memory'))), '段目录读不动须报到段与路径')
})

test('lintMemory：病态输入逐处降级报 warning，体检自身不崩（同名目录确定性触发）', () => {
	const { root, store } = memoryTree(base, 'lint-degraded')
	writeFileSync(join(store, 'good.md'), entry('好条目', '触发词'), 'utf8')
	// x.md 名字的目录：readdirSync 列出它，而它落在「Dirent 判不出是不是普通文件」那一档，补的那
	// 次 statSync 说它不是文件——报出来的是「条目名被非普通文件占用」，不再是读文件时的 EISDIR
	mkdirSync(join(store, 'x.md'))
	const report = lintMemory({ memoryRoot: root, machine: 'home' })
	assert.equal(report.ok, false)
	assert.ok(
		report.warnings.some((w) => w.includes('条目读取失败') && w.includes('x.md') && w.includes('条目名被非普通文件占用')),
		'detail 说的是「名字被非普通文件占用」：同名目录与读不动是两回事，笼统一句「读取失败」会让后来人照着读失败那条线去查',
	)
	assert.ok(!report.warnings.some((w) => w.includes('frontmatter 不合规') && w.includes('good.md')), '好条目不受邻近病态牵连')
})
