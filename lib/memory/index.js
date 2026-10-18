/**
 * memory 工具——单仓记忆（store 顶层两机共享＋ machines/<机器id>/ 本机私有）的读注入＋写侧通道。
 * 模块接口＝register(ctx, config)＋configShape（见文件尾）；其余全是内缝。
 *
 * 归属不再与工作目录相关：这一版没有「按会话活目录算桶」这回事，注入装的是共享段与本机段，
 * 换工作区、换目录都不影响记忆可见性。机器身份来自 config.machine（各机自己的配置文件里
 * 写死；未配置＝注入只有共享段、写入缺省落共享段）。
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
 * 写侧不裸编辑：write/edit/delete/lint 经 frontmatter 契约（恰好 title＋description
 * 两键）、文件名、段值与失控保护校验；索引行是条目 frontmatter 的派生视图，不落盘、不手写，
 * 所以工具 schema 里没有 indexLine——schema 与实现不一致＝子代理按 schema 传参直接报错。
 * 参数面与退役别名表单源在 params.js（纯模块——裸仓解析不了宿主包，而契约判据要逐条
 * 点名参数，表提出来 index.js 只引用）；execute 入口的未知键点名（折叠归一＋别名表）
 * 与条件必填点名走 ../param-guard.js。
 * edit＝对现存条目的按节编辑/按键编辑——write 全文重发对「改几行」场景是纯传输成本
 * 且重抄不变段有漂移风险；正文按 ## 节组织，节标题是条目里现成且唯一的锚点（逐字复述
 * 正文当锚点会退化成先读整篇再重发整篇）；两类编辑目标一次一个，改写结果仍走 upsert
 * 同一条拦截链，校验不降级。edit/delete 不收 scope：寻址只有 file_path（裸名或全形式），
 * 多一个 scope 参数就是第二个真相源——多传即报错，见 execute 里的显式分支。
 * 读侧不碰 fs 的那半在 core.js，条目名与保留名判定在 naming.js，frontmatter 契约与索引行
 * 派生在 frontmatter.js，三动作共用的文本判据在 patterns.js，段清点在 segments.js，条目
 * 读取与注入块组装在 assemble.js；
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
import { assertRequiredParams } from '../param-guard.js'
import { createHostFsPort } from '../fs-port.js'
import { objectShape, stringList } from '../tool-schema.js'
import { composeMemory, withWorkflowLine } from './assemble.js'
import { MACHINE_ID_RE, MEMORY_ACTIONS } from './core.js'
import { DEFAULT_MEMORY_ROOT, describeError, resolveRoot } from '../memory-root.js'
import { deleteEntry } from './delete.js'
import { lintMemory } from './lint.js'
import { WRITING_FILE } from './naming.js'
import { MEMORY_PARAMS, guardMemoryParams } from './params.js'
import { assertEntryHasSection } from './patterns.js'
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

function makeMemoryTool(ctx, memoryRoot, machine) {
	return defineTool({
		name: 'memory',
		description:
			`记忆条目写侧唯一通道：write=写条目正文（frontmatter 须恰好 title＋description 两键，正文至少一个 ## 节，索引行由插件按 frontmatter 生成、不用手写），edit=对现存条目做两类编辑（一次一个目标）：按节锚定改正文（heading 定位 ## 节标题＋body 整段替换该节正文，空串＝删节正文保留标题行；未命中报错列出全部节标题）或改 frontmatter 两键（title/description 可同传），delete=删条目＋报告残余 wikilink 引用，lint=全量体检（frontmatter 契约/段内 title 重名/节重名/死链/超预算/接线/机器身份；非 kebab 名的 .md 文件另出一条信息提醒，不判红）。description 是召回用的纯触发器（触发词前置、口语召回词写进来）；注入侧自动进行，无需读取类调用；写前按 ${WRITING_FILE} 判归属：两机都成立→scope=shared（仓顶层），本机专属→scope 缺省（machines/<本机>/）；跨机帮写帮改用 machines/<id>/<文件名> 全形式，对机 pull 后生效。`,
		parameters: MEMORY_PARAMS,
		output: {
			schema: objectShape({
				action: { type: 'string', required: true },
				scope: { type: 'string' },
				// lint 结果里的机器身份：未配置 machine 时 lint 整键缺席（缺席是跳过，给 null
				// 会被宿主判成返回值越界）。schema 是闭集，这里不声明这个键就等于拒收带它
				// 的那份体检结果——本地直调测不到这一跳，只有宿主验返回值时显形
				machine: { type: 'string' },
				file_path: { type: 'string' },
				dir: { type: 'string' },
				indexLine: { type: 'string' },
				section: { type: 'string' },
				frontmatterEdited: stringList(),
				ok: { type: 'boolean' },
				warnings: stringList(),
				// 信息性提醒：与 warnings 分档，不进 ok。闭集缺它同样会拒收整份体检结果
				notices: stringList(),
				references: stringList(),
				scanError: { type: 'string' },
			}),
			render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
		},
		async execute(args, exec) {
			// 入参守卫先于一切动作分派：宿主参数根节点是开放对象，未知键原样透传到 execute
			// 才能被点名——点名（变体写法→正名、退役名→新用法）必须发生在任何按动作取值的
			// 分支之前，否则「old_string 撞进 edit」会先撞一个更远的错（缺 heading 之类），
			// 指路就晚了
			guardMemoryParams(args)
			// 端口逐次构造：会话文件策略按会话解析（同一进程内不同会话/不同
			// sandbox/mode 事件下不同），把它绑在 register 期会串味。sandboxPolicy 服务
			// 不在 inject 面（工具族不需要它必然在场），故按可选服务取，取不到就交由
			// 宿主后端用自己的默认解析。策略怎么解、signal 走哪个洞位，都在端口里。
			const port = createHostFsPort({ fs: ctx.fs, policy: ctx.get('sandboxPolicy'), agent: exec.agent })
			// 条件必填的运行期点名：schema 表达不了「哪个动作要哪几个键」（扁平 schema 的
			// 必填是并集，把 file_path 标 required 就是逼 lint 也带它编值）；缺哪个点名哪个
			// 并附收到清单，重试从猜收敛成对答案。scope 可选，故不在这里点名
			if (args.action !== 'lint') assertRequiredParams(args, ['file_path'], { action: args.action })
			if (args.action === 'write') {
				// 正文按节组织是 edit 按节锚定的前提，写入时守。只拦新写、不进 upsert 共享链：
				// 存量无节条目等语料迁移收口，在那之前它们经 edit 改 frontmatter 的路必须畅通
				assertRequiredParams(args, ['content'], { action: args.action })
				assertEntryHasSection(args.content)
				const result = await upsertEntry({ port, memoryRoot, machine, scope: args.scope, file: args.file_path, content: args.content, signal: exec.signal })
				return { action: 'write', ...result }
			}
			if (args.action === 'edit') {
				// scope 的 declared 是全动作并集（参数守卫只能按并集点名未知键），per-action 多传
				// 拦不住，故这里显式拒：静默忽略＝把「改哪一段」交给一个不生效的参数，而改错条目
				// 没有任何症状。跨机/消歧的正当写法是 file_path 全形式
				assertScopeNotAccepted(args, 'edit')
				// 编辑目标的组合契约（heading 与 title/description 互斥等）随 editEntry 走，
				// 与写侧单测同读一份
				const result = await editEntry({
					port,
					memoryRoot,
					machine,
					file: args.file_path,
					heading: args.heading,
					body: args.body,
					title: args.title,
					description: args.description,
					signal: exec.signal,
				})
				return { action: 'edit', ...result }
			}
			if (args.action === 'delete') {
				assertScopeNotAccepted(args, 'delete')
				// delete 的 I/O 留在 node:fs（宿主 fs 契约无删除能力），端口只用来问
				// 能不能写——四个 action 同一口径，见 delete.js 的模块注释
				const result = deleteEntry({ port, memoryRoot, machine, file: args.file_path })
				return { action: 'delete', ...result }
			}
			if (args.action === 'lint') {
				const result = lintMemory({ memoryRoot, machine })
				return { action: 'lint', ...result }
			}
			// action 词表已进 schema enum（宿主在调用边界拦值错），这一支留给不经宿主校验
			// 的直调（测试替身、脚本），报错词表仍读单源
			throw new Error(`未知 action「${args.action ?? ''}」（${MEMORY_ACTIONS.join(' | ')}）`)
		},
	})
}

/** edit/delete 收到 scope 时的显式拒绝：唯一 Fail Fast 落点（守卫的 declared 是全动作并集）。 */
function assertScopeNotAccepted(args, action) {
	if (args.scope === undefined) return
	throw new Error(`${action} 不消费 scope（只认 file_path）：改本机条目直接用裸名（共享段与本机段唯一命中），跨机或同名消歧用全形式 file_path=machines/<机器id>/<文件名>`)
}

