/**
 * dsh-memory 的 lint 动作：全量体检。体检项逐条列在 lintMemory 的 JSDoc 里，此处
 * 不重抄——同一个文件里放两份清单，改一处忘另一处是迟早的事（离线那侧同理，覆盖项
 * 以 scripts/checks.mjs 打印的自报名单为准）。
 *
 * 职责边界：本动作与删除同留 node:fs——宿主沙箱只围栏写入，读与列目录本就不受策略约束，
 * 走端口只是白付 async 成本。体检是写侧的离线镜像，镜像不得比本体弱：同一份判定
 * （frontmatter 契约、条目命名与保留名、各项预算、wikilink 口径）来自 frontmatter.js／
 * naming.js／core.js／patterns.js，
 * 各调用方只补自己的定位前缀，不另抄一份判据。共用件从 segments.js／patterns.js 取而不是
 * 从 delete.js 借——「被谁用到」不构成依赖方向。写侧 upsert/edit 的 I/O 只经 fs 端口那条
 * 硬边界不含本文件，本文件按设计必须直连（test/imports.test.js 按文件判定）。
 *
 * 段扫描经 assemble.js 取（读侧持有，写侧消费）：体检是写侧的离线镜像，而列目录、命名判据、
 * 排序、解析、组判定那几件事只有读侧那一份——两侧各扫一次就会漂，漂出来的症状是体检沉默而
 * 写侧事后拦。方向不可反：读侧不该知道有体检这回事。
 *
 * 「配了机器名却没有 machines/<id>/ 目录」这一条**不在这里**：lint 分不清「迁完条目后的空
 * 目录（冒烟后正常）」与「压根没迁移」，而离线自检跑在迁移之后、语境明确，那一条判给
 * scripts/checks.mjs 的 machine-arg。
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { INDEX_CHAR_BUDGET, INDEX_LINE_BUDGET, RUNAWAY_CEILING, isMachineConfigured } from './core.js'
import { describeError, resolveRoot } from '../memory-root.js'
import { RESERVED_STEMS } from './naming.js'
import { knownStems, listSegmentDirs } from './segments.js'
import { ignoredEntryFiles, scanSegment } from './assemble.js'
import { forEachWikilinkMatch, duplicateSectionHeadings, sectionDupNotice, styleWarnings } from './patterns.js'

/**
 * 体检：条目 frontmatter 契约（缺/多余键）、段内 title 重名、条目内 ## 节重名、
 * description 日期戳与派生行超长、派生索引超预算、条目超失控保护、wikilink 死链、
 * 接线（共享段目录、机器身份已配置）；外加一条信息性提醒——非 kebab 名的 .md 文件未进索引。
 * 索引是派生的，故没有「死索引行」「孤儿条目」两类检查：每个 .md 天生在场。
 * 返回 { ok, warnings[], notices[], machine? }：warnings 是待修项，为空＝健康；notices 是
 * 信息档，不进 ok——「算不算条目」是枚举判据不是合法性判据，判红就等于把「不算条目」说成
 * 「报错待修」（体检刷红一次，改动就成了待办）。两档出自同一次扫描、同一个返回值，不另立
 * 一套报告。
 * machine 只在配置了机器身份时出现（未配置＝该字段缺席，不是 null——宿主验返回值时
 * undefined 跳过、null 会报 ToolOutputError）；未配置本身就是一条判红的 warning。
 * 单个文件/目录读不动时逐处降级报 warning 继续——体检自身不许崩（病态输入只该损失覆盖面，
 * 不该停摆整盘）。
 */
