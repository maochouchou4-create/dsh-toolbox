/**
 * node:fs 头读：按字节取文件开头的一段，至多 maxBytes 字节，至 EOF 为止。
 *
 * 为什么单独立模块而不是各处内联：读侧（assemble.js 的注入扫描）与写侧同名检查
 * （fs-port.js 的 node 适配器）要的是同一段机制——开句柄、分块读、累积、末尾解码、
 * 关句柄——而它曾有两份拷贝，连分块块大小都分家（一边 2KB、一边 8KB）。两份拷贝漂起来
 * 时的症状是「某些条目读不到头、某些读到」这种没法定位的偶发形态。
 *
 * isComplete(text) 是「读到这儿够了没有」的回调，由调用方给：读侧给的是围栏闭合判据，
 * 端口那一侧不给——端口契约明写「不截到围栏」，带领域知识的早退不进端口。这里的分块
 * 只决定 I/O 粒度与何时问一次 isComplete，不决定读到哪。
 *
 * 直连 node:fs 是读侧（以及它的替身）的既定取舍：宿主沙箱只围栏写入，读不受策略约束。
 * 判定表与理由见 test/imports.test.js。
 */
import { closeSync, openSync, readSync } from 'node:fs'
import { codedFsError } from './fs-guard.js'

/** 分块 I/O 粒度：定成首次探测块的大小，好让最常见的那次头读一趟读完（它只管粒度，不管读到哪）。 */
const HEAD_CHUNK_BYTES = 2048

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/**
 * 末尾不完整的那个多字节序列要剪掉几字节：从末尾往回最多扫 4 字节，认出最后一个引导
 * 字节（它前面挨着的都是它的后继字节），它声明的序列长度若超出窗口内实际有的那几个字节，
 * 就是「被 maxBytes 切在字符中间」，整段剪掉。
 *
 * 这不是可选的容错而是常态：窗口以块为界，块边界落进中文三字节字符中间的概率约 3/4，
 * 于是几乎每次头读都要处理一次半个字。剪的是窗口边而不是文件里真的坏字节——判据只看
 * 「最后一个引导字节够不够长」，文件内的非法字节不在其列，照样由 fatal 解码报错。
 */
function trailingPartialLength(bytes) {
	const end = bytes.length
	for (let back = 1; back <= 4 && back <= end; back += 1) {
		const byte = bytes[end - back]
		if ((byte & 0b1100_0000) === 0b1000_0000) continue
		// 扫到的第一个非后继字节即引导字节（0xC0 起）或 ASCII；带引导位却小于 0xC0 的
		// 是孤立后继字节，那不是截断——剪掉它等于把文件里的坏字节藏起来
		if ((byte & 0b1000_0000) === 0) return 0
		const declared = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 0
		if (declared === 0) return 0
		// 窗口内已有 back 字节（引导字节加 back−1 个后继），声明得比它长就是尾巴被切了
		return declared > back ? back : 0
	}
	// 末尾连着四个后继字节：不是截断形态，交给解码器报非法字节
	return 0
}

/**
 * 只读文件头并解码成字符串。缺失与非普通文件原样透传（与端口其余方法的错误面一致）；
 * 非法 UTF-8 抛带宿主词表 code 的错——宿主把 readBytes/readByteRange 定为原始字节原语、
 * FS_NOT_TEXT 留给文本读，而 Buffer.toString('utf8') 对非法字节静默产出 U+FFFD：那会让
 * 含非法 UTF-8 的条目 title 变形，同名判定拿变形串去比，而同一文件走 readText 会当场报非文本。
 */
export function readFileHead(path, maxBytes, isComplete) {
	const handle = openSync(path, 'r')
	try {
		const chunks = []
		const buffer = Buffer.allocUnsafe(Math.max(Math.min(HEAD_CHUNK_BYTES, maxBytes), 1))
		let total = 0
		while (total < maxBytes) {
			const read = readSync(handle, buffer, 0, Math.min(buffer.length, maxBytes - total), total)
			if (read === 0) break
			chunks.push(Buffer.from(buffer.subarray(0, read)))
			total += read
			if (isComplete !== undefined && isComplete(decodeHeadBytes(Buffer.concat(chunks), path))) break
		}
		return decodeHeadBytes(Buffer.concat(chunks), path)
	} finally {
		closeSync(handle)
	}
}

/**
 * 解码一份字节：末尾被窗口截断的半个字符剪掉后再解，文件里真的非法字节照抛。
 * 导出给端口的宿主适配器——那边拿到的是字节窗口而非文件句柄，机制共用、解码的判据也得共用。
 */
export function decodeHeadBytes(bytes, path) {
	const partial = trailingPartialLength(bytes)
	try {
		return UTF8.decode(bytes.subarray(0, bytes.length - partial))
	} catch (error) {
		// code 落在宿主词表内：harness 的 toolErrorResult 与模型才拿得到类型，
		// 而纯 message 只能让人看见「不是文本」，看不出是哪个文件。带 code 的错误
		// 统一由 fs-guard.js 那一份工厂造，别处再造一次就成了另一种错误方言
		throw codedFsError(`文件不是合法的 UTF-8 文本：${path}（${error.message}）`, 'FS_NOT_TEXT')
	}
}
