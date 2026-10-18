/**
 * migrate-frontmatter.mjs 的单测：子进程跑真实脚本，跑在 mkdtemp 出的临时记忆根上。
 *
 * 钉的是迁移的三条硬性质：转换后的 frontmatter 恰是两键（name:/metadata: 不留残迹）；
 * 转换后仍不合规的文件原样不动、不硬写；转换结果在段内撞名的那几条也推进跳过——
 * 迁移不得造出它要躲的那个问题。幂等另钉一次：第二次跑零改动、零跳过——迁移脚本按设计
 * 会被反复跑，每次都重写一遍已合规条目只会平白制造 diff。
 *
 * 不再钉备份：单仓化之后全部记忆都在 agent-data 仓里，改写留下的差异 git 看得见、回退有
 * git，脚本里那层按时间戳的副本已删（理由写在脚本头）。
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseFrontmatter } from '../lib/memory/frontmatter.js'
import { SHARED_SEGMENT, resolveScopeDir } from '../lib/memory/core.js'
import { resolveRoot } from '../lib/memory-root.js'
import { SCRIPTS_DIR, memoryTree, tempRoot, withTempDir } from './helpers.js'

const scriptPath = join(SCRIPTS_DIR, 'migrate-frontmatter.mjs')

/** 老布局实锤形态：name: ＋ description: ＋ metadata:（缩进块），没有 title:。 */
const LEGACY = '---\nname: batch-subagent-process\ndescription: 批次执行与子代理复核纪律（DSH 载体）——两道自检门\nmetadata:\n  type: feedback\n---\n\n# 批次执行与子代理复核（DSH 载体，边跑边精进）\n\n正文。\n'
/** 已合规的老条目：迁脚本对它不许有任何动作（幂等的基础）。 */
const ALREADY_OK = '---\ntitle: 老条目\ndescription: 触发词\n---\n\n正文。\n'
/** 值折行：转换后仍不合规，必须跳过而不是硬写。 */
const FOLDED = '---\ntitle: 折行条目\ndescription: >-\n  第一行\n  第二行\n---\n\n正文。\n'
const RETIRED_INDEX = '# 索引\n\n- [老条目](old-entry.md) — 触发词\n'
const WRITING_RULES = '# 记忆书写\n\n两键。\n'

let base
let memoryRoot
let store

before((t) => {
	base = tempRoot(t, 'memory-migrate')
	;({ root: memoryRoot, store } = memoryTree(base, 'memory'))
	writeFileSync(join(store, 'batch-subagent-process.md'), LEGACY, 'utf8')
	writeFileSync(join(store, 'old-entry.md'), ALREADY_OK, 'utf8')
	writeFileSync(join(store, 'folded.md'), FOLDED, 'utf8')
	writeFileSync(join(store, 'MEMORY.md'), RETIRED_INDEX, 'utf8')
	writeFileSync(join(store, 'WRITING.md'), WRITING_RULES, 'utf8')
})

function runScript(args) {
	const result = spawnSync(process.execPath, [scriptPath, memoryRoot, ...args], { encoding: 'utf8' })
	assert.equal(result.error, undefined, `脚本起不来：${result.error?.message ?? ''}`)
	return { code: result.status, stdout: result.stdout }
}

test('dry-run：逐条报将要做什么，且不落盘（迁移是批量原地重写，默认不写是唯一安全的默认）', () => {
	const { code, stdout } = runScript([])
	assert.match(stdout, /dry-run/, stdout)
	assert.match(stdout, /batch-subagent-process\.md/, stdout)
	assert.match(stdout, /批次执行与子代理复核/, stdout)
	assert.equal(readFileSync(join(store, 'batch-subagent-process.md'), 'utf8'), LEGACY, 'dry-run 不得改文件')
	assert.ok(existsSync(join(store, 'MEMORY.md')), 'dry-run 不得删文件')
	assert.ok(!stdout.includes('不在迁移面'), '这一份语料没有非 kebab 名的 .md：N=0 时那一句整个不印')
	assert.notEqual(code, 0, '有待迁条目时退出码须非 0，否则 CI 里没人看得见')
})

