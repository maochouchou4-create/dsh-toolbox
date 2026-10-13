/**
 * memory 工具——两层记忆（习惯层跨机同步＋工作层按工作区分桶）的读注入＋写侧通道。
 * 模块接口＝register(ctx, config)＋configShape（见文件尾）；其余全是内缝。
 *
 * 注入与层路由的工作区口径：一律取 workingDirectory 服务的活目录——header.cwd
 * 只是会话启动快照（projection 的 init 默认值），working_directory(cd) 后不回写；
 * 注入回调用 get(session)（纯读、无 IO，服务自己的 assemble 钩子已先 ensure 过），
 * 工具执行用 ensure(agent, signal)（与 dsh-tool-fs 同款，含目录消失恢复）。
 * 不监听 agent/created 的原因：全局注册天然覆盖已存活会话（含插件热重载后的
 * 旧 agent，无需补挂循环），且注册唯一、归插件生命周期所有——不存在 per-agent
 * 注册随旧闭包滞留旧 memoryRoot 的所有权不对称。
 *
 * order=200：宿主权限类 context（110/115/120）先行——权限关键句不垫在数 KB
 * 索引之后；记忆索引是参考材料，排在行为红线后面。
 *
 * 本模块对记忆文件只读；写侧纪律随习惯层 WRITING.md 注入（单一事实源）。
 * text 回调内任何异常都吞掉并返回空串——注入是增强不是依赖，绝不阻断请求。
 *
 * 写侧不裸编辑：write/edit/delete/lint 经 frontmatter 契约（恰好 title＋description
 * 两键）、文件名与失控保护校验；索引行是条目 frontmatter 的派生视图，不落盘、不手写，
 * 所以工具 schema 里没有 indexLine——schema 与实现不一致＝子代理按 schema 传参直接报错。
 * edit＝对现存条目的字面替换——write 全文重发对「改几行」场景是纯传输成本且重抄不变段
 * 有漂移风险；替换结果仍走 upsert 同一条拦截链，校验不降级。读侧不碰 fs 的那半在 core.js，
 * frontmatter 契约与索引行派生在 frontmatter.js，三动作共用的文本判据在 patterns.js，
 * 层清点在 layers.js，条目读取与注入块组装在 assemble.js；
 * 写侧三个动作各一文件：upsert/edit 在 write.js（IO 全经 fs-port.js 的端口，其本地导入
 * 闭包零 node:fs 导入）、delete 在 delete.js、lint 在 lint.js，后两者直连 node:fs 是刻意
 * 取舍（理由在各自文件头）。纯函数文件一律零宿主依赖，本文件只做 cordis 接线
 * （imports.test 静态解析兜导入面不断链）。
 *
 * 注入侧的 checkWiring 留 node:fs：它在同步 text 回调里做存在性探测，同步上下文内
 * 的探测就该留在同步路径，不为「写侧全走宿主通道」把同步回调改成 async（那会让
 * 注入块静默消失）。
 */
import { existsSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { resolveActiveCwd } from '../working-dir.js'
import { composeMemory } from './assemble.js'
import { DEFAULT_MEMORY_ROOT, absoluteMemoryRoot, describeError, nonEmptyOrDefault, resolveRoot } from './core.js'
import { deleteEntry } from './delete.js'
import { createHostFsPort } from './fs-port.js'
import { lintMemory } from './lint.js'
import { editEntry, upsertEntry } from './write.js'

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

function makeMemoryTool(ctx, memoryRoot) {
	return defineTool({
		name: 'memory',
		description:
			'记忆条目写侧唯一通道：write=写条目正文（frontmatter 须恰好 title＋description 两键，索引行由插件按 frontmatter 生成、不用手写），edit=对现存条目做字面替换（old/new 精确命中，校验同 write；改几行的场景用它，免全文重发），delete=删条目＋报告残余 wikilink 引用，lint=全量体检（frontmatter 契约/死链/超预算/接线）。description 是召回用的纯触发器（触发词前置、口语召回词写进来）；注入侧自动进行，无需读取类调用；写前按 WRITING.md 判层：跨机成立→habit，本机专属→workspace。',
		parameters: {
			action: { type: 'string', required: true, description: 'write | edit | delete | lint' },
			layer: { type: 'string', description: 'habit=习惯层（跨机同步） | workspace=工作层（本工作区·本机专属）。write/edit/delete 必填' },
			file: { type: 'string', description: '条目文件名，小写 kebab（如 tauritavern-toolkit.md）。write/edit/delete 必填' },
			content: {
				type: 'string',
				description:
					'条目全文（markdown）：首行 --- 起的 frontmatter 恰好两键 title（中文语义名，不必等于文件名）＋ description（单行纯触发器），多出第三键直接抛错；两键的值按字面取、不解析 YAML，引号会原样进索引行，要引号就别加；折行写成多行会被拒。其余是正文，销账即删。write 必填',
			},
			oldString: { type: 'string', description: '被替换的原文（字面精确匹配；须在正文中唯一命中，多处须 replaceAll，不命中报错不落盘）。edit 必填' },
			newString: { type: 'string', description: '替换后的文本（空串＝删除该段；编辑结果为空会拦截——整条删除走 delete）。edit 必填' },
			replaceAll: { type: 'boolean', description: '多处命中时全部替换（缺省 false＝多处即拦）。edit 可选' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					action: { type: 'string', required: true },
					layer: { type: 'string' },
					file: { type: 'string' },
					dir: { type: 'string' },
					indexLine: { type: 'string' },
					replacements: { type: 'number' },
					ok: { type: 'boolean' },
					warnings: { type: 'array', items: { type: 'string' } },
					references: { type: 'array', items: { type: 'string' } },
					scanError: { type: 'string' },
				},
			},
			render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
		},
		async execute(args, exec) {
			// 活目录经 workingDirectory 服务取（与 see_image/fs 族同款，收口在
			// lib/working-dir.js）：header.cwd 是会话启动快照，cd 后不回写——层路由跟着
			// 活目录走才与读写工具一致。
			const cwd = await resolveActiveCwd(ctx.workingDirectory, exec)
			// 端口逐次构造：会话文件策略按会话解析（同一进程内不同会话/不同
			// sandbox/mode 事件下不同），把它绑在 register 期会串味。sandboxPolicy 服务
			// 不在 inject 面（工具族不需要它必然在场），故按可选服务取，取不到就交由
			// 宿主后端用自己的默认解析。策略怎么解、signal 走哪个洞位，都在端口里。
			const port = createHostFsPort({ fs: ctx.fs, policy: ctx.get('sandboxPolicy'), agent: exec.agent })
			if (args.action === 'write') {
				const result = await upsertEntry({ port, memoryRoot, cwd, layer: args.layer, file: args.file, content: args.content, signal: exec.signal })
				return { action: 'write', ...result }
			}
			if (args.action === 'edit') {
				const result = await editEntry({
					port,
					memoryRoot,
					cwd,
					layer: args.layer,
					file: args.file,
					oldString: args.oldString,
					newString: args.newString,
					replaceAll: args.replaceAll,
					signal: exec.signal,
				})
				return { action: 'edit', ...result }
			}
			if (args.action === 'delete') {
				// delete 的 I/O 留在 node:fs（宿主 fs 契约无删除能力），端口只用来问
				// 能不能写——四个 action 同一口径，见 delete.js 的模块注释
				const result = deleteEntry({ port, memoryRoot, cwd, layer: args.layer, file: args.file })
				return { action: 'delete', ...result }
			}
			if (args.action === 'lint') {
				const result = lintMemory({ memoryRoot, cwd })
				return { action: 'lint', ...result }
			}
			throw new Error(`未知 action "${args.action}"（write | edit | delete | lint）`)
		},
	})
}

