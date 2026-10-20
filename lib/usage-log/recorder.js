/**
 * 使用日志记录器（零宿主依赖，node --test 直测）：旁听宿主 tools/result 广播，把本包工具的
 * 调用——成功与失败都在内——落成记忆仓里按天、按机器分片的 jsonl。
 *
 * 白名单不在这里：名单由胶水从 FEATURES 表现读传入。本模块 import 胶水就是成环，且会把宿主
 * 依赖带进这个可直接单测的目录（与 see-image/route.js 同款分层）。
 *
 * 为什么走事件面而不是给每件工具的 execute 包一层：事件面一处覆盖全部调用态（参数校验失败、
 * 策略拒绝这些 execute 根本没跑到的态也在内），包一层要动九处且必然漏掉那些态。
 *
 * 行有两态：成功行走瘦行（只记参数键集与耗时，不记参数值与结果摘要——memory 写条目的正文
 * 动辄几千字，按天追加等于把同一条事实复制进 git 历史），失败行保持全量（args 值级摘要与
 * error 都在：宿主 ToolFailure 的 info 只在本日志留存，args 是复现「当时怎么调错」的唯一凭据）。
 * 日档按 14 天窗口轮转：窗口内够复盘按周取样，更久只是同一批事实的重复。轮转只删「已提交到
 * HEAD 的档」——日志历史在 git 里，untracked 或有未提交改动的档删了就不可恢复。
 *
 * 计时走第二条事件面（tools/execute 起表、tools/result 收表）：宿主交来的 result 不带耗时。
 * 起表落在 waterfall 链的中段——先于本监听器注册的 wrapper 所花的时间不计入 ms（这是链式事件
 * 的固有口径，不是漏测）。
 *
 * 为什么要同步写：宿主对监听器不 await（notifyResult 只把返回值 catch 掉），异步 append 会在
 * 调用热路径上丢末行；appendFileSync 单行 μs 级，且进程内串行天然保序（并行工具调用不互插）。
 *
 * 为什么落进仓（记忆仓 store 下的数据域，与批次台账同一处）：日志的唯一消费者是复盘，复盘要看
 * 的是两台机器合起来的工具痛点——放本机目录等于最该被消费的原料藏在一台机器上。落点由配置的
 * 记忆根决定，跟着 git 同步走。
 *
 * 为什么文件名带机器段：两机各写各的文件，git 合并永不把它们放进同一份文件，于是不必为这份
 * 追加流引入合并策略（台账那种两机共写的才需要）。机器名缺席与非法都不兜一个值——兜底字面量会与
 * 真机名同形、并造出「第三种机器段值」。
 *
 * 为什么不接会话只读策略：日志是旁路，接策略就要把 fs 端口那侧 `denyWrite` 的会话语义搬进来，
 * 代价是只读会话里日志写不成、复盘取样随会话策略起伏；取舍是把「只读会话里日志照写」写明在
 * README 里。
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MACHINE_ID_RE } from '../memory/core.js'
import { storeDataDir } from '../memory-root.js'
import { isNonBlankString } from '../value.js'

/** store 数据域下的子目录名：与台账同处 data/，但同目录不同文件（台账两机共写、日志各写各的）。 */
const LOG_DIR_NAME = 'usage-log'

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
 * 日档保留窗口（天）：复盘以周为节奏，14 天跨得住一个完整复盘周期；再长只是把同一批事实重复
 * 进 git 历史。窗口放模块顶部单源、不进配置面——配置面只装两台机器的部署差异，保留多久是产品
 * 口径，不该跟着机器走（两台机器的日志窗口不同也会让「复盘读哪几天」变成猜的事）。
 */
const RETENTION_DAYS = 14

/**
 * 日档名＝<本地日期>.<机器段>.jsonl（见 usageLogFile）。机器段的形状不在这里复写第二份——那是
 * MACHINE_ID_RE 的判据，dayFileNumber 拿它单源校验（保留字 shared 不认）：日志目录里将来多放
 * 的随手文件（notes.txt、备份档）不该被轮转顺手删掉，而「不认识的档名不动」只能靠这条判定本身
 * 保证。
 */
