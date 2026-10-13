/**
 * dsh-memory 端口写侧单测（node:test，零宿主依赖）：frontmatter 契约、索引行派生、
 * 层路由、upsert（建/拦截/风格告警）、edit（字面替换/版本守卫/命中拦截）。
 * upsert/edit 走 fs 端口（createNodeFsPort 构造一次、逐用例复用），故是 async。
 * delete 与 lint 各有自己的文件（memory-delete.test.js／memory-lint.test.js，I/O 按
 * 设计留在 node:fs 保持同步）；本文件仍留一条横跨三个动作的会话策略用例——那条断言
 * 证的是「四个 action 同一口径」，拆到三个文件里就散成三条各自为政的断言。
 * 每个用例独立临时根，互不共享状态。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_MEMORY_ROOT, INDEX_LINE_CHAR_BUDGET, RUNAWAY_CEILING, absoluteMemoryRoot } from '../lib/memory/core.js'
import { deleteEntry } from '../lib/memory/delete.js'
import { createNodeFsPort } from '../lib/memory/fs-port.js'
import { assertEntryFrontmatter, deriveIndexLine, parseFrontmatter } from '../lib/memory/frontmatter.js'
import { lintMemory } from '../lib/memory/lint.js'
import { editEntry, upsertEntry } from '../lib/memory/write.js'

let base
const port = createNodeFsPort()

before(() => {
	base = join(tmpdir(), `dsh-memory-write-test-${process.pid}`)
	mkdirSync(base, { recursive: true })
})

after(() => {
	rmSync(base, { recursive: true, force: true })
})

/** 条目正文夹具：frontmatter 两键＋正文。 */
const entry = (title, description, body = '正文') => `---\ntitle: ${title}\ndescription: ${description}\n---\n\n${body}\n`

/* ===================== frontmatter 契约 ===================== */

test('absoluteMemoryRoot：记忆根归一成绝对路径（相对路径不按两套基目录分家）', () => {
	assert.equal(absoluteMemoryRoot(DEFAULT_MEMORY_ROOT), join(homedir(), '.dsh', 'memory'), '默认根的 ~ 要展开')
	assert.equal(absoluteMemoryRoot('~/tilde'), join(homedir(), 'tilde'))
	// 相对根按 process.cwd() 定死：否则写侧走宿主 fs 后端基目录、读侧走 cwd，两套语义
	assert.equal(absoluteMemoryRoot('相对根'), resolve('相对根'))
	assert.equal(absoluteMemoryRoot('./a/../b'), resolve('b'))
	assert.equal(absoluteMemoryRoot('/abs/root'), '/abs/root', '绝对路径原样透传')
})

test('parseFrontmatter：两键齐备解析成功，CRLF 形态同解（git checkout 归一收在单点）', () => {
	const parsed = parseFrontmatter(entry('习惯条目', '触发词／召回词'))
	assert.deepEqual(parsed, { ok: true, frontmatter: { title: '习惯条目', description: '触发词／召回词' } })
	assert.deepEqual(parseFrontmatter('---\r\ntitle: A\r\ndescription: B\r\n---\r\n\r\n正文\r\n'), {
		ok: true,
		frontmatter: { title: 'A', description: 'B' },
	})
})

test('parseFrontmatter：结构类病灶各自报错（缺 frontmatter/未闭合/多行折行），块内空行放行', () => {
	const bad = {
		缺: '# 光有标题\n\n正文\n',
		未闭合: '---\ntitle: A\ndescription: B\n\n正文\n',
		折行: '---\ntitle: A\ndescription: >-\n  第一行\n  第二行\n---\n正文\n',
		竖线块: '---\ntitle: A\ndescription: |\n  第一行\n---\n正文\n',
	}
	assert.match(parseFrontmatter(bad.缺).error, /缺 frontmatter/)
	assert.match(parseFrontmatter(bad.未闭合).error, /未闭合/)
	assert.match(parseFrontmatter(bad.折行).error, /折行|每行/)
	assert.match(parseFrontmatter(bad.竖线块).error, /折行|每行/)
	// 空行是 YAML 常见写法且现存语料大半如此：拦它等于让整层条目悄悄从索引消失
	assert.deepEqual(parseFrontmatter('---\n\ntitle: A\ndescription: B\n\n---\n\n正文\n'), {
		ok: true,
		frontmatter: { title: 'A', description: 'B' },
	})
})

