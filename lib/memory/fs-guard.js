/**
 * 文件系统守卫：写入侧共用的两份判据——「在场的东西是不是普通文件」与「这类失败带什么
 * code」。两处各写一份时，同一个故障在两条路径上的错误面就会分叉（一条带 code、name 又
 * 与另一条不同），调用方按 `error.code` 断都得先猜走的是哪条路径。
 *
 * 单独成模块而不是并进 fs-port.js：端口直连 node:fs，而 write.js 的本地导入闭包必须零
 * 直连（test/imports.test.js 的闭包断言钉住那条硬边界）——write.js 一 import fs-port.js
 * 就等于把 node:fs 拖进那条闭包，写侧「I/O 只经 fs 端口」当场失效。本文件是纯判据、
 * 一行 I/O 都不做，故放在谁都能 import 的这一层：端口适配器、edit、upsert、delete 四条
 * 路径共用同一份。
 *
 * 只导工厂不导类：宿主通道抛的是宿主 FsError，消费方拿 instanceof 判断恒为 false，
 * 导出一个类只会诱使调用方这么写。消费方一律按 `error.code` 断。
 */

/**
 * 带 code 的写入侧 fs 错误（code 取宿主 FsErrorCode 词表；宿主包在裸仓不可 import，
 * 故本地声明）。name 固定 FsPortError：它是错误族的标识，直连 node:fs 的 delete 路径
 * 也用它，于是同一个 code 在各条路径上的 name 与 code 完全一致。
 */
export function codedFsError(message, code) {
	return Object.assign(new Error(message), { name: 'FsPortError', code })
}

/** stat 结果的类型归一：宿主 FsInfo 自带 type，node Stats 要自己判，两边对上同一个词表。 */
export const typeOfStats = (stats) => (stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other')

/**
 * 「在」不等于「是文件」：同名目录撞上条目名时，不许它一路走到某次读写才炸成后端原生的
 * 英文错误（宿主口径 FS_NOT_REGULAR_FILE）。只看端口 stat 归一出的观察形状，不碰路径，
 * 故端口适配器与写侧四条路径能共用这一份判定。
 */
export function assertRegularFile(observed, path) {
	if (observed.kind === 'present' && observed.type !== 'file') {
		throw codedFsError(`路径不是普通文件（${observed.type}）：${path}——记忆条目只能是文件`, 'FS_NOT_REGULAR_FILE')
	}
}
