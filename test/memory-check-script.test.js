/**
 * checks.mjs 与 check-memory-index.mjs 的单测：子进程跑真实脚本，验「自报名单与检查项是同一份」。
 *
 * 立身之本是那份自报名单：清单如果是另写的一段文案常量，它与检查项数组就没有结构关系，
 * 脚本一改就漂，而漂了之后它仍然「看起来是权威的覆盖范围说明」。这里把两者钉在一起——
 * 报告里出现的每个检查项 id 都得在自报名单里，自报名单里的 id 也得与检查项数组逐项相等。
 *
 * 第二根钉是「判红得真判」：本仓真实发生过假绿（记忆根打错仍印「全部达标」、忘了带参数
 * 却印「新工作区属常态」）。这两类不是措辞问题而是退出码问题——命令被当成「必须绿才算完」
 * 的闸门，假绿等于没跑，所以每种空跑形态各有一条用例钉住退出 1。
 *
 * 第三根是「清单里的每一项都验过」：AGENTS.md 把这份自报名单定为覆盖范围的唯一权威，
 * 而输出里「有触发用例」与「只是列在那儿」长得一模一样，故四项零覆盖的检查各补一条
 * 触发语料。造多少条、多长 padding 一律由 core.js 的常量算出，不在测试里写死第二个数值。
 *
 * 语料跑在 mkdtemp 出的临时目录上：脚本吃的是真实路径，而仓库外的真实语料不该被测试改写。
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { BLOCK_CHAR_BUDGET, INDEX_CHAR_BUDGET, INDEX_LINE_BUDGET, INDEX_LINE_CHAR_BUDGET } from '../lib/memory/core.js'
import { workspaceSlug } from '../lib/memory-root.js'
import { deriveIndexLine } from '../lib/memory/frontmatter.js'
import { CHECKS } from '../scripts/checks.mjs'
import { SCRIPTS_DIR, tempRoot } from './helpers.js'

const scriptPath = join(SCRIPTS_DIR, 'check-memory-index.mjs')
const CHECK_IDS = CHECKS.map((check) => check.id)

let base

before((t) => {
	base = tempRoot(t, 'memory-check')
})

/** 起子进程跑脚本。脚本是「模块 + 薄壳」两层，被直接运行就跑薄壳，不存在 import 时该不该跑的分支。 */
function runScript(args, options = {}) {
	const result = spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', ...options })
	assert.equal(result.error, undefined, `脚本起不来：${result.error?.message ?? ''}`)
	return { code: result.status, stdout: result.stdout }
}

const layerDir = (memoryRoot, layer) => (layer === 'habit' ? join(memoryRoot, 'profile') : join(memoryRoot, 'workspaces', layer))

/**
 * 在临时根里铺一层条目（habit 铺习惯层，其余铺该工作区桶）。
 * lines 走派生行再拆回两键，而不是直接写 frontmatter 文本：这样行预算与块定档的换算用的是
 * 注入侧同一份派生逻辑，测试里不会躺着第二份格式认知。
 */
function seedLayer(memoryRoot, layer, lines) {
	const dir = layerDir(memoryRoot, layer)
	mkdirSync(dir, { recursive: true })
	// 习惯层连同 WRITING.md 一起铺：真实语料里它与层同在，缺了它「写侧纪律读不动」就是
	// 一条真的判红（规则块在运行期被 warn 掉，块随之变小），而这些用例要判的是别的项
	if (layer === 'habit') writeFileSync(join(dir, 'WRITING.md'), '# 写侧纪律\n\n测试语料占位。\n', 'utf8')
	lines.forEach((line, index) => {
		const file = `topic-${index}.md`
		const [, title, , description] = /^- \[(.+)\]\((.+)\) — (.*)$/.exec(line)
		writeFileSync(join(dir, file), `---\ntitle: ${title}\ndescription: ${description}\n---\n\n正文。\n`, 'utf8')
	})
	return dir
}

/** 铺一条内容原样给定的条目：给「派生行凑不出来」的判定用（如不合规 frontmatter）。 */
function seedRaw(memoryRoot, layer, file, content) {
	const dir = layerDir(memoryRoot, layer)
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, file), content, 'utf8')
	return dir
}

