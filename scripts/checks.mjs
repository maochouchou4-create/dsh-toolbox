/**
 * 注入块离线自检的采集与检查两半。同目录的 check-memory-index.mjs 是跑它们的薄壳，
 * 这里单独成文件是因为「一份 .mjs 要兼模块与运行器」逼出了「被直接运行时才执行」的守卫，
 * 而守卫本身就是一处能把自己关掉的判断——`node /tmp/某软链` 调它时 argv[1] 与
 * import.meta.url 不相等，命令于是零输出并以 0 退出：一个「必须绿才算完」的验收闸门
 * 静默变成 no-op，比误报红坏得多（误报红会被看见）。拆成「模块 + 薄壳」之后，两种
 * 入口只剩一种答案，也就没有守卫可写错。
 *
 * 零宿主依赖：这里只 import 本仓 lib/memory 下的纯模块与 node 标准库，单测可直接
 * import 本文件拿 CHECKS，不必起子进程才能验一份清单。
 */
import process from 'node:process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { composeMemory, readEntryHead, scanSegment } from '../lib/memory/assemble.js'
import {
	BLOCK_CHAR_BUDGET,
	INDEX_CHAR_BUDGET,
	INDEX_LINE_BUDGET,
	INDEX_LINE_CHAR_BUDGET,
	MACHINES_DIR,
	SHARED_SEGMENT,
	assertMachineId,
	resolveScopeDir,
} from '../lib/memory/core.js'
import { DEFAULT_MEMORY_ROOT, describeError, resolveRoot } from '../lib/memory-root.js'
import { FRONTMATTER_KEYS, RETIRED_INDEX_NAME, WRITING_FILE, isEntryName, isRetiredIndexFile } from '../lib/memory/frontmatter.js'
import { listSegmentDirs } from '../lib/memory/segments.js'
import { duplicateSectionHeadings, sectionDupNotice } from '../lib/memory/patterns.js'
import { isNonBlankString } from '../lib/value.js'

/**
 * 取参与否收在参数对象里：薄壳与单测从这里拿「给了什么」，不从 process.argv 现场解析。
 *
 * 两参＝记忆根与机器 id（决定注入装本机段的是机器身份，不再是工作区 cwd——归属不再与
 * 工作目录相关）。argv[3] 就是机器 id：它同时也是 `machines/<id>/` 的目录名，故与插件
 * config.machine 同形、同值域。
 *
 * 「给了」问 lib/value.js 那份跨族原语——本文件要与 dsh-memory 的 Config 回退判同一件事，
 * 两者各抄一份时「算不算给了」就在脚本与插件之间分叉。判的是解析后的值而不是数位置参数
 * 个数：空串与纯空白经 `||` 回落后与缺参同形，可它们仍是调用方**写下来**的形参，判据必须
 * 看得见这件事——`node scripts/check-memory-index.mjs "" ""` 收了两个空串，脚本却拿默认根
 * 与空机器名去算，然后印「全部达标」，那是「检查没跑」却报成功。
 */
export function readOptions(argv = process.argv, env = process.env) {
	// 用 `||` 不用 `??`：显式传空串（想只跑默认值）不该被当成「记忆根就是当前目录」，
	// 那会让脚本在一片空地上报「全部达标」
	const memoryRoot = argv[2] || env.DSH_MEMORY_ROOT || DEFAULT_MEMORY_ROOT
	const machine = argv[3] || ''
	return {
		memoryRoot,
		machine,
		rootGiven: isNonBlankString(argv[2]),
		machineGiven: isNonBlankString(argv[3]),
	}
}

/**
 * 采集：跑一遍注入侧同一份扫描，把各检查项要判的东西一次性收齐。
 * 检查项只读现场，不自己再去读盘——检查与采集各读一次盘，两者就会在「读到哪一刻」上分家。
 */
