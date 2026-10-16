/**
 * dsh-memory 读侧的两份清点：两层全部在场目录、全库已知条目 stem 集。
 *
 * 单独成模块而不是各动作自己扫：层目录清点被 delete 的引用清扫与 lint 的体检共用（各扫一遍
 * 就是同一件事两种答案），已知 stem 集被 lint 的死链判定用。也不能让体检去 import 删除模块
 * ——「被谁用到」不构成依赖方向，下沉到两个动作都能向下指的地方，方向才是单向的。
 *
 * 直连 node:fs 是读侧的既定取舍（宿主沙箱只围栏写入，读与列目录不受策略约束）。本模块的
 * 调用方只有 delete 与 lint；写侧 upsert／edit 不从它取用，端口边界不受它影响。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROFILE_LAYER } from './core.js'
import { RESERVED_STEMS, isEntryName, isReservedFile, stemOf } from './frontmatter.js'

/**
 * 两层全部在场目录（习惯层 + 各工作桶）；delete 的引用清扫与 lint 的体检共用。
 * kind 是 lint/checks 输出的层标签：习惯层标签与层值同源（core 的 PROFILE_LAYER）——
 * 标签自成一份就会有一份教出参数面已不收的层值。
 */
export function listLayerDirs(root) {
	const dirs = []
	if (existsSync(root.profile)) dirs.push({ kind: PROFILE_LAYER, dir: root.profile })
	if (existsSync(root.workspaces)) {
		for (const entry of readdirSync(root.workspaces, { withFileTypes: true })) {
			if (entry.isDirectory()) dirs.push({ kind: `workspace:${entry.name}`, dir: join(root.workspaces, entry.name) })
		}
	}
	return dirs
}

/** 全库已知条目 stem 集（lint 判 wikilink 死链用；含保留 stem，不误报）。 */
export function knownStems(layerDirs) {
	const stems = new Set(RESERVED_STEMS)
	for (const { dir } of layerDirs) {
		for (const name of readdirSync(dir)) {
			// 两个判据都问 frontmatter.js 的规范形，不在本模块自拼 `.md` 后缀：条目名问
			// isEntryName，而保留名（写侧纪律那几份）虽不是条目，也是合法的 wikilink 目标，
			// 漏掉就会把它们误报成死链。
			// 与旧的自拼判据只差一类名字：扩展名大写的保留名（如 MEMORY.MD）。isReservedFile
			// 折大小写而 endsWith('.md') 不折，故这一类现在会计入 stem 集、以前不会——
			// 即 [[MEMORY.MD]] 不再被判死链。方向上更对（那个文件就是退役的索引文件），
			// 但这是一处真实的行为差异，不是恒等改写，故写明而不假装两者相同
			if (isEntryName(name) || isReservedFile(name)) stems.add(stemOf(name))
		}
	}
	return stems
}
