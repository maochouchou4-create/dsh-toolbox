/**
 * dsh-toolbox 的包级 fs 端口（node:fs 实现）：写入侧只认这组方法，原子发布、守卫与错误码
 * 归一都收在这里。消费方＝scripts/migrate-frontmatter.mjs 的迁移写盘；读侧不入端口（宿主
 * 沙箱只围栏写入，readText 本就不受策略约束；see_image 直调 ctx.fs 是识图工具自己的事，
 * 不经本端口）。测试需要一份同契约的替身也用它。
 *
 * 生产/测试两用是它存在的理由：写入若直接摸 node:fs，原子写与守卫就散成各处各写一遍——
 * 消费写入的模块在 test/imports.test.js 的判定表上登记为零直连（登记处钉的是「哪个文件」
 * 不是「哪个函数名」，拆文件时不会跟着漂）；而纯函数单测需要一份同契约的替身。
 *
 * 契约（消费方不得解析 target，也不得假设它是本地路径）：
 *   resolve(path) → target
 *   stat(target, signal?) → { kind: 'present', version, type } | { kind: 'absent' }
 *   readText(target, signal?) → string
 *   writeText(target, content, intent?, signal?) → { operation, version }
 * intent 是写入守卫，缺省＝无条件覆写：{ kind: 'createIfAbsent' }（目标已存在即
 * 拒）｜{ kind: 'replaceIfVersion', version }（版本失配即拒）。
 *
 * 原子性口径：**只有 createIfAbsent 是 no-replace 硬保证**（走 O_EXCL，「查过没有」与
 * 「建出来」之间不存在窗口）。其余写入（含 replaceIfVersion）都是「探针 → 发布」窗口：
 * 守卫在发布前比对版本，比对与发布之间仍可能被别人改写，捕到即抛错、捕不到就当无事发生——
 * 同进程内不会发生（本端口的同步实现无让出点），跨进程并发写不在保证内。其余写入都经
 * 「临时文件 + 原子改名」发布，读者永远看不到半个文件。
 *
 * 错误：**仅守卫类**错误（createIfAbsent / replaceIfVersion 失配）与非普通文件
 * 归一为宿主 FsErrorCode 词表——消费方的版本冲突分支与拦截语义才对得上同一套判据；
 * 构造那份带 code 的错误、判定「在不在且是不是文件」都在 fs-guard.js。缺失探针的
 * ENOENT/ENOTDIR 判 absent 后，readText 与其余后端原生错误一律原样透传、不做映射（统一
 * 文案是消费方的事，端口不加工后端事实）。消费方因此只能按 `error.code` 断，不能用
 * `instanceof`。
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertRegularFile, codedFsError, typeOfStats } from './fs-guard.js'

/** 缺失探针：ENOENT/ENOTDIR 一律判 absent（与 existsSync 同口径，父段非目录也不算在场）。 */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR'])

function probe(path) {
	try {
		return statSync(path, { bigint: true })
	} catch (error) {
		if (ABSENT_CODES.has(error?.code)) return null
		throw error
	}
}

/** stat 的归一：宿主 FsInfo 带 type（file/directory/other），缺后端按 file 对待。 */
const presentOf = (version, type) => ({ kind: 'present', version, type: type ?? 'file' })

/** node Stats 的观察形状：与 stat 共用同一份类型词表，别处在别处各判一次就会漂。 */
const observedOf = (stats) => presentOf(versionOf(stats), typeOfStats(stats))

/**
 * 文件版本标识：设备号＋inode＋大小＋纳秒级 mtime/ctime（与宿主 dsh-fs-local 的
 * versionOf 逐项同构，版本串的语义与宿主那份保持一致）。纳秒精度不可省：同长度覆写
 * （如整条重写同尺寸条目）在毫秒精度下可能看不出变化，守卫就漏了。
 * 导出给单测：版本串是本文件最该被外部钉住的一段算法（散进各调用方各写一份就会漂移），
 * 生产消费方只经端口拿版本，不直接调它。
 */
