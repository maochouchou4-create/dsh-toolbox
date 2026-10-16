/**
 * dispatch 族工具装配：派发装配四件（dispatch_plan／dispatch_review／dispatch_build／
 * dispatch_verify，各服务一个固定阶段）＋批次台账 dispatch_batch（四个 action 同一批事件）＋
 * 跨批复盘 dispatch_lessons。模块接口＝六个 register＋configShape；判断一件不做：批型终判、
 * 要不要加挂、findings 怎么裁决、复盘建议怎么采纳全归主会话。本层只做接线——现读数据
 * （./data.js）、调纯函数核心（./core.js、./batch.js、./lessons.js）、把结构化输出渲染成
 * 人话（模型读文本，程序读结构化值本身）。
 *
 * 四件装配工具的注册各占 FEATURES 一行（逐工具隔离现机制承重：一件起不来不带走别的）；工具名↔
 * 阶段的对应关系单源在 core 的 ASSEMBLER_CONTRACTS，本层按契约表逐件装配，不留第二份映射。
 * stage 不再是调用方参数：execute 按本件契约把阶段常量注进 params，core 全程只认 params.stage。
 *
 * 调用期逐次现读：数据文件是规则面，改 JSON 即改规则、不发版不重启；需要重启的只有代码
 * 改动。注册时另有一次现读只为把参数面里的清单拼出来（工具定义在注册时定型），执行时不吃
 * 那份快照。数据目录留 Config 口（dispatchDataDir）为的是测试能指向临时目录与两机各配，
 * 不是运行时的常规用法。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { assertNoUnknownParams } from '../param-guard.js'
import { createHostFsPort, createReadOnlyPort } from '../fs-port.js'
import { objectShape, stringList } from '../tool-schema.js'
import { ASSEMBLER_CONTRACTS, PLAN_STAGE, CONSTRUCTION_STAGE, GATE_LABELS } from './core.js'
import { RenderModelMissingError, resolveLedgerPath, runBatchAction, withBatchBackfill } from './batch.js'
import { assembleDispatch } from './core.js'
import { loadDispatchData, loadDispatchTables, loadDispatchTablesWithBytes, resolveDataDir } from './data.js'
import { assemblerParameters, batchParameters } from './parameters.js'
import { renderLessonsResult, runLessons } from './lessons.js'

/**
 * 四件装配工具的描述＝各一句自述＋一句指路。描述是常驻召回面（每个请求都在上下文里），体量
 * 就是成本：批型→形态对照表只在 README「dispatch 数据资产」一节出现，描述不复述——四件各抄
 * 一份对照表等于四份停更风险；四句指路写法各不同，描述去重的机判（体量上限＋句去重）才立得住。
 * 写法上的取舍：能力清单（combo/briefs/节奏/自检/裁决段…）不再逐项列——那些在输出里本来
 * 就逐项可见，描述里列一遍是矩阵散文的复辟。
 */
const ASSEMBLER_DESCRIPTIONS = {
	[PLAN_STAGE]: '方案阶段的派发装配：出方案任务书（完整方案规范骨架＋定稿自查清单）与节奏提示，写实施方案前调用；批型→形态组合对照表只在 README「dispatch 数据资产」一节，此处不复述。',
	[GATE_LABELS.gate1]: '门一（方案证伪复核）的派发装配：按批型查配对表出各复核形态的完整 brief（角色句＋必读链＋横切判据＋上报格式），方案定稿后调用；批型配对表在 README「dispatch 数据资产」节。',
	[CONSTRUCTION_STAGE]: '施工阶段的派发装配：出施工 brief（执行纪律固定段＋锚点＋禁区＋自验封顶；修复批强制根因分类），施工者按它动工；形态怎么配看 README「dispatch 数据资产」，此处不抄。',
	[GATE_LABELS.gate2]: '门二（净 diff 终审）的派发装配：按批型查配对表出各复核形态 brief（对象＝净 diff 生成命令，不从台账回填），施工完成后调用；各批型两道门各配哪几路，README「dispatch 数据资产」节逐行可查。',
}

/**
 * 一拆四的退役别名：老 dispatch 的 stage 键不再存在，收到它按别名表指路而不是当一般未知键——
 * 照旧习惯传 stage 的调用方（人与模型都有）要拿到「该改调哪件」的答案，而不是「没有这个参数」。
 */
const RETIRED_ASSEMBLER_PARAMS = {
	stage: '阶段已随一拆四固化：dispatch_plan＝方案、dispatch_review＝门一、dispatch_build＝施工、dispatch_verify＝门二——选对工具即可，不再收 stage 参数。',
}