test('parseFrontmatter：键位越界各自报错（多余键/重复键/缺键/空值/非键行）', () => {
	assert.match(parseFrontmatter('---\nname: x\ntitle: A\ndescription: B\n---\n').error, /多余键/)
	assert.match(parseFrontmatter('---\ntitle: A\ntitle: B\ndescription: C\n---\n').error, /重复/)
	assert.match(parseFrontmatter('---\ntitle: A\n---\n').error, /缺 description/)
	assert.match(parseFrontmatter('---\ntitle: A\ndescription: B\norigin: c\n---\n').error, /多余键/)
	assert.match(parseFrontmatter('---\ntitle: A\ndescription:   \n---\n').error, /description 为空/)
	assert.match(parseFrontmatter('---\ntitle:\ndescription: B\n---\n').error, /title 为空/)
	assert.match(parseFrontmatter('---\ntitle: A\ndescription: B\n# 注释\n---\n').error, /每行/)
	assert.match(parseFrontmatter(42).error, /不是字符串/)
})

test('parseFrontmatter：title 含方括号即拒（派生行会不是合法链接行，症状要到注入面才显形）', () => {
	assert.match(parseFrontmatter(entry('[坏标题]', '触发词')).error, /方括号/)
	assert.match(parseFrontmatter(entry('坏]标题[', '触发词')).error, /方括号/)
})

test('deriveIndexLine：格式固定为「- [title](file) — description」', () => {
	assert.equal(deriveIndexLine({ title: '用户画像', description: '偏好／沟通', file: 'user.md' }), '- [用户画像](user.md) — 偏好／沟通')
})

test('assertEntryFrontmatter：报错带文件名与病因（调用方按原样改内容即可）', () => {
	assert.deepEqual(assertEntryFrontmatter(entry('A', 'B'), 'a.md'), { title: 'A', description: 'B' })
	assert.throws(() => assertEntryFrontmatter('正文', 'a.md'), /a\.md.*frontmatter/)
})

/* ===================== upsert ===================== */

test('upsertEntry：工作层新建＝建桶＋条目，返回派生索引行且无风格告警', async () => {
	const root = join(base, 'write-add')
	const r = await upsertEntry({ port, memoryRoot: root, cwd: 'D:\\code', layer: 'workspace', file: 'demo-topic.md', content: entry('演示条目', '触发词') })
	assert.ok(r.dir.endsWith(join('workspaces', 'D-code')))
	assert.equal(existsSync(join(r.dir, 'demo-topic.md')), true)
	assert.equal(r.indexLine, '- [演示条目](demo-topic.md) — 触发词')
	assert.deepEqual(r.warnings, [])
	assert.equal(readFileSync(join(r.dir, 'demo-topic.md'), 'utf8'), entry('演示条目', '触发词'), '落盘形态与入参一致（已带尾换行）')
})

test('upsertEntry：日期戳与派生行超长进 warnings（提示不拦截）', async () => {
	const root = join(base, 'write-warn')
	const long = '词'.repeat(INDEX_LINE_CHAR_BUDGET)
	const r = await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'dated.md', content: entry('带日期戳的条目', `2026-01-02 记录／${long}`) })
	assert.equal(r.warnings.length, 2)
	assert.ok(r.warnings.some((w) => w.includes('日期戳')))
	assert.ok(r.warnings.some((w) => w.includes('超') && w.includes(String(INDEX_LINE_CHAR_BUDGET))))
	assert.equal(existsSync(join(r.dir, 'dated.md')), true, '风格告警不拦落盘')
})

