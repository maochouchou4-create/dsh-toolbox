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
 * 「算不算条目」只有这一份判据：读侧枚举（注入扫描、体检、离线自检）与写侧入参校验都问
 * isEntryName／assertEntryFile，两侧都不许自己再拼一次后缀或保留名。判据是「小写 kebab 名
 * 且非保留名」——两半缺一都出岔：只留后缀会放退役名与任意大写名进索引，只留 kebab 正则会
 * 放保留名进来。存量里 `Foo.md` 这类非 kebab 文件因此不再被枚举（也不进注入），体检另给一条
 * 信息性提醒把它们说出来（见 isIgnoredEntryFile）。
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
 * 条目名的规范形：小写 kebab。刻意不导出——导出就等于给调用方一条绕开 isEntryName／
 * assertEntryFile 自己判一次的路，共享的就只剩那个常量本身。
 */
const ENTRY_FILE_RE = /^[a-z0-9][a-z0-9-]*\.md$/

/**
 * 条目名判定，读写同源：小写 kebab 名 **且** 非保留名。注入扫描、写侧同名拦截、体检、删条目
 * 的引用扫描、离线自检都问它——同一段目录「这堆文件里哪些是条目」只有一个答案，各调用方自己
 * 拼一遍后缀加保留名，就会在第四次加检查点时漂出第五套判据。
 *
 * 保留名那一半不是多余的：MEMORY.md／WRITING.md 过不了 kebab 正则，而 memory.md／writing.md
 * 过得了——少了它，退役的索引文件与写侧纪律会以条目身份进索引。
 */
export function isEntryName(name) {
	return typeof name === 'string' && ENTRY_FILE_RE.test(name) && !isReservedFile(name)
}

/**
 * 被忽略的 Markdown 文件判定：盘上有 `.md` 后缀却不算条目。后缀折大小写——`Foo.MD` 在大小写
 * 不敏感的文件系统上与 `Foo.md` 是同一个文件，直比就会把它漏出提醒面（症状是「东西少了一条」
 * 却没有任何一处说得出）。读侧枚举收紧到规范形之后，这类文件从注入与索引里安静退场，体检拿它
 * 出一条信息性提醒——「记忆里那条不见了」得有可发现路径，否则手工暂存或改名留下的产物谁都看不
 * 见（那正是收紧判据的代价面，得有人兜）。
 *
 * MEMORY.md 这类不是被漏掉的条目，是索引文件与写侧纪律——混进来就是给两类不同的事实同一条
 * 说法。
 */
export function isIgnoredEntryFile(name) {
	return typeof name === 'string' && name.toLowerCase().endsWith('.md') && !isEntryName(name) && !isReservedFile(name)
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
 * 条目文件名的**写侧入参校验**：write／edit／delete 三动作的 file 入参都走它。判据与
 * isEntryName 同一份（小写 kebab 且非保留名），这里只是把两条不过的原因分开说——「形不合」
 * 与「撞保留名」的处置不同（改名 vs 换名），合成一句报错就指不对方向。
 */
export function assertEntryFile(file) {
	if (typeof file !== 'string' || !ENTRY_FILE_RE.test(file)) {
		throw new Error(`条目文件名须为小写中划线 kebab 形如 topic-name.md，收到 "${file}"`)
	}
	if (isReservedFile(file)) {
		throw new Error(`"${file}" 是保留名（${[...RESERVED_FILES].join('/')} 不可作条目）`)
	}
}
