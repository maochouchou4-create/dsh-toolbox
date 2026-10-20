/**
 * dispatch 族工具装配（v2 两件化）：dispatch_task（施工任务书 + 直出可派参数）与
 * dispatch_challenge（证伪门/方案证伪 brief + 裁决记账），加台账 dispatch_batch 与复盘
 * dispatch_lessons。模块接口＝四个 register＋configShape；判断一件不做：档位终判、门里
 * 派几路、findings 怎么裁决、复盘建议怎么采纳全归主会话。
 *
 * 数据面逐趟现读：改 JSON 即改规则，不发版不重启；需要重启的只有代码改动。
 * 台账事件写在这里、不写进 core（core 是纯函数，node 直调即可断言直出参数）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { assertNoUnknownParams } from '../param-guard.js'
import { createHostFsPort, createReadOnlyPort } from '../fs-port.js'
import { objectList, objectShape, stringList } from '../tool-schema.js'
import {
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
import { renderLessonsResult, runLessons } from './lessons.js'

const taskDescription = '施工派发的装配（跑批工作流 v2）：按分诊档位 S/M/L 出任务书（≤15 行骨架；S 档免任务书但免不了记账）并直出可派参数（subagent prompt／workflow args 两形态），diff 预算按 changedFiles/diffLines 机判、超 1000 行直接拒绝并强制升 L；出稿即自动落 start 事件（档位／分诊行／拍板清单＋规则指纹）。档位×门组合对照表只在 README「dispatch 数据资产」一节，此处不复述。'

const challengeDescription = '证伪门／方案证伪的派发与记账：出独立复核 brief（只拿任务书＋净 diff、不读施工汇报、findings 附可复跑命令、一轮为限），或 adjudicate=true 时把 findings 裁决写进 gate 事件（采纳/拒收/双报重叠/漏网/施工段标记）；档位、分诊行、意图、拍板清单未传则从台账回填（subject 不回填：证伪门要净 diff 命令）。'

const batchDescription = '批次台账（四事件：start／gate／commit／review，agent-data 仓 ledger 两机共享，只追加）。commit 记提交与推送结果；review 记复盘行＋门效能（它同时是复盘销账点）；status 查门禁（哪道门没过一句话，提交前必查）；list 列全量批次。裁决完不记＝这轮复核没做完。'

const lessonsDescription = '复盘辅助：读台账找上次复盘（review 事件＝全仓销账点）之后的增量批，按复盘节奏（攒 5–8 批、覆盖 ≥3 个档位）判断是否到点位；到了出配对规则修订建议草稿（长期零 findings 形态降级、漏网加派、修复轮数收敛、双报重叠趋势；历史统计按事件内规则指纹分组，不跨版本平均）。只出建议给主会话裁决，不自动改配对表、不落盘。'

const diffBudgetShape = objectShape({
  threshold: { type: 'number', required: true },
  changedFiles: { type: 'number' },
  diffLines: { type: 'number' },
  verdict: { type: 'string', required: true },
  reason: { type: 'string', required: true },
})

const TASK_OUTPUT_SCHEMA = objectShape({
  batch: { type: 'string', required: true },
  tier: { type: 'string', required: true },
  taskBook: { type: 'boolean', required: true },
  triage: { type: 'string', required: true },
  triageLine: { type: 'string', required: true },
  diffBudget: { ...diffBudgetShape, required: true },
  gates: {
    ...objectShape({ planChallenge: { ...stringList(), required: true }, challenge: { ...stringList(), required: true } }),
    required: true,
  },
  prompt: { type: 'string', required: true },
  workflowArgs: { ...objectShape({ label: { type: 'string', required: true }, prompt: { type: 'string', required: true } }), required: true },
  gateReportLine: { type: 'string', required: true },
  decisionCards: stringList(),
  planAppendix: { type: 'string' },
  warnings: stringList(),
  text: { type: 'string', required: true },
})

const briefShape = objectShape({ form: { type: 'string', required: true }, text: { type: 'string', required: true } })
const argsShape = objectShape({ label: { type: 'string', required: true }, prompt: { type: 'string', required: true } })

const CHALLENGE_OUTPUT_SCHEMA = objectShape({
  batch: { type: 'string', required: true },
  gate: { type: 'string', required: true },
  tier: { type: 'string' },
  segment: { type: 'string', required: true },
  triageLine: { type: 'string' },
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
  tier: { type: 'string' },
  next: { type: 'string' },
  events: { type: 'array', items: objectShape(undefined, { additionalProperties: true }) },
  rows: { type: 'array', items: objectShape(undefined, { additionalProperties: true }) },
  emptyText: { type: 'string' },
  text: { type: 'string', required: true },
})

const LESSONS_OUTPUT_SCHEMA = objectShape({
  due: { type: 'boolean', required: true },
  stats: { type: 'string', required: true },
  suggestions: stringList(),
})

/** 任务书 → 落 start → 展示文本。台账写在 dispatch 装配层，不写进 core（core 保持纯函数）。 */
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
          tier: args.tier,
          triage: args.triage,
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
      const value = assembleChallenge(loaded.data, params)
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
            tier: params.tier ?? state?.tier ?? null,
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

/** 复盘工具：只读门面（结构上不许写）+ 逐趟现读数据面（统计的是已发生事件）。 */
function makeLessonsTool(ctx, dataDir, ledgerPath) {
  const parameters = { force: { type: 'boolean', description: '跳过点位判断直接出建议（默认 false）' } }
  return defineTool({
    name: 'dispatch_lessons',
    description: lessonsDescription,
    parameters,
    output: {
      schema: LESSONS_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderLessonsResult(value) }],
    },
    async execute(args, exec) {
      assertNoUnknownParams(args, { declared: Object.keys(parameters), action: 'dispatch_lessons' })
      const port = createReadOnlyPort(createHostFsPort({ fs: ctx.fs, policy: ctx.get('sandboxPolicy'), agent: exec.agent }))
      return runLessons({ port, path: ledgerPath, dataDir, force: args.force === true, signal: exec.signal })
    },
  })
}

/** 配置归一：台账路径一个派生值，四个注册入口都从这里取。 */
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

export function registerDispatchLessons(ctx, config = {}) {
  const { dataDir, ledgerPath } = resolveDispatchConfig(config)
  ctx.tools.register(makeLessonsTool(ctx, dataDir, ledgerPath))
}

export const configShape = {
  dispatchDataDir: z.string().default(''),
  dispatchLedgerPath: z.string().default(''),
}
