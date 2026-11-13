/**
 * dsh-memory 读侧单测（node:test，零宿主依赖）：记忆根路由、读取状态、索引预算、
 * 扫段派生索引、注入块组装。
 * 夹具在临时目录搭建，测后清理。
 * 每个用例独占一个根目录——避免目录内容互相牵连。
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { BLOCK_CHAR_BUDGET, INDEX_CHAR_BUDGET, INDEX_LINE_BUDGET, applyIndexBudget } from '../lib/memory/core.js'
import { DEFAULT_MEMORY_ROOT, resolveRoot } from '../lib/memory-root.js'
import { HEAD_CHUNK_BYTES, composeMemory, readEntryHead, scanSegment } from '../lib/memory/assemble.js'
import { FRONTMATTER_HEAD_MAX_BYTES } from '../lib/memory/frontmatter.js'
import { isEntryName } from '../lib/memory/naming.js'
import { readOptions } from '../scripts/checks.mjs'
import { entry, memoryTree, tempRoot } from './helpers.js'

let base
let memoryRoot

before((t) => {
	base = tempRoot(t, 'memory-core')
	memoryRoot = join(base, 'memory')
})

/** 独立根目录：建 store 顶层（共享段）与 machines/<id>/（本机段）；返回根与两个目录。造法在 helpers.memoryTree（三处同款）。 */
const fixture = (name, machine = 'home') => memoryTree(base, name, machine)

test('resolveRoot：缺省兜底与绝对化一步做完，对已绝对化的入参幂等（注册期归一过再传进来不变形）', () => {
	assert.deepEqual(resolveRoot(DEFAULT_MEMORY_ROOT), { root: join(homedir(), '.dsh', 'memory'), store: join(homedir(), '.dsh', 'memory', 'memory') }, '默认根的 ~ 要展开')
	// 兜底收在这一步：空值与非字符串一律按没给算，调用方不再各自拼回退形态
	for (const blank of [undefined, null, '', '   ', 42]) {
		assert.deepEqual(resolveRoot(blank), resolveRoot(DEFAULT_MEMORY_ROOT), `${JSON.stringify(blank)} 应当作没给`)
	}
	// 相对根必须解析成绝对路径：读侧与写侧的基目录不同，不归一就是两套语义
	const relative = resolveRoot('./memory')
	assert.deepEqual(relative, resolveRoot(resolve('./memory')), '相对根按 cwd 解析')
	assert.ok(isAbsolute(relative.store), '子位置得是绝对路径')
	// 幂等是「一次归一」这句话成立的前提：已归一过的值再传进来结果不变，故注册期归一过
	// 的根、以及 resolveRoot 自己的产物，都不会二次变形
	assert.deepEqual(resolveRoot(resolveRoot('./memory').root), resolveRoot('./memory'), '对已绝对化的入参幂等')
	const 绝对根 = resolve('abs-memory-root')
	assert.equal(resolveRoot(绝对根).root, 绝对根, '绝对根原样透传')
	// 这格钉的是「空串不许静默变成进程 cwd」：expandHome 对空串原样透传，而 resolve('') 返回
	// cwd——归一链路一旦漏掉兜底，记忆根就悄悄变成当前工作目录，读写当场分家且不报错
	assert.notEqual(resolveRoot('').root, process.cwd(), '空串必须取默认根而不是进程 cwd')
})

test('跨入口根解析同形：显式空串经脚本入参回落后与 resolveRoot 直接判空得到同一个根', () => {
	// 两条入口各自的「空串＝没给」判据各写一份时，脚本那侧回落成进程 cwd、插件那侧回落成默认根，
	// 同一个空串在两处量到两个根：离线自检印「全部达标」而实际量的是另一个根。这格钉的是可测的
	// 那一半（归一后的根同形）；宿主 schema 对空串那道校验属于运行期，待下次启动验证
	const script = readOptions(['node', 'checks', '', ''])
	assert.equal(script.rootGiven, false, '空串是「调用方写下来了但当作没给」，判据看得到这件事')
	assert.equal(script.machineGiven, false, '机器 id 同理：空串按没给算')
	assert.deepEqual(resolveRoot(script.memoryRoot), resolveRoot(''), '脚本入参回落到的根 ≡ resolveRoot 直接判空的根')
	assert.deepEqual(resolveRoot(script.memoryRoot), resolveRoot(DEFAULT_MEMORY_ROOT), '两边都落到默认根，不是进程 cwd')
})

test('scanSegment：read 缺参当场抛编程错误，不报 read-error（漏传是调用方的错，不是语料的病态）', () => {
	// 三处消费者（注入装配、体检、离线自检）都经它读段，漏传 read 的症状若走 read-error 那条
	// 旁路，表现是「整段判不出来」的静默降级——体检少报一轮、离线自检少一段，装配少一块，
	// 而没有任何一处说得出真正的原因是调用方漏了参数
	const { store } = fixture('scan-read-missing')
	assert.throws(() => scanSegment(store, {}), /read.*必填参数/, '缺 read 当场点名，不进 try/catch')
	assert.throws(() => scanSegment(store, { read: '整篇读法' }), /read.*必填参数/, 'read 传了非函数与没传同病：类型错也是编程错误，不降级')
	const empty = join(base, 'scan-read-missing-empty')
	mkdirSync(empty, { recursive: true })
	assert.throws(() => scanSegment(empty, {}), /read.*必填参数/, '空目录也不静默：列目录之前先核参数，否则空段与漏参两种情况看不出区别')
	assert.throws(() => scanSegment(store), /read.*必填参数/, '漏参最常见的裸调写法（第二参整个没给）也要拿到点名消息，不是 destructure 的原生 TypeError')
	const absent = join(base, 'scan-read-missing-absent')
	assert.throws(() => scanSegment(absent, {}), /read.*必填参数/, '目录不存在也先核参数：守卫在列目录之前——挪到后面这格会静默降级成 read-error ENOENT 返回 null')
})

