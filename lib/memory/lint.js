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
 * 体检：条目 frontmatter 契约（缺/多余键）、层内 title 重名、description 日期戳与派生行超长、
 * 派生索引超预算、条目超失控保护、wikilink 死链、接线（习惯层目录、当前 cwd 桶）。
 * 索引是派生的，故没有「死索引行」「孤儿条目」两类检查：每个 .md 天生在场。
 * 返回 { ok, warnings[] }；warnings 为空＝健康。单个文件/目录读不动时逐处降级
 * 报 warning 继续——体检自身不许崩（病态输入只该损失覆盖面，不该停摆整盘）。
 */
export function lintMemory({ memoryRoot, cwd } = {}) {
	const root = resolveRoot(memoryRoot)
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
		// 层内 title 重名的判据与写侧 assertTitleFree 同源（frontmatter 的 title 字段比，
		// 不按文件名），且按层分组——写侧扫的是一个层目录，跨层同名互不影响。
		// 为什么要体检这一项：写侧那道拦截只在进程内拦得住自己，而习惯层是跨机 git 同步语料，
		// 两台机器各自干净，合流后重名照样留在盘上并进索引
		const entriesByTitle = new Map()
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
				// 只收合规条目的 title：不合规条目的 title 不可知，写侧对它的口径是单独报
				// 「同名判定不可信」而不是当作无同名——它已由上面那条 frontmatter warning 认领，
				// 在这里再占一个空 title 只会造出两边都不认的第三种反应
				const sameTitle = entriesByTitle.get(parsed.frontmatter.title)
				if (sameTitle === undefined) entriesByTitle.set(parsed.frontmatter.title, [name])
				else sameTitle.push(name)
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
		for (const [title, files] of entriesByTitle) {
			// 点名全部撞上的条目而不是只说「有重名」：收到报告的人要能直接照着改，只告知
			// 「层内有重名」等于把定位工作原样退回去
			//
			// 处置给的是 edit 不是 delete，这与写侧同一条报错里的措辞故意相反。写侧语境下
			// 「层内已有同名条目」指的就是待写这条的旧版本，删掉不丢东西；这里报的两条是
			// 各自带正文的现存条目，title 与文件名本就是两回事（frontmatter 的 title 是
			// 独立字段），照着「先 delete 再改名」做就是删掉一条真条目。edit 改 frontmatter
			// 那行 title 不动正文，写侧早已把「自己」排除在同名扫描外（edit 改的就是它自己）
			if (files.length > 1) {
				warnings.push(`${kind}：层内 title 重名「${title}」——${dir}／${files.join('、')}（两条各占一行注入索引，按 title 分不出谁是谁。改 title 不丢正文：用 edit 改其中一条的 frontmatter title 行；只有确实多余的那条才 delete）`)
			}
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
