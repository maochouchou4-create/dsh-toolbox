/**
 * 测试夹具的共用件：条目正文模板（frontmatter 两键＋正文）。
 *
 * 收口理由：四个测试文件各写一份逐字相同的它（memory-write／memory-lint／memory-core／
 * memory-delete）。条目 frontmatter 是契约且在收紧（恰好两键），模板一分家就有某个文件
 * 里的夹具按旧形态造条目——症状不是那条用例红，而是它造的条目压根进不了索引，于是
 * 「这条用例到底在验什么」变得不可读。
 *
 * 只收这一件。临时根样板（各文件自己的 before／after 与 fixture 工厂）、只读策略字面量
 * 与带 code 的断言模板、预算造数循环三处刻意保留原样：它们的作用域是单个文件的临时根
 * 与该文件独有的判据，抽象过去要引入按用例传参的参数层，换来的是省几行、代价是读用例
 * 的人得先跳进抽象层才知道盘上摆了什么。
 */
export const entry = (title, description, body = '正文') => `---\ntitle: ${title}\ndescription: ${description}\n---\n\n${body}\n`
