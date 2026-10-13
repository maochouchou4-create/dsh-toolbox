/**
 * dsh-memory 条目文件契约：frontmatter 解析、索引行派生、条目文件命名（纯函数、
 * 零宿主依赖，可独立单测）。
 *
 * 这一模块回答两个问题——「一个文件算不算条目」与「条目的头两行长什么样」：
 * 前者由命名判据（`RESERVED_FILES`／`isReservedFile`／`isEntryName`）回答，
 * 后者由解析器回答，两者的判定只有这一份。
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

/** 保留文件名：它们不是条目（前者是索引文件，后者是写侧纪律）。 */
export const RESERVED_FILES = new Set(['MEMORY.md', 'WRITING.md'])

/** 比对用的折叠集：只比大写或只比小写都会在 MEMORY.md/memory.md 上落空，两边都折。 */
const RESERVED_FOLDED = new Set([...RESERVED_FILES].map((name) => name.toLowerCase()))

/**
 * 保留名判定，大小写不敏感：大小写不敏感的文件系统上 memory.md 与 MEMORY.md 是同一个
 * 文件，只按精确名拦就等于给「把索引文件当条目写」留了个口子。
 */
export function isReservedFile(name) {
	return typeof name === 'string' && RESERVED_FOLDED.has(name.toLowerCase())
}

/**
 * 条目文件名的唯一定义点：`.md` 且非保留名。注入扫描、写侧同名拦截、体检、删条目的
 * 引用扫描都问它——同一层目录「这堆文件里哪些是条目」只有一个答案，各调用方自己
 * 拼一遍 `.md` + 保留名，就会在第四次加检查点时漂出第五套判据。
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
 * CRLF 归一收在此单点：git checkout 产出的 CRLF 条目按 \n 解析即可，同根因不各设特判。
 */
export function parseFrontmatter(text) {
	if (typeof text !== 'string') return fail('内容不是字符串')
	const lines = text.replace(/\r\n/g, '\n').split('\n')
	if (lines[0] !== FENCE) return fail(`条目开头缺 frontmatter（首行须为 ${FENCE}）`)
	const end = lines.indexOf(FENCE, 1)
	if (end === -1) return fail(`frontmatter 未闭合（缺收尾的 ${FENCE} 行）`)
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
