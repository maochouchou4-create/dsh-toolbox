/**
 * 复盘辅助（dispatch_lessons 逻辑面）单测（node:test，零宿主依赖）：跑在临时目录的假台账上，
 * 读法经 fs-port.js 的 node 适配器（与台账同一份替身），故本文件同时钉住两件事——统计口径
 * （采纳率按集合算、跨版本只分组不平均、裁剪与加派各走各的方向、跨组合并要累加份数、修复轮数与
 * 捕获-再捕获估算的成立条件）与边界（只读是结构性的、点位两侧、force 只跳判定、输出是事件集合
 * 的函数）。
 *
 * 钉的是「哪些守门断言不许被改坏」：分母改成 Σfindings、跨版本求平均、裁剪与加派判反、合并计数
 * 只并键不求和、复盘顺手写回台账、force 顺手改统计——每一条都会让复盘输出与台账事实分家，而分家
 * 之后输出仍然读得通，正是最难发现的一类坏。
 *
 * 断言里的数字一律写字面量，不从实现或数据面反查：反查的用例在阈值被人改过时只会跟着改，永远
 * 钉不住任何东西（真要跟数据面联动，改的是那条专门盯数据面的用例——见「点位判据单源」那条）。
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeFormCounts, parseFormList } from '../lib/dispatch/batch.js'
import { RETROSPECTIVE_STAGE } from '../lib/dispatch/core.js'
import { collectStats, judgePoint, pointOf, renderLessonsResult, runLessons } from '../lib/dispatch/lessons.js'
import { loadDispatchData } from '../lib/dispatch/data.js'
import { createNodeFsPort, createReadOnlyPort } from '../lib/fs-port.js'
import { DISPATCH_DATA_DIR, DISPATCH_DIR, makeEvent, seedLedger, tempRoot } from './helpers.js'

const dataDir = DISPATCH_DATA_DIR
const data = loadDispatchData({ dataDir })
/** 按动作注入它要的那几份数据面（生产走 data.js 的 loadDispatchTablesWithBytes 交回 { tables, bytes }，这趟不记规则指纹，只取表那一半）。 */
const loadTables = ({ names }) => ({ tables: Object.fromEntries(names.map((name) => [name, data[name]])), bytes: {} })

const vocabulary = data.forms.forms.map((form) => form.id)
const port = createNodeFsPort()
let root

/** 事件夹具与台账落盘都取自 helpers：字段名与生产构造器（batch.js 的 startEvent／advanceEvent）逐字同形，
 *  时钟按写入顺序递增（事件时间定序是趋势读法的前提，同秒并列的情形由「同刻并列」那条专门测）。 */
const { start, advance } = makeEvent()

/** 直读刚落好的台账：走 collectStats 那条纯函数路时用（生产读法是 runLessons 里的同一个解析）。 */
const readEvents = (path) => readFileSync(path, 'utf8')
	.split('\n')
	.filter((line) => line !== '')
	.map((line) => JSON.parse(line))

const run = (path, params = {}) => runLessons({ port, path, loadTables, force: params.force === true })

/** 五批三批型＝过了点位的那一组：批数与批型数各自独立地够，两条都不能靠对方顶。 */
const reached = (rules = 'v1') => [
	start('b1', '纯后端管线批', rules),
	advance({ batch: 'b1', rules, combo: '锚点核对 事实校准', recommended: '锚点核对 事实校准', perFormCounts: { 锚点核对: 5, 事实校准: 2 }, adopted: 5, overlap: 1 }),
	start('b2', '纯后端管线批', rules),
	advance({ batch: 'b2', rules, combo: '锚点核对', recommended: '锚点核对 事实校准', perFormCounts: { 锚点核对: 3 }, adopted: 3, overlap: 0 }),
	start('b3', '机械搬运/小修', rules),
	start('b4', '用户可见功能批', rules),
	advance({ batch: 'b4', rules, combo: 'GUI 目检 连带面', recommended: 'GUI 目检 连带面', perFormCounts: { 连带面: 4 }, adopted: 2, overlap: 0, missed: '真机窄屏下面板溢出——本可由 GUI 目检抓到' }),
	start('b5', '用户可见功能批', rules),
]

before((t) => {
	root = tempRoot(t, 'dispatch-lessons')
})

test('点位判据单源＝lifecycle 复盘行的 point 字段（工具描述与 README 里的数字只是它的快照）', () => {
	assert.deepEqual(
		pointOf(data.lifecycle),
		{ minBatches: 5, minBatchTypes: 3, upperBatches: 8 },
		'这三档阈值单源在数据面；代码里不留第二份常量（两份数字必有一份先过期）',
	)
	assert.throws(
		() => pointOf({ stages: [{ uses: ['dispatch_lessons'], note: '少了 point' }] }),
		/没有带 point 字段的复盘阶段行/,
		'数据面缺 point 显式报错：静默回落默认值＝「该不该复盘」取决于代码里一个没人看的常量',
	)
	assert.throws(() => collectStats([], {}), /point.minBatches/, '纯函数调用方也得把判据显式传进来')
	assert.throws(() => collectStats([], { point: { minBatches: 5 } }), /point.minBatchTypes/, '少一档也要报错，不拿 undefined 当 0 继续算')
})

test('复盘点位：批数下界 4 批 false / 5 批 true，批型下界 2 种 false / 3 种 true', async () => {
	assert.equal((await run(seedLedger(root, '四批', reached().slice(0, 6)))).due, false, '四批不到下界 5')
	assert.equal((await run(seedLedger(root, '五批', reached()))).due, true, '五批且覆盖三种批型＝到点')
	const twoTypes = seedLedger(root, '五批两批型', [
		start('c1', '纯后端管线批', 'v1'),
		start('c2', '纯后端管线批', 'v1'),
		start('c3', '机械搬运/小修', 'v1'),
		start('c4', '机械搬运/小修', 'v1'),
		start('c5', '机械搬运/小修', 'v1'),
	])
	assert.equal((await run(twoTypes)).due, false, '批数够但只有 2 种批型：配对表只在多种批型上被验证过')
	const threeTypes = seedLedger(root, '五批三批型', [
		start('d1', '纯后端管线批', 'v1'),
		start('d2', '纯后端管线批', 'v1'),
		start('d3', '机械搬运/小修', 'v1'),
		start('d4', '用户可见功能批', 'v1'),
		start('d5', '机械搬运/小修', 'v1'),
	])
	assert.equal((await run(threeTypes)).due, true, '第三种批型一出现就到点——门槛是「覆盖够不够」不是「攒够没有」')
	assert.match((await run(seedLedger(root, '五批三批型', reached()))).stats, /已到复盘点位：5 批（批型 3 种：机械搬运\/小修、用户可见功能批、纯后端管线批）/)
})