/** 台账工具的描述（逐字档）：四个 action 的分工与「裁决完不记＝这轮复核没做完」那一句。 */
const batchDescription = '批次台账：工作流每个批次的一生记成结构化事件（agent-data 仓 ledger，两机共享）。start 登记批次（意图＋拍板清单不得重开——此后 dispatch_plan/review/build/verify 传 batch= 自动带出；幂等：重复 start 报错）；advance 记阶段完成（各形态 findings 数/采纳拒绝/双报重叠/修复轮数/实派组合/漏网标记）；status 查门禁（哪道门没过一句话——事件集合式推导，提交前必查）；list 列全量批次。裁决完不记＝这轮复核没做完。'

/** briefs/combo 的行形状：形态名＋载荷。输出 schema 是逐字档那份，七个字段不多不少。 */
const briefItem = objectShape({
	form: { type: 'string', required: true },
	text: { type: 'string', required: true },
})

const comboItem = objectShape({
	form: { type: 'string', required: true },
	reason: { type: 'string', required: true },
})

const OUTPUT_SCHEMA = objectShape({
	combo: { type: 'array', items: comboItem },
	briefs: { type: 'array', items: briefItem },
	rhythm: stringList(),
	checklist: stringList(),
	rejected: stringList(),
	warnings: stringList(),
	adjudication: stringList(),
})

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
 * 装配一件派发工具（按契约表一行造一件；四件并一行注册＝逐工具隔离没了）。ctx 是 execute 里
 * 回填台账要用的（fs 服务与沙箱策略）：拿在参数上而不是从模块级取，是因为这条线要穿过
 * defineTool——签名里少一个 ctx 而 execute 里引用它，是纯语法引用检查看不见、只到运行期
 * 每次调用才炸的那类接错（ctx.tools.register 的接线单测只查导入名，查不到「注册函数有没有
 * 把 ctx 传下去」）。
 */
function makeAssemblerTool(ctx, contract, data, dataDir, ledgerPath) {
	// 名单源＝本件参数字面量的 Object.keys，提成局部常量再两头引用：defineTool 吃掉这张表后
	// 返回的工具对象上是编译后的 JSON Schema，execute 里拿不到声明名清单——现场反推 schema
	// 等于把「参数面长什么样」的判定交给编译产物，不如从源头取同一份。
	const parameters = assemblerParameters(data, contract.stage)
	return defineTool({
		name: contract.name,
		description: ASSEMBLER_DESCRIPTIONS[contract.stage],
		parameters,
		output: {
			schema: OUTPUT_SCHEMA,
			render: (_args, value) => [{ type: 'text', text: renderDispatchResult(value) }],
		},
		async execute(args, exec) {
			// 未知键自查：宿主把参数根节点编译成开放对象，未声明的键只有这里看得见；stage 那类
			// 退役键走别名表指路（见 RETIRED_ASSEMBLER_PARAMS）
			assertNoUnknownParams(args, { declared: Object.keys(parameters), aliases: RETIRED_ASSEMBLER_PARAMS, action: contract.name })
			const { warnings: dataWarnings, ...fresh } = loadDispatchData({ dataDir })
			// 先回填再校验：回填的那几格里两格是每阶段必填，顺序反了就成「先报缺必填」——
			// 契约在 batch.js 的 withBatchBackfill 头注里，那儿有一条单测钉住次序
			const { params, notes } = await withBatchBackfill({ ctx, args, exec, data: fresh, ledgerPath, stage: contract.stage })
			// stage 注入点：本件的契约阶段在这里进 params，core 全程只认 params.stage——
			// 工具名↔阶段的对应关系不出契约表，装配层不另写一份
			const assembled = assembleDispatch(fresh, { ...params, stage: contract.stage })
			// 三路告警合流：数据面告警（孤儿形态）对每一次调用都成立、放最前（「先改数据再谈
			// 别的」那层）；台账占位提醒是回填面的话；行号锚点那类是本次调用自己的。
			// 用的逐次现读那份，不是注册时拼参数描述那份快照。
			return { ...assembled, warnings: [...dataWarnings, ...notes, ...assembled.warnings] }
		},
	})
}

/** 台账工具的输出 schema（逐字档四字段＋多批视图的 rows 摘要）；告警不进单批结构化值，
 *  多批视图的行摘要里带（每行的告警与那一行是同一件事的）。 */
