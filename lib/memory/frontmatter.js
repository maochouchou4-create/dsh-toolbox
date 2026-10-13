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
export const RESERVED_FOLDED = new Set([...RESERVED_FILES].map((name) => name.toLowerCase()))

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
 * 扫描都问它——同一层目录「这堆文件里哪些是条目」只有一个答案，各调用方自己拼一遍
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
 * 三处都要把条目切成行——解析器、分块头读的围栏早退判据、迁移脚本的行级替换——其中两处
 * 要的是同一个问题（「围栏在哪」），第三处要的也是它。各写一遍 `replace(/\r\n/g, '\n')` 与
 * `split('\n')`，第四处出现时就会有一处忘了归一，而症状是 CRLF 条目在某条路径上读不到头。
 * 家机 git checkout 产出的正是 CRLF 条目，这个坑每次跨机都会重新踩一遍。
 */
export const frontmatterLines = (text) => text.replace(/\r\n/g, '\n').split('\n')

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
 * 写侧入口：不合规即抛。报错带文件名与病因，让调用方按原样修条目内容即可，
 * 不必先读文件反推（拦截类承诺「不落盘」）。
 */
export function assertEntryFrontmatter(text, file) {
	const parsed = parseFrontmatter(text)
	if (!parsed.ok) throw new Error(`条目 ${file} 的 frontmatter 不合规：${parsed.error}`)
	return parsed.frontmatter
}
