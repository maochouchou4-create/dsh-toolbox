/**
 * dsh-memory 的端口写侧：upsert（建/覆写条目）与 edit（按节锚定改正文＋按键改 frontmatter）。
 *
 * 职责边界：**本文件的全部 I/O 经注入的 fs 端口**（fs-port.js）——生产接宿主 ctx.fs
 * （连带会话文件策略、原子发布与中断信号），测试接 node:fs 替身，故两个动作是 async；
 * 端口同时是会话策略的唯一问口（assertWritable），所以写侧不必认识 SandboxPolicy。
 * 本文件的本地导入闭包零 node:fs 导入，于是「upsert/edit 的 I/O 只经 fs 端口」在导入图上
 * 可机器验证到闭包一级（test/imports.test.js 的闭包断言），而不是只验到本文件这一跳、
 * 靠下游模块的自觉维持。删除与体检在 delete.js／lint.js，它们直连 node:fs 是刻意取舍
 * （删＝宿主 fs 契约没有删除原语；读与列目录读侧本就走 node:fs），理由写在各自文件头。
 *
 * 寻址：file_path 与 scope 的解析问 core.js 的 parseFilePath（write/edit/delete 三路共用，
 * 全形式与裸名的差别只在那儿判一次）；裸名的落段由本文件按段探测后交给 resolveBareScope
 * 判定——edit 认不全的名字，write 也不会认。
 *
 * 设计：索引行不是数据，是条目 frontmatter 的派生视图——不落盘、不手写。写侧因此
 * 只写条目文件本身：先校验 frontmatter 契约（恰好 title＋description 两键），再把
 * 这一轮将出现在注入里的那一行原样回给调用方核对。目录里那份无锁读改写的 MEMORY.md
 * 随之消失，一整类并发丢写竞态是没了文件而不是被堵上。
 * 拦截类问题（frontmatter 契约／文件名／段值／失控保护／同名）直接 throw；
 * 风格类问题（日期戳、派生行超长）进 warnings 提示不拦截。
 *
 * edit 的锚定契约：正文按 ## 节组织（patterns.js 的节判定），正文编辑以节标题为锚——
 * 逐字复述正文当锚点会让「改几行」退化成「先读整篇再重发整篇」，而复述稍有出入就是
 * 未命中；节标题是条目里本来就短且唯一的现成锚点。frontmatter 两键同理按键改，不整块
 * 重写 frontmatter（键的其余行不该被一次正文编辑碰到）。
 */
import { join } from 'node:path'
import { assertRegularFile } from '../fs-guard.js'
import { resolveRoot } from '../memory-root.js'
import { isNonBlankString } from '../value.js'
import { RUNAWAY_CEILING, SHARED_SEGMENT, parseFilePath, resolveBareScope, resolveScopeDir, scopeCandidates, scopeProbePaths } from './core.js'
import {
	FRONTMATTER_HEAD_MAX_BYTES,
	FRONTMATTER_HEAD_PROBE_BYTES,
	assertEntryFrontmatter,
	deriveIndexLine,
	findFenceEnd,
	groupTitlesByTitle,
	hasClosedFence,
	normalizeLineEndings,
} from './frontmatter.js'
import { assertEntryFile, isEntryName } from './naming.js'
import { sectionHeadings, styleWarnings } from './patterns.js'

/**
 * 段内同名拦截：派生行以 title 为准，两个文件共用一个 title 会让注入块里的两行
 * 无法区分（链接目标仍各自正确，所以这只是可读性问题，但索引行是人读的那一层）。
 * 必须在写盘前查完——拦截类承诺「不落盘」，先写后查会留下要人工收拾的重名对。
 *
 * 查重范围＝落位的那一段（不跨段）：段隔离正是「两机各自干净、合流后同名照旧」这条
 * 设计的前提，跨段查重会把对机同名的两条（本来就谁也看不见谁）变成写不进去。
 *
 * 取 title 只读文件头，不整篇读：frontmatter 恒在头部几百字节，而条目正文可以到几十 KB，
 * 整篇读进来的那些字节在这次判定里没有任何用处，成本却按同段条数累加。端口的 readHead
 * 正是为此存在的原语——它与写入同走一条 I/O 通道，头读没有为同名检查开后门。
 *
 * 先探后升而不是一次读满：绝大多数条目一次探测块就闭合，省下的是常态路径上的一次
 * 大窗口传输；只有围栏未闭合的病态条目付第二次兜底往返，而那类条目无论读多少都
 * 判为不合规——兜底往返只影响成本，不改变判定口径。
 *
 * 同段条目 frontmatter 不合规时不当作「无同名」：那个条目的 title 不可知，无从证明
 * 新 title 是空的，按 Parse, don't validate 就得报出来而不是放行——否则撞名条目躲在
 * 坏条目后面就再也拦不住。
 */
