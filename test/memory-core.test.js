/**
 * dsh-memory 读侧单测（node:test，零宿主依赖）：记忆根路由与 slug、读取状态、索引预算、
 * 扫目录派生索引、注入块组装。
 * 夹具在临时目录搭建，测后清理；写侧（upsert/edit/delete/lint）在 write.test.js。
 * 每个用例独占一个根目录——避免目录内容互相牵连。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { HEAD_CHUNK_BYTES } from '../lib/head-read.js'
import { INDEX_CHAR_BUDGET, INDEX_LINE_BUDGET, RUNAWAY_CEILING, applyIndexBudget } from '../lib/memory/core.js'
import { DEFAULT_MEMORY_ROOT, resolveRoot, workspaceSlug } from '../lib/memory-root.js'
import { composeMemory, readCapped } from '../lib/memory/assemble.js'
import { entry } from './helpers.js'

let base
let memoryRoot

before(() => {
	base = join(tmpdir(), `dsh-memory-test-${process.pid}`)
	memoryRoot = join(base, 'memory')
	mkdirSync(base, { recursive: true })
})

after(() => {
	rmSync(base, { recursive: true, force: true })
})

/** 独立根目录：建 habit 层，可选建工作桶；返回根与各目录。 */
const fixture = (name) => {
	const root = join(base, name)
	const profile = join(root, 'profile')
	mkdirSync(profile, { recursive: true })
	return { root, profile }
}

test('workspaceSlug：分隔符归一、折叠、去首尾、不小写', () => {
	assert.equal(workspaceSlug('/home/nvse/code'), 'home-nvse-code')
	assert.equal(workspaceSlug('D:\\code'), 'D-code')
	assert.equal(workspaceSlug('/a//b'), 'a-b')
	assert.equal(workspaceSlug('C:/Users/mcc'), 'C-Users-mcc')
	assert.equal(workspaceSlug('/home/nvse/code.local'), 'home-nvse-code.local')
})

test('workspaceSlug：全分隔符路径归化为空串（调用方省略该层）', () => {
	assert.equal(workspaceSlug('///'), '')
	assert.equal(workspaceSlug('\\/'), '')
})

test('workspaceSlug：空串与非字符串抛 TypeError（Fail Fast）', () => {
	assert.throws(() => workspaceSlug(''), TypeError)
	assert.throws(() => workspaceSlug(undefined), TypeError)
	assert.throws(() => workspaceSlug(null), TypeError)
	assert.throws(() => workspaceSlug(42), TypeError)
})

test('resolveRoot：缺省兜底与绝对化一步做完，对已绝对化的入参幂等（注册期归一过再传进来不变形）', () => {
	assert.deepEqual(resolveRoot(DEFAULT_MEMORY_ROOT), { root: join(homedir(), '.dsh', 'memory'), profile: join(homedir(), '.dsh', 'memory', 'profile'), workspaces: join(homedir(), '.dsh', 'memory', 'workspaces') }, '默认根的 ~ 要展开')
	// 兜底收在这一步：空值与非字符串一律按没给算，调用方不再各自拼回退形态
	for (const blank of [undefined, null, '', '   ', 42]) {
		assert.deepEqual(resolveRoot(blank), resolveRoot(DEFAULT_MEMORY_ROOT), `${JSON.stringify(blank)} 应当作没给`)
	}
	// 相对根必须解析成绝对路径：读侧与写侧的基目录不同，不归一就是两套语义
	const relative = resolveRoot('./memory')
	assert.deepEqual(relative, resolveRoot(resolve('./memory')), '相对根按 cwd 解析')
	assert.ok(isAbsolute(relative.profile) && isAbsolute(relative.workspaces), '两个子位置都得是绝对路径')
	// 幂等是「一次归一」这句话成立的前提：已归一过的值再传进来结果不变，故注册期归一过
	// 的根、以及 resolveRoot 自己的产物，都不会二次变形
	assert.deepEqual(resolveRoot(resolveRoot('./memory').root), resolveRoot('./memory'), '对已绝对化的入参幂等')
	assert.equal(resolveRoot('/abs/memory').root, '/abs/memory', '绝对根原样透传')
	// 这格钉的是「空串不许静默变成进程 cwd」：expandHome 对空串原样透传，而 resolve('') 返回
	// cwd——归一链路一旦漏掉兜底，记忆根就悄悄变成当前工作目录，读写当场分家且不报错
	assert.notEqual(resolveRoot('').root, process.cwd(), '空串必须取默认根而不是进程 cwd')
})