test('--apply：转换结果恰为两键，name:/metadata: 不留残迹，退役索引文件删除', () => {
	const { code, stdout } = runScript(['--apply'])
	assert.match(stdout, /folded\.md/, '转换后仍不合规的文件要被点名跳过')

	const converted = readFileSync(join(store, 'batch-subagent-process.md'), 'utf8')
	const parsed = parseFrontmatter(converted)
	assert.equal(parsed.ok, true, `转换结果须合规：${parsed.error}`)
	assert.deepEqual(Object.keys(parsed.frontmatter), ['title', 'description'])
	assert.equal(parsed.frontmatter.title, '批次执行与子代理复核', 'title 从正文首个 H1 派生，遇「（」断开')
	assert.equal(parsed.frontmatter.description, '批次执行与子代理复核纪律（DSH 载体）——两道自检门', 'description 原值保留，脚本不编造触发词')
	assert.doesNotMatch(converted, /^name:/m, 'name: 是与文件名重复的死字段，须删干净')
	assert.doesNotMatch(converted, /^metadata:/m, 'metadata: 连同其缩进块须删干净')
	assert.ok(converted.includes('# 批次执行与子代理复核（DSH 载体，边跑边精进）'), '正文原样保留')

	assert.equal(readFileSync(join(store, 'old-entry.md'), 'utf8'), ALREADY_OK, '已合规条目不动')
	assert.equal(readFileSync(join(store, 'folded.md'), 'utf8'), FOLDED, '转换后仍不合规的文件不硬写')
	assert.equal(existsSync(join(store, 'MEMORY.md')), false, '退役的索引文件在 --apply 下删掉')
	assert.equal(readFileSync(join(store, 'WRITING.md'), 'utf8'), WRITING_RULES, 'WRITING.md 也是保留名，但它不是索引文件，不许删')
	assert.notEqual(code, 0, '有文件被跳过时退出码须非 0（跳过＝仍需人工处理）')
})

/**
 * 脚本打印的相对路径由 path.relative 给：本机是反斜杠、对机是斜杠。断言一律经 join 拼，
 * 写死某一种分隔符就只在写它的那台机器上成立。
 */
const rel = (...parts) => join(...parts)

test('二次跑：零改动（迁移脚本被反复跑是常态，每次重写已合规条目只会平白制造 diff）', () => {
	const before = readFileSync(join(store, 'batch-subagent-process.md'), 'utf8')
	const { stdout } = runScript(['--apply'])
	assert.match(stdout, /已合规条目 2 条/, stdout)
	assert.match(stdout, /待迁 0 条/, stdout)
	assert.equal(readFileSync(join(store, 'batch-subagent-process.md'), 'utf8'), before, '已迁移的条目再跑一次不改')
	// 折行那条是永久跳过项（转换后仍不合规），故「零改动」不等于「零跳过」
	assert.ok(stdout.includes(`跳过 ${rel('memory', 'folded.md')}`), '折行条目始终是跳过项')
})

/**
 * 另起一个临时记忆根跑单条语料：共享 fixture 里有「已合规条目 2 条」这类计数断言，
 * 往那个语料里加条目会把它搅动，于是分支各自带语料、各自用完即删。
 */
function withCorpus(t, seed, run) {
	return withTempDir(t, 'memory-migrate-case', (dir) => {
		seed(dir)
		return run(dir)
	})
}

const runOn = (root, args) => {
	const result = spawnSync(process.execPath, [scriptPath, root, ...args], { encoding: 'utf8' })
	assert.equal(result.error, undefined, `脚本起不来：${result.error?.message ?? ''}`)
	return { code: result.status, stdout: result.stdout }
}

/**
 * 段目录问 core 的路由同一份：脚本装配时也问它，两处各拼一次就会铺到扫不到的地方。
 * 共享段＝store 顶层，机器段＝store/machines/<机器id>（storeOf 是共享段那一支的老写法）。
 */
const storeOf = (root) => resolveRoot(root).store
const segmentDir = (root, segment) => resolveScopeDir(resolveRoot(root), segment)

const writeSegmentEntry = (root, segment, file, text) => {
	const dir = segmentDir(root, segment)
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, file), text, 'utf8')
	return dir
}

const writeEntry = (root, file, text) => writeSegmentEntry(root, SHARED_SEGMENT, file, text)

