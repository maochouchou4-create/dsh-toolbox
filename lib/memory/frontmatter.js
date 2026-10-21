/**
 * dsh-memory 条目文件契约：frontmatter 解析、头读常量与围栏判据、行归一、索引行派生，
 * 以及段内 title 重名判定族（纯函数、零宿主依赖，可独立单测）。
 *
 * 这一模块答的是「条目的头两行长什么样、读到哪算读完、文本怎么切行、头里那两个字段
 * 派生得出什么」。头读常量与围栏判据让读侧注入装配、离线自检（check:memory）与迁移脚本
 * 共用同一个「头读完了没有」的答案，`frontmatterLines`／`findFenceEnd` 的行归一与围栏定位被解析、头读早退、迁移三处
 * 共用，重名判定族吃解析结果、吐「按 title 分组」。
 *
 * 名字那件事（盘上哪些 `.md` 算条目、保留名是谁、去后缀取 stem）不在这里，在 naming.js：
 * 「这个文件算不算条目」与「头两行长什么样」是两个问题，各写一份就会在第四个消费者出现时漂。
 *
 * 契约是「恰好 title＋description 两键」，解析器是它唯一的实现：离线自检拿它验收，读侧拿它
 * 派生索引行，两边共用一份判定，就没有「写得进、注不进来」的缝。
 * 第三键一律拒（Parse, don't validate）——两键之外没有消费者的字段就是死字段，
 * 静默忽略等于让语料里攒下没人读的键位，越攒越查不出谁在读。
 *
 * 值是字面单行文本，不走 YAML 解析器：条目 frontmatter 的形态是我们自己的契约，
 * 引号/块标量/锚点这类 YAML 花招在这里一律按字面处理（引号会原样进索引行，
 * 需要引号就别加）。折行写成多行会被整块拒——YAML 折行在注入侧会变成游离段落行，
 * 而那正好落在索引块里、静默读作正文；块内空行放行（`---` 与首键之间的空行是常见
 * 写法，现存语料大半如此），拦的是缩进续行与 `>`/`|` 块标量那些不以键形态出现的行。
 */

const FENCE = '---'
const KEY_LINE_RE = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/

/** 规范形的两键，顺序即惯例。 */
export const FRONTMATTER_KEYS = ['title', 'description']

const fail = (error) => ({ ok: false, error })

/**
 * 解析条目 frontmatter。
 * 返回 { ok: true, frontmatter: { title, description } } 或 { ok: false, error }——
 * 失败不是抛错：读侧（注入装配、离线自检）要把病灶原样报出来，只有迁移脚本经
 * assertEntryFrontmatter 才把同一个 error 翻成 throw。两种反应共用这一份判定，不各写一套解析。
 *
 * 行归一与围栏定位都问 frontmatterLines／findFenceEnd：CRLF 条目按归一后的行解析即可，
 * 同根因不各设特判。
 */
export function parseFrontmatter(text) {
	if (typeof text !== 'string') return fail('内容不是字符串')
	const lines = frontmatterLines(text)
	const end = findFenceEnd(lines)
	// 两种「没有闭合围栏」要分开报：缺开场围栏是文件形态不对，未闭合是写漏了收尾行，
	// 读的人照着改的东西不是同一处。判定本身共用 findFenceEnd 一份，不在这里另拼
	if (end === -1) {
		return lines[0] === FENCE ? fail(`frontmatter 未闭合（缺收尾的 ${FENCE} 行）`) : fail(`条目开头缺 frontmatter（首行须为 ${FENCE}）`)
	}
	const fields = new Map()
	for (const line of lines.slice(1, end)) {
		// 空行放行：YAML 里 `---` 与首键之间的空行是常见写法，全库现存条目大半如此。
		// 要拦的是「值折到下一行」——那种续行不以 `键: 值` 形态出现（缩进续行、| 与 >
		// 块标量），故拦的是非键行，不是空行
		if (line.trim().length === 0) continue
		const matched = KEY_LINE_RE.exec(line)
		if (!matched) {
			return fail(`frontmatter 每行须为「键: 值」单行形态，多行折行会在索引块产出游离段落行：「${line}」`)
		}
		const [, key, rawValue] = matched
		if (fields.has(key)) return fail(`frontmatter 键重复：「${key}」`)
		if (!FRONTMATTER_KEYS.includes(key)) {
			return fail(`frontmatter 多余键「${key}」——规范形恰好 ${FRONTMATTER_KEYS.join('＋')} 两键`)
		}
		fields.set(key, rawValue.trim())
	}
	for (const key of FRONTMATTER_KEYS) {
		const value = fields.get(key)
		if (value === undefined) return fail(`frontmatter 缺 ${key}`)
		if (value.length === 0) return fail(`frontmatter 的 ${key} 为空`)
	}
	const title = fields.get('title')
	// 方括号会让派生行不是合法的 markdown 链接行，而症状要到注入面才显形（读成游离
	// 文本）——在解析层就拦，报错指的就是病因本身
	if (/[[\]]/.test(title)) return fail(`title 不可含方括号（派生索引行将不是合法链接行）：「${title}」`)
	return { ok: true, frontmatter: { title, description: fields.get('description') } }
}

