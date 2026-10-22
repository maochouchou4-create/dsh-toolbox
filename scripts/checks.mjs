/**
 * 注入块离线自检的采集与检查两半。同目录的 check-memory-index.mjs 是跑它们的薄壳，
 * 这里单独成文件是因为「一份 .mjs 要兼模块与运行器」逼出了「被直接运行时才执行」的守卫，
 * 而守卫本身就是一处能把自己关掉的判断——`node /tmp/某软链` 调它时 argv[1] 与
 * import.meta.url 不相等，命令于是零输出并以 0 退出：一个「必须绿才算完」的验收闸门
 * 静默变成 no-op，比误报红坏得多（误报红会被看见）。拆成「模块 + 薄壳」之后，两种
 * 入口只剩一种答案，也就没有守卫可写错。
 *
 * 检查面有两族：注入块预算（截不截、超不超线）与条目内容健康（frontmatter 契约、节
 * 组织、死链、日期戳、防膨胀两条线）。memory 写侧工具退役后，后一族是从写侧 lint 收编
 * 过来的——全库体检只剩这一处，判据与文案都沿用同一批共享模块（patterns/segments/
 * frontmatter），不在脚本里另写一份。
 *
 * 零宿主依赖：这里只 import 本仓 lib/memory 下的纯模块与 node 标准库，单测可直接
 * import 本文件拿 CHECKS，不必起子进程才能验一份清单。
 */
import process from 'node:process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { composeMemory, ignoredEntryFiles, readEntryHead, scanSegment } from '../lib/memory/assemble.js'
import {
	BLOCK_CHAR_BUDGET,
	INDEX_CHAR_BUDGET,
	INDEX_LINE_BUDGET,
	INDEX_LINE_CHAR_BUDGET,
	MACHINES_DIR,
	RUNAWAY_CEILING,
	SHARED_SEGMENT,
	assertMachineId,
	resolveScopeDir,
} from '../lib/memory/core.js'
import { DEFAULT_MEMORY_ROOT, describeError, resolveRoot } from '../lib/memory-root.js'
import { findFenceEnd, frontmatterLines, FRONTMATTER_KEYS } from '../lib/memory/frontmatter.js'
import { RESERVED_STEMS, RETIRED_INDEX_NAME, WRITING_FILE, isEntryName, isRetiredIndexFile } from '../lib/memory/naming.js'
import { knownStems, listSegmentDirs } from '../lib/memory/segments.js'
import { duplicateSectionHeadings, forEachWikilinkMatch, sectionDupNotice, sectionHeadings, styleWarnings } from '../lib/memory/patterns.js'
import { isNonBlankString } from '../lib/value.js'

/**
 * 条目级防膨胀两条线。判据只服务本脚本：注入侧不按它们截断（那里只有失控保护与索引
 * 预算两族），故常量不进 core.js——「哪条线在运行期有牙齿」靠分居表达，混进同一处
 * 就要靠读注释分辨。
 *
 * - 单条黄线（ENTRY_LINE_YELLOW）：条目正文行数超线只出提示不判红。定档＝排除存量
 *   超线提示后语料正文行上限的上取整档（首档实测：99/152 两条存量之外上限 74，取 80）
 *   ——它是「先收敛再加」的那声提醒，不是闸门；存量超线条目常驻提示正是要的效果（促收不拦行）。
 * - 节长红线（SECTION_LENGTH_RED）：单节行数超线判红。定档取现存最长一节的上方一档
 *   ——红线必须让现行语料通过，否则每次自检都在报一批改不了的旧账，红线很快被习惯性
 *   无视；同时把「一节吞掉大半条」的形态拦在下次追加之前。分布是中段断档的（多数节
 *   十几行、个别长节远超），红线落位看的是最长那档而非中位数。
 *
 * 确需抬线先重新实测分布，把新实测值与理由写进 commit message——这两条线没有运行期
 * 消费方，注释里的数字最容易陈旧，实测值归 git 历史。
 */
