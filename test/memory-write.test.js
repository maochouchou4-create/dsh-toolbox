/**
 * dsh-memory 端口写侧单测（node:test，零宿主依赖）：frontmatter 契约、索引行派生、
 * 层路由、upsert（建/拦截/风格告警）、edit（按节锚定/按键改 frontmatter/版本守卫/目标组合拦截）、
 * 节判定的共享谓词。
 * upsert/edit 走 fs 端口（createNodeFsPort 构造一次、逐用例复用），故是 async。
 * delete 与 lint 各有自己的文件（memory-delete.test.js／memory-lint.test.js，I/O 按
 * 设计留在 node:fs 保持同步）；本文件仍留一条横跨三个动作的会话策略用例——那条断言
 * 证的是「四个 action 同一口径」，拆到三个文件里就散成三条各自为政的断言。
 * 每个用例独立临时根，互不共享状态。
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createNodeFsPort } from '../lib/fs-port.js'
import { INDEX_LINE_CHAR_BUDGET, RUNAWAY_CEILING } from '../lib/memory/core.js'
import { DEFAULT_MEMORY_ROOT, resolveRoot } from '../lib/memory-root.js'
import { deleteEntry } from '../lib/memory/delete.js'
import { assertEntryFrontmatter, deriveIndexLine, findFenceEnd, frontmatterLines, FRONTMATTER_HEAD_MAX_BYTES, FRONTMATTER_HEAD_PROBE_BYTES, groupTitlesByTitle, hasClosedFence, parseFrontmatter } from '../lib/memory/frontmatter.js'
import { lintMemory } from '../lib/memory/lint.js'
import { assertEntryHasSection, duplicateSectionHeadings, sectionHeadings } from '../lib/memory/patterns.js'
import { editEntry, upsertEntry } from '../lib/memory/write.js'
import { entry, tempRoot } from './helpers.js'

let base
const port = createNodeFsPort()

before((t) => {
	base = tempRoot(t, 'memory-write')
})

/* ===================== frontmatter 契约 ===================== */

test('resolveRoot：记忆根归一成绝对路径（相对路径不按两套基目录分家）', () => {
	// 断言走 resolveRoot 的 root 字段：absoluteMemoryRoot 已收为 memory-root.js 模块私有（唯一出口
	// 是 resolveRoot，它自带缺省兜底），「不许漏兜底」从此不靠注释维持
	assert.equal(resolveRoot(DEFAULT_MEMORY_ROOT).root, join(homedir(), '.dsh', 'memory'), '默认根的 ~ 要展开')
	assert.equal(resolveRoot('~/tilde').root, join(homedir(), 'tilde'))
	// 相对根按 process.cwd() 定死：否则写侧走宿主 fs 后端基目录、读侧走 cwd，两套语义
	assert.equal(resolveRoot('相对根').root, resolve('相对根'))
	assert.equal(resolveRoot('./a/../b').root, resolve('b'))
	assert.equal(resolveRoot('/abs/root').root, '/abs/root', '绝对路径原样透传')
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
	const r = await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'dated.md', content: entry('带日期戳的条目', `2026-01-02 记录／${long}`) })
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
	const args = { port, memoryRoot: root, layer: 'profile', file: 'ok.md', content: entry('合规条目', '触发词') }
	await assert.rejects(() => upsertEntry({ ...args, content: '# 没有 frontmatter\n' }), /frontmatter 不合规/)
	await assert.rejects(() => upsertEntry({ ...args, content: '---\nname: ok\ntitle: 多余键\ndescription: 触发词\n---\n\n正文\n' }), /多余键/)
	await assert.rejects(() => upsertEntry({ ...args, content: entry('[带括号]', '触发词') }), /方括号/)
	await assert.rejects(() => upsertEntry({ ...args, content: '---\ntitle: 折行\ndescription: >-\n  一\n  二\n---\n\n正文\n' }), /frontmatter 不合规/)
	await assert.rejects(() => upsertEntry({ ...args, content: '---\ndescription: 触发词\n---\n\n正文\n' }), /缺 title/)
	assert.equal(existsSync(join(root, 'profile', 'ok.md')), false, '拦截分支不得落盘')
})

