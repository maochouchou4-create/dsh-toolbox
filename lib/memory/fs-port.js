/**
 * dsh-memory 的 fs 端口：把宿主 `ctx.fs` 与 `node:fs` 收敛成同一组方法，写入侧
 * 只认这个契约。本文件是「memory 写侧是否真走了宿主通道」的唯一入口——端口之外
 * 不许出现任何后端调用（此口径只管 memory 写侧：see_image 直调 ctx.fs 是识图工具
 * 自己的事，不经本端口）。
 *
 * 端口只服务写入（upsertEntry/editEntry，delete 借它问一句能不能写）。读侧
 * （composeMemory）与 lint 两族留在 node:fs：宿主沙箱只围栏 writeText/editText，
 * readText/listDir 本就不受策略约束，走端口只是白付 async 成本。
 *
 * 本端口是 fs 服务的**旁路消费者**：它不派 `fs/write-intent` waterfall，也不发
 * `fs/observed`（宿主那两个走 fs 的工具层 dsh-tool-fs、dsh-tool-str-replace-editor
 * 每次写入前都派）。要进观察与意图管线，得自己接这两个事件。
 *
 * 生产/测试两用是它存在的理由：write.js 直接摸 node:fs，宿主侧就绕过了会话文件
 * 策略与原子写；而写侧测试是零 ctx 纯函数单测，需要一份同契约的替身。
 *
 * 可查前提：围栏后端按 workspaceRoot 拒绝越界写入，而记忆文件按设计就住在工作目录
 * 之外（~/.dsh/memory），两者天生冲突。本机全部会话为 danger-full-access，围栏不生效，
 * 故现状成立。前提一旦变（出现 workspace-write 会话），记忆写入会因路径在工作目录外
 * 被拒，届时二选一：申请放行，或写侧退回 node:fs——不要让 memory 工具在部分会话里
 * 变成只读失败而不自知。
 *
 * 契约（消费方不得解析 target，也不得假设它是本地路径）：
 *   resolve(path) → target
 *   stat(target, signal?) → { kind: 'present', version, type } | { kind: 'absent' }
 *   readText(target, signal?) → string
 *   writeText(target, content, intent?, signal?) → { operation, version }
 *   assertWritable() → void（不可写即抛 FS_SANDBOX_DENIED；只问策略、不落盘）
 * intent 是写入守卫，缺省＝无条件覆写：{ kind: 'createIfAbsent' }（目标已存在即
 * 拒）｜{ kind: 'replaceIfVersion', version }（版本失配即拒）。
 *
 * 原子性口径：**只有 createIfAbsent 是 no-replace 硬保证**（宿主走独占创建、本端口
 * 走 O_EXCL，「查过没有」与「建出来」之间不存在窗口）。其余写入（含 replaceIfVersion）
 * 都是「探针 → 发布」窗口：守卫在发布前比对版本，比对与发布之间仍可能被别人改写，
 * 捕到即抛错、捕不到就当无事发生——同进程内不会发生（宿主后端按 targetKey 串行，
 * 本端口的同步实现无让出点），跨进程并发写不在保证内。其余写入两侧都经
 * 「临时文件 + 原子改名」发布，读者永远看不到半个文件。
 *
 * 错误：**仅守卫类**错误（createIfAbsent / replaceIfVersion 失配）与策略拒绝归一为
 * FsPortError＋宿主 FsErrorCode 词表——宿主抛什么码就抛同码，写侧的版本冲突分支与
 * 拦截语义才对得上同一套判据。缺失探针的 ENOENT/ENOTDIR 判 absent 后，readText 与
 * 其余后端原生错误一律原样透传、不做映射（统一文案是写侧的事，端口不加工后端
 * 事实），宿主侧全程直传。消费方因此只能按 `error.code` 断，不能用 `instanceof`：
 * 宿主通道抛的是宿主的 FsError，不是本文件这一类。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * 端口错误（code 取宿主 FsErrorCode 词表；宿主包在裸仓不可 import，故本地声明）。
 * 文件内私有、不导出：宿主适配器透传的是宿主 FsError，消费方按 error.code 断语，
 * 导出一个类只会诱使调用方拿它做 instanceof 判断——那在宿主通道上恒为 false。
 */