/** 自报名单里逐项打印的 id（两空格缩进＋制表符分隔，与逐层表格和病灶行都不会混进来）。 */
const reportIds = (stdout) =>
	stdout
		.split('\n')
		.filter((line) => line.startsWith('  ') && line.includes('\t'))
		.map((line) => line.trim().split('\t')[0])
/** 待收敛病灶行前缀带的检查项 id。 */
const violationIds = (stdout) => [...stdout.matchAll(/^ {2}· \[([a-z0-9-]+)\]/gm)].map((match) => match[1])

/** 造 N 条各自都在单行预算内的长派生行：padding 按每个 index 现算，不按第 0 条定死。 */
const longLineOf = (index) => {
	const prefix = deriveIndexLine({ title: `条目${index}`, description: '', file: `topic-${index}.md` }).length
	return deriveIndexLine({ title: `条目${index}`, description: '词'.repeat(INDEX_LINE_CHAR_BUDGET - prefix), file: `topic-${index}.md` })
}

test('合规语料：退出 0，自报名单与检查项数组逐项对得上（清单即数组本身，不是另写的文案）', () => {
	const root = join(base, 'compliant')
	mkdirSync(root, { recursive: true })
	const cwd = '/盘/甲-project'
	seedLayer(root, 'habit', [deriveIndexLine({ title: '习惯条目', description: '触发词／召回词', file: 'habit-topic.md' })])
	// 桶目录名问 core.js 同一份 slug 归一（脚本装配时也问它）：手写一个桶名而 cwd 归一出的
	// 不是它，工作层就不在注入块里——那份报告仍会印「全部达标」，正是空跑假绿的形态
	seedLayer(root, workspaceSlug(cwd), [deriveIndexLine({ title: '工作条目', description: '触发词／召回词', file: 'work-topic.md' })])
	const { code, stdout } = runScript([root, cwd])
	assert.equal(code, 0, `合规语料须退出 0：\n${stdout}`)
	assert.ok(stdout.includes('全部达标'), stdout)
	assert.deepEqual([...new Set(reportIds(stdout))].sort(), [...CHECK_IDS].sort(), '自报名单必须与检查项数组逐项对得上')
	// 「全部达标」那句不再枚举覆盖范围：那份枚举只点了三类，改检查项不会改它，是本仓
	// 亲手造出来的第二份手抄清单。钉它的形态（总数来自数组、逐项在下方），不钉它的措辞
	assert.ok(stdout.includes(`${CHECKS.length} 项检查全过`), `「全部达标」须由检查项数组算总数：\n${stdout}`)
})

test('超预算语料：退出 1，报告里出现的每个检查项都在自报名单里（要造多少条由定档算出来）', () => {
	const root = join(base, 'over-budget')
	mkdirSync(root, { recursive: true })
	const cwd = '/盘/乙-project'
	// padding 按单行预算减去**该条**的前缀算出，条目各自都恰好落在行预算内：这条用例钉的
	// 才是整块定档与层内字符预算那两项。定档一改条数跟着变，用例钉的仍是「超了就判红」。
	// 造语料要按**层数**算而不是按整块算：逐层预算在运行期先截一层（单层至多
	// INDEX_CHAR_BUDGET 字符），一层顶到头也只够到「写侧纪律＋一层」的量级，顶不过整块
	// 那条线——两块各顶到头再加规则块才顶得过去（整块线余量是按现状块算的，现状块两层都
	// 没到顶）。条数按每层能把层内字符预算吃满来取，判据仍是常量推出来的
	const perLayer = Math.ceil(INDEX_CHAR_BUDGET / (longLineOf(0).length + 1)) + 1
	const lines = Array.from({ length: perLayer }, (_, index) => longLineOf(index))
	seedLayer(root, 'habit', lines)
	seedLayer(root, workspaceSlug(cwd), lines.map((line, index) => longLineOf(index + perLayer)))
	const { code, stdout } = runScript([root, cwd])
	assert.equal(code, 1, `超预算语料须以 1 退出：\n${stdout}`)
	assert.ok(stdout.includes('项待收敛：'), stdout)
	const listed = reportIds(stdout)
	assert.ok(violationIds(stdout).length > 0, `以 1 退出却没列病灶：\n${stdout}`)
	for (const id of violationIds(stdout)) {
		assert.ok(listed.includes(id), `报告里出现检查项 ${id}，自报名单却没有——两者必须是同一份`)
	}
	assert.ok(violationIds(stdout).includes('block-chars'), `顶过整块定档却没报整块超线：\n${stdout}`)
	assert.ok(!violationIds(stdout).includes('entry-index-line'), `这批条目各自都在单行预算内，不该顺手把单行那项也报了：\n${stdout}`)
	assert.ok(stdout.includes(`超 ${BLOCK_CHAR_BUDGET} 整块定档`), stdout)
})

