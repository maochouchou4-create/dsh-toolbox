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
import { assertEntryFrontmatter, deriveIndexLine, findFenceEnd, frontmatterLines, FRONTMATTER_HEAD_MAX_BYTES, FRONTMATTER_HEAD_PROBE_BYTES, hasClosedFence, parseFrontmatter } from '../lib/memory/frontmatter.js'
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

test('hasClosedFence：真值表（它决定「头读完了没有」，读侧早退与写侧升窗都问它）', () => {
	// 表驱动而不是逐个 if：漏一格（尤其 CRLF 与正文里的 ---）时，红的是表而不是某个
	// 分支的断言，后者读起来像「这一格过了」，看不出还有没有没写的格子
	const cases = [
		['首行不是围栏', '# 标题\n', false],
		['空串', '', false],
		['只有开场围栏', '---\ntitle: A\n', false],
		['闭合在第二行', '---\n---\ntitle: A\n', true],
		['闭合在块尾', entry('标题', '触发词'), true],
		['CRLF 同样闭合', '---\r\ntitle: A\r\ndescription: B\r\n---\r\n\r\n正文\r\n', true],
		['空行也不构成闭合围栏', '---\ntitle: A\n\n\n', false],
		['尾随空白挡在围栏前（它就不是围栏行）', '---\ntitle: A\n--- \n', false],
		// 围栏不认语义：正文里孤零零一个 --- 就是闭合围栏。解析器随后会因块内非键行报错，
		// 但「头读完了没有」这件事只问形状——把语义判据混进来，读侧就会为一个坏条目
		// 一路读到兜底上限
		['正文里的 --- 就是闭合围栏', '---\ntitle: A\n\n正文\n---\n', true],
	]
	for (const [label, text, expected] of cases) {
		assert.equal(hasClosedFence(text), expected, `${label}：hasClosedFence 应为 ${expected}`)
	}
})

test('说「头闭合」的规范形条目一定解析得出来（头读早退与解析器不许对同一段文本各说各话）', () => {
	// 两处问的是同一个事实：读侧拿闭合判据决定不再往下读，写侧拿它决定不用升窗。判据说
	// 闭合而解析器拒绝的症状是「索引里有它、写侧却报不合规」，而那正是要从现场反推半天的
	// 问题。真值表钉形状，这里钉它与解析器的相容性
	const texts = [entry('标题', '触发词'), '---\r\ntitle: A\r\ndescription: B\r\n---\r\n\r\n正文\r\n', '---\ntitle: 长标题\ndescription: 触发词／召回词／斜杠词簇\n---\n']
	for (const text of texts) {
		assert.equal(hasClosedFence(text), true, `规范形条目须判为闭合：${JSON.stringify(text)}`)
		assert.equal(parseFrontmatter(text).ok, true, `说闭合却解析失败：${JSON.stringify(text)}`)
		assert.equal(findFenceEnd(frontmatterLines(text)), frontmatterLines(text).indexOf('---', 1), '围栏定位由 frontmatterLines/findFenceEnd 这一份回答')
	}
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
	// 同一份文案在写侧也钉住：判定与文案抽出去之后，两侧都不得再各自弱化
	assert.ok(r.warnings.some((w) => w.includes('日期戳') && w.includes('WRITING.md')), '日期戳告警须指向写侧纪律出处')
	assert.ok(r.warnings.some((w) => w.includes('收敛 description')), '派生行超长告警须给收敛方向')
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

test('upsertEntry 与 lintMemory：撞名两侧同判据（写侧造得出的语料体检干净，绕过写侧合流出的撞名被点名且写侧同拦）', async () => {
	const root = join(base, 'dup-title-parity')
	const dupWarnings = () => lintMemory({ memoryRoot: root }).warnings.filter((w) => w.includes('层内 title 重名'))

	// 方向一：写侧一条条造出来的语料（构造上就撞不了名）体检必干净。两个动作问的不是同一件事
	// （写侧问「再写这个 title 会不会撞上」，体检问「盘上现有的 title 有没有已经撞上的」），
	// 但「什么算撞名」这一个判据必须是同一份，否则会出现体检沉默而写侧事后拦的错位
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'one.md', content: entry('标题一', '触发词') })
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'two.md', content: entry('标题二', '触发词') })
	assert.deepEqual(dupWarnings(), [], '各占一个 title 的语料体检不报撞名')

	// 跨机合流能造出写侧造不出的语料：绕过写侧直接落盘（git merge 的等价物）。习惯层是
	// 跨机同步语料，两台机器各自拦得住自己，合流后这层才第一次出现重名
	writeFileSync(join(root, 'profile', 'three.md'), entry('标题一', '触发词'), 'utf8')
	const reported = dupWarnings()
	assert.equal(reported.length, 1, '合流出的一组撞名报一条')
	assert.ok(reported[0].includes('one.md') && reported[0].includes('three.md'), '体检点名撞上的两条')

	// 方向二：体检点名的那一组，写侧正在拦的正是那一个 title（不是别的）
	await assert.rejects(() => upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'four.md', content: entry('标题一', '触发词') }), /同名/)
	// 撞名只挡那一个 title，不把整层封死：重名躺在盘上时换个 title 仍写得进去
	await upsertEntry({ port, memoryRoot: root, layer: 'habit', file: 'five.md', content: entry('标题五', '触发词') })
	const afterWrite = dupWarnings()
	assert.equal(afterWrite.length, 1, '新写的条目不并入撞名组')
	assert.ok(afterWrite[0].includes('one.md') && afterWrite[0].includes('three.md'), '撞名组仍是原来那两条')
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