/** 读一项条目的两键值：迁移结果的判据问解析器，不在测试里另认一套 frontmatter 形态。 */
const readKeysIn = (root, segment, file) => {
	const parsed = parseFrontmatter(readFileSync(join(segmentDir(root, segment), file), 'utf8'))
	assert.equal(parsed.ok, true, `转换结果须合规：${parsed.error}`)
	return parsed.frontmatter
}

const readKeys = (root, file) => readKeysIn(root, SHARED_SEGMENT, file)

test('CRLF 老条目：dry-run 明说会把行尾整篇归一为 LF（与写侧 edit 同口径，不做保真）', (t) => {
	withCorpus(t,
		(root) =>
			writeEntry(
				root,
				'crlf.md',
				'---\r\nname: crlf\r\ndescription: 触发词\r\nmetadata:\r\n  type: feedback\r\n---\r\n\r\n# 老条目\r\n\r\n正文。\r\n',
			),
		(root) => {
			const dry = runOn(root, [])
			assert.match(dry.stdout, /1 个文件是 CRLF 行尾/, `dry-run 须报出会翻转行尾的文件数：\n${dry.stdout}`)
			assert.match(dry.stdout, /归一为 LF/, dry.stdout)
			runOn(root, ['--apply'])
			const converted = readFileSync(join(storeOf(root), 'crlf.md'), 'utf8')
			assert.ok(!converted.includes('\r'), '整篇行尾归一为 LF：git diff 会看到全文翻转，这是刻意与写侧同口径')
			assert.equal(readKeys(root, 'crlf.md').title, '老条目', 'CRLF 条目照样能迁移（行归一在前，围栏定位在其后）')
		},
	)
})

test('机器段里的老布局条目同在迁移扫描内（段清点吃全部段，不只 store 顶层）', (t) => {
	withCorpus(t,
		(root) =>
			writeSegmentEntry(
				root,
				'home',
				'legacy.md',
				'---\nname: legacy\ndescription: 触发词\nmetadata:\n  type: feedback\n---\n\n# 本机老条目\n\n正文。\n',
			),
		(root) => {
			const dry = runOn(root, [])
			// 只扫 store 顶层时这里既不报「拟改写」也不报跳过，整份报告与「已合规」同形：
			// 机器段漏扫不会自己说话，故这条要钉住它在扫描内（单仓化后机器段也是记忆条目）
			assert.ok(
				dry.stdout.includes(`拟 改写 ${rel('memory', 'machines', 'home', 'legacy.md')}`),
				`机器段条目须在扫描内：\n${dry.stdout}`,
			)
			assert.match(dry.stdout, /待迁 1 条/, dry.stdout)
			const applied = runOn(root, ['--apply'])
			assert.equal(applied.code, 0, `机器段条目迁干净时退出 0：\n${applied.stdout}`)
			assert.equal(readKeysIn(root, 'home', 'legacy.md').title, '本机老条目', '机器段条目同样迁到两键')
		},
	)
})

test('条目名被同名目录占住：逐条降级成「跳过」，不让异常崩掉整轮迁移', (t) => {
	withCorpus(t,
		(root) => {
			writeEntry(root, 'ok.md', '---\nname: ok\ndescription: 触发词\n---\n\n# 条目\n\n正文。\n')
			mkdirSync(join(storeOf(root), 'broken.md'), { recursive: true })
		},
		(root) => {
			const { code, stdout } = runOn(root, ['--apply'])
			assert.ok(stdout.includes(`跳过 ${rel('memory', 'broken.md')}：读不动`), `读不动须降级上报：\n${stdout}`)
			assert.doesNotMatch(stdout, /at\s+\S+\s+\(.*:\d+:\d+\)/, '逐条降级，不许把栈回溯抛到顶层')
			assert.equal(code, 1, '有跳过条目时退出码须非 0（跳过＝仍需人工处理）')
			assert.equal(readKeys(root, 'ok.md').description, '触发词', '一条坏的不许挡住另一条')
		},
	)
})

