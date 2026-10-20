/**
 * 跑批工作流 v2 的共享词表：数据层（data.js）、核心层（core.js）、台账层（batch.js）
 * 都从这里取档位、门名、阶段名，避免同一词表在多处各写一份。
 */

/** 档位词表（S 小修／M 常规／L 大档）。 */
export const TIERS = ['S', 'M', 'L']

/** 门名与配对表列名的映射：台账只记门名，列名只是数据面的键。 */
export const GATE_LABELS = {
  planChallenge: '方案证伪',
  challenge: '证伪门',
}

/** 门名→配对表列名（GATE_LABELS 的反查）。 */
export const GATE_COLUMN_BY_LABEL = {
  方案证伪: 'planChallenge',
  证伪门: 'challenge',
}

/** 门名全集，按发生顺序（方案证伪先于证伪门）。 */
export const GATE_NAMES = ['方案证伪', '证伪门']

/** 台账四事件→阶段名。阶段名是状态机词汇，事件名是落盘词汇，两者一一对应。 */
export const LIFECYCLE_KINDS = ['立项', '门报', '提交', '复盘']

/** 事件名→阶段名。 */
export const EVENT_STAGE = {
  start: '立项',
  gate: '门报',
  commit: '提交',
  review: '复盘',
}

/** 阶段名→事件名（EVENT_STAGE 的反查）。 */
export const STAGE_EVENT = {
  立项: 'start',
  门报: 'gate',
  提交: 'commit',
  复盘: 'review',
}

/** 任务书与复核工具接受的参数名全集；生命周期 requires 只能是这些字段名。 */
export const PARAM_FIELDS = [
  'batch',
  'tier',
  'triage',
  'intent',
  'subject',
  'anchors',
  'decisions',
  'forbidden',
  'budget',
  'acceptance',
  'changedFiles',
  'diffLines',
  'decisionCards',
  'gate',
  'segment',
  'forms',
  'recommended',
  'perFormCounts',
  'adopted',
  'rejected',
  'overlap',
  'missed',
  'note',
  'adjudicate',
]

/** 台账可回填给复核工具的参数：登记过的批次不必再手贴。 */
export const BACKFILL_FIELDS = ['tier', 'triage', 'intent', 'subject', 'decisions']

/** 台账里「对象待写」的占位符：读到它＝该槽位没登记，按未登记处理并提醒补记。 */
export const SUBJECT_PLACEHOLDER = '（待写）'

/** diff 超阈的兜底阈值：单源在 pairing.json 的硬触发行，缺行时才用这个。 */
export const DIFF_BUDGET_FALLBACK = 1000