test('单条派生行超行预算：只由那一项判红（行预算得由长 description 顶出来，不由块大小顶）', () => {
	const root = join(base, 'over-line')
	mkdirSync(root, { recursive: true })
	const cwd = '/盘/丙-project'
	// 超预算的那条与合规条目同放一层：块定档够小，于是判红的只有单行那一项
	const long = deriveIndexLine({ title: '超长条目', description: '词'.repeat(INDEX_LINE_CHAR_BUDGET), file: 'long.md' })
	assert.ok(long.length > INDEX_LINE_CHAR_BUDGET, '本用例的前提是这一条确实超行预算')
	seedLayer(root, workspaceSlug(cwd), [long, deriveIndexLine({ title: '正常条目', description: '触发词', file: 'short.md' })])
	const { code, stdout } = runScript([root, cwd])
	assert.equal(code, 1, `超行预算须以 1 退出：\n${stdout}`)
	assert.ok(violationIds(stdout).includes('entry-index-line'), `超行预算须报 entry-index-line：\n${stdout}`)
	// 报出来的长度只断言「确实超了」：行长由派生逻辑（注入侧那一份）决定，测试里再抄一遍
	// 换算就是第二份格式认知，它漂了以后这里会指着一条并不超预算的行说它超了
	const reported = /派生索引行 (\d+) 字符超 (\d+)/.exec(stdout)
	assert.ok(reported !== null && Number(reported[1]) > Number(reported[2]), `须报出实测行长与预算：\n${stdout}`)
	assert.equal(Number(reported[2]), INDEX_LINE_CHAR_BUDGET, '报告里的预算须来自 core.js 的常量')
})

test('层内索引行数超预算：只由那一项判红（要造够多少条由行预算算出）', () => {
	const root = join(base, 'over-lines')
	mkdirSync(root, { recursive: true })
	const cwd = '/盘/丁-project'
	const lines = Array.from({ length: INDEX_LINE_BUDGET + 1 }, (_, index) =>
		deriveIndexLine({ title: `条目${index}`, description: '触发词', file: `topic-${index}.md` }),
	)
	seedLayer(root, workspaceSlug(cwd), lines)
	const { code, stdout } = runScript([root, cwd])
	assert.equal(code, 1, `行数超预算须以 1 退出：\n${stdout}`)
	assert.ok(violationIds(stdout).includes('layer-index-lines'), `须报 layer-index-lines：\n${stdout}`)
	assert.ok(stdout.includes(`索引 ${INDEX_LINE_BUDGET + 1} 行超 ${INDEX_LINE_BUDGET} 行预算`), stdout)
})

test('条目 frontmatter 不合规：只由那一项判红（第三键是最贴近真语料的形态）', () => {
	const root = join(base, 'bad-frontmatter')
	mkdirSync(root, { recursive: true })
	const cwd = '/盘/戊-project'
	const dir = layerDir(root, workspaceSlug(cwd))
	seedRaw(root, workspaceSlug(cwd), 'ok.md', `---\ntitle: 正常条目\ndescription: 触发词\n---\n\n正文。\n`)
	// 第三键：两键契约之外的键没有消费者，历史上正是 name:/metadata: 那样的死字段
	seedRaw(root, workspaceSlug(cwd), 'dead-key.md', `---\ntitle: 带死字段的条目\ndescription: 触发词\nname: dead-key\n---\n\n正文。\n`)
	assert.ok(dir !== '')
	const { code, stdout } = runScript([root, cwd])
	assert.equal(code, 1, `不合规 frontmatter 须以 1 退出：\n${stdout}`)
	assert.ok(violationIds(stdout).includes('entry-frontmatter'), `须报 entry-frontmatter：\n${stdout}`)
	assert.ok(stdout.includes('dead-key.md'), stdout)
})