const DAY_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.([^.]+)\.jsonl$/

const MS_PER_DAY = 86_400_000

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
 * 日志根＝记忆仓 store 下的数据域里的本包目录。求根走 memory-root 的两份归一（记忆根 → store，
 * store → data/），与批次台账同一段前缀：日志与台账必须同仓才谈得上两机共享。
 *
 * 记忆根缺席时 resolveRoot 取默认根（与台账同款行为，不在这里另立一套报错）：那时日志落在
 * 默认根下、不进任何 git 仓——这是被明写与被用例钉住的既有口径，不是静默降级。
 */
export function usageLogRoot(memoryRoot) {
	return join(storeDataDir(memoryRoot), LOG_DIR_NAME)
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
 * 机器段在这里校验而不是只靠调用方：它进的是文件名，而文件名允许的字符比机器 id 宽得多——
 * `a/b` 会静默建出子目录、`..` 会穿出日志目录、大小写变体在 Windows 上与真机名落进同一个文件。
 * 值域问 memory/core.js 的 MACHINE_ID_RE 单源（与 config.machine 同一条判据）；不合法当场抛，
 * 不 sanitize 也不兜底——静默改写会让「这台机器的文件在哪」变成猜不出来的事。
 *
 * at 无默认值：与两个事件构造同一条口径（写侧每一处都把时刻显式带过来），一个「顺手取 now」的
 * 默认值只会让某一处悄悄与事件时间分家。
 */
export function usageLogFile(rootDir, at, machine) {
	if (typeof machine !== 'string' || !MACHINE_ID_RE.test(machine)) {
		throw new Error(`machine 缺失或不在值域内（实得 ${JSON.stringify(machine) ?? String(machine)}）：日志文件名按机器分段，只收小写字母数字起头、只含小写字母数字与中划线且不为 shared 的值（记忆根配置的机器名）`)
	}
	const pad = (value) => String(value).padStart(2, '0')
	return join(rootDir, `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.${machine}.jsonl`)
}

/** 本地日历日的序数（以 UTC 日为单位）：分片按本地日，而横跨夏令时的日子是 23/25 小时——
 * 拿本地日期分量再按 UTC 做减法，天数差就不会被那两个短/长日子带偏。 */
function localDayNumber(at) {
	return Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()) / MS_PER_DAY
}

/** 日档名里的日期 → UTC 日序数；不认识的、或格式对但日期不存在的（如 2026-02-30，UTC 会把它
 * 滚到 3 月）记 null——宁可不删，也不按滚错的日期判龄。 */
function dayFileNumber(name) {
	const match = DAY_FILE_RE.exec(name)
	if (match === null) return null
	// 机器段形状问 MACHINE_ID_RE 单源（保留字 shared 与形状之外都不认）：档名是轮转唯一的删除
	// 依据，猜错一个段就是把不该删的文件删掉
	if (!MACHINE_ID_RE.test(match[4])) return null
	const year = Number(match[1])
	const month = Number(match[2])
	const date = Number(match[3])
	const stamp = Date.UTC(year, month - 1, date)
	const back = new Date(stamp)
	if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== date) return null
	return stamp / MS_PER_DAY
}

/**
 * 调用方必须显式给 at：缺了它 localDayNumber 会算出 NaN，而 NaN 参与的比较全为 false——轮转会
 * 变成「一个都不删」同样静默。这类编程错必须在进 try 之前就抛：appendUsageLine 的 catch 只吞
 * 轮转的 IO 失败，不吞漏传参数。
 */
function requireAt(at) {
	if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
		throw new TypeError(`usage-log 需要调用方的 at（Date）：分片、ts 与轮转必须同一个时刻，实得 ${String(at)}`)
	}
}

/**
 * 删除资格：档在 git 仓内、且工作区内容与 HEAD 一致。
 *
 * 日志历史只在 git 里（日志目录落在记忆仓的 data/ 下）：untracked 的档删了就是不可恢复，有未
 * 提交改动的档删了连当前那一版也没了。这台机器没有 git、或目录不在仓内（记忆根取默认根时不进
 * 任何仓的既有口径）时同样按「不可恢复」处理——轮转少删一天，比删掉唯一一份强。
 */