test('upsertEntry：层内同名拦截且不落盘（处置是改 title 不 delete，且点名全部撞上的条目）', async () => {
	const root = join(base, 'write-dup')
	await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'first.md', content: entry('同一个标题', '触发词') })
	await assert.rejects(() => upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'second.md', content: entry('同一个标题', '另一词') }), /同名/)
	assert.equal(existsSync(join(root, 'profile', 'second.md')), false, '拦截不得留孤儿条目')
	// 同名但就是它自己（重写同一条目）不拦
	const again = await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'first.md', content: entry('同一个标题', '触发词改') })
	assert.equal(again.indexLine, '- [同一个标题](first.md) — 触发词改')
	// 报错点名全部撞上的条目而不只是第一条：读者照着改要一次改对，撞一个改一个得来回几趟。
	// 绕过写侧直接落盘（跨机合流的等价物）造出第二条撞名，报错须两个名字都给全
	writeFileSync(join(root, 'profile', 'third.md'), entry('同一个标题', '第三词'), 'utf8')
	await assert.rejects(
		() => upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'second.md', content: entry('同一个标题', '另一词') }),
		(error) => {
			assert.match(error.message, /first\.md/)
			assert.match(error.message, /third\.md/)
			// 处置口径与体检那份同向：撞上的不是待写这条的旧版本，照着「先 delete 再改名」丢的是真条目
			assert.match(error.message, /edit/)
			assert.ok(!error.message.includes('先 delete 再改名'), error.message)
			return true
		},
		'报错须点名全部撞名条目并给出无损的处置',
	)
})

test('upsertEntry 与 lintMemory：撞名两侧同判据（写侧造得出的语料体检干净，绕过写侧合流出的撞名被点名且写侧同拦）', async () => {
	const root = join(base, 'dup-title-parity')
	const dupWarnings = () => lintMemory({ memoryRoot: root }).warnings.filter((w) => w.includes('层内 title 重名'))

	// 方向一：写侧一条条造出来的语料（构造上就撞不了名）体检必干净。两个动作问的不是同一件事
	// （写侧问「再写这个 title 会不会撞上」，体检问「盘上现有的 title 有没有已经撞上的」），
	// 但「什么算撞名」这一个判据必须是同一份，否则会出现体检沉默而写侧事后拦的错位
	await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'one.md', content: entry('标题一', '触发词') })
	await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'two.md', content: entry('标题二', '触发词') })
	assert.deepEqual(dupWarnings(), [], '各占一个 title 的语料体检不报撞名')

	// 跨机合流能造出写侧造不出的语料：绕过写侧直接落盘（git merge 的等价物）。习惯层是
	// 跨机同步语料，两台机器各自拦得住自己，合流后这层才第一次出现重名
	writeFileSync(join(root, 'profile', 'three.md'), entry('标题一', '触发词'), 'utf8')
	const reported = dupWarnings()
	assert.equal(reported.length, 1, '合流出的一组撞名报一条')
	assert.ok(reported[0].includes('one.md') && reported[0].includes('three.md'), '体检点名撞上的两条')

	// 方向二：体检点名的那一组，写侧正在拦的正是那一个 title（不是别的）
	await assert.rejects(() => upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'four.md', content: entry('标题一', '触发词') }), /同名/)
	// 撞名只挡那一个 title，不把整层封死：重名躺在盘上时换个 title 仍写得进去
	await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'five.md', content: entry('标题五', '触发词') })
	const afterWrite = dupWarnings()
	assert.equal(afterWrite.length, 1, '新写的条目不并入撞名组')
	assert.ok(afterWrite[0].includes('one.md') && afterWrite[0].includes('three.md'), '撞名组仍是原来那两条')
})