test('scanSegment：有效条目与指向它的软链条目都进索引（names 与 entries 各含两条）', () => {
	// 不建机器段：本用例钉的是 names／entries 的全量与命名判据，store 顶层多一个 machines/ 目录
	// 会让 names 多一项（那是常态，不是病），干扰对条目清点的断言
	const { store } = memoryTree(base, 'scan-symlink')
	writeFileSync(join(store, 'real.md'), entry('真条目', '触发词'), 'utf8')
	symlinkSync(join(store, 'real.md'), join(store, 'link.md'))
	const scan = scanSegment(store, { read: (path) => readFileSync(path, 'utf8') })
	assert.deepEqual(scan.names, ['link.md', 'real.md'], 'names 是段内全量（含非条目名），按码元序——离线自检要拿它数条目文件')
	assert.deepEqual(scan.entries.map((one) => one.name), ['link.md', 'real.md'], '两条都进 entries：Dirent 判不出是不是普通文件时补的那次 stat 就是为软链条目兜的')
	assert.ok(scan.lines.every((line) => line.includes('- [真条目]')), '两条派生出同一行（同名 title 正是体检那项要报的撞名，两条都在场才对）')
})

test('scanSegment：read 抛错只降级那一条，邻近条目不受牵连；indexLine 为空 ⟺ 该条目解析没过', () => {
	const { store } = memoryTree(base, 'scan-read-throw')
	writeFileSync(join(store, 'a-ok.md'), entry('好条目', '触发词'), 'utf8')
	writeFileSync(join(store, 'b-bad.md'), '---\ntitle: 缺描述\n---\n', 'utf8')
	writeFileSync(join(store, 'c-throw.md'), entry('读不动的条目', '触发词'), 'utf8')
	const issues = []
	const scan = scanSegment(store, {
		read: (path) => {
			if (path.endsWith('c-throw.md')) throw new Error('读法炸了')
			return readFileSync(path, 'utf8')
		},
		report: (issue, path, detail) => issues.push([issue, path, detail]),
	})
	assert.deepEqual(scan.names, ['a-ok.md', 'b-bad.md', 'c-throw.md'], '读炸那条仍留在 names：它确实在场，只是读不动')
	assert.deepEqual(scan.entries.map((one) => one.name), ['a-ok.md', 'b-bad.md'], '读炸的那条从 entries 退场，另两条照常')
	assert.deepEqual(scan.entries.map((one) => one.indexLine === null), [false, true], 'indexLine 为空 ⟺ parsed 不过：两条不等价的判据各写一处时，坏行会以空串或半行进索引')
	assert.ok(scan.entries.every((one) => (one.indexLine === null) === !one.parsed.ok), '恒等式：indexLine 非空 ⟺ parsed.ok——两条不等价的判据各写一处时，坏行会以空串或半行进索引')
	assert.ok(issues.some(([issue, path, detail]) => issue === 'read-error' && path.endsWith('c-throw.md') && detail === '读法炸了'), 'read 抛错报 read-error，detail 原样带出抛错消息')
	assert.ok(issues.some(([issue, path]) => issue === 'entry-frontmatter' && path.endsWith('b-bad.md')), 'frontmatter 不合规报 entry-frontmatter，与读错分开')
	assert.ok(!issues.some(([, path]) => path.endsWith('a-ok.md')), '好条目不受邻近病态牵连')
})

test('注入装配的读法封顶：frontmatter 超 64KB 才闭合的条目不进注入块（体检整篇读不受此限）', () => {
	const { root, store } = fixture('compose-head-cap')
	writeFileSync(join(store, 'ok.md'), entry('正常条目', '触发词'), 'utf8')
	// 围栏本体超过 FRONTMATTER_HEAD_MAX_BYTES 才闭合（填充塞在 description 值内——frontmatter
	// 恰好两键的契约不破）：注入侧的头读（读到闭合为止、最多 64KB）会先触顶拿到截断文本；
	// 若有人把注入侧读法换成整篇读，这条会 parse 成功混进注入块，本用例翻红。
	writeFileSync(join(store, 'huge.md'), `---\ntitle: 围栏超限\ndescription: ${'x'.repeat(FRONTMATTER_HEAD_MAX_BYTES + 4096)}\n---\n正文`, 'utf8')
	const issues = []
	const block = composeMemory({ memoryRoot: root, machine: 'home', onIssue: (issue, path) => issues.push([issue, path]) })
	assert.ok(block.includes('- [正常条目]'), '正常条目照常进注入块')
	assert.ok(!block.includes('- [围栏超限]'), '围栏超限条目不进注入块：头读封顶把它挡在外面（若注入侧读法被换成整篇读，这条会 parse 成功混进注入块，本断言翻红）')
	assert.ok(issues.some(([issue, path]) => issue === 'entry-frontmatter' && path.endsWith('huge.md')), '触顶表现为截断文本 parse 不过（围栏未闭合）报 entry-frontmatter——注入块 40 行预算不该为一条畸形 frontmatter 买单')
})

test('scanSegment：names 是 readdir 全量、entries 逐条过命名判据（非条目名进 names 不进 entries）', () => {
	const { store } = fixture('scan-names-vs-entries')
	writeFileSync(join(store, 'MEMORY.md'), '# 旧索引\n', 'utf8')
	writeFileSync(join(store, 'note.txt'), '不是条目\n', 'utf8')
	writeFileSync(join(store, 'ok.md'), entry('条目', '触发词'), 'utf8')
	mkdirSync(join(store, 'sub'), { recursive: true })
	const scan = scanSegment(store, { read: (path) => readFileSync(path, 'utf8') })
	assert.deepEqual(scan.names, readdirSync(store).sort(), 'names ≡ readdir 全量（含非条目名）：离线自检的条目清点与保留文件判定都问它这一份')
	assert.ok(scan.entries.every((one) => isEntryName(one.name)), 'entries 里逐条都是条目名：命名判据只有一处，非条目名一个都不该混进来')
	assert.deepEqual(scan.entries.map((one) => one.name), ['ok.md'], '三条非条目名各不进 entries')
})

