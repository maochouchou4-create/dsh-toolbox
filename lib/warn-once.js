/**
 * 同一告警信息只报一次的告警器工厂：记忆索引注入等装配共用这条
 * 「状态不变不刷屏」纪律——dedup 键＝消息文本，状态迁移产生新文本时自然再报。
 * 收日志函数而不收 ctx：本模块零宿主依赖、可直接单测（test/shared-primitives.test.js），
 * [memory] 等前缀由调用方闭进日志函数，不进本层。
 */
export function makeWarnOnce(warn) {
  const emitted = new Set()
  return (message) => {
    if (emitted.has(message)) return
    emitted.add(message)
    warn(message)
  }
}
