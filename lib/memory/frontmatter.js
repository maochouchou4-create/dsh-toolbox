/**
 * dsh-memory 条目文件契约：frontmatter 解析、索引行派生、条目文件命名（纯函数、
 * 零宿主依赖，可独立单测）。
 *
 * 这一模块回答四个问题——「一个文件算不算条目」、「条目的头两行长什么样」、
 * 「读到多少字节才算读完头」、「文本怎么切行、围栏在哪」：前两个分别由命名判据
 * （`RESERVED_FILES`／`isReservedFile`／`isEntryName`）与解析器回答，判定只有这一份；
 * 第三个由头读常量与围栏闭合判据回答，读侧（assemble.js）与写侧（write.js 的同名检查）
 * 各按它判断「够不够解析」，两边对「头读完了没有」的答案就不至于分叉；第四个由
 * `frontmatterLines`／`findFenceEnd` 回答，解析、头读早退、迁移三处共用同一份行归一与
 * 围栏定位——它们问的是同一个事实，各写一遍就会在第四个消费者出现时漂。
 *
 * 契约是「恰好 title＋description 两键」，解析器是它唯一的实现：写侧拿它做落盘前
 * 拦截，读侧拿它派生索引行，两边共用一份判定，就没有「写得进、注不进来」的缝。
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

/**
 * 写侧纪律文件名：保留名里不是 frontmatter 条目的那一份。装配注入块与离线体检都要定位它，
 * 单写一份字面量就得两处同时改——漏一处的症状是纪律块悄悄从某一面消失，而纪律被静默丢掉
 * 比超预算更难查。故它先立成符号，保留名集合再由它构成。
 *
 * test/ 夹具里那份写死的 'WRITING.md' 是有意的：夹具造的是磁盘上的真实文件名，换成符号
 * 反而让「造了什么盘」不直观。全仓只有本行与那些夹具两处留字面量，都是定义点或有意为之，
 * 不要当残留收敛掉。
 */
export const WRITING_FILE = 'WRITING.md'

/** 保留文件名：它们不是条目（前者是索引文件，后者是写侧纪律）。 */
export const RESERVED_FILES = new Set(['MEMORY.md', WRITING_FILE])

/** 比对用的折叠集：只比大写或只比小写都会在 MEMORY.md/memory.md 上落空，两边都折。 */
const RESERVED_FOLDED = new Set([...RESERVED_FILES].map((name) => name.toLowerCase()))

/**
 * 退役的索引文件名（小写形态）。「哪个文件是已退役的索引」是本模块的知识而不是各调用方的：
 * 两个脚本各写一遍 `isReservedFile(name) && name.toLowerCase() === 'memory.md'`，改起来
 * 就得同时想起两处，而漏一处的结果是那份索引文件在一边被清、另一边被留着。
 */
export const RETIRED_INDEX_NAME = 'memory.md'

/**
 * 保留名判定，大小写不敏感：大小写不敏感的文件系统上 memory.md 与 MEMORY.md 是同一个
 * 文件，只按精确名拦就等于给「把索引文件当条目写」留了个口子。
 */
export function isReservedFile(name) {
	return typeof name === 'string' && RESERVED_FOLDED.has(name.toLowerCase())
}

/** 退役索引文件判定：保留名里唯独它不再被读（索引改由条目 frontmatter 现场派生）。 */
export function isRetiredIndexFile(name) {
	return isReservedFile(name) && name.toLowerCase() === RETIRED_INDEX_NAME
}

/**
 * 条目名的**读侧口径**：`.md` 且非保留名。注入扫描、写侧同名拦截、体检、删条目的引用
 * 扫描都问它——同一段目录「这堆文件里哪些是条目」只有一个答案，各调用方自己拼一遍
 * `.md` + 保留名，就会在第四次加检查点时漂出第五套判据。
 *
 * 它比写侧宽：写/edit/delete 的 file 入参走 patterns.js 的 assertEntryFile，要的是可接受
 * 的规范形（小写 kebab）。于是 `Foo.md` 这类大写形态读侧照收、写侧拒收——两侧宽窄不同是
 * 有意的：读侧的任务是枚举盘上已有的东西（把不合规的报出来正是体检的价值），写侧的任务是
 * 不让不合规的东西落盘。收紧这一侧到 kebab 会让现存的大写条目从「被体检报出来」变成
 * 「看不见」，那是行为变更，不在本次收敛内。
 */
export function isEntryName(name) {
	return typeof name === 'string' && name.endsWith('.md') && !isReservedFile(name)
}

/**
 * 去 `.md` 后缀取 stem。wikilink 的目标与条目名同形，引用匹配与已知 stem 清点因此都拿它
 * 当同一个串；去后缀只有这一份拼法，派生保留名、删条目的引用匹配、stem 清点三处各折一次
 * 就等于三处可能只改得动两处。
 */