/** 围栏未闭合时的兜底上限：病态条目（值折行、漏收尾围栏）读到它为止仍没闭合即判未闭合。 */
export const FRONTMATTER_HEAD_MAX_BYTES = 65536

/**
 * 行归一的一份实现：CRLF 收在这一个点，同根因不各设特判。
 * 三处都要把条目的行尾收成 LF——解析器、分块头读的围栏早退判据、迁移脚本的行级替换。
 * 其中前两处要的其实是同一个问题（「围栏在哪」）。各写一遍
 * `replace(/\r\n/g, '\n')` 与 `split('\n')`，第四处出现时就会有一处忘了归一，而症状是
 * CRLF 条目在某条路径上读不到头。家机 git checkout 产出的正是 CRLF 条目，这个坑每次跨机
 * 都会重新踩一遍。
 */
export const normalizeLineEndings = (text) => text.replace(/\r\n/g, '\n')

/** 按归一后的行切分：切行与归一是同一步的上下游，故归一问上面那一份，不在这里重写一遍。 */
export const frontmatterLines = (text) => normalizeLineEndings(text).split('\n')

/**
 * 围栏判定的一份实现：首行须是开场围栏，返回闭合围栏的下标，没有则 -1。
 * 分块早退、够不够解析、迁移脚本的块切分都问它——三处各拼一次 `'---'` 字符串匹配，
 * 就会在第四个消费者出现时漂出第五套围栏判据，而漂了之后的症状是「有的条目读得到头、
 * 有的读不到」，比报错难查。
 * 不导出 FENCE 裸常量：导了它，调用方就又能各拼各的字符串匹配，共享的就只剩那个常量本身。
 */
export function findFenceEnd(lines) {
	if (lines[0] !== FENCE) return -1
	return lines.indexOf(FENCE, 1)
}

/**
 * 文本里有没有成形的 frontmatter 块（决定「头读够了没有」的那个单一谓词）：
 * 注入装配拿它决定分块早退，离线自检拿它判头形态，之后各走各的解析路径。
 */
// 按 \r?\n 切而不是 \n：上面 frontmatterLines 已把 CRLF 归一，这里再切一次是为了让
// hasClosedFence 单独可调用时也安全——两者喂同一份行数组时结果一致，归一与切分只此一份
export const hasClosedFence = (text) => findFenceEnd(frontmatterLines(text)) !== -1

/** 派生索引行：`- [title](file) — description`。索引不落盘，每次注入按此重建。 */
export function deriveIndexLine({ title, description, file }) {
	return `- [${title}](${file}) — ${description}`
}

/**
 * 判定链的第一级（单条）：把一条 `{ name, text }` 解析成判定可用的中间形态。
 * 返回 { name, ok: true, frontmatter } 或 { name, ok: false, error }——失败不抛错，
 * 与 parseFrontmatter 同一口径（读侧要把病灶原样报出来，只有迁移脚本才翻成 throw）。
 *
 * 这一级独立出来是因为调用方手上常常已经有解析结果：离线自检与注入装配逐条解析过（要派生
 * 索引行），再把原文交回 groupTitlesByTitle 就是同一段文本被 parse 两次——两次结果相同、
 * 代价翻倍，而「这一份被解了几次」在代码里看不出来，看着只是一次普通的函数调用。
 */
export function parseEntry({ name, text }) {
	const parsed = parseFrontmatter(text)
	return parsed.ok ? { name, ok: true, frontmatter: parsed.frontmatter } : { name, ok: false, error: parsed.error }
}

/** 判定链的第一级（整组）：逐条 parseEntry。 */
const parseEntries = (entries) => entries.map(parseEntry)

