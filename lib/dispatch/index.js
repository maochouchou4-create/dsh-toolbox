/**
 * dispatch 工具——把「判阶段→判批型→选形态组合→套 brief 模板」固化成一次调用；连同批次台账
 * dispatch_batch（四个 action 同一批事件）与跨批复盘 dispatch_lessons 一并在此装配。
 * 模块接口＝register＋configShape；判断一件不做：批型终判、要不要加挂、findings 怎么
 * 裁决、复盘建议怎么采纳全归主会话。本层只做三件接线——现读数据（./data.js）、调纯函数核心
 * （./core.js、./batch.js、./lessons.js）、把结构化输出渲染成人话（模型读文本，程序读结构化值
 * 本身）。工具描述与参数面由数据现读拼（./parameters.js 与本文件的 description()），本层不
 * 留任何名单副本。
 *
 * 调用期逐次现读：数据文件是规则面，改 JSON 即改规则、不发版不重启；需要重启的只有代码
 * 改动。注册时另有一次现读只为把描述与参数面里的清单拼出来（工具定义在注册时定型），
 * 执行时不吃那份快照。数据目录留 Config 口（dispatchDataDir）为的是测试能指向临时目录与
 * 两机各配，不是运行时的常规用法。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { createHostFsPort, createReadOnlyPort } from '../fs-port.js'
import { isNonBlankString } from '../value.js'
import { renderBatchResult, resolveLedgerPath, runBatchAction, withBatchBackfill } from './batch.js'
import { assembleDispatch, dispatchStages } from './core.js'
import { DEFAULT_DATA_DIR, loadDispatchData, loadDispatchTables } from './data.js'
import { batchParameters, dispatchParameters } from './parameters.js'
import { renderLessonsResult, runLessons } from './lessons.js'

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
const description = (data) => `派发装配器（方案/施工/复核通用）：把「判阶段→判批型→选形态组合→套 brief 模板/方案任务书」固化成一次调用。输入阶段（${dispatchStages(data).join('/')}）＋批型＋对象＋意图＋拍板清单（或批次名，从台账自动拉），返回：推荐形态组合（每形态一句理由；配对表是起点不是上限——最大化口径，主会话可增删）、每路完整 brief（已含角色句、两级 AGENTS.md 必读链、横切判据、上报格式「现象与证据」、provider/model 显式指派提醒；施工含自证行、修复批含红灯先行与根因分类）、方案任务书（阶段=方案：完整方案规范骨架＋自查清单）、节奏提示（按批型/阶段/模型路线谓词匹配：何时派/单双路/机器门/拆批上限）、brief 自检四条（方案阶段那份 11 条定稿自查随任务书模板尾逐条渲染，不在本字段里重复）、不做清单、裁决固定段（收 findings 时逐条过）、机器可判警告（锚点含行号等）。修复批施工 brief 强制根因分类（错行/错结构）。不裁决、不自动派发——判断永远归主会话。`

/** 台账工具的描述（逐字档）：四个 action 的分工与「裁决完不记＝这轮复核没做完」那一句。 */
const batchDescription = '批次台账：工作流每个批次的一生记成结构化事件（agent-data 仓 ledger，两机共享）。start 登记批次（意图＋拍板清单不得重开——此后 dispatch 装配自动带出；幂等：重复 start 报错）；advance 记阶段完成（各形态 findings 数/采纳拒绝/双报重叠/修复轮数/实派组合/漏网标记）；status 查门禁（哪道门没过一句话——事件集合式推导，提交前必查）；list 列全量批次。裁决完不记＝这轮复核没做完。'

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

/**
 * 装配 dispatch 工具。ctx 是 execute 里回填台账要用的（fs 服务与沙箱策略）：拿在参数上而不是
 * 从模块级取，是因为这条线要穿过 defineTool——签名里少一个 ctx 而 execute 里引用它，是纯语法
 * 引用检查看不见、只到运行期每次调用才炸的那类接错（ctx.tools.register 的接线单测只查导入名，
 * 查不到「注册函数有没有把 ctx 传下去」）。
 */
function makeDispatchTool(ctx, data, dataDir, ledgerPath) {
	return defineTool({
		name: 'dispatch',
		description: description(data),
		parameters: dispatchParameters(data),
		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: renderDispatchResult(value) }],
		},
		async execute(args, exec) {
			const { warnings: dataWarnings, ...fresh } = loadDispatchData({ dataDir })
			// 先回填再校验：回填的那四格里两格是每阶段必填，顺序反了就成「先报缺必填」——
			// 契约在 batch.js 的 withBatchBackfill 头注里，那儿有一条单测钉住次序
			const params = await withBatchBackfill({ ctx, args, exec, data: fresh, ledgerPath })
			const assembled = assembleDispatch(fresh, params)
			// 数据面告警（孤儿形态）对每一次调用都成立，与本次调用的告警（行号锚点等）
			// 是两回事，在同一份输出里合流、数据面在前——它们是「先改数据再谈别的」那层。
			// 用的逐次现读那份，不是注册时拼参数描述那份快照。
			return { ...assembled, warnings: [...dataWarnings, ...assembled.warnings] }
		},
	})
}