test('upsertEntry：同名判定只读文件头（探一次、闭合即停），正文里的 title 字样不参与判定', async () => {
	const root = join(base, 'write-head-only')
	const dir = join(root, 'profile')
	mkdirSync(dir, { recursive: true })
	// 头部两键几百字节就闭合，正文远远排在探测块之外；正文里摆一条完整形态的 title:
	// 行，它既不该被读进来，也不该被算成这条条目的 frontmatter
	const body = `${'填充段落。'.repeat(1000)}\ntitle: 撞名标题\n`
	writeFileSync(join(dir, 'peer.md'), entry('本条目自己的标题', '触发词', body), 'utf8')
	const reads = []
	const spy = {
		...port,
		readText(target) {
			reads.push({ method: 'readText', path: target.displayPath })
			return port.readText(target)
		},
		readHead(target, maxBytes, signal) {
			reads.push({ method: 'readHead', path: target.displayPath, maxBytes })
			return port.readHead(target, maxBytes, signal)
		},
	}
	const r = await upsertEntry({ port: spy, memoryRoot: root, layer: 'habit', file: 'other.md', content: entry('撞名标题', '另一词') })
	assert.equal(readFileSync(join(dir, 'other.md'), 'utf8'), entry('撞名标题', '另一词'), '正文里出现的同名字样不撞名：判定只看头部那份 frontmatter')
	assert.equal(r.indexLine, '- [撞名标题](other.md) — 另一词')
	// 这条用例真正钉的是读法而不只是结论：整篇读一次都不该出现，围栏闭合即停不必付兜底往返
	assert.deepEqual(reads, [{ method: 'readHead', path: join(dir, 'peer.md'), maxBytes: FRONTMATTER_HEAD_PROBE_BYTES }])
})

test('upsertEntry：头部未闭合的病态条目升到兜底上限读一次，随后判为不合规（不静默当作无同名）', async () => {
	const root = join(base, 'write-unclosed-head')
	const dir = join(root, 'profile')
	mkdirSync(dir, { recursive: true })
	// 单行超长正文顶在围栏之前：探测块与兜底上限都读不到闭合围栏，两次往返都只拿到半截
	const filler = '填'.repeat(Math.ceil(FRONTMATTER_HEAD_MAX_BYTES / 3) + 16)
	writeFileSync(join(dir, 'unclosed.md'), `---\ntitle: 未闭合条目\ndescription: 触发词\n${filler}\n`, 'utf8')
	const probes = []
	const spy = {
		...port,
		readHead(target, maxBytes, signal) {
			probes.push(maxBytes)
			return port.readHead(target, maxBytes, signal)
		},
	}
	await assert.rejects(
		() => upsertEntry({ port: spy, memoryRoot: root, layer: 'habit', file: 'other.md', content: entry('别的条目', '触发词') }),
		(error) => {
			assert.match(error.message, /层内 1 条 frontmatter 不合规/)
			assert.match(error.message, /unclosed\.md/)
			assert.match(error.message, /未闭合/)
			return true
		},
		'兜底往返只影响成本，不改变判定：读不满头就判不合规，与整篇读时同一结论',
	)
	assert.deepEqual(probes, [FRONTMATTER_HEAD_PROBE_BYTES, FRONTMATTER_HEAD_MAX_BYTES], '探测未命中围栏即升到兜底上限')
	assert.equal(existsSync(join(dir, 'other.md')), false, '拦截不得留孤儿条目')
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

test('editEntry：命中域含尾换行（照 read 原文复制文末片段即命中，不必先掐掉换行）', async () => {
	const root = join(base, 'edit-hit-tail')
	const dir = join(root, 'profile')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'topic.md'), '---\ntitle: A\ndescription: B\n---\n\n甲行\n\n乙行\n', 'utf8')
	// 调用方是从 read 的原文里复制片段，而落盘恒以 \n 收尾：把尾换行切出命中域时，
	// 下面第 1、3 两种写法（照抄文末几行）必然报「未命中」，报错还反指「勿凭印象」
	const 带尾换行 = await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '乙行\n', newString: '乙行改\n' })
	assert.equal(带尾换行.replacements, 1)
	assert.equal(readFileSync(join(dir, 'topic.md'), 'utf8'), '---\ntitle: A\ndescription: B\n---\n\n甲行\n\n乙行改\n')
	const 跨空行 = await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '甲行\n\n乙行改', newString: '甲乙合一行' })
	assert.equal(跨空行.replacements, 1)
	assert.equal(readFileSync(join(dir, 'topic.md'), 'utf8'), '---\ntitle: A\ndescription: B\n---\n\n甲乙合一行\n')
	const 跨空行带尾换行 = await editEntry({ port, memoryRoot: root, layer: 'habit', file: 'topic.md', oldString: '\n\n甲乙合一行\n', newString: '\n\n甲乙终行\n' })
	assert.equal(跨空行带尾换行.replacements, 1)
	assert.equal(readFileSync(join(dir, 'topic.md'), 'utf8'), '---\ntitle: A\ndescription: B\n---\n\n甲乙终行\n', '整文全等：前两行替换后未被覆盖的形态一并钉死')
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