/**
 * 段内 title 重名判定的一份实现：吃 parseEntries 的产物，吐「按 title 分组的 names」、
 * 「撞上名的组」与「不可解析的条目」。
 *
 * 分组按 frontmatter 的 title 字段，不按文件名：派生索引行以 title 为准，文件名各不
 * 相同的两个文件照样会让注入块里那两行不可区分。不合群的条目一律不参与，也不占坑——
 * title 不可知就不能参与比较，把空串当成一个真实存在的 title 只会造出第三种谁都不认
 * 的反应。
 *
 * 撞名门槛（组长大于 1）在这里判一次并随值返回：调用方各判一遍就会漂，而漂出来的症状是
 * 同一组撞名注入装配报了而离线自检没报（或反过来），两边谁都说不出另一边的口径。
 *
 * 各消费方对不可解析条目的**后续**处理刻意不同：注入装配与离线自检只跳过并交给各自的
 * frontmatter warning 认领（不因一条坏条目整段失声），迁移脚本自己决定拦不拦。
 * 差的是策略，这份判定只回答那几个事实——哪些 title 撞上了（dups）、各
 * title 下是哪些条目（byTitle）、哪些条目的 title 不可知（unparsable）；各调用方拿其中一面。
 *
 * 不可解析的名单随值返回而不是就地丢弃：坏条目原先只是「没占坑」，等于从没说给读者听
 * 它的 title 一次都没被比较过——「本结论只覆盖其余条目」这句话，得有这份名单才说得出口。
 */
export function groupByTitle(parsedEntries) {
	const byTitle = new Map()
	const unparsable = []
	for (const entry of parsedEntries) {
		if (!entry.ok) {
			unparsable.push({ name: entry.name, error: entry.error })
			continue
		}
		const group = byTitle.get(entry.frontmatter.title)
		if (group === undefined) byTitle.set(entry.frontmatter.title, [entry.name])
		else group.push(entry.name)
	}
	const dups = [...byTitle].filter(([, names]) => names.length > 1).map(([title, names]) => ({ title, names }))
	return { byTitle, dups, unparsable }
}

/**
 * 吃原文的便利入口：调用方手上只有文本时用它，解析与分组一步做完（注入装配只读文件头、
 * 迁移脚本整篇读，拿到的都是文本）。已经 parse 过的走 parseEntry ＋ groupByTitle 两步，
 * 别把原文再交一遍。
 */
export const groupTitlesByTitle = (entries) => groupByTitle(parseEntries(entries))

/**
 * 撞名那一条的唯一渲染点（离线自检报告与注入装配 warning 共用这一份）。
 *
 * 处置给的是宿主 edit（改 frontmatter 的 title 行）而不是先 rm：title 是 frontmatter 的
 * 独立字段、与文件名是两回事，而撞上的按构造就是**另一条**各自带正文的现存条目——
 * 照「先 rm 再改名」做，删掉的是一条真条目。
 *
 * 组大小说 names.length 而不是写死「两条」：撞名组可以是三条以上，写死的数量会与同句里
 * 点出的名单自相矛盾（说两条、列三个名字）。
 */
export function renderDupWarning({ dir, title, names }) {
	return `段内 title 重名「${title}」——${dir}／${names.join('、')}（这 ${names.length} 条各占一行注入索引，按 title 分不出谁是谁。不要 rm 其中任何一条：改 frontmatter 的 title 不丢正文，用宿主 edit 改其中一条的 title 行；只有确实多余的那条才 rm；改完跑 npm run check:memory -- <记忆根> <机器id> 验收）`
}

/**
 * 覆盖面缺口那一条的唯一渲染点，与 renderDupWarning 同理由只此一处：条数口径与措辞各调用方
 * 各拼一次就会分叉，而分叉出来的症状是读者以为重名结论覆盖了整段。
 */
export function renderCoverageWarning({ unparsable }) {
	const list = unparsable.map(({ name, error }) => `${name}：${error}`).join('；')
	return `${unparsable.length} 条 title 判不了（${list}），重名结论只覆盖其余条目`
}

/**
 * 迁移脚本入口：不合规即抛。报错带文件名与病因，让调用方按原样修条目内容即可，
 * 不必先读文件反推。宿主写侧已退役（写改删走宿主 write/edit/rm），运行期不再有第二个
 * 抛错消费方——入口留在这儿只为迁移脚本与离线自检共用同一份判定。
 */
export function assertEntryFrontmatter(text, file) {
	const parsed = parseFrontmatter(text)
	if (!parsed.ok) throw new Error(`条目 ${file} 的 frontmatter 不合规：${parsed.error}`)
	return parsed.frontmatter
}