export function collectSite({ memoryRoot, machine, rootGiven, machineGiven }) {
	const root = resolveRoot(memoryRoot)
	const issues = []
	const record = (kind) => (issue, path, detail) => {
		issues.push({ kind, issue, path, detail })
	}
	// 段清点只发生一次，两个消费方（头读扫描与节重名整篇读）共用同一份清单：脚本自己
	// 再列一遍目录，两次结果不一致时（中途增删条目）报告里的数字就互相对不上
	const segmentDirs = listSegmentDirs(root)
	const segments = segmentDirs.map(({ kind, dir }) => {
		// 段清点、派生行与这一段报出的 issue 出自同一次扫描：脚本自己再列一遍目录，
		// 两次结果不一致时（中途增删条目）报告里的「条目文件数」与派生行数就对不上，
		// 而那正是读报告的人唯一能自查的抓手。读法与注入侧同源（只读文件头），
		// 故派生行与判据量的是同一段文本
		const scan = scanSegment(dir, { read: readEntryHead, report: record(kind) })
		const names = scan?.names ?? []
		const lines = scan?.lines ?? []
		return {
			kind,
			dir,
			lines,
			chars: lines.join('\n').length,
			// 条目文件数与派生行数分列：两者的差就是被拒条目数，合在一列里这个差值看不见
			entryFiles: names.filter(isEntryName).length,
			overLine: lines.filter((line) => line.length > INDEX_LINE_CHAR_BUDGET),
			retired: names.filter(isRetiredIndexFile),
		}
	})
	// 节重名查的是正文，头读那份窗口看不到——这一项自己整篇读（与体检同一读法；读法是
	// 消费方的知识）。逐文件降级：读不动的条目已由 entry-readable 认领 read-error，
	// 这里跳过不重复报。issue kind entry-section-dup 由 entry-section-dup 检查项认领
	// ——没人认领的新 kind 会被 issue-unclaimed 兜住，那是 CHECKS 数组结构给的保险
	for (const { kind, dir } of segmentDirs) {
		let names
		try {
			names = readdirSync(dir)
		} catch {
			continue // 段目录读不动已在扫描期以 read-error 入账
		}
		for (const name of names) {
			if (!isEntryName(name)) continue
			const path = join(dir, name)
			try {
				for (const title of duplicateSectionHeadings(readFileSync(path, 'utf8'))) {
					issues.push({ kind, issue: 'entry-section-dup', path, detail: sectionDupNotice(title) })
				}
			} catch {
				continue // 单文件读失败已在扫描期以 read-error 入账
			}
		}
	}
	// 写侧纪律的字符数读不到即记一条 issue：静默归 0 会让整块变小、block-chars 随之达标，
	// 脚本印「全部达标」，而规则块在运行期是被 warn 掉的——规则被静默丢掉比超预算更难查
	const rulesPath = join(root.store, WRITING_FILE)
	let rulesChars = 0
	try {
		rulesChars = readFileSync(rulesPath, 'utf8').length
	} catch (error) {
		record('写侧纪律')('read-error', rulesPath, describeError(error))
	}
	// 机器 id 不合规（与 config.machine 同值域）在这里就拦：它是路径的一段，放过去会让
	// 后面每一次 resolveScopeDir 都抛，而机器名写错该报的是「这个名字不合规」而不是崩溃。
	// 不合规时后面一律按「没给机器身份」装配：否则 composeMemory 会在这句话之后当场抛，
	// 报告一个字都印不出来——那正是一个「写错参数就零输出」的假绿形态
	let machineDir = ''
	let machineDirExists = false
	let machineValid = false
	if (isNonBlankString(machine)) {
		try {
			// 机器身份先过 assertMachineId 而不是借 resolveScopeDir 顺带校验：后者收的是段值域，
			// 会把保留字 shared 放行成机器名——本机段与共享段落进同一个目录，注入块里同一段
			// 内容出现两遍、对机段整段漏装，而报告照样印「全部达标」
			assertMachineId(machine)
			machineDir = resolveScopeDir(root, machine)
			machineDirExists = existsSync(machineDir)
			machineValid = true
		} catch (error) {
			machineDir = join(root.store, MACHINES_DIR, machine)
			record('机器身份')('bad-machine', machine, describeError(error))
		}
	}
	// 装配侧的 issue 与段扫描走同一个收集器：少了它，WRITING.md 与段目录的读失败一条都进不了
	// 现场，而块却照样算出来、照样被判达标
	const block = composeMemory({ memoryRoot, machine: machineValid ? machine : '', onIssue: record('注入块') })
	return {
		root,
		memoryRoot,
		rootGiven,
		machine,
		machineGiven,
		segments,
		issues,
		block,
		machineDir,
		machineDirExists,
		machineValid,
		rulesChars,
	}
}

