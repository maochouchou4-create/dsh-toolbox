/**
 * 共享原语的直接单测（node:test，零宿主依赖、零 IO）：跨工具族收敛出来的那几个判据原语
 * 与遍历，各自的行为契约在这里钉住。
 *
 * 为什么不用动作层的用例间接覆盖：动作层的用例只验「经过这些原语之后发生了什么」，验不到
 * 原语本身的口径——行号差一位、判据在某类退化输入上换了答案，两边都可能照样全绿。收敛成
 * 单一事实源之后，原语自己就成了契约面的一部分，它得有自己的用例。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INDEX_LINE_CHAR_BUDGET } from '../lib/memory/core.js'
import { nonEmptyOrDefault } from '../lib/memory-root.js'
import { forEachWikilinkMatch, styleWarnings } from '../lib/memory/patterns.js'
import { resolveActiveCwd } from '../lib/working-dir.js'

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

test('styleWarnings：日期戳与派生行超长各出一条，合规输入一条不出', () => {
	const 短行 = '- [标题](a.md) — 触发词'
	const 刚好 = '- [标题](a.md) — ' + '词'.repeat(INDEX_LINE_CHAR_BUDGET - '- [标题](a.md) — '.length)
	const 超一行 = `${刚好}词`
	// 合规：两条都不该报（超长判定是 `>`，恰满预算不报）
	assert.deepEqual(styleWarnings({ description: '触发词', indexLine: 短行 }), [])
	assert.deepEqual(styleWarnings({ description: '触发词', indexLine: 刚好 }), [], `恰 ${INDEX_LINE_CHAR_BUDGET} 字符不报`)
	// 日期戳：文案须指向写侧纪律出处，否则读到的人不知道该去问哪条规则
	const 日期戳 = styleWarnings({ description: '2026-01-02 记', indexLine: 短行 })
	assert.equal(日期戳.length, 1)
	assert.ok(日期戳[0].includes('日期戳') && 日期戳[0].includes('WRITING.md'), 日期戳[0])
	// 超长：文案须给收敛方向，只说「超了」等于把判断留给读到的人
	const 超长 = styleWarnings({ description: '触发词', indexLine: 超一行 })
	assert.equal(超长.length, 1)
	assert.ok(超长[0].includes(String(INDEX_LINE_CHAR_BUDGET)), 超长[0])
	assert.ok(超长[0].includes('收敛 description'), 超长[0])
	// 两条同时命中时都在
	assert.equal(styleWarnings({ description: '2026-01-02 记', indexLine: 超一行 }).length, 2)
})

test('resolveActiveCwd：无 agent 返回 undefined，有 agent 取会话 header.cwd', () => {
	// 无 agent 的脚本化/预览路径：返回 undefined，由下游按自己的默认解析（不猜 process.cwd()）
	assert.equal(resolveActiveCwd(undefined), undefined)
	// 有 agent：活目录就是会话 header.cwd，原样透传不改写
	assert.equal(resolveActiveCwd({ session: { header: { cwd: '/work/live' } } }), '/work/live')
	// 会话没带 cwd（宿主里 cwd 是可选字段）＝合法缺省，不是契约断裂
	assert.equal(resolveActiveCwd({ session: { header: {} } }), undefined)
	// 契约断裂当场抛：静默回落成 undefined 会让消费方的相对路径改按启动目录解析，
	// 症状出现在几层之外，最难查
	assert.throws(() => resolveActiveCwd({}), /session\.header/)
	assert.throws(() => resolveActiveCwd({ session: {} }), /session\.header/)
})