export const versionOf = (stats) => `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`

/** 端口形状一次性校验：四个 I/O 方法缺一即编程错误（漏注入/替身写残）。 */
const PORT_METHODS = ['resolve', 'stat', 'readText', 'writeText']
function assertPortShape(port) {
	for (const method of PORT_METHODS) {
		if (typeof port[method] !== 'function') {
			throw new TypeError(`fs 端口缺方法 ${method}（createNodeFsPort() 构造的端口应齐四个 I/O 方法）`)
		}
	}
	return port
}

/** 同目录临时件名（与目标同 fs，rename 才原子）。不用 .md 后缀，免得被离线自检/引用扫描扫到。 */
let tempSeq = 0
const tempPathFor = (path) => join(dirname(path), `.${basename(path)}.${process.pid}.${tempSeq++}.tmp`)

/**
 * 失败清理：删不掉就算了——残件是 .tmp，扫描只认 .md，扫不到也无害。
 * 用 unlinkSync 而非 rmSync：Node v24.13.0 在 Windows 上，被删路径的**末段（basename）非
 * ASCII** 会让整个进程以 0xC0000409 死掉（父目录非 ASCII 无害；unlinkSync 与不带 recursive 的
 * rmdirSync 都不受影响）。这里删的临时件末段是 `<文件名>.<pid>.<seq>.tmp`，文件名可以是中文。
 */
function dropQuietly(path) {
	try {
		unlinkSync(path)
	} catch {
		/* 残件无害，见上；文件本就不在也走这里，与原 force 同义 */
	}
}

/**
 * node:fs 适配器：迁移脚本的生产写盘与单测替身共用这一份实现——守卫在写前核对、父目录
 * 补建、原子发布（临时件 + 改名，对齐宿主 writeFileAtomic）。signal 只为接口同形：
 * 实现是同步的，一次调用内无让出点，中断只能在调用前后生效。
 */
export function createNodeFsPort() {
	return assertPortShape({
		resolve(path) {
			return Promise.resolve({ targetKey: path, displayPath: path })
		},
		async stat(target) {
			const stats = probe(target.targetKey)
			return stats === null
				? { kind: 'absent' }
				: observedOf(stats)
		},
		async readText(target) {
			return readFileSync(target.targetKey, 'utf8')
		},
		async writeText(target, content, intent) {
			const path = target.targetKey
			const before = probe(path)
			// 「目标是普通文件」与版本守卫同属守卫类，两侧都得归一：错误码沿用宿主词表，
			// 不拦就会放出原生 ENOTEMPTY/EISDIR——同一个契约两种错误面。顺序与宿主实现
			// 一致：先判类型，再判守卫
			assertRegularFile(before === null ? { kind: 'absent' } : observedOf(before), path)
			if (intent?.kind === 'replaceIfVersion') {
				const current = before === null ? '不存在' : versionOf(before)
				if (current !== intent.version) {
					throw codedFsError(`目标已被并发改动（期望版本 ${intent.version}，现为 ${current}）——请重试本操作：${path}`, 'FS_STALE_VERSION')
				}
			}
			mkdirSync(dirname(path), { recursive: true })
			// createIfAbsent 是全契约里唯一的 no-replace 硬保证：O_EXCL 让「查过没有」
			// 与「建出来」合成一步，故上面不必为它再探一次版本
			if (intent?.kind === 'createIfAbsent') {
				try {
					writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' })
				} catch (error) {
					if (error?.code === 'EEXIST') throw codedFsError(`目标已存在，拒绝「仅当不存在」创建：${path}`, 'FS_NOT_OBSERVED')
					throw error
				}
				return { operation: 'create', version: versionOf(probe(path)) }
			}
			const temp = tempPathFor(path)
			try {
				writeFileSync(temp, content, 'utf8')
				renameSync(temp, path)
			} catch (error) {
				dropQuietly(temp)
				throw error
			}
			return { operation: before === null ? 'create' : 'update', version: versionOf(probe(path)) }
		},
	})
}