class FsPortError extends Error {
	constructor(message, code) {
		super(message)
		this.name = 'FsPortError'
		this.code = code
	}
}

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

/**
 * 文件版本标识：设备号＋inode＋大小＋纳秒级 mtime/ctime，与宿主 dsh-fs-local 的
 * versionOf 逐项同构——两个端口算出的版本要能对同一次改动给出一致的判断，否则
 * 「在测试端口验过守卫」不等于「宿主通道上守卫同样成立」。纳秒精度不可省：同长度
 * 覆写（如替换一条索引行）在毫秒精度下可能看不出变化，守卫就漏了。
 * 导出给 write.js 的 delete 路径：那里留在 node:fs，同款索引守卫要共用这一份算法，
 * 两处各写一份版本串就会各自漂移。
 */
export const versionOf = (stats) => `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`

/** 端口形状一次性校验：四个 I/O 方法＋一个问策略的，缺一即编程错误（漏注入/替身写残）。 */
const PORT_METHODS = ['resolve', 'stat', 'readText', 'writeText', 'assertWritable']
function assertPortShape(port) {
	for (const method of PORT_METHODS) {
		if (typeof port[method] !== 'function') {
			throw new TypeError(`fs 端口缺方法 ${method}（生产传 createHostFsPort(ctx.fs, policy, agent)，测试传 createNodeFsPort()）`)
		}
	}
	return port
}

/**
 * 端口形状之外的构造期 Fail Fast。信号是「会话文件策略会被静默丢弃」这种错了
 * 不报错的失败：宿主两个后端本地版 writeText 4 个形参、沙箱版 5 个，而实参数与
 * 形参数不可区分（**参数被删除探得到，被插入探不到**），后者只能靠 package.json
 * 的 engines.dsh 版本区间兜。故这里只钉住「策略洞位还在」。
 */
function assertHostContract(hostFs) {
	const arity = typeof hostFs?.writeText === 'function' ? hostFs.writeText.length : -1
	if (arity < 5) {
		throw new Error(`宿主 fs 契约版本不匹配：writeText 须为 (target, content, intent, signal, sandboxPolicy) 五个形参，收到 ${arity} 个——会话文件策略会被静默丢弃，越界写入将得逞`)
	}
}

/** 不可写时的统一拒绝：code 落在宿主词表内，harness 的 toolErrorResult 才拿得到。 */
function denyWrite() {
	throw new FsPortError('当前会话策略不允许写记忆（读侧与体检不受影响）——记忆文件按设计住在工作目录之外，需 danger-full-access；改成 workspace-write 仍会被判越界，因为围栏范围是会话 cwd', 'FS_SANDBOX_DENIED')
}

/** 同目录临时件名（与目标同 fs，rename 才原子）。不用 .md 后缀，免得被体检/引用扫描扫到。 */
let tempSeq = 0
const tempPathFor = (path) => join(dirname(path), `.${basename(path)}.${process.pid}.${tempSeq++}.tmp`)

/** 失败清理：删不掉就算了——残件是 .tmp，lint 与引用扫描都只认 .md，扫不到也无害。 */
function dropQuietly(path) {
	try {
		rmSync(path, { force: true })
	} catch {
		/* 残件无害，见上 */
	}
}

/**
 * node:fs 适配器（测试用，也是无宿主环境下的可用实现）：
 * 承担宿主通道由后端负责的那部分语义——守卫在写前核对、父目录补建、原子发布
 * （临时件 + 改名，对齐宿主 writeFileAtomic）。signal 只为接口同形：实现是同步的，
 * 一次调用内无让出点，中断只能在调用前后生效。
 */