test('scanSegment：kebab 名进 entries，非 kebab 名与「合 kebab 的保留名」都不进（读侧判据与写侧同一份）', () => {
	// Foo.md 与 foo.md 分住两个段：大小写不敏感的文件系统上同一目录里的这两条是同一个文件
	// （同目录造＝后者覆盖前者，用例会验到一条根本不存在的非 kebab 文件而绿）
	const { store, machineDir } = fixture('scan-entry-name')
	writeFileSync(join(store, 'ok.md'), entry('规范条目', '触发词'), 'utf8')
	writeFileSync(join(store, 'Foo.md'), entry('大写名条目', '触发词'), 'utf8')
	writeFileSync(join(store, 'memory.md'), entry('退役索引名条目', '触发词'), 'utf8')
	writeFileSync(join(machineDir, 'foo.md'), entry('小写条目', '触发词'), 'utf8')
	const read = (path) => readFileSync(path, 'utf8')
	assert.deepEqual(scanSegment(store, { read }).entries.map((one) => one.name), ['ok.md'], 'Foo.md 非 kebab 名不枚举；memory.md 能过 kebab 正则，靠保留名那一半拦住')
	assert.deepEqual(scanSegment(machineDir, { read }).entries.map((one) => one.name), ['foo.md'], '小写 kebab 名枚举：双条件合起来才是读侧判据')
})

test('isEntryName：规范形＝小写 kebab 且非保留名，两侧条件缺一都算不得条目', () => {
	assert.equal(isEntryName('foo.md'), true)
	assert.equal(isEntryName('topic-0.md'), true, '数字与中划线是规范形的一部分')
	assert.equal(isEntryName('Foo.md'), false, '大写名不合 kebab 形')
	assert.equal(isEntryName('Bad_Name.md'), false, '下划线不合 kebab 形')
	assert.equal(isEntryName('note.txt'), false, '不是 Markdown 文件')
	assert.equal(isEntryName(undefined), false, '非字符串一律不算')
	// 现判据放行的三格：正则只管「首字符是字母数字、其后是字母数字与中划线」，尾中划线、连续
	// 中划线、纯数字都过。要紧的是别把「收紧到更严的 kebab 定义」当成顺手改——这三格是红点
	assert.equal(isEntryName('foo-.md'), true, '尾中划线：现判据放行')
	assert.equal(isEntryName('foo--bar.md'), true, '连续中划线：现判据放行')
	assert.equal(isEntryName('123.md'), true, '纯数字：现判据放行')
	// 这一格是本判据的第二半条件：memory.md 能过 kebab 正则，只有保留名排除拦得住；
	// 少了那半，退役的索引文件会以条目身份进索引
	assert.equal(isEntryName('memory.md'), false, '扣掉保留名条件即复活退役索引名')
	assert.equal(isEntryName('MEMORY.md'), false, '保留名排除＋大写名不合 kebab 形，两半各拦一道')
})

test('composeMemory：空树返回空串（不注入）', () => {
	assert.equal(composeMemory({ memoryRoot: join(base, 'empty-tree'), machine: 'home' }), '')
})

test('composeMemory：两段齐备时单串含头＋共享段＋本机段，块序正确', () => {
	const { root, store, machineDir } = fixture('compose-full')
	writeFileSync(join(store, 'a-topic.md'), entry('共享条目', '触发词／召回词'), 'utf8')
	writeFileSync(join(machineDir, 'b-topic.md'), entry('本机条目', '另一组触发词'), 'utf8')

	const text = composeMemory({ memoryRoot: root, machine: 'home' })
	const headerAt = text.indexOf('[记忆索引]')
	const sharedAt = text.indexOf('## 共享（跨机同步）')
	const machineAt = text.indexOf('## 本机（home）')
	assert.ok(headerAt !== -1 && sharedAt !== -1 && machineAt !== -1)
	assert.ok(headerAt < sharedAt && sharedAt < machineAt, '块序：头→共享→本机')
	assert.ok(text.includes(`基目录：${store}`) && text.includes(`基目录：${machineDir}`))
	assert.ok(text.includes('- [共享条目](a-topic.md) — 触发词／召回词'), '索引行由 frontmatter 派生')
	assert.ok(text.includes('- [本机条目](b-topic.md) — 另一组触发词'))
})

test('composeMemory：机器身份未配置时无本机段块、共享段照常（共享段不依赖本机身份）', () => {
	const { root, store } = memoryTree(base, 'compose-no-machine')
	writeFileSync(join(store, 'a-topic.md'), entry('共享条目', '触发词'), 'utf8')
	const issues = []
	const text = composeMemory({ memoryRoot: root, onIssue: (kind) => issues.push(kind) })
	assert.ok(text.includes('## 共享（跨机同步）'))
	assert.ok(!text.includes('## 本机'), '未配机器身份＝整段不装（不是空段）')
	assert.deepEqual(issues, [], '未配身份是配置态不是病灶，注入侧不报 issue（判红归 lint 与离线自检）')
})

test('composeMemory：配了机器身份而本机段目录尚无条目 → 无本机段块、共享段照常', () => {
	const { root, store } = memoryTree(base, 'compose-machine-absent')
	writeFileSync(join(store, 'a-topic.md'), entry('共享条目', '触发词'), 'utf8')
	const issues = []
	const text = composeMemory({ memoryRoot: root, machine: 'home', onIssue: (kind) => issues.push(kind) })
	assert.ok(text.includes('## 共享（跨机同步）'))
	assert.ok(!text.includes('## 本机'), '本机目录尚无条目（或还没建）＝该段安静省略，不注入 header-only 噪声块')
	assert.deepEqual(issues, [], '空段是常态不是病灶，不该报 issue')
})

test('composeMemory：本机段目录建了但一条条目也没有 → 该段同样安静省略', () => {
	const { root, store } = fixture('compose-machine-empty')
	writeFileSync(join(store, 'a-topic.md'), entry('共享条目', '触发词'), 'utf8')
	const text = composeMemory({ memoryRoot: root, machine: 'home' })
	assert.ok(text.includes('## 共享（跨机同步）'))
	assert.ok(!text.includes('## 本机'), '索引是派生的：空目录即空段')
})

