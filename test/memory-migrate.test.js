/**
 * migrate-frontmatter.mjs 的单测：子进程跑真实脚本，跑在 mkdtemp 出的临时记忆根上。
 *
 * 钉的是迁移的三条硬性质：转换后的 frontmatter 恰是两键（name:/metadata: 不留残迹）；
 * 转换后仍不合规的文件原样不动、不硬写；--apply 之前先备份且备份与记忆根同级（放进
 * workspaces/ 会被 listLayerDirs 当成一层扫，造出幽灵层）。幂等另钉一次：第二次跑零改动、
 * 零备份——迁移脚本按设计会被反复跑，每次都重写一遍已合规条目只会平白制造 diff 与备份。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseFrontmatter } from '../lib/memory/frontmatter.js'

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'migrate-frontmatter.mjs')

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
let profile

before(() => {
	base = mkdtempSync(join(tmpdir(), 'dsh-memory-migrate-'))
	memoryRoot = join(base, 'memory')
	profile = join(memoryRoot, 'profile')
	mkdirSync(profile, { recursive: true })
	writeFileSync(join(profile, 'batch-subagent-process.md'), LEGACY, 'utf8')
	writeFileSync(join(profile, 'old-entry.md'), ALREADY_OK, 'utf8')
	writeFileSync(join(profile, 'folded.md'), FOLDED, 'utf8')
	writeFileSync(join(profile, 'MEMORY.md'), RETIRED_INDEX, 'utf8')
	writeFileSync(join(profile, 'WRITING.md'), WRITING_RULES, 'utf8')
})

after(() => {
	rmSync(base, { recursive: true, force: true })
})

function runScript(args) {
	const result = spawnSync(process.execPath, [scriptPath, memoryRoot, ...args], { encoding: 'utf8' })
	assert.equal(result.error, undefined, `脚本起不来：${result.error?.message ?? ''}`)
	return { code: result.status, stdout: result.stdout }
}

/**
 * 备份根与记忆根同级：listLayerDirs 只把 `profile` 与 `workspaces/<x>` 当层扫，
 * 放进 `workspaces/` 才会被扫成一层幽灵语料（放进记忆根顶层是安全的）。
 */
const backupRoot = () => join(base, 'memory-migrate-backups')
const backupDirs = () => (existsSync(backupRoot()) ? readdirSync(backupRoot()) : [])

test('dry-run：逐条报将要做什么，且不落盘（迁移是批量原地重写，默认不写是唯一安全的默认）', () => {
	const { code, stdout } = runScript([])
	assert.match(stdout, /dry-run/, stdout)
	assert.match(stdout, /batch-subagent-process\.md/, stdout)
	assert.match(stdout, /批次执行与子代理复核/, stdout)
	assert.equal(readFileSync(join(profile, 'batch-subagent-process.md'), 'utf8'), LEGACY, 'dry-run 不得改文件')
	assert.ok(existsSync(join(profile, 'MEMORY.md')), 'dry-run 不得删文件')
	assert.deepEqual(backupDirs(), [], 'dry-run 不建备份目录')
	assert.notEqual(code, 0, '有待迁条目时退出码须非 0，否则 CI 里没人看得见')
})

test('--apply：转换结果恰为两键，name:/metadata: 不留残迹，退役索引文件删除，备份等于改前原文', () => {
	const { code, stdout } = runScript(['--apply'])
	assert.match(stdout, /备份目录：/, stdout)
	assert.match(stdout, /folded\.md/, '转换后仍不合规的文件要被点名跳过')

	const converted = readFileSync(join(profile, 'batch-subagent-process.md'), 'utf8')
	const parsed = parseFrontmatter(converted)
	assert.equal(parsed.ok, true, `转换结果须合规：${parsed.error}`)
	assert.deepEqual(Object.keys(parsed.frontmatter), ['title', 'description'])
	assert.equal(parsed.frontmatter.title, '批次执行与子代理复核', 'title 从正文首个 H1 派生，遇「（」断开')
	assert.equal(parsed.frontmatter.description, '批次执行与子代理复核纪律（DSH 载体）——两道自检门', 'description 原值保留，脚本不编造触发词')
	assert.doesNotMatch(converted, /^name:/m, 'name: 是与文件名重复的死字段，须删干净')
	assert.doesNotMatch(converted, /^metadata:/m, 'metadata: 连同其缩进块须删干净')
	assert.ok(converted.includes('# 批次执行与子代理复核（DSH 载体，边跑边精进）'), '正文原样保留')

	assert.equal(readFileSync(join(profile, 'old-entry.md'), 'utf8'), ALREADY_OK, '已合规条目不动')
	assert.equal(readFileSync(join(profile, 'folded.md'), 'utf8'), FOLDED, '转换后仍不合规的文件不硬写')
	assert.equal(existsSync(join(profile, 'MEMORY.md')), false, '退役的索引文件在 --apply 下删掉')
	assert.equal(readFileSync(join(profile, 'WRITING.md'), 'utf8'), WRITING_RULES, 'WRITING.md 也是保留名，但它不是索引文件，不许删')

	assert.equal(backupDirs().length, 1, '备份目录按时间戳只建一个')
	const backupDir = join(backupRoot(), backupDirs()[0])
	assert.equal(readFileSync(join(backupDir, 'profile', 'batch-subagent-process.md'), 'utf8'), LEGACY, '备份内容须等于改前原文')
	assert.equal(readFileSync(join(backupDir, 'profile', 'MEMORY.md'), 'utf8'), RETIRED_INDEX, '被删的文件同样要有备份：工作层不在任何 git 仓里')
	assert.equal(existsSync(join(backupDir, 'profile', 'old-entry.md')), false, '已合规条目不进备份')
	assert.notEqual(code, 0, '有文件被跳过时退出码须非 0（跳过＝仍需人工处理）')
})