/**
 * 检查项：id 是稳定的短名（报告与自报名单里出现的就是它），label 说这一项在管什么，
 * guard 说它守的判据——判据里的数值全部由 core.js 的常量插值，不在脚本里另抄一份，
 * 常量一改这里自动跟着改。run(site) 返回该站场上这一项待收敛的条目（人读的一行一个）。
 * claims 列出这一项**认领**的 issue kind：认领是显式登记的，于是「扫描出了没人认领的
 * issue kind」本身成为一项可判的事（见 issue-unclaimed），而不是随报告一起无声消失。
 */
export const CHECKS = [
	{
		id: 'memory-root-wired',
		label: '记忆根接上了线且扫得到条目（扫到 0 条不是「没有问题」，是「什么都没检」）',
		guard: 'store 顶层或 machines/ 下某个机器段扫到 ≥1 条 .md（段按条目数算，空目录不算）',
		run: (site) => {
			// 判「段在场」按有条目的段算而不是按目录数：空 machines/<id>/ 是首跑常态，拿它当
			// 「扫到了东西」会让「共享段 0 条＋本机段空」报成「N 项检查全过」——正是这一项
			// label 说的那种空跑假绿
			const filled = site.segments.filter((segment) => (segment.entryFiles ?? 0) > 0)
			if (filled.length > 0) return []
			return [
				`记忆根下扫到 0 条条目：${site.root.store} 顶层与 machines/ 下各段都没有 .md——本次一份条目都没扫，报成「${CHECKS.length} 项检查全过」与空跑同形。先接线（见 README），或把第一个实参指向真正在用的记忆根`,
			]
		},
	},
	{
		id: 'segment-index-lines',
		label: '段内索引行数在逐段预算内',
		guard: `INDEX_LINE_BUDGET=${INDEX_LINE_BUDGET}`,
		run: (site) =>
			site.segments
				.filter((segment) => segment.lines.length > INDEX_LINE_BUDGET)
				.map((segment) => `${segment.kind}：索引 ${segment.lines.length} 行超 ${INDEX_LINE_BUDGET} 行预算（注入会被截断）`),
	},
	{
		id: 'segment-index-chars',
		label: '段内索引字符数在逐段预算内',
		guard: `INDEX_CHAR_BUDGET=${INDEX_CHAR_BUDGET}`,
		run: (site) =>
			site.segments
				.filter((segment) => segment.chars > INDEX_CHAR_BUDGET)
				.map((segment) => `${segment.kind}：索引 ${segment.chars} 字符超 ${INDEX_CHAR_BUDGET} 字符预算（注入会被截断）`),
	},
	{
		id: 'entry-index-line',
		label: '单条派生索引行在行预算内',
		guard: `INDEX_LINE_CHAR_BUDGET=${INDEX_LINE_CHAR_BUDGET}`,
		run: (site) =>
			site.segments.flatMap((segment) =>
				segment.overLine.map((line) => `${segment.kind}：派生索引行 ${line.length} 字符超 ${INDEX_LINE_CHAR_BUDGET} —— ${line}`),
			),
	},
	{
		id: 'entry-frontmatter',
		label: '条目 frontmatter 契约合于两键规范形',
		guard: `FRONTMATTER_KEYS=${FRONTMATTER_KEYS.join('＋')}`,
		claims: ['entry-frontmatter'],
		run: (site) =>
			site.issues
				.filter((item) => item.issue === 'entry-frontmatter')
				.map((item) => `${item.kind}：${item.path} —— ${item.detail}`),
	},
	{
		id: 'entry-readable',
		label: `条目、段目录与写侧纪律 ${WRITING_FILE} 读得动（读失败即失去判定覆盖面，不许静默）`,
		guard: `扫描期 read-error issue（段目录、${WRITING_FILE} 与注入块装配三路都收）`,
		claims: ['read-error'],
		run: (site) => site.issues.filter((item) => item.issue === 'read-error').map((item) => `${item.kind}：${item.path} —— ${item.detail}`),
	},
	{
		id: 'retired-index-file',
		label: '段内没有退役的索引文件残留',
		guard: `保留名折叠后等于 ${RETIRED_INDEX_NAME} 的文件（大小写不敏感）`,
		run: (site) =>
			site.segments
				.filter((segment) => segment.retired.length > 0)
				.map((segment) => `${segment.kind}：${segment.retired.map((name) => join(segment.dir, name)).join('、')} 是已退役的索引文件（索引由条目 frontmatter 现场派生，不再读它）——删掉它`),
	},
	{
		id: 'segment-title-dup',
		label: '段内没有 title 重名（撞名的各行在注入块里按 title 分不出谁是谁）',
		guard: '按 frontmatter 的 title 字段分组，同组 >1 即判红；title 判不了的条目不占坑',
		claims: ['segment-title-dup'],
		// 文案不再自己渲染：detail 出自 frontmatter.js 那份共享渲染点，与体检 warning、
		// 写侧报错同一份口径；这里只补上「哪一段」这半句定位前缀
		run: (site) => site.issues.filter((item) => item.issue === 'segment-title-dup').map((item) => `${item.kind}：${item.detail}`),
	},
	{
		id: 'segment-title-coverage',
		label: '段内 title 判定覆盖得到整段（判不了 title 的条目不参与重名比对，缺口得说出来）',
		guard: '扫描期 segment-title-coverage issue（每段一条，与该段有无撞名无关）',
		claims: ['segment-title-coverage'],
		run: (site) => site.issues.filter((item) => item.issue === 'segment-title-coverage').map((item) => `${item.kind}：${item.detail}`),
	},
	{
		id: 'entry-section-dup',
		label: '条目内没有重名的 ## 节标题（edit 按节锚定以标题为锚，重名即分不清锚在哪）',
		guard: '整篇读条目正文，同一 ## 标题（去空白后）出现 ≥2 即判红；只查重名不查无节——无节条目是语料迁移收口前的存量常态',
		claims: ['entry-section-dup'],
		// detail 出自 patterns 的共享渲染点（与体检 warning 同一份口径），这里补上「哪一段」定位
		run: (site) => site.issues.filter((item) => item.issue === 'entry-section-dup').map((item) => `${item.kind}：${item.path} —— ${item.detail}`),
	},
	{
		id: 'block-chars',
		label: '注入块整块字符在定档内（运行期不截，这一项只判红）',
		guard: `BLOCK_CHAR_BUDGET=${BLOCK_CHAR_BUDGET}`,
		run: (site) =>
			site.block.length > BLOCK_CHAR_BUDGET
				? [`注入块 ${site.block.length} 字符超 ${BLOCK_CHAR_BUDGET} 整块定档（写侧纪律 ${site.rulesChars} ＋ 两段索引）`]
				: [],
	},
	{
		id: 'machine-arg',
		label: '机器身份在场（空跑不假绿：未给机器 id 而 machines/ 下有条目即判红；给了却没有那个目录也判红）',
		guard: '机器 id 实参非空白且 machines/<id>/ 在场；或未给机器 id 时 machines/ 下没有任何有条目的目录',
		claims: ['bad-machine'],
		run: (site) => {
			const issues = site.issues
				.filter((item) => item.issue === 'bad-machine')
				.map((item) => `机器 id「${item.path}」不合规——${item.detail}`)
			// 配了机器名而目录缺席＝那台机器的条目还没迁进来（lint 判不了这一条：空目录与
			// 首跑不可区分；而离线自检跑在迁移之后，语境明确，缺席就是迁移没做）。
			// 名字不合规那一格由上面的 bad-machine 认领：那时「目录缺席」是同义的第二种说法
			if (site.machineGiven && site.machineValid && !site.machineDirExists) {
				issues.push(`配了机器名 ${site.machine} 却没有私有目录 ${site.machineDir}——先做条目迁移（见 agent-data-sync.md 记忆仓直连节）`)
			}
			// 未给机器 id 而 machines/ 下有条目：本次装配只装共享段，本机段整段缺失，
			// 照印「全部达标」就是空跑假绿
			const withEntries = site.segments.filter((segment) => segment.kind !== SHARED_SEGMENT && segment.entryFiles > 0)
			if (!site.machineGiven && withEntries.length > 0) {
				issues.push(`未给机器 id 参数：machines/ 下有 ${withEntries.length} 个有条目的机器段（${withEntries.map((segment) => segment.kind).join('、')}），本次注入只装共享段、本机段整段缺失——空跑。要真检某台机器请带上 <记忆根> <机器id>`)
			}
			return issues
		},
	},
	{
		id: 'issue-unclaimed',
		label: '扫描出的 issue kind 都有人认领（新 kind 不许无声消失）',
		guard: '各检查项 claims 的并集覆盖现场出现的 issue kind',
		run: (site) => {
			const claimed = new Set(CHECKS.flatMap((check) => check.claims ?? []))
			const unclaimed = [...new Set(site.issues.map((item) => item.issue))].filter((kind) => !claimed.has(kind))
			if (unclaimed.length === 0) return []
			return [
				`出现无人认领的 issue kind：${unclaimed.join('、')}——扫描器（assemble.js）长出新 kind 而没有检查项认领时，它不会出现在报告里。加一个认领它的检查项（claims 登记 + run 判它）`,
			]
		},
	},
]