test('readCapped：文件不存在返回 missing（常态，非错误）', () => {
	assert.deepEqual(readCapped(join(base, 'no-such-file.md')), { status: 'missing' })
})

test('readCapped：小文件 ok 且不截断', () => {
	const p = join(base, 'small.md')
	writeFileSync(p, '内容很短', 'utf8')
	const r = readCapped(p)
	assert.equal(r.status, 'ok')
	assert.equal(r.truncated, false)
	assert.equal(r.origChars, '内容很短'.length)
	assert.equal(r.text, '内容很短')
})

test('readCapped：超失控保护时头部截断并显式标注', () => {
	const p = join(base, 'huge.md')
	writeFileSync(p, 'x'.repeat(RUNAWAY_CEILING + 5000), 'utf8')
	const r = readCapped(p)
	assert.equal(r.status, 'ok')
	assert.equal(r.truncated, true)
	assert.equal(r.origChars, RUNAWAY_CEILING + 5000)
	assert.ok(r.text.includes(`仅注入前 ${RUNAWAY_CEILING} 字符`), '截断标注必须显式在场')
	assert.ok(r.text.length > RUNAWAY_CEILING && r.text.length < RUNAWAY_CEILING + 200, '只多出标注行')
})

test('readCapped：文件在但读失败返回 read-error（目录当文件喂入＝EISDIR 确定性触发）', () => {
	const dir = join(base, 'a-directory')
	mkdirSync(dir)
	const r = readCapped(dir)
	assert.equal(r.status, 'read-error')
	assert.ok(typeof r.message === 'string' && r.message.length > 0)
})

test('composeMemory：空树返回空串（不注入）', () => {
	assert.equal(composeMemory({ memoryRoot: join(base, 'empty-tree'), cwd: '/home/nvse/code' }), '')
})

test('composeMemory：三层齐备时单串含头＋规则＋习惯层＋工作层，块序正确', () => {
	const { root, profile } = fixture('compose-full')
	const bucket = join(root, 'workspaces', 'home-nvse-code')
	mkdirSync(bucket, { recursive: true })
	writeFileSync(join(profile, 'WRITING.md'), '写侧纪律正文', 'utf8')
	writeFileSync(join(profile, 'a-topic.md'), entry('习惯条目', '触发词／召回词'), 'utf8')
	writeFileSync(join(bucket, 'b-topic.md'), entry('工作条目', '另一组触发词'), 'utf8')

	const text = composeMemory({ memoryRoot: root, cwd: '/home/nvse/code' })
	const headerAt = text.indexOf('[记忆索引]')
	const rulesAt = text.indexOf('## 记忆书写（写侧纪律）')
	const profileAt = text.indexOf('## 习惯层（跨机同步）')
	const workspaceAt = text.indexOf('## 工作层（本工作区·本机专属）')
	assert.ok(headerAt !== -1 && rulesAt !== -1 && profileAt !== -1 && workspaceAt !== -1)
	assert.ok(headerAt < rulesAt && rulesAt < profileAt && profileAt < workspaceAt, '块序：头→规则→习惯→工作')
	assert.ok(text.includes('写侧纪律正文'))
	assert.ok(text.includes(`基目录：${profile}`) && text.includes(`基目录：${bucket}`))
	assert.ok(text.includes('- [习惯条目](a-topic.md) — 触发词／召回词'), '索引行由 frontmatter 派生')
	assert.ok(text.includes('- [工作条目](b-topic.md) — 另一组触发词'))
})

