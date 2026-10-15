/**
 * 测试夹具的共用件：条目正文模板、临时根、记忆树、现读数据目录、台账事件。
 *
 * 收口理由分四层，每层都对着一种「两边各自都对、于是没人发现」的分家：
 *
 * ①条目正文模板（frontmatter 两键加正文）此前四个测试文件各写一份逐字相同的它（memory-write／
 *   memory-lint／memory-core／memory-delete）。frontmatter 是契约且在收紧（恰好两键），模板一分
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
 * ③记忆树（根加习惯层加可选工作层桶）与现读数据目录（拷一份真数据再改坏）此前各有三四个文件
 *   各写一遍，目录名各拼各的——测试盘上摆了什么，读用例的人得逐个文件自己认。现读面那份文件名
 *   清单也从生产侧（data.js 的 DATA_FILES）现读，不在本模块手抄。
 *
 * ④台账事件此前 lessons 与 dispatch 两族各造一份同型对象：字段名与生产构造器（batch.js 的
 *   startEvent／advanceEvent）同源，抄一份就多一个「抄件与原件分家」的地方。注意本模块造的是
 *   夹具：batch.test.js 直接 import 生产构造器的那几处不能改调——那些用例验的就是生产构造器
 *   本身，用夹具替身造事件等于把被验对象换掉。而「同形」这件事由 helpers.test.js 对着生产
 *   构造器核键集钉住，不靠这里写注释自觉。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDispatchData, DATA_FILES } from '../lib/dispatch/data.js'

export const entry = (title, description, body = '正文') => `---\ntitle: ${title}\ndescription: ${description}\n---\n\n${body}\n`

/* ---------- 路径常量（此前六个文件各拼一遍 join(dirname(import.meta.url), '..', …)） ---------- */

/** 仓根：下面几个常量都由它派生，而它自己没人直接用——导出就等于给「派生值另有消费者」留一个口子。 */
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
export const LIB_DIR = join(ROOT_DIR, 'lib')
export const DISPATCH_DIR = join(LIB_DIR, 'dispatch')
export const DISPATCH_DATA_DIR = join(DISPATCH_DIR, 'data')
export const SCRIPTS_DIR = join(ROOT_DIR, 'scripts')
export const FIXTURES_DIR = join(ROOT_DIR, 'test', 'fixtures')

/**
 * 现读面的五份数据文件名。名单从生产侧现读而不是在这里手抄：手抄那一份是加载器规格的第二处
 * 表述，数据面增一份文件时它就少拷一份，而症状不是「少了一个文件」，是某条用例在无关的原因上红
 * （例如临时目录里读不到 plan-spec.json，报的却是「数据形状不合」）。
 */
export const DISPATCH_DATA_FILES = DATA_FILES.map((e) => e.file)

/* ---------- 临时根 ---------- */

const makeTempRoot = (label) => mkdtempSync(join(tmpdir(), `dsh-${label}-`))
const removeTempRoot = (dir) => rmSync(dir, { recursive: true, force: true })

/**
 * 临时根的收尾挂在 node:test 的上下文上：t.after 在用例（或文件）收尾时跑，于是每个文件不必
 * 再写一份 rmSync 样板。上下文缺位时当场报错，而不是安静建一个没人删的目录——那种泄漏要到下次
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

/* ---------- 记忆树（根加习惯层加可选工作层桶） ---------- */

/**
 * 在 base 下建一棵可写的记忆树。给 workspaceSlug 就顺带建工作层桶（没给的那一档 bucket 是
 * undefined，调用方据此知道这条用例只碰习惯层）。返回各层路径，省掉调用方重拼目录名。
 *
 * 名字当场拒空与分隔符：层级是调用方拼的，夹具只该在 base 底下加一层。空名会被 join 落回 base，
 * 于是多个用例的「各自的树」叠成一棵而互相污染；带分隔符则造出一棵比调用方想的那棵深的树——
 * 两种症状都出现在别的用例上（读到别人的数据／读不到 profile），指向的是别处。
 */
