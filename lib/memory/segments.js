/**
 * dsh-memory 读侧的两份清点：全库在场段目录、全库已知条目 stem 集。
 *
 * 段＝store 顶层（shared，两机共享）＋ `machines/<机器id>`（各机私有）。只展开 machines/
 * 这一支：store 顶层还有 data/（机器可读数据：dispatch 台账与使用日志）之类与条目无关的子目录，
 * 把任意子目录都当段展开会让那一类的 .md 混进注入索引。
 *
 * 单独成模块而不是各动作自己扫：段目录清点被 delete 的引用清扫与 lint 的体检共用（各扫一遍
 * 就是同一件事两种答案），已知 stem 集被 lint 的死链判定用。也不能让体检去 import 删除模块
 * ——「被谁用到」不构成依赖方向，下沉到两个动作都能向下指的地方，方向才是单向的。
 *
 * 直连 node:fs 是读侧的既定取舍（宿主沙箱只围栏写入，读与列目录不受策略约束）。本模块的
 * 调用方是 delete 的引用清扫、lint 的体检、离线自检（scripts/checks.mjs）与迁移脚本
 * （scripts/migrate-frontmatter.mjs）；写侧 upsert／edit 不从它取用，端口边界不受它影响。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MACHINES_DIR, SHARED_SEGMENT, machineSegmentNames, segmentKind } from './core.js'
import { RESERVED_STEMS, isEntryName, isReservedFile, stemOf } from './naming.js'

/**
 * 全库在场段目录（共享段 + 各机器段）；delete 的引用清扫、lint 的体检与离线自检共用。
 *
 * kind 是段标签（core.js 的 segmentKind 单源）：标签自成一份就会有一份教出参数面已不收的值。
 * 机器段按段名排序而不是信 readdir 的返回序：注入尾行、体检报告与离线自检的表格都要可比，
 * 同一份语料两次跑必须给出同一个段序（排序在 core 的 machineSegmentNames 里，与 scanSegment 内部同序）。
 *
 * 列目录不吞错（与 assemble.js 的指纹那一支不同）：清点失败＝段目录清单都没有，逐段体检无从
 * 谈起，由调用方（lint／delete）认领并中止，不静默降级成「这一段没有条目」。
 */
export function listSegmentDirs(root) {
	const dirs = []
	if (existsSync(root.store)) dirs.push({ kind: SHARED_SEGMENT, dir: root.store })
	const machinesDir = join(root.store, MACHINES_DIR)
	if (existsSync(machinesDir)) {
		const names = machineSegmentNames(readdirSync(machinesDir, { withFileTypes: true }))
		for (const name of names) dirs.push({ kind: segmentKind(name), dir: join(machinesDir, name) })
	}
	return dirs
}

/** 全库已知条目 stem 集（lint 判 wikilink 死链用；含保留 stem，不误报）。 */
export function knownStems(segmentDirs) {
	const stems = new Set(RESERVED_STEMS)
	for (const { dir } of segmentDirs) {
		for (const name of readdirSync(dir)) {
			// 两个判据都问 naming.js，不在本模块自拼 `.md` 后缀：条目名问 isEntryName（小写
			// kebab 且非保留名），而保留名虽不是条目、且各种大小写形态都合法（MEMORY.MD），也
			// 是合法的 wikilink 目标，漏掉就会把它们误报成死链。保留名那一支经 isReservedFile
			// 进 stem 集，stemOf 只删后缀、不改大小写，故 MEMORY.MD 给出的是 MEMORY 这个 stem。
			// 既非 kebab 又非保留名的（Foo.md）不进 stem 集：它按同一份判据也不是条目——条目不
			// 进索引就无处可读，指向它的 wikilink 在记忆系统里就是死链，报出来才能促成改名
			if (isEntryName(name) || isReservedFile(name)) stems.add(stemOf(name))
		}
	}
	return stems
}