test('迁移不得造出它要躲的那个问题：转换结果段内撞名的条目推进跳过，落盘后以非 0 退出', (t) => {
	withCorpus(t,
		(root) => {
			// 三条老布局条目从同一个 H1 派生 title：撞名是转换这一刻才出现的，而本脚本按设计
			// 不经写侧 assertTitleFree（那个拦截只管 write/edit 这条链路）
			for (const file of ['dup-a.md', 'dup-b.md', 'dup-c.md']) {
				writeEntry(root, file, `---\nname: ${file.replace('.md', '')}\ndescription: 触发词\n---\n\n# 同题条目\n\n正文。\n`)
			}
			writeEntry(root, 'ok.md', '---\nname: ok\ndescription: 触发词\n---\n\n# 独一份\n\n正文。\n')
		},
		(root) => {
			const dry = runOn(root, [])
			assert.ok(
				dry.stdout.includes(`跳过 ${rel('memory', 'dup-a.md')}：转换结果与同段的 dup-b.md、dup-c.md 撞 title「同题条目」`),
				dry.stdout,
			)
			assert.match(dry.stdout, /待迁 1 条、跳过 3 条/, dry.stdout)

			const applied = runOn(root, ['--apply'])
			assert.equal(applied.code, 1, '落盘后有跳过条目须以非 0 退出，否则没人看得见要人工处理')
			for (const file of ['dup-a.md', 'dup-b.md', 'dup-c.md']) {
				assert.match(
					readFileSync(join(storeOf(root), file), 'utf8'),
					/^name:/m,
					`${file} 撞名就不该落盘——带着判红落下去，这个退路本身就成了新的退路`,
				)
			}
			assert.equal(readKeys(root, 'ok.md').title, '独一份', '不撞名的那条照常迁，撞名不许把整段封死')
		},
	)
})

test('记忆根不存在或根下没有 store：退出 1 并说明没接线（不是「无需迁移」）', (t) => {
	withTempDir(t, 'memory-migrate-root', (dir) => {
		const missing = runOn(join(dir, 'no-such-root'), [])
		assert.equal(missing.code, 1, '记忆根没接线不得以 0 退出告诉人「已合规」')
		assert.match(missing.stdout, /没有 store 目录/, missing.stdout)
		// 根在、store 目录一个都没有：与「根不存在」症状同形（段清点的唯一入口就是 store），
		// 走的是另一扇门，两扇门都得判红
		const bare = join(dir, 'bare')
		mkdirSync(join(bare, 'machines'), { recursive: true })
		const empty = runOn(bare, [])
		assert.equal(empty.code, 1, '根下 0 段同样不得以 0 退出')
		assert.match(empty.stdout, /没有 store 目录/, empty.stdout)
	})
})

test('title 派生：四种断开标点各断一次，断完为空就退回文件名 stem', (t) => {
	const cases = [
		['paren.md', '# 全角括号（副标题）\n', '全角括号'],
		['paren-ascii.md', '# 半角括号 (副标题)\n', '半角括号'],
		['colon.md', '# 冒号：副标题\n', '冒号'],
		['dash.md', '# 破折号——副标题\n', '破折号'],
		// 下面两条派生不出语义名：正文没有 H1，以及 H1 一上来就是断开标点
		['no-heading.md', '正文没有 H1。\n', 'no-heading'],
		['bracket-first.md', '#（括号开头，没有语义名）\n', 'bracket-first'],
	]
	withCorpus(t,
		(root) => {
			for (const [file, body] of cases) writeEntry(root, file, `---\nname: ${file.replace('.md', '')}\ndescription: 触发词\n---\n\n${body}`)
		},
		(root) => {
			runOn(root, ['--apply'])
			for (const [file, , expected] of cases) {
				assert.equal(readKeys(root, file).title, expected, `${file} 的 title 派生`)
			}
		},
	)
})