export const memoryTree = (base, name, workspaceSlug) => {
	if (typeof name !== 'string' || name.trim() === '') {
		throw new Error(`memoryTree 的名字须是非空串（它落在 base 之下，层级由调用方拼），实得 ${JSON.stringify(name) ?? String(name)}——空名会被 join 落回 base，多个用例的树叠成一棵`)
	}
	if (name.includes('/') || name.includes('\\') || name === '..' || name === '.') {
		throw new Error(`memoryTree 的名字「${name}」带路径分隔符或路径穿越：夹具只在 base 底下建一层，多写的层级会造出一棵比调用方预期深的树，报错点在别的用例读不到 profile 上`)
	}
	const root = join(base, name)
	const profile = join(root, 'profile')
	mkdirSync(profile, { recursive: true })
	if (workspaceSlug === undefined) return { root, profile, bucket: undefined }
	const bucket = join(root, 'workspaces', workspaceSlug)
	mkdirSync(bucket, { recursive: true })
	return { root, profile, bucket }
}

/* ---------- 现读数据目录（拷真数据 → 改坏 → 断言 → 删） ---------- */

/** 把给定的几份数据拷进目标目录（缺省五份全拷；目录不存在就建），返回该目录。 */
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

/**
 * 改一份 JSON 再写回。刻意只从磁盘文本重新解析、不复用任何一次加载返回的对象：复用的话，
 * 「改文件后下次调用取新值」那条用例就会被自己写回的那份缓存喂绿。
 */
export const editData = (dir, file, mutate) => {
	const value = JSON.parse(readFileSync(join(dir, file), 'utf8'))
	mutate(value)
	writeFileSync(join(dir, file), JSON.stringify(value))
}

/** withDataDir 的加载版：按 edits（{文件名: mutator}）改坏一份真数据，把加载结果交给 run。 */
export const withLoadedData = (t, edits, run) => withDataDir(t, (dir) => {
	for (const [file, mutate] of Object.entries(edits ?? {})) editData(dir, file, mutate)
	return run(loadDispatchData({ dataDir: dir }))
})

/* ---------- 台账事件夹具（lessons 与 dispatch 两族共用） ---------- */

/**
 * 递增时钟：事件时间定序是趋势读法的前提（同刻并列那一档另有专门用例在测）。按写入顺序递增而
 * 不取真实时间——真时间会让「哪条事件在前」随跑动的快慢变。
 */
export const isoClock = (epochMs = Date.UTC(2026, 0, 1)) => {
	let tick = 0
	return () => {
		tick += 1
		return new Date(epochMs + tick).toISOString().replace('Z', '+00:00')
	}
}

/**
 * 一份事件夹具：字段名与生产构造器（batch.js 的 startEvent／advanceEvent）逐字同形。做成工厂而
 * 不是两个模块级函数，是为了让时钟按「一份夹具一份」计数——两个文件共用同一个模块级计数器时，
 * 两边的先后次序会互相影响，而次序正是这些用例的前提。
 */
export const makeEvent = () => {
	const iso = isoClock()
	const start = (batch, batchType, rules = 'v1', extra = {}) => ({
		t: iso(), batch, action: 'start', batchType, baseBatchType: '', intent: `${batch} 意图`, subject: '', decisions: [], rules, ...extra,
	})
	const advance = ({ batch, stage = '门二', rules = 'v1', combo = '', recommended = '', perFormCounts = {}, adopted = 0, overlap = 0, missed = '', note = '' }) => ({
		t: iso(), batch, action: 'advance', stage, rules, combo, recommended, perFormCounts, adopted, overlap, missed, note,
	})
	return { start, advance }
}

/** 落一份台账：一行一事件（与写侧同形，故读侧那条「坏行 fail fast」的契约在用到它的文件里也生效）。 */
export const seedLedger = (root, name, events) => {
	const path = join(root, `${name}.jsonl`)
	writeFileSync(path, events.map((event) => `${JSON.stringify(event)}\n`).join(''))
	return path
}
