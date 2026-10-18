/**
 * 使用日志记录器（零宿主依赖，node --test 直测）：旁听宿主 tools/result 广播，把本包工具的
 * 调用——成功与失败都在内——落成本机私有的按天 jsonl。
 *
 * 白名单不在这里：名单由胶水从 FEATURES 表现读传入。本模块 import 胶水就是成环，且会把宿主
 * 依赖带进这个可直接单测的目录（与 see-image/route.js 同款分层）。
 *
 * 为什么走事件面而不是给每件工具的 execute 包一层：事件面一处覆盖全部调用态（参数校验失败、
 * 策略拒绝这些 execute 根本没跑到的态也在内），包一层要动九处且必然漏掉那些态。
 *
 * 为什么要同步写：宿主对监听器不 await（notifyResult 只把返回值 catch 掉），异步 append 会在
 * 调用热路径上丢末行；appendFileSync 单行 μs 级，且进程内串行天然保序（并行工具调用不互插）。
 *
 * 为什么求根走宿主 profileContext：自己按 $DSH_HOME／~ 推的路径会与宿主实际写入分家（识图存区
 * 那条线踩过）。这里是旁路，拿不到就不记——失败经宿主 logger 显形，不静默退回 ~/.dsh。
 *
 * 为什么整体 try/catch 后吞：日志是旁路，写失败不得污染工具调用链。jsonl 里没有失败标记
 * （读侧只认格式），复盘发现断档时查宿主日志——这是显形面。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isNonBlankString, dshHome } from '../value.js'

/** DSH home 下的本包日志目录名：本机私有，不进任何 git 仓。 */
const LOG_DIR_NAME = 'toolbox-usage'

/**
 * 值级截断的字符上限：典型单行 description ≤160、逐条一行的决策行也能整条装下——200 取完整
 * 容纳典型行。语料变了按实际调（复盘时读日志定），不按印象。
 */
const VALUE_MAX_CHARS = 200

/** 手记正文上限：隐性坑补记两句因果＋处置的量——独立标定，复盘按台账调。 */
export const NOTE_MAX_CHARS = 500

/** 手记未点名关联工具时的 tool 值。 */
const NOTE_TOOL_NAME = 'usage_note'

/**
 * 通用值级截断：任何 string 值超限即截（记原长＋前 N 字符），对象与数组递归下钻（嵌套里的长串
 * 同样截），其余类型原样。
 *
 * 刻意不按字段名点名：点名清单＝第二份参数面，字段一改名就静默失效，而失效的症状是「日志里
 * 突然出现整段全文」——没人会想到是截断名单过期。
 *
 * 只读不改：入参是宿主的深冻结 lossless JSON（顶层浅拷贝改顶层不抛、改嵌套才抛，别赌）。
 */
function summarize(value, max) {
	if (typeof value === 'string') {
		return value.length > max ? { len: value.length, head: value.slice(0, max) } : value
	}
	if (Array.isArray(value)) return value.map((item) => summarize(item, max))
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, summarize(item, max)]))
	}
	return value
}

/**
 * 日志根＝宿主 DSH home 下的本包目录。home 的读取走 lib/value.js 的 dshHome（识图存区同一份
 * 判据；那边也要求 home 在场，两个消费方的差别只在拿不到时各自的报错文案与降级方式）。
 */
export function usageLogRoot(ctx) {
	const home = dshHome(ctx)
	if (home === null) {
		throw new Error('宿主未提供 profileContext.home（拿不到 DSH home）——无法定位使用日志目录')
	}
	return join(home, LOG_DIR_NAME)
}

/**
 * 事件行的 profile 归因键＝宿主 profile 名（profileContext.name，即 dsh --profile 选中的那个）。
 * 日志按天分片、不按 profile 分文件：同机多 profile 并发跑时，没有这一格就分不清某行是哪次启动
 * 写的——归因只能靠它。profileContext 缺席（非 dsh profile 启动）或名字不是非空白串时记 null：
 * 事实源给不出就不猜，读侧据 null 知道这一行无法归因。
 */
export function usageProfile(ctx) {
	const name = ctx.get('profileContext')?.name
	return isNonBlankString(name) ? name : null
}

/**
 * 当日日志文件。分片跟本机日历走（复盘按「当天」读文件，跨零点读相邻两个），ts 仍是 ISO／UTC
 * ——分片给人读、ts 给对账，两者不同基准是刻意的。
 *
 * at 无默认值：与两个事件构造同一条口径（写侧每一处都把时刻显式带过来），一个「顺手取 now」的
 * 默认值只会让某一处悄悄与事件时间分家。
 */
export function usageLogFile(rootDir, at) {
	const pad = (value) => String(value).padStart(2, '0')
	return join(rootDir, `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.jsonl`)
}

