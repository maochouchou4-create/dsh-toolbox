/**
 * dispatch 工具——把「判阶段→判批型→选形态组合→套 brief 模板」固化成一次调用。
 * 模块接口＝register＋configShape；判断一件不做：批型终判、要不要加挂、findings 怎么
 * 裁决全归主会话。本层只做三件接线——现读数据（./data.js）、调纯函数核心（./core.js）、
 * 把结构化输出渲染成人话（模型读文本，程序读结构化值本身）。工具描述与参数面由数据现读拼
 * （./parameters.js 与本文件的 description()），本层不留任何名单副本。
 *
 * 调用期逐次现读：数据文件是规则面，改 JSON 即改规则、不发版不重启；需要重启的只有代码
 * 改动。注册时另有一次现读只为把描述与参数面里的清单拼出来（工具定义在注册时定型），
 * 执行时不吃那份快照。数据目录留 Config 口（dispatchDataDir）为的是测试能指向临时目录与
 * 两机各配，不是运行时的常规用法。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { isNonBlankString } from '../value.js'
import { assembleDispatch, dispatchStages } from './core.js'
import { DEFAULT_DATA_DIR, loadDispatchData } from './data.js'
import { dispatchParameters } from './parameters.js'

/**
 * 工具描述＝常驻召回面（它每个请求都在上下文里，比「要主动去读」的 skill 载体更强），
 * 所以只写已上线的面：未上线的阶段与参数一个字都不提——模型照着描述调一个还不存在的
 * 阶段只会撞上「未知 stage」，那是描述在说谎，不叫前瞻。提交/复盘与批次名等对应工具上线
 * 时再往描述里加：改描述＝改代码＝要重启宿主，顺带让「描述与已上线的面保持对齐」成为一次
 * 有人负责的动作，而不是忘了就长期说谎。
 *
 * 描述里的阶段清单现读拼（注册时 data 在手）：手抄那份停在上一次改 JSON 之前的名字，模型照
 * 它选阶段就撞「未知 stage」——而描述是模型唯一不查代码的依据。
 */
const description = (data) => `派发装配器（方案/施工/复核通用）：把「判阶段→判批型→选形态组合→套 brief 模板/方案任务书」固化成一次调用。输入阶段（${dispatchStages(data).join('/')}）＋批型＋对象＋意图＋拍板清单，返回：推荐形态组合（每形态一句理由；配对表是起点不是上限——最大化口径，主会话可增删）、每路完整 brief（已含角色句、两级 AGENTS.md 必读链、横切判据、上报格式「现象与证据」、provider/model 显式指派提醒；施工含自证行、修复批含红灯先行与根因分类）、方案任务书（阶段=方案：完整方案规范骨架＋自查清单）、节奏提示（按批型/阶段/模型路线谓词匹配：何时派/单双路/机器门/拆批上限）、brief 自检四条、不做清单、裁决固定段（收 findings 时逐条过）、机器可判警告（锚点含行号等）。修复批施工 brief 强制根因分类（错行/错结构）。不裁决、不自动派发——判断永远归主会话。`

/** briefs/combo 的行形状：形态名＋载荷。输出 schema 是逐字档那份，七个字段不多不少。 */
const briefItem = {
	type: 'object',
	additionalProperties: false,
	properties: {
		form: { type: 'string', required: true },
		text: { type: 'string', required: true },
	},
}

const comboItem = {
	type: 'object',
	additionalProperties: false,
	properties: {
		form: { type: 'string', required: true },
		reason: { type: 'string', required: true },
	},
}

/** 字符串列表字段（输出里共五处同一形状，故收成一个工厂而不是抄五遍）。 */
const stringList = { type: 'array', items: { type: 'string' } }

const OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		combo: { type: 'array', items: comboItem },
		briefs: { type: 'array', items: briefItem },
		rhythm: stringList,
		checklist: stringList,
		rejected: stringList,
		warnings: stringList,
		adjudication: stringList,
	},
}

/**
 * 渲染成人话（durable 展示面；模型消费的结构化值是另一份）。警告置顶——它是「先改
 * brief 再发」的那类信息，压到末尾等于没给；组合逐形态一行（形态名＋理由），brief 按
 * 路分块（每路一段可直接粘贴的任务书），节奏提示、自检四条、不做清单、裁决固定段各占
 * 一块，逐条照数据原样列出，不在这里二次归纳。
 */
function renderDispatchResult(value) {
	const out = []
	const section = (...lines) => {
		if (lines.length === 0) return
		if (out.length > 0) out.push('')
		out.push(...lines)
	}
	if (value.warnings.length > 0) {
		section('先看这几条警告（机器可判，别带着它们发 brief）：', ...value.warnings.map((warning) => `⚠ ${warning}`))
	}
	if (value.combo.length > 0) {
		section(
			'推荐形态组合（配对表是起点不是上限——主会话可增删）：',
			'每路派一个 subagent，禁合并——合并＝注意力稀释。',
			...value.combo.map(({ form, reason }) => `· ${form}：${reason}`),
		)
	}
	for (const brief of value.briefs) section(`【brief：${brief.form}】`, brief.text)
	if (value.rhythm.length > 0) section('节奏提示：', ...value.rhythm.map((note) => `· ${note}`))
	if (value.checklist.length > 0) section(...value.checklist)
	if (value.rejected.length > 0) section('不做清单：', ...value.rejected.map((item) => `· ${item}`))
	if (value.adjudication.length > 0) section('裁决固定段（收 findings 时逐条过）：', ...value.adjudication)
	return out.join('\n')
}

function makeDispatchTool(data, dataDir) {
	return defineTool({
		name: 'dispatch',
		description: description(data),
		parameters: dispatchParameters(data),
		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: renderDispatchResult(value) }],
		},
		async execute(args) {
			const { warnings: dataWarnings, ...fresh } = loadDispatchData({ dataDir })
			const assembled = assembleDispatch(fresh, args)
			// 数据面告警（孤儿形态）对每一次调用都成立，与本次调用的告警（行号锚点等）
			// 是两回事，在同一份输出里合流、数据面在前——它们是「先改数据再谈别的」那层。
			// 用的逐次现读那份，不是注册时拼参数描述那份快照。
			return { ...assembled, warnings: [...dataWarnings, ...assembled.warnings] }
		},
	})
}

export function registerDispatch(ctx, { dispatchDataDir: configuredDir } = {}) {
	const dataDir = isNonBlankString(configuredDir) ? configuredDir : DEFAULT_DATA_DIR
	// 注册时现读一次：描述与参数面里的清单要随配对表／lifecycle 走（见 dispatchParameters 与
	// 本文件的 description()）。数据坏了就让本工具注册失败——宁可它缺席，也不要挂一个行名
	// 清单与配对表对不上的工具在上下文里。
	const data = loadDispatchData({ dataDir })
	ctx.tools.register(makeDispatchTool(data, dataDir))
}

/**
 * 本模块的 Config 键（胶水层合成 package Config；两键一次到位）。dispatchDataDir 空串＝
 * 模块同目录的 ./data/；dispatchLedgerPath 是追加面台账的路径，由批次台账工具消费——先声明
 * 省一轮契约扩张（声明未消费的键不会误导：它不出现在任何工具描述里）。
 */
export const configShape = {
	dispatchDataDir: z.string().default(''),
	dispatchLedgerPath: z.string().default(''),
}
