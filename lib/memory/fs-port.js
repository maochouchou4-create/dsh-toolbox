/**
 * dsh-memory 的 fs 端口：把宿主 `ctx.fs` 与 `node:fs` 收敛成同一组方法，写入侧
 * 只认这个契约。本文件是「memory 写入侧（upsertEntry/editEntry）的 I/O 是否真走了宿主
 * 通道」的唯一入口——该边界之外不许出现任何后端调用。口径按写入侧划：delete 也是写侧
 * 动作，但它按设计必须直连 node:fs（宿主契约无删除原语）；读侧（composeMemory）与 lint
 * 两族同此（此口径也不管 see_image：它直调 ctx.fs 是识图工具自己的事，不经本端口）。
 *
 * 端口服务写入侧（upsertEntry/editEntry，delete 借它问一句能不能写）与其唯一的读需求
 * ——写侧同名检查取每条 title 时只读文件头。读侧（composeMemory）与 lint 两族仍留在
 * node:fs：宿主沙箱只围栏 writeText/editText，readText/listDir 本就不受策略约束，
 * 走端口只是白付 async 成本；同名检查不同，它必须与写入同一条 I/O 通道才不越边界。
 *
 * 本端口是 fs 服务的**旁路消费者**：它不派 `fs/write-intent` waterfall，也不发
 * `fs/observed`（宿主那两个走 fs 的工具层 dsh-tool-fs、dsh-tool-str-replace-editor
 * 每次写入前都派）。要进观察与意图管线，得自己接这两个事件。
 *
 * 生产/测试两用是它存在的理由：写侧若直接摸 node:fs，宿主侧就绕过了会话文件策略
 * 与原子写——所以承载 upsert/edit 的文件登记为零直连（登记处是 test/imports.test.js
 * 的判定表：钉的是「哪个文件」不是「哪个函数名」，拆文件时不会跟着漂），且写侧
 * write.js 的本地导入闭包整包零 node:fs（同一文件的闭包断言：逐文件表只管到本文件，
 * 共享件里加一行 import node:fs 照样绕过端口）；而写侧测试是零 ctx 纯函数单测，
 * 需要一份同契约的替身。
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
 *   readHead(target, maxBytes, signal?) → string（至多 maxBytes 字节按 UTF-8 解码）
 *   writeText(target, content, intent?, signal?) → { operation, version }
 *   listDir(target, signal?) → [{ name, type }]（直系子项、不读内容；目录不存在返回 []）
 *   assertWritable() → void（不可写即抛 FS_SANDBOX_DENIED；只问策略、不落盘）
 * readHead 文件比 maxBytes 短就返回全长，不截到围栏：截到围栏是带领域知识的早退，
 * 而 frontmatter 的围栏判据是 memory 侧的契约知识（frontmatter.js），端口只提供
 * 「按字节取一段」这一件与领域无关的事，取多少、够不够解析由消费方判。
 * 它的错误面只有三类，都与 readText 同源——文件缺失/不是普通文件（后端原生码原样透传）、
 * 字节不是合法 UTF-8（FS_NOT_TEXT）。末类不许静默降级成替换符：head 的下游是同名判定，
 * 变形后的 title 会让判定拿一个谁也没写过的串去比，而同一文件走 readText 当场就报非文本。
 * listDir 只给目录直系子项的名单与类型，不回传 target：消费方要读子项时自己 resolve，
 * 端口不为它发明 target 形状（宿主 FsDirEntry 带 target，那是宿主契约的细节）。
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
 * 错误：**仅守卫类**错误（createIfAbsent / replaceIfVersion 失配）、非普通文件与策略
 * 拒绝归一为宿主 FsErrorCode 词表——宿主抛什么码就抛同码，写侧的版本冲突分支与拦截
 * 语义才对得上同一套判据；构造那份带 code 的错误、判定「在不在且是不是文件」都在
 * fs-guard.js（写侧 edit/upsert 与直连 node:fs 的 delete 共用同一份，见该文件头）。
 * 缺失探针的 ENOENT/ENOTDIR 判 absent 后，readText 与其余后端原生错误一律原样透传、
 * 不做映射（统一文案是写侧的事，端口不加工后端事实），宿主侧全程直传。消费方因此
 * 只能按 `error.code` 断，不能用 `instanceof`：宿主通道抛的是宿主 FsError。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { assertRegularFile, codedFsError, typeOfStats } from './fs-guard.js'
import { decodeHeadBytes, readFileHead } from './head-read.js'

/** 缺失探针：ENOENT/ENOTDIR 一律判 absent（与 existsSync 同口径，父段非目录也不算在场）。 */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR'])

/** 宿主词表里的「不存在」：宿主后端列目录时对缺失目录抛它，不是 node 的 ENOENT。 */
const HOST_ABSENT_CODE = 'FS_NOT_FOUND'

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

