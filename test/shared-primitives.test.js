/**
 * 共享原语的直接单测（node:test，零宿主依赖、零 IO）：跨工具族收敛出来的那几个判据原语、
 * 遍历与告警去重工厂，各自的行为契约在这里钉住。
 *
 * 为什么不用动作层的用例间接覆盖：动作层的用例只验「经过这些原语之后发生了什么」，验不到
 * 原语本身的口径——行号差一位、判据在某类退化输入上换了答案，两边都可能照样全绿。收敛成
 * 单一事实源之后，原语自己就成了契约面的一部分，它得有自己的用例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INDEX_LINE_CHAR_BUDGET } from '../lib/memory/core.js'
import { nonEmptyOrDefault } from '../lib/memory-root.js'
import { duplicateSectionHeadings, forEachWikilinkMatch, sectionHeadings, styleWarnings } from '../lib/memory/patterns.js'
import { makeWarnOnce } from '../lib/warn-once.js'

test('duplicateSectionHeadings：标题按去空白后的串比对，尾随空白写法不同也算重名', () => {
	// 「## 甲」与「## 甲 」是同一个节锚：各写一次就是重名
	assert.deepEqual(duplicateSectionHeadings('## 甲\n正文\n\n## 甲  \n正文\n\n## 乙\n'), ['甲'])
	assert.deepEqual(duplicateSectionHeadings('## 甲\n\n## 乙\n'), [])
})

test('sectionHeadings：行号从剥掉 frontmatter 后算起，标题去首尾空白，病态写法与围栏内的行不算节', () => {
	/** 取 [标题, 行号] 对，便于逐项比对。 */
	const pairs = (text) => sectionHeadings(text).map(({ title, line }) => [title, line])
	// 常规：frontmatter 占 0–4 行（含空行），首个标题落在下标 5；尾随空白不构成「另一个标题」
	assert.deepEqual(
		pairs('---\ntitle: 甲\ndescription: 触发词\n---\n\n## 甲节  \n正文\n\n## 乙节\n'),
		[
			['甲节', 5],
			['乙节', 8],
		],
	)
	// 无 frontmatter：标题可以在首行
	assert.deepEqual(pairs('## 首行节\n正文\n'), [['首行节', 0]])
	// CRLF：行尾归一后再判，标题不带 \r
	assert.deepEqual(pairs('## 甲节\r\n正文\r\n## 乙节\r\n'), [
		['甲节', 0],
		['乙节', 2],
	])
	// 病态写法：`##x`（无空格）、`###`（子标题）、空标题都不立节
	assert.deepEqual(pairs('##x 不是节\n### 子标题\n## \n## 真节\n'), [['真节', 3]])
	// frontmatter 里的 `## ` 行不算节（扫描面从围栏之后起）
	assert.deepEqual(pairs('---\n## 甲\ndescription: x\n---\n## 乙\n'), [['乙', 4]])
})

test('sectionHeadings：围栏代码块里的 `## ` 行是示例不是节，围栏按 CommonMark 规则配对', () => {
	/** 取 [标题, 行号] 对，便于逐项比对。 */
	const pairs = (text) => sectionHeadings(text).map(({ title, line }) => [title, line])
	// 反引号围栏：开栏行带语言名、关栏行裸着；栏内两行同名 `## ` 不立节（重名假红的来源）
	assert.deepEqual(pairs('## 真节\n```md\n## 示例\n## 示例\n```\n## 下一节\n'), [
		['真节', 0],
		['下一节', 5],
	])
	// 波浪线围栏与反引号围栏互不配对：``` 栏内的 ~~~ 不关栏
	assert.deepEqual(pairs('```md\n~~~\n## 栏内\n```\n## 栏外\n'), [['栏外', 4]])
	// 波浪线自己也能开栏：栏内的 `## ` 同样不算节
	assert.deepEqual(pairs('~~~md\n## 栏内\n~~~\n## 栏外\n'), [['栏外', 3]])
	// 关栏行不短于开栏行（CommonMark）：四个反引号开的栏，栏内三个反引号的那行关不上
	assert.deepEqual(pairs('````\n## 栏内\n```\n## 仍栏内\n````\n## 栏外\n'), [['栏外', 5]])
	// 缩进不超过三格的围栏也算开栏；栏内 `## ` 同样不算
	assert.deepEqual(pairs('## 甲\n   ```\n## 栏内\n   ```\n## 乙\n'), [
		['甲', 0],
		['乙', 4],
	])
	// 栏没关到文末：后面的 `## ` 全在栏内，一个都不立
	assert.deepEqual(pairs('## 甲\n```\n## 栏内一\n## 栏内二\n'), [['甲', 0]])
	// 关栏行不许带 info 串：栏内引用的 ` ```text ` 只是内容，关不掉栏
	assert.deepEqual(pairs('## 甲\n```\n## 栏内\n```text\n## 仍栏内\n```\n## 栏外\n'), [
		['甲', 0],
		['栏外', 6],
	])
	// 反引号围栏的 info 串里有反引号＝整行不是围栏（关栏位：关不掉栏）
	assert.deepEqual(pairs('## 甲\n```\n## 栏内\n``` a`b\n## 仍栏内\n```\n## 栏外\n'), [
		['甲', 0],
		['栏外', 6],
	])
	// 同一条规则在开栏位：开不出栏，吞不掉后面的节
	assert.deepEqual(pairs('## 甲\n``` a`b\n## 乙\n'), [
		['甲', 0],
		['乙', 2],
	])
})

