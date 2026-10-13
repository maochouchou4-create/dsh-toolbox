/**
 * dsh-memory 的 delete 动作：删条目正文＋报告残余 wikilink 引用。
 *
 * 职责边界：本动作与体检同留 node:fs——宿主 FileSystem 契约没有删除能力，端口化到这里
 * 无处可去（完整取舍见 deleteEntry 的注释）。写侧 upsert/edit 的 I/O 只经 fs 端口那条
 * 硬边界不含本文件，且本文件按设计**必须**直连：test/imports.test.js 按文件判定，
 * write.js 零直连、delete.js 必须直连——刻意取舍不登记在导入面上就等于改成了漏改。
 * 共用件（层路由、层目录清点、wikilink 口径、条目命名判据）分别来自 core.js／layers.js／
 * patterns.js／frontmatter.js，本层不导出任何 fs 函数，写侧动作无法借它摸到 node:fs。
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_MEMORY_ROOT, describeError, resolveLayerDir, resolveRoot } from './core.js'
import { isEntryName, stemOf } from './frontmatter.js'
import { listLayerDirs } from './layers.js'
import { WIKILINK_RE, assertEntryFile } from './patterns.js'

/**
 * 引用清扫：两层全部在场条目里逐处找出指向 stem 的 wikilink。
 *
 * 降级粒度＝单个文件（层目录清点与列目录各按自己的粒度降级），与体检的逐文件降级同一
 * 口径：整轮共用一个 try 时，一个病态文件（名为 x.md 的目录、权限错的条目）会带停余下
 * 全部目录并交出半份 references——而「这份报告少了几处」比「这几处没扫到」更难发现，
 * 调用方无从知道该按报告改完之后还该再查一遍。
 */
function scanReferences(memoryRoot, stem) {
	const references = []
	const failures = []
	let layerDirs
	try {
		layerDirs = listLayerDirs(resolveRoot(memoryRoot ?? DEFAULT_MEMORY_ROOT))
	} catch (error) {
		return { references, scanError: `引用扫描失败（层目录清点）：${describeError(error)}` }
	}
	for (const { dir } of layerDirs) {
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
				const lines = readFileSync(path, 'utf8').split('\n')
				for (let i = 0; i < lines.length; i += 1) {
					// 与 lint 同口径：WIKILINK_RE 提取 stem 后全等比较（前缀子串会把 [[toolkit]] 误报成对 tool 的引用）
					for (const match of lines[i].matchAll(WIKILINK_RE)) {
						if (match[1].trim() === stem) references.push(`${path}:${i + 1}`)
					}
				}
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
 * 围栏对本路径不生效，其可查前提（本机全部会话为 danger-full-access）记在
 * fs-port.js 的模块头。signal 同理不参与：实现全同步，一次调用内无让出点。
 */
export function deleteEntry({ port, memoryRoot, cwd, layer, file }) {
	assertEntryFile(file)
	port.assertWritable()
	const dir = resolveLayerDir({ memoryRoot, layer, cwd })
	const entry = join(dir, file)
	if (!existsSync(entry)) throw new Error(`条目不存在：${entry}`)
	rmSync(entry)
	// 主操作（删文）已成功；引用扫描是附属报告，失败降级不回滚不整崩，降级情况逐个
	// 文件名进 scanError——报告不全这件事本身要能被调用方看见
	return { layer, dir, file, ...scanReferences(memoryRoot, stemOf(file)) }
}
