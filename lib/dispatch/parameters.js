/**
 * dispatch_batch 的参数面（schema 声明层）：六动作共用一张扁平表。
 *
 * 条件必填（start 要 intent、gate 要门名、commit 要 commit/pushed、review 要 retro）只能由
 * execute 与 batch.js 判——扁平 schema 里的 required 只有「任何动作都必填」的 action 一格；
 * 把动作相关字段写进 required 会让另一动作的调用被 schema 直接拒掉。
 */
import { objectList, stringList } from '../tool-schema.js'

export function batchParameters() {
  return {
    action: {
      type: 'string',
      required: true,
      description:
        'start｜gate｜commit｜review｜status｜list。start 立项落账（batch/intent 必填，subject 缺省占位）；gate 记门报（门名必填，裁决字段只落账不判）；commit 记提交与推送结果；review 记复盘行＋门效能（收官即清账）；status 查单批事件与进度；list 列全量批次。',
    },
    batch: { type: 'string', description: '批次名（start/gate/commit/review/status 必填；list 可省）。' },
    intent: {
      type: 'string',
      description: '本批意图一句话（action=start 必填）：设计判断要知道目标才谈得上最优。',
    },
    subject: {
      type: 'string',
      description: '对象（action=start 可选）：方案文档绝对路径＋批次节指针；未定先不传（台账写占位「（待写）」）。',
    },
    decisions: { ...stringList(), description: '拍板清单（action=start 可选）：不得重开，逐条原文。' },
    gate: {
      type: 'string',
      description: '门名（action=gate 必填）：证伪门（施工后，对象＝净 diff）｜方案证伪（施工前，对象＝方案文档）。台账按门名分流，词表之外直接报错。',
    },
    segment: {
      type: 'string',
      description: '施工段标记（action=gate 可选）：判的是哪个施工段的净 diff；缺省按门给 方案／净 diff。',
    },
    forms: { ...stringList(), description: '实派形态（action=gate 可选）：这趟真派了哪些复核形态。' },
    recommended: {
      ...stringList(),
      description: '当趟装配的推荐组合（action=gate 可选）：脚本次账的分母；未裁剪时＝forms。',
    },
    perFormCounts: {
      ...objectList({ form: { type: 'string', required: true }, count: { type: 'number', required: true } }),
      description: '各形态 findings 数（action=gate 可选；缺省=0）。',
    },
    adopted: {
      type: 'number',
      description: '采纳的 findings 数（action=gate 可选，缺省 0；与 rejected 各自落账，不互相推导）。',
    },
    rejected: { type: 'number', description: '显式拒收数（action=gate 可选，缺省 0）。' },
    overlap: { type: 'number', description: '双路重复上报的 findings 数（action=gate 可选，缺省 0）。' },
    missed: {
      type: 'string',
      description: '漏网标记（action=gate 可选）：用户事后实测暴露的问题＋本可由哪形态抓到；无漏网不传此字段（写『无』会被统计当真漏网）。',
    },
    note: { type: 'string', description: '自由附注一句。' },
    commit: { type: 'string', description: 'commit 号（action=commit 必填，单行）。' },
    pushed: {
      type: 'string',
      description: '推送结果（action=commit 必填，单行；如 ok／failed: <原因>／not-pushed）。',
    },
    retro: {
      type: 'string',
      description: '复盘行（action=review 必填，单行）：本批结论＋下一轮口径。',
    },
    efficacy: { type: 'string', description: '门效能一句（action=review 可选）：哪道门拦住了什么、哪道门零拦截。' },
  }
}
