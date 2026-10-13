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
import { buildIndexBlock, composeMemory } from '../lib/memory/assemble.js'
import {
	BLOCK_CHAR_BUDGET,
	DEFAULT_MEMORY_ROOT,
	INDEX_CHAR_BUDGET,
	INDEX_LINE_BUDGET,
	INDEX_LINE_CHAR_BUDGET,
	describeError,
	resolveRoot,
	workspaceSlug,
} from '../lib/memory/core.js'
import { FRONTMATTER_KEYS, RETIRED_INDEX_NAME, WRITING_FILE, isEntryName, isRetiredIndexFile } from '../lib/memory/frontmatter.js'
import { listLayerDirs } from '../lib/memory/layers.js'
import { isNonBlankString } from '../lib/value.js'

/**
 * 取参与否收在参数对象里：薄壳与单测从这里拿「给了什么」，不从 process.argv 现场解析。
 *
 * 「给了」问 lib/value.js 那份跨族原语——本文件要与 dsh-memory 的 Config 回退判同一件事，
 * 两者各抄一份时「算不算给了」就在脚本与插件之间分叉。判的是解析后的值而不是数位置参数
 * 个数：空串与纯空白经 `||` 回落后与缺参同形，可它们仍是调用方**写下来**的形参，判据必须
 * 看得见这件事——`node scripts/check-memory-index.mjs "" ""` 收了两个空串，脚本却拿
 * process.cwd() 去算桶，然后拿只量到习惯层的块印「全部达标」，那是「检查没跑」却报成功。
 */
export function readOptions(argv = process.argv, env = process.env) {
	// 用 `||` 不用 `??`：显式传空串（想只跑默认值）不该被当成「记忆根就是当前目录」，
	// 那会让脚本在一片空地上报「全部达标」
	const memoryRoot = argv[2] || env.DSH_MEMORY_ROOT || DEFAULT_MEMORY_ROOT
	const cwd = argv[3] || process.cwd()
	return {
		memoryRoot,
		cwd,
		rootGiven: isNonBlankString(argv[2]),
		cwdGiven: isNonBlankString(argv[3]),
	}
}

/**
 * 采集：跑一遍注入侧同一份扫描，把各检查项要判的东西一次性收齐。
 * 检查项只读现场，不自己再去读盘——检查与采集各读一次盘，两者就会在「读到哪一刻」上分家。
 */