test('二次跑：零改动零备份（迁移脚本被反复跑是常态，每次重写已合规条目只会平白制造 diff）', () => {
	const before = readFileSync(join(profile, 'batch-subagent-process.md'), 'utf8')
	const { stdout } = runScript(['--apply'])
	assert.match(stdout, /已合规条目 2 条/, stdout)
	assert.match(stdout, /待迁/, stdout)
	assert.equal(readFileSync(join(profile, 'batch-subagent-process.md'), 'utf8'), before, '已迁移的条目再跑一次不改')
	assert.equal(backupDirs().length, 1, '零待迁就不建新备份目录')
})

/**
 * 另起一个临时记忆根跑单条语料：共享 fixture 里有「已合规条目 2 条」这类计数断言，
 * 往那个语料里加条目会把它搅动，于是分支各自带语料、各自用完即删。
 */
function withCorpus(seed, run) {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-migrate-case-'))
	try {
		seed(dir)
		return run(dir)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

const runOn = (root, args) => {
	const result = spawnSync(process.execPath, [scriptPath, root, ...args], { encoding: 'utf8' })
	assert.equal(result.error, undefined, `脚本起不来：${result.error?.message ?? ''}`)
	return { code: result.status, stdout: result.stdout }
}

const writeEntry = (root, file, text) => {
	const dir = join(root, 'profile')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, file), text, 'utf8')
	return dir
}

/** 读一项条目的两键值：迁移结果的判据问解析器，不在测试里另认一套 frontmatter 形态。 */
const readKeys = (root, file) => {
	const parsed = parseFrontmatter(readFileSync(join(root, 'profile', file), 'utf8'))
	assert.equal(parsed.ok, true, `转换结果须合规：${parsed.error}`)
	return parsed.frontmatter
}

test('备份目录在动第一个文件之前就打印（中途失败时人得知道东西在哪、已经动了多少）', () => {
	withCorpus(
		(root) => writeEntry(root, 'legacy.md', '---\nname: legacy\ndescription: 触发词\nmetadata:\n  type: feedback\n---\n\n# 老条目\n\n正文。\n'),
		(root) => {
			const { stdout } = runOn(root, ['--apply'])
			const backupAt = stdout.indexOf('备份目录（改写前已复制原文件）')
			const changedAt = stdout.indexOf('已改 1 条')
			assert.ok(backupAt !== -1 && changedAt !== -1, stdout)
			assert.ok(backupAt < changedAt, `备份目录必须先于落盘结论打印：\n${stdout}`)
		},
	)
})

test('CRLF 老条目：dry-run 明说会把行尾整篇归一为 LF（与写侧 edit 同口径，不做保真）', () => {
	withCorpus(
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
			const converted = readFileSync(join(root, 'profile', 'crlf.md'), 'utf8')
			assert.ok(!converted.includes('\r'), '整篇行尾归一为 LF：git diff 会看到全文翻转，这是刻意与写侧同口径')
			assert.equal(readKeys(root, 'crlf.md').title, '老条目', 'CRLF 条目照样能迁移（行归一在前，围栏定位在其后）')
		},
	)
})

