/**
 * 跑批工作流的共享词表：数据层（data.js）与台账层（batch.js）都从这里取门名、阶段名，
 * 避免同一词表在多处各写一份。
 */

/** 门名与数据面键的映射：台账只记门名，键名只是代码里的助记。 */
export const GATE_LABELS = {
  planChallenge: '方案证伪',
  challenge: '证伪门',
}

/** 门名全集，按发生顺序（方案证伪先于证伪门）。 */
export const GATE_NAMES = ['方案证伪', '证伪门']

/**
 * 台账四事件→阶段名，键序即阶段发生顺序。阶段名是状态机词汇，事件名是落盘词汇，
 * 两者一一对应：lifecycle.json 的 kind 列、纪律文本里的 action 序列都由这一份派生。
 */
export const KIND_ACTIONS = {
  立项: 'start',
  门报: 'gate',
  提交: 'commit',
  复盘: 'review',
}

/** 阶段名全集（按发生顺序）：状态机只认这四步。 */
export const LIFECYCLE_KINDS = Object.keys(KIND_ACTIONS)

/** 台账里「对象待写」的占位符：start 落账未带 subject 时写入，标记槽位未登记。 */
export const SUBJECT_PLACEHOLDER = '（待写）'