export function stemOf(name) {
	return name.replace(/\.md$/, '')
}

/** 保留文件对应的 stem（去后缀）：死链判定与「不是条目」的排除名单，同一份不再各折一遍。 */
export const RESERVED_STEMS = new Set([...RESERVED_FILES].map(stemOf))

const fail = (error) => ({ ok: false, error })

/**
 * 解析条目 frontmatter。
 * 返回 { ok: true, frontmatter: { title, description } } 或 { ok: false, error }——
 * 失败不是抛错：读侧（注入/体检）要把病灶原样报出来，只有写侧才把同一个 error
 * 翻成 throw。两种反应共用这一份判定，不各写一套解析。
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
	// 文本）——在写侧就拦，报错指的就是病因本身
	if (/[[\]]/.test(title)) return fail(`title 不可含方括号（派生索引行将不是合法链接行）：「${title}」`)
	return { ok: true, frontmatter: { title, description: fields.get('description') } }
}

/** 首次探测的头块大小：两键 frontmatter 典型只有几百字节，一次就够绝大多数条目。 */
export const FRONTMATTER_HEAD_PROBE_BYTES = 2048

/** 围栏未闭合时的兜底上限：病态条目（值折行、漏收尾围栏）读到它为止仍没闭合即判未闭合。 */
export const FRONTMATTER_HEAD_MAX_BYTES = 65536

/**
 * 行归一的一份实现：CRLF 收在这一个点，同根因不各设特判。
 * 四处都要把条目的行尾收成 LF——解析器、分块头读的围栏早退判据、迁移脚本的行级替换，
 * 以及写侧 edit 的正文入口（按节锚定的行 span 重建要在归一后的行上做，落盘统一 LF）。
 * 其中前两处要的其实是同一个问题（「围栏在哪」），第三与第四处要的也是它。各写一遍
 * `replace(/\r\n/g, '\n')` 与 `split('\n')`，第五处出现时就会有一处忘了归一，而症状是
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
 * 读侧拿它决定分块早退，写侧拿它决定要不要升窗口，之后各走各的解析路径。
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
 * 与 parseFrontmatter 同一口径（读侧要把病灶原样报出来，只有写侧才翻成 throw）。
 *
 * 这一级独立出来是因为调用方手上常常已经有解析结果：体检与注入装配逐条解析过（要派生
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
 * 撞名门槛（组长 > 1）在这里判一次并随值返回：调用方各判一遍就会漂，而漂出来的症状是
 * 同一组撞名在体检里报了而离线自检没报（或反过来），两边谁都说不出另一边的口径。
 *
 * 两侧对不可解析条目的**后续**处理刻意不同：写侧遇它就封段报错（同名判定不可信就别
 * 写），体检只跳过并交给它自己的 frontmatter warning 认领（离线镜像不该因一条坏条目
 * 整段失声）。差的是策略，这份判定只回答那几个事实——哪些 title 撞上了（dups）、各
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
 * 吃原文的便利入口：调用方手上只有文本时用它，解析与分组一步做完（写侧只读文件头、
 * 迁移脚本整篇读，拿到的都是文本）。已经 parse 过的走 parseEntry ＋ groupByTitle 两步，
 * 别把原文再交一遍。
 */
export const groupTitlesByTitle = (entries) => groupByTitle(parseEntries(entries))

/**
 * 撞名那一条的唯一渲染点（写侧报错、体检 warning、离线自检报告共用这一份）。
 *
 * 处置给的是 edit（改 frontmatter 的 title 行）而不是先 delete：title 是 frontmatter 的
 * 独立字段、与文件名是两回事，而撞上的按构造就是**另一条**各自带正文的现存条目——写侧的
 * 同名扫描把待写/待改的那条排除在外（edit 改的正是它自己），故报出来的不会是自己。
 * 照「先 delete 再改名」做，删掉的是一条真条目。
 *
 * 组大小说 names.length 而不是写死「两条」：撞名组可以是三条以上，写死的数量会与同句里
 * 点出的名单自相矛盾（说两条、列三个名字）。
 */
export function renderDupWarning({ dir, title, names }) {
	return `段内 title 重名「${title}」——${dir}／${names.join('、')}（这 ${names.length} 条各占一行注入索引，按 title 分不出谁是谁。不要 delete 其中任何一条：改 frontmatter 的 title 不丢正文，用 edit 的 title 参数改其中一条；只有确实多余的那条才 delete）`
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
 * 写侧入口：不合规即抛。报错带文件名与病因，让调用方按原样修条目内容即可，
 * 不必先读文件反推（拦截类承诺「不落盘」）。
 */
export function assertEntryFrontmatter(text, file) {
	const parsed = parseFrontmatter(text)
	if (!parsed.ok) throw new Error(`条目 ${file} 的 frontmatter 不合规：${parsed.error}`)
	return parsed.frontmatter
}