test('批型空串不贡献批型数（拿空串凑出「第三种批型」会让点位提前到点）', async () => {
	const path = seedLedger(root, '空批型', [
		start('e1', '纯后端管线批', 'v1'),
		start('e2', '纯后端管线批', 'v1'),
		start('e3', '机械搬运/小修', 'v1'),
		start('e4', '', 'v1'),
		start('e5', '', 'v1'),
	])
	const value = await run(path)
	assert.equal(value.due, false, '五批里两批没记批型，真实批型只有 2 种')
	assert.match(value.stats, /批型 2 种：机械搬运\/小修、纯后端管线批/)
})

test('同名批多个 start 按批型并集取（跨机并发登记是吸收态，取第一条会丢掉另一台登记的覆盖面）', async () => {
	const path = seedLedger(root, '双start', [
		start('f1', '纯后端管线批', 'v1'),
		start('f1', '机械搬运/小修', 'v1'),
		start('f2', '机械搬运/小修', 'v1'),
		start('f3', '机械搬运/小修', 'v1'),
		start('f4', '纯后端管线批', 'v1'),
	])
	const stats = collectStats(readEvents(path), { point: pointOf(data.lifecycle), vocabulary: new Set(vocabulary) })
	assert.equal(stats.batchCount, 4, '四个批次（f1 的两条 start 是同一批）')
	assert.deepEqual([...stats.batchTypes], ['机械搬运/小修', '纯后端管线批'], 'f1 的两个批型都算，覆盖面按并集而不是「取第一条」')
})

test('形态 id 含空格也不被切坏：词法按形态词表走最长匹配，不按空白（「GUI 目检」是一个 id 不是两个）', () => {
	assert.ok(vocabulary.includes('GUI 目检'), '词表里确实有含空格的 id——夹具的前提')
	assert.deepEqual(parseFormList('GUI 目检 连带面 锚点核对', vocabulary), ['GUI 目检', '连带面', '锚点核对'], '按空白切会把「GUI 目检」数成两个 id，推荐路数与裁剪差跟着全错')
	assert.deepEqual(parseFormList('设计七维·终审 砍刀', vocabulary), ['设计七维·终审', '砍刀'], '不含空格的 id 照旧逐个切')
	assert.deepEqual(parseFormList('   ', vocabulary), [], '空白串＝没派')
	assert.deepEqual(
		parseFormList('已退场形态 锚点核对 连带面', vocabulary),
		['已退场形态', '锚点核对', '连带面'],
		'未知 id 自己成段、不往后吞：吞到下一个已知 id 会把「记账有问题」这条证据连同后面的正常 id 一起吞没',
	)
	assert.deepEqual(
		parseFormList('GUI 目检 未知A 连带面', vocabulary),
		['GUI 目检', '未知A', '连带面'],
		'未知 token 夹在中间也不许把后面的已知 id 带走',
	)
	assert.deepEqual(parseFormList('GUI 目检 连带面'), ['GUI', '目检', '连带面'], '词表为空＝没有词法可用，退化成按空白切（含空格的 id 会被数成两个，这条路只服务纯函数调用方）')
	// 词表里两个 id 互为 token 前缀时才能分辨「最长」与「首个命中即停」；今天的形态词表没有这样
	// 的一对（grep 过：无 token 是另一个的前缀），用合成词表把判据本身钉住，免得将来加形态时静默退化
	const synthetic = new Set(['连带面', '连带面 跨端', '锚点核对'])
	assert.deepEqual(
		parseFormList('连带面 跨端 锚点核对', synthetic),
		['连带面 跨端', '锚点核对'],
		'最长匹配：短 id 是长 id 的前缀时，先试长的那个——按短的切会切出半个 id',
	)
	// 切分守恒：切出来的片段按原序拼回去就是原文（去空白后）——切错一个 id 就会在这里露馅
	for (const text of ['GUI 目检 连带面 锚点核对', '已退场形态 锚点核对', '设计七维·终审']) {
		assert.equal(parseFormList(text, vocabulary).join(' '), text)
	}
})

test('采纳率按集合算：同一个 id 在串里重复两遍不算两路（否则分母翻倍、比率能算出 100% 以上）', async () => {
	const path = seedLedger(root, '重复id', [
		start('g1', '纯后端管线批', 'v1'),
		advance({ batch: 'g1', combo: '锚点核对', recommended: '锚点核对 锚点核对 事实校准', perFormCounts: { 锚点核对: 3 }, adopted: 3 }),
		start('g2', '纯后端管线批', 'v1'),
		start('g3', '机械搬运/小修', 'v1'),
		start('g4', '用户可见功能批', 'v1'),
		start('g5', '机械搬运/小修', 'v1'),
	])
	const { stats } = await run(path)
	assert.match(stats, /组合采纳率 50%（推荐 2 路／采纳 1 路／裁剪 1）/u, '推荐串去重后是 2 路，裁剪 1 路（事实校准）')
})

test('裁剪与加派各走各的方向（判反必红：那会把主会话削减组合读成它自己加派）', async () => {
	const trimmed = await run(seedLedger(root, '裁剪方向', [
		start('h1', '纯后端管线批', 'v1'),
		advance({ batch: 'h1', combo: '锚点核对', recommended: '锚点核对 事实校准', perFormCounts: { 锚点核对: 3 }, adopted: 3 }),
	]), { force: true })
	assert.ok(trimmed.suggestions.some((line) => line.includes('裁剪记录（推荐了没派）：事实校准 1 次')), '推荐了没派＝裁剪')
	assert.ok(!trimmed.suggestions.some((line) => line.includes('加派记录')), '裁剪那一趟不许同时报加派')
	const added = await run(seedLedger(root, '加派方向', [
		start('h2', '纯后端管线批', 'v1'),
		advance({ batch: 'h2', combo: '连带面 锚点核对', recommended: '锚点核对', perFormCounts: { 锚点核对: 3 }, adopted: 3 }),
	]), { force: true })
	assert.ok(added.suggestions.some((line) => line.includes('加派记录（推荐之外派的）：连带面 1 次')), '推荐之外派的＝加派（最大化口径下主会话手动加的路）')
	assert.ok(!added.suggestions.some((line) => line.includes('裁剪记录')), '加派那一趟不许同时报裁剪')
	assert.match(added.stats, /组合采纳率 100%（推荐 1 路／采纳 1 路／裁剪 0）/u, '加派不抬采纳率分子——它不是「采纳了推荐」')
})

test('裁剪与加派跨规则版本合并时按次数求和（只并键会把三趟裁剪报成一次）', async () => {
	const path = seedLedger(root, '跨组合并', [
		start('i1', '纯后端管线批', 'v1'),
		advance({ batch: 'i1', rules: 'v1', combo: '锚点核对', recommended: '锚点核对 事实校准', perFormCounts: { 锚点核对: 2 }, adopted: 2 }),
		advance({ batch: 'i1', rules: 'v1', combo: '锚点核对', recommended: '锚点核对 事实校准', perFormCounts: { 锚点核对: 2 }, adopted: 2 }),
		start('i2', '纯后端管线批', 'v2'),
		advance({ batch: 'i2', rules: 'v2', combo: '锚点核对', recommended: '锚点核对 事实校准', perFormCounts: { 锚点核对: 2 }, adopted: 2 }),
	])
	const { suggestions } = await run(path, { force: true })
	assert.ok(
		suggestions.some((line) => line.includes('裁剪记录（推荐了没派）：事实校准 3 次')),
		'两个版本各裁一次共 3 次（2＋1）：合并时按份数求和，只并键会报成 1 次',
	)
})

