/**
 * dsh-toolbox 的包级 fs 端口：把宿主 `ctx.fs` 与 `node:fs` 收敛成同一组方法，写入侧
 * 只认这个契约。本文件是「包内写入是否真走了宿主通道」的唯一入口——该边界之外不许
 * 出现任何后端写调用（消费方＝dispatch 台账与复盘的状态落盘、scripts/migrate-frontmatter.mjs
 * 的迁移写盘；读侧不入端口：宿主沙箱只围栏 writeText/editText，readText 本就不受策略约束；
 * see_image 直调 ctx.fs 是识图工具自己的事，不经本端口）。
 *
 * 本端口是 fs 服务的**旁路消费者**：它不派 `fs/write-intent` waterfall，也不发
 * `fs/observed`（宿主那两个走 fs 的工具层 dsh-tool-fs、dsh-tool-str-replace-editor
 * 每次写入前都派）。要进观察与意图管线，得自己接这两个事件。
 *
 * 生产/测试两用是它存在的理由：写入若直接摸 node:fs，宿主侧就绕过了会话文件策略
 * 与原子写——所以消费写入的模块在 test/imports.test.js 的判定表上登记为零直连
 * （登记处钉的是「哪个文件」不是「哪个函数名」，拆文件时不会跟着漂）；而纯函数单测
 * 需要一份同契约的替身。
 *
 * 可查前提：围栏后端按 workspaceRoot 拒绝越界写入，而记忆根在两机的配置里都是 agent-data
 * 仓、落在各自常用工作区之内，两者因此不冲突。前提一旦变（会话工作区不覆盖记忆根：换了
 * 工作区，或记忆根配到了别处），台账写盘会因路径在工作区外被拒，须 danger-full-access；
 * workspace-write 覆盖不到它。届时二选一：申请放行，或写盘退回 node:fs——不要让 dispatch
 * 在部分会话里变成只写失败而不自知。
 *
 * 契约（消费方不得解析 target，也不得假设它是本地路径）：
 *   resolve(path) → target
 *   stat(target, signal?) → { kind: 'present', version, type } | { kind: 'absent' }
 *   readText(target, signal?) → string
 *   writeText(target, content, intent?, signal?) → { operation, version }
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
 * 错误：**仅守卫类**错误（createIfAbsent / replaceIfVersion 失配）与非普通文件
 * 归一为宿主 FsErrorCode 词表——宿主抛什么码就抛同码，消费方的版本冲突分支与拦截
 * 语义才对得上同一套判据；构造那份带 code 的错误、判定「在不在且是不是文件」都在
 * fs-guard.js。缺失探针的 ENOENT/ENOTDIR 判 absent 后，readText 与其余后端原生错误
 * 一律原样透传、不做映射（统一文案是消费方的事，端口不加工后端事实），宿主侧全程直传。
 * 消费方因此只能按 `error.code` 断，不能用 `instanceof`：宿主通道抛的是宿主 FsError。
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
 * 文件版本标识：设备号＋inode＋大小＋纳秒级 mtime/ctime，与宿主 dsh-fs-local 的
 * versionOf 逐项同构——两个端口算出的版本要能对同一次改动给出一致的判断，否则
 * 「在测试端口验过守卫」不等于「宿主通道上守卫同样成立」。纳秒精度不可省：同长度
 * 覆写（如整条重写同尺寸条目）在毫秒精度下可能看不出变化，守卫就漏了。
 * 导出给单测：版本串是本文件最该被外部钉住的一段算法（散进各调用方各写一份就会漂移），
 * 生产消费方只经端口拿版本，不直接调它。
 */
export const versionOf = (stats) => `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`

/** 端口形状一次性校验：四个 I/O 方法缺一即编程错误（漏注入/替身写残）。 */
const PORT_METHODS = ['resolve', 'stat', 'readText', 'writeText']
function assertPortShape(port) {
	for (const method of PORT_METHODS) {
		if (typeof port[method] !== 'function') {
			throw new TypeError(`fs 端口缺方法 ${method}（生产传 createHostFsPort(ctx.fs, policy, agent)，测试传 createNodeFsPort()）`)
		}
	}
	return port
}

/**
 * 宿主 fs 的形状校验（方法齐不齐）：四个方法各带一句「缺了会在哪一步炸成什么」，因为
 * 读者要修的是不同的那一个，并成一张表遍历才不会让四段 typeof 各写一遍、各漏一个。
 *
 * 分两组的差别是排查方向：writeText 缺席即构造期报错，一眼看到端口建不起来；后三个
 * （resolve／stat／readText）包装函数照样建得起来，缺席要到第一个用点才炸——裸 TypeError
 * 既不是带 code 的 FsError 也不带契约口径，那才是最难查的一种失败，所以表里必须逐个
 * 写明它会在哪一步炸。
 *
 * 顺序有讲究：writeText 在场才谈得上「少几个形参」，故它排在最前、且它缺席即先报——
 * fs 服务压根没注入时，后面几条描述「首个用点才炸」的话会让人去查一个根本没在跑的调用。
 */