test('forEachWikilinkMatch：行号从 1 起，同行多匹配与跨行各自对位', () => {
	/** 跑一遍并收集 (原始串, 行号)。 */
	const collect = (text) => {
		const hits = []
		forEachWikilinkMatch(text, (matched, line) => hits.push([matched, line]))
		return hits
	}
	// 首行
	assert.deepEqual(collect('[[a]]'), [['a', 1]])
	// 同行多匹配：两个匹配落在同一行，行号不该被前者带偏
	assert.deepEqual(collect('前 [[a]] 中 [[b]] 后'), [
		['a', 1],
		['b', 1],
	])
	// 跨行：行号随换行递增，且逐行递增不是逐匹配递增（这是行归一写错一位就露馅的那种错）
	assert.deepEqual(collect('第一行 [[a]]\n第二行 [[b]]\n第三行 [[c]]'), [
		['a', 1],
		['b', 2],
		['c', 3],
	])
	// 空行也算一行：引用报告的「文件:行」要指对人，空行跳过就会指错
	assert.deepEqual(collect('[[a]]\n\n[[b]]'), [
		['a', 1],
		['b', 3],
	])
	// 无 wikilink 时一个回调都不该发
	assert.deepEqual(collect('没有引用的一篇正文'), [])
})

test('forEachWikilinkMatch：别名与锚点已截到 stem，trim 留给调用点', () => {
	const hits = []
	// 提取在 `]`、`|`、`#` 三个字符前收手，故别名与锚点形态回来的已经是 stem；
	// 「要不要 trim」是删条目的引用匹配与体检的死链判定各自的口径，不该在这一层替它们定
	forEachWikilinkMatch('[[a|别名]] [[b#锚]] [[ c ]]', (matched, line) => hits.push([matched, line]))
	assert.deepEqual(hits, [
		['a', 1],
		['b', 1],
		[' c ', 1],
	])
})

test('nonEmptyOrDefault：退化输入一律回落，有值原样返回', () => {
	const fallback = '~/.dsh/memory'
	for (const degenerate of [undefined, null, '', '   ', '\t\n', 0, 1, false, true, {}, [], () => {}]) {
		assert.equal(nonEmptyOrDefault(degenerate, fallback), fallback, `${String(degenerate)} 应回落缺省`)
	}
	assert.equal(nonEmptyOrDefault('~/.dsh/memory', fallback), '~/.dsh/memory')
	assert.equal(nonEmptyOrDefault('/tmp/root', fallback), '/tmp/root')
	// 原样返回、不 trim：这条判据只答「算不算给了」，裁剪是值自己的事。哪天某个调用点开始
	// 拿 trim 过的串当记忆根，它与读侧算出的目录就会分家，而症状要到条目写进相对路径才显形
	assert.equal(nonEmptyOrDefault('  ~/.dsh/memory  ', fallback), '  ~/.dsh/memory  ', '不得 trim 入参')
})

test('styleWarnings：日期戳与派生行超长各出一条（kind 标注），合规输入一条不出', () => {
	const 短行 = '- [标题](a.md) — 触发词'
	const 刚好 = '- [标题](a.md) — ' + '词'.repeat(INDEX_LINE_CHAR_BUDGET - '- [标题](a.md) — '.length)
	const 超一行 = `${刚好}词`
	// 合规：两条都不该报（超长判定是 `>`，恰满预算不报）
	assert.deepEqual(styleWarnings({ description: '触发词', indexLine: 短行 }), [])
	assert.deepEqual(styleWarnings({ description: '触发词', indexLine: 刚好 }), [], `恰 ${INDEX_LINE_CHAR_BUDGET} 字符不报`)
	// 日期戳：文案须指向写法细则的出处，否则读到的人不知道该去问哪条规则
	const 日期戳 = styleWarnings({ description: '2026-01-02 记', indexLine: 短行 })
	assert.equal(日期戳.length, 1)
	assert.equal(日期戳[0].kind, 'date-stamp', '消费方按 kind 拣选，kind 是对外契约')
	assert.ok(日期戳[0].text.includes('日期戳') && 日期戳[0].text.includes('memory-writing'), 日期戳[0].text)
	// 超长：文案须给收敛方向，只说「超了」等于把判断留给读到的人
	const 超长 = styleWarnings({ description: '触发词', indexLine: 超一行 })
	assert.equal(超长.length, 1)
	assert.equal(超长[0].kind, 'index-line-length')
	assert.ok(超长[0].text.includes(String(INDEX_LINE_CHAR_BUDGET)), 超长[0].text)
	assert.ok(超长[0].text.includes('收敛 description'), 超长[0].text)
	// 两条同时命中时都在
	assert.equal(styleWarnings({ description: '2026-01-02 记', indexLine: 超一行 }).length, 2)
})

test('makeWarnOnce：同消息只报一次，新消息各自报，两工厂互不串状态', () => {
	const seen = []
	const warnOnce = makeWarnOnce((message) => seen.push(message))
	// 同一消息：状态没变就不刷屏
	warnOnce('接线缺失')
	warnOnce('接线缺失')
	assert.deepEqual(seen, ['接线缺失'])
	// 状态迁移产生新消息，自然再报——dedup 键是文本，不是「报过一次就哑」
	warnOnce('接线缺失（另一处）')
	assert.deepEqual(seen, ['接线缺失', '接线缺失（另一处）'])
	// 去重集闭在工厂里：前缀由调用方闭进日志函数，两个工厂对同一消息各自报一次
	const other = []
	const second = makeWarnOnce((message) => other.push(`[memory] ${message}`))
	second('接线缺失')
	second('接线缺失')
	assert.deepEqual(other, ['[memory] 接线缺失'])
	assert.deepEqual(seen, ['接线缺失', '接线缺失（另一处）'])
})
