/**
 * 错误码词表与错误族标识：读侧探针（assemble 的 read-error 面）用它造带 code 的错误。
 * 只导工厂不导类：宿主通道抛的是宿主 FsError，消费方拿 instanceof 判断恒为 false，
 * 导出一个类只会诱使调用方这么写。消费方一律按 `error.code` 断。
 */

/**
 * 带 code 的 fs 错误（code 取宿主 FsErrorCode 词表；宿主包在裸仓不可 import，故本地声明）。
 * name 固定 FsPortError：历史名——写侧端口（fs-port.js）已退役，名字沿用为错误族的标识，
 * 同一个 code 在读侧各路径上的 name 与 code 保持一致。
 */
export function codedFsError(message, code) {
	return Object.assign(new Error(message), { name: 'FsPortError', code })
}
