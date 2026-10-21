/**
 * dispatch 族工具装配（方案先行）：dispatch_task（施工派发出稿，方案文档单形态＋直出可派参数）与
 * dispatch_challenge（证伪门/方案证伪 brief + 裁决记账），加台账 dispatch_batch。
 * 模块接口＝三个 register＋configShape；判断一件不做：门里派几路、
 * findings 怎么裁决全归主会话。
 *
 * 数据面逐趟现读：改 JSON 即改规则，不发版不重启；需要重启的只有代码改动。
 * 台账事件写在这里、不写进 core（core 是纯函数，node 直调即可断言直出参数）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { assertNoUnknownParams } from '../param-guard.js'
import { createHostFsPort } from '../fs-port.js'
import { objectList, objectShape, stringList } from '../tool-schema.js'
import {
  DispatchInputError,
  GATE_LABELS,
  assembleChallenge,
  assembleTask,
  renderChallengeResult,
  renderTaskResult,
} from './core.js'
import {
  RenderModelMissingError,
  appendGateEvent,
  appendStartOnce,
  gateEvent,
  loadBatchState,
  mergeBackfill,
  resolveLedgerPath,
  rulesFingerprint,
  runBatchAction,
  startEvent,
} from './batch.js'
import { loadDispatchData, resolveDataDir } from './data.js'
import { batchParameters, challengeParameters, taskParameters } from './parameters.js'

const taskDescription = '施工派发的装配：出方案文档单形态的施工任务（方案骨架＋登记行，意图/锚点必填，对象/禁区/预算/验收命令可省）并直出可派参数（subagent prompt／workflow args 两形态）；出稿即自动落 start 事件（意图／拍板清单＋规则指纹）。方案定稿自查的规范源在 dispatch 数据资产（plan-spec），此处不复述。'

const challengeDescription = '证伪门／方案证伪的派发与记账：出独立复核 brief（只拿方案文档＋净 diff、不读施工汇报、findings 附可复跑命令、一轮为限），或 adjudicate=true 时把 findings 裁决写进 gate 事件（采纳/拒收/双报重叠/漏网/施工段标记）；复核形态 forms 追加语义：缺省按门给标准形态，显式点名逐个追加（安全专项缺省滤除、点名放行）；意图、拍板清单未传则从台账回填；subject 仅方案证伪从台账 start 事件回填（证伪门必传净 diff 命令）。'

const batchDescription = '批次台账（四事件：start／gate／commit／review，agent-data 仓 ledger 两机共享，进行中批的工作台，review 收官即清该批全部行）。commit 记提交与推送结果；review 记复盘行＋门效能（收官即清账）；status 查门禁（哪道门没过一句话，提交前必查）；list 列全量批次。裁决完不记＝这轮复核没做完。'

const TASK_OUTPUT_SCHEMA = objectShape({
  batch: { type: 'string', required: true },
  prompt: { type: 'string', required: true },
  workflowArgs: { ...objectShape({ label: { type: 'string', required: true }, prompt: { type: 'string', required: true } }), required: true },
  gateReportLine: { type: 'string', required: true },
  decisionCards: stringList(),
  warnings: stringList(),
  text: { type: 'string', required: true },
})

const briefShape = objectShape({ form: { type: 'string', required: true }, text: { type: 'string', required: true } })
const argsShape = objectShape({ label: { type: 'string', required: true }, prompt: { type: 'string', required: true } })

const CHALLENGE_OUTPUT_SCHEMA = objectShape({
  batch: { type: 'string', required: true },
  gate: { type: 'string', required: true },
  segment: { type: 'string', required: true },
  briefs: { type: 'array', items: briefShape, required: true },
  workflowArgs: { type: 'array', items: argsShape, required: true },
  gateReportLine: { type: 'string', required: true },
  warnings: stringList(),
  adjudication: {
    ...objectShape({
      recorded: { type: 'boolean', required: true },
      recommended: stringList(),
      forms: stringList(),
      perFormCounts: objectList({ form: { type: 'string', required: true }, count: { type: 'number', required: true } }),
      adopted: { type: 'number', required: true },
      rejected: { type: 'number', required: true },
      overlap: { type: 'number', required: true },
      missed: { type: 'string' },
      note: { type: 'string' },
    }),
    required: true,
  },
  text: { type: 'string', required: true },
})

const BATCH_OUTPUT_SCHEMA = objectShape({
  ok: { type: 'boolean', required: true },
  batch: { type: 'string' },
  next: { type: 'string' },
  events: { type: 'array', items: objectShape(undefined, { additionalProperties: true }) },
  rows: { type: 'array', items: objectShape(undefined, { additionalProperties: true }) },
  emptyText: { type: 'string' },
  text: { type: 'string', required: true },
})

/** 出稿 → 落 start → 展示文本。台账写在 dispatch 装配层，不写进 core（core 保持纯函数）。 */
function makeTaskTool(ctx, dataDir, ledgerPath) {
  const parameters = taskParameters()
  return defineTool({
    name: 'dispatch_task',
    description: taskDescription,
    parameters,
    output: {
      schema: TASK_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      assertNoUnknownParams(args, { declared: Object.keys(parameters), action: 'dispatch_task' })
      const loaded = loadDispatchData(dataDir)
      const value = assembleTask(loaded.data, args)
      const port = createHostFsPort({ fs: ctx.fs, policy: ctx.get('sandboxPolicy'), agent: exec.agent })
      const note = await appendStartOnce({
        port,
        path: ledgerPath,
        event: startEvent({
          batch: args.batch,
          intent: args.intent,
          subject: args.subject,
          decisions: args.decisions ?? [],
          rules: rulesFingerprint(loaded.raw),
        }),
        signal: exec.signal,
      })
      const text = renderTaskResult(value)
      return { ...value, warnings: [...loaded.warnings, note, ...value.warnings], text }
    },
  })
}

