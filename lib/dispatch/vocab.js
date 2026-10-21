/**
 * 跑批工作流的共享词表：数据层（data.js）、核心层（core.js）、台账层（batch.js）
 * 都从这里取门名、阶段名、参数名，避免同一词表在多处各写一份。
 */

/** 门名与数据面键的映射：台账只记门名，键名只是数据面的键。 */
export const GATE_LABELS = {
  planChallenge: '方案证伪',
  challenge: '证伪门',
}

/** 门名全集，按发生顺序（方案证伪先于证伪门）。 */
export const GATE_NAMES = ['方案证伪', '证伪门']

/** 台账四事件→阶段名。阶段名是状态机词汇，事件名是落盘词汇，两者一一对应。 */
export const LIFECYCLE_KINDS = ['立项', '门报', '提交', '复盘']

/** 复核与台账工具接受的参数名全集；生命周期 requires 只能是这些字段名。 */
export const PARAM_FIELDS = [
  'batch',
  'intent',
  'subject',
  'anchors',
  'decisions',
  'forbidden',
  'budget',
  'acceptance',
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
export const BACKFILL_FIELDS = ['intent', 'subject', 'decisions']

/** 台账里「对象待写」的占位符：读到它＝该槽位没登记，按未登记处理并提醒补记。 */
export const SUBJECT_PLACEHOLDER = '（待写）'