export const ENTRY_LINE_YELLOW = 80
export const SECTION_LENGTH_RED = 60

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
	// 实参双形都收：记忆根（store＝<根>/memory）或记忆目录本身（…/memory，root 取其父目录）。
	// 注入块头句给人看的基目录就是记忆目录，照抄那条路径是最自然的用法，不该换来「路径叠成
	// memory/memory」的假红；归一只在脚本入口做，resolveRoot 本身保持单形（dispatch 台账与
	// 使用日志共用它，另一套口径会在那里分家）。环境变量与缺省值保持纯根语义——名字就叫 ROOT。
	const given = argv[2]
	const memoryRoot = (isNonBlankString(given) && given.endsWith('/memory') ? dirname(given) : given) || env.DSH_MEMORY_ROOT || DEFAULT_MEMORY_ROOT
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
			// 非 kebab 名的 .md 按同一份判据不算条目，于是既不进 entryFiles 也不进派生行——
			// 报告要能说出这块钱去哪了，否则读者只看到数字比盘上文件数少
			ignored: ignoredEntryFiles(dir, names),
			// 风格告警（日期戳等）从头扫描的派生行与 description 现算：判据问 patterns
			// 的单源，采的是头读那一次读盘的产物，不为风格再读一遍。派生行超长那一半
			// 不收（按 kind 拣选）——它是 entry-index-line 的事实，这里再报就是同一件事两行
			styles: (scan?.entries ?? [])
				.filter((entry) => entry.indexLine !== null)
				.flatMap((entry) =>
					styleWarnings({ description: entry.parsed.frontmatter.description, indexLine: entry.indexLine })
						.filter((warning) => warning.kind === 'date-stamp')
						.map((warning) => ({ name: entry.name, text: warning.text })),
				),
		}
	})
	// 正文族检查（节长、死链、失控、节重名）查的是整篇，头读那份窗口看不到——这一趟
	// 自己整篇读（与读侧失控读取同一读法；读法是消费方的知识）。逐文件降级：读不动的
	// 条目已由 entry-readable 认领 read-error，这里跳过不重复报。
	// 重名判定与节长度量各问 patterns 的同一份节判定，不在脚本里自拼「什么算一节」；
	// 死链判据问 segments 的全库 stem 集，头扫描的段清单就是它的段界
	// 收编自写侧 lint 的降级路径：全库 stem 集读不动时退保留名集＋报告记一行，不崩——
	// 崩会把整份报告换成一条栈，降级只可能漏报死链，其余检查照跑
	let stems
	let stemsDegraded = false
	try {
		stems = knownStems(segmentDirs)
	} catch {
		stems = new Set(RESERVED_STEMS)
		stemsDegraded = true
	}
	const entries = []
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
			let text
			try {
				text = readFileSync(path, 'utf8')
			} catch {
				continue // 单文件读失败已在扫描期以 read-error 入账
			}
			const lines = frontmatterLines(text)
			const fenceEnd = findFenceEnd(lines)
			// 无闭合围栏的条目按「全文即正文」量：它已由 entry-frontmatter 判红，
			// 行数量个大概即可，不为坏 frontmatter 另立分支
			const bodyStart = fenceEnd === -1 ? 0 : fenceEnd + 1
			// 以 \n 结尾的文件 split 出的最后一个空串不是一行，剥掉再计
			const bodyEnd = lines.length - (lines[lines.length - 1] === '' ? 1 : 0)
			const headings = sectionHeadings(text)
			const sections = headings.map((heading, index) => ({
				title: heading.title,
				// 节长含节标题行、止于下一节标题（末节止于正文尾）：行号是同一份行数组的
				// 下标，差值即行数，不必再切一次
				len: (index + 1 < headings.length ? headings[index + 1].line : bodyEnd) - heading.line,
			}))
			const deadLinks = []
			forEachWikilinkMatch(text, (stem, line) => {
				if (!stems.has(stem)) deadLinks.push({ stem, line })
			})
			entries.push({ kind, path, name, chars: text.length, bodyLines: bodyEnd - bodyStart, sections, deadLinks })
			for (const title of duplicateSectionHeadings(text)) {
				issues.push({ kind, issue: 'entry-section-dup', path, detail: sectionDupNotice(title) })
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
	// 注入块只取块体：装配侧的诊断回调刻意不接——装配侧那一路是自扫的子集——自扫经
	// listSegmentDirs 覆盖各机器段，装配侧只扫 store 顶层与本机段；接上只会一事两行；
	// 块却照样算出来、照样被判达标
	const block = composeMemory({ memoryRoot, machine: machineValid ? machine : '' })
	return {
		root,
		memoryRoot,
		rootGiven,
		machine,
		machineGiven,
		segments,
		entries,
		issues,
		block,
		machineDir,
		machineDirExists,
		machineValid,
		rulesChars,
		stemsDegraded,
	}
}