/** 端口形状一次性校验：六个 I/O 方法＋一个问策略的，缺一即编程错误（漏注入/替身写残）。 */
const PORT_METHODS = ['resolve', 'stat', 'readText', 'readHead', 'writeText', 'listDir', 'assertWritable']
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
	// listDir 缺失/改名同样要炸在构造期：它只被层内同名条目拦截用到，一旦被滤空，
	// 拦截退化成 no-op（谁也不知道重名条目没拦住），等真写重了才从症状反推
	if (typeof hostFs?.listDir !== 'function') {
		throw new Error('宿主 fs 契约版本不匹配：缺 listDir 方法——层内同名条目拦截依赖它，缺失时拦截静默失效')
	}
	// readByteRange 缺失同样要炸在构造期：它撑着同名检查的「只读文件头」，而同名检查是
	// 写侧唯一一处读——端口构造即失败，memory 写入全不可用（不是「慢一点」而是「不写」）
	if (typeof hostFs?.readByteRange !== 'function') {
		throw new Error('宿主 fs 契约版本不匹配：缺 readByteRange 方法——同名检查的只读文件头依赖它，缺失时整个写侧端口构造失败，memory 写入不可用')
	}
}

/** 不可写时的统一拒绝：code 落在宿主词表内，harness 的 toolErrorResult 才拿得到。 */
function denyWrite() {
	throw codedFsError('当前会话策略不允许写记忆（读侧与体检不受影响）——记忆文件按设计住在工作目录之外，需 danger-full-access；改成 workspace-write 仍会被判越界，因为围栏范围是会话 cwd', 'FS_SANDBOX_DENIED')
}

/** 同目录临时件名（与目标同 fs，rename 才原子）。不用 .md 后缀，免得被体检/引用扫描扫到。 */
let tempSeq = 0
const tempPathFor = (path) => join(dirname(path), `.${basename(path)}.${process.pid}.${tempSeq++}.tmp`)

/**
 * 失败清理：删不掉就算了——残件是 .tmp，lint 与引用扫描都只认 .md，扫不到也无害。
 */
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
				: observedOf(stats)
		},
		async readText(target) {
			return readFileSync(target.targetKey, 'utf8')
		},
		// 头读机制在 head-read.js，与读侧共用一份；端口这一侧不给早退判据（契约明写不截围栏），
		// 只把「按字节取一段」这件事转过去。decode 那步也在那边，因为它要跨块处理半个多字节字符
		async readHead(target, maxBytes) {
			return readFileHead(target.targetKey, maxBytes)
		},
		// 目录不存在按「无子项」归一，与 stat 的 ENOENT→absent 同一口径：新桶首写是常态，
		// 不该让列目录先炸一次
		async listDir(target) {
			try {
				return readdirSync(target.targetKey, { withFileTypes: true }).map((entry) => ({
					name: entry.name,
					type: typeOfStats(entry),
				}))
			} catch (error) {
				if (ABSENT_CODES.has(error?.code)) return []
				throw error
			}
		},
		async writeText(target, content, intent) {
			const path = target.targetKey
			const before = probe(path)
			// 「目标是普通文件」与版本守卫同属守卫类，两侧都得归一：宿主在探针后先报
			// FS_NOT_REGULAR_FILE，这里不拦就会放出原生 ENOTEMPTY/EISDIR——同一个端口
			// 两套错误面。顺序也照宿主：先判类型，再判守卫；判定与写侧共用一份
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
		// 走字节窗口而不是 readBytes：后者是「文件超上限即抛 FS_TOO_LARGE」，与头读要的
		// 「取前若干字节、文件更短就取满」正好相反。窗口越界宿主返回空（不按文件大小报错），
		// 短文件读不满 maxBytes 正是这里要的语义。解码与 node 适配器共用一份机制与判据：
		// 两边各解一次，非法 UTF-8 的反应就会分叉（一边变形、一边报非文本）
		async readHead(target, maxBytes, signal) {
			const bytes = await hostFs.readByteRange(target, { offset: 0, length: maxBytes }, signal)
			return decodeHeadBytes(bytes, target.displayPath)
		},
		// 宿主 FsDirEntry 带 target/version/size，端口只透出消费方要用的 name+type：
		// 读子项由消费方自己 resolve，端口不替它决定 target 从哪来
		async listDir(target, signal) {
			try {
				const entries = await hostFs.listDir(target, signal)
				return entries.map((entry) => ({ name: entry.name, type: entry.type }))
			} catch (error) {
				// 缺失归一为「无子项」，与 node 适配器同口径：宿主本地后端对不存在的目录抛
				// FS_NOT_FOUND，不归一的话契约里写着的「返回 []」在宿主通道上就是个谎，
				// 下一个照契约写的消费方会拿到一个契约外的错误码
				if (ABSENT_CODES.has(error?.code) || error?.code === HOST_ABSENT_CODE) return []
				throw error
			}
		},
		writeText: (target, content, intent, signal) => hostFs.writeText(target, content, intent, signal, sandboxPolicy),
		// 策略缺省（服务不在场或无会话上下文）＝不在端口二次否决，交由后端自己的默认解析
		assertWritable() {
			if (sandboxPolicy?.mode === 'read-only') denyWrite()
		},
	})
}