test('composeMemory：非本机段有条目时只出尾行不装索引（对机条目要看得见、但不占本机预算）', () => {
	const { root, store } = memoryTree(base, 'compose-other-machine')
	writeFileSync(join(store, 'a-topic.md'), entry('共享条目', '触发词'), 'utf8')
	mkdirSync(join(store, 'machines', 'office'), { recursive: true })
	writeFileSync(join(store, 'machines', 'office', 'peer-a.md'), entry('对机条目甲', '触发词'), 'utf8')
	writeFileSync(join(store, 'machines', 'office', 'peer-b.md'), entry('对机条目乙', '触发词'), 'utf8')
	const text = composeMemory({ memoryRoot: root, machine: 'home' })
	assert.ok(!text.includes('对机条目'), '别的机器的条目正文/索引行不进本机上下文')
	assert.ok(text.includes('另：machines/office 2 条未注入，可直接读文件'), '尾行报相对路径与条数——对机照这个形态直接读文件或走全形式 file_path')
	// 空的对机段零信息量，不报（首跑时新建的 machines/<id>/ 就是这样）
	mkdirSync(join(store, 'machines', 'laptop'), { recursive: true })
	const 再装 = composeMemory({ memoryRoot: root, machine: 'home' })
	assert.ok(!再装.includes('machines/laptop'), '空段不占尾行——每台机器都建了目录时尾行会变成一串零')
})

test('composeMemory：输出不含任何规则块（写侧纪律已并入 AGENTS.md，注入块只装索引）', () => {
	const { root, store } = fixture('compose-no-rules')
	writeFileSync(join(store, 'a-topic.md'), entry('共享条目', '触发词'), 'utf8')
	// 夹具里真的铺一份旧写侧文件：断言「不含规则块」由此获得判别力——若组装回植了规则块，
	// 这份文件的标题字样必然漏进输出，用例当场红；盘上没有这份文件时该断言只是恒真
	writeFileSync(join(store, 'WRITING.md'), '# 记忆书写（写侧纪律）\n写侧纪律正文', 'utf8')
	const text = composeMemory({ memoryRoot: root, machine: 'home' })
	assert.ok(!text.includes('记忆书写'), '规则块的节标题不得出现')
	assert.ok(!text.includes('写侧纪律'), '写侧纪律不再随索引注入')
	assert.ok(text.includes('- [共享条目](a-topic.md) — 触发词'), '索引段照常')
})

test('composeMemory：条目名被目录占用 → onIssue 报 read-error、好条目照常', () => {
	// x.md 名字的目录：readdir 列出它、stat 判出非普通文件——确定性病态输入
	const { root, store } = fixture('compose-read-error')
	writeFileSync(join(store, 'good.md'), entry('好条目', '触发词'), 'utf8')
	mkdirSync(join(store, 'x.md'))
	const issues = []
	const text = composeMemory({ memoryRoot: root, machine: 'home', onIssue: (kind, path, detail) => issues.push([kind, path, detail]) })
	const readErrors = issues.filter(([kind]) => kind === 'read-error')
	assert.equal(readErrors.length, 1)
	assert.ok(readErrors[0][1].endsWith('x.md'))
	assert.ok(readErrors[0][2].length > 0, 'detail 携带错误信息')
	assert.ok(text.includes('- [好条目](good.md) — 触发词'), '邻近病态条目不得牵连好条目')
})

