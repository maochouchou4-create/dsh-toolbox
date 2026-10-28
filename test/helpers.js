/**
 * 测试夹具的共用件：条目正文模板、临时根、记忆树、现读数据目录。
 *
 * 收口理由分三层，每层都对着一种「两边各自都对、于是没人发现」的分家：
 *
 * ①条目正文模板（frontmatter 两键加正文）此前多个测试文件各写一份逐字相同的它（写侧退役后
 *   现消费方＝memory-core／memory-check-script）。frontmatter 是契约且在收紧（恰好两键），模板一分
 *   家就有某个文件里的夹具按旧形态造条目——症状不是那条用例红，而是它造的条目压根进不了索引，
 *   于是「这条用例到底在验什么」变得不可读。
 *
 * ②临时根此前是 14 处 mkdtempSync 直调加 5 处「join(tmpdir(), 名字-${pid}) 加 mkdirSync」两套
 *   写法散在 13 个文件里。两套并存让「临时根怎么造」在仓内有两个答案：某个文件改一种、忘了另一
 *   种时没有任何东西会拦，而泄漏的症状（某个用例读到了上一轮的残留）指向的是别处。收口之后清理由
 *   node:test 的 t.after 统一登记（t 是这里唯一的参数层，不进用例正文）。一处刻意留在原样：
 *   memory-core 的「~ 展开」用例把目录造在 homedir 之下——它要验的正是根被展开到 homedir，
 *   挪进临时根就验不到那一层了。
 *
 * ③记忆树（store 顶层共享段加可选机器私有段）与现读数据目录（拷一份真数据再改坏）此前各有三四个文件
 *   各写一遍，目录名各拼各的——测试盘上摆了什么，读用例的人得逐个文件自己认。现读面那份文件名
 *   清单也从生产侧（data.js 的 DATA_FILES）现读，不在本模块手抄。
 *
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_FILES } from '../lib/dispatch/data.js'

export const entry = (title, description, body = '正文') => `---\ntitle: ${title}\ndescription: ${description}\n---\n\n${body}\n`

/* ---------- 路径常量（此前六个文件各拼一遍 join(dirname(import.meta.url), '..', …)） ---------- */

/** 仓根：下面几个常量都由它派生，而它自己没人直接用——导出就等于给「派生值另有消费者」留一个口子。 */
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
export const LIB_DIR = join(ROOT_DIR, 'lib')
const DISPATCH_DIR = join(LIB_DIR, 'dispatch')
export const DISPATCH_DATA_DIR = join(DISPATCH_DIR, 'data')
export const SCRIPTS_DIR = join(ROOT_DIR, 'scripts')

/* ---------- 本包登记的工具名（接线自查的那份名单） ---------- */

/**
 * 本包登记的工具名，逐字同 lib/index.js 的 FEATURES 表 label 列（顺序也同）。
 *
 * 名单本身是 FEATURES 表的投影（imports.test 对着源码钉 label 列）：在这里另手抄一份独立数组，
 * 就等于给「本包有哪些工具」留了第二个真相源——加一件工具时它静默漏一项，而 schema 自查照样全绿。
 */
export const TOOL_NAMES = [
	'see_image',
]

/**
 * 现读面的两份数据文件名。名单从生产侧现读而不是在这里手抄：手抄那一份是加载器规格的第二处
 * 表述，数据面增一份文件时它就少拷一份，而症状不是「少了一个文件」，是某条用例在无关的原因上红
 * （例如临时目录里读不到 discipline.md，报的却是「数据形状不合」）。
 */
export const DISPATCH_DATA_FILES = DATA_FILES.map((e) => e.file)

/* ---------- 临时根 ---------- */

const makeTempRoot = (label) => mkdtempSync(join(tmpdir(), `dsh-${label}-`))

/**
 * 递归删一棵临时树。不用 rmSync／rmdirSync 的 recursive：Node v24.13.0 在 Windows 上，被删路径的
 * 末段（basename）非 ASCII 会让整个进程以 0xC0000409 死掉（父目录非 ASCII 无害；不带 recursive
 * 的 rmdirSync 与 unlinkSync 都不受影响），而临时树里装的正是测试自己造的条目名。目录本就不在时
 * 按「已删」跳过，与原先 force 的语义一致；判定用 lstat 不跟符号链接，与 rmSync 一样只删链接本身。
 *
 * 导出是因为这条删除路径要能被单测：它绕开的是「整进程硬崩」而不是抛错，藏在 withTempDir 里
 * 失效时没有任何一处报得出原因（跑着跑着进程没了，TAP 输出都没了）。
 */
export const removeTempRoot = (dir) => {
	if (!existsSync(dir)) return
	for (const name of readdirSync(dir)) {
		const child = join(dir, name)
		if (lstatSync(child).isDirectory()) removeTempRoot(child)
		else unlinkSync(child)
	}
	rmdirSync(dir)
}

