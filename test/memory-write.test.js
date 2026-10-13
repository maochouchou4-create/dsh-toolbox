/**
 * dsh-memory 写侧单测（node:test，零宿主依赖）：frontmatter 契约、索引行派生、
 * 层路由、upsert（建/拦截/风格告警）、edit（字面替换/版本守卫/命中拦截）、
 * delete（删文＋引用报告）、lint 体检。
 * upsert/edit 走 fs 端口（createNodeFsPort 构造一次、逐用例复用），故是 async；
 * delete 与 lint 的 I/O 留在 node:fs 保持同步（delete 接端口只为问一句能不能写）。
 * 每个用例独立临时根，互不共享状态。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_MEMORY_ROOT, INDEX_CHAR_BUDGET, INDEX_LINE_BUDGET, INDEX_LINE_CHAR_BUDGET, RUNAWAY_CEILING, absoluteMemoryRoot, composeMemory } from '../lib/memory/core.js'
import { createNodeFsPort } from '../lib/memory/fs-port.js'
import { assertEntryFrontmatter, deriveIndexLine, parseFrontmatter } from '../lib/memory/frontmatter.js'
import { deleteEntry, editEntry, lintMemory, upsertEntry } from '../lib/memory/write.js'

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

/* ===================== delete ===================== */

test('deleteEntry：删文＋跨层 wikilink 引用报告（delete 族同步走 node:fs）', async () => {
	const root = join(base, 'delete-case')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'gone.md', content: entry('被删条目', '触发词') })
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'stays.md', content: entry('留下条目', '触发词', '引用 [[gone]] 一处，另有 [[toolkit]] 不可计作别条引用') })
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'tool.md', content: entry('工具条目', '触发词') })
	const r = deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'gone.md' })
	assert.equal(existsSync(join(r.dir, 'gone.md')), false)
	assert.equal(r.references.length, 1)
	assert.ok(r.references[0].includes(join('stays.md:6')))
	assert.equal(r.scanError, '')
	assert.throws(() => deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'gone.md' }), /不存在/)
	assert.throws(() => deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'Bad_Name.md' }), /kebab/)
	assert.throws(() => deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'memory.md' }), /保留名/)
	// 前缀子串不误报：[[toolkit]] 不构成对 tool.md 的引用
	const rt = deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'tool.md' })
	assert.equal(rt.references.length, 0, '[[toolkit]] 是另一个 stem，不得计作 [[tool]] 的引用')
})

test('deleteEntry：被删条目的索引行随之退场（索引是派生的，无文件即无行）', async () => {
	const root = join(base, 'delete-derived')
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'gone.md', content: entry('被删条目', '触发词') })
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'stays.md', content: entry('留下条目', '触发词') })
	assert.ok(composeMemory({ memoryRoot: root }).includes('- [被删条目](gone.md)'))
	deleteEntry({ port, memoryRoot: root, layer: 'habit', file: 'gone.md' })
	const text = composeMemory({ memoryRoot: root })
	assert.ok(!text.includes('gone.md'), '删条目后派生索引行必须消失')
	assert.ok(text.includes('- [留下条目](stays.md) — 触发词'))
})

/* ===================== lint ===================== */

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
	// 判定是 `>`（write.js:319），差一个字符就是误报；两个预算各钉一次边界
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