/** 跑完一份检查项数组，返回全部待收敛条目（带 id，报告与自报名单靠它对上）。 */
export function collectViolations(site) {
	return CHECKS.flatMap((check) => check.run(site).map((text) => ({ id: check.id, text })))
}

/**
 * 报告：现场清点 → 逐项判定 → 自报名单。末段清单由 CHECKS 生成而不是手抄文案常量——
 * 另写一份就是给「覆盖了哪几项」造出下一次改动就会漂的旁证，而这正是本检查存在的理由。
 * 「全部达标」那句也不枚举覆盖范围：枚举一份只点了三类的清单，等于在本文件里养第二份真相。
 */
export function renderReport(site) {
	const out = []
	const push = (line = '') => out.push(line)
	push(`共享段：${site.root.store}`)
	// 记忆根取自哪个来源要印出来：空串回落成默认根时，那不是调用方要检的那个语料，
	// 而报告里的一切数字都是相对它量的
	push(`记忆根来源：${site.rootGiven ? '本次实参' : '默认值（未显式给出）'}`)
	push(`机器 id（决定本机段）：${site.machineGiven ? site.machine : '（未给）'}`)
	push()
	push('段\t条目文件\t派生行\t索引字符\t最长行\t超单行预算')
	for (const segment of site.segments) {
		const longest = segment.lines.length === 0 ? 0 : Math.max(...segment.lines.map((line) => line.length))
		push(`${segment.kind}\t${segment.entryFiles}\t${segment.lines.length}\t${segment.chars}\t${longest}\t${segment.overLine.length}`)
	}
	// 未给机器 id 时这一栏只数到共享段：说清是「本次装配本就如此」还是「机器名给错了」，
	// 否则报告里的字符数会被当成全量而误判
	push()
	push(`注入块（机器 ${site.machineGiven ? site.machine : '未给'}）：${site.block.length} 字符／${site.block.split('\n').length} 行（含规则块与索引）`)
	if (!site.machineGiven) {
		// 「只有共享段」在没给机器 id 时是预期形态，但注入块本身也少了本机段与尾行——
		// 这句话是把「本次量到的不是全量」说清楚，判红的那一项另说
		push('提示：未给机器 id，本次装配只有共享段（本机段与尾行均不含本机）')
	}
	push(
		`预算：段内索引 ${INDEX_LINE_BUDGET} 行／${INDEX_CHAR_BUDGET} 字符（逐段），派生行 ${INDEX_LINE_CHAR_BUDGET} 字符，整块 ${BLOCK_CHAR_BUDGET} 字符`,
	)
	push(`其中写侧纪律 ${WRITING_FILE} 占 ${site.rulesChars} 字符`)
	push()
	if (site.block.length === 0) push('（无内容：记忆根未接线，或共享段与本机段都无条目）')

	const violations = collectViolations(site)
	if (violations.length > 0) {
		push(`${violations.length} 项待收敛：`)
		// 病灶带检查项 id：报告与下面的自报名单靠它对上，读者不必逐条猜是哪一项在拦
		for (const violation of violations) push(`  · [${violation.id}] ${violation.text}`)
	} else {
		push(`全部达标：${CHECKS.length} 项检查全过（逐项见下）。`)
	}
	push()
	push(`本命令覆盖 ${CHECKS.length} 项（检查项数组即清单，改这一份就够）：`)
	for (const check of CHECKS) push(`  ${check.id}\t${check.label}\t守：${check.guard}`)
	return { report: out.join('\n'), violations }
}
