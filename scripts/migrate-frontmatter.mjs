#!/usr/bin/env node
/**
 * 老布局条目迁到 frontmatter 两键：`name:`／`description:`／`metadata:` → `title`＋`description`。
 *
 * 为什么要有它：frontmatter 契约一改，全层条目同时变成不合规，而同名判定要求全层可解析——
 * 于是那一层所有条目一次性写不了：逐条写入的通道被堵死（`edit` 的豁免只覆盖被改的那一条，
 * 两条坏条目并存时改任一条都被另一条挡住），只能退回手工改文件。迁移脚本把这条退路铺好：
 * 契约再改时先跑它，而不是一条条手工拆弹。
 *
 * 用法：node scripts/migrate-frontmatter.mjs <记忆根> [--apply]
 * 默认 dry-run（逐条打印将要做什么），`--apply` 才落盘。记忆根缺省 ~/.dsh/memory。
 * 退出码：0＝无待迁条目且无跳过；1＝有待迁条目（dry-run）、有跳过条目、记忆根没接线。
 *
 * description 原值一律保留：它是人／模型读正文后写的触发词，脚本凭空生成一个等于把召回面
 * 换成一段编的文本，而 description 的失效没有任何症状。title 缺失时才从正文派生。
 *
 * 判据不重写：层清点问 layers.js，条目命名与保留名（含「哪个是已退役的索引」）问
 * frontmatter.js，行归一与围栏定位也问它，转换结果是否合规问 assertEntryFrontmatter，
 * 转换结果按层是否撞名问那份共享的重名判定。本脚本只做「删死字段 + 补缺失的 title」
 * 这一层行级机械替换，不自扫目录、不自写一套 frontmatter 解析——那两样一旦分家，
 * 迁移就会按另一套契约判「迁好了」。
 *
 * 两条不打算实现的行为，先说清免得被当成疏漏：
 * ① **行尾会被整篇归一为 LF**（行归一在前，转换在其后）。这是刻意与写侧同口径：write.js 的
 *    edit 同样把 CRLF 归一为 LF，迁移若另搞一套保真，家机跑一次 `--apply` 就会造出与
 *    写侧不一致的正文，而 git diff 也只看不出差别的那部分。dry-run 会显式报出有几个文件
 *    将被翻转行尾，让人知道自己要往哪个仓提 diff。
 * ② **删除仍是 rmSync**：宿主 fs 契约没有删除原语（见 fs-port.js 文件头的写侧边界），
 *    迁移脚本直连 node:fs 才走得通；写入则仍走 fs 端口的原子发布（临时件 + 改名），
 *    崩在写一半只会留一个 .tmp 残件，不会留一条被截断的条目。
 *
 * 半成态：备份完成后、动第一个文件之前先打印备份目录；写入循环若中断，报「已改 N 条后
 * 中断」并把备份目录与「重跑幂等收敛」一并说清。批量原地重写没有撤销键，中途失败时
 * 人必须立刻知道东西在哪、已经动了多少。
 */
import process from 'node:process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describeError, resolveRoot } from '../lib/memory/core.js'
import { createNodeFsPort } from '../lib/memory/fs-port.js'
import {
	assertEntryFrontmatter,
	findFenceEnd,
	frontmatterLines,
	groupTitlesByTitle,
	isEntryName,
	isRetiredIndexFile,
	stemOf,
} from '../lib/memory/frontmatter.js'
import { listLayerDirs } from '../lib/memory/layers.js'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
// 记忆根实参原样留着，缺省兜底与绝对化由 resolveRoot 收（core.js 归一的唯一出口）
const rawMemoryRoot = args.find((arg) => !arg.startsWith('--'))

/** 是否已合规（幂等判据就走契约本身，不另定一份「像不像合规」）。 */
function isCompliant(text, file) {
	try {
		assertEntryFrontmatter(text, file)
		return true
	} catch {
		return false
	}
}

/**
 * 从正文首个 H1 派生 title：取 `^# ` 之后、`（`／`(`／`：`／`—` 之前的部分。
 * 那些标点是作者给副标题留的入口（「……（DSH 载体）」），索引行里连着正文一起太长且重复。
 * 仍为空（正文无 H1，或 H1 一上来就是括号）就交回文件名 stem——派生不出语义名时，
 * stem 至少是唯一且可查的。
 */