test('同名判定：同一条目体检整篇读、写侧头读 64KB 封顶，围栏闭合在窗口之外的存量条目两侧答案不同', async () => {
	const root = join(base, 'dup-title-head-window')
	const dir = join(root, 'profile')
	mkdirSync(dir, { recursive: true })
	// frontmatter 本身合法，但收尾围栏被推到 FRONTMATTER_HEAD_MAX_BYTES 之外：description 是
	// 一整行超长值（单行形态、不折行，所以照样合规），这是「值写太长把围栏顶出窗口」的真实形态
	const wide = entry('宽条目', '词'.repeat(FRONTMATTER_HEAD_MAX_BYTES), '正文')
	writeFileSync(join(dir, 'wide.md'), wide, 'utf8')
	writeFileSync(join(dir, 'narrow.md'), entry('宽条目', '触发词'), 'utf8')

	// 写侧只读到 64KB，看不见收尾围栏 → 判成不合规 → 整层封死，连别的条目也写不了
	await assert.rejects(
		() => upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'third.md', content: entry('第三个条目', '触发词') }),
		(error) => {
			assert.match(error.message, /frontmatter 不合规/)
			assert.match(error.message, /wide\.md/)
			return true
		},
		'写侧头读窗口看不到收尾围栏，该条目判成不合规',
	)
	// 体检整篇读，围栏闭合 → 判合规，于是看见重名并点名两条。两侧答案不同是既成事实：
	// 判定本身已下沉到同一份函数，分叉来自两侧的读法不同（头读有窗口、整篇读没有），
	// 这条用例把这个分叉钉住，免得哪天读法变了却没人发现
	const dup = lintMemory({ memoryRoot: root }).warnings.filter((w) => w.includes('层内 title 重名'))
	assert.equal(dup.length, 1, '体检读得到围栏，于是看见重名')
	assert.ok(dup[0].includes('wide.md') && dup[0].includes('narrow.md'), '点名撞上的两条')
})