/** 复核 brief／裁决记账同一件工具：adjudicate 分野，两种值是同一张输出 schema。 */
function makeChallengeTool(ctx, dataDir, ledgerPath) {
  const parameters = challengeParameters()
  return defineTool({
    name: 'dispatch_challenge',
    description: challengeDescription,
    parameters,
    output: {
      schema: CHALLENGE_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      assertNoUnknownParams(args, { declared: Object.keys(parameters), action: 'dispatch_challenge' })
      const loaded = loadDispatchData(dataDir)
      const port = createHostFsPort({ fs: ctx.fs, policy: ctx.get('sandboxPolicy'), agent: exec.agent })
      const state = await loadBatchState({ port, path: ledgerPath, batch: args.batch, data: loaded.data, signal: exec.signal })
      const gate = args.gate ?? GATE_LABELS.challenge
      const { params, notes } = mergeBackfill({ args, state, gate })
      // 回填摘记只在成功路径进 warnings；校验抛错时它们随局部变量一起消失，报错就丢了台账
      // 现值（补记线索只剩一半）。这里把摘记织回错误文案再重抛：拍板「报错并回显台账现值」的落点。
      let value
      try {
        value = assembleChallenge(loaded.data, params)
      } catch (error) {
        if (error instanceof DispatchInputError && notes.length > 0) {
          error.message = `${error.message}；台账现值：${notes.join('；')}`
        }
        throw error
      }
      let adjudication = {
        recorded: false,
        recommended: [],
        forms: [],
        perFormCounts: [],
        adopted: 0,
        rejected: 0,
        overlap: 0,
        missed: '',
        note: '',
      }
      const warnings = [...loaded.warnings, ...notes, ...value.warnings]
      if (params.adjudicate) {
        adjudication = {
          recorded: true,
          recommended: params.recommended ?? value.workflowArgs.map(entry => entry.label.split('·').at(-1)),
          forms: params.forms ?? value.briefs.map(brief => brief.form),
          perFormCounts: params.perFormCounts ?? [],
          adopted: params.adopted ?? 0,
          rejected: params.rejected ?? 0,
          overlap: params.overlap ?? 0,
          missed: params.missed ?? '',
          note: params.note ?? '',
        }
        const note = await appendGateEvent({
          port,
          path: ledgerPath,
          event: gateEvent({
            batch: params.batch,
            gate: value.gate,
            segment: value.segment,
            recommended: adjudication.recommended,
            forms: adjudication.forms,
            perFormCounts: adjudication.perFormCounts,
            adopted: adjudication.adopted,
            rejected: adjudication.rejected,
            overlap: adjudication.overlap,
            missed: adjudication.missed,
            note: adjudication.note,
            rules: rulesFingerprint(loaded.raw),
          }),
          signal: exec.signal,
        })
        warnings.push(note)
        return { ...value, adjudication, warnings, text: renderChallengeResult({ ...value, adjudication }) }
      }
      return { ...value, adjudication, warnings, text: renderChallengeResult(value) }
    },
  })
}

/** 台账工具：四动作同一批事件；渲染只投影 execute 算好的 text（render 里不读盘）。 */
function makeBatchTool(ctx, dataDir, ledgerPath) {
  const parameters = batchParameters()
  return defineTool({
    name: 'dispatch_batch',
    description: batchDescription,
    parameters,
    output: {
      schema: BATCH_OUTPUT_SCHEMA,
      render: (_args, value) => {
        if (typeof value.text !== 'string') {
          throw new RenderModelMissingError('台账渲染：结构化值不带 text（内部不变量被破坏）')
        }
        return [{ type: 'text', text: value.text }]
      },
    },
    async execute(args, exec) {
      assertNoUnknownParams(args, { declared: Object.keys(parameters), action: 'dispatch_batch' })
      const port = createHostFsPort({ fs: ctx.fs, policy: ctx.get('sandboxPolicy'), agent: exec.agent })
      return runBatchAction({ port, path: ledgerPath, dataDir, action: args.action, params: args, signal: exec.signal })
    },
  })
}

/** 配置归一：台账路径一个派生值，三个注册入口都从这里取。 */
function resolveDispatchConfig({ dispatchDataDir: configuredDir, dispatchLedgerPath, memoryRoot } = {}) {
  return {
    dataDir: resolveDataDir(configuredDir),
    ledgerPath: resolveLedgerPath({ configuredPath: dispatchLedgerPath, memoryRoot }),
  }
}

export function registerDispatchTask(ctx, config = {}) {
  const { dataDir, ledgerPath } = resolveDispatchConfig(config)
  loadDispatchData(dataDir)
  ctx.tools.register(makeTaskTool(ctx, dataDir, ledgerPath))
}

export function registerDispatchChallenge(ctx, config = {}) {
  const { dataDir, ledgerPath } = resolveDispatchConfig(config)
  loadDispatchData(dataDir)
  ctx.tools.register(makeChallengeTool(ctx, dataDir, ledgerPath))
}

export function registerDispatchBatch(ctx, config = {}) {
  const { dataDir, ledgerPath } = resolveDispatchConfig(config)
  ctx.tools.register(makeBatchTool(ctx, dataDir, ledgerPath))
}

export const configShape = {
  dispatchDataDir: z.string().default(''),
  dispatchLedgerPath: z.string().default(''),
}