/** 台账工具的输出 schema（逐字档四字段＋多批视图的 rows 摘要）；告警不进单批结构化值，
 *  多批视图的行摘要里带（每行的告警与那一行是同一件事的）。 */
const BATCH_OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		ok: { type: 'boolean', required: true },
		batch: { type: 'string' },
		next: { type: 'string' },
		// 事件行是两类异构记录（start/advance 各带自己那几格），逐字段列在这里就是第二份事件
		// 契约——事件构造处一改，这里跟着改的那天就晚了。显式 true 是宿主的硬要求：object 节点
		// 不显式声明 additionalProperties，defineTool 编译就抛「unsupported JSON schema」，
		// 整件工具缺席（不是这条事件被拒，是工具没注册上）
		events: { type: 'array', items: { type: 'object', additionalProperties: true } },
		// 多批视图（list 与不带批次的 status）带 rows 而不带 events：一批一行的状态摘要，事件全量
		// 一百分批就是几百 KB 的上下文负担。它同时是那两条视图的渲染输入——宿主深拷贝结构化值
		// 再交给 render，值自带推导输入是同步纯投影下唯一可靠的通道。
		rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
		// 空态那句话（rows 为空时才带）：渲染照值说话，不自己判「台账空了」还是「全收尾了」
		emptyText: { type: 'string' },
	},
}

/**
 * 装配台账工具。参数面在注册时现读一次（只读配对表与形态表——描述里的行名与示例形态 id 取自
 * 它们），执行时每个动作按需取自己那几份（见 batch.js 的 runBatchAction）：status/list 不读
 * 模板与阶段表以外的份，就不必让模板坏了连台账查询一起失败；三个注册入口的免检承诺对称。
 */
function makeBatchTool(ctx, data, dataDir, ledgerPath) {
	const loadTables = ({ names }) => loadDispatchTables({ dataDir, names })
	return defineTool({
		name: 'dispatch_batch',
		description: batchDescription,
		parameters: batchParameters(data),
		output: {
			schema: BATCH_OUTPUT_SCHEMA,
			// 渲染必须是同步纯投影，不能在这里重跑查询：宿主那侧是
			// `rendered = tool.output.render(exec.arguments, value)` 直接取值（dsh-tools
			// lib/index.js:3548，不 await），紧接着 snapshotProjection 对返回值做一次
			// 结构化克隆。render 一旦 async，返回的就是 Promise，克隆它抛 DataCloneError，
			// 整次调用挂在「render 投影」上——比模型没挂上还糟。
			// 所以这层只做两件事：按同一个对象取 execute 那次的推导结果（命中＝省一次读，
			// 口径见 batch.js 的 renderModels），取不到就从结构化值自带的 events 复算（单批视图
			// 与两个写动作都带 events）。真宿主会把结构化值深拷贝一遍再交给 render，那条缓存
			// 在真宿主上必然 miss——多批视图的渲染因此还没有活路，已上报等裁决（要么让多批视图
			// 的结构化值带上推导好的那一份，要么改工具的输出契约，两者都动拍板项）。
			render: (_args, value) => [{ type: 'text', text: renderBatchResult(value, loadTables({ names: ['lifecycle', 'pairing'] })) }],
		},
		async execute(args, exec) {
			const port = createHostFsPort({ fs: ctx.fs, policy: ctx.get('sandboxPolicy'), agent: exec.agent })
			return runBatchAction({ port, path: ledgerPath, loadTables, dataDir, action: args.action, params: args, signal: exec.signal })
		},
	})
}

/**
 * 复盘工具的描述（逐字档）：点位口径与统计口径都写在描述里——它是常驻召回面，模型不会为了
 * 知道「凭什么算到点」去读别的文件。描述里的点位数字是快照，单源在 lifecycle 复盘行的 point
 * 字段（改阈值改数据面，描述随之改）；末句那句「只出建议、不落盘」是这套工具的边界本体：
 * 复盘工具自动改配对表＝绕过主会话裁决。
 */
const lessonsDescription = '复盘辅助：读台账全量事件，按复盘节奏（攒 5–8 批覆盖 ≥3 批型）判断是否到复盘点位；到了输出配对规则修订建议草稿（长期零 findings 形态降级、漏网多批型加派、修复轮数收敛统计、双报重叠趋势——历史统计按事件内规则版本分组，不跨版本平均；行数类数字台账事件没有维度，不出小批化校准项）。只出建议给主会话裁决，不自动改配对表、不落盘。'

/** 复盘工具的输出 schema（逐字档三字段）：stats 带点位摘要与分组明细，suggestions 是逐条草稿。 */
const LESSONS_OUTPUT_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		due: { type: 'boolean', required: true },
		stats: { type: 'string', required: true },
		suggestions: { type: 'array', items: { type: 'string' } },
	},
}