/** 工具结果的人类可读渲染（durable 展示面；模型消费的是结构化值本身）。 */
function renderToolResult(value) {
	const lines = []
	if (value.action === 'write') {
		lines.push(`已写入 ${value.file}（${value.layer} 层）：${value.dir}`)
	} else if (value.action === 'edit') {
		lines.push(`已编辑 ${value.file}（${value.layer} 层，替换 ${value.replacements} 处）：${value.dir}`)
	} else if (value.action === 'delete') {
		lines.push(`已删除 ${value.file}（${value.layer} 层）；索引行随之退场（索引是派生的，目录里没有文件就没有这一行）。`)
	} else if (value.action === 'lint') {
		lines.push(value.ok ? '体检通过：条目 frontmatter 合规、预算内、无死链。' : `体检发现 ${value.warnings.length} 项：`)
	}
	if (value.indexLine) lines.push(`注入的索引行：${value.indexLine}`)
	for (const warning of value.warnings ?? []) lines.push(`⚠ ${warning}`)
	if (value.scanError) lines.push(value.scanError)
	for (const reference of value.references ?? []) lines.push(`残余引用待清：${reference}`)
	return lines.length > 0 ? lines.join('\n') : '(memory 完成)'
}

export function registerMemory(ctx, { memoryRoot: configuredRoot } = {}) {
	// 记忆根在注册期归一成绝对路径（单一收敛点，见 core.js absoluteMemoryRoot）：
	// 相对路径在不同后端会被不同基目录解析，读写迟早分家。空串/纯空白按没给算，判据与
	// 其余三个动作同走 nonEmptyOrDefault，不在本层另拼一份
	const memoryRoot = absoluteMemoryRoot(nonEmptyOrDefault(configuredRoot, DEFAULT_MEMORY_ROOT))
	const warnOnce = makeWarnOnce(ctx)
	const root = resolveRoot(memoryRoot)

	// 接线断裂只在「由好变坏」的迁移沿报一次；恢复不报（无需噪音）。
	let lastWired = true
	const checkWiring = () => {
		const wired = existsSync(root.profile)
		if (lastWired && !wired) {
			ctx.logger.warn(`[memory] 习惯层接线缺失：${root.profile} 不存在（接线见 README）`)
		}
		lastWired = wired
	}

	ctx.tools.register(makeMemoryTool(ctx, memoryRoot))

	ctx.systemPrompt.context({
		name: CONTEXT_NAME,
		order: ORDER,
		text: (assembleContext) => {
			try {
				checkWiring()
				return composeMemory({
					memoryRoot,
					// 注入桶跟活目录，但走 get 而不是工具侧的 ensure（两者语义不同，
					// 差异与理由见 lib/working-dir.js 的 resolveActiveCwd）：本回调是
					// 同步的，改成 await 会让注入块整个静默消失；而工作目录服务自己的
					// assemble 钩子（prepend）已先 ensure 过，此处纯读即可拿到本次请求
					// 的已提交目录——与工具侧路由到同一个桶。
					cwd:
						assembleContext?.agent === undefined
							? undefined
							: ctx.workingDirectory.get(assembleContext.agent.session),
					onIssue: (kind, path, detail) => {
						if (kind === 'read-error') {
							warnOnce(`读取失败，已省略：${path}（${detail ?? '未知原因'}）`)
						} else if (kind === 'entry-frontmatter') {
							warnOnce(`条目 frontmatter 不合规，已从索引省略（write/edit 会拦它，先修）：${path}（${detail}）`)
						}
					},
				})
			} catch (error) {
				// 读侧与写侧共用 core.js 的那一份：同一个错误在两处各判一次，文案迟早分叉
				warnOnce(`注入失败：${describeError(error)}`)
				return ''
			}
		},
	})
}

/** 本模块的 Config 键（胶水层合成 package Config；默认值单源于常量）。 */
export const configShape = {
	memoryRoot: z.string().default(DEFAULT_MEMORY_ROOT),
}
