/**
 * see_image 内缝（零宿主依赖，node --test 直测）：图型魔数嗅探、附件占位符解析与存区
 * 定位、流终态映射与正文抽取，外加两个编排函数 resolveTarget／transcribe。与 memory/ 的
 * core.js/write.js 同款分层——逻辑独立于 cordis 接线层，宿主包不可解析的裸仓环境也能整段
 * 跑单测。
 *
 * 「零宿主依赖」钉的是不 import 宿主包（BlockAssembler、defineTool 都在胶水层），不是
 * 不碰 ctx：ctx 由胶水层构造后当参数传进来，故编排那半段能直测，纯函数那半段仍旧纯。
 */
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { expandHome } from '../paths.js'
import { isNonBlankString } from '../value.js'
import { resolveActiveCwd } from '../working-dir.js'

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
 * 本常量复刻宿主 dsh-attachment-local 的 v1/objects 布局，宿主改布局时此处必错——改前先核宿主实现。
 *
 * 桶枚举（<前2位>）留在这份复刻里而没交给宿主：AttachmentStore 抽象面没有按 id 读回
 * 图字节的接口（imageHostPath 与 readImage 都要完整 ref 对象），而本仓手上只有占位符
 * 那 8 位前缀——宿主改布局时这条命令会自己失效，而不会在编译期拦住我们，故写死在此处。
 */
const STORE_LAYOUT = ['attachments', 'v1', 'objects']

/** 桶名＝对象名（64 位 sha256）的前两位；布局之外的部分由内容寻址本身定死。 */
const bucketOf = (hex) => hex.slice(0, 2)

/**
 * 宿主附件存区根（objects/ 目录）。DSH home 由胶水层从宿主 profileContext.home 注入：
 * 求根语义（$DSH_HOME、~ 展开）是宿主 resolveDshHome 那一份，本模块不复刻——旧实现
 * 自己推时漏过 ~ 展开，`DSH_HOME='~/.dsh'` 那种写法会算出字面量相对路径，与宿主
 * 实际写入分家。`~` 展开在这里仍兜一层（注入方哪天传了未展开的值，路径不会静默跑偏）。
 */
export function resolveAttachmentRoot(dshHome) {
	if (!isNonBlankString(dshHome)) {
		throw new Error('附件存区求根需要 DSH home（由胶水层从宿主 profileContext.home 注入）——不自行按 $DSH_HOME／~ 推算')
	}
	return join(expandHome(dshHome.trim()), ...STORE_LAYOUT)
}

/**
 * 在内容寻址存区里把 hex（前缀或全量）解析到唯一对象。桶内前缀匹配后必须唯一命中——
 * 0 或 >1 都是显式错误（>1 时提示加长前缀），不做「取最新」这类会转述错图的静默兜底。
 */
export function resolveAttachmentObject(objectsRoot, hex) {
	const bucket = join(objectsRoot, bucketOf(hex))
	let entries
	try {
		entries = readdirSync(bucket)
	} catch {
		throw new Error(`附件存区没有桶 ${bucket}（前缀 ${bucketOf(hex)} 无对象，或存区根 ${objectsRoot} 不对——检查 DSH home）`)
	}
	const matches = entries.filter((entry) => entry.length === 64 && /^[a-f0-9]{64}$/.test(entry) && entry.startsWith(hex))
	if (matches.length === 0) throw new Error(`桶 ${bucket} 内没有以 ${hex} 开头的对象`)
	if (matches.length > 1) throw new Error(`前缀 ${hex} 在桶 ${bucket} 内命中 ${matches.length} 个对象（${matches.slice(0, 3).join('、')}…）——请加长前缀到唯一`)
	return { path: join(bucket, matches[0]), id: matches[0] }
}

/**
 * 定位要转述的那张图。path 分支交 fs 服务解析（相对路径按会话活目录），attachment 分支
 * 在宿主全局存区按前缀定位对象、读回字节同样走 fs 服务——两条分支读的都是「宿主认的
 * 那个文件」，超帽与常规文件校验只有一处口径。
 *
 * 两个分支返回同一形状 { target, sourceName, attachmentId }，attachmentId 只在占位符
 * 分支有值：调用方据此决定输出里要不要回显 sha256，不必知道进来的是哪一路。
 *
 * objectsRootOf 是取用函数而不是求好的字符串：存区根只有占位符分支要，注入方拿不到
 * DSH home 时那条磁盘路径入口仍要能用，故求根失败不许拖垮它。
 */
export async function resolveTarget(ctx, args, exec, objectsRootOf) {
	if ((args.path === undefined) === (args.attachment === undefined)) {
		throw new Error('path 与 attachment 必须二选一：磁盘路径走 path，占位符十六进制串走 attachment')
	}
	if (args.attachment !== undefined) {
		const prefix = parseAttachmentId(args.attachment)
		const object = resolveAttachmentObject(objectsRootOf(), prefix)
		return {
			target: await ctx.fs.resolve(object.path, { signal: exec.signal }),
			sourceName: object.id,
			attachmentId: object.id,
		}
	}
	// 活目录经 workingDirectory 服务取（F1，收口在 lib/working-dir.js，与 memory 工具侧同一份）：
	// header.cwd 是会话启动快照，working_directory(cd) 后不回写；ensure 与 dsh-tool-fs 同款
	// （含目录消失时恢复）。非 agent 调用不传 cwd，交由 fs 服务默认解析
	const cwd = await resolveActiveCwd(ctx, exec)
	const target = await ctx.fs.resolve(args.path, {
		signal: exec.signal,
		...(cwd !== undefined ? { cwd } : {}),
	})
	return { target, sourceName: basename(args.path), attachmentId: undefined }
}

/**
 * 喂流取正文：终态出错即抛，正文为空即抛（空转述比失败更难被调用方察觉）。
 * assembler 由胶水层注入——BlockAssembler 是宿主类型，本模块不 import 宿主包，
 * 故这里只认「能 push(chunk)、交得出 finish 与 blocks()」这一个形状。
 */
export async function transcribe({ stream, assembler }) {
	for await (const chunk of stream) assembler.push(chunk)
	const failure = finishError(assembler.finish)
	if (failure !== undefined) throw failure
	const description = assembler
		.blocks()
		.filter((block) => block.type === 'text')
		.map((block) => block.text)
		.join('')
		.trim()
	if (description.length === 0) throw new Error('视觉模型返回空正文（若持续出现，检查该模型是否默认开启思考吃光输出预算）')
	return description
}