function deriveTitleFromBody(body) {
	const heading = /^# (.+)$/m.exec(body.join('\n'))
	if (heading === null) return ''
	return heading[1].split(/[（(：—]/)[0].trim()
}

/**
 * 老布局 → 两键。行级机械替换：删 `name:`（与文件名重复的死字段，两键之外没有消费者）、
 * 删 `metadata:` 及其后所有缩进行（块标量形态），`title:` 缺失时补一个（正文 H1，退到文件名
 * stem）。正文与 description 原样带走。
 *
 * 返回 { text: null, reason }＝没有成形的 frontmatter 块（首行不是围栏或未闭合），调用方据此
 * 跳过：那种文件的头不是一个可机械改写的块，硬改就是在猜。
 */
function convertEntry(text, file) {
	// 行归一与围栏定位都问 frontmatter.js：家机 CRLF 条目按 \n 直切的话闭合围栏永不命中，
	// 而「迁移脚本用自己那份切法」正是这层知识分家的起点
	const lines = frontmatterLines(text)
	const close = findFenceEnd(lines)
	if (close === -1) {
		return { text: null, reason: lines[0] === '---' ? 'frontmatter 未闭合（缺收尾的 --- 行），机械转换无从下手' : '首行不是 ---，没有成形的 frontmatter 块' }
	}
	const kept = []
	let inMetadataBlock = false
	for (const line of lines.slice(1, close)) {
		if (/^name:/.test(line)) continue
		if (/^metadata:/.test(line)) {
			inMetadataBlock = true
			continue
		}
		if (inMetadataBlock && /^[ \t]/.test(line)) continue
		// 空行也终结 metadata 块：块内没有空行是规范形态，但一旦有，它后面的内容属于别的键
		inMetadataBlock = false
		kept.push(line)
	}
	if (!kept.some((line) => line.startsWith('title:'))) {
		kept.unshift(`title: ${deriveTitleFromBody(lines.slice(close + 1)) || stemOf(file)}`)
	}
	return { text: ['---', ...kept, '---', ...lines.slice(close + 1)].join('\n'), reason: null }
}

/** 采集：列出将要改的文件（改写与删除）与读不动／转换后仍不合规／转换后与同层撞名而被跳过的文件。 */
function plan(root) {
	const changes = []
	const skipped = []
	let compliantEntries = 0
	let crlfFiles = 0
	for (const { kind, dir } of listLayerDirs(root)) {
		// 先按层攒齐再比对：撞名是「这一层」的性质，攒齐前判只能看见已走过的那几条，
		// 报出来的组会随遍历顺序变化
		const layerChanges = []
		const titled = []
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name)
			const rel = relative(root.root, path)
			if (isRetiredIndexFile(name)) {
				layerChanges.push({ layer: kind, rel, path, kindOfChange: '删除', text: null })
				continue
			}
			if (!isEntryName(name)) continue
			// 读与转换一起包 try：名为 x.md 的目录、权限错、坏块都不该把整轮迁移带崩——
			// 崩掉时连「跳过了什么」都没有，而逐条降级上报是 assemble.js／lint.js 的同款口径
			let text
			try {
				text = readFileSync(path, 'utf8')
			} catch (error) {
				skipped.push({ rel, reason: `读不动：${describeError(error)}` })
				continue
			}
			// 已合规的条目不动、不进备份、不报：迁移脚本被反复跑是常态（每次契约变更跑一次），
			// 每次都去重写一遍已合规的条目只会平白制造 diff 与备份。它仍参与撞名比对——
			// 它占着这个 title，转换结果撞上来就是真的撞名
			if (isCompliant(text, name)) {
				compliantEntries += 1
				titled.push({ name, text })
				continue
			}
			if (text.includes('\r\n')) crlfFiles += 1
			const converted = convertEntry(text, name)
			if (converted.text === null) {
				skipped.push({ rel, reason: converted.reason })
				continue
			}
			try {
				assertEntryFrontmatter(converted.text, name)
			} catch (error) {
				skipped.push({ rel, reason: error.message })
				continue
			}
			layerChanges.push({ layer: kind, rel, path, kindOfChange: '改写', text: converted.text })
			titled.push({ name, text: converted.text })
		}
		// 迁移不得造出它要躲的那个问题：title 缺失时从正文 H1 派生，派生结果没有层内去重，
		// 而本脚本按设计不过 assertTitleFree。静默兜底的后果是三条 H1 同名的条目迁移完
		// 退出码 0、而落盘后 memory lint 立刻报层内重名——这个脚本的存在理由恰恰是
		// 「契约一改全层写不了时先跑它」，把病灶留给下游等于给退路本身再添一条退路。
		// 只把**将被改写**的那几条推进 skipped：已合规的那条不动，它由 lint 那侧照常报出来
		for (const { title, names } of groupTitlesByTitle(titled).dups) {
			for (const name of names) {
				const change = layerChanges.find((item) => item.path === join(dir, name))
				if (change === undefined) continue
				const others = names.filter((other) => other !== name).join('、')
				skipped.push({
					rel: change.rel,
					reason: `转换结果与同层的 ${others} 撞 title「${title}」——改其中一条的 frontmatter title，不要 delete 那一条（两条各带正文）`,
				})
				layerChanges.splice(layerChanges.indexOf(change), 1)
			}
		}
		changes.push(...layerChanges)
	}
	return { changes, skipped, compliantEntries, crlfFiles }
}