test('groupTitlesByTitle：按 title 字段分组、不合群的另列一份（两份消费方拿不同那一面）', () => {
	const { byTitle, dups, unparsable } = groupTitlesByTitle([
		{ name: 'a.md', text: entry('标题一', '触发词') },
		{ name: 'b.md', text: entry('标题一', '另一词') },
		{ name: 'c.md', text: entry('标题二', '触发词') },
		{ name: 'bad.md', text: '没有 frontmatter\n' },
	])
	assert.deepEqual(byTitle.get('标题一'), ['a.md', 'b.md'], '同 title 的按喂入顺序聚成一组')
	assert.deepEqual(byTitle.get('标题二'), ['c.md'], '各占一个 title 的单列一组')
	// dups 是「组长 > 1」那道门槛的唯一定义处：扫描器与体检都直接取它。门槛留在各自
	// 调用方的话，下一个同类需求（title 归一后撞、跨层撞）要改两个文件
	assert.deepEqual(dups, [{ title: '标题一', names: ['a.md', 'b.md'] }], '只有撞上的组进 dups，单条组不进')
	assert.deepEqual(unparsable, [{ name: 'bad.md', error: '条目开头缺 frontmatter（首行须为 ---）' }], '不合群的随值返回，带病因供写侧拼报错')
	// 不合群的既不进分组也不占一个空 title——空串会被当成真实存在的 title
	assert.equal(byTitle.has(''), false)
	assert.equal(byTitle.size, 2)
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
		() => upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'other.md', content: entry('别的条目', '触发词') }),
		(error) => {
			assert.match(error.message, /层内 2 条 frontmatter 不合规/)
			assert.match(error.message, /legacy\.md/)
			assert.match(error.message, /legacy-two\.md/)
			// 两条并存时 write 重写任一条都会被另一条挡住，文案不许说「write 是唯一还能写的路径」
			assert.match(error.message, /先 delete 掉多余的坏条目/)
			return true
		},
		'拦截文案必须自带脱困路径与全部坏条目，否则读到的人会以为整层锁死，转而绕过工具裸编辑文件',
	)
	assert.equal(existsSync(join(dir, 'other.md')), false, '拦截不得留孤儿条目')
	// edit 修不了缺键的坏条目：按键编辑只改现存键行，legacy.md 连 title: 行都没有——
	// 老工具时代「edit 逐字改写 frontmatter」的脱困路随按节/按键契约退役，这里拦下并指给 write
	await assert.rejects(
		() => editEntry({ port, memoryRoot: root, layer: 'profile', file: 'legacy.md', title: '老条目', description: '触发词' }),
		/没有「title:」行/,
		'edit 的按键编辑补不出缺失的键，脱困路径指给 write',
	)
	// 有键可改也不行，但拦它的是另一道门：title 行替换出的 next 内容自己就过不了
	// upsert 的 frontmatter 契约（metadata 多余键＋description 缺键）——坏条目修不好自己，
	// 谈不上「改 title」
	await assert.rejects(
		() => editEntry({ port, memoryRoot: root, layer: 'profile', file: 'legacy-two.md', title: '另一个老条目改' }),
		/legacy-two\.md 的 frontmatter 不合规/,
		'坏条目自身先过不了 upsert 契约（缺键＋多余键），edit 修不了它',
	)
	assert.equal(readFileSync(join(dir, 'legacy.md'), 'utf8').includes('metadata'), true, '被拦的 edit 不得留下半截改动')
	// edit 的层封路径可达于「编辑的是合规条目、坏的是同伴」：同名判定把 title 不可知的
	// 同伴当潜在撞名源，宁可封层也不放行
	const lockRoot = join(base, 'write-edit-lock')
	const lockDir = join(lockRoot, 'profile')
	mkdirSync(lockDir, { recursive: true })
	await upsertEntry({ port, memoryRoot: lockRoot, layer: 'profile', file: 'valid.md', content: entry('编辑锁条目', '触发词', '## 节\n\n正文\n') })
	writeFileSync(join(lockDir, 'broken.md'), '没有 frontmatter 的裸正文\n', 'utf8')
	await assert.rejects(
		() => editEntry({ port, memoryRoot: lockRoot, layer: 'profile', file: 'valid.md', title: '编辑锁条目改' }),
		(error) => {
			assert.match(error.message, /层内 1 条 frontmatter 不合规/)
			assert.match(error.message, /broken\.md/)
			return true
		},
		'edit 只跳过自己：同伴坏条目在场时它同样写不了',
	)
	// 脱困姿势：先 delete 掉一条，剩最后一条时 write 重写它就是层内唯一还能写的路径
	// （同名扫描把待写这条排除在外）；坏条目缺的是键本身，edit 的按键编辑补不出缺失的键，
	// 故脱困走 write 而非 edit
	const deleted = deleteEntry({ port, memoryRoot: root, layer: 'profile', file: 'legacy-two.md' })
	assert.equal(existsSync(join(dir, 'legacy-two.md')), false)
	assert.deepEqual(deleted.references, [])
	await assert.rejects(
		() => upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'other.md', content: entry('别的条目', '触发词') }),
		(error) => {
			assert.match(error.message, /层内 1 条 frontmatter 不合规/)
			assert.match(error.message, /legacy\.md/)
			assert.match(error.message, /同名扫描把待写这条排除在外，它是层内唯一还能写的路径/)
			return true
		},
	)
	const fixed = await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'legacy.md', content: entry('老条目', '触发词', '老正文。') })
	assert.equal(fixed.indexLine, '- [老条目](legacy.md) — 触发词')
	assert.equal(readFileSync(join(dir, 'legacy.md'), 'utf8'), entry('老条目', '触发词', '老正文。'))
	const other = await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'other.md', content: entry('别的条目', '触发词') })
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
	const r = await upsertEntry({ port: spy, memoryRoot: root, layer: 'profile', file: 'other.md', content: entry('撞名标题', '另一词') })
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
		() => upsertEntry({ port: spy, memoryRoot: root, layer: 'profile', file: 'other.md', content: entry('别的条目', '触发词') }),
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

