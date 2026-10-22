/**
 * dispatch 族装配：一件台账工具 dispatch_batch（六动作）。
 *
 * 纪律与模板不再经工具派发——纪律进 systemPrompt 注入（dispatch/discipline.js），模板是人读的
 * 数据文件（data/templates.md），台账只记事实、不设闸不设提醒。判断一件不做：门里派几路、
 * findings 怎么裁决全归主会话。
 *
 * 数据面逐趟现读：改 templates.md 即换规则指纹，不发版不重启；需要重启的只有代码改动。
 * 台账事件写在这里、不写进 batch（batch 是纯函数，node 直调即可断言直出参数）。
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertNoUnknownParams } from '../param-guard.js'
import { createHostFsPort } from '../fs-port.js'
import { objectShape } from '../tool-schema.js'
import { RenderModelMissingError, resolveLedgerPath, runBatchAction } from './batch.js'
import { resolveDataDir } from './data.js'
import { batchParameters } from './parameters.js'

const batchDescription =
  '批次台账（六动作：start／gate／commit／review／status／list；agent-data 仓 ledger 两机共享）。台账只记事实——不设闸、不设提醒，进行中的批是工作台，review 收官即清该批全部行。start 立项（batch/intent 必填，subject 缺省占位）；gate 记门报（门名必填：方案证伪／证伪门；裁决字段 adopted／rejected／overlap／perFormCounts 只落账不判）；commit 记提交与推送结果；review 记复盘行＋门效能；status 查单批事件与进度（不判门禁）；list 列全量批次。'

const BATCH_OUTPUT_SCHEMA = objectShape({
  ok: { type: 'boolean', required: true },
  batch: { type: 'string' },
  next: { type: 'string' },
  events: { type: 'array', items: objectShape(undefined, { additionalProperties: true }) },
  rows: { type: 'array', items: objectShape(undefined, { additionalProperties: true }) },
  emptyText: { type: 'string' },
  text: { type: 'string', required: true },
})

/** 台账工具：六动作同一批事件；渲染只投影 execute 算好的 text（render 里不读盘）。 */
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

/** 配置归一：台账路径一个派生值，装配入口从这里取。 */
function resolveDispatchConfig({ dispatchDataDir: configuredDir, dispatchLedgerPath, memoryRoot } = {}) {
  return {
    dataDir: resolveDataDir(configuredDir),
    ledgerPath: resolveLedgerPath({ configuredPath: dispatchLedgerPath, memoryRoot }),
  }
}

export function registerDispatchBatch(ctx, config = {}) {
  const { dataDir, ledgerPath } = resolveDispatchConfig(config)
  ctx.tools.register(makeBatchTool(ctx, dataDir, ledgerPath))
}

export const configShape = {
  dispatchDataDir: z.string().default(''),
  dispatchLedgerPath: z.string().default(''),
}
