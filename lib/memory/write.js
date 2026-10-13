/**
 * dsh-memory 的端口写侧：upsert（建/覆写条目）与 edit（对现存条目的字面替换）。
 *
 * 职责边界：**本文件的全部 I/O 经注入的 fs 端口**（fs-port.js）——生产接宿主 ctx.fs
 * （连带会话文件策略、原子发布与中断信号），测试接 node:fs 替身，故两个动作是 async；
 * 端口同时是会话策略的唯一问口（assertWritable），所以写侧不必认识 SandboxPolicy。
 * 本文件的本地导入闭包零 node:fs 导入，于是「upsert/edit 的 I/O 只经 fs 端口」在导入图上
 * 可机器验证到闭包一级（test/imports.test.js 的闭包断言），而不是只验到本文件这一跳、
 * 靠下游模块的自觉维持。删除与体检在 delete.js／lint.js，它们直连 node:fs 是刻意取舍
 * （删＝宿主 fs 契约没有删除原语；读与列目录读侧本就走 node:fs），理由写在各自文件头。
 *
 * 设计：索引行不是数据，是条目 frontmatter 的派生视图——不落盘、不手写。写侧因此
 * 只写条目文件本身：先校验 frontmatter 契约（恰好 title＋description 两键），再把
 * 这一轮将出现在注入里的那一行原样回给调用方核对。目录里那份无锁读改写的 MEMORY.md
 * 随之消失，一整类并发丢写竞态是没了文件而不是被堵上。
 * 拦截类问题（frontmatter 契约／文件名／层／桶／失控保护／同名）直接 throw；
 * 风格类问题（日期戳、派生行超长）进 warnings 提示不拦截。
 *
 * 已知未解：旧工具偶发抛「oldString 不能为空」（同一 payload 重试即过，实测复现过
 * 两次）。本文件对非空串的校验没有竞态面——那条错只可能由入参本身为空触发，
 * 而重试即过说明入参在两次调用间并不相同。据此无法在本文件内定位根因，不猜。
 * 规避姿势：撞到该错原样重试一次；重试仍报再 read 条目核对 payload 是不是被中途改写。
 */
import { join } from 'node:path'
import { INDEX_LINE_CHAR_BUDGET, RUNAWAY_CEILING, resolveLayerDir } from './core.js'
import {
	FRONTMATTER_HEAD_MAX_BYTES,
	FRONTMATTER_HEAD_PROBE_BYTES,
	assertEntryFrontmatter,
	deriveIndexLine,
	hasClosedFence,
	isEntryName,
	parseFrontmatter,
} from './frontmatter.js'
import { DATE_RE, assertEntryFile } from './patterns.js'

/**
 * 端口 stat 的判定收口：「在」不等于「是文件」。同名目录撞上条目名时，
 * 不许它一路走到某次读写才炸成后端原生的英文错误（宿主口径 FS_NOT_REGULAR_FILE）。
 */
function assertRegularFile(observed, path) {
	if (observed.kind === 'present' && observed.type !== 'file') {
		throw codedError(`路径不是普通文件（${observed.type}）：${path}——记忆条目只能是文件`, 'FS_NOT_REGULAR_FILE')
	}
}

/** 宿主词表里的失败要带 code：裸 Error 拿不到，harness 的 toolErrorResult 与模型都看不见类型。 */
function codedError(message, code) {
	const error = new Error(message)
	error.code = code
	return error
}

/** 风格类提示（不拦截）：日期戳、派生行超长。 */
function entryWarnings({ description, indexLine }) {
	const warnings = []
	if (DATE_RE.test(description)) warnings.push('description 含日期戳（WRITING.md：不写日期戳，时序归 git）')
	if (indexLine.length > INDEX_LINE_CHAR_BUDGET) {
		warnings.push(`派生索引行 ${indexLine.length} 字符超 ${INDEX_LINE_CHAR_BUDGET}——收敛 description（整行上限即 description 上限的推论）`)
	}
	return warnings
}