test('统计输出含各形态 findings 数与采纳率，三处口径交叉守恒（头条＝各版本＝逐事件）', async () => {
	const path = seedLedger(root, '采纳率', reached())
	const { stats, suggestions } = await run(path)
	// 三趟复核的 recommended 共 2+2+2=6 路，实派∩推荐 2+1+2=5 路 → 83%；裁剪 1 路（事实校准）
	assert.match(stats, /组合采纳率 83%（推荐 6 路／采纳 5 路／裁剪 1）/u)
	assert.match(stats, /表单 findings：锚点核对 8、连带面 4、事实校准 2/u)
	assert.match(stats, /findings 上报 14、采纳 10/u)
	assert.match(stats, /漏网 1 条/u)
	assert.ok(suggestions.some((line) => line.includes('组合采纳率 83%')), '采纳率也进建议草稿——它是「组合宽度合不合用」那个判断的输入')
	const events = readEvents(path)
	const perEvent = events.filter((event) => event.action === 'advance').reduce((total, event) => total + Object.values(event.perFormCounts).reduce((sum, count) => sum + count, 0), 0)
	assert.equal(perEvent, 14, '逐事件求和')
	const groupLine = stats.split('\n').find((line) => line.startsWith('规则版本 v1：'))
	assert.match(groupLine, /findings 上报 14、采纳 10/u, '各版本合计＝头条（只报单版本就会与头条分家）')
	assert.match(groupLine, /组合采纳率 83%（推荐 6／采纳 5）/u)
})

test('采纳率分母不可算时注明（事件未自存 recommended 不等于采纳率 0%）', async () => {
	const path = seedLedger(root, '无分母', [
		start('x1', '纯后端管线批', 'v1'),
		advance({ batch: 'x1', combo: '锚点核对 事实校准', recommended: '', perFormCounts: { 锚点核对: 4 } }),
	])
	const value = await run(path)
	assert.match(value.stats, /组合采纳率 不可算（分母为 0）/u)
	assert.ok(value.suggestions.some((line) => line.includes('recommended') && line.includes('不可算')), '不可算要在建议里点名原因与补法')
	assert.ok(
		!value.suggestions.some((line) => line.includes('加派记录') || line.includes('裁剪记录')),
		'没有推荐基线时那份差等于整份实派清单——报成「加派」是把缺基线说成主会话的动作',
	)
})

test('规则版本分组不跨版本平均：两个版本各报各的比率与 findings，头条合计跨版本求和', async () => {
	const path = seedLedger(root, '两版本', [
		start('m1', '纯后端管线批', 'v1'),
		advance({ batch: 'm1', rules: 'v1', combo: '锚点核对', recommended: '锚点核对 事实校准', perFormCounts: { 锚点核对: 9 }, adopted: 4 }),
		advance({ batch: 'm1', rules: 'v1', combo: '锚点核对', recommended: '锚点核对 事实校准', perFormCounts: { 锚点核对: 9, 事实校准: 1 }, adopted: 5 }),
		start('m2', '纯后端管线批', 'v2'),
		advance({ batch: 'm2', rules: 'v2', combo: '连带面 契约一致性', recommended: '连带面 契约一致性', perFormCounts: { 连带面: 2, 契约一致性: 2 }, adopted: 4 }),
	])
	const { stats } = await run(path)
	assert.match(stats, /规则版本 v1：1 批／3 事件｜组合采纳率 50%（推荐 4／采纳 2）｜findings 上报 19、采纳 9/u)
	assert.match(stats, /规则版本 v2：1 批／2 事件｜组合采纳率 100%（推荐 2／采纳 2）｜findings 上报 4、采纳 4/u)
	assert.match(stats, /规则版本 2 组/u)
	// 头条那三个数＝两个版本之和（漏掉任一版本求和，这行立刻对不上）
	assert.match(stats, /组合采纳率 67%（推荐 6 路／采纳 4 路／裁剪 2）/u)
	assert.match(stats, /findings 上报 23、采纳 13/u)
})

test('到点分支的 stats 正文逐字钉住（把任何一行换成「（略）」都会红）', async () => {
	const path = seedLedger(root, '正文', [
		start('e1', '纯后端管线批', 'v1'),
		advance({ batch: 'e1', combo: '锚点核对', recommended: '锚点核对', perFormCounts: { 锚点核对: 2 }, adopted: 2 }),
		start('e2', '机械搬运/小修', 'v1'),
		advance({ batch: 'e2', combo: '砍刀', recommended: '砍刀 连带面', perFormCounts: { 砍刀: 1 }, adopted: 1 }),
		start('e3', '用户可见功能批', 'v1'),
		start('e4', '跨端契约批', 'v1'),
		start('e5', '配置/迁移批', 'v1'),
	])
	const { stats, due } = await run(path)
	assert.equal(due, true)
	assert.equal(
		stats,
		[
			'已到复盘点位：5 批（批型 5 种：机械搬运/小修、用户可见功能批、纯后端管线批、跨端契约批、配置/迁移批）｜门二 修复轮数合计 0（多轮批 0）｜组合采纳率 67%（推荐 3 路／采纳 2 路／裁剪 1）｜findings 上报 3、采纳 3｜规则版本 1 组｜复核事件 2 趟｜漏网 0 条',
			'规则版本 v1：5 批／7 事件｜组合采纳率 67%（推荐 3／采纳 2）｜findings 上报 3、采纳 3',
			'  表单 findings：锚点核对 2、砍刀 1',
		].join('\n'),
		'逐行写出：漏行、并行、换数、把哪段换成「（略）」都会红',
	)
})

test('force 只跳点位判断，不改统计（跳的是「该不该现在复」，不是「复什么」）', async () => {
	const path = seedLedger(root, 'force', reached().slice(0, 6))
	const normal = await run(path)
	const forced = await run(path, { force: true })
	assert.equal(normal.due, false)
	assert.equal(forced.due, true, 'force=true 出建议，不管点位到没到')
	assert.match(forced.stats, /^点位判断已跳过（force）：4 批/u)
	assert.deepEqual(forced.suggestions, normal.suggestions, '建议逐条相同——force 不改任何一项统计')
	assert.deepEqual(
		forced.stats.split('\n').slice(1),
		normal.stats.split('\n').slice(1),
		'stats 只差首行那句点位结论（未到点那趟首行连结论都不写，见渲染那条）',
	)
})