test('upsertEntry：frontmatter 契约不合规一律抛错且不落盘', async () => {
	const root = join(base, 'write-fm')
	const args = { port, memoryRoot: root, layer: 'habit', file: 'ok.md', content: entry('合规条目', '触发词') }
	await assert.rejects(() => upsertEntry({ ...args, content: '# 没有 frontmatter\n' }), /frontmatter 不合规/)
	await assert.rejects(() => upsertEntry({ ...args, content: '---\nname: ok\ntitle: 多余键\ndescription: 触发词\n---\n\n正文\n' }), /多余键/)
	await assert.rejects(() => upsertEntry({ ...args, content: entry('[带括号]', '触发词') }), /方括号/)
	await assert.rejects(() => upsertEntry({ ...args, content: '---\ntitle: 折行\ndescription: >-\n  一\n  二\n---\n\n正文\n' }), /frontmatter 不合规/)
	await assert.rejects(() => upsertEntry({ ...args, content: '---\ndescription: 触发词\n---\n\n正文\n' }), /缺 title/)
	assert.equal(existsSync(join(root, 'profile', 'ok.md')), false, '拦截分支不得落盘')
})

test('upsertEntry：层内同名拦截且不落盘（先 delete 再改名）', async () => {
	const root = join(base, 'write-dup')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'first.md', content: entry('同一个标题', '触发词') })
	await assert.rejects(() => upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'second.md', content: entry('同一个标题', '另一词') }), /同名/)
	assert.equal(existsSync(join(root, 'profile', 'second.md')), false, '拦截不得留孤儿条目')
	// 同名但就是它自己（重写同一条目）不拦
	const again = await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'first.md', content: entry('同一个标题', '触发词改') })
	assert.equal(again.indexLine, '- [同一个标题](first.md) — 触发词改')
})

test('upsertEntry：层内 frontmatter 不合规的条目逐条列全（报错要给出脱困路径，修完即解锁）', async () => {
	const root = join(base, 'write-broken-peer')
	const dir = join(root, 'profile')
	mkdirSync(dir, { recursive: true })
	// 老布局条目：name:/metadata: 而非 title:/description:——迁移期与手改坏文件都是这个形态
	writeFileSync(join(dir, 'legacy.md'), '---\nname: 老条目\nmetadata:\n  type: user\n---\n\n老正文。\n', 'utf8')
	writeFileSync(join(dir, 'legacy-two.md'), '---\ntitle: 另一个老条目\nmetadata:\n  type: user\n---\n\n老正文二。\n', 'utf8')
	// 坏条目一次列全：只报撞到的那一条时，读到的人修完它会撞上下一条，来回几趟才撞得完
	await assert.rejects(
		() => upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'other.md', content: entry('别的条目', '触发词') }),
		(error) => {
			assert.match(error.message, /层内 2 条 frontmatter 不合规/)
			assert.match(error.message, /legacy\.md/)
			assert.match(error.message, /legacy-two\.md/)
			// 两条并存时 edit 改任一条都会被另一条挡住，文案不许说「edit 是唯一还能写的路径」
			assert.match(error.message, /先 delete 掉其中多余的坏条目/)
			return true
		},
		'拦截文案必须自带脱困路径与全部坏条目，否则读到的人会以为整层锁死，转而绕过工具裸编辑文件',
	)
	assert.equal(existsSync(join(dir, 'other.md')), false, '拦截不得留孤儿条目')
	await assert.rejects(
		() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'legacy.md', oldString: 'name: 老条目\nmetadata:\n  type: user', newString: 'title: 老条目\ndescription: 触发词' }),
		/层内 1 条/,
		'edit 只跳过自己：另一条坏条目在场时它同样写不了（文案因此不给「逐条 edit」这条路）',
	)
	assert.equal(readFileSync(join(dir, 'legacy.md'), 'utf8').includes('metadata'), true, '被拦的 edit 不得留下半截改动')
	// 脱困姿势：先 delete 掉一条，剩最后一条时 edit 就是层内唯一还能写的路径
	const deleted = deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'legacy-two.md' })
	assert.equal(existsSync(join(dir, 'legacy-two.md')), false)
	assert.deepEqual(deleted.references, [])
	await assert.rejects(
		() => upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'other.md', content: entry('别的条目', '触发词') }),
		(error) => {
			assert.match(error.message, /层内 1 条 frontmatter 不合规/)
			assert.match(error.message, /legacy\.md/)
			assert.match(error.message, /在同名扫描里被跳过，是层内唯一还能写的路径/)
			return true
		},
	)
	const fixed = await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'legacy.md', oldString: 'name: 老条目\nmetadata:\n  type: user', newString: 'title: 老条目\ndescription: 触发词' })
	assert.equal(fixed.indexLine, '- [老条目](legacy.md) — 触发词')
	assert.equal(readFileSync(join(dir, 'legacy.md'), 'utf8'), entry('老条目', '触发词', '老正文。'))
	const other = await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'other.md', content: entry('别的条目', '触发词') })
	assert.equal(other.indexLine, '- [别的条目](other.md) — 触发词', '修好之后层立即解锁')
})