const BATCH_OUTPUT_SCHEMA = objectShape({
	ok: { type: 'boolean', required: true },
	batch: { type: 'string' },
	next: { type: 'string' },
	// 事件行是两类异构记录（start/advance 各带自己那几格），逐字段列在这里就是第二份事件
	// 契约——事件构造处一改，这里跟着改的那天就晚了。显式 true 是宿主的硬要求：object 节点
	// 不显式声明 additionalProperties，defineTool 编译就抛「unsupported JSON schema」，
	// 整件工具缺席（不是这条事件被拒，是工具没注册上）
	events: { type: 'array', items: objectShape(undefined, { additionalProperties: true }) },
	// 多批视图（list 与不带批次的 status）带 rows 而不带 events：一批一行的状态摘要，事件全量
	// 一百分批就是几百 KB 的上下文负担。它是那两条视图的展示文本的推导输入——execute 那一趟
	// 由它算好 text，渲染只投影 text
	rows: { type: 'array', items: objectShape(undefined, { additionalProperties: true }) },
	// 空态那句话（rows 为空时才带）：渲染照值说话，不自己判「台账空了」还是「全收尾了」
	emptyText: { type: 'string' },
	// 展示文本：execute 那一次把它算进值里（口径见 batch.js 的 withRenderText），故 render
	// 不读盘也不重跑查询。顶层闭集——多带字段＝输出契约变更，宿主按 schema 判（缺它即
	// ToolOutputError），所以它必填而不是可省
	text: { type: 'string', required: true },
})

/**
 * 装配台账工具。参数面在注册时现读一次（只读配对表与形态表——描述里的行名与示例形态 id 取自
 * 它们），执行时每个动作按需取自己那几份（见 batch.js 的 runBatchAction）：status/list 不读
 * 模板与阶段表以外的份，就不必让模板坏了连台账查询一起失败；各注册入口的免检承诺对称。
 */