test('composeMemory：cwd 对应桶不存在时无工作层块、其余照常', () => {
	const { root, profile } = fixture('compose-no-bucket')
	writeFileSync(join(profile, 'WRITING.md'), '写侧纪律正文', 'utf8')
	writeFileSync(join(profile, 'a-topic.md'), entry('习惯条目', '触发词'), 'utf8')
	const text = composeMemory({ memoryRoot: root, cwd: '/home/nvse/other' })
	assert.ok(text.includes('## 习惯层（跨机同步）'))
	assert.ok(!text.includes('## 工作层'))
})

test('composeMemory：cwd 缺失（全局预览装配）时无工作层块、其余照常', () => {
	const { root, profile } = fixture('compose-no-cwd')
	writeFileSync(join(profile, 'a-topic.md'), entry('习惯条目', '触发词'), 'utf8')
	const text = composeMemory({ memoryRoot: root })
	assert.ok(text.includes('## 习惯层（跨机同步）'))
	assert.ok(!text.includes('## 工作层'))
})

test('composeMemory：slug 归化为空的 cwd 时无工作层块', () => {
	const { root, profile } = fixture('compose-empty-slug')
	writeFileSync(join(profile, 'a-topic.md'), entry('习惯条目', '触发词'), 'utf8')
	const text = composeMemory({ memoryRoot: root, cwd: '///' })
	assert.ok(!text.includes('## 工作层'))
})

test('composeMemory：缺 WRITING.md 时规则块省略、习惯层照常（互不牵连）', () => {
	const { root, profile } = fixture('compose-no-writing')
	writeFileSync(join(profile, 'a-topic.md'), entry('习惯条目', '触发词'), 'utf8')
	const text = composeMemory({ memoryRoot: root, cwd: '/home/nvse/code' })
	assert.ok(!text.includes('记忆书写'))
	assert.ok(text.includes('- [习惯条目](a-topic.md) — 触发词'))
})

test('composeMemory：桶存在但无条目 → 无工作层块（索引是派生的，空桶即空层）', () => {
	const { root } = fixture('compose-empty-bucket')
	mkdirSync(join(root, 'workspaces', 'home-nvse-bare'), { recursive: true })
	const issues = []
	const text = composeMemory({ memoryRoot: root, cwd: '/home/nvse/bare', onIssue: (kind) => issues.push(kind) })
	assert.ok(!text.includes('home-nvse-bare'))
	assert.deepEqual(issues, [], '空桶是常态不是病灶，不该报 issue')
})

test('composeMemory：条目名被目录占用 → onIssue 报 read-error、好条目照常', () => {
	// x.md 名字的目录：readdir 列出它、stat 判出非普通文件——确定性病态输入
	const { root, profile } = fixture('compose-read-error')
	writeFileSync(join(profile, 'good.md'), entry('好条目', '触发词'), 'utf8')
	mkdirSync(join(profile, 'x.md'))
	const issues = []
	const text = composeMemory({ memoryRoot: root, cwd: '/home/nvse/code', onIssue: (kind, path, detail) => issues.push([kind, path, detail]) })
	const readErrors = issues.filter(([kind]) => kind === 'read-error')
	assert.equal(readErrors.length, 1)
	assert.ok(readErrors[0][1].endsWith('x.md'))
	assert.ok(readErrors[0][2].length > 0, 'detail 携带错误信息')
	assert.ok(text.includes('- [好条目](good.md) — 触发词'), '邻近病态条目不得牵连好条目')
})