test('没有成形 frontmatter 的文件：跳过并点名（机械转换无从下手时不硬改）', (t) => {
	withCorpus(t,
		(root) => {
			writeEntry(root, 'no-fence.md', '# 根本没有 frontmatter\n\n正文。\n')
			writeEntry(root, 'unclosed.md', '---\ntitle: 未闭合\ndescription: 触发词\n\n正文。\n')
			writeEntry(root, 'ok.md', '---\nname: ok\ndescription: 触发词\n---\n\n# 条目\n')
		},
		(root) => {
			const { code, stdout } = runOn(root, ['--apply'])
			assert.ok(stdout.includes(`跳过 ${rel('memory', 'no-fence.md')}：首行不是 ---`), stdout)
			assert.ok(stdout.includes(`跳过 ${rel('memory', 'unclosed.md')}：frontmatter 未闭合`), stdout)
			assert.equal(code, 1, '有跳过条目时退出码须非 0')
			assert.equal(readFileSync(join(storeOf(root), 'no-fence.md'), 'utf8'), '# 根本没有 frontmatter\n\n正文。\n', '跳过的文件原样不动')
			assert.equal(readKeys(root, 'ok.md').description, '触发词', '能迁的那条照迁')
		},
	)
})

test('metadata 块被空行终结：块后的键属于别的键，不跟着 metadata 一起删', (t) => {
	withCorpus(t,
		(root) => {
			writeEntry(
				root,
				'after-blank.md',
				'---\nname: after-blank\ndescription: 触发词\nmetadata:\n  type: feedback\n  note: 缩进块第二行\n\nother: 块后的键\n---\n\n# 条目\n',
			)
		},
		(root) => {
			const { code, stdout } = runOn(root, ['--apply'])
			// 块后的 other: 留下来了，于是转换结果是三键、不合规：这条正是「空行终结 metadata 块」
			// 的行为证据——若空行没有终结，缩进行判定不参与，结论也一样，但少了这条就用例钉不住它
			assert.ok(stdout.includes(`跳过 ${rel('memory', 'after-blank.md')}`), stdout)
			assert.match(stdout, /多余键|other/, stdout)
			assert.equal(code, 1)
		},
	)
})

test('退役索引文件按保留名判定，大小写不敏感（大小写不敏感的文件系统上二者是同一个文件）', (t) => {
	withCorpus(t,
		(root) => {
			writeEntry(root, 'ok.md', '---\ntitle: 条目\ndescription: 触发词\n---\n\n正文。\n')
			writeEntry(root, 'memory.md', '# 索引\n')
			writeEntry(root, 'WRITING.md', '# 纪律\n')
		},
		(root) => {
			const { stdout } = runOn(root, ['--apply'])
			assert.ok(stdout.includes(`删除 ${rel('memory', 'memory.md')}`), stdout)
			assert.equal(existsSync(join(storeOf(root), 'memory.md')), false)
			assert.equal(existsSync(join(storeOf(root), 'WRITING.md')), true, 'WRITING.md 是保留名但不是退役索引，不许删')
		},
	)
})

test('非 kebab 名的 .md 不在迁移面：总数行显式报出数量与内容不动（静默略过会被读成「这一段已迁干净」）', (t) => {
	withCorpus(t,
		(root) => {
			writeEntry(root, 'ok.md', '---\nname: ok\ndescription: 触发词\n---\n\n# 条目\n\n正文。\n')
			// 非 kebab 名按同一份判据不是条目，迁移不碰它（写侧也不认这个名），可它是盘上看得
			// 见的 .md——不说一句，这份报告与「这一段的 .md 都迁完了」同形
			writeEntry(root, 'Foo.md', '---\ntitle: 大写名条目\ndescription: 触发词\n---\n\n正文。\n')
		},
		(root) => {
			const dry = runOn(root, [])
			assert.ok(dry.stdout.includes('另有 1 个文件因非 kebab 名不在迁移面'), `总数行须报出不在迁移面的那些：\n${dry.stdout}`)
			const applied = runOn(root, ['--apply'])
			assert.ok(applied.stdout.includes('另有 1 个文件因非 kebab 名不在迁移面'), applied.stdout)
			assert.equal(readKeys(root, 'ok.md').title, '条目', '条目名合规的那条照常迁')
			// 它真的没被动过：迁移面外的文件连 title 都不补——碰了就是把「不算条目」改写成另一种形态
			assert.equal(
				readFileSync(join(storeOf(root), 'Foo.md'), 'utf8'),
				'---\ntitle: 大写名条目\ndescription: 触发词\n---\n\n正文。\n',
				'非 kebab 名的文件不在迁移面，内容原样不动',
			)
		},
	)
})
