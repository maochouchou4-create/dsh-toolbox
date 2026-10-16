/**
 * 会话活目录的取用收口：工具执行路径与注入路径上的 cwd 一律取会话 header.cwd，谁也不许
 * 自己认 process.cwd()——认了就把「这台机器的启动目录」当成了「这个会话的工作区」。
 *
 * 单独成模块而不是让每个工具族各写一行：这条口径跨工具族（memory 的层路由与 see_image 的
 * 相对路径解析都靠它），散在各处时改一次口径要同时想起几处，而漏一处的症状是「有的工具
 * 路由到旧目录、有的路由到新目录」——层路由与路径解析就此分家。
 *
 * 位置在 lib/ 根而不是 memory/ 下：两个工具族都要它，而 lib/memory/ 自述是 dsh-memory 的
 * 内缝，让另一个工具族去那儿取共享件就越了它声明的界。
 *
 * 入参只收 agent 而不收整个 ctx：整个 ctx 传进来，本模块就被绑成「非有 cordis 上下文不可
 * 单测」，而且将来在这里误加一句 ctx.<别的服务>不会有任何检查看见——收窄到 agent，依赖
 * 面就是参数面上写出来的那一个。
 */

/**
 * 会话活目录。
 *
 * 宿主 rc.2 没有独立的 workingDirectory 服务，也没有中途改目录的工具（会话目录不会在
 * 场次内变动），一场会话的目录从头到尾就是 header.cwd 这一个值；宿主自己的 fs 工具解析
 * 相对路径读的也是它（dsh-tool-fs 内部 sessionCwd 的实现）。本仓与宿主读同一处，故工具
 * 执行路径与注入路径合流到这一个函数——原先两条路径（服务的 ensure/get）分立是因为宿主
 * 那两条语义确实不同（一个含目录消失后的恢复、一个是同步纯读），如今同一个字段上没有
 * 这层区别，留着两条只会让「读的是不是同一处」重新变成要人判断的事。
 *
 * 无 agent 的调用（无会话上下文的脚本化/预览路径）返回 undefined，由下游按自己的默认解析
 * ——不传 cwd 与传一个猜的值，两者的差别由下游自己定。
 * 有 agent 而取不到 session/header，是宿主契约断裂（编程错误），当场抛而不是回落成
 * undefined：回落会让「层路由整体退到习惯层」「相对路径按启动目录解析」这类错误静默
 * 生效，症状出现在几层之外，最难查。
 */
export function resolveActiveCwd(agent) {
	if (agent === undefined) return undefined
	const { session } = agent
	if (session?.header === undefined) {
		throw new Error('agent 上取不到 session.header：活目录读 session.header.cwd，宿主契约断裂（编程错误，不是运行期分支）')
	}
	return session.header.cwd
}