/** 工具结果的人类可读渲染（durable 展示面；模型消费的是结构化值本身）。 */
function renderToolResult(value) {
	const lines = []
	if (value.action === 'write') {
		lines.push(`已写入 ${value.file_path}（${value.scope} 段）：${value.dir}`)
	} else if (value.action === 'edit') {
		lines.push(`已编辑 ${value.file_path}（${value.scope} 段）：${value.dir}`)
		if (value.section !== undefined) lines.push(`按节替换正文：「${value.section}」`)
		if ((value.frontmatterEdited ?? []).length > 0) lines.push(`已更新 frontmatter：${value.frontmatterEdited.join('、')}`)
	} else if (value.action === 'delete') {
		lines.push(`已删除 ${value.file_path}（${value.scope} 段）；索引行随之退场（索引是派生的，目录里没有文件就没有这一行）。`)
	} else if (value.action === 'lint') {
		lines.push(value.ok ? '体检通过：条目 frontmatter 合规、段内无重名、无节重名、预算内、无死链。' : `体检发现 ${value.warnings.length} 项：`)
	}
	if (value.indexLine) lines.push(`注入的索引行：${value.indexLine}`)
	for (const warning of value.warnings ?? []) lines.push(`⚠ ${warning}`)
	// 信息性提醒用平档标记：ok 为真时它也一起印，跟着 ⚠ 排就是给「不算条目」谎报一个待修度
	for (const notice of value.notices ?? []) lines.push(`提示：${notice}`)
	if (value.scanError) lines.push(value.scanError)
	for (const reference of value.references ?? []) lines.push(`残余引用待清：${reference}`)
	return lines.length > 0 ? lines.join('\n') : '(memory 完成)'
}