test('composeMemory：onIssue 缺省时不抛（旁路诊断可选），真有 issue 的语料照样装配', () => {
	const { root, store } = fixture('compose-no-onissue')
	// 语料要真的造出会报 issue 的东西：根不存在时全程零 issue，「不抛」证明不了缺省兜底，
	// 倒地把兜底删掉（report 回落成 undefined）这条照样绿
	writeFileSync(join(store, 'bare.md'), '# 光有标题\n\n没有 frontmatter\n', 'utf8')
	writeFileSync(join(store, 'good.md'), entry('好条目', '触发词'), 'utf8')
	let text = ''
	assert.doesNotThrow(() => {
		text = composeMemory({ memoryRoot: root, machine: 'home' })
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
		mkdirSync(join(absolute, 'memory'), { recursive: true })
		writeFileSync(join(absolute, 'memory', 'topic.md'), entry('展开条目', '触发词'), 'utf8')
		// 归一的产物路径同源：~ 展开后拼出来的 store 就在那棵真实的树下
		assert.deepEqual(resolveRoot(asTilde), {
			root: absolute,
			store: join(absolute, 'memory'),
		}, '~ 要展开到 homedir，且产物路径同源')
		const text = composeMemory({ memoryRoot: asTilde })
		assert.ok(text.includes(`基目录：${join(absolute, 'memory')}`), '注入块里的段目录须是展开后的绝对路径')
		assert.ok(text.includes('- [展开条目](topic.md) — 触发词'), '展开后的根真的读出了条目（不展开就落在 cwd 下，读不到）')
	} finally {
		rmSync(absolute, { recursive: true, force: true })
	}
})

test('composeMemory：条目头跨一个分块边界且边界劈开三字节汉字，派生行仍逐字正确', () => {
	const { root, store } = fixture('compose-head-chunk')
	// 围栏要落在第二块里（头长到块边界开外），并把一个三字节汉字压在块边界上：前段用 ASCII
	// 铺到边界前 2 字节，那之后第一个字符就是那个字，占 [边界-2, 边界+1) 号字节。偏移从
	// HEAD_CHUNK_BYTES 算而不是写死——写死的话块大小一改夹具整个落进同一块，用例照样绿
	const cut = HEAD_CHUNK_BYTES
	const prefix = '---\ntitle: 长条目\ndescription: '
	const description = `${'x'.repeat(cut - 2 - Buffer.byteLength(prefix, 'utf8'))}${'汉'.repeat(64)}`
	writeFileSync(join(store, 'long.md'), entry('长条目', description), 'utf8')
	const bytes = readFileSync(join(store, 'long.md'))
	assert.deepEqual(bytes.subarray(cut - 2, cut + 1), Buffer.from('汉', 'utf8'), '夹具自证：那个字确实被块边界劈开（否则这条只是普通用例）')
	assert.ok(bytes.length > cut, '头部确实跨过第一块')
	const issues = []
	const text = composeMemory({ memoryRoot: root, machine: 'home', onIssue: (kind, path, detail) => issues.push([kind, path, detail]) })
	// 头读若只取一块就收工，围栏在窗外，解析会判不合规并报 entry-frontmatter
	assert.deepEqual(issues, [], `跨块头读出问题会报 issue，实际 ${JSON.stringify(issues)}`)
	assert.ok(text.includes(`- [长条目](long.md) — ${description}`), '派生行须与 description 逐字相同')
	assert.ok(!text.includes('�'), '半个字不许变成替换符')
})

test('composeMemory：条目名被悬空软链占位 → statSync 抛错走 read-error（与同名目录那格分开）', () => {
	const { root, store } = fixture('compose-stat-error')
	writeFileSync(join(store, 'good.md'), entry('好条目', '触发词'), 'utf8')
	// 悬空软链：readdir 列出它，statSync 跟随到不存在的目标抛 ENOENT。这与「同名目录占位」
	// 同为 read-error，却走的是另一条支路（statSync 抛错 vs 判出非普通文件），分开钉
	symlinkSync(join(store, 'gone.md'), join(store, 'x.md'))
	const issues = []
	const text = composeMemory({ memoryRoot: root, machine: 'home', onIssue: (kind, path, detail) => issues.push([kind, path, detail]) })
	assert.deepEqual(issues.map(([kind]) => kind), ['read-error'], `只有一个 issue，实际 ${JSON.stringify(issues)}`)
	assert.ok(issues[0][1].endsWith('x.md'))
	assert.match(issues[0][2], /ENOENT/, 'detail 是 statSync 的原样错误，不是「非普通文件」那句固定文案（两支路别混成一条）')
	assert.ok(!text.includes('x.md'), '读不动的条目不进索引')
	assert.ok(text.includes('- [好条目](good.md) — 触发词'), '邻近病态条目不得牵连好条目')
})

test('composeMemory：条目缺 frontmatter → onIssue 报 entry-frontmatter、该条目不进索引', () => {
	const { root, store } = fixture('compose-bad-fm')
	writeFileSync(join(store, 'good.md'), entry('好条目', '触发词'), 'utf8')
	writeFileSync(join(store, 'bare.md'), '# 光有标题\n\n没有 frontmatter\n', 'utf8')
	writeFileSync(join(store, 'extra.md'), '---\nname: extra\ntitle: 多余键\ndescription: 触发词\n---\n\n正文\n', 'utf8')
	const issues = []
	const text = composeMemory({ memoryRoot: root, machine: 'home', onIssue: (kind, path, detail) => issues.push([kind, path, detail]) })
	const frontmatterIssues = issues.filter(([kind]) => kind === 'entry-frontmatter')
	assert.equal(frontmatterIssues.length, 2, '缺 frontmatter 与多余键都要报到文件名')
	assert.ok(frontmatterIssues.some(([, path, detail]) => path.endsWith('extra.md') && detail.includes('多余键')))
	assert.ok(text.includes('- [好条目](good.md) — 触发词'))
	assert.ok(!text.includes('bare.md') && !text.includes('extra.md'), '不合规条目不占索引行')
})

test('composeMemory：段内加一条条目，下一趟即见（每趟现读现算）', () => {
	const { root, store } = fixture('compose-added')
	writeFileSync(join(store, 'first.md'), entry('原有条目', '触发词'), 'utf8')
	assert.ok(!composeMemory({ memoryRoot: root, machine: 'home' }).includes('[后来条目]'))
	writeFileSync(join(store, 'later.md'), entry('后来条目', '触发词'), 'utf8')
	const text = composeMemory({ memoryRoot: root, machine: 'home' })
	assert.ok(text.includes('- [后来条目](later.md) — 触发词'), '新增条目后必须重扫')
	assert.ok(text.includes('- [原有条目](first.md) — 触发词'), '邻近条目不受牵连')
})

test('composeMemory：原地改写条目（只改文件内容，不动增删改名）下一趟即新', () => {
	const { root, store } = fixture('compose-rewrite-entry')
	const path = join(store, 'kept.md')
	writeFileSync(path, entry('原标题', '原触发词'), 'utf8')
	const first = composeMemory({ memoryRoot: root, machine: 'home' })
	assert.ok(first.includes('- [原标题](kept.md) — 原触发词'), '改写前旧标题旧触发词在场')
	// 原地改写：只动文件内容，不增不删不改名——记忆更新的主流形态（同主题条目并节）。
	// 早先版本在装配入口留过上一次算出的块，触发词要等下一次增删改名才换血；那扇窗已随
	// 整套留存的零件拆除，此条就是钉它的锚
	writeFileSync(path, entry('新标题', '新触发词'), 'utf8')
	const second = composeMemory({ memoryRoot: root, machine: 'home' })
	assert.ok(second.includes('- [新标题](kept.md) — 新触发词'), '原地改写下一趟即新：触发词当场换血')
	assert.ok(!second.includes('原触发词'), '旧触发词不得残留')
})

test('composeMemory：机器身份传保留字 shared 或大写即抛（机器 id 不是段值，没有 shared 这一档）', () => {
	const { root } = memoryTree(base, 'compose-shared-as-machine')
	// 放行的症状不是报错：本机段与共享段落进同一个目录，注入块里共享段出现两遍、对机段整段漏装。
	// 校验收在 composeMemory 里而不是各调用方，故离线自检脚本那条路也绕不过
	assert.throws(() => composeMemory({ memoryRoot: root, machine: 'shared' }), /未知机器 id「shared」/)
	assert.throws(() => composeMemory({ memoryRoot: root, machine: 'Home' }), /未知机器 id「Home」/)
})

test('composeMemory：换记忆根不串块（各根各读各的，不携上一根的结果）', () => {
	const left = fixture('compose-root-left')
	const right = fixture('compose-root-right')
	// 两根放同一个条目文件名、各写各的内容：串块的形态是右根拿到左根那行（把不存在的条目注进了上下文）
	for (const [one, title] of [[left, '左根条目'], [right, '右根条目']]) {
		writeFileSync(join(one.store, 'shared.md'), entry(title, '触发词'), 'utf8')
	}
	const leftText = composeMemory({ memoryRoot: left.root, machine: 'home' })
	assert.ok(leftText.includes('- [左根条目](shared.md) — 触发词'))
	const rightText = composeMemory({ memoryRoot: right.root, machine: 'home' })
	assert.ok(rightText.includes('- [右根条目](shared.md) — 触发词'), '另一个根读自己那份')
	assert.ok(!rightText.includes('左根条目'), '跨根串块＝把不存在的条目注进了上下文')
	assert.ok(composeMemory({ memoryRoot: left.root, machine: 'home' }).includes('左根条目'), '来回切换后各自仍取自己那份')
})

test('composeMemory：换机器身份不串块（各身份各装各的那一段）', () => {
	const { root, store } = memoryTree(base, 'compose-machine-identity')
	for (const [id, title] of [['home', '家机条目'], ['office', '对机条目']]) {
		const dir = join(store, 'machines', id)
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'shared.md'), entry(title, '触发词'), 'utf8')
	}
	const 家机 = composeMemory({ memoryRoot: root, machine: 'home' })
	assert.ok(家机.includes('家机条目') && !家机.includes('对机条目'), '本机段只装自己那一段（对机那张走尾行）')
	const 对机 = composeMemory({ memoryRoot: root, machine: 'office' })
	assert.ok(对机.includes('对机条目') && !对机.includes('家机条目'), '换身份装换的那一段')
	assert.ok(composeMemory({ memoryRoot: root, machine: 'home' }).includes('家机条目'), '来回切换后各自仍取自己那份')
})