/**
 * 装配复盘工具。与台账工具同一条 I/O 通道（同一个包级 fs 端口、同一个台账路径）与同一份按需
 * 现读数据的注入，但它注册期一份数据都不读：描述与参数面里没有名单要拼（唯一个 force 是固定
 * 语义）。形态词表与阶段表在 execute 里逐趟取——词表是 combo/recommended 两个串的词法，阶段表
 * 那行 point 是点位判据，读侧拿它们切串与判点位，而复盘统计的是已经发生的事件、与出稿规则面
 * 无关，数据面坏了不该让复盘整件消失。
 *
 * 端口过一道只读门面再传下去：复盘工具结构上不许写，「只出建议不落盘」不该靠这层记得别写。
 */
function makeLessonsTool(ctx, dataDir, ledgerPath) {
	const loadTables = ({ names }) => loadDispatchTables({ dataDir, names })
	return defineTool({
		name: 'dispatch_lessons',
		description: lessonsDescription,
		parameters: {
			force: { type: 'boolean', description: '跳过点位判断直接出建议（默认 false）' },
		},
		output: {
			schema: LESSONS_OUTPUT_SCHEMA,
			// 同步纯投影：结构化值自带渲染要的全部文本（stats 与 suggestions），这里只排版——
			// 宿主深拷贝冻结后才交 render，按对象身份的缓存与渲染期读盘在那条路上都不可用
			render: (_args, value) => [{ type: 'text', text: renderLessonsResult(value) }],
		},
		async execute(args, exec) {
			const port = createReadOnlyPort(createHostFsPort({ fs: ctx.fs, policy: ctx.get('sandboxPolicy'), agent: exec.agent }))
			return runLessons({ port, path: ledgerPath, loadTables, force: args.force === true, signal: exec.signal })
		},
	})
}

/**
 * 配置归一只在这一处发生：数据目录与台账路径两个派生值，三个注册入口都从这里取。同式重复
 * 防不住任何东西，它只会在两处将来各自改动时把「一次归一」悄悄变成两次（memory/index.js 的
 * resolveRoot 旁那条注释说的是同一件事）。
 */
function resolveDispatchConfig({ dispatchDataDir: configuredDir, dispatchLedgerPath, memoryRoot } = {}) {
	return {
		dataDir: isNonBlankString(configuredDir) ? configuredDir : DEFAULT_DATA_DIR,
		ledgerPath: resolveLedgerPath({ configuredPath: dispatchLedgerPath, memoryRoot }),
	}
}

export function registerDispatch(ctx, config = {}) {
	const { dataDir, ledgerPath } = resolveDispatchConfig(config)
	// 注册时现读一次：描述与参数面里的清单要随配对表／lifecycle 走（见 dispatchParameters 与
	// 本文件的 description()）。数据坏了就让本工具注册失败——宁可它缺席，也不要挂一个行名
	// 清单与配对表对不上的工具在上下文里。
	const data = loadDispatchData({ dataDir })
	ctx.tools.register(makeDispatchTool(ctx, data, dataDir, ledgerPath))
}

/**
 * 台账工具单列一次注册：胶水层的 FEATURES 按工具逐条 try/catch，注册与 dispatch 写在一起
 * 就是「台账起不来顺带把装配器也带走」，而那两件事的失败原因毫无关系。
 *
 * 注册期只读配对表、形态表与阶段表（参数面要行名清单、示例形态 id 与阶段词表就这三份）：模板或
 * 方案任务书坏了不该让台账整件消失——台账记的是已经发生的批次，与出稿模板无关（与 dispatch
 * 那边的免检承诺对称：那边坏在出稿面，这边坏在出稿面，两边都不连坐）。阶段表在这里多读一份是
 * batchParameters 现读它拼 stage 的取值清单所致，不读就得把那份清单手抄进描述。
 */
export function registerDispatchBatch(ctx, config = {}) {
	const { dataDir, ledgerPath } = resolveDispatchConfig(config)
	const tables = loadDispatchTables({ dataDir, names: ['pairing', 'forms', 'lifecycle'] })
	ctx.tools.register(makeBatchTool(ctx, tables, dataDir, ledgerPath))
}

/**
 * 复盘工具单列一次注册：它与装配器、台账工具的失败原因都毫无关系（前者坏在出稿面、后者坏在
 * 事件读面、复盘坏在统计读面），绑进哪一行都是「一件起不来顺带把另一件带走」。
 */
export function registerDispatchLessons(ctx, config = {}) {
	const { dataDir, ledgerPath } = resolveDispatchConfig(config)
	ctx.tools.register(makeLessonsTool(ctx, dataDir, ledgerPath))
}

/**
 * 本模块的 Config 键（胶水层合成 package Config）。dispatchDataDir 空串＝模块同目录的
 * ./data/；dispatchLedgerPath 空串＝按 memoryRoot 推导到习惯层底目录下的 data/dispatch-ledger.jsonl
 * （推导口径见 batch.js 的 resolveLedgerPath，与 memory 写侧共用同一份「记忆根 → 层目录」归一）。
 */
export const configShape = {
	dispatchDataDir: z.string().default(''),
	dispatchLedgerPath: z.string().default(''),
}