test('render：到点三段（点位统计／建议草稿／裁决归属），未到点一句带点位摘要且不叠词', async () => {
	const dueText = renderLessonsResult(await run(seedLedger(root, '渲染到点', reached())))
	assert.match(dueText, /^【点位统计】/u)
	assert.ok(dueText.includes('【修订建议草稿】') && dueText.includes('· '), '建议逐条带项目符号成行')
	assert.match(dueText, /建议给主会话裁决，不自动改配对表——本工具只读台账、不落盘。/u)
	const pending = await run(seedLedger(root, '渲染未到', reached().slice(0, 6)))
	const pendingText = renderLessonsResult(pending)
	assert.match(pendingText, /^未到复盘点（/u)
	assert.ok(pendingText.includes(pending.stats), '未到点那一句带的是同一个 stats 值')
	assert.ok(!/未到复盘点（未到复盘点位/.test(pendingText), '框里已经说了「未到复盘点」，stats 首行就不该再说一次')
	assert.equal(pending.stats.startsWith('4 批（批型'), true, '未到点时 stats 首行从数字起，不重复渲染框给的结论')
	// 深拷贝后文本不变：宿主会把结构化值冻结再交渲染，按对象身份的取法在那条路上必然失效
	assert.equal(renderLessonsResult(structuredClone(pending)), pendingText)
})

test('只读不落盘：跑一趟复盘后台账逐字不变（自动改配对表/回写事件都从这里被挡住）', async () => {
	const path = seedLedger(root, '只读', reached())
	const before = { text: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs }
	await run(path, { force: true })
	assert.equal(readFileSync(path, 'utf8'), before.text, '台账内容不许变')
	assert.equal(statSync(path).mtimeMs, before.mtimeMs, '连文件都不许重写（重写就意味着有一次写）')
})

test('只读是结构性的：门面端口上写方法根本不存在（写方法一律 throw 的替身端口也能跑通）', async () => {
	const path = seedLedger(root, '门面', reached())
	const guarded = {
		...createNodeFsPort(),
		writeText: () => {
			throw new Error('复盘不许写')
		},
		assertWritable: () => {
			throw new Error('复盘不许问写权限')
		},
	}
	const readOnly = createReadOnlyPort(guarded)
	assert.equal(readOnly.writeText, undefined, '白名单之外的方法不在对象上——想写得先在门面这一处加它')
	assert.equal(readOnly.assertWritable, undefined)
	assert.equal(typeof readOnly.readText, 'function', '读方法透出')
	assert.ok(Object.isFrozen(readOnly), '门面冻结：事后往它身上挂方法也不算数')
	const value = await runLessons({ port: readOnly, path, loadTables, force: true })
	assert.equal(value.due, true, '只读门面照样跑得出复盘结果')
	const source = readFileSync(join(DISPATCH_DIR, 'lessons.js'), 'utf8')
	assert.ok(!/writeText|assertWritable|node:fs/.test(source), '逻辑面源码里不许出现写方法或 node:fs——边界不靠纪律维持')
})

test('漏网按批型聚合成一条并带上限与余数（逐事件流水进上下文几万字符，而描述承诺的是趋势）', async () => {
	const long = '真机窄屏下面板溢出，滚动条压住最后一个按钮，用户点了没反应，回归时没人发现，验收也漏过——本可由 GUI 目检在真机上点到这个位置'
	const path = seedLedger(root, '漏网聚合', [
		start('j1', '纯后端管线批', 'v1'),
		advance({ batch: 'j1', combo: '锚点核对', recommended: '锚点核对', perFormCounts: { 锚点核对: 2 }, adopted: 2, missed: long }),
		advance({ batch: 'j1', combo: '锚点核对', recommended: '锚点核对', perFormCounts: { 锚点核对: 2 }, adopted: 2, missed: '第二条漏网' }),
		advance({ batch: 'j1', combo: '锚点核对', recommended: '锚点核对', perFormCounts: { 锚点核对: 2 }, adopted: 2, missed: '第三条漏网' }),
		start('j2', '机械搬运/小修', 'v1'),
		advance({ batch: 'j2', combo: '锚点核对', recommended: '锚点核对', perFormCounts: { 锚点核对: 2 }, adopted: 2, missed: '小修批漏网' }),
		start('j3', '用户可见功能批', 'v1'),
		advance({ batch: 'j3', combo: '锚点核对', recommended: '锚点核对', perFormCounts: { 锚点核对: 2 }, adopted: 2, missed: '功能批漏网' }),
		start('j4', '配置/迁移批', 'v1'),
		start('j5', '跨端契约批', 'v1'),
	])
	const { suggestions } = await run(path, { force: true })
	const line = suggestions.find((entry) => entry.includes('漏网标记'))
	assert.ok(line !== undefined, '漏网聚合成一条')
	assert.match(line, /^漏网标记（按批型聚合，明细见台账）：/u)
	assert.match(line, /纯后端管线批 3 条（j1·门二：.+、j1·门二：.+、…）/u, '每个批型最多两条样本，余下用「…」表示还有')
	assert.ok(!line.includes(long), `样本文本按 ${60} 字截断，不让一条事件的自由文本决定成稿长度`)
	assert.ok(line.includes('…'), '截断标记在')
	assert.match(line, /另有 1 条未列/u, '被聚合吃掉的条数要报出来：不给这个数，读者会以为那就是全部')
	assert.equal(suggestions.filter((entry) => entry.includes('漏网')).length, 1, '漏网只占一条建议，不逐事件成行')
})

test('双报重叠按批型聚合：每批型一趟数、重叠 0 趟数与估算区间，超出的批型报余数', async () => {
	const path = seedLedger(root, '重叠聚合', [
		start('k1', '纯后端管线批', 'v1'),
		advance({ batch: 'k1', combo: '连带面 砍刀', recommended: '连带面 砍刀', perFormCounts: { 连带面: 6, 砍刀: 4 }, adopted: 6, overlap: 1 }),
		advance({ batch: 'k1', combo: '连带面 砍刀', recommended: '连带面 砍刀', perFormCounts: { 连带面: 6, 砍刀: 4 }, adopted: 6, overlap: 1 }),
		start('k2', '机械搬运/小修', 'v1'),
		advance({ batch: 'k2', combo: '连带面 砍刀', recommended: '连带面 砍刀', perFormCounts: { 连带面: 5, 砍刀: 3 }, adopted: 5, overlap: 2 }),
		start('k3', '用户可见功能批', 'v1'),
		advance({ batch: 'k3', combo: '连带面 砍刀', recommended: '连带面 砍刀', perFormCounts: { 连带面: 4, 砍刀: 2 }, adopted: 4, overlap: 1 }),
		start('k4', '配置/迁移批', 'v1'),
		advance({ batch: 'k4', combo: '连带面 砍刀', recommended: '连带面 砍刀', perFormCounts: { 连带面: 3, 砍刀: 1 }, adopted: 3, overlap: 0 }),
		start('k5', '跨端契约批', 'v1'),
	])
	const { suggestions } = await run(path, { force: true })
	const line = suggestions.find((entry) => entry.includes('双报重叠'))
	assert.match(line, /^双报重叠（按批型聚合）：/u)
	assert.match(line, /纯后端管线批 复核 2 趟、重叠 0 的 0 趟、捕获-再捕获估算 24–24 条/u, '同一批型的多趟合并成一条，估算是区间')
	assert.match(line, /机械搬运\/小修 复核 1 趟、重叠 0 的 0 趟、捕获-再捕获估算 8 条/u)
	assert.match(line, /用户可见功能批 复核 1 趟、重叠 0 的 0 趟、捕获-再捕获估算 8 条/u)
	assert.match(line, /另有 1 条未列/u, '前三种批型之外的（配置/迁移批那条 overlap 0）报余数')
	assert.ok(!line.includes('两路无交集＝检出面还开着'), '重叠 0 不下结论：台账判不出是两路互补还是覆盖面有缺口，判断权在主会话')
	assert.ok(line.includes('两种读法'), '两种读法都要摆出来供裁决')
})