test('composeMemory：onIssue 缺省时不抛（旁路诊断可选），真有 issue 的语料照样装配', () => {
	const { root, profile } = fixture('compose-no-onissue')
	// 语料要真的造出会报 issue 的东西：根不存在时全程零 issue，「不抛」证明不了缺省兜底，
	// 倒地把兜底删掉（report 回落成 undefined）这条照样绿
	writeFileSync(join(profile, 'bare.md'), '# 光有标题\n\n没有 frontmatter\n', 'utf8')
	writeFileSync(join(profile, 'good.md'), entry('好条目', '触发词'), 'utf8')
	let text = ''
	assert.doesNotThrow(() => {
		text = composeMemory({ memoryRoot: root, cwd: '/home/nvse/code' })
	}, 'onIssue 缺省时 issue 无处可去，丢弃即可，不许抛')
	// 那条 issue 的归属没变：不合规条目照样被省略、邻近好条目照样进索引
	assert.ok(!text.includes('bare.md'), '缺 frontmatter 的条目不进索引')
	assert.ok(text.includes('- [好条目](good.md) — 触发词'), '无消费者的 issue 不得牵连好条目')
})

test('composeMemory：memoryRoot 支持 ~ 展开（真造目录，不靠「不存在的根返回空串」蒙过去）', () => {
	// 目录造在 homedir 下：~ 展开与普通绝对路径处理在此同形，只有真有一个目录在场，
	// 断言才证明得了「根被展开到了 homedir」，而不是「这个根不存在，于是返回空串」
	const absolute = join(homedir(), `.dsh-memory-tilde-test-${process.pid}`)
	const asTilde = `~/${basename(absolute)}`
	try {
		mkdirSync(join(absolute, 'profile'), { recursive: true })
		writeFileSync(join(absolute, 'profile', 'topic.md'), entry('展开条目', '触发词'), 'utf8')
		// 归一的三个产物路径同源：~ 展开后拼出来的 profile/workspaces 都在那棵真实的树下
		assert.deepEqual(resolveRoot(asTilde), {
			root: absolute,
			profile: join(absolute, 'profile'),
			workspaces: join(absolute, 'workspaces'),
		}, '~ 要展开到 homedir，且三个产物路径同源')
		const text = composeMemory({ memoryRoot: asTilde })
		assert.ok(text.includes(`基目录：${join(absolute, 'profile')}`), '注入块里的层目录须是展开后的绝对路径')
		assert.ok(text.includes('- [展开条目](topic.md) — 触发词'), '展开后的根真的读出了条目（不展开就落在 cwd 下，读不到）')
	} finally {
		rmSync(absolute, { recursive: true, force: true })
	}
})

test('composeMemory：条目头跨一个分块边界且边界劈开三字节汉字，派生行仍逐字正确', () => {
	const { root, profile } = fixture('compose-head-chunk')
	// 围栏要落在第二块里（头长到块边界开外），并把一个三字节汉字压在块边界上：前段用 ASCII
	// 铺到边界前 2 字节，那之后第一个字符就是那个字，占 [边界-2, 边界+1) 号字节。偏移从
	// HEAD_CHUNK_BYTES 算而不是写死——写死的话块大小一改夹具整个落进同一块，用例照样绿
	const cut = HEAD_CHUNK_BYTES
	const prefix = '---\ntitle: 长条目\ndescription: '
	const description = `${'x'.repeat(cut - 2 - Buffer.byteLength(prefix, 'utf8'))}${'汉'.repeat(64)}`
	writeFileSync(join(profile, 'long.md'), entry('长条目', description), 'utf8')
	const bytes = readFileSync(join(profile, 'long.md'))
	assert.deepEqual(bytes.subarray(cut - 2, cut + 1), Buffer.from('汉', 'utf8'), '夹具自证：那个字确实被块边界劈开（否则这条只是普通用例）')
	assert.ok(bytes.length > cut, '头部确实跨过第一块')
	const issues = []
	const text = composeMemory({ memoryRoot: root, onIssue: (kind, path, detail) => issues.push([kind, path, detail]) })
	// 头读若只取一块就收工，围栏在窗外，解析会判不合规并报 entry-frontmatter
	assert.deepEqual(issues, [], `跨块头读出问题会报 issue，实际 ${JSON.stringify(issues)}`)
	assert.ok(text.includes(`- [长条目](long.md) — ${description}`), '派生行须与 description 逐字相同')
	assert.ok(!text.includes('�'), '半个字不许变成替换符')
})