/**
 * 层内同名拦截：派生行以 title 为准，两个文件共用一个 title 会让注入块里的两行
 * 无法区分（链接目标仍各自正确，所以这只是可读性问题，但索引行是人读的那一层）。
 * 必须在写盘前查完——拦截类承诺「不落盘」，先写后查会留下要人工收拾的重名对。
 *
 * 取 title 只读文件头，不整篇读：frontmatter 恒在头部几百字节，而条目正文可以到几十 KB，
 * 整篇读进来的那些字节在这次判定里没有任何用处，成本却按同层条数累加。端口的 readHead
 * 正是为此存在的原语——它与写入同走一条 I/O 通道，头读没有为同名检查开后门。
 *
 * 先探后升而不是一次读满：绝大多数条目一次探测块就闭合，省下的是常态路径上的一次
 * 大窗口传输；只有围栏未闭合的病态条目付第二次兜底往返，而那类条目无论读多少都
 * 判为不合规——兜底往返只影响成本，不改变判定口径。
 *
 * 同层条目 frontmatter 不合规时不当作「无同名」：那个条目的 title 不可知，无从证明
 * 新 title 是空的，按 Parse, don't validate 就得报出来而不是放行——否则撞名条目躲在
 * 坏条目后面就再也拦不住。
 */
async function assertTitleFree({ port, dir, title, file, signal }) {
	const dirTarget = await port.resolve(dir)
	if ((await port.stat(dirTarget, signal)).kind !== 'present') return
	const broken = []
	for (const entry of await port.listDir(dirTarget, signal)) {
		if (entry.type !== 'file' || !isEntryName(entry.name) || entry.name === file) continue
		const entryTarget = await port.resolve(join(dir, entry.name))
		let head = await port.readHead(entryTarget, FRONTMATTER_HEAD_PROBE_BYTES, signal)
		if (!hasClosedFence(head)) head = await port.readHead(entryTarget, FRONTMATTER_HEAD_MAX_BYTES, signal)
		const parsed = parseFrontmatter(head)
		if (!parsed.ok) {
			broken.push(`「${entry.name}」${parsed.error}`)
			continue
		}
		if (parsed.frontmatter.title === title) {
			throw new Error(`层内已有同名条目「${title}」（${entry.name}）——先 delete 再改名`)
		}
	}
	// 坏条目要数完再报：遇到第一条就抛，报的是「这一条」而实际要修的可能是好几条，读到的人
	// 修完第一条再撞第二条，来回几趟才撞得完。脱困路径按条数分两种说法——edit 的同名扫描
	// 只跳过被改的那一条，两条坏条目并存时改哪一条都会被另一条挡住，这时候说「edit 是唯一
	// 还能写的路径」就是把模型送进死循环
	if (broken.length === 1) {
		throw new Error(`层内 1 条 frontmatter 不合规（${broken[0]}）——同名判定不可信，别的条目暂时写不了。用 edit 改这一条本身：它在同名扫描里被跳过，是层内唯一还能写的路径，oldString 先用宿主 read 工具取它的现文`)
	}
	if (broken.length > 1) {
		throw new Error(`层内 ${broken.length} 条 frontmatter 不合规（${broken.join('；')}）——同名判定不可信，别的条目暂时写不了。先 delete 掉其中多余的坏条目，只剩一条时用 edit 改它（那时它在同名扫描里被跳过，是层内唯一还能写的路径；两条并存时改任一条都会被另一条挡住），oldString 先用宿主 read 工具取它的现文`)
	}
}

/**
 * 写条目（upsert）：校验 frontmatter 契约 → 派生索引行 → 同名拦截 → 落盘。
 * 拦截：非 kebab 文件名、content 空/超失控保护、frontmatter 缺失或越界
 * （缺键/空值/第三键/title 带方括号/多行折行）、层内同名、会话策略不许写
 * （问端口，不自己认 SandboxPolicy）。
 * 提示（warnings）：description 含日期戳、派生索引行超长。
 * 版本守卫：调用方传入 entryVersion 时照该版本写（editEntry 读条目时透传），
 * 期间被别人改过即抛错。write 缺省不护——它的语义是「以我这份为准」，
 * 并发两次 write 谁后到谁赢属调用方自己的选择。
 */
export async function upsertEntry({ port, memoryRoot, cwd, layer, file, content, entryVersion, signal }) {
	assertEntryFile(file)
	port.assertWritable()
	if (typeof content !== 'string' || content.trim().length === 0) throw new Error('content 不能为空')
	if (content.length > RUNAWAY_CEILING) {
		throw new Error(`content ${content.length} 字符超失控保护 ${RUNAWAY_CEILING}——先收敛再写（拆条目或精简）`)
	}
	const { title, description } = assertEntryFrontmatter(content, file)
	const indexLine = deriveIndexLine({ title, description, file })
	const dir = resolveLayerDir({ memoryRoot, layer, cwd })
	await assertTitleFree({ port, dir, title, file, signal })
	const guard = entryVersion === undefined ? undefined : { kind: 'replaceIfVersion', version: entryVersion }
	await port.writeText(await port.resolve(join(dir, file)), content.endsWith('\n') ? content : `${content}\n`, guard, signal)
	return { layer, dir, file, indexLine, warnings: entryWarnings({ description, indexLine }) }
}