test('重叠 0 时不出估算（没有交集就没有捕获-再捕获的样本），重叠数与捕获数矛盾时报不可算', async () => {
	const disjoint = await run(seedLedger(root, '重叠0', [
		start('l1', '纯后端管线批', 'v1'),
		advance({ batch: 'l1', combo: '连带面 砍刀', recommended: '连带面 砍刀', perFormCounts: { 连带面: 5, 砍刀: 2 }, adopted: 5, overlap: 0 }),
	]), { force: true })
	const line = disjoint.suggestions.find((entry) => entry.includes('双报重叠'))
	assert.match(line, /重叠 0 的 1 趟/u)
	assert.match(line, /捕获-再捕获估算 不可算（两路无交集，或重叠数与捕获数自相矛盾，见口径注记）/u)
	const broken = await run(seedLedger(root, '重叠矛盾', [
		start('l2', '纯后端管线批', 'v1'),
		advance({ batch: 'l2', combo: '连带面 砍刀', recommended: '连带面 砍刀', perFormCounts: { 连带面: 5, 砍刀: 2 }, adopted: 5, overlap: 9 }),
	]), { force: true })
	assert.match(
		broken.suggestions.find((entry) => entry.includes('双报重叠')),
		/捕获-再捕获估算 不可算/u,
		'overlap 大于次大那路＝交集比任何一路的命中都大，写侧不校验、只能算坏数据',
	)
	assert.match(broken.stats, /口径注记：重叠数大于次大路的捕获数 1 趟/u)
	assert.ok(broken.suggestions.some((entry) => entry.includes('重叠数与捕获数自相矛盾')), '矛盾要在建议里点名补法')
})

test('少于两路有捕获就不报重叠（一条单路复核没有第二个样本，那个式子无从算起）', async () => {
	const { suggestions } = await run(seedLedger(root, '单路', [
		start('m1', '纯后端管线批', 'v1'),
		advance({ batch: 'm1', combo: '锚点核对', recommended: '锚点核对', perFormCounts: { 锚点核对: 4 }, adopted: 4, overlap: 0 }),
		advance({ batch: 'm1', combo: '连带面', recommended: '连带面', perFormCounts: { 连带面: 2 }, adopted: 2, overlap: 0 }),
	]), { force: true })
	assert.ok(!suggestions.some((entry) => entry.includes('双报重叠')), '两趟单路复核不是「两路无交集」，是没得比')
})

test('修复轮数、零 findings 形态与记账缺格各走各的那条建议', async () => {
	const path = seedLedger(root, '草稿', [
		start('r1', '修复批', 'v1', { baseBatchType: '纯后端管线批' }),
		advance({ batch: 'r1', combo: '连带面 设计七维·终审 契约一致性', recommended: '连带面 设计七维·终审 契约一致性', perFormCounts: { 连带面: 6, '设计七维·终审': 4, 契约一致性: 0 }, adopted: 6, overlap: 3 }),
		advance({ batch: 'r1', combo: '连带面 设计七维·终审 契约一致性', recommended: '连带面 设计七维·终审 契约一致性', perFormCounts: { 连带面: 2, '设计七维·终审': 0, 契约一致性: 0 }, adopted: 2, overlap: 1, missed: '收尾批又开了新账' }),
		advance({ batch: 'r1', combo: '连带面 设计七维·终审 契约一致性', recommended: '连带面 设计七维·终审 契约一致性', perFormCounts: { 连带面: 3, '设计七维·终审': 1, 契约一致性: 0 }, adopted: 4, overlap: 0 }),
	])
	const { suggestions, stats } = await run(path, { force: true })
	const joined = suggestions.join('\n')
	assert.match(joined, /修复轮数：批次 r1（依赖原批型 纯后端管线批）：门二 记了 3 轮（修复轮数 2）/u)
	// 降级证据跨全量台账累积，增量 versions 组容不下纯旧批的形态
	assert.match(joined, /长期零 findings 形态：契约一致性——派过 ≥2 次仍零 findings，请裁决降级（配对表改派）或转手动指派（跨全量台账累积，含已复盘批）/u)
	assert.match(stats, /门二 修复轮数合计 2（多轮批 1）/u)
	// S4：行数类数字台账事件没有维度，这一条永不产出，写成用例是为了钉住「不出」而不是「出」
	assert.ok(!joined.includes('小批化'), '描述已删「小批化数字校准」，输出里也不许再冒出来')
	assert.ok(!stats.includes('小批化'))
	assert.match(joined, /漏网标记（按批型聚合，明细见台账）：修复批 1 条（r1·门二：收尾批又开了新账）/u)
	assert.match(joined, /双报重叠（按批型聚合）：修复批 复核 2 趟、重叠 0 的 1 趟、捕获-再捕获估算 8 条/u)
})

test('零 findings 与记账缺格是两件事：派过两次仍零 findings 才进降级候选，只出现过一次不算', async () => {
	const path = seedLedger(root, '零门槛', [
		start('y1', '纯后端管线批', 'v1'),
		// 第一趟：砍刀派了两次零 findings；GUI 目检派了却没在 perFormCounts 里落数（记账缺格）
		advance({ batch: 'y1', combo: '砍刀 GUI 目检', recommended: '砍刀 GUI 目检', perFormCounts: { 砍刀: 0 } }),
		advance({ batch: 'y1', combo: '砍刀 场景走查·升级版', recommended: '砍刀 场景走查·升级版', perFormCounts: { 砍刀: 0, '场景走查·升级版': 0 } }),
	])
	const value = await run(path, { force: true })
	const zeroLine = value.suggestions.find((line) => line.includes('长期零 findings 形态'))
	assert.match(zeroLine, /：砍刀——派过 ≥2 次仍零 findings/u)
	assert.ok(!zeroLine.includes('场景走查·升级版'), '只派过一次就零 findings 的形态不进降级候选：一次样本说不准是形态不对口还是没派足')
	const missingLine = value.suggestions.find((line) => line.includes('实派了却没记 findings 数的形态'))
	assert.ok(missingLine.includes('GUI 目检'), '派了没记数的形态走「记账缺格」那条，不混进零 findings 候选')
})

