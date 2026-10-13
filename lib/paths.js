/**
 * 跨工具族的路径原语：目前只有 `~` 展开。
 *
 * 放 lib/ 根而不是 dsh-memory 的内缝：`~` 是文件系统的约定而不是记忆的约定，记忆根与
 * 附件存区两条来路都要它——而 lib/memory/ 的文件头自述职责是「dsh-memory 的纯函数核心」，
 * 让另一个工具族去那儿取共享件就越了模块自己声明的界（界一破，下一步往那儿加一行 IO 也
 * 只差一个决定）。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 展开路径开头的 `~/`。 */
export function expandHome(path) {
	if (typeof path !== 'string' || path.length === 0) return path
	if (path === '~') return homedir()
	if (path.startsWith('~/')) return join(homedir(), path.slice(2))
	return path
}
