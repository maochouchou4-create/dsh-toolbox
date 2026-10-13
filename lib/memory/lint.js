/**
 * dsh-memory 的 lint 动作：全量体检（frontmatter 契约／死链／预算／失控保护／接线）。
 *
 * 职责边界：本动作与删除同留 node:fs——宿主沙箱只围栏写入，读与列目录本就不受策略约束，
 * 走端口只是白付 async 成本。体检是写侧的离线镜像，镜像不得比本体弱：同一份判定
 * （frontmatter 契约、各项预算、wikilink 口径）来自 frontmatter.js／core.js／patterns.js，
 * 各调用方只补自己的定位前缀，不另抄一份判据。共用件从 layers.js／patterns.js 取而不是
 * 从 delete.js 借——「被谁用到」不构成依赖方向。写侧 upsert/edit 的 I/O 只经 fs 端口那条
 * 硬边界不含本文件，本文件按设计必须直连（test/imports.test.js 按文件判定）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
	DEFAULT_MEMORY_ROOT,
	INDEX_CHAR_BUDGET,
	INDEX_LINE_BUDGET,
	RUNAWAY_CEILING,
	describeError,
	resolveRoot,
	workspaceSlug,
} from './core.js'
import { RESERVED_STEMS, deriveIndexLine, isEntryName, parseFrontmatter } from './frontmatter.js'
import { knownStems, listLayerDirs } from './layers.js'
import { forEachWikilinkMatch, styleWarnings } from './patterns.js'

/**
 * 体检：条目 frontmatter 契约（缺/多余键）、description 日期戳与派生行超长、
 * 派生索引超预算、条目超失控保护、wikilink 死链、接线（习惯层目录、当前 cwd 桶）。
 * 索引是派生的，故没有「死索引行」「孤儿条目」两类检查：每个 .md 天生在场。
 * 返回 { ok, warnings[] }；warnings 为空＝健康。单个文件/目录读不动时逐处降级
 * 报 warning 继续——体检自身不许崩（病态输入只该损失覆盖面，不该停摆整盘）。
 */
export function lintMemory({ memoryRoot, cwd } = {}) {
	const root = resolveRoot(memoryRoot ?? DEFAULT_MEMORY_ROOT)
	const warnings = []
	if (!existsSync(root.profile)) warnings.push(`习惯层接线缺失：${root.profile} 不存在（接线见 README）`)
	let layerDirs
	try {
		layerDirs = listLayerDirs(root)
	} catch (error) {
		warnings.push(`层清点失败（体检中止）：${describeError(error)}`)
		return { ok: false, warnings }
	}
	let stems
	try {
		stems = knownStems(layerDirs)
	} catch (error) {
		stems = new Set(RESERVED_STEMS)
		warnings.push(`条目清点失败，死链判定降级：${describeError(error)}`)
	}
	for (const { kind, dir } of layerDirs) {
		let names
		try {
			// 保留文件不是条目：既不派生索引行，也不受 frontmatter 契约与失控保护约束
			names = readdirSync(dir).filter(isEntryName)
		} catch (error) {
			warnings.push(`${kind}：目录读取失败——${dir}（${describeError(error)}）`)
			continue
		}
		const indexLines = []
		for (const name of names) {
			let text
			try {
				text = readFileSync(join(dir, name), 'utf8')
			} catch (error) {
				warnings.push(`${kind}：条目读取失败——${name}（${describeError(error)}）`)
				continue
			}
			// CRLF 归一收在 parseFrontmatter 内的单点；这里量的是解析结果，不是原始字节
			const parsed = parseFrontmatter(text)
			if (!parsed.ok) {
				warnings.push(`${kind}：条目 frontmatter 不合规（该条目不进索引）——${name}（${parsed.error}）`)
			} else {
				const indexLine = deriveIndexLine({ ...parsed.frontmatter, file: name })
				indexLines.push(indexLine)
				// 文案问写侧那一份（patterns.styleWarnings），本层只补自己的定位：层作前缀、
				// 条目名作后缀，与同函数其余 warning 的定位形态一致
				for (const style of styleWarnings({ description: parsed.frontmatter.description, indexLine })) {
					warnings.push(`${kind}：${style}——${name}`)
				}
			}
			if (text.length > RUNAWAY_CEILING) warnings.push(`${kind}：条目超失控保护（写侧拦新增，存量请收敛）——${name}`)
			forEachWikilinkMatch(text, (matched) => {
				const stem = matched.trim()
				if (stem.length > 0 && !stems.has(stem)) warnings.push(`${kind}：死 wikilink [[${stem}]]——${name}`)
			})
		}
		const indexText = indexLines.join('\n')
		if (indexLines.length > INDEX_LINE_BUDGET || indexText.length > INDEX_CHAR_BUDGET) {
			warnings.push(`${kind}：派生索引超预算（${indexLines.length} 行/${indexText.length} 字符，注入会被截断）`)
		}
	}
	if (typeof cwd === 'string' && cwd.length > 0) {
		const slug = workspaceSlug(cwd)
		if (slug.length > 0 && !existsSync(join(root.workspaces, slug))) {
			warnings.push(`当前工作区尚无桶（${slug}）——新工作区常态；首次 write 自动建桶`)
		}
	}
	return { ok: warnings.length === 0, warnings }
}