test('upsertEntry：前置拦截（空桶名/空 content/超限/非 kebab/保留名）', async () => {
	const root = join(base, 'pre-reject')
	const ok = { port, memoryRoot: root, layer: 'profile', file: 'ok.md', content: entry('合规条目', '触发词') }
	// 层值域不在这层守：layer 已进 schema enum，值错由宿主在调用边界拦（报错自带合法值
	// 清单；裸仓 stub 无 validateArgs，宿主层那条待重启后真会话验证），写侧不再自带
	// 未知层分支——传错值到这里属接线错误，不是要再拦一道的使用错误
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
	const args = { port, memoryRoot: root, layer: 'profile', file: 'topic.md', content: entry('主题条目', '触发词') }
	await assert.rejects(() => upsertEntry({ ...args, port: readOnly }), (error) => {
		// code 在宿主词表内，harness 的 toolErrorResult 与模型才拿得到类型
		assert.equal(error.code, 'FS_SANDBOX_DENIED')
		assert.match(error.message, /danger-full-access/)
		assert.doesNotMatch(error.message, /workspace-write 或更高/, '围栏范围是会话 cwd，照着改成 workspace-write 仍然被拒，不得这么引导')
		return true
	})
	assert.equal(existsSync(join(root, 'profile')), false, '被拒的写入不得建桶落盘')
	await upsertEntry(args)
	await assert.rejects(() => editEntry({ port: readOnly, memoryRoot: root, layer: 'profile', file: 'topic.md', heading: '节', body: '新正文' }), /不允许写记忆/)
	assert.equal(readFileSync(join(root, 'profile', 'topic.md'), 'utf8'), entry('主题条目', '触发词'), '被拒的编辑不得落盘')
	// delete 的 I/O 虽留在 node:fs（宿主契约无删除能力），照样接端口问能不能写：
	// 四个 action 同一口径。它是同步函数（I/O 无 await），故用 throws 而非 rejects
	assert.throws(() => deleteEntry({ port: readOnly, memoryRoot: root, layer: 'profile', file: 'topic.md' }), /不允许写记忆/)
	assert.ok(existsSync(join(root, 'profile', 'topic.md')), '被拒的删除不得动条目')
	// 策略缺省（无会话上下文）＝不受限：字段缺席不得被当成只读而误拒
	const ok = await upsertEntry({ ...args, file: 'other.md', content: entry('另一条目', '触发词') })
	assert.equal(ok.indexLine, '- [另一条目](other.md) — 触发词')
	// 只读策略只关写入：读侧与体检照常可用（文案里承诺过这句）
	assert.equal(lintMemory({ memoryRoot: root }).ok, true)
})

test('upsertEntry：write 路径不带版本守卫（语义是「以我这份为准」，并发两次 write 后者赢）', async () => {
	const root = join(base, 'write-no-guard')
	await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'one.md', content: entry('条目', '触发词', 'v1') })
	const r = await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'one.md', content: entry('条目', '触发词', 'v2') })
	assert.equal(readFileSync(join(r.dir, 'one.md'), 'utf8'), entry('条目', '触发词', 'v2'), 'write 无版本守卫：后者整份覆盖前者')
})

test('editEntry：并发两次改同一条目，后到者抛 FS_STALE_VERSION 且先到者正文完好', async () => {
	const root = join(base, 'edit-guard')
	const entryPath = join(root, 'profile', 'topic.md')
	await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', content: entry('主题条目', '触发词', '## 状态\n\nv1 状态行\n') })
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
		() => editEntry({ port: racing, memoryRoot: root, layer: 'profile', file: 'topic.md', heading: '状态', body: 'v2 状态行\n' }),
		(error) => {
			assert.equal(error.code, 'FS_STALE_VERSION')
			assert.match(error.message, /重试/)
			return true
		},
	)
	assert.equal(readFileSync(entryPath, 'utf8'), '并发方先改\n', '版本失配不得静默吃掉并发方刚落的正文')
})

/* ===================== edit ===================== */