export function createNodeFsPort({ sandboxPolicy } = {}) {
	return assertPortShape({
		resolve(path) {
			return Promise.resolve({ targetKey: path, displayPath: path })
		},
		async stat(target) {
			const stats = probe(target.targetKey)
			return stats === null
				? { kind: 'absent' }
				: presentOf(versionOf(stats), stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other')
		},
		async readText(target) {
			return readFileSync(target.targetKey, 'utf8')
		},
		async writeText(target, content, intent) {
			const path = target.targetKey
			const before = probe(path)
			// 「目标是普通文件」与版本守卫同属守卫类，两侧都得归一：宿主在探针后先报
			// FS_NOT_REGULAR_FILE，这里不拦就会放出原生 ENOTEMPTY/EISDIR——同一个端口
			// 两套错误面。顺序也照宿主：先判类型，再判守卫
			if (before !== null && !before.isFile()) {
				throw new FsPortError(`目标不是普通文件，拒绝写入：${path}`, 'FS_NOT_REGULAR_FILE')
			}
			if (intent?.kind === 'replaceIfVersion') {
				const current = before === null ? '不存在' : versionOf(before)
				if (current !== intent.version) {
					throw new FsPortError(`目标已被并发改动（期望版本 ${intent.version}，现为 ${current}）——请重试本操作：${path}`, 'FS_STALE_VERSION')
				}
			}
			mkdirSync(dirname(path), { recursive: true })
			// createIfAbsent 是全契约里唯一的 no-replace 硬保证：O_EXCL 让「查过没有」
			// 与「建出来」合成一步，故上面不必为它再探一次版本
			if (intent?.kind === 'createIfAbsent') {
				try {
					writeFileSync(path, content, { encoding: 'utf8', flag: 'wx' })
				} catch (error) {
					if (error?.code === 'EEXIST') throw new FsPortError(`目标已存在，拒绝「仅当不存在」创建：${path}`, 'FS_NOT_OBSERVED')
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
		// node 适配器背后没有宿主策略，服务不到时按不限处理；显式给了 policy 才照它否决，
		// 这样测试能用同一份替身验「只读拒写」这条与宿主同款的语义
		assertWritable() {
			if (sandboxPolicy?.mode === 'read-only') denyWrite()
		},
	})
}

/**
 * 宿主适配器：直传 ctx.fs，只做一处形状收敛（stat 的 absent 归一与 type 补齐），
 * 让写侧不必分支判断后端。signal 与 sandboxPolicy 都按各自的洞位原样透传——中断与
 * 策略都该由宿主后端裁决，端口不代劳。
 */
export function createHostFsPort({ fs: hostFs, policy, agent }) {
	assertHostContract(hostFs)
	// resolve 是同步的（dsh-sandbox-policy 的 resolve 直接返回策略对象，不 await）：
	// 哪天它改成 async，这里不加 await 就得到 Promise，Promise.mode 恒为 undefined
	// 且不等于 'read-only'，只读拒写会静默失效而没有任何报错
	const sandboxPolicy = policy?.resolve(agent === undefined ? {} : { session: agent.session })
	return assertPortShape({
		resolve: (path) => hostFs.resolve(path),
		async stat(target, signal) {
			const info = await hostFs.stat(target, signal)
			return info === undefined ? { kind: 'absent' } : presentOf(info.version, info.type)
		},
		async readText(target, signal) {
			return hostFs.readText(target, signal)
		},
		writeText: (target, content, intent, signal) => hostFs.writeText(target, content, intent, signal, sandboxPolicy),
		// 策略缺省（服务不在场或无会话上下文）＝不在端口二次否决，交由后端自己的默认解析
		assertWritable() {
			if (sandboxPolicy?.mode === 'read-only') denyWrite()
		},
	})
}
