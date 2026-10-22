/**
 * memory 注入侧——单仓记忆（store 顶层两机共享＋ machines/<机器id>/ 本机私有）的读注入。
 * 模块接口＝register(ctx, config)＋configShape（见文件尾）；其余全是内缝。
 *
 * 写侧工具已整体退役：写＝宿主 write、改＝宿主 edit、删＝rm，改完跑
 * `npm run check:memory -- <记忆根> <机器id>` 离线校验（scripts/checks.mjs，与注入侧
 * 同一套读法与判据）。本模块只剩注入：索引装配、接线探测，以及随共享段注入的
 * 写侧纪律（WRITING.md）。
 *
 * 归属不再与工作目录相关：这一版没有「按会话活目录算桶」这回事，注入装的是共享段与本机段，
 * 换工作区、换目录都不影响记忆可见性。机器身份来自 config.machine（各机自己的配置文件里
 * 写死；未配置＝注入只有共享段）。
 *
 * 不监听 agent/created 的原因：全局注册天然覆盖已存活会话（含插件热重载后的
 * 旧 agent，无需补挂循环），且注册唯一、归插件生命周期所有——不存在 per-agent
 * 注册随旧闭包滞留旧 memoryRoot 的所有权不对称。
 *
 * order=200：宿主权限类 context（110/115/120）先行——权限关键句不垫在数 KB
 * 索引之后；记忆索引是参考材料，排在行为红线后面。
 *
 * 本模块对记忆文件只读；写侧纪律随共享段 WRITING.md 注入（单一事实源）。
 * text 回调内任何异常都吞掉并返回空串——注入是增强不是依赖，绝不阻断请求。
 *
 * 读侧不碰 fs 的那半在 core.js，条目名与保留名判定在 naming.js，frontmatter 契约与索引行
 * 派生在 frontmatter.js，文本判据在 patterns.js，段清点在 segments.js，条目
 * 读取与注入块组装在 assemble.js。纯函数文件一律零宿主依赖，本文件只做 cordis 接线
 * （imports.test 静态解析兜导入面不断链）。
 *
 * 注入侧的 checkWiring 留 node:fs：它在同步 text 回调里做存在性探测，同步上下文内
 * 的探测就该留在同步路径，不为「写侧走宿主通道」把同步回调改成 async（那会让
 * 注入块静默消失）。
 */
import { existsSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { composeMemory } from './assemble.js'
import { MACHINE_ID_RE } from './core.js'
import { DEFAULT_MEMORY_ROOT, describeError, resolveRoot } from '../memory-root.js'

const CONTEXT_NAME = 'memory:index'
const ORDER = 200

/** 同一告警信息只报一次（状态不变不刷屏；状态迁移产生新信息自然再报）。 */
function makeWarnOnce(ctx) {
	const emitted = new Set()
	return (message) => {
		if (emitted.has(message)) return
		emitted.add(message)
		ctx.logger.warn(`[memory] ${message}`)
	}
}

export function registerMemory(ctx, { memoryRoot: configuredRoot, machine } = {}) {
	// 归一只在 resolveRoot 一处发生，这里不重算：交给接线探测用的 store，
	// 取自同一次归一的产物。重算一遍不是保险——同式重复防不住任何东西，它只
	// 会在两边将来各自改动时把「一次归一」悄悄变成两次
	const root = resolveRoot(configuredRoot)
	const memoryRoot = root.root
	const warnOnce = makeWarnOnce(ctx)

	// 接线断裂只在「由好变坏」的迁移沿报一次；恢复不报（无需噪音）。
	let lastWired = true
	const checkWiring = () => {
		const wired = existsSync(root.store)
		if (lastWired && !wired) {
			ctx.logger.warn(`[memory] 共享段接线缺失：${root.store} 不存在（接线见 README）`)
		}
		lastWired = wired
	}

	ctx.systemPrompt.context({
		name: CONTEXT_NAME,
		order: ORDER,
		text: () => {
			try {
				checkWiring()
				return composeMemory({
					memoryRoot,
					machine,
					onIssue: (kind, path, detail) => {
						if (kind === 'read-error') {
							warnOnce(`读取失败，已省略：${path}（${detail ?? '未知原因'}）`)
						} else if (kind === 'entry-frontmatter') {
							warnOnce(`条目 frontmatter 不合规，已从索引省略（check:memory 会拦它，先修）：${path}（${detail}）`)
						} else if (kind === 'segment-title-dup') {
							warnOnce(`段内 title 重名，注入索引里这几行按 title 分不出谁是谁（${detail}）`)
						} else if (kind === 'segment-title-coverage') {
							warnOnce(`本段有 ${detail}`)
						}
					},
				})
			} catch (error) {
				// 读侧与离线自检共用 core.js 的那一份：同一个错误在两处各判一次，文案迟早分叉
				warnOnce(`注入失败：${describeError(error)}`)
				return ''
			}
		},
	})
}

/** 本模块的 Config 键（胶水层合成 package Config；默认值单源于常量）。 */
export const configShape = {
	memoryRoot: z.string().default(DEFAULT_MEMORY_ROOT),
	// pattern 而不是 enum：合法机器名是开放集（每台机器一个），枚举列不全；
	// schemastery 只有 .pattern()，字段不写 .required() 即可选——未配置＝共享-only 模式
	machine: z.string().pattern(MACHINE_ID_RE),
}