/**
 * 检查项：id 是稳定的短名（报告与自报名单里出现的就是它），label 说这一项在管什么，
 * guard 说它守的判据——判据里的数值全部由常量插值，不在脚本里另抄一份，
 * 常量一改这里自动跟着改。run(site) 返回该站场上这一项待收敛的条目（人读的一行一个）。
 * claims 列出这一项**认领**的 issue kind：认领是显式登记的，于是「扫描出了没人认领的
 * issue kind」本身成为一项可判的事（见 issue-unclaimed），而不是随报告一起无声消失。
 * soft: true 的是黄线项：只出提示、不进 violations（判红与提示分档——红是「必须收敛」，
 * 黄是「先收敛再加」；分档的落点在 renderReport 与 collectViolations 的 soft 过滤）。
 */
export const CHECKS = [
	{
		id: 'memory-root-wired',
		label: '记忆根接上了线且扫得到条目（扫到 0 条不是「没有问题」，是「什么都没检」）',
		guard: 'store 顶层或 machines/ 下某个机器段扫到 ≥1 条条目（kebab 名的 .md；段按条目数算，空目录与非条目名不算）',
		run: (site) => {
			// 判「段在场」按有条目的段算而不是按目录数：空 machines/<id>/ 是首跑常态，拿它当
			// 「扫到了东西」会让「共享段 0 条＋本机段空」报成「N 项检查全过」——正是这一项
			// label 说的那种空跑假绿
			const filled = site.segments.filter((segment) => (segment.entryFiles ?? 0) > 0)
			if (filled.length > 0) return []
			// 一条条目都没扫到、段里却躺着 .md：那不是「根没接上线」，是它们全被命名判据挡在门外。
			// 指路接线只会让人去翻 README 找一条本来就接好的线，而该做的是改名
			const ignored = site.segments.reduce((count, segment) => count + (segment.ignored?.length ?? 0), 0)
			if (ignored > 0) {
				return [
					`记忆根下扫到 0 条条目，但有 ${ignored} 个非 kebab 名的 .md 未计入——本次一份条目都没扫，报成「${CHECKS.length} 项检查全过」与空跑同形。改成小写 kebab 名即回到索引（名单见上方段表）`,
				]
			}
			return [
				`记忆根下扫到 0 条条目：${site.root.store} 顶层与 machines/ 下各段都没有 kebab 名的 .md——本次一份条目都没扫，报成「${CHECKS.length} 项检查全过」与空跑同形。先接线（见 README），或把第一个实参指向真正在用的记忆根`,
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
		guard: `扫描期 read-error issue（段扫描与 ${WRITING_FILE} 两路都收）`,
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
		// 文案不再自己渲染：detail 出自 frontmatter.js 那份共享渲染点，与注入侧告警
		// 同一份口径；这里只补上「哪一段」这半句定位前缀
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
		label: '条目内没有重名的 ## 节标题（节标题是条目里唯一的锚，重名即分不清指哪节）',
		guard: '整篇读条目正文，同一 ## 标题（去空白后）出现 ≥2 即判红；只查重名不查无节——无节条目是存量常态',
		claims: ['entry-section-dup'],
		// detail 出自 patterns 的共享渲染点，这里补上「哪一段」定位
		run: (site) => site.issues.filter((item) => item.issue === 'entry-section-dup').map((item) => `${item.kind}：${item.path} —— ${item.detail}`),
	},
	{
		id: 'entry-section-length',
		label: `单节行数在红线上（一节吞掉大半条＝该收敛或该拆条的膨胀形态）`,
		guard: `SECTION_LENGTH_RED=${SECTION_LENGTH_RED}（行；现存最长一节的上方一档，抬线先重测分布）`,
		run: (site) =>
			site.entries.flatMap((entry) =>
				entry.sections
					.filter((section) => section.len > SECTION_LENGTH_RED)
					.map((section) => `${entry.kind}：${entry.path} 的节「${section.title}」${section.len} 行超红线 ${SECTION_LENGTH_RED}——先收敛该节（销账即删、活事实归位），或把这一节拆成独立条目`),
			),
	},
	{
		id: 'entry-runaway',
		label: '单条字符数在失控保护内（超线注入侧会截断丢尾，且只留一句截断标注）',
		guard: `RUNAWAY_CEILING=${RUNAWAY_CEILING}（字符，与注入侧 readCapped 同一份常量）`,
		run: (site) =>
			site.entries
				.filter((entry) => entry.chars > RUNAWAY_CEILING)
				.map((entry) => `${entry.kind}：条目 ${entry.name} ${entry.chars} 字符超失控保护 ${RUNAWAY_CEILING}（注入会被截断丢尾）——收敛正文或拆条`),
	},
	{
		id: 'entry-dead-link',
		label: '条目内 wikilink 都有所指（死链的另一半「删条目清引用」靠写的人当场做）',
		guard: '[[stem]] 的 stem 落在全库已知 stem 集（segments.knownStems，含保留名）内；判不出所指即判红',
		run: (site) =>
			site.entries.flatMap((entry) =>
				entry.deadLinks.map((link) => `${entry.kind}：${entry.path}:${link.line} 的 [[${link.stem}]] 无所指（全库没有这个名字的条目）——改指现存条目，或删掉这处引用`),
			),
	},
	{
		id: 'entry-date-stamp',
		label: '条目 description 不带日期戳（时序归 git；日期会让触发器「过期」而不自知）',
		guard: 'description 含 YYYY-MM-DD 形态即判红（判据问 patterns.styleWarnings 单源）',
		run: (site) =>
			site.segments.flatMap((segment) =>
				segment.styles.map((style) => `${segment.kind}：条目 ${style.name} —— ${style.text}`),
			),
	},
	{
		id: 'entry-lines-hint',
		label: '单条正文行数在黄线下（超线是「先收敛再加」的提醒，不是闸门）',
		guard: `ENTRY_LINE_YELLOW=${ENTRY_LINE_YELLOW}（行；排除存量提示后语料上限 74 的上取整档）`,
		soft: true,
		run: (site) =>
			site.entries
				.filter((entry) => entry.bodyLines > ENTRY_LINE_YELLOW)
				.map((entry) => `${entry.kind}：条目 ${entry.name} 正文 ${entry.bodyLines} 行过黄线 ${ENTRY_LINE_YELLOW}——追加前先收敛：销账段删掉、活事实归位`),
	},
	{
		id: 'block-chars',
		label: '注入块整块字符在定档内（运行期不截，这一项只判红）',
		guard: `BLOCK_CHAR_BUDGET=${BLOCK_CHAR_BUDGET}`,
		run: (site) =>
			site.block.length > BLOCK_CHAR_BUDGET
				? [`注入块 ${site.block.length} 字符超 ${BLOCK_CHAR_BUDGET} 整块定档（写侧纪律 ${site.rulesChars} ＋ 两段索引 ＋ 引导行）`]
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
			// 配了机器名而目录缺席＝那台机器的条目还没迁进来（头扫描判不了这一条：空目录与
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

/** 跑完一份检查项数组，返回全部待收敛条目（带 id，报告与自报名单靠它对上）。黄线项不进这里。 */
export function collectViolations(site) {
	return CHECKS.filter((check) => !check.soft).flatMap((check) => check.run(site).map((text) => ({ id: check.id, text })))
}

/**
 * 报告：现场清点 → 逐项判定 → 黄线提示 → 自报名单。末段清单由 CHECKS 生成而不是手抄文案
 * 常量——另写一份就是给「覆盖了哪几项」造出下一次改动就会漂的旁证，而这正是本检查存在的
 * 理由。「全部达标」那句也不枚举覆盖范围：枚举一份只点几类的清单，等于在本文件里养第二份
 * 真相。
 */
export function renderReport(site) {
	const out = []
	const push = (line = '') => out.push(line)
	push(`共享段：${site.root.store}`)
	// 记忆根取自哪个来源要印出来：空串回落成默认根时，那不是调用方要检的那个语料，
	// 而报告里的一切数字都是相对它量的
	push(`记忆根来源：${site.rootGiven ? '本次实参' : '默认值（未显式给出）'}`)
	push(`机器 id（决定本机段）：${site.machineGiven ? site.machine : '（未给）'}`)
	if (site.stemsDegraded) push('⚠ 死链判定降级：全库 stem 集读不动，保留名集兜底——死链可能漏报，其余检查照跑')
	push()
	push('段\t条目文件\t派生行\t索引字符\t最长行\t超单行预算')
	for (const segment of site.segments) {
		const longest = segment.lines.length === 0 ? 0 : Math.max(...segment.lines.map((line) => line.length))
		push(`${segment.kind}\t${segment.entryFiles}\t${segment.lines.length}\t${segment.chars}\t${longest}\t${segment.overLine.length}`)
		// 表里的「条目文件」一列只数 kebab 名的条目，被命名判据挡在门外的那些得另起一行说出去向：
		// 这一句是报告文本，不进 CHECKS——「不算条目」不是「待修错误」，判红就是给读者一个不存在的待办
		if (segment.ignored.length > 0) push(`${segment.kind}：${segment.ignored.length} 个文件因非 kebab 名未进索引——${segment.ignored.join('、')}`)
	}
	// 未给机器 id 时这一栏只数到共享段：说清是「本次装配本就如此」还是「机器名给错了」，
	// 否则报告里的字符数会被当成全量而误判
	push()
	// 行数按内容行计：空树时块为空串，行数是 0 而不是 split 出来的那一行
	const blockLines = site.block === '' ? 0 : site.block.trimEnd().split('\n').length
	push(`真实注入块（机器 ${site.machineGiven ? site.machine : '未给'}）：${site.block.length} 字符／${blockLines} 行（含规则块与索引）`)
	if (!site.machineGiven) {
		// 「只有共享段」在没给机器 id 时是预期形态，但注入块本身也少了本机段与尾行——
		// 这句话是把「本次量到的不是全量」说清楚，判红的那一项另说
		push('提示：未给机器 id，本次装配只有共享段（本机段与尾行均不含本机）')
	}
	push(
		`预算：段内索引 ${INDEX_LINE_BUDGET} 行／${INDEX_CHAR_BUDGET} 字符（逐段），派生行 ${INDEX_LINE_CHAR_BUDGET} 字符，整块 ${BLOCK_CHAR_BUDGET} 字符；防膨胀线：单条黄线 ${ENTRY_LINE_YELLOW} 行（不判红），单节红线 ${SECTION_LENGTH_RED} 行`,
	)
	push(`其中写侧纪律 ${WRITING_FILE} 占 ${site.rulesChars} 字符`)
	push()
	if (site.block.length === 0) push('（记忆内容为空：记忆根未接线，或共享段与本机段都无条目——注入块为空，宿主滤除）')

	const violations = collectViolations(site)
	if (violations.length > 0) {
		push(`${violations.length} 项待收敛：`)
		// 病灶带检查项 id：报告与下面的自报名单靠它对上，读者不必逐条猜是哪一项在拦
		for (const violation of violations) push(`  · [${violation.id}] ${violation.text}`)
	} else {
		push(`全部达标：${CHECKS.length} 项检查全过（逐项见下）。`)
	}
	// 黄线提示单独一段、用「~」前缀：不进 violations、不参与退出码，行形也与病灶行分开，
	// 「必须收敛」与「可以先收敛」两股流在报告与测试里都各认各的
	const hints = CHECKS.filter((check) => check.soft).flatMap((check) => check.run(site).map((text) => ({ id: check.id, text })))
	if (hints.length > 0) {
		push(`${hints.length} 条黄线提示（不判红）：`)
		for (const hint of hints) push(`  ~ [${hint.id}] ${hint.text}`)
	}
	push()
	push(`本命令覆盖 ${CHECKS.length} 项（检查项数组即清单，改这一份就够）：`)
	for (const check of CHECKS) push(`  ${check.id}\t${check.label}\t守：${check.guard}`)
	return { report: out.join('\n'), violations }
}
