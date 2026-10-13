/**
 * dsh-memory 读侧的两份清点：两层全部在场目录、全库已知条目 stem 集。
 *
 * 单独成模块而不是各动作自己扫：delete 的引用清扫与 lint 的体检都要这份清单，两处各扫一遍
 * 就是同一件事两种答案。也不能让体检去 import 删除模块——「被谁用到」不构成依赖方向，
 * 下沉到两个动作都能向下指的地方，方向才是单向的。
 *
 * 直连 node:fs 是读侧的既定取舍（宿主沙箱只围栏写入，读与列目录不受策略约束）。本模块的
 * 调用方只有 delete 与 lint；写侧 upsert／edit 不从它取用，端口边界不受它影响。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { RESERVED_STEMS, stemOf } from './frontmatter.js'

/** 两层全部在场目录（habit + 各工作桶）；delete 的引用清扫与 lint 的体检共用。 */
export function listLayerDirs(root) {
	const dirs = []
	if (existsSync(root.profile)) dirs.push({ kind: 'habit', dir: root.profile })
	if (existsSync(root.workspaces)) {
		for (const entry of readdirSync(root.workspaces, { withFileTypes: true })) {
			if (entry.isDirectory()) dirs.push({ kind: `workspace:${entry.name}`, dir: join(root.workspaces, entry.name) })
		}
	}
	return dirs
}

/** 全库已知条目 stem 集（wikilink 判死链用；含保留 stem，不误报）。 */
export function knownStems(layerDirs) {
	const stems = new Set(RESERVED_STEMS)
	for (const { dir } of layerDirs) {
		for (const name of readdirSync(dir)) {
			if (name.endsWith('.md')) stems.add(stemOf(name))
		}
	}
	return stems
}