/**
 * 临时根的收尾挂在 node:test 的上下文上：t.after 在用例（或文件）收尾时跑，于是每个文件不必
 * 再写一份删除样板。上下文缺位时当场报错，而不是安静建一个没人删的目录——那种泄漏要到下次
 * 有人清 /tmp 才发现，而症状（某个用例突然读到了上一轮的残留）指向的是别处。
 *
 * 导出是因为这条守卫本身要能被单测：它是共用件里唯一一条「守卫型」的逻辑，藏起来就没人能
 * 证明它还在生效，而它失效的方式是安静地泄漏（不抛错，只是目录没人删）。
 */
export const requireTestContext = (t, who) => {
	if (typeof t?.after !== 'function') {
		throw new Error(`${who} 须在 node:test 的上下文里调（before((t) => …)／test((t) => …) 拿得到 t）：临时根的删除登记在 t.after 上，脱离上下文就没人删它`)
	}
	return t
}

/** 一个可写的临时根，删除交给 t.after。跨多个用例复用的文件级根用它。 */
export const tempRoot = (t, label) => {
	const dir = makeTempRoot(label)
	requireTestContext(t, 'tempRoot').after(() => removeTempRoot(dir))
	return dir
}

/**
 * 单个用例的临时根：建 → 跑 fn(dir) → 删。fn 抛错或断言红时目录照样删。
 *
 * 两种时序形态都在：fn 同步就当场删完、原样返回它的返回值（不套一层 promise——调用方在同一个
 * tick 里拿返回值时拿到的得是它）；fn 返回 promise 就把收尾挂到那个 promise 上，等它 settle 再删。
 * 早删一步的后果很具体：回调醒来读到的目录已经不在，报出来的 ENOENT 指向回调自己而不是夹具，
 * 而症状（某个用例读不到临时目录）与「夹具造错了」长得一样。
 */
export const withTempDir = (t, label, fn) => {
	requireTestContext(t, 'withTempDir')
	const dir = makeTempRoot(label)
	let result
	try {
		result = fn(dir)
	} catch (error) {
		removeTempRoot(dir)
		throw error
	}
	if (typeof result?.then === 'function') return result.finally(() => removeTempRoot(dir))
	removeTempRoot(dir)
	return result
}

/* ---------- 记忆树（store 顶层共享段 ＋ 可选机器私有段） ---------- */

/**
 * 夹具只在给定目录底下加一层：名字当场拒空与分隔符——空名会被 join 落回上一层，多个用例的
 * 「各自的树」叠成一棵而互相污染；带分隔符则造出一棵比调用方想的那棵深的树。两种症状都
 * 出现在别的用例上（读到别人的数据／读不到自己那一段），指向的是别处。
 */
const assertSingleLevelName = (value, who) => {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`${who} 须是非空串（它落在上一层目录之下，层级由调用方拼），实得 ${JSON.stringify(value) ?? String(value)}——空名会被 join 落回上一层，多个用例的树叠成一棵`)
	}
	if (value.includes('/') || value.includes('\\') || value === '..' || value === '.') {
		throw new Error(`${who}「${value}」带路径分隔符或路径穿越：夹具只在上一层目录底下建一层，多写的层级会造出一棵比调用方预期深的树`)
	}
}

/**
 * 在 base 下建一棵可写的记忆树：store（＝<root>/memory，顶层就是共享段）＋可选的
 * machines/<机器id>（那台机器的私有段）。给 machineId 就顺带建私有段（没给的那一档
 * machineDir 是 undefined，调用方据此知道这条用例只碰共享段）。返回各段路径，省掉调用方重拼目录名。
 */
export const memoryTree = (base, name, machineId) => {
	assertSingleLevelName(name, 'memoryTree 的名字')
	const root = join(base, name)
	const store = join(root, 'memory')
	mkdirSync(store, { recursive: true })
	if (machineId === undefined) return { root, store, machineDir: undefined }
	assertSingleLevelName(machineId, 'memoryTree 的机器 id')
	const machineDir = join(store, 'machines', machineId)
	mkdirSync(machineDir, { recursive: true })
	return { root, store, machineDir }
}

/* ---------- 现读数据目录（拷真数据 → 改坏 → 断言 → 删） ---------- */

/** 把给定的几份数据拷进目标目录（缺省两份全拷；目录不存在就建），返回该目录。 */
export const copyDataFiles = (dir, files = DISPATCH_DATA_FILES) => {
	mkdirSync(dir, { recursive: true })
	for (const file of files) writeFileSync(join(dir, file), readFileSync(join(DISPATCH_DATA_DIR, file)))
	return dir
}

/**
 * 一份可随意改坏的临时数据目录。run 拿到目录后自己改（改坏再断言），故 mutator 与断言不再分两
 * 个形参——原先那个 mutate 形参的用途只是「把改的动作排在 run 前面」，而 run 里改同样排在断言
 * 前面，少一个形参少一处能传错位的入口。
 */
export const withDataDir = (t, run) => withTempDir(t, 'dispatch-data', (dir) => run(copyDataFiles(dir)))

/** 改一份文本数据（discipline.md／templates.md）再写回；改坏模板不走 JSON 重写那一套。 */
export const editText = (dir, file, mutate) => {
	writeFileSync(join(dir, file), mutate(readFileSync(join(dir, file), 'utf8')))
}