test('composeMemory：没传 onIssue 且纪律块读不动 → 不抛、纪律块静默缺席', () => {
	const { root, profile } = fixture('compose-writing-no-reporter')
	// 与上一条同一格支路、另一个前提：调用方压根没给上报口（胶水层不传、脚本传）。缺省兜底
	// 就守在这一格——删掉它这里就是 TypeError: report is not a function，而注入块连同索引
	// 一起当场炸掉。判据是「不抛」，不是「报出了什么」：没上报口时按定义报不出去。
	mkdirSync(join(profile, 'WRITING.md'), { recursive: true })
	writeFileSync(join(profile, 'topic.md'), entry('好条目', '触发词'), 'utf8')
	const text = composeMemory({ memoryRoot: root, cwd: '/home/nvse/code' })
	assert.ok(!text.includes('## 记忆书写'), '读不动的纪律块不进注入块')
	assert.ok(text.includes('- [好条目](topic.md) — 触发词'), '上报口缺席不得牵连索引块——这一格就是兜底存在的理由')
})

test('composeMemory：写侧纪律块读不动 → onIssue 报 read-error、纪律块缺席但不牵连索引块', () => {
	const { root, profile } = fixture('compose-writing-read-error')
	// WRITING.md 是目录：existsSync 为真、readFileSync 抛 EISDIR——纪律块读失败与条目读
	// 失败是同一个出口的另一次触发，纪律被静默丢掉比超预算更难查，故这一格必须报出来
	mkdirSync(join(profile, 'WRITING.md'), { recursive: true })
	writeFileSync(join(profile, 'topic.md'), entry('好条目', '触发词'), 'utf8')
	const issues = []
	const text = composeMemory({ memoryRoot: root, cwd: '/home/nvse/code', onIssue: (kind, path, detail) => issues.push([kind, path, detail]) })
	assert.deepEqual(issues.map(([kind, path]) => [kind, path.endsWith('WRITING.md')]), [['read-error', true]], `须报到纪律块的文件名，实际 ${JSON.stringify(issues)}`)
	assert.ok(issues[0][2].length > 0, 'detail 携带错误信息')
	assert.ok(!text.includes('## 记忆书写'), '读不动的纪律块不进注入块')
	assert.ok(text.includes('- [好条目](topic.md) — 触发词'), '纪律块读失败不得牵连索引块')
})

test('composeMemory：条目名被悬空软链占位 → statSync 抛错走 read-error（与同名目录那格分开）', () => {
	const { root, profile } = fixture('compose-stat-error')
	writeFileSync(join(profile, 'good.md'), entry('好条目', '触发词'), 'utf8')
	// 悬空软链：readdir 列出它，statSync 跟随到不存在的目标抛 ENOENT。这与「同名目录占位」
	// 同为 read-error，却走的是另一条支路（statSync 抛错 vs 判出非普通文件），分开钉
	symlinkSync(join(profile, 'gone.md'), join(profile, 'x.md'))
	const issues = []
	const text = composeMemory({ memoryRoot: root, cwd: '/home/nvse/code', onIssue: (kind, path, detail) => issues.push([kind, path, detail]) })
	assert.deepEqual(issues.map(([kind]) => kind), ['read-error'], `只有一个 issue，实际 ${JSON.stringify(issues)}`)
	assert.ok(issues[0][1].endsWith('x.md'))
	assert.match(issues[0][2], /ENOENT/, 'detail 是 statSync 的原样错误，不是「非普通文件」那句固定文案（两支路别混成一条）')
	assert.ok(!text.includes('x.md'), '读不动的条目不进索引')
	assert.ok(text.includes('- [好条目](good.md) — 触发词'), '邻近病态条目不得牵连好条目')
})