test('upsertEntry：前置拦截（未知层/空桶名/空 content/超限/非 kebab/保留名）', async () => {
	const root = join(base, 'pre-reject')
	const ok = { port, memoryRoot: root, layer: 'habit', file: 'ok.md', content: entry('合规条目', '触发词') }
	await assert.rejects(() => upsertEntry({ ...ok, layer: 'bogus' }), /未知层/)
	await assert.rejects(() => upsertEntry({ ...ok, layer: 'workspace', cwd: '///' }), /桶名为空/)
	await assert.rejects(() => upsertEntry({ ...ok, content: '   ' }), /content/)
	await assert.rejects(() => upsertEntry({ ...ok, content: 'x'.repeat(RUNAWAY_CEILING + 1) }), /失控保护/)
	await assert.rejects(() => upsertEntry({ ...ok, file: 'Bad_Name.md' }), /kebab/)
	await assert.rejects(() => upsertEntry({ ...ok, file: 'memory.md' }), /保留名/)
	await assert.rejects(() => upsertEntry({ port, memoryRoot: root, layer: 'workspace', file: 'a.md', content: entry('无桶', '触发词') }), /cwd/)
})

test('upsertEntry/editEntry/deleteEntry：会话策略不许写时三个动作全拒（只问端口，code 落宿主词表）', async () => {
	const root = join(base, 'write-readonly')
	const readOnly = createNodeFsPort({ sandboxPolicy: { mode: 'read-only', workspaceRoot: '/tmp', sessionId: 'session-1' } })
	const args = { port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: entry('主题条目', '触发词') }
	await assert.rejects(() => upsertEntry({ ...args, port: readOnly }), (error) => {
		// code 在宿主词表内，harness 的 toolErrorResult 与模型才拿得到类型
		assert.equal(error.code, 'FS_SANDBOX_DENIED')
		assert.match(error.message, /danger-full-access/)
		assert.doesNotMatch(error.message, /workspace-write 或更高/, '围栏范围是会话 cwd，照着改成 workspace-write 仍然被拒，不得这么引导')
		return true
	})
	assert.equal(existsSync(join(root, 'profile')), false, '被拒的写入不得建桶落盘')
	await upsertEntry(args)
	await assert.rejects(() => editEntry({ port: readOnly, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '正文', newString: '正文改' }), /不允许写记忆/)
	assert.equal(readFileSync(join(root, 'profile', 'topic.md'), 'utf8'), entry('主题条目', '触发词'), '被拒的编辑不得落盘')
	// delete 的 I/O 虽留在 node:fs（宿主契约无删除能力），照样接端口问能不能写：
	// 四个 action 同一口径。它是同步函数（I/O 无 await），故用 throws 而非 rejects
	assert.throws(() => deleteEntry({ port: readOnly, memoryRoot: root, layer: 'habit', file: 'topic.md' }), /不允许写记忆/)
	assert.ok(existsSync(join(root, 'profile', 'topic.md')), '被拒的删除不得动条目')
	// 策略缺省（无会话上下文）＝不受限：字段缺席不得被当成只读而误拒
	const ok = await upsertEntry({ ...args, file: 'other.md', content: entry('另一条目', '触发词') })
	assert.equal(ok.indexLine, '- [另一条目](other.md) — 触发词')
	// 只读策略只关写入：读侧与体检照常可用（文案里承诺过这句）
	assert.equal(lintMemory({ memoryRoot: root }).ok, true)
})

