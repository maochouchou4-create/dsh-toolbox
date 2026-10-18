/**
 * dsh-memory 的 delete 动作：删条目正文＋报告残余 wikilink 引用。
 *
 * 职责边界：本动作与体检同留 node:fs——宿主 FileSystem 契约没有删除能力，端口化到这里
 * 无处可去（完整取舍见 deleteEntry 的注释）。写侧 upsert/edit 的 I/O 只经 fs 端口那条
 * 硬边界不含本文件，且本文件按设计**必须**直连：test/imports.test.js 按文件判定，
 * write.js 零直连、delete.js 必须直连——刻意取舍不登记在导入面上就等于改成了漏改。
 * 共用件（段路由、段目录清点、wikilink 口径、条目命名判据、文件类型守卫与错误词表）
 * 分别来自 core.js／segments.js／patterns.js／frontmatter.js／fs-guard.js，本层不导出
 * 任何 fs 函数，写侧动作无法借它摸到 node:fs。
 *
 * 寻址与 edit 同一份：全形式或裸名，裸名的落段由 core 的唯一命中判定给（歧义报错）；
 * 两处各写一遍时的症状是「edit 说歧义、delete 悄悄删了其中一条」。
 */
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { assertRegularFile, typeOfStats } from '../fs-guard.js'
import { describeError, resolveRoot } from '../memory-root.js'
import { parseFilePath, resolveBareScope, resolveScopeDir, scopeCandidates, scopeProbePaths } from './core.js'
import { isEntryName, stemOf } from './frontmatter.js'
import { listSegmentDirs } from './segments.js'
import { assertEntryFile, forEachWikilinkMatch } from './patterns.js'

/**
 * 引用清扫：全库在场条目（共享段＋各机器段）里逐处找出指向 stem 的 wikilink。
 *
 * 降级粒度＝单个文件（段目录清点与列目录各按自己的粒度降级），与体检的逐文件降级同一
 * 口径：整轮共用一个 try 时，一个病态文件（名为 x.md 的目录、权限错的条目）会带停余下
 * 全部目录并交出半份 references——而「这份报告少了几处」比「这几处没扫到」更难发现，
 * 调用方无从知道该按报告改完之后还该再查一遍。
 */
function scanReferences(memoryRoot, stem) {
	const references = []
	const failures = []
	let segmentDirs
	try {
		segmentDirs = listSegmentDirs(resolveRoot(memoryRoot))
	} catch (error) {
		return { references, scanError: `引用扫描失败（段目录清点）：${describeError(error)}` }
	}
	for (const { dir } of segmentDirs) {
		let names
		try {
			names = readdirSync(dir)
		} catch (error) {
			failures.push(`${dir}：${describeError(error)}`)
			continue
		}
		for (const name of names) {
			if (!isEntryName(name)) continue
			const path = join(dir, name)
			try {
				// 与 lint 同口径：提取到的串 trim 后全等比较（前缀子串会把 [[toolkit]] 误报成对 tool 的引用）。
				// 逐文件降级，故 try 仍圈住「读＋扫」整段，与遍历本身无关
				forEachWikilinkMatch(readFileSync(path, 'utf8'), (matched, line) => {
					if (matched.trim() === stem) references.push(`${path}:${line}`)
				})
			} catch (error) {
				failures.push(`${path}：${describeError(error)}`)
			}
		}
	}
	return { references, scanError: failures.length === 0 ? '' : `引用扫描失败：${failures.join('；')}` }
}

/**
 * 删条目：删正文即退场——索引行是派生的，目录里没有文件就没有这一行，别的条目正文里
 * 指向它的 [[wikilink]] 逐处报告（措辞改写需要判断力，留给调用方按报告修——
 * 机械替换会破坏行文）。
 *
 * 本路径的 I/O 有意不过宿主 fs 通道：宿主 FileSystem 契约里没有删除能力（成员全量
 * 见 dsh-fs 的抽象类定义），端口化到这里无处可去，故与 lint 族同留 node:fs。但它
 * 仍然接端口、只问一句「能不能写」——问的是策略判断，一个字的 I/O 都不经端口；
 * 四个 action 同一口径，不能因为走的是 node:fs 就让只读会话照样删掉条目。越界
 * 围栏守的是端口写侧（其可查前提记在 fs-port.js 的模块头），本路径的 I/O 是
 * node:fs、不经那道围栏——门只有 assertWritable 的只读前检这一道。signal 同理
 * 不参与：实现全同步，一次调用内无让出点。
 */
export function deleteEntry({ port, memoryRoot, machine, file }) {
	// 不传裸名缺省段（第三参）：那是 write 的语义，delete 的裸名要按候选段唯一命中
	const parsed = parseFilePath(file)
	assertEntryFile(parsed.file)
	port.assertWritable()
	const root = resolveRoot(memoryRoot)
	let targetScope = parsed.scope
	if (targetScope === undefined) {
		// 裸名：在候选段里探一遍（同步 stat），落段由 core 那份唯一命中判定给。
		// 待探路径的拼装也问 core：段序与路径拼法在写侧与删侧各写一遍时会分家
		const scopes = scopeCandidates(machine)
		const probes = scopeProbePaths(root, scopes, parsed.file)
		const present = scopes.filter((_scope, index) => statSync(probes[index], { throwIfNoEntry: false }) !== undefined)
		targetScope = resolveBareScope({ file: parsed.file, scopes, present })
	}
	const dir = resolveScopeDir(root, targetScope)
	const entry = join(dir, parsed.file)
	// 一次 stat 给出「在不在」与「是不是文件」，顺序照宿主写路径：先判类型，再动手删。
	// 判定与 code 走 fs-guard.js 那一份，故本路径（直连 node:fs）与 write/edit 对同一个
	// 故障给出同一个 name＋code——各写一份时，同名目录占位在这里炸的是裸 node 错误
	const stats = statSync(entry, { throwIfNoEntry: false })
	if (stats === undefined) throw new Error(`条目不存在：${entry}`)
	assertRegularFile({ kind: 'present', type: typeOfStats(stats) }, entry)
	// 用 unlinkSync 而非 rmSync：Node v24.13.0 在 Windows 上，被删路径的**末段（basename）非
	// ASCII** 会让整个进程以 0xC0000409 死掉（父目录非 ASCII 无害；unlinkSync 与不带 recursive 的
	// rmdirSync 都不受影响）。这里删的正是条目文件，条目名可以是中文——真会踩的那一档
	unlinkSync(entry)
	// 主操作（删文）已成功；引用扫描是附属报告，失败降级不回滚不整崩，降级情况逐个
	// 文件名进 scanError——报告不全这件事本身要能被调用方看见
	// 结果键与工具出参对齐叫 file_path（同 write.js 的取舍：内部形参仍是 file）
	return { scope: targetScope, dir, file_path: parsed.file, ...scanReferences(memoryRoot, stemOf(parsed.file)) }
}