test('composeMemory：条目缺 frontmatter → onIssue 报 entry-frontmatter、该条目不进索引', () => {
	const { root, profile } = fixture('compose-bad-fm')
	writeFileSync(join(profile, 'good.md'), entry('好条目', '触发词'), 'utf8')
	writeFileSync(join(profile, 'bare.md'), '# 光有标题\n\n没有 frontmatter\n', 'utf8')
	writeFileSync(join(profile, 'extra.md'), '---\nname: extra\ntitle: 多余键\ndescription: 触发词\n---\n\n正文\n', 'utf8')
	const issues = []
	const text = composeMemory({ memoryRoot: root, cwd: '/home/nvse/code', onIssue: (kind, path, detail) => issues.push([kind, path, detail]) })
	const frontmatterIssues = issues.filter(([kind]) => kind === 'entry-frontmatter')
	assert.equal(frontmatterIssues.length, 2, '缺 frontmatter 与多余键都要报到文件名')
	assert.ok(frontmatterIssues.some(([, path, detail]) => path.endsWith('extra.md') && detail.includes('多余键')))
	assert.ok(text.includes('- [好条目](good.md) — 触发词'))
	assert.ok(!text.includes('bare.md') && !text.includes('extra.md'), '不合规条目不占索引行')
})

test('composeMemory：改 frontmatter 后下一次装配就是新行（读侧无跨调用缓存，同长度改写也立刻可见）', () => {
	const { root, profile } = fixture('compose-refresh')
	const path = join(profile, 'refreshed.md')
	writeFileSync(path, entry('旧标题', '旧触发词'), 'utf8')
	assert.ok(composeMemory({ memoryRoot: root }).includes('- [旧标题](refreshed.md) — 旧触发词'))
	// 同长度改写：任何以「键含 size」的缓存都会漏掉这种改动，读侧不做缓存就没有这个面
	writeFileSync(path, entry('新标题', '新触发词'), 'utf8')
	assert.ok(composeMemory({ memoryRoot: root }).includes('- [新标题](refreshed.md) — 新触发词'), '改过 frontmatter 必须重扫')
	assert.ok(!composeMemory({ memoryRoot: root }).includes('旧标题'), '旧派生行不得残留')
})

test('composeMemory：CRLF 条目照样派生（家机 git checkout 的换行不得让围栏判空）', () => {
	const { root, profile } = fixture('compose-crlf')
	writeFileSync(join(profile, 'crlf.md'), entry('窗口条目', '触发词／召回').replace(/\n/g, '\r\n'), 'utf8')
	const text = composeMemory({ memoryRoot: root })
	assert.ok(text.includes('- [窗口条目](crlf.md) — 触发词／召回'), 'CRLF 下 frontmatter 围栏必须仍判为闭合')
})

test('composeMemory：条目被删后索引行随之退场（readdir 不再列它）', () => {
	const { root, profile } = fixture('compose-deleted')
	writeFileSync(join(profile, 'stay.md'), entry('留下', '触发词'), 'utf8')
	writeFileSync(join(profile, 'gone.md'), entry('删掉', '触发词'), 'utf8')
	assert.ok(composeMemory({ memoryRoot: root }).includes('- [删掉](gone.md)'))
	rmSync(join(profile, 'gone.md'))
	const text = composeMemory({ memoryRoot: root })
	assert.ok(!text.includes('gone.md'), '删掉的条目不得继续出现在索引里')
	assert.ok(text.includes('- [留下](stay.md) — 触发词'))
})

