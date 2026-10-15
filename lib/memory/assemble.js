/**
 * dsh-memory 读侧的 I/O 半边：失控保护读取、frontmatter 头读、层目录索引扫描、注入块组装。
 *
 * 从 core.js 分出来的理由写在 core.js 的文件头（写侧导入闭包要穿过那里）：读与写分成两半
 * 是导入图上的硬边界，不是文件大小的偏好。
 *
 * 直连 node:fs 是读侧的既定取舍：宿主沙箱只围栏写入，读与列目录不受策略约束，走端口只是
 * 白付 async 成本（与 delete／lint 同一口径，两处的 why 各自写在本模块）。头读机制本身
 * 在 head-read.js，与端口的 node 适配器共用一份；共享的是机制，「读多少算够」的早退判据
 * 仍留在读侧（端口契约明写「不截到围栏」，带领域知识的早退不进端口）。
 *
 * 依赖边：体检（lint，写侧的离线镜像）与离线自检脚本从这里取层扫描原语——读侧持有，写侧
 * 消费。列目录、命名判据、排序、解析、组判定只有这一份，三处各扫一次就会漂，而漂出来的
 * 症状是某一处沉默、另两处报得出来。方向不可反：读侧不必知道有写侧那两件事。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readFileHead } from '../head-read.js'
import { describeError, workspaceSlug } from '../memory-root.js'
import { RUNAWAY_CEILING, applyIndexBudget, resolveLayerDir } from './core.js'
import {
	FRONTMATTER_HEAD_MAX_BYTES,
	WRITING_FILE,
	deriveIndexLine,
	groupByTitle,
	hasClosedFence,
	isEntryName,
	parseEntry,
	renderCoverageWarning,
	renderDupWarning,
} from './frontmatter.js'

/**
 * 读一个文件，超失控保护时头部截断并显式标注（防静默丢尾）。
 * 三分支返回：
 * - ok：{ status, text, truncated, origChars }
 * - missing：文件不存在（层省略的常态，不是错误）
 * - read-error：文件在但读失败（调用方经 onIssue 上报——静默吞读错误会让「层消失」无从诊断）
 */
export function readCapped(path) {
	if (!existsSync(path)) return { status: 'missing' }
	let text
	try {
		text = readFileSync(path, 'utf8')
	} catch (error) {
		return { status: 'read-error', message: describeError(error) }
	}
	if (text.length <= RUNAWAY_CEILING) {
		return { status: 'ok', text, truncated: false, origChars: text.length }
	}
	const head = text.slice(0, RUNAWAY_CEILING)
	return {
		status: 'ok',
		truncated: true,
		origChars: text.length,
		text: `${head}\n\n…（失控保护截断：原文 ${text.length} 字符，仅注入前 ${RUNAWAY_CEILING} 字符，全文在 ${path}）\n`,
	}
}

/**
 * 只读文件头（读到 frontmatter 闭合为止，最多 FRONTMATTER_HEAD_MAX_BYTES）。
 * 分块累积与末尾解码在 head-read.js 的机制里，这里只给「读到这儿够了没有」的判据：
 * 读侧要的正是带领域知识的围栏早退，而那不进端口。
 *
 * 导出给离线自检脚本：它要与注入侧用同一份读法，否则派生行与它报出的 issue 出自两把
 * 尺子，「同一语料两个镜像」的分叉就又回来了。
 */
export function readEntryHead(path) {
	return readFileHead(path, FRONTMATTER_HEAD_MAX_BYTES, hasClosedFence)
}

/**
 * 扫一层目录：列出条目、逐条读入（读法由调用方给）、解析 frontmatter、派生索引行，
 * 并判出层内 title 重名与覆盖面缺口。三处消费者——注入装配、体检、离线自检——的差异只在
 * 「怎么读一条」与「读到之后各自再判什么」，列目录、命名判据、排序、解析、组判定这五件事是
 * 同一件事，各写一遍就迟早在某一面漂，而漂出来的症状是同一组撞名在体检里报了而注入侧没报。
 *
 * read(path) → 文本，由调用方给：注入侧与离线自检要的是头（frontmatter 恒在头部几百字节，
 * 条目正文可以到几十 KB），体检要的是整篇（wikilink 与失控保护查的是正文）。读法是消费方
 * 的知识，扫层不是——所以它进参数，不进本函数。
 *
 * report(issue, path, detail) 是旁路诊断出口，issue 取值就是下面那五种，四处口径一致：
 * - 'read-error'：层目录列不动 / 条目 stat 或读失败 / 条目名被非普通文件占用
 * - 'entry-frontmatter'：条目缺或不合规 frontmatter，该条目不进索引
 * - 'layer-title-dup'：层内 title 撞名，那几行在注入索引里按 title 分不出谁是谁
 * - 'layer-title-coverage'：本层有几条 title 判不了，重名结论只覆盖其余条目
 * 组判定在循环外一次做完（撞名与覆盖面都是「整层」的性质，循环里报就等于每条条目报一次），
 * 文案问 frontmatter.js 那份共享渲染点，写侧报错、体检 warning、离线自检报告三处同源。
 *
 * 列不动目录时返回 null：调用方对「这一层什么都判不出来」的反应各不相同（注入侧省略整层、
 * 体检报一条 warning、离线自检收一条 issue），把反应留在调用方，扫描只负责把事实交出去。
 *
 * 本函数保持纯函数：无状态、无跨调用缓存，三处消费者各调各的。缓存收在 composeMemory 一层
 * （键在那里才算得全：调用方的会话 cwd 与两层落点只有它知道，而体检与离线自检压根不需要它）——
 * 缓存若下沉到本函数，就得替每个调用方各算一份版本标识，而三处的读法与判据本就不同（注入侧
 * 与离线自检要头、体检要整篇），同一份键对它们并不等价，键算错一处是某一处静默停在旧值。
 */