/** 备份目录名：ISO 时间戳去掉冒号（家机是 Windows，路径里带冒号建不出来）。 */
const backupStamp = () => new Date().toISOString().replace(/[:.]/g, '-')

/**
 * 备份：改任何文件之前，把将被改的文件按相对记忆根的路径原样复制一份。
 * 理由是工作层不在任何 git 仓里——批量原地重写没有回退路径，出错时唯一能救语料的就是这份副本。
 * 备份目录放在记忆根的**同级**：listLayerDirs 只把 `profile` 与 `workspaces/<x>` 当层扫，
 * 真正的风险只有 `workspaces/` 那一支——备份目录若落进 `workspaces/<时间戳>/`，里面装的
 * .md 会被当成一层扫出来（幽灵层），而落在记忆根顶层则是安全的。
 */
function backup(root, changes) {
	const dir = join(dirname(root.root), 'memory-migrate-backups', backupStamp())
	for (const change of changes) {
		const target = join(dir, change.rel)
		mkdirSync(dirname(target), { recursive: true })
		copyFileSync(change.path, target)
	}
	return dir
}

/** 落盘：写入走 fs 端口的原子发布（崩在写一半只留 .tmp 残件），删除只有 rmSync 可用。 */
async function applyChanges(changes) {
	const port = createNodeFsPort()
	let done = 0
	for (const change of changes) {
		if (change.kindOfChange === '删除') {
			rmSync(change.path)
		} else {
			await port.writeText(await port.resolve(change.path), change.text)
		}
		done += 1
	}
	return done
}

async function main() {
	const root = resolveRoot(rawMemoryRoot)
	const layers = listLayerDirs(root)
	// 记忆根没接线与「层里没有要迁的东西」是两件事，前者印「无可迁移」并以 0 退出，
	// 等于告诉人这一层已经合规，而事实是根本没读到任何层
	if (!existsSync(root.profile) && !existsSync(root.workspaces)) {
		console.log(`记忆根没有层目录（${root.profile} 与 ${root.workspaces} 都不存在）：这不是「无需迁移」，是没读到任何层。先接线（见 README），或把实参指向真正在用的记忆根`)
		process.exitCode = 1
		return
	}
	if (layers.length === 0) {
		console.log(`记忆根下扫到 0 层（${root.profile} 不存在且 ${root.workspaces} 无子目录）：没检到东西，不等于合规`)
		process.exitCode = 1
		return
	}
	const { changes, skipped, compliantEntries, crlfFiles } = plan(root)
	console.log(`记忆根：${root.root}`)
	console.log(`模式：${apply ? '--apply（落盘）' : 'dry-run（只报不做，加 --apply 才落盘）'}`)
	console.log(`已合规条目 ${compliantEntries} 条（不动、不备份、不报）`)
	if (changes.length === 0) {
		if (skipped.length === 0) {
			console.log('待迁条目：0（无需迁移）')
			return
		}
		for (const item of skipped) console.log(`跳过 ${item.rel}：${item.reason}`)
		console.log(`\n待迁 0 条、跳过 ${skipped.length} 条（转换后仍不合规，须人工处理）`)
		process.exitCode = 1
		return
	}
	for (const change of changes) {
		const title = change.text === null ? '（索引文件，不再读）' : /^title:\s*(.*)$/m.exec(change.text)[1]
		console.log(`${apply ? '将' : '拟'} ${change.kindOfChange} ${change.rel}：title「${title}」`)
	}
	for (const item of skipped) console.log(`跳过 ${item.rel}：${item.reason}`)
	if (crlfFiles > 0) console.log(`其中 ${crlfFiles} 个文件是 CRLF 行尾，改写会把它整篇归一为 LF（与写侧 edit 同口径）`)
	if (!apply) {
		console.log(`\n待迁 ${changes.length} 条、跳过 ${skipped.length} 条（未落盘）`)
		process.exitCode = 1
		return
	}
	// 备份目录在动第一个文件之前就印：中途 ENOSPC/EACCES 时，人既要知道东西在哪，
	// 也要知道已经动了多少——这两样缺一样就只能靠猜
	const backupDir = backup(root, changes)
	console.log(`备份目录（改写前已复制原文件）：${backupDir}`)
	let done = 0
	try {
		done = await applyChanges(changes)
	} catch (error) {
		console.log(`\n已改 ${done} 条后中断：${describeError(error)}。备份在 ${backupDir}；重跑本脚本即可幂等收敛（已合规的条目不再动）`)
		process.exitCode = 1
		return
	}
	console.log(`\n已改 ${done} 条、跳过 ${skipped.length} 条`)
	console.log(`备份目录：${backupDir}`)
	if (skipped.length > 0) process.exitCode = 1
}

// 顶层即主流程：这是一次性迁移工具，不是可被 import 的模块（单测也起子进程跑它，
// 故不存在「import 时该不该跑」的分支）
await main()