test('upsertEntry：write 路径不带版本守卫（语义是「以我这份为准」，并发两次 write 后者赢）', async () => {
	const root = join(base, 'write-no-guard')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'one.md', content: entry('条目', '触发词', 'v1') })
	const r = await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'one.md', content: entry('条目', '触发词', 'v2') })
	assert.equal(readFileSync(join(r.dir, 'one.md'), 'utf8'), entry('条目', '触发词', 'v2'), 'write 无版本守卫：后者整份覆盖前者')
})

test('editEntry：并发两次改同一条目，后到者抛 FS_STALE_VERSION 且先到者正文完好', async () => {
	const root = join(base, 'edit-guard')
	const entryPath = join(root, 'profile', 'topic.md')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: entry('主题条目', '触发词', 'v1 状态行') })
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
})

/* ===================== edit ===================== */

test('editEntry：字面替换整文落盘，派生索引行按改完的 frontmatter 重算', async () => {
	const root = join(base, 'edit-basic')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: entry('旧标题', '旧触发词', '# 标题\n\nv1 状态行\n\n- 保留行') })
	const r = await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: 'v1 状态行', newString: 'v2 状态行' })
	assert.equal(r.replacements, 1)
	// 全等而非 includes：edit 只许动被替换的那一段，frontmatter 与整篇形态一并钉死，
	// 子串断言会让「顺带把 frontmatter 写坏了」这类回归绿灯通过
	assert.equal(readFileSync(join(r.dir, 'topic.md'), 'utf8'), entry('旧标题', '旧触发词', '# 标题\n\nv2 状态行\n\n- 保留行'))
	assert.equal(r.indexLine, '- [旧标题](topic.md) — 旧触发词', '只改正文时索引行不变')
	assert.deepEqual(r.warnings, [], '正常 edit 不产生任何 warning')
	const retitled = await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: 'title: 旧标题', newString: 'title: 新标题' })
	assert.equal(retitled.indexLine, '- [新标题](topic.md) — 旧触发词', '改了 title 即刻重算派生行')
})

test('editEntry：replaceAll 全替换并计处数', async () => {
	const root = join(base, 'edit-advanced')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: entry('主题条目', '触发词', '甲旧\n乙旧\n丙新') })
	const r = await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '旧', newString: '新', replaceAll: true })
	assert.equal(r.replacements, 2)
	assert.equal(readFileSync(join(r.dir, 'topic.md'), 'utf8'), entry('主题条目', '触发词', '甲新\n乙新\n丙新'))
})

test('editEntry：改出不合规 frontmatter 走同一条拦截链（先算后写，不留半截改动）', async () => {
	const root = join(base, 'edit-fm')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: entry('主题条目', '触发词', '正文行') })
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: 'title: 主题条目', newString: 'title: [带括号]' }), /方括号/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '---\ntitle: 主题条目', newString: '---\nname: 多余\ntitle: 主题条目' }), /多余键/)
	assert.equal(readFileSync(join(root, 'profile', 'topic.md'), 'utf8'), entry('主题条目', '触发词', '正文行'), '被拦后整份保持原样')
})

test('editEntry：命中拦截（不命中/多处未声明 replaceAll）与前置拦截（非 kebab/条目不存在/参数类型）', async () => {
	const root = join(base, 'edit-reject')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: entry('主题条目', '触发词', '重复\n重复') })
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '不存在片段', newString: 'y' }), /未命中/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '重复', newString: '独' }), /命中 2 处/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'Bad_Name.md', oldString: 'x', newString: 'y' }), /kebab/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'ghost.md', oldString: 'x', newString: 'y' }), /不存在/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '', newString: 'y' }), /oldString 不能为空/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: undefined, newString: 'y' }), /oldString 不能为空/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '重复', newString: null }), /newString/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '重复', newString: '独', replaceAll: 1 }), /replaceAll/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '重复', newString: '独', replaceAll: 'true' }), /replaceAll/)
})

test('editEntry：全等替换（newString===oldString）命中≠改动，replacements=0 且正文不变', async () => {
	const root = join(base, 'edit-noop')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: entry('主题条目', '触发词', '重复\n重复') })
	const r = await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '重复', newString: '重复', replaceAll: true })
	assert.equal(r.replacements, 0, '全等替换＝零改动，不得按命中处数谎报')
	assert.equal(readFileSync(join(r.dir, 'topic.md'), 'utf8'), entry('主题条目', '触发词', '重复\n重复'))
})