async function assertTitleFree({ port, dir, title, file, signal }) {
	const dirTarget = await port.resolve(dir)
	if ((await port.stat(dirTarget, signal)).kind !== 'present') return
	// 先把同段各条的头读完，再把这份材料交给 frontmatter.js 那份共享判定。读法（只读头、
	// 探不到就升窗口）是本侧特有的；「哪些参与同名比较、哪些 title 不可知」不是，两侧
	// 各判一次就会漂，而漂出来的症状是体检沉默而写侧事后拦
	const heads = []
	for (const entry of await port.listDir(dirTarget, signal)) {
		if (entry.type !== 'file' || !isEntryName(entry.name) || entry.name === file) continue
		const entryTarget = await port.resolve(join(dir, entry.name))
		let head = await port.readHead(entryTarget, FRONTMATTER_HEAD_PROBE_BYTES, signal)
		if (!hasClosedFence(head)) head = await port.readHead(entryTarget, FRONTMATTER_HEAD_MAX_BYTES, signal)
		heads.push({ name: entry.name, text: head })
	}
	const { byTitle, unparsable } = groupTitlesByTitle(heads)
	const sameTitle = byTitle.get(title)
	if (sameTitle !== undefined) {
		// 点名全部撞上的条目（不只第一条）：照着改要一次改对，逐条撞过去得来回几趟。
		// 处置给 edit 不给先 delete，与体检那份同向——上面的扫描把待写这条排除在外，
		// 报出来的每一条都是各自带正文的现存条目，先删掉丢的是内容
		throw new Error(`段内已有同名条目「${title}」（${sameTitle.join('、')}）——用 edit 的 title 参数改其中一条的 frontmatter title，不要先 delete：同名扫描把待写这条（${file}）排除在外，报出来的每一条都是各自带正文的现存条目`)
	}
	// 坏条目要数完再报：遇到第一条就抛，报的是「这一条」而实际要修的可能是好几条，读到的人
	// 修完第一条再撞第二条，来回几趟才撞得完。脱困路径按条数分两种说法——write 的同名扫描
	// 只跳过被写的那一条，两条坏条目并存时写哪一条都会被另一条挡住，这时候说「write 是唯一
	// 还能写的路径」就是把模型送进死循环。脱困走 write 而非 edit：坏条目的 frontmatter 缺的
	// 是键本身，edit 的按键编辑只改现存键行，补不出缺失的键
	const broken = unparsable.map(({ name, error }) => `「${name}」${error}`)
	if (broken.length === 1) {
		throw new Error(`段内 1 条 frontmatter 不合规（${broken[0]}）——同名判定不可信，别的条目暂时写不了。用 write 以修好 frontmatter 的全文重写这一条：同名扫描把待写这条排除在外，它是本段内唯一还能写的路径`)
	}
	if (broken.length > 1) {
		throw new Error(`段内 ${broken.length} 条 frontmatter 不合规（${broken.join('；')}）——同名判定不可信，别的条目暂时写不了。先 delete 掉多余的坏条目，只剩一条时用 write 以修好 frontmatter 的全文重写它（那时它在同名扫描里被跳过，是本段内唯一还能写的路径——两条并存时写任一条都会被另一条挡住）`)
	}
}

/**
 * 写条目（upsert）：解析 file_path／scope → 校验 frontmatter 契约 → 派生索引行 → 路径守卫
 * → 同名拦截 → 落盘。
 * 拦截：非 kebab 文件名、content 空/超失控保护、frontmatter 缺失或越界
 * （缺键/空值/第三键/title 带方括号/多行折行）、条目名被同名目录占用（非普通文件，
 * 与 edit 及端口适配器同一份判定与同一个码）、段内同名、会话策略不许写
 * （问端口，不自己认 SandboxPolicy）、全形式与 scope 冲突。
 * 提示（warnings）：description 含日期戳、派生索引行超长。
 * 版本守卫：调用方传入 entryVersion 时照该版本写（editEntry 读条目时透传），
 * 期间被别人改过即抛错。write 缺省不护——它的语义是「以我这份为准」，
 * 并发两次 write 谁后到谁赢属调用方自己的选择。
 * scope 缺省＝config.machine（未配置机器时 shared）：工具永远可用，跨机帮写走全形式。
 */