test('composeMemory：索引行按文件名排序（readdir 顺序不作数，逐次装配须可比）', () => {
	const { root, profile } = fixture('compose-order')
	for (const name of ['zebra.md', 'alpha.md', 'middle.md']) writeFileSync(join(profile, name), entry(name.slice(0, 5), '触发词'), 'utf8')
	const order = [...composeMemory({ memoryRoot: root }).matchAll(/^- \[[^\]]+\]\(([^)]+)\)/gm)].map((m) => m[1])
	assert.deepEqual(order, ['alpha.md', 'middle.md', 'zebra.md'])
})

test('composeMemory：残留的 MEMORY.md 不进索引（它不是条目，也不是保留名的理由之外的东西）', () => {
	const { root, profile } = fixture('compose-legacy-index')
	writeFileSync(join(profile, 'MEMORY.md'), '# 老索引\n- [手写](x.md) — 旧行\n', 'utf8')
	writeFileSync(join(profile, 'real.md'), entry('真条目', '触发词'), 'utf8')
	const text = composeMemory({ memoryRoot: root })
	assert.ok(text.includes('- [真条目](real.md) — 触发词'))
	assert.ok(!text.includes('手写'), 'MEMORY.md 的内容一律不读')
})

test('composeMemory：层内只有保留文件时该层安静省略（不注入 header-only 噪声块）', () => {
	const { root, profile } = fixture('compose-only-reserved')
	mkdirSync(join(root, 'workspaces', 'home-nvse-empty'), { recursive: true })
	writeFileSync(join(profile, 'WRITING.md'), '写侧纪律正文', 'utf8')
	writeFileSync(join(profile, 'MEMORY.md'), '# 习惯层索引（使用习惯，跨机同步）\n', 'utf8')
	const text = composeMemory({ memoryRoot: root, cwd: '/home/nvse/empty' })
	assert.ok(text.includes('写侧纪律正文'), '规则块照常')
	assert.ok(!text.includes('## 习惯层（跨机同步）'), '无条目的习惯层省略')
	assert.ok(!text.includes('## 工作层'), '无条目的工作层省略')
})

/* ===================== 索引预算 ===================== */

test('applyIndexBudget：预算内原样返回', () => {
	const r = applyIndexBudget('- [a](a.md) — **x**')
	assert.equal(r.truncated, false)
	assert.equal(r.text, '- [a](a.md) — **x**')
	assert.equal(r.origLines, 1)
})

test('applyIndexBudget：超行预算截断并显式标注', () => {
	const text = Array.from({ length: INDEX_LINE_BUDGET + 5 }, (_, i) => `line-${i}`).join('\n')
	const r = applyIndexBudget(text)
	assert.equal(r.truncated, true)
	assert.ok(r.text.includes(`原文 ${INDEX_LINE_BUDGET + 5} 行`))
	assert.ok(r.text.includes(`仅注入前 ${INDEX_LINE_BUDGET} 行`))
	assert.ok(!r.text.includes(`line-${INDEX_LINE_BUDGET}`), '截断后不含超预算的第一行')
})

/** 去掉成对的代理项后仍有残留码元＝注入串里有游离代理对（半个 emoji）。 */
const 有游离代理对 = (text) => /[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))

/** 注入串＝正文段（行尾 … 已在其中）＋块尾截断标注。 */
const 注入正文段 = (text) => text.replace(/\n\n…（索引超预算截断[\s\S]*\n$/, '')

test('applyIndexBudget：行数达标但超字符预算走字符截断', () => {
	// 行数取满预算内、每行长度使总量越字符预算：行/字符两条分支必须各自可达，
	// 只测其中一条会让另一条退化成永远不走的死分支
	const perLine = Math.ceil(INDEX_CHAR_BUDGET / INDEX_LINE_BUDGET) + 20
	const text = Array.from({ length: INDEX_LINE_BUDGET }, () => '字'.repeat(perLine)).join('\n')
	const r = applyIndexBudget(text)
	assert.equal(r.truncated, true)
	assert.ok(r.text.includes('仅注入前'))
	// 切点回退到行边界：注入段只由原文整行拼成、末行带 …，块尾另附一条标注。
	// 断言的是「不切在行中间」这条契约本身，不拿截断后总长与预算比大小——那个数字
	// 取决于标注文案长度，超没超预算跟注入内容对不对无关
	const injected = 注入正文段(r.text)
	assert.ok(injected.endsWith('…'), '行尾留 … 标出切点')
	const 原文行 = new Set(text.split('\n'))
	assert.ok(injected.replace(/…$/, '').split('\n').every((line) => 原文行.has(line)), '注入段每一行都是原文整行，无半行碎片')
	assert.equal(有游离代理对(r.text), false)
})