export function registerMemory(ctx, { memoryRoot: configuredRoot, machine } = {}) {
	// 归一只在 resolveRoot 一处发生，这里不重算：交给各动作的根串与接线探测用的 store，
	// 都取自同一次归一的产物。重算一遍不是保险——同式重复防不住任何东西，它只
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

	ctx.tools.register(makeMemoryTool(ctx, memoryRoot, machine))

	ctx.systemPrompt.context({
		name: CONTEXT_NAME,
		order: ORDER,
		text: () => {
			try {
				checkWiring()
				// 首行是流程引导、拼在 composeMemory 之前（拼装在 assemble.js 的 withWorkflowLine，与离线
				// 自检共用同一份）：空树时 composeMemory 返回 ''，这块仍带着引导行——它不是记忆数据，
				// 不随记忆根接线与否消失
				return withWorkflowLine(composeMemory({
					memoryRoot,
					machine,
					onIssue: (kind, path, detail) => {
						if (kind === 'read-error') {
							warnOnce(`读取失败，已省略：${path}（${detail ?? '未知原因'}）`)
						} else if (kind === 'entry-frontmatter') {
							warnOnce(`条目 frontmatter 不合规，已从索引省略（write/edit 会拦它，先修）：${path}（${detail}）`)
						} else if (kind === 'segment-title-dup') {
							warnOnce(`段内 title 重名，注入索引里这几行按 title 分不出谁是谁（${detail}）`)
						} else if (kind === 'segment-title-coverage') {
							warnOnce(`本段有 ${detail}`)
						}
					},
				}))
			} catch (error) {
				// 读侧与写侧共用 core.js 的那一份：同一个错误在两处各判一次，文案迟早分叉
				warnOnce(`注入失败：${describeError(error)}`)
				// 异常路径走 fail-safe 返回 ''：引导行随之一起消失（它与记忆块同生死，是可接受的取舍——
				// 注入是增强不是依赖，报错时宁可整块缺席也不让请求失败；宿主会滤掉空块）
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
