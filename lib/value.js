/**
 * 值级取用的原语：跨工具族的「这个值算不算给了」与宿主 profile 事实源的读取。
 *
 * 放 lib/ 根而不是某个工具族的内缝——Config 回退、离线脚本的入参判定、宿主注入的路径校验
 * 问的都是同一个问题（这是不是一个非空白的字符串），而它跨族：留在 dsh-memory 的内缝里，
 * 另一个工具族就只能逐字复刻（复刻的那几份散在视觉族的入参回退与存区求根里，形态还各不相同，
 * 有一份是取反的）。共用件留在错误的位置，方向就不是单向的。
 *
 * 与 lib/paths.js 同层同理由，但不同类：那里是路径原语，这里是「读」原语——值谓词与宿主
 * profile 事实源（dshHome）。Config 值与位置参都未必是路径；宿主事实源的读取只读不拼路径，
 * 也够不上路径原语，两件都塞进 paths.js 会让它名不副实。
 */

/**
 * 非空白的字符串才算「给了」：undefined／null／空串／纯空白／非字符串一律不算。
 * 只判不裁——原值原样返回、不 trim，故调用方拿到的仍是自己写下来的那个串；要裁的是值本身
 * 的调用点自己裁（裁不裁是那个调用点的事，不是这条判据的事）。
 */
export function isNonBlankString(value) {
	return typeof value === 'string' && value.trim().length > 0
}

/**
 * 宿主 DSH home；拿不到返回 null。
 *
 * 事实源只有一处：宿主启动器 boot 时填好的 profileContext.home（它由宿主 resolveDshHome 算出，
 * 起点是本机实际启动的环境）。本仓只读不推——自己按 $DSH_HOME／~ 推一遍的写法会与宿主实际写入
 * 分家（识图存区那条线踩过：~ 未展开，宿主明明存了图这里却查不到桶）。
 *
 * 不在这里抛错：同一个缺席事实，识图存区与使用日志目录要说清的后果不同，报错文案归消费方；
 * 本函数只回答值在不在。故它是两个消费方共用的判据，而不是某一方的错误口径。
 */
export function dshHome(ctx) {
	const home = ctx.get('profileContext')?.home
	return isNonBlankString(home) ? home : null
}