test('editEntry：按节锚定整段替换正文（heading 唯一命中），结果报 section 与 file_path', async () => {
	const root = join(base, 'edit-basic')
	await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', content: entry('主题条目', '触发词', '## 状态\n\nv1 状态行\n\n## 备注\n\n备注正文\n') })
	const r = await editEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', heading: '状态', body: '\nv2 状态行\n' })
	assert.equal(r.section, '状态')
	assert.equal(r.file_path, 'topic.md', '结果键与工具出参同名（file_path）')
	// 全等而非 includes：edit 只许动锚定那一节的正文 span，frontmatter、节标题行与
	// 下一节的正文一并钉死，子串断言会让「顺带把别的节写坏了」这类回归绿灯通过。
	// body 是「标题行之下」的整段 span：紧贴标题行的那行空行也在 span 里，要保住隔行
	// 就把它写进 body（机械全 span 语义，不替调用方补行删行）
	assert.equal(
		readFileSync(join(r.dir, 'topic.md'), 'utf8'),
		entry('主题条目', '触发词', '## 状态\n\nv2 状态行\n\n## 备注\n\n备注正文\n'),
		'只动锚定节的正文：标题行与其后各节逐字未动',
	)
	assert.equal(r.indexLine, '- [主题条目](topic.md) — 触发词', '只改正文时索引行不变')
	assert.deepEqual(r.warnings, [], '正常 edit 不产生任何 warning')
})

test('editEntry：按键改 frontmatter（title/description 可同传），派生行按改完的两键重算', async () => {
	const root = join(base, 'edit-frontmatter')
	await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', content: entry('旧标题', '旧触发词', '## 节\n\n正文\n') })
	const r = await editEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', title: '新标题', description: '新触发词' })
	assert.deepEqual(r.frontmatterEdited, ['title', 'description'])
	assert.equal(r.indexLine, '- [新标题](topic.md) — 新触发词', '改了任一键即重算派生行')
	assert.equal(readFileSync(join(r.dir, 'topic.md'), 'utf8'), entry('新标题', '新触发词', '## 节\n\n正文\n'), '只有那两行被动过，正文逐字未动')
	const single = await editEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', title: '再改一次' })
	assert.deepEqual(single.frontmatterEdited, ['title'], '单传一键只报一键')
})

test('editEntry：改出不合规 frontmatter 走同一条拦截链（先算后写，不留半截改动）', async () => {
	const root = join(base, 'edit-fm')
	await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', content: entry('主题条目', '触发词', '## 节\n\n正文行\n') })
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', title: '[带括号]' }), /方括号/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', description: '折\n行' }), /单行/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', title: '   ' }), /title 为空/, '空值键行写进去后由 frontmatter 契约拦')
	assert.equal(readFileSync(join(root, 'profile', 'topic.md'), 'utf8'), entry('主题条目', '触发词', '## 节\n\n正文行\n'), '被拦后整份保持原样')
})

test('editEntry：锚定拦截（未命中列出全部节标题/重名拒绝/无节可锚）与目标组合拦截（并存/缺 body/body 无锚/无目标）', async () => {
	const root = join(base, 'edit-reject')
	await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', content: entry('主题条目', '触发词', '## 状态\n\n正文\n\n## 备注\n\n另一段\n') })
	// 未命中：报错列出全部节标题，调用方就地挑对（按节锚定的锚点是节标题，不逐字复述正文）
	await assert.rejects(
		() => editEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', heading: '不存在节', body: 'x' }),
		(error) => {
			assert.match(error.message, /未命中/)
			assert.match(error.message, /「状态」/)
			assert.match(error.message, /「备注」/)
			return true
		},
		'未命中须列出全部节标题',
	)
	// 重名拒绝：同名节有两处时锚不唯一，替换落到哪节全凭运气——拦
	writeFileSync(
		join(root, 'profile', 'dup.md'),
		entry('重名节条目', '触发词', '## 状态\n\n第一处\n\n## 状态\n\n第二处\n'),
		'utf8',
	)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'profile', file: 'dup.md', heading: '状态', body: 'x' }), /命中 2 处/)
	// 无节可锚
	await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'flat.md', content: entry('无节条目', '触发词', '没有节结构的正文') })
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'profile', file: 'flat.md', heading: '状态', body: 'x' }), /没有 ## 节/)
	// 目标组合：并存/缺 body/body 无锚/无目标
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', heading: '状态', body: 'x', title: '新标题' }), /并存/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', heading: '状态' }), /heading 编辑必须带 body/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', body: 'x' }), /body 须与 heading 同传/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md' }), /没有编辑目标/)
	// 前置拦截照旧（非 kebab/条目不存在）
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'profile', file: 'Bad_Name.md', title: 'x' }), /kebab/)
	await assert.rejects(() => editEntry({ port, memoryRoot: root, layer: 'profile', file: 'ghost.md', title: 'x' }), /不存在/)
})

