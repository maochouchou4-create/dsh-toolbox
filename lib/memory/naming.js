/**
 * dsh-memory 的条目名知识：盘上哪些 `.md` 算条目、调用方可以拿什么名字来写／删、去后缀
 * 取 stem，以及保留名与退役索引名那两份名单。
 *
 * 只收「名字」这一个问题，另半边（头两行长什么样）留在 frontmatter.js：判定「这个文件
 * 算不算条目」不需要解析头，解析头也不需要知道保留名是谁——两者合住一处时，
 * 改任何一侧都要穿过另一整篇的散文，而合住的理由（都发生在条目文件上）并不是同一条契约。
 *
 * 依赖集为空：命名判定不碰预算、不碰解析、不碰宿主包与 node:fs，故本模块零 IO、可独立单测。
 *
 * 读侧与写侧在这里宽窄不同，是同一个问题的两侧而不是两份判据：读侧答「盘上已有的 .md
 * 里哪些当条目看」（枚举，宽），写侧答「调用方可以拿什么名字来写／删」（规范形，窄）。
 * 读侧判据当前比写侧宽；统一到单源判据是既定方向，属后续收紧范围。
 */

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
const RESERVED_FILES = new Set(['MEMORY.md', WRITING_FILE])

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
 * 它比同模块的 assertEntryFile 宽：写/edit/delete 的 file 入参要的是可接受的规范形
 * （小写 kebab），而 `Foo.md` 这类大写形态读侧照收、写侧拒收。读侧判据当前比写侧宽；
 * 统一到单源判据是既定方向，属后续收紧范围。
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

/**
 * 条目文件名的**写侧口径**：可接受的规范形——小写 kebab（全库现有条目全部满足），
 * MEMORY.md/WRITING.md 为保留名。write／edit／delete 三动作的 file 入参都走它。
 *
 * 与 isEntryName 是同一问题的两侧：那边答「盘上有哪些 `.md` 要当条目看」（读侧，宽），
 * 这边答「调用方可以拿什么名字来写／删」（规范形，窄）。正则刻意不导出：导了它，调用方
 * 就能绕开这里自己判一次规范形，共享的就只剩那个常量本身。
 */
const ENTRY_FILE_RE = /^[a-z0-9][a-z0-9-]*\.md$/
export function assertEntryFile(file) {
	if (typeof file !== 'string' || !ENTRY_FILE_RE.test(file)) {
		throw new Error(`条目文件名须为小写中划线 kebab 形如 topic-name.md，收到 "${file}"`)
	}
	if (isReservedFile(file)) {
		throw new Error(`"${file}" 是保留名（${[...RESERVED_FILES].join('/')} 不可作条目）`)
	}
}