/**
 * 改条目（外科手术式替换）：对现存正文做字面 old→new 替换后整文落盘，索引行按改完的
 * frontmatter 重算（内容是数据、索引行是派生，天然跟着走）。
 * 提供 edit 而非只有 write 的原因：改几行就全文重发是纯传输成本（输出 token 按整条计），
 * 且重抄不变段落本身有引入漂移的风险；校验不降级——替换结果走 upsert 同一条拦截链
 * （frontmatter 契约/空文/失控保护/同名）。
 * 契约：oldString 字面精确匹配（不命中即拦——提醒先 read 再改；多处命中未声明
 * replaceAll 即拦防误伤）；newString 按字面写入，其中的模式符号（$$、$&、$'、$`）
 * 一律不解释——正文写正则笔记时不会被展开成匹配前后文；正文入口把 \r\n 归一为 \n（git checkout 的 CRLF 形态下
 * 跨行 oldString 才可达，落盘统一 LF）；尾部空行原样保留（upsert 只补一个 \n，
 * 多出的尾空行是作者形态，替换不该动它）。
 * 正文落盘带版本守卫：读条目时观察到的版本透传给 upsert 的 entryVersion，于是并发
 * 两次 edit 同一条目时后者抛 FS_STALE_VERSION，而不是静默吃掉前者刚落的正文还
 * 报成功（readText 与 replaceIfVersion 之间那段窗口正是竞态所在）。
 * 替换先在内存里算完再交 upsert 落盘：编辑后空文、失控保护、frontmatter 契约这些
 * 拦截必须发生在写盘之前，先写后验会留下半截改动。
 */
export async function editEntry({ port, memoryRoot, cwd, layer, file, oldString, newString, replaceAll, signal }) {
	assertEntryFile(file)
	port.assertWritable()
	if (typeof oldString !== 'string' || oldString.length === 0) {
		throw new Error('oldString 不能为空（字面精确匹配的原文片段；命中不了就 read 条目现文再改）')
	}
	if (typeof newString !== 'string') throw new Error('newString 必须为字符串（删除内容传空串）')
	if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
		throw new Error(`replaceAll 须为布尔（多处命中全换开关），收到 ${typeof replaceAll} 类型`)
	}
	const dir = resolveLayerDir({ memoryRoot, layer, cwd })
	const entry = join(dir, file)
	const entryTarget = await port.resolve(entry)
	const entryObserved = await port.stat(entryTarget, signal)
	assertRegularFile(entryObserved, entry)
	if (entryObserved.kind !== 'present') throw new Error(`条目不存在：${entry}`)
	const normalized = (await port.readText(entryTarget, signal)).replace(/\r\n/g, '\n')
	const tail = /\n+$/.exec(normalized)?.[0] ?? ''
	const body = normalized.slice(0, normalized.length - tail.length)
	const hits = body.split(oldString).length - 1
	if (hits === 0) throw new Error('oldString 在正文中未命中——先 read 条目现文再改，勿凭印象')
	if (hits > 1 && !replaceAll) throw new Error(`oldString 命中 ${hits} 处——收窄 oldString 或显式 replaceAll`)
	// 字面替换走 split/join：String.replace 的字符串替换会解释 newString 里的 $ 模式
	// （`$` 插入匹配前文、`$'` 插入匹配后文、`$&` 插回命中段、$$ 转义），条目正文里
	// 出现 ``$` `` 这类写法（写规则类正文很常见）会被静默放大成整条内容复制。
	// 唯一命中已由上面的 hits 校验保证（多处未声明 replaceAll 即拦），故两条分支合一。
	const nextBody = body.split(oldString).join(newString)
	const nextContent = nextBody + tail
	if (nextContent.trim().length === 0) throw new Error('编辑后正文为空——整条删除走 delete')
	const result = await upsertEntry({ port, memoryRoot, cwd, layer, file, content: nextContent, entryVersion: entryObserved.version, signal })
	// replacements 报实际改动处数（newString 与 oldString 全等时命中≠改动，报 0）
	return { ...result, replacements: nextBody === body ? 0 : hits }
}