test('坏计数折成零而不是把整份统计变成 NaN（坏行本身由读台账那层报错）', async () => {
	const path = seedLedger(root, '坏计数', [
		start('n1', '纯后端管线批', 'v1'),
		advance({ batch: 'n1', combo: '锚点核对 砍刀 连带面 GUI 目检', recommended: '锚点核对 砍刀 连带面 GUI 目检', perFormCounts: { 锚点核对: '4', 砍刀: -3, 连带面: 'Infinity', 'GUI 目检': null }, adopted: '2' }),
	])
	const { stats, suggestions } = await run(path, { force: true })
	assert.match(stats, /findings 上报 4、采纳 2/u, '数字串按数取值；负数、Infinity、null 折成零')
	assert.match(stats, /表单 findings：锚点核对 4、GUI 目检 0、砍刀 0、连带面 0/u, '同为零的那几个按 id 定序，不按写入顺序')
	assert.ok(!stats.includes('NaN'), '一份坏计数不许把整份稿变成 NaN')
	assert.ok(suggestions.some((line) => line.includes('组合采纳率 100%')))
})

test('超过提示上限批数时只多一条提示，不改到点判定（点位看覆盖面不是攒月数）', async () => {
	const kinds = ['纯后端管线批', '机械搬运/小修', '用户可见功能批']
	const path = seedLedger(root, '超上限', Array.from({ length: 9 }, (_, index) => start(`o${index}`, kinds[index % 3], 'v1')))
	const value = await run(path)
	assert.equal(value.due, true, '九批三批型：到点')
	assert.match(value.stats, /已到复盘点位：9 批（批型 3 种/u, '过了上限也不改首行的判定结论，只是多一条提示')
	assert.ok(value.suggestions.some((line) => line.includes('已攒 9 批，超过提示上限 8 批')), '超上限出提示')
})

test('空台账（在、一条事件都没有）出零值统计，不报「异常」也不编数', async () => {
	const path = seedLedger(root, '空台账', [])
	const value = await run(path)
	assert.equal(value.due, false)
	assert.match(value.stats, /^0 批（批型 0 种：—）｜门二 修复轮数合计 0（多轮批 0）/u)
	assert.match(value.stats, /组合采纳率 不可算（分母为 0）/u)
	assert.deepEqual(value.suggestions.filter((line) => !line.includes('recommended')), [], '没有可提的证据就不提')
})

test('台账不存在时显式报错，不静默出一份空复盘（空复盘读起来像「没有异常项」）', async () => {
	await assert.rejects(() => run(join(root, '尚未登记.jsonl')), /台账里还没有任何批次事件可统计/u)
	assert.equal(existsSync(join(root, '尚未登记.jsonl')), false, '复盘不建台账：start 是唯一的自举入口')
})

test('统计是事件集合的函数：行序打乱（跨机 union merge 的常态）不改变任何输出', async () => {
	const events = [
		start('o1', '纯后端管线批', 'v1'),
		start('o2', '用户可见功能批', 'v1'),
		advance({ batch: 'o1', combo: '连带面 锚点核对', recommended: '连带面 锚点核对', perFormCounts: { 连带面: 5, 锚点核对: 2 }, adopted: 5, overlap: 1 }),
		advance({ batch: 'o2', combo: 'GUI 目检', recommended: 'GUI 目检 砍刀', perFormCounts: { 'GUI 目检': 0 }, adopted: 0, missed: '甲批漏网' }),
	]
	const forward = await run(seedLedger(root, '顺序', events))
	const backward = await run(seedLedger(root, '乱序', [...events].reverse()))
	assert.equal(backward.stats, forward.stats, '按事件时间定序，读到哪一行都一样')
	assert.deepEqual(backward.suggestions, forward.suggestions)
})

test('时间戳并列时行序也不许漂（t 只到秒，跨机各记一条同一秒是常态）', async () => {
	const at = '2026-01-01T00:00:00+00:00'
	const events = [
		{ ...start('q1', '纯后端管线批', 'v2'), t: at },
		{ ...advance({ batch: 'q1', rules: 'v2', combo: '连带面 砍刀', recommended: '连带面 砍刀', perFormCounts: { 连带面: 4, 砍刀: 2 }, adopted: 4, overlap: 1, missed: '甲批漏网' }), t: at },
		{ ...start('q2', '纯后端管线批', 'v1'), t: at },
		{ ...advance({ batch: 'q2', combo: '连带面 契约一致性', recommended: '连带面 契约一致性', perFormCounts: { 连带面: 2, 契约一致性: 1 }, adopted: 3, overlap: 1, missed: '乙批漏网' }), t: at },
		{ ...start('q3', '用户可见功能批', 'v1'), t: at },
		{ ...advance({ batch: 'q3', combo: '连带面 连带面', recommended: '连带面', perFormCounts: { 连带面: 2 }, adopted: 2 }), t: at },
		{ ...start('q4', '跨端契约批', 'v1'), t: at },
		{ ...start('q5', '机械搬运/小修', 'v1'), t: at },
	]
	const forward = await run(seedLedger(root, '同刻正序', events))
	const backward = await run(seedLedger(root, '同刻乱序', [...events].reverse()))
	assert.equal(backward.stats, forward.stats, '同一秒内的并列不许让版本组、批型清单的行序漂')
	assert.deepEqual(backward.suggestions, forward.suggestions, '漏网这类逐条出的也一样——它们都自带定序键（两条漏网分属同一批型的两个批次，正序倒序会换位）')
	assert.match(forward.stats, /规则版本 v1：/u)
	assert.ok(forward.stats.indexOf('规则版本 v1') < forward.stats.indexOf('规则版本 v2'), '版本组按版本名定序，不按第一条事件的先后')
})

test('点位判定纯函数：force 与门槛各自独立，不读事件内容', () => {
	const point = { minBatches: 5, minBatchTypes: 3, upperBatches: 8 }
	const stats = { batchCount: 5, batchTypeCount: 3, point }
	assert.deepEqual(judgePoint(stats), { force: false, batchCount: 5, batchTypeCount: 3, reached: true, due: true, overUpper: false })
	assert.equal(judgePoint(stats, { force: true }).force, true)
	assert.equal(judgePoint({ batchCount: 4, batchTypeCount: 3, point }, { force: true }).reached, false, 'force 跳的是 due，reached 仍按门槛算')
	assert.equal(judgePoint({ batchCount: 9, batchTypeCount: 3, point }).overUpper, true, '超过提示上限 8 批出一条提示，不改判定')
	assert.equal(judgePoint({ batchCount: 9, batchTypeCount: 2, point }).due, false, '批型不够时攒再多批也不到点')
})

