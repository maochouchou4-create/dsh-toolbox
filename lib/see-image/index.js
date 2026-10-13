/**
 * see_image 工具——把图交给视觉模型转述成文字。模块接口＝register＋configShape；
 * execute 是五段接线（定位目标 → 读字节验图型 → 存附件 → 调模型 → 整形输出），
 * 其中能直测的那几步在 ./vision.js（内缝，自测直达）。
 *
 * 通道选型（探针后定型）：走宿主 llm 服务（ctx.llm.stream），不走插件自带
 * fetch＋key 直连。理由：凭据/路由/重试全归宿主（插件零密钥零网络代码）；
 * 图片经 attachments 存成 durable ref 后由适配层按模型目录的 inputLimits
 * 自动缩放/压缩；不传 reasoningEffort 时 zai 适配器自动发
 * thinking:{type:'disabled'}——探针实证 glm-5.3-flash 默认思考会吃光
 * 输出预算（reasoning_tokens 509/512、正文为空），关掉后读图比 4v-flash
 * 更细，且这是适配器原生行为而非本插件特判。
 *
 * 空输出防护（内缝 transcribe 实现）：流以 stop 收尾但无任何非空文本时抛错——「思考吃输出」在
 * 上游配置漂移时会以空正文形态复发，宁可失败也不给调用方一份空转述。
 */
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { resolveAttachmentRoot, resolveTarget, sniffImageMediaType, transcribe } from './vision.js'

export const DEFAULT_PROVIDER = 'zai-coding-cn'
export const DEFAULT_MODEL = 'glm-5.3-flash'
const MAX_TOKENS = 2048
const TIMEOUT_MS = 180_000

/** 视觉转述的系统指令：转写优先（逐字、原语言），描述按图类型给结构。 */
const VISION_SYSTEM = `You are a precise vision assistant. An engineer who cannot see the image relies entirely on your text.
Rules:
1. Transcribe ALL visible text verbatim first, region by region (keep the original language; never translate or "fix" it).
2. Then describe the image by its kind: charts/diagrams (chart type, axes, series, exact values), UI screenshots (layout, controls, states, focused/disabled items), documents (structure, tables), photos (subjects, actions, scene).
3. Always include concrete numbers, labels, colors, and positions; quote UI strings exactly.
4. Never speculate beyond the pixels; mark anything unclear as unclear.
Be concise but complete.`

/**
 * 宿主 DSH home：附件存区求根的事实源是宿主 resolveDshHome 算出的那份，profileContext.home
 * 就是它（宿主启动器在 boot 时填好）。本仓只读不推——自己按 $DSH_HOME／~ 推一遍的旧写法漏过
 * ~ 展开，那种写法算出的路径与宿主实际写入分家，症状是「宿主明明存了图，这里却查不到桶」。
 * profileContext 只在 dsh 启动的 profile 里在场：拿不到时显式报错，不静默退回 ~/.dsh。
 */
function hostDshHome(ctx) {
	const home = ctx.get('profileContext')?.home
	if (typeof home !== 'string' || home.trim() === '') {
		throw new Error('宿主未提供 profileContext.home（拿不到 DSH home）——无法定位附件存区')
	}
	return home
}