function isCommittedAtHead(rootDir, name) {
	const tracked = spawnSync('git', ['-C', rootDir, 'ls-files', '--error-unmatch', '--', name], { encoding: 'utf8' })
	if (tracked.error || tracked.status !== 0) return false
	const clean = spawnSync('git', ['-C', rootDir, 'diff', '--quiet', 'HEAD', '--', name])
	return !clean.error && clean.status === 0
}

/**
 * 清掉窗口外的日档，返回删掉的文件名（用例与诊断要看得见删了什么）。
 *
 * 判龄只看文件名里的日期，不看 mtime：日志随 git 同步，clone/checkout 会把所有档的 mtime 刷成
 * 当时——按 mtime 判龄等于「新克隆的仓第一次写日志就把旧历史全清空」。
 *
 * 不分机器段：档名里的机器段只是「两台机器各写各的、git 不合并同一份文件」的分片手段，窗口按
 * 日期收才是这件事本身；只清自己那台的话，一台退役机器留下的旧档会永久占位。窗口边界按「超过
 * 14 天才删」，正好第 14 天的档保留（复盘要读的那几天不能被边界算法削掉）。
 *
 * 删除只对「已提交到 HEAD 的档」开口（见 isCommittedAtHead）：未被 git 记下的档删了不可恢复，
 * 跳过并 warn 一条——静默跳过等于「轮转以为在跑、实际一直不生效」。
 *
 * 先尽量删完再把失败汇总抛：一个删不掉的档不该把同一趟里其余旧档留在盘上。删不删得掉由调用方
 * 决定怎么报（写入侧吞掉、注册侧 warn 一条）。
 */
export function pruneUsageLog(rootDir, at) {
	requireAt(at)
	let names
	try {
		names = readdirSync(rootDir)
	} catch (error) {
		// 目录还没建＝没有旧档可清（日志目录是首次写入时才递归建的）
		if (error?.code === 'ENOENT') return []
		throw error
	}
	const today = localDayNumber(at)
	const removed = []
	const failed = []
	for (const name of names) {
		const day = dayFileNumber(name)
		if (day === null || today - day <= RETENTION_DAYS) continue
		if (!isCommittedAtHead(rootDir, name)) {
			// 这里没有 logger 面（纯模块级 I/O 缝）：console 是跳过唯一可见处，不静默
			console.warn(`[dsh-toolbox] 超龄日档未删除（不在 git 仓内或与 HEAD 不一致，删除后不可恢复）：${name}`)
			continue
		}
		try {
			unlinkSync(join(rootDir, name))
			removed.push(name)
		} catch (error) {
			// 读到之后被别的进程删掉（两台机器共用一份同步目录）＝目标已达成，不算失败
			if (error?.code === 'ENOENT') continue
			failed.push(`${name}（${error?.message ?? error}）`)
		}
	}
	if (failed.length > 0) throw new Error(`旧日档清理失败：${failed.join('、')}`)
	return removed
}

/**
 * 追加一行事件，并顺手轮转。写前递归建目录：复盘 SOP 带定期删日志，目录可能中途不在，而缓存一份
 * 「已建」状态就是第二份真相源（首次建失败后它会一直说已建）。递归 mkdir 对已在的目录是空操作。
 *
 * at 由调用方显式带入（与分片、ts 同一个时刻）：轮转的窗口边界若自己另取一次 now，跨零点那一下
 * 就会按「明天」判今天该不该删。轮转放在写之后、失败只吞掉：这一行已经落盘，删旧档是维护动作，
 * 不该把一次成功的写入变成调用方眼里的失败（手记侧是显式请求，失败必须如实报——所以只吞轮转、
 * 不吞写入）。漏传 at 是编程错而不是运行时故障，在进 try 之前就抛（见 requireAt）。判据每次从
 * 目录现读、不缓存「已清理」状态：缓存就是第二份真相源，日志目录被删过之后它会一直说清过了；
 * 无状态判据让下一次写入自然重试。
 */