test('读侧归一 normalizeFormCounts：新旧两种形状归出同一份「形态→份数」（求和方向判据）', () => {
	const objectShape = { 锚点核对: 5, 事实校准: 2 }
	const arrayShape = [{ form: '锚点核对', count: 5 }, { form: '事实校准', count: 2 }]
	assert.deepEqual(
		[...normalizeFormCounts(objectShape, new Set(vocabulary))],
		[...normalizeFormCounts(arrayShape, new Set(vocabulary))],
		'同一份计数两种形状归一结果逐键逐值相同——读面不知道也不想知道是哪种',
	)
	assert.deepEqual([...normalizeFormCounts(arrayShape)], [['锚点核对', 5], ['事实校准', 2]], '新形状按 count 归一：findings 求和吃的是份数不是条数')
	assert.deepEqual([...normalizeFormCounts('锚点核对 事实校准', new Set(vocabulary))], [['锚点核对', 1], ['事实校准', 1]], '旧串形状按词法切、各记 1 份')
	assert.deepEqual([...normalizeFormCounts([{ form: '锚点核对' }])], [['锚点核对', 0]], 'count 缺/坏与显式 0 同折 0（countOf 同一口径）：读面不替坏数据发明份数，也不让一个 NaN 污染整份统计')
	assert.deepEqual([...normalizeFormCounts([{ form: '锚点核对', count: '三条' }])], [['锚点核对', 0]], '坏值折 0：读面不重复拦形状，也不让一个坏值把整份统计变成 NaN')
})

test('新形状事件走全链：findings 按份数求和（不是条数）、实派未记数的形态报「记账缺格」、记全的不虚报漏记', async () => {
	const path = seedLedger(root, '新形状全链', [
		start('n1', '纯后端管线批', 'v1'),
		start('n2', '机械搬运/小修', 'v1'),
		start('n3', '用户可见功能批', 'v1'),
		start('n4', '用户可见功能批', 'v1'),
		start('n5', '纯后端管线批', 'v1'),
		// combo 两个形态、计数只记了一个：锚点核对 5 份进 findings 求和，事实校准进「记账缺格」
		advance({ batch: 'n1', rules: 'v1', combo: ['锚点核对', '事实校准'], recommended: ['锚点核对', '事实校准'], perFormCounts: [{ form: '锚点核对', count: 5 }], adopted: 5 }),
	])
	const { stats, suggestions } = await run(path, { force: true })
	assert.match(stats, /findings 上报 5、采纳 5/u, '求和按份数：[{form,count}] 的 count 相加，不是数组条数')
	assert.match(stats, /表单 findings：锚点核对 5/u, '按形态的份数同样来自 count')
	assert.ok(
		suggestions.some((line) => line.includes('实派了却没记 findings 数的形态：事实校准')),
		'combo 里有、计数里没有＝记账缺格（漏记方向）：归一后的键域判定吃到了新形状',
	)
	// 对照：combo 与计数对得上时不虚报——旧代码 Object.hasOwn 对数组恒 false 会把每行都判成整格漏记
	const clean = seedLedger(root, '新形状不虚报', [
		start('m1', '纯后端管线批', 'v1'),
		start('m2', '机械搬运/小修', 'v1'),
		start('m3', '用户可见功能批', 'v1'),
		start('m4', '用户可见功能批', 'v1'),
		start('m5', '纯后端管线批', 'v1'),
		advance({ batch: 'm1', rules: 'v1', combo: ['锚点核对'], recommended: ['锚点核对'], perFormCounts: [{ form: '锚点核对', count: 3 }], adopted: 3 }),
	])
	const cleanRun = await run(clean, { force: true })
	assert.ok(
		!cleanRun.suggestions.some((line) => line.includes('实派了却没记 findings 数的形态')),
		'键域对得上就不出漏记建议：新形状的每一行不许被误判成整格漏记（虚高方向判据）',
	)
})

/* ---------- 增量口径：复盘事件＝全仓销账点（最后一条复盘事件的 t；同刻不算、批粒度整批进出） ---------- */

test('无复盘事件＝全量口径：cutoff 为 null，首行不带「上次复盘」（首次复盘前的兼容面）', async () => {
	const path = seedLedger(root, 'cutoff空', reached())
	const value = await run(path)
	assert.equal(
		collectStats(readEvents(path), { point: pointOf(data.lifecycle), vocabulary: new Set(vocabulary) }).cutoff,
		null,
		'台账里一条复盘事件都没有：销账点不存在，初始态是全量而不是错误',
	)
	assert.ok(!value.stats.includes('上次复盘'), '没有销账点就没有增量口径：首行保持「N 批（批型 M 种…）」的现状文本')
})

test('有复盘事件：销账点后有事件的批进增量、纯旧批被销，旧批的 findings 不再进统计', async () => {
	const events = [
		start('old1', '纯后端管线批', 'v1'),
		advance({ batch: 'old1', combo: '锚点核对', recommended: '锚点核对', perFormCounts: [{ form: '锚点核对', count: 2 }], adopted: 2 }),
		advance({ batch: 'old1', stage: RETROSPECTIVE_STAGE }),
		start('new1', '机械搬运/小修', 'v1'),
		start('new2', '用户可见功能批', 'v1'),
		start('new3', '跨端契约批', 'v1'),
		start('new4', '配置/迁移批', 'v1'),
		start('new5', '配置/迁移批', 'v1'),
	]
	const stats = collectStats(readEvents(seedLedger(root, '增量集', events)), { point: pointOf(data.lifecycle), vocabulary: new Set(vocabulary) })
	assert.equal(stats.cutoff, events[2].t, '销账点＝那条复盘事件的时间')
	assert.equal(stats.batchCount, 5, 'old1 的全部事件都不晚于销账点——整批被销，窗口里只剩 new1–new5')
	assert.equal(stats.batchTypeCount, 4)
	assert.equal(stats.totals.found, 0, '旧批的 findings 不随旧批进增量窗口')
	const value = await run(seedLedger(root, '增量集文案', events))
	assert.ok(
		value.stats.includes(`上次复盘〔${events[2].t}〕后增量 5 批／台账全量 6 批（增量批型 4 种：机械搬运/小修、用户可见功能批、跨端契约批、配置/迁移批）`),
		'首行报增量口径；批型数与清单不可丢——点位是批数∧批型数双门槛',
	)
})

test('cutoff 取最后一条复盘事件而不是台账最后一条事件（防实现滑成「最后事件时刻」）', () => {
	const events = [
		start('old1', '纯后端管线批', 'v1'),
		advance({ batch: 'old1', stage: RETROSPECTIVE_STAGE }),
		start('new1', '机械搬运/小修', 'v1'),
		advance({ batch: 'new1', stage: RETROSPECTIVE_STAGE }),
		advance({ batch: 'new1' }),
	]
	const stats = collectStats(events, { point: pointOf(data.lifecycle), vocabulary: new Set(vocabulary) })
	assert.equal(stats.cutoff, events[3].t, '两条复盘事件取更晚那条为销账点；台账最后一条是普通 advance，不参与')
})

test('与销账点同刻的事件不算增量（严格大于——复盘事件自己是 max，把它算进增量的实现会在这一步红）', () => {
	const events = [
		start('old1', '纯后端管线批', 'v1'),
		advance({ batch: 'old1', stage: RETROSPECTIVE_STAGE }),
		start('same1', '机械搬运/小修', 'v1'),
	]
	events[2] = { ...events[2], t: events[1].t }
	const stats = collectStats(events, { point: pointOf(data.lifecycle), vocabulary: new Set(vocabulary) })
	assert.equal(stats.cutoff, events[1].t)
	assert.equal(stats.batchCount, 0, '同刻并列按不晚于销账点处理：≥ 会把销账事件自己算进增量')
})

