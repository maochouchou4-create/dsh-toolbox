/**
 * dsh-toolbox 胶水层——唯一外部缝：name/inject/Config/apply 四件，宿主只见这张脸。
 *
 * 结构（深模块口径）：功能＝lib/ 下一个目录模块，接口缩到 register(ctx, config)
 * ＋configShape 两件；功能的复杂度全在模块内缝（纯函数文件＋自测直达）。
 * 胶水只做三件事：合成 Config、装配注入、隔离失败——注入起不来只降级记忆块
 * 并留全栈日志，不把整包拖进 DOA（dsh-see-image 首装 schema 错连坐整个
 * 插件的教训）。
 *
 * peerDependencies 只声明真 import 的包（schemastery）；cordis 是经 inject 消费的
 * 宿主服务，不是 import 面，声明了只会凑永不满足的约束噪音。区间须显式盖住
 * 宿主实装的预发布线（node-semver 预发布排除规则：比较子须与版本同 tuple
 * 带预发布才放行）。
 */
import z from '@deepseek-ai/schemastery'
import { configShape as memoryShape, registerMemory } from './memory/index.js'

export const name = 'dsh-toolbox'
// inject＝记忆索引注入这一件事的消费面：systemPrompt。
export const inject = ['systemPrompt']

export const Config = z.object({ ...memoryShape })

export function apply(ctx, config = {}) {
	// 记忆索引注入是本包唯一功能面；起不来只降级记忆块并留全栈日志——
	// 会话照常，症状＝无记忆块，而不是整包 DOA
	try {
		registerMemory(ctx, config)
	} catch (error) {
		ctx.logger.error(`[dsh-toolbox] memory 注入激活失败，已跳过：\n${error?.stack ?? error}`)
	}
}