test('条目读不动（同名目录占位）：只由那一项判红（读失败失去覆盖面，不许静默）', () => {
	const root = join(base, 'unreadable')
	mkdirSync(root, { recursive: true })
	const cwd = '/盘/己-project'
	const dir = seedLayer(root, workspaceSlug(cwd), [deriveIndexLine({ title: '正常条目', description: '触发词', file: 'ok.md' })])
	// 条目名被同名目录占着：扫得到名字却读不出内容，两种反应都不是「静默跳过」
	mkdirSync(join(dir, 'slot.md'), { recursive: true })
	const { code, stdout } = runScript([root, cwd])
	assert.equal(code, 1, `读不动须以 1 退出：\n${stdout}`)
	assert.ok(violationIds(stdout).includes('entry-readable'), `须报 entry-readable：\n${stdout}`)
	assert.ok(stdout.includes('slot.md'), stdout)
})

test('层内退役索引文件残留：只由那一项判红（大小写不敏感都算同一个文件）', () => {
	const root = join(base, 'retired-index')
	mkdirSync(root, { recursive: true })
	const cwd = '/盘/庚-project'
	seedLayer(root, workspaceSlug(cwd), [deriveIndexLine({ title: '正常条目', description: '触发词', file: 'ok.md' })])
	seedRaw(root, workspaceSlug(cwd), 'MEMORY.md', '- [正常条目](ok.md) — 触发词\n')
	const { code, stdout } = runScript([root, cwd])
	assert.equal(code, 1, `退役索引文件残留须以 1 退出：\n${stdout}`)
	assert.ok(violationIds(stdout).includes('retired-index-file'), `须报 retired-index-file：\n${stdout}`)
	assert.ok(stdout.includes('MEMORY.md'), stdout)
})

test('层内 title 重名：只由那一项判红，且跨层同名不算（撞名的成因是合流，脚本得能看见）', () => {
	const root = join(base, 'title-dup')
	mkdirSync(root, { recursive: true })
	const cwd = '/盘/辛-project'
	// 同层两条共用一个 title：文件名各不相同（派生行以 title 为准），注入块里那两行照样分不出谁是谁
	seedLayer(root, workspaceSlug(cwd), [
		deriveIndexLine({ title: '同题条目', description: '触发词甲', file: 'a.md' }),
		deriveIndexLine({ title: '同题条目', description: '触发词乙', file: 'b.md' }),
		deriveIndexLine({ title: '独题条目', description: '触发词丙', file: 'c.md' }),
	])
	// 习惯层也放一条同名：两层各一行都看得清，跨层不构成不可区分
	seedLayer(root, 'habit', [deriveIndexLine({ title: '同题条目', description: '习惯层触发词', file: 'h.md' })])
	const { code, stdout } = runScript([root, cwd])
	assert.equal(code, 1, `层内重名须以 1 退出：\n${stdout}`)
	// 按去重后的 id 断言：证明的是「只有这一项判红」，不是「这一项只列一行」——同一语料
	// 在逐层清点与注入块装配两次扫描里各报一次（两种 kind 前缀），是本脚本的既有形态
	assert.deepEqual([...new Set(violationIds(stdout))], ['layer-title-dup'], `只该由这一项判红：\n${stdout}`)
	assert.ok(stdout.includes('同题条目') && stdout.includes('topic-0.md') && stdout.includes('topic-1.md'), stdout)
	// 处置指向 edit 而不是 delete：报出来的两条是各自带正文的现存条目，照着删丢的是内容
	assert.ok(stdout.includes('不要 delete'), stdout)
	assert.ok(!stdout.includes('独题条目'), `未撞名的条目不牵进来：\n${stdout}`)
})