test('批粒度：跨点批（start 在销账点前、advance 在后）整批进增量，销账点前的旧事件也进统计', () => {
	const events = [
		start('x1', '纯后端管线批', 'v1'),
		advance({ batch: 'x1', combo: '锚点核对', recommended: '锚点核对', perFormCounts: [{ form: '锚点核对', count: 2 }], adopted: 2 }),
		advance({ batch: 'x1', stage: RETROSPECTIVE_STAGE }),
		advance({ batch: 'x1', combo: '锚点核对', recommended: '锚点核对', perFormCounts: [{ form: '锚点核对', count: 3 }], adopted: 3 }),
	]
	const stats = collectStats(events, { point: pointOf(data.lifecycle), vocabulary: new Set(vocabulary) })
	assert.equal(stats.cutoff, events[2].t)
	assert.equal(stats.batchCount, 1, 'x1 的 start 早于销账点但销账点后还有 advance——跨点活跃批整批进')
	assert.equal(stats.totals.found, 5, '销账点前的旧 advance（2 份）也进统计：切事件会造出半批统计')
	assert.equal(stats.fixRounds[0].rounds, 1, '修复轮数按批粒度：销账点前那趟门二也计入（2 趟门二−1；切事件只数销账点后会是 0）')
	assert.equal(stats.reviewEventCount, 2, '复核事件按批粒度整批进：销账点前那趟也数（切事件会是 1）')
})

test('零 findings 跨全量累积：纯旧批的两次零 findings 仍出降级建议，带固定后缀、不带版本标签', async () => {
	const events = [
		start('old1', '纯后端管线批', 'v1'),
		advance({ batch: 'old1', combo: '砍刀', recommended: '砍刀', perFormCounts: [{ form: '砍刀', count: 0 }] }),
		advance({ batch: 'old1', combo: '砍刀', recommended: '砍刀', perFormCounts: [{ form: '砍刀', count: 0 }] }),
		advance({ batch: 'old1', stage: RETROSPECTIVE_STAGE }),
		start('new1', '机械搬运/小修', 'v1'),
		advance({ batch: 'new1', combo: '锚点核对', recommended: '锚点核对', perFormCounts: [{ form: '锚点核对', count: 1 }], adopted: 1 }),
	]
	const value = await run(seedLedger(root, '零findings全量', events), { force: true })
	const line = value.suggestions.find((entry) => entry.includes('长期零 findings 形态'))
	assert.ok(line !== undefined && line.includes('砍刀'), '证据全在销账点之前：销账销裁决待办不销证据，降级线索仍要进裁决队列')
	assert.ok(line.includes('（跨全量台账累积，含已复盘批）'), '固定后缀点明口径，不至于把这条读成增量面')
	assert.ok(!line.includes('规则版本'), '不按规则版本分组：增量 versions 组容不下纯旧批的形态，版本考古归裁决日志')
})

test('同刻不同时区拼写的复盘事件：cutoff 按字典序定向，对输入行序独立', () => {
	// 两个 t 是同一时刻的两种拼写（Date.parse 相等）：字典序大的是 '+08:00' 那条
	const base = [
		start('old1', '纯后端管线批', 'v1'),
		{ ...advance({ batch: 'old1', stage: RETROSPECTIVE_STAGE }), t: '2026-01-01T00:00:00+00:00' },
		{ ...advance({ batch: 'old2', stage: RETROSPECTIVE_STAGE }), t: '2026-01-01T08:00:00+08:00' },
	]
	for (const events of [base, [...base].reverse()]) {
		const stats = collectStats(events, { point: pointOf(data.lifecycle), vocabulary: new Set(vocabulary) })
		assert.equal(stats.cutoff, '2026-01-01T08:00:00+08:00', '同刻并列取字典序大者：换输入行序结果逐字不变（输出是事件集合的函数）')
	}
})

test('allForms 跨销账点两侧累积：times 跨界累加，删掉复盘事件证据面逐键不变', async () => {
	const zero = (batch) => advance({ batch, combo: '砍刀', recommended: '砍刀', perFormCounts: [{ form: '砍刀', count: 0 }] })
	const events = [
		start('old1', '纯后端管线批', 'v1'),
		zero('old1'),
		advance({ batch: 'old1', stage: RETROSPECTIVE_STAGE }),
		start('new1', '机械搬运/小修', 'v1'),
		zero('new1'),
	]
	const withRetro = collectStats(events, { point: pointOf(data.lifecycle), vocabulary: new Set(vocabulary) })
	assert.deepEqual(
		withRetro.allForms.get('砍刀'),
		{ found: 0, times: 2 },
		'销账点前后各一趟：times 跨界累加到 2（切进增量窗口会被饿死成 1，凑不齐降级门槛）',
	)
	const value = await run(seedLedger(root, '零两侧', events), { force: true })
	const line = value.suggestions.find((entry) => entry.includes('长期零 findings 形态'))
	assert.ok(line !== undefined && line.includes('砍刀'), '两侧累加过 ≥2 门槛，降级建议要列出')
	const withoutRetro = collectStats(
		events.filter((event) => event.stage !== RETROSPECTIVE_STAGE),
		{ point: pointOf(data.lifecycle), vocabulary: new Set(vocabulary) },
	)
	assert.deepEqual(
		withoutRetro.allForms.get('砍刀'),
		withRetro.allForms.get('砍刀'),
		'allForms 从全量 rows 累积：有无销账点不改变证据面（销账不销证据）',
	)
})

test('迟到事件（t 早于已有事件、后并入台账）：cutoff 与增量批名单都不变（集合式推导不认写入序）', () => {
	const events = [
		start('old1', '纯后端管线批', 'v1'),
		advance({ batch: 'old1', stage: RETROSPECTIVE_STAGE }),
		start('new1', '机械搬运/小修', 'v1'),
		advance({ batch: 'new1', combo: '锚点核对', recommended: '锚点核对', perFormCounts: [{ form: '锚点核对', count: 1 }], adopted: 1 }),
	]
	const baseline = collectStats(events, { point: pointOf(data.lifecycle), vocabulary: new Set(vocabulary) })
	// 后写但 t 更早：普通 advance 与复盘事件各试一式
	const lateNormal = { ...advance({ batch: 'new1' }), t: events[0].t }
	const lateRetro = { ...advance({ batch: 'old2', stage: RETROSPECTIVE_STAGE }), t: events[0].t }
	for (const late of [lateNormal, lateRetro]) {
		const stats = collectStats([...events, late], { point: pointOf(data.lifecycle), vocabulary: new Set(vocabulary) })
		assert.equal(stats.cutoff, baseline.cutoff, '更早的迟到事件抬不动销账点：cutoff 是 max（迟到复盘事件也一样）')
		assert.deepEqual(stats.batches.map((row) => row.batch), baseline.batches.map((row) => row.batch), '增量批名单不变：迟到的旧事件不把已销的批拉回窗口')
	}
})