function makeSeeImageTool(ctx, { provider, model }) {
	// 取用函数而非求好的字符串：只有占位符入口要存区根，DSH home 拿不到时磁盘路径入口照常可用
	const objectsRootOf = () => resolveAttachmentRoot(hostDshHome(ctx))
	return defineTool({
		name: 'see_image',
		// 描述插值实际路由（F4）：路由可被 config 覆写，硬编码通道名会让调用方
		// 模型看到与真实通道不符的描述；定价性措辞（免费/收费）不入描述。
		description: `把一张图片交给视觉模型（${provider}/${model}，经宿主通道）转述成文字。兜的是「图在磁盘上但你看不了像素」的场景；若你已直接看到图内容就不要用本工具。返回＝先逐字转写全部可见文字（保留原语言、按区域），再按图类型给结构化描述；带 question 时优先回答问题。图片来源二选一：path＝png/jpeg/webp/gif 文件路径（绝对，或相对会话工作目录）；attachment＝会话文本里 \`[image omitted … attachment sha256:xxxxxxxx]\` 占位符的那串十六进制——已进对话历史的图片在纯文本模型下的回放形态（往纯文本模型的新消息里贴图会被宿主拒收，图到不了会话）。`,
		parameters: {
			path: { type: 'string', description: '图片文件路径（与 attachment 二选一；绝对，或相对会话工作目录）' },
			attachment: { type: 'string', description: '宿主附件十六进制标识（与 path 二选一）：占位符 sha256: 后的前缀（≥8 位）或完整 64 位' },
			question: { type: 'string', description: '针对这张图的具体问题（可选）；给出后先转写文字再回答' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					path: { type: 'string', required: true },
					attachment: { type: 'string', description: '来源为 attachment 入口时回显完整 sha256 标识，便于后续直引' },
					provider: { type: 'string', required: true },
					model: { type: 'string', required: true },
					description: { type: 'string', required: true },
				},
			},
			render: (args, value) => [{ type: 'text', text: value.description }],
		},
		timeoutMs: TIMEOUT_MS,
		async execute(args, exec) {
			// 六件事各自成段：定位目标（两条入口同一形状）→ 读字节验图型 → 存附件 →
			// 调视觉模型 → 整形输出。内缝那几步在 ./vision.js，宿主接线留在本层
			const { target, sourceName, attachmentId } = await resolveTarget(ctx, args, exec, objectsRootOf)
			// 宿主通道读字节（F2）：readBytes 内含 stat＋常规文件校验＋超帽拒绝
			// （FS_TOO_LARGE）＋signal 取消；帽取附件服务的图上限，与 read 工具同源
			const cap = Math.min(ctx.attachments.imageLimits.maxImageBytes, ctx.attachments.imageLimits.maxMessageImageBytes)
			const bytes = await ctx.fs.readBytes(target, exec.signal, cap)
			const mediaType = sniffImageMediaType(bytes)
			if (mediaType === null) {
				throw new Error(`不支持的图片格式 ${target.displayPath}（魔数嗅探未命中 png/jpeg/webp/gif）`)
			}
			// 附件仓是 durable 内容寻址存储（同图去重、宿主无 GC/释放 API）——
			// 每次调用永久留存一份图字节，存储增长边界见 README（F5 口径）
			const [ref] = await ctx.attachments.saveImages([{ data: bytes, mediaType, name: sourceName }])
			const instruction = args.question
				? `针对这张图回答问题：${args.question}\n回答前先按系统指令完整转写图中可见文字，再给答案；引用的数字与文字必须与像素一致。`
				: '请按系统指令转写并描述这张图。'
			const description = await transcribe({
				assembler: new BlockAssembler(),
				stream: ctx.llm.stream({
					provider,
					model,
					system: VISION_SYSTEM,
					messages: [
						{
							role: 'user',
							content: [
								{ type: 'text', text: instruction },
								{ type: 'image', attachment: ref },
							],
						},
					],
					maxTokens: MAX_TOKENS,
					sessionId: exec.agent?.session?.id,
					signal: exec.signal,
				}),
			})
			return {
				path: target.displayPath,
				...(attachmentId !== undefined ? { attachment: `sha256:${attachmentId}` } : {}),
				provider,
				model,
				description,
			}
		},
	})
}

export function registerSeeImage(ctx, { visionProvider: configuredProvider, visionModel: configuredModel } = {}) {
	const provider = typeof configuredProvider === 'string' && configuredProvider.trim().length > 0 ? configuredProvider : DEFAULT_PROVIDER
	const model = typeof configuredModel === 'string' && configuredModel.trim().length > 0 ? configuredModel : DEFAULT_MODEL
	ctx.tools.register(makeSeeImageTool(ctx, { provider, model }))
}

/** 本模块的 Config 键（胶水层合成 package Config；默认值单源于常量）。 */
export const configShape = {
	visionProvider: z.string().default(DEFAULT_PROVIDER),
	visionModel: z.string().default(DEFAULT_MODEL),
}