test('composeMemory：machines/ 下新增条目，尾行下一趟即见', () => {
	const { root, store } = memoryTree(base, 'compose-machines-added')
	writeFileSync(join(store, 'a-topic.md'), entry('共享条目', '触发词'), 'utf8')
	// 空的对机段在首趟之前就建好：首趟尾行还不报它（空目录零信息量）
	mkdirSync(join(store, 'machines', 'office'), { recursive: true })
	const 首趟 = composeMemory({ memoryRoot: root, machine: 'home' })
	assert.ok(!首趟.includes('machines/office'), '空段不占尾行——每台机器都建了目录时尾行会变成一串零')
	// 对机段新增条目：尾行是最先看得见的那一处
	writeFileSync(join(store, 'machines', 'office', 'peer.md'), entry('对机条目', '触发词'), 'utf8')
	const 二趟 = composeMemory({ memoryRoot: root, machine: 'home' })
	assert.ok(二趟.includes('另：machines/office 1 条未注入，可直接读文件'), '对机段加条目，尾行下一趟即见')
})

test('composeMemory：CRLF 条目照样派生（家机 git checkout 的换行不得让围栏判空）', () => {
	const { root, store } = memoryTree(base, 'compose-crlf')
	writeFileSync(join(store, 'crlf.md'), entry('窗口条目', '触发词／召回').replace(/\n/g, '\r\n'), 'utf8')
	const text = composeMemory({ memoryRoot: root })
	assert.ok(text.includes('- [窗口条目](crlf.md) — 触发词／召回'), 'CRLF 下 frontmatter 围栏必须仍判为闭合')
})

test('composeMemory：条目被删后索引行随之退场（readdir 不再列它）', () => {
	const { root, store } = memoryTree(base, 'compose-deleted')
	writeFileSync(join(store, 'stay.md'), entry('留下', '触发词'), 'utf8')
	writeFileSync(join(store, 'gone.md'), entry('删掉', '触发词'), 'utf8')
	assert.ok(composeMemory({ memoryRoot: root }).includes('- [删掉](gone.md)'))
	rmSync(join(store, 'gone.md'))
	const text = composeMemory({ memoryRoot: root })
	assert.ok(!text.includes('gone.md'), '删掉的条目不得继续出现在索引里')
	assert.ok(text.includes('- [留下](stay.md) — 触发词'))
})

test('composeMemory：索引行按文件名排序（readdir 顺序不作数，逐次装配须可比）', () => {
	const { root, store } = memoryTree(base, 'compose-order')
	for (const name of ['zebra.md', 'alpha.md', 'middle.md']) writeFileSync(join(store, name), entry(name.slice(0, 5), '触发词'), 'utf8')
	const order = [...composeMemory({ memoryRoot: root }).matchAll(/^- \[[^\]]+\]\(([^)]+)\)/gm)].map((m) => m[1])
	assert.deepEqual(order, ['alpha.md', 'middle.md', 'zebra.md'])
})

test('composeMemory：残留的 MEMORY.md 不进索引（它不是条目，也不是保留名的理由之外的东西）', () => {
	const { root, store } = memoryTree(base, 'compose-legacy-index')
	writeFileSync(join(store, 'MEMORY.md'), '# 老索引\n- [手写](x.md) — 旧行\n', 'utf8')
	writeFileSync(join(store, 'real.md'), entry('真条目', '触发词'), 'utf8')
	const text = composeMemory({ memoryRoot: root })
	assert.ok(text.includes('- [真条目](real.md) — 触发词'))
	assert.ok(!text.includes('手写'), 'MEMORY.md 的内容一律不读')
})

test('composeMemory：非 kebab 名的 .md 文件零注入（Foo.md 不进索引，foo.md 照常）', () => {
	// 两条名字分住两个段：大小写不敏感的文件系统上同一目录里的 Foo.md 与 foo.md 是同一个
	// 文件，同目录造＝互相覆盖，这条用例就验不到非 kebab 那一半
	const { root, store, machineDir } = memoryTree(base, 'compose-non-kebab', 'home')
	writeFileSync(join(store, 'Foo.md'), entry('大写条目', '触发词'), 'utf8')
	writeFileSync(join(machineDir, 'foo.md'), entry('小写条目', '触发词'), 'utf8')
	const text = composeMemory({ memoryRoot: root, machine: 'home' })
	assert.ok(text.includes('- [小写条目](foo.md) — 触发词'), '规范形的条目照常进索引：收紧读侧判据不是把整段扫没了')
	assert.ok(!text.includes('大写条目') && !text.includes('Foo.md'), '非 kebab 名零注入：读侧与写侧同一份判据，不再有「读侧进得了索引、写侧拒写」的两套说法')
})