export function lintMemory({ memoryRoot, machine } = {}) {
	const root = resolveRoot(memoryRoot)
	const warnings = []
	const notices = []
	if (!existsSync(root.store)) warnings.push(`共享段接线缺失：${root.store} 不存在（接线见 README）`)
	// 未配置机器身份＝配置不完整（注入只有共享段、写入缺省落共享段），判红促修；共享-only
	// 的功能不受影响，所以这一条是 warning 而不是抛错
	if (!isMachineConfigured(machine)) {
		warnings.push('机器身份未配置（config.machine 缺失）：注入只有共享段、写入缺省落共享段。配置本机机器名见 README')
	}
	let segmentDirs
	try {
		segmentDirs = listSegmentDirs(root)
	} catch (error) {
		warnings.push(`段清点失败（体检中止）：${describeError(error)}`)
		return { ok: false, warnings }
	}
	let stems
	try {
		stems = knownStems(segmentDirs)
	} catch (error) {
		stems = new Set(RESERVED_STEMS)
		warnings.push(`条目清点失败，死链判定降级：${describeError(error)}`)
	}
	for (const { kind, dir } of segmentDirs) {
		// 扫段问 assemble.js 那一份（列目录、命名判据、排序、解析、组判定都在那里），本动作只补
		// 两样它不管的：读法是整篇（wikilink 与失控保护查的是正文，头读那份窗口看不到）与
		// 逐条的体检项。组判定与 frontmatter 判据都问同一份共享函数，两侧各判一次就会漂，
		// 而漂出来的症状是体检沉默而写侧事后拦。之所以要体检撞名这一项：写侧那道拦截只在进程内
		// 拦得住自己，而共享段是跨机 git 同步语料，两台机器各自干净，合流后重名照样留在盘上
		// 并进索引
		const scan = scanSegment(dir, {
			read: (path) => readFileSync(path, 'utf8'),
			report: (issue, path, detail) => {
				// issue 的取值与注入侧、离线自检完全一致（同一份扫描的出口），只有定位前缀
				// 各带各的：体检给的是「段：条目名」这一层，别的两面给的是路径
				if (issue === 'read-error') {
					warnings.push(path === dir
						? `${kind}：目录读取失败——${path}（${detail}）`
						: `${kind}：条目读取失败——${basename(path)}（${detail}）`)
				} else if (issue === 'entry-frontmatter') {
					warnings.push(`${kind}：条目 frontmatter 不合规（该条目不进索引）——${basename(path)}（${detail}）`)
				} else {
					// 撞名与覆盖面缺口的文案问 frontmatter.js 那份共享渲染点（写侧报错、体检
					// warning、离线自检报告三处同源），本层只补上「哪一段」这半句定位前缀
					warnings.push(`${kind}：${detail}`)
				}
			},
		})
		if (scan === null) continue
		// 非 kebab 名的 .md 文件按同一份判据不算条目，于是从注入与索引里安静退场——这里把它们
		// 数出来提一句，让「记忆里那条不见了」有可发现路径。名单取自本次扫描的 names 且只数普通
		// 文件：两次列目录会在中途增删时互相对不上，而同名目录数进来就是报一个不存在的待办
		const ignored = ignoredEntryFiles(dir, scan.names)
		if (ignored.length > 0) {
			notices.push(`${kind}：${ignored.length} 个文件因非 kebab 名未进索引——${ignored.join('、')}（改成 kebab 名即回到索引）`)
		}
		for (const { name, text, parsed, indexLine } of scan.entries) {
			if (parsed.ok) {
				// 文案问写侧那一份（patterns.styleWarnings），本层只补自己的定位：段作前缀、
				// 条目名作后缀，与同函数其余 warning 的定位形态一致
				for (const style of styleWarnings({ description: parsed.frontmatter.description, indexLine })) {
					warnings.push(`${kind}：${style}——${name}`)
				}
				// 节重名只报重名、不报无节：条目全量有节是语料迁移趟的判据，在那之前无节
				// 条目是存量常态（edit 改它们的 frontmatter 还指望这条路畅通），报了就是
				// 整屏噪音；而节重名任何时刻都是真问题——edit 按节锚定以标题为锚，重名即
				// 分不清锚在哪。判定问 patterns 那份共享判定，文案问同一个模块的共享渲染点
				for (const title of duplicateSectionHeadings(text)) {
					warnings.push(`${kind}：${sectionDupNotice(title)}——${name}`)
				}
			}
			// 量的是读进来的正文，不是原始字节：CRLF 归一收在 frontmatter 解析内的单点，
			// 而整篇读与头读两个读法在这层必须给出同一个答案，否则「这条是不是超了」会随
			// 调用方选了哪个读法而变
			if (text.length > RUNAWAY_CEILING) warnings.push(`${kind}：条目超失控保护（写侧拦新增，存量请收敛）——${name}`)
			forEachWikilinkMatch(text, (matched) => {
				const stem = matched.trim()
				if (stem.length > 0 && !stems.has(stem)) warnings.push(`${kind}：死 wikilink [[${stem}]]——${name}`)
			})
		}
		// 派生索引超预算在这里「判红」，注入侧那份是「施加截断」：一个报警一个截断，语义不同，
		// 合在一起就会出现体检把已经截过的块再判一次、或注入侧把该报的静默截掉
		const indexText = scan.lines.join('\n')
		if (scan.lines.length > INDEX_LINE_BUDGET || indexText.length > INDEX_CHAR_BUDGET) {
			warnings.push(`${kind}：派生索引超预算（${scan.lines.length} 行/${indexText.length} 字符，注入会被截断）`)
		}
	}
	const result = { ok: warnings.length === 0, warnings, notices }
	if (isMachineConfigured(machine)) result.machine = machine
	return result
}