export function appendUsageLine(file, event, at) {
	requireAt(at)
	mkdirSync(dirname(file), { recursive: true })
	appendFileSync(file, `${JSON.stringify(event)}\n`)
	try {
		pruneUsageLog(dirname(file), at)
	} catch {
		// 这里没有 logger 面可报：删不掉的旧档留给下一次写入重试（判据无状态、不记进度）
	}
}

/**
 * 参数键集：瘦行只回答「这次调用带了哪些参数名」。参数值不记——memory 写条目的正文一次几千字，
 * 落在按天追加的日志里等于把同一条事实复制一份进 git 历史（正文的单源在那条条目上）。
 *
 * 参数不是普通对象（schema 允许数组/标量）时记 null 而不是 []：没有参数与参数形状不是对象是
 * 两件事，兜成空数组会让读侧把后者读成前者。
 */
function argumentKeys(args) {
	if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
	return Object.keys(args)
}

/**
 * 工具调用行（纯函数，单测直调）。按 ok 分两态，字段集就是读侧契约：
 *
 * 成功行瘦：ts/type/tool/callId/ok/agent/profile/argKeys/ms——只留参数键集与耗时，不落参数值、
 * 结果摘要。调用痕迹的用途是「哪件工具、什么时候、多快、带了哪些参数」，值在对话与宿主会话文件
 * 里各有单源；日志复制一份正文只会让 git 历史随 memory 写量线性长。
 *
 * 失败行胖：保持既有全量形态（args 值级摘要＋result＋error）。失败是复盘要找的东西：宿主
 * ToolFailure 的 info（结构化失败类别）只在本日志留存（模型可见 content 里没有它），args 是复现
 * 「当时是怎么调错的」的唯一凭据——两次复盘都靠它。
 *
 * ms 是调用耗时（毫秒，订阅侧在 tools/execute 起表、tools/result 收表）；拿不到开始时刻的调用记
 * null，不拿 0 充数——0 与「没测到」是两件事。失败行不混入 ms：它的契约是「既有形态原样」，
 * 复盘找坑看的是 args 与 error，多一格只会让两种形态的字段表各说各话。
 *
 * profile 两态都留：同一日文件里并发的多个 profile 只能靠它归因，它不是参数值、也不随调用内容
 * 膨胀。内层不再带 ok／isError——顶层 ok 就是同一个事实，写两遍就是两个真相源。
 *
 * at 无默认值：分片与 ts 必须取同一个 at（跨零点时「ts 是今天、行落在昨天文件」自相矛盾），
 * 而「现在几点」只有调用方知道——留个默认值就等于允许它静悄悄地另取一次 now。
 */
