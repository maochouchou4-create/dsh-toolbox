/**
 * dsh-toolbox 胶水层——唯一外部缝：name/inject/Config/apply 四件，宿主只见这张脸。
 *
 * 结构（深模块口径）：每个工具＝lib/ 下一个目录模块，接口缩到 register(ctx, config)
 * ＋configShape 两件（无配置项的模块不导出 configShape；装配面仍统一按 register(ctx, config)
 * 调，那类模块忽略 config 形参——统一调用形状换来逐工具一行的装配表）；
 * 工具的复杂度全在模块内缝（纯函数文件＋自测直达）。
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
import {
	configShape as dispatchShape,
	registerDispatchBatch,
	registerDispatchChallenge,
	registerDispatchLessons,
	registerDispatchTask,
} from './dispatch/index.js'
import { configShape as memoryShape, registerMemory } from './memory/index.js'
import { configShape as visionShape, registerSeeImage } from './see-image/index.js'
import { registerUsageNote } from './usage-log/note.js'
import { subscribeUsageLog } from './usage-log/recorder.js'

export const name = 'dsh-toolbox'
// inject 是全工具并集：fs 是 see_image、dispatch_batch 与 dispatch_lessons 共用的宿主正规通道
// （活目录解析＋带帽读字节＋台账写盘），llm/attachments 归视觉转述，systemPrompt 归记忆索引注入。
// 会话活目录不在这里——它取自会话本身（见 lib/working-dir.js），不是宿主服务。
export const inject = ['systemPrompt', 'tools', 'llm', 'attachments', 'fs']

export const Config = z.object({ ...dispatchShape, ...memoryShape, ...visionShape })

// 一行一个工具，装配两件与台账、复盘各占一行：这几件的失败原因毫无关系，绑一行就是台账
// 起不来顺带把装配器也带走，而逐工具隔离正是本层存在的理由（同 see_image 首装 schema 错连坐整包）
const FEATURES = [
	['dispatch_task', registerDispatchTask],
	['dispatch_challenge', registerDispatchChallenge],
	['dispatch_batch', registerDispatchBatch],
	['dispatch_lessons', registerDispatchLessons],
	['see_image', registerSeeImage],
	['usage_note', registerUsageNote],
]

export function apply(ctx, config = {}) {
	// 使用日志的白名单＝FEATURES 的 label 列现读（唯一单源，不手抄六件名）；订阅自吞失败，
	// 不连坐任何一件工具的注册。根与机器名在订阅期定格（config 是注册期终值）
	subscribeUsageLog(ctx, FEATURES.map(([label]) => label), { memoryRoot: config.memoryRoot, machine: config.machine })
	// 记忆索引注入独立于 FEATURES 装配：它不是工具（无可调用面，不进使用日志白名单），写侧
	// 退役后它只剩 systemPrompt 注入这一件事，走 FEATURES 表反而让 label 列多出一个永不
	// 出现在日志里的死名单。同款逐件隔离照旧：注入起不来只降级记忆块，工具面不受影响
	try {
		registerMemory(ctx, config)
	} catch (error) {
		ctx.logger.error(`[dsh-toolbox] memory 注入激活失败，已跳过（其余工具不受影响）：\n${error?.stack ?? error}`)
	}
	for (const [label, register] of FEATURES) {
		try {
			register(ctx, config)
		} catch (error) {
			ctx.logger.error(`[dsh-toolbox] ${label} 激活失败，已跳过（其余工具不受影响）：\n${error?.stack ?? error}`)
		}
	}
}