test('editEntry：body 空串删节正文保留标题行；多节条目编辑中间节不动前后节与尾空行', async () => {
	const root = join(base, 'edit-body-empty')
	await upsertEntry({
		port,
		memoryRoot: root,
		layer: 'profile',
		file: 'topic.md',
		content: entry('主题条目', '触发词', '## 甲\n\n甲正文\n\n## 乙\n\n乙正文\n\n## 丙\n\n丙正文\n'),
	})
	const r = await editEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', heading: '乙', body: '' })
	assert.equal(r.section, '乙')
	assert.equal(
		readFileSync(join(r.dir, 'topic.md'), 'utf8'),
		entry('主题条目', '触发词', '## 甲\n\n甲正文\n\n## 乙\n## 丙\n\n丙正文\n'),
		'空 body 删光该节正文只留标题行；甲丙两节逐字未动',
	)
	// 尾部空行是 body span 的一部分（契约：含尾部空行；紧贴标题行的空行同样在 span 里），
	// 作者写几行就是几行——这里钉「替调用方补/删空行」这类好心不得存在
	const tailed = await editEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', heading: '丙', body: '\n丙改\n\n\n' })
	assert.equal(
		readFileSync(join(tailed.dir, 'topic.md'), 'utf8'),
		entry('主题条目', '触发词', '## 甲\n\n甲正文\n\n## 乙\n## 丙\n\n丙改\n\n'),
		'body 按字面成行，空行不补不删',
	)
})

test('editEntry：CRLF 正文照常工作，落盘归一 LF（git checkout 形态）', async () => {
	const root = join(base, 'edit-crlf')
	const dir = join(root, 'profile')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'topic.md'), '---\r\ntitle: 主题条目\r\ndescription: 触发词\r\n---\r\n\r\n## 节\r\n\r\n甲行\r\n\r\n', 'utf8')
	const r = await editEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', heading: '节', body: '\n乙行\n\n' })
	assert.equal(r.section, '节')
	assert.equal(r.indexLine, '- [主题条目](topic.md) — 触发词', 'CRLF frontmatter 照样派生出索引行')
	// 一条全等钉住三件事：替换生效、落盘统一 LF、节结构与空行形态完好；拆成子串断言时
	// 「frontmatter 被顺带改坏」这类回归照样绿灯通过
	assert.equal(readFileSync(join(dir, 'topic.md'), 'utf8'), '---\ntitle: 主题条目\ndescription: 触发词\n---\n\n## 节\n\n乙行\n\n', 'CRLF 条目按节替换后整文正确（LF 归一＋span 语义按字面）')
})

test('editEntry：超失控保护与按键路径的契约拦截走同一条链（结果仍过 upsert 校验）', async () => {
	const root = join(base, 'edit-validate')
	const big = join(base, 'edit-big')
	await upsertEntry({ port, memoryRoot: big, layer: 'profile', file: 'big.md', content: entry('大条目', '触发词', `## 节\n\n${'x'.repeat(RUNAWAY_CEILING - 200)}\n`) })
	await assert.rejects(() => editEntry({ port, memoryRoot: big, layer: 'profile', file: 'big.md', heading: '节', body: `## 节\n\n${'yy'.repeat(RUNAWAY_CEILING)}\n` }), /失控保护/)
	// 按键编辑只改现存键行：键不在（老布局条目）即拦并指给 write，不静默当作改成功
	const legacyRoot = join(base, 'edit-legacy-key')
	const dir = join(legacyRoot, 'profile')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'legacy.md'), '---\nname: 老条目\n---\n\n正文\n', 'utf8')
	await assert.rejects(() => editEntry({ port, memoryRoot: legacyRoot, layer: 'profile', file: 'legacy.md', title: '新标题' }), /没有「title:」行/)
	assert.equal(readFileSync(join(dir, 'legacy.md'), 'utf8'), '---\nname: 老条目\n---\n\n正文\n', '被拦后整份保持原样')
	// 无节条目的 frontmatter 编辑照常可达（语料迁移收口前的存量常态，这条路必须畅通）
	await upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'flat.md', content: entry('无节条目', '触发词', '没有节结构的正文') })
	const flat = await editEntry({ port, memoryRoot: root, layer: 'profile', file: 'flat.md', description: '新触发词' })
	assert.equal(flat.indexLine, '- [无节条目](flat.md) — 新触发词', '无节条目按键改 frontmatter 不受节结构影响')
})

