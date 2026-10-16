/**
 * 工具入参守卫：未知键点名＋折叠归一＋退役别名表。零依赖、零宿主包、零 fs——纯函数，
 * 装配层与单测都能直接 import。
 *
 * 为什么独立成模块而不写进各工具的 execute：宿主把参数根节点编译成开放对象——未知键
 * 不拒、原样透传进 execute，而条件必填又写不进扁平 schema，于是「收到没声明的键」只有
 * execute 自己能看见。点名与指路（变体写法→正名、退役名→新用法）是所有工具同一件事，
 * 各工具各写一份就会有一份只点名不指路；收在这里，判据与报错骨架只有一份。
 *
 * 折叠归一＝键名两侧各做「小写＋去分隔符（_-）」后精确比对：filePath 与 file_path 折叠后
 * 同形，命中；fileName 与 file_path 是不同的词，不命中。归一只用于报错指路，不参与取值
 * ——归一命中≠替调用方改参，重发的动作留给调用方（Parse, don't validate：不洗入参）。
 *
 * 优先级规则：**归一命中必须是当前声明名，退役名一律走别名表**。别名表的键也按折叠口径
 * 匹配（OldString 能中表键 oldString），但表里收的都是已退役的名字——若先查别名表，
 * 「old_string 是已退役 oldString 的变体」会被教回退役名；先查声明名归一、只在没有声明名
 * 可命中时才查别名表，退役名才总能拿到「该改用什么」的指引。
 */

/** 折叠口径：小写＋去分隔符。键名比对（声明名归一、别名表键匹配）都经这一份。 */
export const foldParamName = (name) => name.toLowerCase().replace(/[-_]/g, '')

/**
 * 单个未知键的指路行（骨架的第二行起）。返回 null 表示该键归一与别名表都不中——
 * 由调用方给兜底句（动作名只有它知道）。
 */
function diagnoseUnknown(key, declared, aliases) {
	const folded = foldParamName(key)
	const declaredName = declared.find((name) => foldParamName(name) === folded)
	if (declaredName !== undefined) {
		return `「${key}」是「${declaredName}」的变体写法——直接改用「${declaredName}」重发。`
	}
	const aliasKey = Object.keys(aliases).find((name) => foldParamName(name) === folded)
	if (aliasKey !== undefined) {
		return `「${key}」已退役——${aliases[aliasKey]}。`
	}
	return null
}

/**
 * 未知键点名：收到没声明的键即 throw，报错逐键指路（变体→正名、退役→新用法、
 * 都不中→回工具描述）。参数全部声明在案时不抛，原样返回入参。
 *
 * received 键清单按收到顺序原样列出（含值为 undefined 的键——键在就是收到了，
 * 值对不对是另一道判据的事）。
 */
export function assertNoUnknownParams(params, { declared, aliases = {}, action }) {
	if (typeof params !== 'object' || params === null || Array.isArray(params)) {
		throw new TypeError(`入参守卫收到非对象 params（${typeof params}）——参数根节点恒为对象，这不是调用方的用法错误而是接线错误`)
	}
	const received = Object.keys(params)
	const unknown = received.filter((key) => !declared.includes(key))
	if (unknown.length === 0) return params
	const lines = [`未知参数「${unknown.join('、')}」——本工具没有这个参数。本次收到：${received.join('、')}。`]
	for (const key of unknown) {
		const hint = diagnoseUnknown(key, declared, aliases)
		lines.push(hint ?? `${action ?? '本工具'} 的参数见工具描述。`)
	}
	throw new Error(lines.join('\n'))
}

/**
 * 条件必填的运行期点名：schema 表达不了「哪个动作要哪几个键」（扁平 schema 的必填是
 * 并集），由各工具在 execute 里按动作给名单。缺哪个点名哪个，并附上「本次收到了什么」
 * ——缺的键就在没收的那几个里，点名收到清单能把重试从猜收敛成对答案。
 */
export function assertRequiredParams(params, required, { action } = {}) {
	const received = Object.keys(params)
	const missing = required.filter((name) => !received.includes(name))
	if (missing.length === 0) return
	throw new Error(
		`缺必填「${missing.join('」「')}」${action === undefined ? '' : `（${action}）`}——本次收到的键：${received.join('、')}——缺的就在没收的那几个里，别猜，看描述。`,
	)
}
