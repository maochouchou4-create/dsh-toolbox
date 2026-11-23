/**
 * 值级取用的原语：「这个值算不算给了」的判据。
 *
 * 放 lib/ 根而不是 memory 的内缝——Config 回退与离线脚本的入参判定问的是同一个
 * 问题（这是一个非空白的字符串吗），而共用件留在错误的位置，方向就不是单向的。
 */

/**
 * 非空白的字符串才算「给了」：undefined／null／空串／纯空白／非字符串一律不算。
 * 只判不裁——原值原样返回、不 trim，故调用方拿到的仍是自己写下来的那个串；要裁的是值本身
 * 的调用点自己裁（裁不裁是那个调用点的事，不是这条判据的事）。
 */
export function isNonBlankString(value) {
	return typeof value === 'string' && value.trim().length > 0
}