export function collectSite({ memoryRoot, cwd, rootGiven, cwdGiven }) {
	const root = resolveRoot(memoryRoot)
	const issues = []
	const record = (kind) => (issue, path, detail) => {
		issues.push({ kind, issue, path, detail })
	}
	const layers = listLayerDirs(root).map(({ kind, dir }) => {
		// 一次 readdir 同时收派生行与文件名两样东西：清点与派生出自同一层目录，
		// 各读一次就等于赌两次读看到的是同一个目录状态
		const names = readdirSync(dir)
		const text = buildIndexBlock(dir, record(kind))
		const lines = text === null ? [] : text.split('\n')
		return {
			kind,
			dir,
			lines,
			chars: text?.length ?? 0,
			// 条目文件数与派生行数分列：两者的差就是被拒条目数，合在一列里这个差值看不见
			entryFiles: names.filter(isEntryName).length,
			overLine: lines.filter((line) => line.length > INDEX_LINE_CHAR_BUDGET),
			retired: names.filter(isRetiredIndexFile),
		}
	})
	// 写侧纪律的字符数读不到即记一条 issue：静默归 0 会让整块变小、block-chars 随之达标，
	// 脚本印「全部达标」，而规则块在运行期是被 warn 掉的——规则被静默丢掉比超预算更难查
	const rulesPath = join(root.profile, WRITING_FILE)
	let rulesChars = 0
	try {
		rulesChars = readFileSync(rulesPath, 'utf8').length
	} catch (error) {
		record('写侧纪律')('read-error', rulesPath, describeError(error))
	}
	// 装配侧的 issue 与层扫描走同一个收集器：少了它，WRITING.md 与层目录的读失败一条都进不了
	// 现场，而块却照样算出来、照样被判达标
	const block = composeMemory({ memoryRoot, cwd, onIssue: record('注入块') })
	const bucket = workspaceSlug(cwd)
	return {
		root,
		memoryRoot,
		rootGiven,
		cwd,
		cwdGiven,
		layers,
		issues,
		block,
		bucket,
		bucketExists: existsSync(join(root.workspaces, bucket)),
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
		label: '记忆根接上了线且扫得到层（扫到 0 层不是「没有问题」，是「什么都没检」）',
		guard: `记忆根存在且 listLayerDirs 扫到 ≥1 层（profile/ 与 workspaces/*）`,
		run: (site) => (site.layers.length === 0
			? [
					`记忆根下扫到 0 层：${site.root.profile} 的父目录 ${site.root.workspaces} 不存在或无子目录——本次一份条目都没扫，报成「${CHECKS.length} 项检查全过」与空跑同形。先接线（见 README），或把第一个实参指向真正在用的记忆根`,
				]
			: []),
	},
	{
		id: 'layer-index-lines',
		label: '层内索引行数在逐层预算内',
		guard: `INDEX_LINE_BUDGET=${INDEX_LINE_BUDGET}`,
		run: (site) =>
			site.layers
				.filter((layer) => layer.lines.length > INDEX_LINE_BUDGET)
				.map((layer) => `${layer.kind}：索引 ${layer.lines.length} 行超 ${INDEX_LINE_BUDGET} 行预算（注入会被截断）`),
	},
	{
		id: 'layer-index-chars',
		label: '层内索引字符数在逐层预算内',
		guard: `INDEX_CHAR_BUDGET=${INDEX_CHAR_BUDGET}`,
		run: (site) =>
			site.layers
				.filter((layer) => layer.chars > INDEX_CHAR_BUDGET)
				.map((layer) => `${layer.kind}：索引 ${layer.chars} 字符超 ${INDEX_CHAR_BUDGET} 字符预算（注入会被截断）`),
	},
	{
		id: 'entry-index-line',
		label: '单条派生索引行在行预算内',
		guard: `INDEX_LINE_CHAR_BUDGET=${INDEX_LINE_CHAR_BUDGET}`,
		run: (site) =>
			site.layers.flatMap((layer) =>
				layer.overLine.map((line) => `${layer.kind}：派生索引行 ${line.length} 字符超 ${INDEX_LINE_CHAR_BUDGET} —— ${line}`),
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
		label: `条目、层目录与写侧纪律 ${WRITING_FILE} 读得动（读失败即失去判定覆盖面，不许静默）`,
		guard: `扫描期 read-error issue（层目录、${WRITING_FILE} 与注入块装配三路都收）`,
		claims: ['read-error'],
		run: (site) => site.issues.filter((item) => item.issue === 'read-error').map((item) => `${item.kind}：${item.path} —— ${item.detail}`),
	},
	{
		id: 'retired-index-file',
		label: '层内没有退役的索引文件残留',
		guard: `保留名折叠后等于 ${RETIRED_INDEX_NAME} 的文件（大小写不敏感）`,
		run: (site) =>
			site.layers
				.filter((layer) => layer.retired.length > 0)
				.map((layer) => `${layer.kind}：${layer.retired.map((name) => join(layer.dir, name)).join('、')} 是已退役的索引文件（索引由条目 frontmatter 现场派生，不再读它）——删掉它`),
	},
	{
		id: 'block-chars',
		label: '注入块整块字符在定档内（运行期不截，这一项只判红）',
		guard: `BLOCK_CHAR_BUDGET=${BLOCK_CHAR_BUDGET}`,
		run: (site) =>
			site.block.length > BLOCK_CHAR_BUDGET
				? [`注入块 ${site.block.length} 字符超 ${BLOCK_CHAR_BUDGET} 整块定档（写侧纪律 ${site.rulesChars} ＋ 两层索引）`]
				: [],
	},
	{
		id: 'workspace-bucket',
		label: '工作区桶在场（空跑不假绿：工作区 cwd 没给全——缺参、空串、纯空白都算——即判红）',
		guard: '工作区 cwd 实参非空白且该桶在场',
		run: (site) => {
			if (site.bucket.length === 0 || site.bucketExists) return []
			// 桶不在场与「工作区 cwd 没给」是两件事：给了有效 cwd 而桶不在＝新工作区，
			// 属常态、只提示；没给则是整块定档只量到习惯层的空跑，照印「全部达标」＝假绿
			if (site.cwdGiven) return []
			return [
				`未给工作区 cwd 参数（空串与纯空白按没给算）：按进程 cwd=${site.cwd} 算出桶 ${site.bucket}，而它不存在——整块定档只量到习惯层，本次是空跑。要真检某个工作区请带上 <记忆根> <工作区 cwd>`,
			]
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
	push(`习惯层：${site.root.profile}`)
	// 记忆根取自哪个来源要印出来：空串回落成默认根时，那不是调用方要检的那个语料，
	// 而报告里的一切数字都是相对它量的
	push(`记忆根来源：${site.rootGiven ? '本次实参' : '默认值（未显式给出）'}`)
	push(`工作区 cwd（决定装配哪一层）：${site.cwd}`)
	push()
	push('层\t条目文件\t派生行\t索引字符\t最长行\t超单行预算')
	for (const layer of site.layers) {
		const longest = layer.lines.length === 0 ? 0 : Math.max(...layer.lines.map((line) => line.length))
		push(`${layer.kind}\t${layer.entryFiles}\t${layer.lines.length}\t${layer.chars}\t${longest}\t${layer.overLine.length}`)
	}
	// cwd 的桶不在场时这一栏只数到习惯层：说清是「本次装配本就如此」还是「桶名算错了」，
	// 否则报告里的字符数会被当成全量而误判
	push()
	push(`注入块（cwd=${site.cwd}，桶 ${site.bucket}）：${site.block.length} 字符／${site.block.split('\n').length} 行（含规则块与索引）`)
	if (site.bucket.length > 0 && !site.bucketExists) {
		// 「属常态」只在工作区 cwd 有效给出时成立：那时桶不在场确实只说明这是新工作区；
		// 没给全时这句话是在替一次空跑打圆场，判红的那一项已经把它说清楚了
		push(`提示：该工作区无桶，本次装配只有习惯层${site.cwdGiven ? '（新工作区属常态）' : ''}`)
	}
	push(
		`预算：层内索引 ${INDEX_LINE_BUDGET} 行／${INDEX_CHAR_BUDGET} 字符（逐层），派生行 ${INDEX_LINE_CHAR_BUDGET} 字符，整块 ${BLOCK_CHAR_BUDGET} 字符`,
	)
	push(`其中写侧纪律 ${WRITING_FILE} 占 ${site.rulesChars} 字符`)
	push()
	if (site.block.length === 0) push('（无内容：记忆根未接线，或该工作区尚无桶）')

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