test('editEntry：newString 里的 $ 模式（$` / $\' / $& / $$）按字面落盘，不得插回匹配前后文', async () => {
	const root = join(base, 'edit-dollar')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content: entry('主题条目', '触发词', '甲行\n丙行') })
	// 规则类正文很常带 ``$` `` 这类写法（写正则笔记），按 String.replace 解释它会静默复制整条
	const replacement = "JS 正则无 m 标志时 `$` 只认串尾；$' $& $$ 一律按字面"
	const r = await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '甲行', newString: replacement })
	assert.equal(r.replacements, 1)
	assert.equal(readFileSync(join(r.dir, 'topic.md'), 'utf8'), entry('主题条目', '触发词', `${replacement}\n丙行`))
})

test('editEntry：CRLF 正文照常工作，落盘归一 LF、尾部空行保真（git checkout 形态）', async () => {
	const root = join(base, 'edit-crlf')
	const dir = join(root, 'profile')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'topic.md'), '---\r\ntitle: 主题条目\r\ndescription: 触发词\r\n---\r\n\r\n甲行\r\n\r\n', 'utf8')
	const r = await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '甲行', newString: '乙行' })
	assert.equal(r.replacements, 1)
	assert.equal(r.indexLine, '- [主题条目](topic.md) — 触发词', 'CRLF frontmatter 照样派生出索引行')
	// 一条全等钉住三件事：替换生效、落盘统一 LF、尾部空行保真；拆成子串断言时
	// 「frontmatter 被顺带改坏」这类回归照样绿灯通过
	assert.equal(readFileSync(join(dir, 'topic.md'), 'utf8'), '---\ntitle: 主题条目\ndescription: 触发词\n---\n\n乙行\n\n', 'CRLF 正文替换后整文正确（LF 归一＋尾空行保真）')
})

test('editEntry：跨行 oldString 在 CRLF 正文下可达（归一后按 \\n 匹配）', async () => {
	const root = join(base, 'edit-crlf-cross')
	const dir = join(root, 'profile')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'topic.md'), `${entry('主题条目', '触发词', 'line1\r\nline2')}`, 'utf8')
	await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: 'line1\nline2', newString: 'L' })
	// 整文全等而非 includes：跨行替换只许动 oldString 那两行，frontmatter 与其后的
	// 空行形态一并钉死——子串断言会让「顺带把条目头部写坏了」这类回归绿灯通过
	assert.equal(readFileSync(join(dir, 'topic.md'), 'utf8'), entry('主题条目', '触发词', 'L'), '跨行替换按 LF 口径命中，条目头部未被挪动')
})

test('editEntry：LF 正文多尾空行保真（替换不动作者行尾形态）', async () => {
	const root = join(base, 'edit-tail')
	const dir = join(root, 'profile')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'topic.md'), '---\ntitle: A\ndescription: B\n---\n\na\n\n\n', 'utf8')
	await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '\n\na', newString: '\n\nA' })
	assert.equal(readFileSync(join(dir, 'topic.md'), 'utf8'), '---\ntitle: A\ndescription: B\n---\n\nA\n\n\n', '两个尾空行原样保留')
})

test('editEntry：编辑后正文为空与超失控保护走同一条拦截链（结果仍过 upsert 校验）', async () => {
	const root = join(base, 'edit-validate')
	const content = entry('主题条目', '触发词', '唯一一行')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', content })
	// 整条清空（含 frontmatter）才触得到「编辑后为空」：有 frontmatter 的条目删不干净，
	// 剩下的空壳会由 upsert 的 frontmatter 契约拦——两条报错说的是两件事
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: content.replace(/\n$/, ''), newString: '' }), /为空/)
	const big = join(base, 'edit-big')
	await upsertEntry({ port, memoryRoot: big, layer: 'habit', file: 'big.md', content: entry('大条目', '触发词', 'x'.repeat(RUNAWAY_CEILING - 200)) })
	await assert.rejects(() => editEntry({ port, memoryRoot: big, layer: 'habit', file: 'big.md', oldString: 'x', newString: 'yy', replaceAll: true }), /失控保护/)
})