function makeBatchTool(ctx, data, dataDir, ledgerPath) {
	const loadTables = ({ names }) => loadDispatchTablesWithBytes({ dataDir, names })
	// 名单源＝参数字面量的 Object.keys（理由同 makeAssemblerTool 那条注）
	const parameters = batchParameters(data)
	return defineTool({
		name: 'dispatch_batch',
		description: batchDescription,
		parameters,
		output: {
			schema: BATCH_OUTPUT_SCHEMA,
			// 渲染必须是同步纯投影，不能在这里重跑查询：宿主那侧是
			// `rendered = tool.output.render(exec.arguments, value)` 直接取值（dsh-tools
			// lib/index.js:3548，不 await），紧接着 snapshotProjection 对返回值做一次
			// 结构化克隆。render 一旦 async，返回的就是 Promise，克隆它抛 DataCloneError，
			// 整次调用挂在「render 投影」上——比模型没挂上还糟。
			// 所以这层只投影 execute 算好的那一份文本：读数据面与折状态都在 execute 里做一次，
			// 渲染这条路上一次读盘也没有（口径见 batch.js 的 withRenderText）。
			render: (_args, value) => {
				// 宿主按 schema 先判 text 必填（缺它当场 ToolOutputError）；这一格是给手工造值
				// 的调用方与将来的改动留的——静默出空文本看不出是值少了一格
				if (typeof value.text !== 'string') {
					throw new RenderModelMissingError('台账渲染：结构化值不带 text，展示文本没算进值里（内部不变量被破坏）')
				}
				return [{ type: 'text', text: value.text }]
			},
		},
		async execute(args, exec) {
			assertNoUnknownParams(args, { declared: Object.keys(parameters), action: 'dispatch_batch' })
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
const LESSONS_OUTPUT_SCHEMA = objectShape({
	due: { type: 'boolean', required: true },
	stats: { type: 'string', required: true },
	suggestions: stringList(),
})

/**
 * 装配复盘工具。与台账工具同一条 I/O 通道（同一个台账路径）与同一份按需现读数据的注入，但它
 * 注册期一份数据都不读：描述与参数面里没有名单要拼（唯一个 force 是固定语义）。形态词表与
 * 阶段表在 execute 里逐趟取——词表是 combo/recommended 计数格的键域，阶段表那行 point 是点位
 * 判据，读侧拿它们归一与判点位，而复盘统计的是已经发生的事件、与出稿规则面无关，数据面坏了
 * 不该让复盘整件消失。
 *
 * 端口过一道只读门面再传下去：复盘工具结构上不许写，「只出建议不落盘」不该靠这层记得别写。
 */
function makeLessonsTool(ctx, dataDir, ledgerPath) {
	const loadTables = ({ names }) => loadDispatchTablesWithBytes({ dataDir, names })
	const parameters = {
		force: { type: 'boolean', description: '跳过点位判断直接出建议（默认 false）' },
	}
	return defineTool({
		name: 'dispatch_lessons',
		description: lessonsDescription,
		parameters,
		output: {
			schema: LESSONS_OUTPUT_SCHEMA,
			// 同步纯投影：结构化值自带渲染要的全部文本（stats 与 suggestions），这里只排版——
			// 宿主深拷贝冻结后才交 render，按对象身份的缓存与渲染期读盘在那条路上都不可用
			render: (_args, value) => [{ type: 'text', text: renderLessonsResult(value) }],
		},
		async execute(args, exec) {
			assertNoUnknownParams(args, { declared: Object.keys(parameters), action: 'dispatch_lessons' })
			const port = createReadOnlyPort(createHostFsPort({ fs: ctx.fs, policy: ctx.get('sandboxPolicy'), agent: exec.agent }))
			return runLessons({ port, path: ledgerPath, loadTables, force: args.force === true, signal: exec.signal })
		},
	})
}

/**
 * 配置归一只在这一处发生：台账路径一个派生值，六个注册入口都从这里取。同式重复防不住任何
 * 东西，它只会在两处将来各自改动时把「一次归一」悄悄变成两次（memory/index.js 的 resolveRoot
 * 旁那条注释说的是同一件事）。数据目录那一格由 data.js 的 resolveDataDir 归一——它与各处读取
 * 入口读的是同一份判据，留空串的处理口径只此一处。
 */
function resolveDispatchConfig({ dispatchDataDir: configuredDir, dispatchLedgerPath, memoryRoot } = {}) {
	return {
		dataDir: resolveDataDir(configuredDir),
		ledgerPath: resolveLedgerPath({ configuredPath: dispatchLedgerPath, memoryRoot }),
	}
}

/** 按工具名取契约行：注册函数与契约表之间不许出现位置索引（加行/换序时索引悄悄指去别件）。 */
const contractByName = (name) => {
	const contract = ASSEMBLER_CONTRACTS.find((entry) => entry.name === name)
	if (contract === undefined) {
		throw new Error(`装配契约缺「${name}」行——四件的注册各按契约表逐行来，缺行＝注册不出对应工具`)
	}
	return contract
}

/**
 * 一件装配工具的注册工厂：注册期现读一次数据（参数面里的批型行名与条件名单要随配对表走）。
 * 数据坏了就让本件注册失败——宁可它缺席，也不要挂一个行名清单与配对表对不上的工具在上下文里。
 * 四件各占 FEATURES 一行、各自 try/catch，互不连坐。
 */
const registerAssemblerFor = (name) => (ctx, config = {}) => {
	const { dataDir, ledgerPath } = resolveDispatchConfig(config)
	const data = loadDispatchData({ dataDir })
	ctx.tools.register(makeAssemblerTool(ctx, contractByName(name), data, dataDir, ledgerPath))
}

export const registerDispatchPlan = registerAssemblerFor('dispatch_plan')
export const registerDispatchReview = registerAssemblerFor('dispatch_review')
export const registerDispatchBuild = registerAssemblerFor('dispatch_build')
export const registerDispatchVerify = registerAssemblerFor('dispatch_verify')

/**
 * 台账工具单列一次注册：胶水层的 FEATURES 按工具逐条 try/catch，注册与装配四件写在一起
 * 就是「台账起不来顺带把装配器也带走」，而那几件事的失败原因毫无关系。
 *
 * 注册期只读配对表、形态表与阶段表（参数面要行名清单、示例形态 id 与阶段词表就这三份）：模板或
 * 方案任务书坏了不该让台账整件消失——台账记的是已经发生的批次，与出稿模板无关（与装配四件
 * 那边的免检承诺对称：那边坏在出稿面，这边坏在事件读面，两边都不连坐）。阶段表在这里多读一份是
 * batchParameters 现读它拼 stage 的取值清单所致，不读就得把那份清单手抄进描述。
 */
export function registerDispatchBatch(ctx, config = {}) {
	const { dataDir, ledgerPath } = resolveDispatchConfig(config)
	const tables = loadDispatchTables({ dataDir, names: ['pairing', 'forms', 'lifecycle'] })
	ctx.tools.register(makeBatchTool(ctx, tables, dataDir, ledgerPath))
}

/**
 * 复盘工具单列一次注册：它与装配四件、台账工具的失败原因都毫无关系（前者坏在出稿面、台账坏在
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