export function scanLayer(dir, options = {}) {
	// 第二参带缺省空对象：漏参最常见的裸调写法也要落到下面的点名消息，而不是解构 undefined
	// 的原生 TypeError（报不出漏的是什么）
	const { read, report = () => {} } = options
	// 读法是必填参数，且它的缺失是调用方的编程错误而不是语料的病态：降级出口（report）收的是
	// 「这一层/这一条读不动」，把漏参也走那条路的话，三处消费者各自安静地少扫一层——体检少报一轮、
	// 离线自检少一层、装配少一块，而没有任何一处说得出会真正的原因。故当场抛，且抛在列目录之前：
	// 空层与漏参两种情况必须一眼分得开。
	if (typeof read !== 'function') {
		throw new Error(`scanLayer 的 read（读法）是必填参数，漏传或传了非函数是编程错误，不是条目病态（实得 ${read === undefined ? 'undefined' : typeof read}）——读法是消费方的知识（注入与离线自检要头、体检要整篇），扫层不替它选；降级出口只收语料的病态`)
	}
	let dirents
	try {
		// 按名排序而不是信 readdir 的返回序：注入块逐次装配要可比，两次装配读同一份语料
		// 必须给出同一个组序。排法是按码元比较（与 Array.prototype.sort 的默认比较同序），
		// 别换成 localeCompare：同一份语料在两台机器上会给出不同的组序
		dirents = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
	} catch (error) {
		report('read-error', dir, describeError(error))
		return null
	}
	const names = dirents.map((dirent) => dirent.name)
	const entries = []
	for (const dirent of dirents) {
		if (!isEntryName(dirent.name)) continue
		const path = join(dir, dirent.name)
		// 逐条 stat 是 Dirent 出来之前的老办法：readdir 自带类型，真文件那一条不必再问盘。
		// 但 Dirent 是 lstat 口径——软链条目一律不是「文件」，直接按它判就会把指向普通文件的
		// 软链从索引里整个抹掉。端口的 listDir 既有取舍是「跟随 stat」，这里沿用同一取舍：
		// 只对判不出是不是普通文件的条目补那一次 stat，真文件一条都不补
		let isFile = dirent.isFile()
		if (!isFile) {
			try {
				isFile = statSync(path).isFile()
			} catch (error) {
				report('read-error', path, describeError(error))
				continue
			}
		}
		// 名字是 .md 却不是普通文件（同名目录）：当条目处理不了，从索引省略并报出去，
		// 静默跳过会让人以为那条目不存在
		if (!isFile) {
			report('read-error', path, '条目名被非普通文件占用，已从索引省略')
			continue
		}
		let text
		try {
			text = read(path)
		} catch (error) {
			report('read-error', path, describeError(error))
			continue
		}
		// 解析结果既派生索引行、也留给循环外的组判定：同一段文本只解一次
		const parsed = parseEntry({ name: dirent.name, text })
		entries.push({
			name: dirent.name,
			text,
			parsed,
			indexLine: parsed.ok ? deriveIndexLine({ ...parsed.frontmatter, file: dirent.name }) : null,
		})
		if (!parsed.ok) report('entry-frontmatter', path, parsed.error)
	}
	const { dups, unparsable } = groupByTitle(entries.map((entry) => entry.parsed))
	for (const { title, names: dupNames } of dups) {
		report('layer-title-dup', join(dir, dupNames[0]), renderDupWarning({ dir, title, names: dupNames }))
	}
	// 覆盖面缺口每层单独一条：无撞名时也得说——只报在撞名那条尾巴上，这层不撞名就一个字都不说
	if (unparsable.length > 0) report('layer-title-coverage', dir, renderCoverageWarning({ unparsable }))
	return { names, entries, lines: entries.map((entry) => entry.indexLine).filter((line) => line !== null) }
}