const HOST_FS_METHODS = [
	['writeText', '台账与迁移的写盘全走它，缺失时端口构造失败，不会静默放行成「写没生效」'],
	['resolve', '写盘的第一个动作就是它取 target（读回定位同理）；缺失时构造期不报，直到第一次写才抛裸 TypeError「hostFs.resolve is not a function」'],
	['stat', '批次事件的版本判定问它；缺失时构造期不报，直到第一次 stat 抛裸 TypeError「hostFs.stat is not a function」'],
	['readText', '复盘与批次事件读回问它；缺失时构造期不报，直到第一次读才抛裸 TypeError「hostFs.readText is not a function」'],
]
function assertHostShape(hostFs) {
	for (const [method, consequence] of HOST_FS_METHODS) {
		if (typeof hostFs?.[method] !== 'function') {
			throw new Error(`宿主 fs 契约版本不匹配：缺 ${method} 方法——${consequence}`)
		}
	}
}

/**
 * 形状之外的语义门：策略洞位还在不在。宿主两个后端本地版 writeText 4 个形参、沙箱版
 * 5 个，形参少一位就等于会话文件策略会被静默丢弃，越界写入将得逞——错了不报错的失败。
 *
 * 形参数只作「洞位整段不在」的粗判据，且只对「参数被删除」这个方向可靠：实参与形参在
 * JS 里不可区分，宿主若把 sandboxPolicy 挪到别的位置，.length 仍是 5，这里探测不到；
 * rest 绑定也会让 .length 少报。也不用实探做实——洞位只在 writeText 形参上，在 readText
 * 传策略恒被忽略，在 writeText 上探就得在构造期真写一次文件（比拒绝启动更难收拾）。
 * 「洞位在、位置被插错」这一类本仓没有能兜它的判据：package.json 的 engines.dsh 区间
 * 覆盖不了它——沙箱后端挂不挂由 profile 的 bundle 组合决定，与 dsh 版本无关，真发生
 * 只能靠宿主侧版本对齐人工确认
 */
function assertHostContract(hostFs) {
	assertHostShape(hostFs)
	if (hostFs.writeText.length < 5) {
		throw new Error(`该 fs 后端不带 sandboxPolicy 洞位，据此判定洞位整段不在：writeText 实到 ${hostFs.writeText.length} 个形参（应为 target/content/intent/signal/sandboxPolicy 五个），缺第 5 位则会话文件策略会被静默丢弃，越界写入将得逞——先确认这个 profile 挂了 dsh-fs-sandbox；已挂仍报＝宿主签名与本仓假定的不一致`)
	}
}

/** 同目录临时件名（与目标同 fs，rename 才原子）。不用 .md 后缀，免得被体检/引用扫描扫到。 */
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
 * node:fs 适配器（测试用，也是无宿主环境下的可用实现）：
 * 承担宿主通道由后端负责的那部分语义——守卫在写前核对、父目录补建、原子发布
 * （临时件 + 改名，对齐宿主 writeFileAtomic）。signal 只为接口同形：实现是同步的，
 * 一次调用内无让出点，中断只能在调用前后生效。
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
			// 「目标是普通文件」与版本守卫同属守卫类，两侧都得归一：宿主在探针后先报
			// FS_NOT_REGULAR_FILE，这里不拦就会放出原生 ENOTEMPTY/EISDIR——同一个端口
			// 两套错误面。顺序也照宿主：先判类型，再判守卫
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

/**
 * 宿主适配器：直传 ctx.fs，只做一处形状收敛（stat 的 absent 归一与 type 补齐），
 * 让消费方不必分支判断后端。signal 与 sandboxPolicy 都按各自的洞位原样透传——中断与
 * 策略都该由宿主后端裁决，端口不代劳。
 */
export function createHostFsPort({ fs: hostFs, policy, agent }) {
	assertHostContract(hostFs)
	// resolve 是同步的（dsh-sandbox-policy 的 resolve 直接返回策略对象，不 await）：
	// 哪天它改成 async，这里不加 await 就得到 Promise，Promise.mode 恒为 undefined。
	// 策略缺省（服务不在场或无会话上下文）＝不在端口二次否决，交由后端自己的默认解析
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
	})
}

/**
 * 只读门面：按白名单透出读方法，写方法在返回的对象上**根本不存在**。给「结构上不许写」的
 * 调用方用（如 dispatch_lessons 读台账）——它要的不只是运行期拒绝写，而是让写路径在类型与
 * 运行时都摸不到：「记得别写」是纪律，纪律会随改动静悄悄松掉，而复盘自动改配对表等于绕过
 * 主会话裁决。白名单是显式列举的：端口将来加方法时它默认不出现，要出现得有人在两处各改一次。
 */
export function createReadOnlyPort(port) {
	assertPortShape(port)
	const readOnly = {}
	for (const method of ['resolve', 'stat', 'readText']) {
		readOnly[method] = (...args) => port[method](...args)
	}
	return Object.freeze(readOnly)
}