test('composeMemory：段内只有保留文件时该段安静省略（块为空，宿主滤除）', () => {
	const { root, store } = fixture('compose-only-reserved')
	writeFileSync(join(store, 'MEMORY.md'), '# 共享段索引\n', 'utf8')
	const text = composeMemory({ memoryRoot: root, machine: 'home' })
	assert.equal(text, '', '无条目的共享段省略且无规则块可装：整块为空串')
	assert.ok(!text.includes('## 共享（跨机同步）'), '无条目的共享段省略')
	assert.ok(!text.includes('## 本机'), '无条目的本机段省略')
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
	const { root, store } = memoryTree(base, 'compose-budget')
	// 文件名补零：注入块按名字排序（字符串序），不补零则 e10 排在 e2 前面，截断点不可预期
	for (let i = 0; i < INDEX_LINE_BUDGET + 10; i += 1) {
		writeFileSync(join(store, `e${String(i).padStart(3, '0')}.md`), entry(`条目${i}`, '触发词'), 'utf8')
	}
	const text = composeMemory({ memoryRoot: root })
	assert.ok(text.includes('索引超预算截断'))
	assert.ok(!text.includes(`[条目${INDEX_LINE_BUDGET}]`), '超预算的第一条不注入')
	assert.ok(text.includes(`[条目${INDEX_LINE_BUDGET - 1}]`), '预算内的最后一条照常注入')
	assert.ok(existsSync(join(store, `e${String(INDEX_LINE_BUDGET + 9).padStart(3, '0')}.md`)), '预算只作用于注入串，不动磁盘')
})

test('applyIndexBudget：报出实际装进去多少（keptLines/keptChars）——块尾那句「切在哪一重」要的就是这两个数', () => {
	const 行分支 = applyIndexBudget(Array.from({ length: INDEX_LINE_BUDGET + 7 }, (_, i) => `line-${i}`).join('\n'))
	assert.equal(行分支.keptLines, INDEX_LINE_BUDGET, '行分支：装进去的行数就是行预算')
	assert.equal(行分支.keptChars, 注入正文段(行分支.text).length, '字符分支没走时，字符数就是注入正文段的长度')
	const 每行 = Math.ceil(INDEX_CHAR_BUDGET / INDEX_LINE_BUDGET) + 20
	const 字符分支 = applyIndexBudget(Array.from({ length: INDEX_LINE_BUDGET }, () => '字'.repeat(每行)).join('\n'))
	assert.equal(字符分支.keptLines, INDEX_LINE_BUDGET, '行没超预算：装进去的行数就是原文行数')
	assert.ok(字符分支.keptChars < 字符分支.origChars, '字符分支：装进去的字符数确实少于原文')
	assert.equal(字符分支.keptChars, 注入正文段(字符分支.text).replace(/…$/, '').length, '报的字符数是原文实长（不含切点标记 …）')
})

test('composeMemory：语料长大时四条基线仍然成立（上界／恒等／前缀／单调——它们各自钉一种「越修越坏」）', () => {
	const { root, store } = memoryTree(base, 'compose-baseline')
	const 铺一层 = (从, 到) => {
		for (let i = 从; i < 到; i += 1) {
			writeFileSync(join(store, `n${String(i).padStart(3, '0')}.md`), entry(`条目${i}`, `触发词${'／'.repeat(i % 5)}${'x'.repeat(i % 23)}`), 'utf8')
		}
	}
	铺一层(0, 20)
	const 二十条 = composeMemory({ memoryRoot: root })
	assert.equal(composeMemory({ memoryRoot: root }), 二十条, '前缀（幂等那面）：语料不动，块逐字相同——派生是语料的纯函数，每趟现算逐字复现')
	铺一层(20, 30)
	const 三十条 = composeMemory({ memoryRoot: root })
	assert.ok(三十条.length > 二十条.length, '单调：加条目只增不减，块长不许倒退（倒退即某条索引行被悄悄吞了）')
	铺一层(30, 80)
	const 八十条 = composeMemory({ memoryRoot: root })
	assert.ok(八十条.length <= BLOCK_CHAR_BUDGET, `上界：块不超过整块定档（实得 ${八十条.length}）`)

	const 注入行 = 八十条.split('\n').filter((line) => line.startsWith('- ['))
	assert.ok(注入行.length <= INDEX_LINE_BUDGET, `上界：段内索引行数不超过行预算（实得 ${注入行.length}）`)
	assert.ok(注入行.join('\n').length <= INDEX_CHAR_BUDGET, '上界：段内索引字符不超过字符预算')
	// 单条派生行长度不在基线里：deriveIndexLine 不截断（行字符预算是 lint 的 warn-only 口径），
	// 在这里断言「≤160」钉住的只是本夹具的生成器——真超长行由 memory 工具 lint 报，不归注入路径管

	// 恒等与前缀各自拿独立算的一份当答案：scanSegment 是独立的另一票纯函数，它扫出的全量
	// 行序就是「注入的应当是它的前 N 行」这句话的另一半。前缀性只在行预算截断下成立（行截断只
	// 切整行）；字符预算截断的末行是回退到行边界补「…」的残行，那个形态由 cutAtLineBoundary 的用例钉
	const 全量行 = scanSegment(store, { read: readEntryHead }).lines
	assert.deepEqual(注入行, 全量行.slice(0, 注入行.length), '前缀：截断只切尾，注入的每一行都是全量的前 N 行、行序也不变')
	const 盘上 = new Set(readdirSync(store))
	for (const line of 注入行) {
		const 文件 = /\]\(([^)]+)\)/u.exec(line)[1]
		assert.ok(盘上.has(文件), `恒等：注入的每一行都对应盘上真实存在的条目——凭空多出来的一行就是「语料之外的内容进了上下文」（${文件}）`)
	}

	assert.ok(全量行.length > 注入行.length, '这一份语料确实撞上了行预算：上面那些性质是在截断状态下验的，没截断的形态另有前面几条用例')
})