test('层内重名结论的覆盖面：title 判不了的条目一并说出来，别让读者以为结论覆盖了整层', () => {
	const root = join(base, 'title-dup-coverage')
	mkdirSync(root, { recursive: true })
	const cwd = '/盘/壬-project'
	seedLayer(root, workspaceSlug(cwd), [
		deriveIndexLine({ title: '同题条目', description: '触发词甲', file: 'a.md' }),
		deriveIndexLine({ title: '同题条目', description: '触发词乙', file: 'b.md' }),
	])
	// 第三键＝最贴近真语料的坏形态：它占坑不得，却让这一层的 title 比对少了一条覆盖面
	seedRaw(root, workspaceSlug(cwd), 'broken.md', '---\ntitle: A\nname: 多余键\ndescription: B\n---\n\n正文。\n')
	const { code, stdout } = runScript([root, cwd])
	assert.equal(code, 1, `层内重名须以 1 退出：\n${stdout}`)
	assert.ok(violationIds(stdout).includes('layer-title-dup'), stdout)
	// 覆盖面缺口单独立项认领：拼在撞名那条尾巴上时，三组撞名会印三遍、不撞名时一个字都不说
	assert.ok(violationIds(stdout).includes('layer-title-coverage'), `覆盖面缺口要有自己的检查项：\n${stdout}`)
	assert.ok(stdout.includes('1 条 title 判不了'), `覆盖面缺口要一并说出来：\n${stdout}`)
	assert.ok(violationIds(stdout).includes('entry-frontmatter'), stdout)
})

test('没人认领的 issue kind：兜底项把它报出来，而不是让它随报告消失', () => {
	// 这一条没法用子进程造：issue kind 由扫描器（assemble.js）发出，测试不该为它改扫描器。
	// 直接拿现场片段喂那一项的 run，钉的是「未认领即判红」这个判定本身
	const check = CHECKS.find((item) => item.id === 'issue-unclaimed')
	assert.ok(check, '兜底项必须在检查项数组里——它是 issue 枚举会长大这件事的唯一哨兵')
	const reported = check.run({ issues: [{ kind: 'habit', issue: 'future-kind', path: '/x.md', detail: '' }] })
	assert.equal(reported.length, 1, '未认领的 kind 须报一行')
	assert.ok(reported[0].includes('future-kind'), reported[0])
	assert.deepEqual(check.run({ issues: [{ kind: 'habit', issue: 'entry-frontmatter', path: '/x.md', detail: '' }] }), [], '已认领的 kind 不该被兜底项重复报')
})

test('记忆根打错：退出 1 且由接线那项判红（扫到 0 层不等于没有问题）', () => {
	const missing = join(base, 'no-such-root-xyz')
	// 记忆根不存在 ⇒ 扫不到任何层，而缺省形态会一路走到「全部达标」：这是与空跑同族的假绿
	const { code, stdout } = runScript([missing, '/盘/辛-project'])
	assert.equal(code, 1, `记忆根打错不得假绿：\n${stdout}`)
	assert.ok(violationIds(stdout).includes('memory-root-wired'), `须由 memory-root-wired 判红：\n${stdout}`)
	assert.ok(!stdout.includes('全部达标'), stdout)
})

test('记忆根存在但里面没有层：同样 exit 1（空目录与打错的根都扫不到层，症状同形）', () => {
	const root = join(base, 'empty-root')
	mkdirSync(root, { recursive: true })
	const { code, stdout } = runScript([root, '/盘/壬-project'])
	assert.equal(code, 1, `扫到 0 层不得假绿：\n${stdout}`)
	assert.ok(violationIds(stdout).includes('memory-root-wired'), `须由 memory-root-wired 判红：\n${stdout}`)
})

test('空跑（两参都没给）：退出 1 且由桶在场那项判红，不许照印全部达标', () => {
	const root = join(base, 'empty-run')
	seedLayer(root, 'habit', [deriveIndexLine({ title: '习惯条目', description: '触发词', file: 'habit-topic.md' })])
	// 两参都不给时脚本走默认记忆根（这里用 DSH_MEMORY_ROOT 指回临时根，不碰真实语料）与
	// process.cwd()：后者取一个必然没有桶的临时目录，于是「忘了带参数」的判红条件成立，
	// 且整条路径与跑测试的人站在哪个仓库无关
	const noBucketCwd = join(base, 'no-bucket-here')
	mkdirSync(noBucketCwd, { recursive: true })
	const { code, stdout } = runScript([], { cwd: noBucketCwd, env: { ...process.env, DSH_MEMORY_ROOT: root } })
	assert.equal(code, 1, `空跑不得假绿：\n${stdout}`)
	assert.ok(violationIds(stdout).includes('workspace-bucket'), `空跑须由桶在场那项判红：\n${stdout}`)
	assert.ok(stdout.includes('未给工作区 cwd 参数'), stdout)
	assert.ok(!stdout.includes('全部达标'), stdout)
})