/**
 * 一层目录的注入索引块（不落盘）。无条目返回 null＝该层无内容，调用方省略整层。
 * 扫描本体在 scanLayer，本函数只做「行数组 → 注入块那一段字符串」这一步。
 */
function indexBlockOf(scan) {
	return scan === null || scan.lines.length === 0 ? null : scan.lines.join('\n')
}

/**
 * 层目录指纹：目录 mtime ＋ readdir 的文件名列表。
 *
 * 两维都要，缺一即失效：目录 mtime 覆盖增删改名的绝大多数路径（写侧的原子发布是「临时件＋
 * 改名」，改名必动目录 mtime——实测如此），文件名列表补的是目录 mtime 粒度粗的那一档
 * （一秒一格的 fs 上，同一秒内先删一个再补一个可以让 mtime 回到同一个值，而名字集合确实变了）。
 *
 * 文件名列表直接 join 进键而不是取 hash：键只在进程内当 Map 的索引，长度只随条目数走，
 * 而 hash 要多一个导入、多一处「撞了算谁的」，换来的是零收益。
 *
 * 列不动/stat 不了不抛：那是语料病态，照常往下走由 scanLayer 报 read-error 并省略该层；这里
 * 只把失败事实编进键，免得两次不同的失败复用同一份结果。键里带的是错误消息而不是恒定标记，
 * 正是为这一格——恒定标记会让「读不动」和「不存在」共用一份键。这一格无法用例钉住：测试
 * 环境造不出「目录在但读不动」（root 旁路 chmod 000），靠 code review 守。
 */
function dirFingerprint(dir) {
	try {
		return `${statSync(dir).mtimeMs}:${readdirSync(dir).join('\n')}`
	} catch (error) {
		return `unreadable:${describeError(error)}`
	}
}

/** 单文件指纹：size＋mtime（WRITING.md 用——写侧纪律是块里唯一按文件而非按目录读的那一份）。 */
function fileFingerprint(path) {
	try {
		const info = statSync(path)
		return `${info.size}:${info.mtimeMs}`
	} catch (error) {
		return `unreadable:${describeError(error)}`
	}
}

/**
 * 注入块缓存：模块级 Map，键见 composeMemory，值＝上一次算出的块字符串。随宿主进程活着，
 * 不落盘——落一份索引出去就与「索引是派生的」直接打架。
 *
 * 为什么有它：注入块每轮请求都现读现算，而整块的成本全在「逐条读条目文件头并解析派生行」
 * 上（随条目数线性涨）；键命中的那次只剩几把 stat 加 readdir，比满算低一到两个数量级（要当前
 * 语料上的数字自己跑一次，别信注释里的旧值）。纯函数那条路（scanLayer）不因缓存失掉——缓存
 * 只在装配入口这一层，scanLayer 仍是每次现读。
 *
 * 可接受的陈旧窗口：键不含条目文件内容指纹，所以「不经写侧、原地改写某个条目」不会让键变
 * （原地改写不动目录 mtime），那一行的触发词要到下一次增删改名才刷新。写侧那条路不在窗口内——
 * upsert/edit 走 fs-port 的原子发布（临时件＋改名），实测每次都动目录 mtime。窗口按
 * 「陈旧一行触发词」计，不是「看不到条目」：条目正文本来就不注入。
 */
const blockCache = new Map()

/**
 * 容量封顶：键随任一维度变动而变，一个长驻的宿主进程会攒下一串历史键（每改一次记忆就多一个），
 * 而它们除了「上一次」之外再没有命中可能。
 *
 * 淘汰按插入序（FIFO），不是 LRU：命中不重写 Map 的次序，故一个被反复命中的热键照样会被
 * 挤出容量。取值 8 的依据是「当前单桶工作集的活跃键远小于它」这一条经验观察（多工作区
 * 并行或同一进程扫多个记忆根时会越过），没有实测曲线支撑那个具体整数。
 * 越过之后的表现是命中率归零而不是变慢：每次 miss 都重算，与没有缓存同价，所以不是悬崖式
 * 事故；但那是本设计的已知边界，攒到「一个进程里活跃键常驻超过容量」再改 LRU（改动只在
 * 命中那一行把 delete+set 补上）。已挂账在 memory 的 dsh-toolbox 技术债与挂账条目里。
 */
const CACHE_CAPACITY = 8

