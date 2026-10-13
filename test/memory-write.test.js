/**
 * dsh-memory 写侧单测（node:test，零宿主依赖）：索引行解析、层路由、
 * upsert（建/替换/拦截/风格告警）、edit（替换/索引行沿用/命中拦截）、
 * delete（清索引＋引用报告）、lint 体检。
 * upsert/edit 走 fs 端口（createNodeFsPort 构造一次、逐用例复用），故是 async；
 * delete 与 lint 的 I/O 留在 node:fs 保持同步（delete 接端口只为问一句能不能写）。
 * 每个用例独立临时根，互不共享状态。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_MEMORY_ROOT, INDEX_LINE_BUDGET, RUNAWAY_CEILING, absoluteMemoryRoot } from '../lib/memory/core.js'
import { createNodeFsPort } from '../lib/memory/fs-port.js'
import {
	deleteEntry,
	editEntry,
	lintMemory,
	parseIndexLine,
	upsertEntry,
} from '../lib/memory/write.js'

let base
const port = createNodeFsPort()

before(() => {
	base = join(tmpdir(), `dsh-memory-write-test-${process.pid}`)
	mkdirSync(base, { recursive: true })
})

after(() => {
	rmSync(base, { recursive: true, force: true })
})

test('absoluteMemoryRoot：记忆根归一成绝对路径（相对路径不按两套基目录分家）', () => {
	assert.equal(absoluteMemoryRoot(DEFAULT_MEMORY_ROOT), join(homedir(), '.dsh', 'memory'), '默认根的 ~ 要展开')
	assert.equal(absoluteMemoryRoot('~/tilde'), join(homedir(), 'tilde'))
	// 相对根按 process.cwd() 定死：否则写侧走宿主 fs 后端基目录、读侧走 cwd，两套语义
	assert.equal(absoluteMemoryRoot('相对根'), resolve('相对根'))
	assert.equal(absoluteMemoryRoot('./a/../b'), resolve('b'))
	assert.equal(absoluteMemoryRoot('/abs/root'), '/abs/root', '绝对路径原样透传')
})

test('parseIndexLine：条目行解析、非条目行返回 null', () => {
	assert.deepEqual(parseIndexLine('- [tauritavern-toolkit](tauritavern-toolkit.md) — **TT工具箱→查此条**'), {
		title: 'tauritavern-toolkit',
		file: 'tauritavern-toolkit.md',
		rest: '— **TT工具箱→查此条**',
	})
	assert.equal(parseIndexLine('# 标题'), null)
	assert.equal(parseIndexLine('普通段落 [[wikilink]]'), null)
	assert.equal(parseIndexLine('42'), null)
	assert.equal(parseIndexLine(undefined), null)
})

test('upsertEntry：工作层新建＝建桶＋条目＋索引头，返回 added 且无风格告警', async () => {
	const root = join(base, 'write-add')
	const r = await upsertEntry({
		port,
		memoryRoot: root,
		cwd: 'D:\\code',
		layer: 'workspace',
		file: 'demo-topic.md',
		content: '正文',
		indexLine: '- [demo-topic](demo-topic.md) — **demo→查此条**',
	})
	assert.equal(r.indexAction, 'added')
	assert.ok(r.dir.endsWith(join('workspaces', 'D-code')))
	assert.equal(existsSync(join(r.dir, 'demo-topic.md')), true)
	const index = readFileSync(r.indexPath, 'utf8')
	assert.ok(index.startsWith('# 工作层索引'))
	assert.ok(index.includes('(demo-topic.md)'))
	assert.deepEqual(r.warnings, [])
})

test('upsertEntry：日期戳与缺触发尾注进 warnings（提示不拦截）', async () => {
	const root = join(base, 'write-warn')
	const r = await upsertEntry({
		port,
		memoryRoot: root,
		layer: 'habit',
		file: 'dated.md',
		content: 'x',
		indexLine: '- [dated](dated.md) — 2026-01-02 记录',
	})
	assert.equal(r.warnings.length, 2)
	assert.ok(r.warnings.some((w) => w.includes('日期戳')))
	assert.ok(r.warnings.some((w) => w.includes('查此条')))
})

test('upsertEntry：替换＝索引行换新、正文覆写，indexAction=replaced', async () => {
	const root = join(base, 'write-replace')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: 'v1', indexLine: '- [topic](topic.md) — **旧→查此条**' })
	const r = await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: 'v2', indexLine: '- [topic](topic.md) — **新→查此条**' })
	assert.equal(r.indexAction, 'replaced')
	assert.equal(readFileSync(join(r.dir, 'topic.md'), 'utf8'), 'v2\n')
	const index = readFileSync(r.indexPath, 'utf8')
	assert.ok(index.includes('**新→查此条**') && !index.includes('**旧→查此条**'))
	assert.equal(index.split('\n').filter((l) => parseIndexLine(l)?.file === 'topic.md').length, 1, '索引行唯一')
})

test('upsertEntry：拦截类校验（文件名/保留名/空文/超限/链接不一致/非链接行/同名异文件）', async () => {
	const root = join(base, 'write-reject')
	const ok = { port, memoryRoot: root, layer: 'habit', file: 'ok.md', content: 'x', indexLine: '- [ok](ok.md) — **x→查此条**' }
	await assert.rejects(() => upsertEntry({ ...ok, file: 'Bad_Name.md' }), /kebab/)
	await assert.rejects(() => upsertEntry({ ...ok, file: 'memory.md' }), /保留名/)
	await assert.rejects(() => upsertEntry({ ...ok, content: '' }), /content/)
	await assert.rejects(() => upsertEntry({ ...ok, content: 'x'.repeat(RUNAWAY_CEILING + 1) }), /失控保护/)
	await assert.rejects(() => upsertEntry({ ...ok, indexLine: '- [ok](other.md) — **x→查此条**' }), /不一致/)
	await assert.rejects(() => upsertEntry({ ...ok, indexLine: 'plain text' }), /列表链接行/)
	await assert.rejects(() => upsertEntry({ port, memoryRoot: root, layer: 'workspace', file: 'a.md', content: 'x', indexLine: '- [a](a.md) — **x→查此条**' }), /cwd/)
	// 同名标题链到另一文件 → 拦截且不落盘（拦截类承诺，不留孤儿）
	await upsertEntry({ ...ok })
	await assert.rejects(() => upsertEntry({ ...ok, file: 'ok2.md', indexLine: '- [ok](ok2.md) — **x→查此条**' }), /同名/)
	assert.equal(existsSync(join(root, 'profile', 'ok2.md')), false, '拦截分支不得落盘')
})

test('upsertEntry：前置拦截（未知层/空桶名/空 indexLine）', async () => {
	const root = join(base, 'pre-reject')
	const ok = { port, memoryRoot: root, layer: 'habit', file: 'ok.md', content: 'x', indexLine: '- [ok](ok.md) — **x→查此条**' }
	await assert.rejects(() => upsertEntry({ ...ok, layer: 'bogus' }), /未知层/)
	await assert.rejects(() => upsertEntry({ ...ok, layer: 'workspace', cwd: '///' }), /桶名为空/)
	await assert.rejects(() => upsertEntry({ ...ok, indexLine: '' }), /indexLine 不能为空/)
	await assert.rejects(() => upsertEntry({ ...ok, indexLine: '   ' }), /indexLine 不能为空/)
})

test('upsertEntry/editEntry/deleteEntry：会话策略不许写时三个动作全拒（只问端口，code 落宿主词表）', async () => {
	const root = join(base, 'write-readonly')
	const readOnly = createNodeFsPort({ sandboxPolicy: { mode: 'read-only', workspaceRoot: '/tmp', sessionId: 'session-1' } })
	const args = { port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: 'x', indexLine: '- [topic](topic.md) — **x→查此条**' }
	await assert.rejects(() => upsertEntry({ ...args, port: readOnly }), (error) => {
		// code 在宿主词表内，harness 的 toolErrorResult 与模型才拿得到类型
		assert.equal(error.code, 'FS_SANDBOX_DENIED')
		assert.match(error.message, /danger-full-access/)
		assert.doesNotMatch(error.message, /workspace-write 或更高/, '围栏范围是会话 cwd，照着改成 workspace-write 仍然被拒，不得这么引导')
		return true
	})
	assert.equal(existsSync(join(root, 'profile')), false, '被拒的写入不得建桶落盘')
	await upsertEntry(args)
	await assert.rejects(() => editEntry({ port: readOnly, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: 'x', newString: 'y' }), /不允许写记忆/)
	assert.equal(readFileSync(join(root, 'profile', 'topic.md'), 'utf8'), 'x\n', '被拒的编辑不得落盘')
	// delete 的 I/O 虽留在 node:fs（宿主契约无删除能力），照样接端口问能不能写：
	// 四个 action 同一口径。它是同步函数（I/O 无 await），故用 throws 而非 rejects
	assert.throws(() => deleteEntry({ port: readOnly, memoryRoot: root, layer: 'habit', file: 'topic.md' }), /不允许写记忆/)
	assert.ok(existsSync(join(root, 'profile', 'topic.md')), '被拒的删除不得动条目')
	// 策略缺省（无会话上下文）＝不受限：字段缺席不得被当成只读而误拒
	const ok = await upsertEntry({ ...args, file: 'other.md', indexLine: '- [other](other.md) — **y→查此条**' })
	assert.equal(ok.indexAction, 'added')
	// 只读策略只关写入：读侧与体检照常可用（文案里承诺过这句）
	assert.equal(lintMemory({ memoryRoot: root }).ok, true)
})

test('upsertEntry：索引写入带版本守卫，读后写前被并发改动即拒写', async () => {
	const root = join(base, 'write-guard')
	const first = await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'one.md', content: 'x', indexLine: '- [one](one.md) — **x→查此条**' })
	// 竞态窗口在「读到索引」与「写回索引」之间：在 readText 返回后立刻由并发方改写
	// 索引，才能真正踩到守卫（先把索引改掉再进 upsert 会被本次 stat 观察到，不构成竞态）
	let raced = false
	const racing = {
		...port,
		async readText(target) {
			const text = await port.readText(target)
			if (!raced && target.displayPath === first.indexPath) {
				raced = true
				writeFileSync(first.indexPath, '# 习惯层索引（使用习惯，跨机同步）\n\n- [two](two.md) — **并发方落盘**\n', 'utf8')
			}
			return text
		},
	}
	await assert.rejects(
		() => upsertEntry({ port: racing, memoryRoot: root, layer: 'habit', file: 'one.md', content: 'v2', indexLine: '- [one](one.md) — **新→查此条**' }),
		(error) => {
			assert.equal(error.code, 'FS_STALE_VERSION')
			assert.match(error.message, /重试/)
			return true
		},
	)
	assert.ok(readFileSync(first.indexPath, 'utf8').includes('并发方落盘'), '版本失配不得静默覆盖并发方的索引行')
	// write 路径的条目正文写无守卫（语义是「以我这份为准」，见 upsertEntry 模块注释），
	// 故本次正文已随之更新；这条不作为期望断言——半成态只在 write 路径成立，
	// edit 路径的同款竞态由下一条用例钉住
})

test('editEntry：并发两次改同一条目，后到者抛 FS_STALE_VERSION 且先到者正文完好', async () => {
	const root = join(base, 'edit-guard')
	const entryPath = join(root, 'profile', 'topic.md')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: 'v1 状态行', indexLine: '- [topic](topic.md) — **x→查此条**' })
	// 竞态窗口在 editEntry 读条目与 upsert 写条目之间：在 readText 返回后立刻由并发方
	// 直接改写正文（绕过端口），后到的 edit 才踩得到传下去的 entryVersion 守卫
	let raced = false
	const racing = {
		...port,
		async readText(target) {
			const text = await port.readText(target)
			if (!raced && target.displayPath === entryPath) {
				raced = true
				writeFileSync(entryPath, '并发方先改\n', 'utf8')
			}
			return text
		},
	}
	await assert.rejects(
		() => editEntry({ port: racing, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: 'v1 状态行', newString: 'v2 状态行' }),
		(error) => {
			assert.equal(error.code, 'FS_STALE_VERSION')
			assert.match(error.message, /重试/)
			return true
		},
	)
	assert.equal(readFileSync(entryPath, 'utf8'), '并发方先改\n', '版本失配不得静默吃掉并发方刚落的正文')
	assert.ok(readFileSync(join(root, 'profile', 'MEMORY.md'), 'utf8').includes('- [topic](topic.md)'), '正文写被拒时索引不该动')
})

test('editEntry：字面替换整文落盘、缺省沿用现索引行（indexAction=replaced 但索引文本不变）', async () => {
	const root = join(base, 'edit-basic')
	await upsertEntry({
		port,
		memoryRoot: root,
		layer: 'habit',
		file: 'topic.md',
		content: '# 标题\n\nv1 状态行\n\n- 保留行',
		indexLine: '- [topic](topic.md) — **x→查此条**',
	})
	const r = await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: 'v1 状态行', newString: 'v2 状态行' })
	assert.equal(r.replacements, 1)
	assert.equal(readFileSync(join(r.dir, 'topic.md'), 'utf8'), '# 标题\n\nv2 状态行\n\n- 保留行\n')
	const index = readFileSync(r.indexPath, 'utf8')
	assert.ok(index.includes('- [topic](topic.md) — **x→查此条**'), '缺省不改索引行')
	assert.equal(index.split('\n').filter((l) => parseIndexLine(l)?.file === 'topic.md').length, 1, '索引行唯一')
	assert.deepEqual(r.warnings, [])
})

test('editEntry：显式 indexLine 同笔换、replaceAll 全替换并计处数', async () => {
	const root = join(base, 'edit-advanced')
	await upsertEntry({
		port,
		memoryRoot: root,
		layer: 'habit',
		file: 'topic.md',
		content: '甲旧\n乙旧\n丙新',
		indexLine: '- [topic](topic.md) — **旧→查此条**',
	})
	const r = await editEntry({
		port,
		memoryRoot: root,
		layer: 'habit',
		file: 'topic.md',
		oldString: '旧',
		newString: '新',
		replaceAll: true,
		indexLine: '- [topic](topic.md) — **新→查此条**',
	})
	assert.equal(r.replacements, 2)
	assert.equal(readFileSync(join(r.dir, 'topic.md'), 'utf8'), '甲新\n乙新\n丙新\n')
	assert.ok(readFileSync(r.indexPath, 'utf8').includes('**新→查此条**'))
})

test('editEntry：命中拦截（不命中/多处未声明 replaceAll）与前置拦截（非 kebab/条目不存在/孤儿无索引行）', async () => {
	const root = join(base, 'edit-reject')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: '重复\n重复', indexLine: '- [topic](topic.md) — **x→查此条**' })
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '不存在片段', newString: 'y' }), /未命中/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '重复', newString: '独' }), /命中 2 处/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'Bad_Name.md', oldString: 'x', newString: 'y' }), /kebab/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'ghost.md', oldString: 'x', newString: 'y' }), /不存在/)
	// 孤儿条目（无索引行）：edit 缺省沿用失败须拦，不静默写盘
	const orphanDir = join(root, 'profile')
	writeFileSync(join(orphanDir, 'orphan.md'), 'x', 'utf8')
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'orphan.md', oldString: 'x', newString: 'y' }), /孤儿/)
	// 拦截类承诺不落盘：被拦后正文保持原样
	assert.equal(readFileSync(join(orphanDir, 'orphan.md'), 'utf8'), 'x')
})

test('editEntry：全等替换（newString===oldString）命中≠改动，replacements=0 且正文不变', async () => {
	const root = join(base, 'edit-noop')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: '重复\n重复', indexLine: '- [topic](topic.md) — **x→查此条**' })
	const r = await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '重复', newString: '重复', replaceAll: true })
	assert.equal(r.replacements, 0, '全等替换＝零改动，不得按命中处数谎报')
	assert.equal(readFileSync(join(r.dir, 'topic.md'), 'utf8'), '重复\n重复\n')
})

test('editEntry：newString 里的 $ 模式（$` / $\' / $& / $$）按字面落盘，不得插回匹配前后文', async () => {
	const root = join(base, 'edit-dollar')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: '甲行\n丙行', indexLine: '- [topic](topic.md) — **x→查此条**' })
	// 规则类正文很常带 ``$` `` 这类写法（写正则笔记），按 String.replace 解释它会静默复制整条
	const replacement = "JS 正则无 m 标志时 `$` 只认串尾；$' $& $$ 一律按字面"
	const r = await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '甲行', newString: replacement })
	assert.equal(r.replacements, 1)
	assert.equal(readFileSync(join(r.dir, 'topic.md'), 'utf8'), `${replacement}\n丙行\n`)
})

test('editEntry：CRLF 正文＋CRLF 索引（git checkout 形态）照常工作，落盘归一 LF、索引行报 kept、尾空行保真', async () => {
	const root = join(base, 'edit-crlf')
	const dir = join(root, 'profile')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'topic.md'), '# t\r\n\r\n甲行\r\n\r\n', 'utf8')
	writeFileSync(join(dir, 'MEMORY.md'), '# 习惯层索引（使用习惯，跨机同步）\r\n\r\n- [topic](topic.md) — **x→查此条**\r\n', 'utf8')
	const r = await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '甲行', newString: '乙行' })
	assert.equal(r.replacements, 1)
	assert.equal(r.indexAction, 'kept', '缺省沿用＝语义未动，不得谎报已同步')
	const text = readFileSync(join(dir, 'topic.md'), 'utf8')
	assert.ok(text.includes('乙行'), 'CRLF 正文下替换生效')
	assert.ok(!text.includes('\r'), '落盘统一 LF')
	assert.ok(text.endsWith('乙行\n\n'), '尾部空行原样保留')
	// 同根因的 delete/lint 同口径：parseIndexLine 单点归一覆盖三面
	const lint = lintMemory({ memoryRoot: root })
	assert.ok(!lint.warnings.some((w) => w.includes('孤儿条目') && w.includes('topic.md')), 'CRLF 索引行不得误报孤儿')
	const d = deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md' })
	assert.equal(d.indexRemoved, true, 'CRLF 索引行照样清得掉')
})

test('editEntry：跨行 oldString 在 CRLF 正文下可达（归一后按 \\n 匹配）', async () => {
	const root = join(base, 'edit-crlf-cross')
	const dir = join(root, 'profile')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'topic.md'), '# t\r\n\r\nline1\r\nline2\r\n', 'utf8')
	writeFileSync(join(dir, 'MEMORY.md'), '- [topic](topic.md) — **x→查此条**\n', 'utf8')
	await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: 'line1\nline2', newString: 'L' })
	assert.ok(readFileSync(join(dir, 'topic.md'), 'utf8').includes('# t\n\nL\n'), '跨行替换按 LF 口径命中')
})

test('editEntry：replaceAll 非布尔类型 Fail Fast（报错指对病因，不当真值也不误报未命中）', async () => {
	const root = join(base, 'edit-replaceall-type')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: 'Z mid Z', indexLine: '- [topic](topic.md) — **x→查此条**' })
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: 'Z', newString: 'A', replaceAll: 1 }), /replaceAll/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: 'Z', newString: 'A', replaceAll: 'true' }), /replaceAll/)
})

test('editEntry：indexLine 显式传空串在 upsert 同点拦（不得静默回退沿用）', async () => {
	const root = join(base, 'edit-blank-index')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: 'x', indexLine: '- [topic](topic.md) — **x→查此条**' })
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: 'x', newString: 'y', indexLine: '' }), /indexLine 不能为空/)
})

test('editEntry：LF 正文多尾空行保真（替换不动作者行尾形态）', async () => {
	const root = join(base, 'edit-tail')
	const dir = join(root, 'profile')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'topic.md'), 'a\n\n\n', 'utf8')
	writeFileSync(join(dir, 'MEMORY.md'), '- [topic](topic.md) — **x→查此条**\n', 'utf8')
	await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: 'a', newString: 'A' })
	assert.equal(readFileSync(join(dir, 'topic.md'), 'utf8'), 'A\n\n\n', '两个尾空行原样保留')
})

test('editEntry：编辑后正文为空与超失控保护走同一条拦截链（结果仍过 upsert 校验）', async () => {
	const root = join(base, 'edit-validate')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: '唯一一行', indexLine: '- [topic](topic.md) — **x→查此条**' })
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '唯一一行', newString: '' }), /为空/)
	const big = join(base, 'edit-big')
	await upsertEntry({
		port,
		memoryRoot: big,
		layer: 'habit',
		file: 'big.md',
		content: 'x'.repeat(RUNAWAY_CEILING),
		indexLine: '- [big](big.md) — **x→查此条**',
	})
	await assert.rejects(() => editEntry({ port, memoryRoot: big, layer: 'habit', file: 'big.md', oldString: 'x', newString: 'yy', replaceAll: true }), /失控保护/)
})

test('deleteEntry：删文＋清索引行＋跨层 wikilink 引用报告（delete 族同步走 node:fs）', async () => {
	const root = join(base, 'delete-case')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'gone.md', content: 'x', indexLine: '- [gone](gone.md) — **x→查此条**' })
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'stays.md', content: '引用 [[gone]] 一处，另有 [[toolkit]] 不可计作别条引用', indexLine: '- [stays](stays.md) — **x→查此条**' })
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'tool.md', content: 'x', indexLine: '- [tool](tool.md) — **x→查此条**' })
	const r = deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'gone.md' })
	assert.equal(r.indexRemoved, true)
	assert.equal(existsSync(join(r.dir, 'gone.md')), false)
	assert.ok(!readFileSync(r.indexPath, 'utf8').includes('gone.md'))
	assert.equal(r.references.length, 1)
	assert.ok(r.references[0].includes(join('stays.md:1')))
	assert.equal(r.scanError, '')
	assert.throws(() => deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'gone.md' }), /不存在/)
	// 文件名拦截同样覆盖 delete 路径；条目在而无 MEMORY.md → indexRemoved=false（渲染「本就不在」依赖）
	assert.throws(() => deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'Bad_Name.md' }), /kebab/)
	assert.throws(() => deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'memory.md' }), /保留名/)
	// 前缀子串不误报：[[toolkit]] 不构成对 tool.md 的引用
	const rt = deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'tool.md' })
	assert.equal(rt.references.length, 0, '[[toolkit]] 是另一个 stem，不得计作 [[tool]] 的引用')
	const bareRoot = join(base, 'delete-bare')
	const bareDir = join(bareRoot, 'profile')
	mkdirSync(bareDir, { recursive: true })
	writeFileSync(join(bareDir, 'loose.md'), 'x', 'utf8')
	const bare = deleteEntry({ port, memoryRoot: bareRoot, layer: 'habit', file: 'loose.md' })
	assert.equal(bare.indexRemoved, false)
	assert.equal(bare.indexPath, join(bareDir, 'MEMORY.md'))
})

test('lintMemory：死索引行/孤儿/死链/超预算全覆盖，干净夹具 ok', () => {
	const root = join(base, 'lint-case')
	const profile = join(root, 'profile')
	const bucket = join(root, 'workspaces', 'D-code')
	mkdirSync(bucket, { recursive: true })
	// 习惯层：干净索引 + 1 孤儿条目 + 死 wikilink
	mkdirSync(profile, { recursive: true })
	writeFileSync(join(profile, 'MEMORY.md'), '# 习惯层索引（使用习惯，跨机同步）\n\n- [good](good.md) — **x→查此条**\n', 'utf8')
	writeFileSync(join(profile, 'good.md'), 'x 引 [[missing]]', 'utf8')
	writeFileSync(join(profile, 'orphan.md'), 'y', 'utf8')
	// 工作层：死索引行 + 超预算索引
	writeFileSync(join(bucket, 'MEMORY.md'), `- [missing](missing.md) — **x→查此条**\n${Array.from({ length: INDEX_LINE_BUDGET + 3 }, (_, i) => `- [f${i}](f${i}.md) — **x→查此条**`).join('\n')}\n`, 'utf8')
	const report = lintMemory({ memoryRoot: root, cwd: 'D:\\code' })
	assert.equal(report.ok, false)
	assert.ok(report.warnings.some((w) => w.includes('孤儿条目') && w.includes('orphan.md')))
	assert.ok(report.warnings.some((w) => w.includes('死索引行') && w.includes('missing.md')))
	assert.ok(report.warnings.some((w) => w.includes('死 wikilink [[missing]]')))
	assert.ok(report.warnings.some((w) => w.includes('索引超预算')))
	// 干净夹具：单层单条目单索引即健康
	const cleanRoot = join(base, 'lint-clean')
	mkdirSync(join(cleanRoot, 'profile'), { recursive: true })
	writeFileSync(join(cleanRoot, 'profile', 'MEMORY.md'), '# 习惯层索引（使用习惯，跨机同步）\n\n- [only](only.md) — **x→查此条**\n', 'utf8')
	writeFileSync(join(cleanRoot, 'profile', 'only.md'), 'x', 'utf8')
	const clean = lintMemory({ memoryRoot: cleanRoot })
	assert.equal(clean.ok, true)
	assert.deepEqual(clean.warnings, [])
})

test('lintMemory：缺习惯层接线/缺索引/日期戳/无桶提示', () => {
	const root = join(base, 'lint-wire')
	mkdirSync(join(root, 'workspaces', 'D-code'), { recursive: true })
	writeFileSync(join(root, 'workspaces', 'D-code', 'loose.md'), 'x', 'utf8')
	const report = lintMemory({ memoryRoot: root, cwd: 'D:\\code' })
	assert.ok(report.warnings.some((w) => w.includes('习惯层接线缺失')), '根无 profile 目录')
	assert.ok(report.warnings.some((w) => w.includes('缺 MEMORY.md')), '桶有条目无索引')
	const noBucket = lintMemory({ memoryRoot: join(base, 'lint-wire'), cwd: 'D:\\other' })
	assert.ok(noBucket.warnings.some((w) => w.includes('尚无桶')), '新工作区常态提示')
	const datedRoot = join(base, 'lint-dated')
	mkdirSync(join(datedRoot, 'profile'), { recursive: true })
	writeFileSync(join(datedRoot, 'profile', 'MEMORY.md'), '- [d](d.md) — 2026-01-02 记\n', 'utf8')
	writeFileSync(join(datedRoot, 'profile', 'd.md'), 'x', 'utf8')
	const dated = lintMemory({ memoryRoot: datedRoot })
	assert.ok(dated.warnings.some((w) => w.includes('日期戳')), '索引行日期戳体检')
	// 条目超失控保护：lint 唯一体检项断言（写侧另有拦截测试）
	const hugeRoot = join(base, 'lint-huge')
	const hugeDir = join(hugeRoot, 'profile')
	mkdirSync(hugeDir, { recursive: true })
	writeFileSync(join(hugeDir, 'MEMORY.md'), '- [big](big.md) — **x→查此条**\n', 'utf8')
	writeFileSync(join(hugeDir, 'big.md'), 'x'.repeat(RUNAWAY_CEILING + 1), 'utf8')
	const huge = lintMemory({ memoryRoot: hugeRoot })
	assert.ok(huge.warnings.some((w) => w.includes('失控保护') && w.includes('big.md')))
	// 恰 200 行（upsert 产物必带尾换行）不误报超预算
	const edgeRoot = join(base, 'lint-edge')
	const edgeDir = join(edgeRoot, 'profile')
	mkdirSync(edgeDir, { recursive: true })
	writeFileSync(join(edgeDir, 'MEMORY.md'), `# 习惯层索引（使用习惯，跨机同步）\n${Array.from({ length: INDEX_LINE_BUDGET - 1 }, (_, i) => `- [e${i}](e${i}.md) — **x→查此条**`).join('\n')}\n`, 'utf8')
	for (let i = 0; i < INDEX_LINE_BUDGET - 1; i += 1) writeFileSync(join(edgeDir, `e${i}.md`), 'x', 'utf8')
	const edge = lintMemory({ memoryRoot: edgeRoot })
	assert.ok(!edge.warnings.some((w) => w.includes('索引超预算')), '恰 200 行（含尾换行）不得误报超预算')
})

test('lintMemory：病态输入逐处降级报 warning，体检自身不崩（EISDIR 确定性触发）', () => {
	const root = join(base, 'lint-degraded')
	const profile = join(root, 'profile')
	mkdirSync(profile, { recursive: true })
	writeFileSync(join(profile, 'MEMORY.md'), '# 习惯层索引（使用习惯，跨机同步）\n\n- [good](good.md) — **x→查此条**\n', 'utf8')
	writeFileSync(join(profile, 'good.md'), 'x', 'utf8')
	// x.md 名字的目录：readdirSync 列出它，readFileSync 抛 EISDIR——确定性病态输入
	mkdirSync(join(profile, 'x.md'))
	const report = lintMemory({ memoryRoot: root })
	assert.equal(report.ok, false)
	assert.ok(report.warnings.some((w) => w.includes('条目读取失败') && w.includes('x.md')))
	assert.ok(!report.warnings.some((w) => w.includes('孤儿条目') && w.includes('good.md')), '好条目不受邻近病态牵连')
})