test('applyIndexBudget：没超限时 keptLines/keptChars 就是原文（承重：它们不是「取预算内的那部分」）', () => {
	const 合规 = ['- [a](a.md) — x', '- [b](b.md) — y'].join('\n')
	const r = applyIndexBudget(合规)
	assert.equal(r.truncated, false)
	assert.equal(r.keptLines, r.origLines, '没超行预算时装进去的就是全部行——防的是「恒取行预算」那种写法（已由截断用例杀死）；min(行数, 预算) 与本式恒等、本就正确，不防')
	assert.equal(r.keptChars, r.origChars, '字符同理')
	assert.deepEqual(r.cuts, [], '没截断就没有 cuts')
	assert.equal(r.cutLabel, '', '没截断就没有 cutLabel：块尾那句总结靠它判「没截断就不出现」')
	assert.equal(注入正文段(r.text), 合规, '预算内原样返回')
})

test('composeMemory：字符预算那一重也报得出来（行数没撞、字符撞了 → 块尾那行说字符，不说行）', () => {
	const { root, store } = memoryTree(base, 'compose-cut-chars')
	// 35 条、每条 description 200 字符：派生行各自被单行预算压到上限，35 行在行预算内，
	// 而总字符越过字符预算 → 撞的是字符那一重。行预算那一重由上一条用例打，这里不打同一枪
	const 描述 = '描'.repeat(200)
	for (let i = 0; i < 35; i += 1) {
		writeFileSync(join(store, `c${String(i).padStart(3, '0')}.md`), entry(`条目${i}`, 描述), 'utf8')
	}
	const text = composeMemory({ memoryRoot: root })
	assert.match(text, /本次注入有 1 段索引超预算已截断：共享（跨机同步） \d+→\d+ 字符/u, '撞的是字符那一重，块尾就报字符')
	assert.doesNotMatch(text, /本次注入有[^\n]*\d+→\d+ 行/u, '行预算没撞上就别报行——把没撞上的那一重也算进去，那句话就永远说不清是哪一重')
	// 同一份语料的段内标注与块尾总结同源：都出自 applyIndexBudget 的 cuts
	assert.match(text, /仅注入前 \d+ 字符/u)
})

test('composeMemory：同一段行、字符两重都撞 → 块尾同一段名下两段都报（行在前、字符在后）', () => {
	const { root, store } = memoryTree(base, 'compose-cut-both')
	// 45 条、每条 description 180 字符：45 行越过行预算、总量 ~8K 越过字符预算——两重同撞。
	// 常态增长区正落在这里（共享段现均长 ~130，长到 40 条即两重同撞），只报一重＝把切了几重说少
	const 描述 = '述'.repeat(180)
	for (let i = 0; i < 45; i += 1) {
		writeFileSync(join(store, `b${String(i).padStart(3, '0')}.md`), entry(`双撞${i}`, 描述), 'utf8')
	}
	const text = composeMemory({ memoryRoot: root })
	assert.match(
		text,
		/本次注入有 1 段索引超预算已截断：共享（跨机同步） \d+→40 行、\d+→\d+ 字符/u,
		'两重都切就两段都报：漏掉「行」那一重（cuts 只剩字符）或只取最后一重，这句都会少说一重',
	)
	assert.match(text, /仅注入前 40 行、\d+ 字符/u, '段内标注两重同报（keptLabel 同源）')
})

test('composeMemory：逐段截断真发生 → 块尾收一句总的（几段、切在哪一重）；没截断就不出现那行', () => {
	const { root, store, machineDir } = fixture('compose-cut-note')
	for (let i = 0; i < INDEX_LINE_BUDGET + 4; i += 1) {
		writeFileSync(join(store, `h${String(i).padStart(3, '0')}.md`), entry(`共享${i}`, '触发词'), 'utf8')
		writeFileSync(join(machineDir, `w${String(i).padStart(3, '0')}.md`), entry(`本机${i}`, '触发词'), 'utf8')
	}
	const 两段都切 = composeMemory({ memoryRoot: root, machine: 'home' })
	assert.match(
		两段都切,
		/（本次注入有 2 段索引超预算已截断：共享（跨机同步） \d+→40 行、本机（home） \d+→40 行——跑 node D:\\code\\repos\\dsh-toolbox\\scripts\\check-memory-index.mjs <记忆根> <机器id> 定位收敛）\s*$/u,
		'块尾那行是本块唯一的整体结论位：报段数、报段、报切在哪一重',
	)

	// 只剩一段超、另一段非空但不超：句里只报超的那段——非空未超的段进不进这句是这段的靶心
	// （若把「没被切的段不进那句」改成无条件收录，这句会多出本机段与错误的段数）
	for (let i = 0; i < 4; i += 1) writeFileSync(join(machineDir, `w-keep${i}.md`), entry(`本机保留${i}`, '触发词'), 'utf8')
	for (let i = 0; i < INDEX_LINE_BUDGET + 4; i += 1) rmSync(join(machineDir, `w${String(i).padStart(3, '0')}.md`))
	const 只切共享 = composeMemory({ memoryRoot: root, machine: 'home' })
	assert.match(只切共享, /本次注入有 1 段索引超预算已截断：共享（跨机同步）/, '段数是逐段数出来的，不是固定文案')
	const 截断句 = 只切共享.split('\n').find((line) => line.includes('本次注入有'))
	assert.ok(截断句 !== undefined && !截断句.includes('本机'), '非空但没被切的段不进截断句——本机段此刻有 4 条在装、只是没超预算（段标题照常在场，别拿整块文本判）')

	// 一段都没切：这行整个不出现（它说的是「真发生过」，没发生就不该占块尾一行）
	for (let i = 0; i < INDEX_LINE_BUDGET + 4; i += 1) rmSync(join(store, `h${String(i).padStart(3, '0')}.md`))
	const 没切 = composeMemory({ memoryRoot: root, machine: 'home' })
	assert.ok(没切.includes('[记忆索引]'), '块照常装')
	assert.ok(!没切.includes('本次注入有'), '没有截断就不出截断告警——常驻材料里那行每次都出现，等于每次都教人忽略它')
})