/**
 * 追加一行事件。写前递归建目录：复盘 SOP 带定期删日志，目录可能中途不在，而缓存一份「已建」
 * 状态就是第二份真相源（首次建失败后它会一直说已建）。递归 mkdir 对已在的目录是空操作。
 */
export function appendUsageLine(file, event) {
	mkdirSync(dirname(file), { recursive: true })
	appendFileSync(file, `${JSON.stringify(event)}\n`)
}

/**
 * 工具调用行（纯函数，单测直调）。字段是读侧契约：type 是过滤的唯一判据，callId 与宿主会话
 * 文件对账（同分钟多次同工具调用可分），agent 只记标识、不判主/子（agent loop 对两者都注入），
 * profile 是同一日文件里多 profile 并发的归因键（见 usageProfile）。
 *
 * result 只装产出摘要（值的截断摘要）：全文在对话与宿主会话文件各有单源，这里不复制；模型可见
 * content 同理不记。内层不再带 ok／isError——顶层 ok 就是同一个事实，写两遍就是两个真相源，
 * 读侧还得判断该信哪个。
 *
 * error 只在失败行出现，且整块不截断：它是「过程中遇到的问题」的主载体，而宿主 ToolFailure 的
 * info（结构化失败类别）只在本日志留存——模型可见 content 里没有它，机判失败类别只能读这里。
 *
 * at 无默认值：分片与 ts 必须取同一个 at（跨零点时「ts 是今天、行落在昨天文件」自相矛盾），
 * 而「现在几点」只有调用方知道——留个默认值就等于允许它静悄悄地另取一次 now。
 */
export function usageCallEvent(exec, result, at, profile) {
	return {
		ts: at.toISOString(),
		type: 'call',
		tool: exec.name,
		callId: exec.callId,
		ok: !result.isError,
		agent: exec.agent?.id ?? null,
		profile,
		args: summarize(exec.arguments, VALUE_MAX_CHARS),
		result: { value: summarize(result.value, VALUE_MAX_CHARS) },
		error: result.isError ? { message: result.error?.message, info: result.error?.info } : undefined,
	}
}

/**
 * 手记行（纯函数，单测直调）：结构化字段装不下的隐性坑，事后补记。
 *
 * tool 缺省 usage_note（这条不针对某一件）；ok 未给记 null 而不是 true——「没表态」与「没问题」
 * 是两件事，复盘按 ok:false 找坑，中性手记不该被算成成功。
 *
 * tool 直存、不过 summarize：它取自本包九件的登记名（最长 16 字符），够不到值级上限；套一层
 * 截断只会让读侧以为这一格可能出现 { len, head } 形态。
 */
export function usageNoteEvent(args, at, profile) {
	return {
		ts: at.toISOString(),
		type: 'note',
		tool: isNonBlankString(args.tool) ? args.tool : NOTE_TOOL_NAME,
		ok: args.ok ?? null,
		profile,
		note: summarize(args.note, NOTE_MAX_CHARS),
	}
}

/**
 * 白名单过滤＋落盘（I/O 内缝）。rootDir＝日志目录（usageLogRoot 的返回值），单测直调时传临时根
 * 即可，不碰真实家目录。名单从胶水传入——本模块不 import 胶水，也不自己拼工具名清单。
 *
 * 事件时间在这一缝取一次、供分片与 ts 共用：读侧按文件找「当天」，两个时刻分头取会把跨零点那
 * 一条写进 A 文件却标上 B 日的时间。
 */
export function handleToolResult(exec, result, rootDir, toolNames, profile) {
	if (!toolNames.includes(exec.name)) return
	const at = new Date()
	appendUsageLine(usageLogFile(rootDir, at), usageCallEvent(exec, result, at, profile))
}

/**
 * 订阅宿主 tools/result 广播（apply 开头调一次）。整包 try/catch：订阅与写盘都是旁路，失败只经
 * 宿主 logger 显形，绝不影响工具注册与调用链（宿主自己也 contained 监听器错误，这里再包一层
 * 是为了不往外抛带栈的错误）。
 *
 * 求根放在每次事件里而不是订阅时求一次：profileContext 是宿主启动期填的服务，注册期未必在场，
 * 而那时拿不到的后果不该是「整场会话失去订阅」——只该是「这一条不记」。
 */
export function subscribeUsageLog(ctx, toolNames) {
	try {
		ctx.on('tools/result', (exec, result) => {
			try {
				handleToolResult(exec, result, usageLogRoot(ctx), toolNames, usageProfile(ctx))
			} catch (error) {
				ctx.logger.warn(`[dsh-toolbox] 使用日志写入失败（调用不受影响，这一条不记）：${error?.stack ?? error}`)
			}
		})
	} catch (error) {
		ctx.logger.warn(`[dsh-toolbox] 使用日志订阅失败（本次启动不记使用日志）：${error?.stack ?? error}`)
	}
}