export async function upsertEntry({ port, memoryRoot, machine, scope, file, content, entryVersion, signal }) {
	const parsed = parseFilePath(file, scope, machine)
	assertEntryFile(parsed.file)
	port.assertWritable()
	if (!isNonBlankString(content)) throw new Error('content 不能为空')
	if (content.length > RUNAWAY_CEILING) {
		throw new Error(`content ${content.length} 字符超失控保护 ${RUNAWAY_CEILING}——先收敛再写（拆条目或精简）`)
	}
	const { title, description } = assertEntryFrontmatter(content, parsed.file)
	const indexLine = deriveIndexLine({ title, description, file: parsed.file })
	const targetScope = parsed.scope ?? SHARED_SEGMENT
	const dir = resolveScopeDir(resolveRoot(memoryRoot), targetScope)
	const entry = join(dir, parsed.file)
	const target = await port.resolve(entry)
	// 同名目录占着条目名时在扫段之前就炸：扫完再炸等于白扫一遍段内全部条目，而
	// edit 与端口适配器早就用同一个码报同一件事（判定与文案都在 fs-guard.js）
	assertRegularFile(await port.stat(target, signal), entry)
	await assertTitleFree({ port, dir, title, file: parsed.file, signal })
	const guard = entryVersion === undefined ? undefined : { kind: 'replaceIfVersion', version: entryVersion }
	await port.writeText(target, content.endsWith('\n') ? content : `${content}\n`, guard, signal)
	// 结果键与工具出参对齐叫 file_path（工具参数面同名）；内部形参仍叫 file——它是
	// 「文件名」这个物，不是宿主参数面的那份契约。scope 报的是落成的段值（shared 或机器 id）
	return { scope: targetScope, dir, file_path: parsed.file, indexLine, warnings: styleWarnings({ description, indexLine }) }
}

/**
 * 编辑目标的两类改写，都在内存里算完再交 upsert 落盘：frontmatter 契约、失控保护、
 * 同名这些拦截必须发生在写盘之前，先写后验会留下半截改动。
 */

/**
 * 按节替换正文：锚定节标题行，整段换掉标题行之下、下一同级标题之前的正文 span。
 * body 按字面成行——它末尾带不带换行（即与下一节隔开的空行）由调用方写明，这里不补
 * 也不删；空串＝删光节正文只留标题行。锚点比对用去空白后的标题（尾随空格不构成「另一个
 * 标题」），未命中列出全部节标题让调用方就地挑对，重名拒绝——锚不唯一时替换落到哪节
 * 全凭运气，那是误伤不是编辑。
 */
function replaceSectionBody({ lines, wanted, body }) {
	const headings = sectionHeadings(lines.join('\n'))
	if (headings.length === 0) {
		throw new Error('条目内没有 ## 节——按节锚定找不到锚点。正文还没有按节组织，用 write 重写整条补上节结构')
	}
	const matches = headings.filter((item) => item.title === wanted)
	if (matches.length === 0) {
		const known = headings.map((item) => `「${item.title}」`).join('、')
		throw new Error(`节标题「${wanted}」未命中——条目内的 ## 节标题：${known}。按节锚定的锚点是节标题，不逐字复述正文`)
	}
	if (matches.length > 1) {
		throw new Error(`节标题「${wanted}」在条目内命中 ${matches.length} 处——按节锚定要求节标题条目内唯一，先用 lint 定位重名节收敛（lint 的节重名项）`)
	}
	const anchorLine = matches[0].line
	const nextHeadingLine = headings.find((item) => item.line > anchorLine)?.line
	const bodyLines = body.length === 0 ? [] : normalizeLineEndings(body).split('\n')
	return [...lines.slice(0, anchorLine + 1), ...bodyLines, ...lines.slice(nextHeadingLine ?? lines.length)].join('\n')
}

/**
 * 按键替换 frontmatter：只重写 title/description 各自的那一行，frontmatter 其余行与
 * 正文一概不碰。键行不在（条目 frontmatter 缺该键）即拦——按键编辑补不出缺失的键，
 * 那是结构问题，write 重写整条才是对症路径（见 assertTitleFree 的脱困指引）。
 */
function replaceFrontmatterKeys({ lines, file, title, description }) {
	const fenceEnd = findFenceEnd(lines)
	if (fenceEnd === -1) throw new Error(`条目 ${file} 的 frontmatter 没有闭合围栏——按键编辑无从下手，用 write 重写整条`)
	const next = [...lines]
	for (const [key, value] of [['title', title], ['description', description]]) {
		if (value === undefined) continue
		const keyLine = next.slice(1, fenceEnd).findIndex((line) => line.startsWith(`${key}:`))
		if (keyLine === -1) {
			throw new Error(`条目 frontmatter 里没有「${key}:」行——按键编辑只改现存键，键缺失时用 write 重写整条`)
		}
		next[keyLine + 1] = `${key}: ${value}`
	}
	return next.join('\n')
}

