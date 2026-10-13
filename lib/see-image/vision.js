/**
 * see_image 内缝纯函数（零宿主依赖，node --test 直测）：图型魔数嗅探＋流终态映射
 * ＋附件占位符解析。与 memory/ 的 core.js/write.js 同款分层——纯逻辑独立于
 * cordis 接线层，宿主包不可解析的裸仓环境也能跑单测。
 */
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

/**
 * 解析占位符附件标识。宿主给纯文本模型的占位符只带 8 位前缀
 * （`[image omitted …; attachment sha256:053eb17e]`），而附件服务面全部要完整
 * 64 位 ref——这里收「sha256:前缀／裸前缀／完整 64 位」三种写法，归一成裸小写
 * hex。最短 8 位＝占位符原生长度；再短的前缀在 256 个桶里歧义率过高，不值得收。
 * 前缀按大小写不敏感剥：hex 那一步本来就在归一，只认小写前缀等于同一段里两套口径
 * 自相矛盾——`053EB17E` 收得下、`SHA256:053eb17e` 却报无效，同一个标识两种结果。
 */
export function parseAttachmentId(input) {
	const hex = input.replace(/^sha256:/i, '').toLowerCase()
	if (!/^[a-f0-9]{8,64}$/.test(hex)) {
		throw new Error(`无效的附件标识 ${input}：需要 sha256: 后至少 8 位十六进制（占位符里的前缀或完整 64 位）`)
	}
	return hex
}

/**
 * 宿主附件存区根（objects/ 目录）。root 复刻 dsh-home-paths 的 resolveDshHome
 * 语义（显式 env ＞ $DSH_HOME 非空白 ＞ ~/.dsh）——附件服务没有公开 root
 * getter，DSH_HOME 与默认值两分支已覆盖本机形态；若宿主以私有 configured 值
 * 另立 dshHome，这里会算错，错误信息里带算出的路径便于诊断。
 */
export function resolveAttachmentRoot(env = process.env, homedirFn = homedir) {
	const configured = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : undefined
	return join(configured ?? join(homedirFn(), '.dsh'), 'attachments', 'v1', 'objects')
}

/**
 * 在内容寻址存区里把 hex（前缀或全量）解析到唯一对象。存区布局＝
 * objects/<前2位>/<64hex>；桶内前缀匹配后必须唯一命中——0 或 >1 都是显式
 * 错误（>1 时提示加长前缀），不做「取最新」这类会转述错图的静默兜底。
 */
export function resolveAttachmentObject(objectsRoot, hex) {
	const bucket = join(objectsRoot, hex.slice(0, 2))
	let entries
	try {
		entries = readdirSync(bucket)
	} catch {
		throw new Error(`附件存区没有桶 ${bucket}（前缀 ${hex.slice(0, 2)} 无对象，或存区根 ${objectsRoot} 不对——检查 $DSH_HOME）`)
	}
	const matches = entries.filter((entry) => entry.length === 64 && /^[a-f0-9]{64}$/.test(entry) && entry.startsWith(hex))
	if (matches.length === 0) throw new Error(`桶 ${bucket} 内没有以 ${hex} 开头的对象`)
	if (matches.length > 1) throw new Error(`前缀 ${hex} 在桶 ${bucket} 内命中 ${matches.length} 个对象（${matches.slice(0, 3).join('、')}…）——请加长前缀到唯一`)
	return { path: join(bucket, matches[0]), id: matches[0] }
}
