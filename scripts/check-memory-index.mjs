#!/usr/bin/env node
/**
 * 记忆注入块离线自检。必须带 <记忆根> <工作区 cwd> 两参：不带参数时工作层按
 * process.cwd() 算出桶，该层在注入块装配里被省略，整块定档只量到习惯层——空跑。
 * 空跑不再是假绿而是判红：桶不存在且两参都没给时，本命令以 1 退出并说明该带什么。
 *
 * 为什么有它：注入块每轮上下文都要装一份，涨起来是看不见的成本；插件改动又只能在
 * 下次启动后才在运行期观察。本脚本用注入侧同一份判定（core.js 的扫描与预算常量）
 * 把「这块会长成什么样、有没有超预算」变成一条命令的当场结论。
 *
 * 扫全部层而非只扫当前工作区：工作层桶名由 cwd 归一而来，脚本从仓库目录跑时自然
 * 落到一个不存在的桶上，于是只检一层就等于放过了真正在注入的那层。
 *
 * 用法：node scripts/check-memory-index.mjs [记忆根] [工作区 cwd]
 * 记忆根默认 ~/.dsh/memory，工作区 cwd 默认 process.cwd()。
 * 退出码：0＝全部达标；1＝有超预算或 frontmatter 不合规的条目（逐条列出）。
 */
import process from 'node:process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildIndexBlock, composeMemory } from '../lib/memory/assemble.js'
import {
	BLOCK_CHAR_BUDGET,
	DEFAULT_MEMORY_ROOT,
	INDEX_CHAR_BUDGET,
	INDEX_LINE_BUDGET,
	INDEX_LINE_CHAR_BUDGET,
	resolveRoot,
	workspaceSlug,
} from '../lib/memory/core.js'
import { isEntryName, isReservedFile } from '../lib/memory/frontmatter.js'
import { listLayerDirs } from '../lib/memory/layers.js'

// 用 `||` 不用 `??`：显式传空串（想只跑默认值）不该被当成「记忆根就是当前目录」，
// 那会让脚本在一片空地上报「全部达标」
const memoryRoot = process.argv[2] || process.env.DSH_MEMORY_ROOT || DEFAULT_MEMORY_ROOT
const cwd = process.argv[3] || process.cwd()
// 两参是否都由调用方给了：没给就走默认值，而默认值在工作层这一维几乎必然算错桶
const argsGiven = process.argv.length > 2
const root = resolveRoot(memoryRoot)

const violations = []
// 层清点问注入侧同一份（core.js 里 buildIndexBlock 的注释就是这份理由）：脚本自己再扫一遍
// 目录就是用另一套尺子量这把尺子，判定与组装不一致时报告仍会印「全部达标」
const layers = listLayerDirs(root)

console.log(`习惯层：${root.profile}`)
console.log(`工作区 cwd（决定装配哪一层）：${cwd}\n`)
console.log('层\t条目文件\t派生行\t索引字符\t最长行\t超单行预算')
for (const { kind, dir } of layers) {
	const text = buildIndexBlock(dir, (issue, path, detail) => {
		violations.push(`${kind}：${path} —— ${detail}`)
	})
	const lines = text === null ? [] : text.split('\n')
	const over = lines.filter((line) => line.length > INDEX_LINE_CHAR_BUDGET)
	// 条目文件数与派生行数分列：两者的差就是被拒条目数，合在一列里这个差值看不见
	const entries = readdirSync(dir).filter(isEntryName).length
	console.log(
		`${kind}\t${entries}\t${lines.length}\t${text?.length ?? 0}\t${lines.length === 0 ? 0 : Math.max(...lines.map((l) => l.length))}\t${over.length}`,
	)
	// 退役的索引文件：两机同步下另一台可能还留着，人打开改它不会生效也不会有人提示
	for (const name of readdirSync(dir)) {
		if (isReservedFile(name) && name.toLowerCase() === 'memory.md') {
			violations.push(`${kind}：${join(dir, name)} 是已退役的索引文件（索引由条目 frontmatter 现场派生，不再读它）——删掉它`)
		}
	}
	for (const line of over) violations.push(`${kind}：派生索引行 ${line.length} 字符超 ${INDEX_LINE_CHAR_BUDGET} —— ${line}`)
	if (lines.length > INDEX_LINE_BUDGET) violations.push(`${kind}：索引 ${lines.length} 行超 ${INDEX_LINE_BUDGET} 行预算（注入会被截断）`)
	if ((text?.length ?? 0) > INDEX_CHAR_BUDGET) violations.push(`${kind}：索引 ${text.length} 字符超 ${INDEX_CHAR_BUDGET} 字符预算（注入会被截断）`)
}

const block = composeMemory({ memoryRoot, cwd })
const rulesChars = (() => {
	try {
		return readFileSync(join(root.profile, 'WRITING.md'), 'utf8').length
	} catch {
		return 0
	}
})()
// cwd 的桶不在场时这一栏只数到习惯层：说清是「本次装配本就如此」还是「桶名算错了」，
// 否则报告里的字符数会被当成全量而误判
const bucket = workspaceSlug(cwd)
console.log(`\n注入块（cwd=${cwd}，桶 ${bucket}）：${block.length} 字符／${block.split('\n').length} 行（含规则块与索引）`)
if (bucket.length > 0 && !existsSync(join(root.workspaces, bucket))) {
	console.log(`提示：该工作区无桶，本次装配只有习惯层${argsGiven ? '（新工作区属常态）' : ''}`)
	// 两参都没给时这不是「新工作区」，是忘了带参数：进程 cwd 多半是仓库目录，算出个不存在的桶。
	// 照印「全部达标」＝空跑假绿，所以在这里判红而不是只提醒。
	if (!argsGiven) violations.push(`未给工作区 cwd 参数：按进程 cwd=${cwd} 算出桶 ${bucket}，而它不存在——整块定档只量到习惯层，本次是空跑。要真检某个工作区请带上 <记忆根> <工作区 cwd>`)
}
console.log(`预算：层内索引 ${INDEX_LINE_BUDGET} 行／${INDEX_CHAR_BUDGET} 字符（逐层），派生行 ${INDEX_LINE_CHAR_BUDGET} 字符，整块 ${BLOCK_CHAR_BUDGET} 字符`)
console.log(`其中写侧纪律 WRITING.md 占 ${rulesChars} 字符\n`)
if (block.length > BLOCK_CHAR_BUDGET) violations.push(`注入块 ${block.length} 字符超 ${BLOCK_CHAR_BUDGET} 整块定档（写侧纪律 ${rulesChars} ＋ 两层索引）`)
if (block.length === 0) console.log('（无内容：记忆根未接线，或该工作区尚无桶）')

if (violations.length > 0) {
	console.log(`${violations.length} 项待收敛：`)
	for (const violation of violations) console.log(`  · ${violation}`)
	process.exitCode = 1
} else {
	console.log(`全部达标：各层索引与整块均在预算内，条目 frontmatter 全部合规，无退役索引文件残留。`)
}