/**
 * 组装注入块（单一字符串；全空返回 ''，宿主滤除空块）。
 * 块序：[记忆索引] 头 → 记忆书写规则 → 习惯层 → 工作层。
 * 两层索引扫目录现场生成、走 INDEX_* 预算（截断即治理信号）；WRITING.md 只受失控保护。
 * cwd 缺失（如无会话的全局预览装配）时工作层跳过，其余照常。
 * 块尾有一行「本次注入有 N 层索引超预算已截断」：逐层截断真发生时才出现，是运行期唯一那个
 * 「索引没装全」的信号（整块定档那重运行期不截，只由离线自检判红）。
 *
 * 键＝两层各自（落点路径＋目录 mtime＋文件名列表）＋写侧纪律的 size/mtime＋调用方 cwd 原样。
 * 落点路径与 cwd 两维挡的是「跨工作区／跨记忆根串块」；指纹两维挡的是「同一处语料变了」。
 * 任一维度变即换键即全量重算，故「数据现读」的语义不变——只是没变的那次不必重算。
 * 命中时不走 onIssue：诊断是那次现读的旁路出口，复报同一条只会刷屏，而状态一变换键重算时
 * 它照常再报（胶水层的 warnOnce 也在同一层去重）。
 * onIssue(kind, path, detail) 是旁路诊断回调，不影响返回值：
 * - 'read-error'：文件在但读失败、该条目/该层省略（胶水层映射 warn）
 * - 'entry-frontmatter'：条目缺/不合规 frontmatter，该条目不进索引（胶水层映射 warn）
 * - 'layer-title-dup'：层内 title 撞名，那几行在注入索引里按 title 分不出谁是谁（胶水层映射 warn）
 * - 'layer-title-coverage'：本层有几条 title 判不了，重名结论只覆盖其余条目（胶水层映射 warn）
 */
export function composeMemory({ memoryRoot, cwd, onIssue } = {}) {
	const habitDir = resolveLayerDir({ memoryRoot, layer: 'habit' })
	const rulesPath = join(habitDir, WRITING_FILE)
	// 层位置问 resolveLayerDir 一份（读侧与写侧认同一套映射）；这里多出的判定是装配侧的
	// 「这一层在不在本次块里」——缺 cwd 或桶名归一后为空即省略整层，不是错误、不报 issue。
	// 判定提前到算键之前：键里那一维必须与真正装不装这一层同口径，否则键变而块不变
	const hasWorkspace = typeof cwd === 'string' && cwd.length > 0 && workspaceSlug(cwd).length > 0
	const workspaceDir = hasWorkspace ? resolveLayerDir({ memoryRoot, layer: 'workspace', cwd }) : ''
	const key = JSON.stringify([
		typeof cwd === 'string' ? cwd : '',
		habitDir,
		workspaceDir,
		dirFingerprint(habitDir),
		workspaceDir === '' ? '' : dirFingerprint(workspaceDir),
		fileFingerprint(rulesPath),
	])
	const cached = blockCache.get(key)
	if (cached !== undefined) return cached

	const report = onIssue ?? (() => {})
	const parts = []
	/**
	 * 被切过的层记到这里，块尾再收一句总的。各层正文里本来就有那层自己的截断标注，而块尾这句
	 * 答的是另一个问题——「这一块有几层没装全」：层序在后、越读越长，那几行标注会被越读越远，
	 * 而块尾是本块唯一的整体结论位。判据是「逐层截断真的发生过」，不是整块超没超定档：
	 * 定档那重运行期不截（截了会连写侧纪律一起丢），它只由离线自检判红。
	 */
	const cutLayers = []
	const pushLayer = (title, dir) => {
		if (!existsSync(dir)) return
		const block = indexBlockOf(scanLayer(dir, { read: readEntryHead, report }))
		if (block === null) return
		const budgeted = applyIndexBudget(block)
		parts.push(`## ${title}\n基目录：${dir}\n\n${budgeted.text}`)
		// cutLabel 与层内那条标注同一个出处（core.js 的 applyIndexBudget）：两处各写一遍
		// 格式，早晚一句说行一句说字符，而「切在哪一重」这句话该由一处判
		if (budgeted.truncated) cutLayers.push(`${title} ${budgeted.cutLabel}`)
	}

	const rules = readCapped(rulesPath)
	if (rules.status === 'ok') parts.push(`## 记忆书写（写侧纪律）\n\n${rules.text}`)
	else if (rules.status === 'read-error') report('read-error', rulesPath, rules.message)

	pushLayer('习惯层（跨机同步）', habitDir)
	if (hasWorkspace) pushLayer('工作层（本工作区·本机专属）', workspaceDir)

	const block = parts.length === 0 ? '' : [
		'[记忆索引] 索引常驻；条目正文按需读取。',
		...parts,
		...(cutLayers.length === 0 ? [] : [`（本次注入有 ${cutLayers.length} 层索引超预算已截断：${cutLayers.join('、')}——用 memory 工具 lint 定位收敛）`]),
	].join('\n\n')
	blockCache.set(key, block)
	if (blockCache.size > CACHE_CAPACITY) blockCache.delete(blockCache.keys().next().value)
	return block
}