test('条目名被同名目录占住：逐条降级成「跳过」，不让异常崩掉整轮迁移', () => {
	withCorpus(
		(root) => {
			writeEntry(root, 'ok.md', '---\nname: ok\ndescription: 触发词\n---\n\n# 条目\n\n正文。\n')
			mkdirSync(join(root, 'profile', 'broken.md'), { recursive: true })
		},
		(root) => {
			const { code, stdout } = runOn(root, ['--apply'])
			assert.match(stdout, /跳过 profile\/broken\.md：读不动/, `读不动须降级上报：\n${stdout}`)
			assert.doesNotMatch(stdout, /at\s+\S+\s+\(.*:\d+:\d+\)/, '逐条降级，不许把栈回溯抛到顶层')
			assert.equal(code, 1, '有跳过条目时退出码须非 0（跳过＝仍需人工处理）')
			assert.equal(readKeys(root, 'ok.md').description, '触发词', '一条坏的不许挡住另一条')
		},
	)
})

test('记忆根不存在或根下没有层：退出 1 并说明没接线（不是「无需迁移」）', () => {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-migrate-root-'))
	try {
		const missing = runOn(join(dir, 'no-such-root'), [])
		assert.equal(missing.code, 1, '记忆根没接线不得以 0 退出告诉人「已合规」')
		assert.match(missing.stdout, /没有层目录/, missing.stdout)
		// 根在、层目录一个都没有（workspaces 在但没有子目录）：与「根不存在」症状同形，
		// 走的是另一扇门，两扇门都得判红
		const bare = join(dir, 'bare')
		mkdirSync(join(bare, 'workspaces'), { recursive: true })
		const empty = runOn(bare, [])
		assert.equal(empty.code, 1, '根下 0 层同样不得以 0 退出')
		assert.match(empty.stdout, /扫到 0 层/, empty.stdout)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

test('title 派生：四种断开标点各断一次，断完为空就退回文件名 stem', () => {
	const cases = [
		['paren.md', '# 全角括号（副标题）\n', '全角括号'],
		['paren-ascii.md', '# 半角括号 (副标题)\n', '半角括号'],
		['colon.md', '# 冒号：副标题\n', '冒号'],
		['dash.md', '# 破折号——副标题\n', '破折号'],
		// 下面两条派生不出语义名：正文没有 H1，以及 H1 一上来就是断开标点
		['no-heading.md', '正文没有 H1。\n', 'no-heading'],
		['bracket-first.md', '#（括号开头，没有语义名）\n', 'bracket-first'],
	]
	withCorpus(
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

test('没有成形 frontmatter 的文件：跳过并点名（机械转换无从下手时不硬改）', () => {
	withCorpus(
		(root) => {
			writeEntry(root, 'no-fence.md', '# 根本没有 frontmatter\n\n正文。\n')
			writeEntry(root, 'unclosed.md', '---\ntitle: 未闭合\ndescription: 触发词\n\n正文。\n')
			writeEntry(root, 'ok.md', '---\nname: ok\ndescription: 触发词\n---\n\n# 条目\n')
		},
		(root) => {
			const { code, stdout } = runOn(root, ['--apply'])
			assert.match(stdout, /跳过 profile\/no-fence\.md：首行不是 ---/, stdout)
			assert.match(stdout, /跳过 profile\/unclosed\.md：frontmatter 未闭合/, stdout)
			assert.equal(code, 1, '有跳过条目时退出码须非 0')
			assert.equal(readFileSync(join(root, 'profile', 'no-fence.md'), 'utf8'), '# 根本没有 frontmatter\n\n正文。\n', '跳过的文件原样不动')
			assert.equal(readKeys(root, 'ok.md').description, '触发词', '能迁的那条照迁')
		},
	)
})

test('metadata 块被空行终结：块后的键属于别的键，不跟着 metadata 一起删', () => {
	withCorpus(
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
			assert.match(stdout, /跳过 profile\/after-blank\.md/, stdout)
			assert.match(stdout, /多余键|other/, stdout)
			assert.equal(code, 1)
		},
	)
})

test('退役索引文件按保留名判定，大小写不敏感（大小写不敏感的文件系统上二者是同一个文件）', () => {
	withCorpus(
		(root) => {
			writeEntry(root, 'ok.md', '---\ntitle: 条目\ndescription: 触发词\n---\n\n正文。\n')
			writeEntry(root, 'memory.md', '# 索引\n')
			writeEntry(root, 'WRITING.md', '# 纪律\n')
		},
		(root) => {
			const { stdout } = runOn(root, ['--apply'])
			assert.match(stdout, /删除 profile\/memory\.md/, stdout)
			assert.equal(existsSync(join(root, 'profile', 'memory.md')), false)
			assert.equal(existsSync(join(root, 'profile', 'WRITING.md')), true, 'WRITING.md 是保留名但不是退役索引，不许删')
		},
	)
})
