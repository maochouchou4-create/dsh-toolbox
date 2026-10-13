/**
 * 会话活目录的取用收口：工具执行路径上的 cwd 一律问 workingDirectory 服务，不认
 * header.cwd（会话启动快照，working_directory(cd) 后不回写）。
 *
 * 单独成模块而不是让每个工具族各写一行：这条口径跨工具族（memory 的层路由与 see_image 的
 * 相对路径解析都靠它），散在各处时改一次口径要同时想起几处，而漏一处的症状是「有的工具
 * 路由到旧目录、有的路由到新目录」——层路由与路径解析就此分家。
 *
 * 位置在 lib/ 根而不是 memory/ 下：两个工具族都要它，而 lib/memory/ 自述是 dsh-memory 的
 * 内缝，让另一个工具族去那儿取共享件就越了它声明的界。
 */

/**
 * 执行路径上的会话活目录。无 agent 的调用（无会话上下文的脚本化/预览路径）返回 undefined，
 * 由下游按自己的默认解析——不传 cwd 与传一个猜的值，两者的差别由下游自己定。
 *
 * 这里只收 ensure 这一种，注入侧的 get 不走本函数，且**不许**把它们统一：两者语义不同，
 * 统一就改了行为。
 * - `ensure(agent, signal)`：async，含目录消失后的恢复（目录被删时自建），与 dsh-tool-fs
 *   同款；工具执行用它，代价是一次 IO。
 * - `get(session)`：同步、纯读、无 IO，取服务已提交的那份目录。注入侧在同步的 text 回调
 *   里跑（把它改成 await，注入块会整个静默消失），且 working-directory 服务自己的 assemble
 *   钩子已先 ensure 过，此处不需要恢复语义。
 * 工具侧与注入侧因此路由到同一个桶，但走的是两条路径——这个巧合靠的是同一个服务，
 * 不是同一个函数。
 */
export async function resolveActiveCwd(ctx, exec) {
	if (exec.agent === undefined) return undefined
	return ctx.workingDirectory.ensure(exec.agent, exec.signal)
}