/**
 * 改条目：两类编辑目标一次一个——按节改正文（heading＋body），或改 frontmatter 两键
 * （title/description 可同传）。提供 edit 而非只有 write 的原因：改几行就全文重发是纯
 * 传输成本（输出 token 按整条计），且重抄不变段落本身有引入漂移的风险；校验不降级——
 * 改写结果走 upsert 同一条拦截链（frontmatter 契约/空文/失控保护/同名）。
 * 契约：heading 与 title/description 并存即拦（一次一个编辑目标）；heading 必带 body、
 * body 不带 heading 也拦（那不是任何一类编辑目标）；title/description 须单行（frontmatter
 * 每行一个键）。正文落盘带版本守卫：读条目时观察到的版本透传给 upsert 的 entryVersion，
 * 于是并发两次 edit 同一条目时后者抛 FS_STALE_VERSION，而不是静默吃掉前者刚落的正文
 * 还报成功（readText 与 replaceIfVersion 之间那段窗口正是竞态所在）。
 *
 * edit 不收 scope 参数（工具层显式拒）：裸名在共享段与本机段之间唯一命中，歧义要全形式；
 * 多一个 scope 参数就是第二个真相源，与 file_path 里那段冲突时谁赢都说不清。
 */
export async function editEntry({ port, memoryRoot, machine, file, heading, body, title, description, signal }) {
	// 不传裸名缺省段（第三参）：那是 write 的语义，edit 的裸名要按候选段唯一命中
	const parsed = parseFilePath(file)
	assertEntryFile(parsed.file)
	port.assertWritable()
	const editsSection = heading !== undefined
	const editsFrontmatter = title !== undefined || description !== undefined
	if (editsSection && typeof body !== 'string') {
		throw new Error(`heading 编辑必须带 body（该节标题行之下、下一同级标题之前的整段正文；空串＝删除该节正文保留标题行），收到 ${body === undefined ? '未传' : typeof body}`)
	}
	if (!editsSection && body !== undefined) {
		throw new Error('body 须与 heading 同传——body 是按节替换的正文，没有 heading 就没有锚点')
	}
	if (!editsSection && !editsFrontmatter) {
		throw new Error('edit 没有编辑目标——按节改正文传 heading（＋body），改 frontmatter 传 title／description（两键可同传）')
	}
	if (editsSection && editsFrontmatter) {
		throw new Error('heading 与 title/description 不能并存——edit 一次只改一个编辑目标，正文与 frontmatter 分两次 edit')
	}
	for (const [key, value] of [['title', title], ['description', description]]) {
		if (typeof value === 'string' && /[\r\n]/.test(value)) {
			throw new Error(`${key} 须为单行（frontmatter 每行一个键，折行值会把行结构撑破）`)
		}
	}
	const root = resolveRoot(memoryRoot)
	let targetScope = parsed.scope
	if (targetScope === undefined) {
		// 裸名：在候选段里探一遍，落段由 core 那份唯一命中判定给（歧义与不存在两句报错都在那儿）。
		// 待探路径的拼装也问 core：段序与路径拼法在写侧与删侧各写一遍时会分家
		const scopes = scopeCandidates(machine)
		const present = []
		const probes = scopeProbePaths(root, scopes, parsed.file)
		for (const [index, probe] of probes.entries()) {
			const probed = await port.stat(await port.resolve(probe), signal)
			if (probed.kind === 'present') present.push(scopes[index])
		}
		targetScope = resolveBareScope({ file: parsed.file, scopes, present })
	}
	const dir = resolveScopeDir(root, targetScope)
	const entry = join(dir, parsed.file)
	const entryTarget = await port.resolve(entry)
	const entryObserved = await port.stat(entryTarget, signal)
	assertRegularFile(entryObserved, entry)
	if (entryObserved.kind !== 'present') throw new Error(`条目不存在：${entry}`)
	const normalized = normalizeLineEndings(await port.readText(entryTarget, signal))
	const lines = normalized.split('\n')
	const wanted = editsSection ? heading.trim() : undefined
	const nextContent = editsSection
		? replaceSectionBody({ lines, wanted, body })
		: replaceFrontmatterKeys({ lines, file: parsed.file, title, description })
	const result = await upsertEntry({ port, memoryRoot, machine, scope: targetScope, file: parsed.file, content: nextContent, entryVersion: entryObserved.version, signal })
	return editsSection
		? { ...result, section: wanted }
		: { ...result, frontmatterEdited: [title !== undefined && 'title', description !== undefined && 'description'].filter(Boolean) }
}
