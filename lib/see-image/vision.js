/**
 * see_image 内缝纯函数（零宿主依赖，node --test 直测）：图型魔数嗅探＋流终态映射。
 * 与 memory/ 的 core.js/write.js 同款分层——纯逻辑独立于 cordis 接线层，
 * 宿主包不可解析的裸仓环境也能跑单测。
 */

/** 附件服务的受支持图型（ImageMediaType），按魔数嗅探；声明类型会被解码校验。 */
export function sniffImageMediaType(bytes) {
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
	if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
	if (bytes.length >= 6 && bytes.toString('latin1', 0, 6).startsWith('GIF8')) return 'image/gif'
	return null
}

/** 终态映射沿用 dsh-compaction-basic 的 fail-close 语义；本工具不复述流细节。 */
export function finishError(finish) {
	if (finish.kind === 'error' || finish.kind === 'aborted') {
		return new Error(`vision model call ${finish.kind}: ${finish.failure?.message ?? 'unknown failure'}`)
	}
	if (finish.kind === 'max-tokens') return new Error('vision model output truncated at the token cap; image too complex for one pass')
	return undefined
}