export function usageCallEvent(exec, result, at, profile, ms) {
	const base = {
		ts: at.toISOString(),
		type: 'call',
		tool: exec.name,
		callId: exec.callId,
		ok: !result.isError,
		agent: exec.agent?.id ?? null,
		profile,
	}
	if (!result.isError) return { ...base, argKeys: argumentKeys(exec.arguments), ms: typeof ms === 'number' ? ms : null }
	return {
		...base,
		args: summarize(exec.arguments, VALUE_MAX_CHARS),
		result: { value: summarize(result.value, VALUE_MAX_CHARS) },
		error: { message: result.error?.message, info: result.error?.info },
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
 * 白名单过滤＋落盘（I/O 内缝）。options 一个对象而不是继续加位置参数：调用侧要带的事实（根、
 * 名单、归因、机器段、耗时）已经超过一眼能记的个数，位置参数一多，订阅侧与用例各错一位就是
 * 静默写错地方。rootDir＝日志目录（usageLogRoot 的返回值），单测直调时传临时根即可。
 *
 * 事件时间在这一缝取一次、供分片、ts 与轮转共用：读侧按文件找「当天」，两个时刻分头取会把跨
 * 零点那一条写进 A 文件却标上 B 日的时间，轮转也会按另一天的边界判该不该删。
 */
export function handleToolResult(exec, result, { rootDir, toolNames, profile, machine, ms }) {
	if (!toolNames.includes(exec.name)) return
	const at = new Date()
	appendUsageLine(usageLogFile(rootDir, at, machine), usageCallEvent(exec, result, at, profile, ms), at)
}

/**
 * 订阅宿主事件面（apply 开头调一次）：tools/execute 起表、tools/result 落盘。整包 try/catch：
 * 订阅与写盘都是旁路，失败只经宿主 logger 显形，绝不影响工具注册与调用链（宿主自己也 contained
 * 监听器错误，这里再包一层是为了不往外抛带栈的错误——apply 里这一句在逐工具 try 之外，抛出去
 * 就是整包九件都不注册）。
 *
 * 为什么多挂一条 tools/execute：tools/result 交来的 exec/result 不带耗时，ms 只能在执行前起表、
 * 执行后收表。这仍是事件面而不是给每件工具包一层——一条 waterfall 监听器不改工具实现。
 *
 * options 的两位在订阅期定格：memoryRoot 与 machine 都来自 apply 的 config，那是注册期的终值，
 * 换配置的生效方式就是重启——每次事件现读一遍只会给出同一份值。profile 归因不在此列：它读的
 * profileContext 是宿主启动期填的服务，注册期未必在场，而那时拿不到的后果不该是「整场会话失去
 * 订阅」，只该是「这一行的归因记 null」（见 usageProfile）。
 *
 * 机器名不合格（缺席或不在值域内）在挂监听器之前就判掉：值已在订阅期定格，整场只可能是同一个，
 * 留到第一条事件再判等于「整场不调本包工具就零可见」——配置坏掉时那条 warn 永远发不出来。
 * 告警文案走一条、不按缺席与非法分两支：对调用方是同一个补救动作（把记忆根配置的机器名填对）。
 * 手记侧相反，那里是显式请求，当场抛。
 */
export function subscribeUsageLog(ctx, toolNames, options = {}) {
	try {
		const { memoryRoot, machine } = options
		if (typeof machine !== 'string' || !MACHINE_ID_RE.test(machine)) {
			ctx.logger.warn('[dsh-toolbox] 未配置或不合法的 machine（记忆根配置的机器名）——本次启动不记使用日志（文件名按机器分片，兜一个值会与真机名同形）')
			return
		}
		const rootDir = usageLogRoot(memoryRoot)
		// 计时表以执行对象为键：tools/execute 与 tools/result 交来的是同一个冻结对象；WeakMap
		// 不给旁路留一张越攒越大的表，结果侧取完即删。没走到 execute 的调用（策略拒绝等）在
		// 结果侧取不到开始时刻，ms 记 null（不猜耗时）。
		const startedAt = new WeakMap()
		ctx.on('tools/execute', (exec, next) => {
			try {
				startedAt.set(exec, performance.now())
			} catch {
				// 计时是旁路：记不上开始时刻最多让成功行的 ms 记 null，不许顶掉工具执行
			}
			return next()
		})
		ctx.on('tools/result', (exec, result) => {
			try {
				const started = startedAt.get(exec)
				startedAt.delete(exec)
				const ms = started === undefined ? null : Math.max(0, Math.round(performance.now() - started))
				handleToolResult(exec, result, { rootDir, toolNames, profile: usageProfile(ctx), machine, ms })
			} catch (error) {
				ctx.logger.warn(`[dsh-toolbox] 使用日志写入失败（调用不受影响，这一条不记）：${error?.stack ?? error}`)
			}
		})
		// 注册时先清一趟旧日档：一台机器可能隔很久才开机，开机前那批早已过窗的日档不必再等第一次工具
		// 调用才收。放在挂完监听器之后：订阅都没挂上就谈不上「本场照常记录」，不必再报一条清理告警。
		// 清理失败只 warn、不挡住订阅（轮转是维护动作，写入侧还会再清）。
		try {
			pruneUsageLog(rootDir, new Date())
		} catch (error) {
			ctx.logger.warn(`[dsh-toolbox] 旧日档清理失败（不影响订阅，写入时再试）：${error?.stack ?? error}`)
		}
	} catch (error) {
		ctx.logger.warn(`[dsh-toolbox] 使用日志订阅失败（本次启动不记使用日志）：${error?.stack ?? error}`)
	}
}
