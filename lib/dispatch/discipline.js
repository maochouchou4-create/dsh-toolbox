/**
 * 跑批工作流纪律注入件——纪律进每回合的 systemPrompt，不靠「调一次吐提示词」的工具。
 *
 * 病根回顾：纪律原来住在两件「调一次吐提示词」的装配工具输出里，不调那件工具就看不见它，
 * 于是批可以一路跳过方案证伪直接提交。这里把纪律文本放进注入块：它与记忆索引同一条通道，
 * 每回合在场、无需调用；改纪律只改数据文件（discipline.md），下一回合现读即生效，不发版重启。
 *
 * order=130：宿主权限类 context（110／115／120／125）先行作为行为红线，记忆索引在 200。
 * 130 落在「角色与派发」与「参考材料（记忆）」之间的空档。
 *
 * text 回调内任何异常都吞掉并返回空串——注入是增强不是依赖，绝不阻断请求。失败只 warnOnce
 * （状态不变不刷屏），代价是这一回合纪律缺席，而不是整包 DOA。
 */
import { join } from 'node:path'
import { TEMPLATES_PLACEHOLDER, loadDispatchData, resolveDataDir } from './data.js'

const CONTEXT_NAME = 'dispatch:discipline'
const ORDER = 130

/** 同一告警信息只报一次（状态不变不刷屏；状态迁移产生新信息自然再报）。 */
function makeWarnOnce(ctx) {
  const emitted = new Set()
  return (message) => {
    if (emitted.has(message)) return
    emitted.add(message)
    ctx.logger.warn(`[dispatch] ${message}`)
  }
}

export function registerDiscipline(ctx, { dispatchDataDir: configuredDir } = {}) {
  const dataDir = resolveDataDir(configuredDir)
  const warnOnce = makeWarnOnce(ctx)
  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: ORDER,
    // 每次请求现读：纪律文本与模板路径都不是注册期快照。data.js 同时做结构校验——
    // 纪律与阶段表脱节时这里失败，整块缺席而不是把半截纪律注进去
    text: () => {
      try {
        const { data } = loadDispatchData(dataDir)
        return data.discipline.replaceAll(TEMPLATES_PLACEHOLDER, join(dataDir, 'templates.md'))
      } catch (error) {
        warnOnce(`纪律注入失败，本回合跳过：${error?.message ?? error}`)
        return ''
      }
    },
  })
}