test('applyIndexBudget：4999 字符＋emoji 尾巴的语料按行回退（不产半个 emoji，也不产无标注半行）', () => {
	const 行长 = 125
	const 行 = '字'.repeat(行长)
	const 末行 = '字'.repeat(4999 - 39 * (行长 + 1))
	const text = `${Array.from({ length: 39 }, () => 行).join('\n')}\n${末行}😀`
	assert.equal(text.length, 5001, '语料＝4999 字符＋一个 emoji，恰超字符预算且不超行预算')
	const r = applyIndexBudget(text)
	assert.equal(r.truncated, true)
	assert.equal(r.origLines, INDEX_LINE_BUDGET, '行数未超预算，走的确实是字符分支')
	const injected = 注入正文段(r.text)
	assert.equal(injected, `${Array.from({ length: 39 }, () => 行).join('\n')}…`, '切点回退到预算内最后一个换行，末行整行不带进注入')
	assert.equal(有游离代理对(r.text), false, '注入串里不许出现半个 emoji')
})

test('applyIndexBudget：单行就超字符预算时按预算切，高代理项摘掉而不是留半个 emoji', () => {
	const text = `${'字'.repeat(4999)}😀`
	const r = applyIndexBudget(text)
	assert.equal(r.truncated, true)
	// 无换行可回退的边界：不因「切不成整行」就丢掉整条索引（连标题都没了，而标题正是
	// 召回入口），只把落在高代理项上的那个码元摘掉
	assert.equal(注入正文段(r.text), `${'字'.repeat(4999)}…`)
	assert.equal(有游离代理对(r.text), false)
	assert.ok(r.text.includes('仅注入前 4999 字符'), '标注报的是实际注入的原文长度（不含 …）')
})

test('applyIndexBudget：恰满行数＋尾换行不误报（生成器产物形态）', () => {
	const text = `${Array.from({ length: INDEX_LINE_BUDGET }, (_, i) => `- [e${i}](e${i}.md) — x`).join('\n')}\n`
	const r = applyIndexBudget(text)
	assert.equal(r.truncated, false)
	assert.equal(r.origLines, INDEX_LINE_BUDGET)
})

test('composeMemory：派生索引超预算时注入块带截断标注（预算走索引不走失控保护）', () => {
	const { root, profile } = fixture('compose-budget')
	// 文件名补零：注入块按名字排序（字符串序），不补零则 e10 排在 e2 前面，截断点不可预期
	for (let i = 0; i < INDEX_LINE_BUDGET + 10; i += 1) {
		writeFileSync(join(profile, `e${String(i).padStart(3, '0')}.md`), entry(`条目${i}`, '触发词'), 'utf8')
	}
	const text = composeMemory({ memoryRoot: root, cwd: '/home/nvse/none' })
	assert.ok(text.includes('索引超预算截断'))
	assert.ok(!text.includes(`[条目${INDEX_LINE_BUDGET}]`), '超预算的第一条不注入')
	assert.ok(text.includes(`[条目${INDEX_LINE_BUDGET - 1}]`), '预算内的最后一条照常注入')
	assert.ok(existsSync(join(profile, `e${String(INDEX_LINE_BUDGET + 9).padStart(3, '0')}.md`)), '预算只作用于注入串，不动磁盘')
})