test('editEntry：条目名被同名目录占用时按宿主词表拒改，与 upsert／delete 同一 name＋code', async () => {
	const root = join(base, 'edit-not-regular')
	const dir = join(root, 'profile')
	mkdirSync(join(dir, 'topic.md'), { recursive: true })
	const 捕获 = async (fn) => {
		try {
			await fn()
		} catch (error) {
			return error
		}
		return undefined
	}
	// 这道门在 edit 上是独立的一道：edit 是「判类型 → 读现文 → 内存里按节/按键改 → 交
	// upsert 落盘」，少了它就拿着一个目录去 readText，炸成裸 node 的 EISDIR（调用方按
	// code 断会断不到）
	const 编辑错误 = await 捕获(() => editEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', heading: '节', body: 'x' }))
	assert.equal(编辑错误?.code, 'FS_NOT_REGULAR_FILE', '拒改须报宿主那个码')
	assert.equal(编辑错误?.name, 'FsPortError')
	// 同一个故障在 upsert 与 edit 上是同一个错误对象形状：判定与错误工厂走 fs-guard.js
	// 那一份（delete 路径上与 upsert 的对照在 memory-delete.test.js），三处必须一致
	const 写错误 = await 捕获(() => upsertEntry({ port, memoryRoot: root, layer: 'profile', file: 'topic.md', content: entry('主题条目', '触发词') }))
	assert.equal(写错误?.code, 编辑错误?.code)
	assert.equal(写错误?.name, 编辑错误?.name)
	assert.equal(statSync(join(dir, 'topic.md')).isDirectory(), true, '被拒的编辑不得动那个目录')
})

/* ===================== 节判定（patterns 共享谓词） ===================== */

test('sectionHeadings：只认「## 标题」行（剥 frontmatter 后按行定位），深浅标题与空标题不算节', () => {
	const text = entry('主题', '触发词', '### 深标题\n\n## 甲\n\n甲正文\n\n##\n\n## 乙  \n\n乙正文\n')
	assert.deepEqual(
		sectionHeadings(text).map(({ title, line }) => [title, line]),
		[['甲', 7], ['乙', 13]],
		'### 是节内层级、空标题是病态写法；行号指向归一后行数组（0 起，含 frontmatter 与其后的空行），title 去首尾空白',
	)
	assert.deepEqual(duplicateSectionHeadings(entry('主题', '触发词', '## 甲\n\n一\n\n## 甲\n\n二\n\n## 乙\n\n三\n')), ['甲'], '同名节报标题不报处数')
	assert.deepEqual(duplicateSectionHeadings(entry('主题', '触发词', '## 甲\n\n一\n\n## 乙\n\n二\n')), [], '各不同名不报')
	// frontmatter 里的「## 」形态不该参与：剥围栏后再算，行号与「frontmatter 之后第几行」一致
	const withFm = sectionHeadings(entry('主题', '触发词', '## 唯一\n'))
	assert.deepEqual(withFm, [{ title: '唯一', line: 5 }])
})

test('assertEntryHasSection：无节的 content 拦（写入守卫），空白串与非字符串放行给 upsert 的 content 判空', () => {
	assert.throws(() => assertEntryHasSection(entry('主题', '触发词', '没有节结构的正文')), /至少要有一个 ## 节/)
	assert.doesNotThrow(() => assertEntryHasSection(entry('主题', '触发词', '## 节\n\n正文\n')))
	assert.doesNotThrow(() => assertEntryHasSection('   \n\t'), '空白串不在这里拦——判空是 upsert 那道的事（「content 不能为空」），各报各的病因')
	assert.doesNotThrow(() => assertEntryHasSection(undefined), '非字符串同理')
})
