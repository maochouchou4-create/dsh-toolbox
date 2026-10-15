/**
 * dsh-toolbox 胶水层——唯一外部缝：name/inject/Config/apply 四件，宿主只见这张脸。
 *
 * 结构（深模块口径）：每个工具＝lib/ 下一个目录模块，接口缩到 register(ctx, config)
 * ＋configShape 两件；工具的复杂度全在模块内缝（纯函数文件＋自测直达）。
 * 胶水只做三件事：合成 Config、按表装配、逐工具隔离——一个工具激活失败
 * （如 schema 断链）只降级该工具并留全栈日志，不连坐整包（dsh-see-image
 * 首装 schema 错连坐整个插件的教训）。
 *
 * peerDependencies 只声明真 import 的包（dsh-tools/dsh-llm/schemastery）；
 * cordis/dsh-system-prompt 是经 inject 消费的宿主服务，不是 import 面，
 * 声明了只会凑永不满足的约束噪音。区间须显式盖住宿主实装的预发布线
 * （node-semver 预发布排除规则：比较子须与版本同 tuple 带预发布才放行）。
 */
import z from '@deepseek-ai/schemastery'
import { configShape as dispatchShape, registerDispatch, registerDispatchBatch } from './dispatch/index.js'
import { configShape as memoryShape, registerMemory } from './memory/index.js'
import { configShape as visionShape, registerSeeImage } from './see-image/index.js'

export const name = 'dsh-toolbox'
// inject 是全工具并集：fs 是 see_image、memory、dispatch_batch 共用的宿主正规通道（活目录解析＋
// 带帽读字节），llm/attachments 归视觉转述，systemPrompt 归记忆索引注入。会话活目录
// 不在这里——它取自会话本身（见 lib/working-dir.js），不是宿主服务。
export const inject = ['systemPrompt', 'tools', 'llm', 'attachments', 'fs']

export const Config = z.object({ ...dispatchShape, ...memoryShape, ...visionShape })

// 一行一个工具，装配器与其台账工具分两行：这两件的失败原因毫无关系，绑一行就是台账起不来
// 顺带把装配器也带走，而逐工具隔离正是本层存在的理由（同 see_image 首装 schema 错连坐整包）
const FEATURES = [
	['dispatch', registerDispatch],
	['dispatch_batch', registerDispatchBatch],
	['memory', registerMemory],
	['see_image', registerSeeImage],
]

export function apply(ctx, config = {}) {
	for (const [label, register] of FEATURES) {
		try {
			register(ctx, config)
		} catch (error) {
			ctx.logger.error(`[dsh-toolbox] ${label} 激活失败，已跳过（其余工具不受影响）：\n${error?.stack ?? error}`)
		}
	}
}