test('空串两参：退出 1（空串与纯空白按没给算，且不许拿「新工作区属常态」打圆场）', () => {
	const root = join(base, 'empty-string-args')
	seedLayer(root, 'habit', [deriveIndexLine({ title: '习惯条目', description: '触发词', file: 'habit-topic.md' })])
	// 显式传空串：解析后与缺参同形，可它仍是调用方写下来的形参——判据必须看得见这件事，
	// 否则一次「以为给了参数」的调用会以 0 退出并印「全部达标」
	const noBucketCwd = join(base, 'empty-string-no-bucket')
	mkdirSync(noBucketCwd, { recursive: true })
	const { code, stdout } = runScript(['', ''], { cwd: noBucketCwd })
	assert.equal(code, 1, `空串两参不得假绿：\n${stdout}`)
	assert.ok(violationIds(stdout).includes('workspace-bucket'), `须由桶在场那项判红：\n${stdout}`)
	assert.ok(!stdout.includes('全部达标'), stdout)
	assert.ok(!stdout.includes('新工作区属常态'), '参数没给全时不得拿新工作区当安慰')
})

test('空跑（只给了记忆根、没给工作区 cwd）：同样 exit 1，不许拿「新工作区属常态」打圆场', () => {
	const root = join(base, 'root-only')
	seedLayer(root, 'habit', [deriveIndexLine({ title: '习惯条目', description: '触发词', file: 'habit-topic.md' })])
	// 给了记忆根、cwd 缺省落到 process.cwd()：那次装配只量到习惯层，整块定档名不副实。
	// 这与「两参都不给」是同一个空跑走的另一扇门，两者都必须判红
	const noBucketCwd = join(base, 'root-only-no-bucket')
	mkdirSync(noBucketCwd, { recursive: true })
	const { code, stdout } = runScript([root], { cwd: noBucketCwd })
	assert.equal(code, 1, `少给工作区 cwd 参数同样不得假绿：\n${stdout}`)
	assert.ok(violationIds(stdout).includes('workspace-bucket'), `须由桶在场那项判红：\n${stdout}`)
	assert.ok(stdout.includes('未给工作区 cwd 参数'), stdout)
	assert.ok(!stdout.includes('全部达标'), stdout)
})

test('新工作区（两参齐备、桶真的不存在）：只提示不判红（那是常态，不是空跑）', () => {
	const root = join(base, 'fresh-workspace')
	seedLayer(root, 'habit', [deriveIndexLine({ title: '习惯条目', description: '触发词', file: 'habit-topic.md' })])
	const fresh = '/盘/癸-fresh'
	const { code, stdout } = runScript([root, fresh])
	assert.equal(code, 0, `新工作区是常态，不该判红：\n${stdout}`)
	assert.ok(stdout.includes('新工作区属常态'), stdout)
	assert.ok(!violationIds(stdout).includes('workspace-bucket'), '两参齐备时桶不在场不是空跑')
})

test('软链调用：照样出报告（薄壳没有「被直接运行才执行」那道守卫可关）', () => {
	const root = join(base, 'symlinked')
	mkdirSync(root, { recursive: true })
	seedLayer(root, 'habit', [deriveIndexLine({ title: '习惯条目', description: '触发词', file: 'habit-topic.md' })])
	const cwd = '/盘/子-project'
	seedLayer(root, workspaceSlug(cwd), [deriveIndexLine({ title: '工作条目', description: '触发词', file: 'work.md' })])
	// 曾经有一道 `realpath(argv[1]) === import.meta.url` 的守卫，它在软链下不成立，
	// 于是「必须绿才算完」的闸门静默变成 no-op：零输出、0 退出。拆成薄壳后不再有守卫可关
	const link = join(base, 'check-via-symlink.mjs')
	symlinkSync(scriptPath, link)
	const result = spawnSync(process.execPath, [link, root, cwd], { encoding: 'utf8' })
	assert.equal(result.error, undefined, `脚本起不来：${result.error?.message ?? ''}`)
	assert.equal(result.status, 0, `软链调用须与直接调用同判：\n${result.stdout}`)
	assert.ok(result.stdout.includes('全部达标'), `软链调用不得零输出：\n${result.stdout}`)
	assert.ok(result.stdout.includes('本命令覆盖'), '自报名单在软链调用下同样要打印')
})
