/**
 * 接线单测（静态解析为主）：宿主包（dsh-tools/dsh-llm/schemastery）在裸仓不可
 * import，接线正确性分三层钉——
 * ① 胶水→工具模块：导入名须在目标模块 export 语句里（目标含宿主 import 只能
 *    静态验证；搬家断链的历史实锤见 dsh-memory 0.2 core→write 搬家事故）；
 * ② 工具模块→下游模块：动态 import 验导出面（纯模块的清单不在这里枚举——枚举随搬家
 *    漂移，而「某模块算不算纯模块」由下面的 node:fs 判定表回答）；
 * ③ inject 声明与模块内 ctx.* 服务消费双向对齐（少声明＝cordis DOA，多声明＝
 *    噪音），以及 lib/ 各模块的 node:fs 直连面按文件判定表。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LIB_DIR, TOOL_NAMES } from './helpers.js'

const libDir = LIB_DIR
const loadModule = (file) => import(pathToFileURL(join(libDir, file)).href)
const readLib = (file) => readFileSync(join(libDir, file), 'utf8')

/** 命中 import { a, b as c } from './x.js' 的多行形态；宿主包导入不在核对范围。
 * 别名只影响本地名，核对的是源名（目标导出面里的是源名）。 */
function parseLocalImports(source) {
	const imports = new Map()
	for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.\/[^']+)'/g)) {
		const names = match[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter((s) => s.length > 0)
		imports.set(match[2], names)
	}
	return imports
}

/** 静态收集 export 声明的名字（目标模块含宿主 import，不可动态加载）。 */
function parseExportNames(source) {
	const names = new Set()
	for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/g)) names.add(match[1])
	return names
}

/** 去块注释与行注释后扫：注释里的提及不算数（文件头散文常提到 node:fs，不能当导入面）。 */
function stripComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** 去注释后扫服务消费（注释里的提及不算数）。
 * 覆盖的是**注入面消费**（ctx.<service>）外加按需取用（ctx.get('<service>')）——后者
 * 不在 inject 面是设计（工具族不需要它必然在场），收集起来只为识别、不参与下面的
 * 双向对齐；本函数因此看不见任何其它形式的服务引用（如解构注入、插件闭包取用）。 */
const SERVICES = ['systemPrompt', 'tools', 'llm', 'attachments', 'fs']
function consumedServices(source) {
	const code = stripComments(source)
	const used = new Set()
	for (const service of SERVICES) {
		if (new RegExp(`ctx\\.${service}\\b`).test(code)) used.add(service)
	}
	for (const match of code.matchAll(/ctx\.get\(\s*'(\w+)'/g)) used.add(match[1])
	return used
}

test('胶水→工具模块的导入名在目标 export 语句内（防搬家断链）', () => {
	const glue = readLib('index.js')
	const imports = parseLocalImports(glue)
	assert.ok(imports.has('./memory/index.js') && imports.has('./see-image/index.js') && imports.has('./dispatch/discipline.js'), '胶水须装配 memory、see_image 与纪律注入三个模块')
	for (const [specifier, names] of imports) {
		const exported = parseExportNames(readLib(specifier.replace('./', '')))
		for (const name of names) {
			assert.ok(exported.has(name), `胶水从 ${specifier} 导入的 "${name}" 不在目标 export 面——搬家断链`)
		}
	}
})

test('工具模块→纯函数文件的导入名在目标导出面内（动态加载验证）', async () => {
	const cases = [
		['memory/index.js', ['registerMemory', 'configShape']],
		['see-image/index.js', ['registerSeeImage', 'configShape']],
		['dispatch/discipline.js', ['registerDiscipline']],
	]
	for (const [file, expected] of cases) {
		const imports = parseLocalImports(readLib(file))
		for (const [specifier, names] of imports) {
			const mod = await loadModule(join(dirname(file), specifier))
			for (const name of names) {
				assert.ok(name in mod, `${file} 从 ${specifier} 导入的 "${name}" 不在导出面`)
			}
		}
		assert.ok(expected.every((name) => parseExportNames(readLib(file)).has(name)), `${file} 缺模块接口 ${expected.join('/')}`)
	}
})

test('inject 声明与 ctx.* 消费双向对齐（少＝DOA，多＝噪音）', async () => {
	const glue = readLib('index.js')
	const match = /export const inject = \[([^\]]*)\]/.exec(glue)
	assert.ok(match, 'index.js 须导出 inject 数组')
	const declared = new Set(SERVICES.filter((service) => match[1].includes(`'${service}'`)))

	// 扫描面＝实际消费 ctx.* 的文件清单，逐个点名而不是靠目录扫：ctx 消费一旦从被扫的
	// 文件挪到没被扫的文件（如活目录解析收进 lib/working-dir.js、或收口后落到
	// see-image/vision.js），DOA 要到运行期才炸，而这条用例正是提前拦住它的那道
	const used = new Set([
		...consumedServices(glue),
		...consumedServices(readLib('dispatch/discipline.js')),
		...consumedServices(readLib('memory/index.js')),
		...consumedServices(readLib('see-image/index.js')),
		...consumedServices(readLib('see-image/vision.js')),
		...consumedServices(readLib('working-dir.js')),
	])
	for (const service of used) {
		// 只对注入面服务做双向对齐：ctx.get('sandboxPolicy') 这类按需取用不在 inject 面
		// 是设计，对齐它会把设计当噪音报错
		if (!SERVICES.includes(service)) continue
		assert.ok(declared.has(service), `模块消费了 ctx.${service} 但 inject 未声明——cordis 抛 cannot get property 而插件 DOA`)
	}
	for (const service of declared) {
		assert.ok(used.has(service), `inject 声明了 '${service}' 但无模块消费——多余的 DOA 风险/约束噪音`)
	}
	assert.ok(readLib('see-image/index.js').includes('ctx.tools.register'), 'see-image/index.js 须注册自身工具')
	// 记忆索引注入的装配哨兵：它不是工具（不占 FEATURES 行），独立装配
	// 意味着 FEATURES 表动它不会红——少这一行 import 哪都在，调用线一断注入就静默死
	// （症状＝会话里再无记忆块，而无任何报错），故把调用本身钉在源码上
	assert.ok(stripComments(glue).includes('registerMemory(ctx, config)'), '胶水须独立装配记忆索引注入（registerMemory(ctx, config)）——写侧退役后它只剩注入，调用线一断即静默死')
	// 纪律注入同理独立装配：注入件不占 FEATURES 行，FEATURES 表动它不会红。
	// 调用线一断的症状是「纪律整块静默缺席」（会话照常跑，只是流程没人提），必须钉在源码上
	assert.ok(stripComments(glue).includes('registerDiscipline(ctx, config)'), '胶水须独立装配跑批纪律注入（registerDiscipline(ctx, config)）——调用线一断纪律即静默缺席')
	// 胶水的 FEATURES 表＝逐工具隔离的粒度：工具多一件而表里少一行，隔离就少一件；反过来，
	// 多件工具写进一行就是「一件起不来，另几件陪葬」——逐工具隔离正是本层存在的理由
	const features = [...glue.matchAll(/^\t\['([\w_]+)', (\w+)\],$/gm)].map((match) => [match[1], match[2]])
	assert.deepEqual(features.map(([label]) => label), TOOL_NAMES, 'FEATURES 的标签集＝本包登记的工具面（识图占一行；记忆索引注入不占行，见上一条哨兵）；名单的另一处真相源在 test/helpers.js 的 TOOL_NAMES，两处同读一份投影，改名或加件不会只红一处')
	// 行形正则锁得住列数，锁不住列里写了什么：FEATURES 曾带第三列 seeImageShape/usageNoteShape，
	// 两个标识符在胶水里根本没有绑定——apply 一跑就 ReferenceError，整包 DOA（逐工具隔离接不住
	// 模块加载期错误）。这里逐标识符核绑定面：import 名＋顶层声明名。
	const featureBlock = glue.match(/const FEATURES = \[([\s\S]*?)\n\]/)?.[1] ?? ''
	assert.ok(featureBlock, '胶水里要能定位 FEATURES 数组（正则/结构变了先改这条）')
	const bound = new Set()
	for (const match of glue.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
		for (const part of match[1].split(',')) {
			const name = part.trim().split(/\s+as\s+/).pop().trim()
			if (name) bound.add(name)
		}
	}
	for (const match of glue.matchAll(/^import\s+(\w+)\s+from/gm)) bound.add(match[1])
	for (const match of glue.matchAll(/^(?:export\s+)?(?:const|function|class)\s+(\w+)/gm)) bound.add(match[1])
	const declaredKeywords = new Set(['const', 'FEATURES', 'true', 'false', 'null'])
	const featureTokens = (featureBlock.replace(/'[^']*'/g, "''").match(/[A-Za-z_$][\w$]*/g) ?? [])
	for (const token of featureTokens) {
		if (declaredKeywords.has(token)) continue
		assert.ok(bound.has(token), `FEATURES 里的标识符 ${token} 在本文件没有绑定（import 名或顶层声明）——表读得动，apply 一跑就 ReferenceError，整包 DOA`)
	}
	const glueImports = [...parseLocalImports(glue).values()].flat()
	for (const [label, register] of features) {
		assert.ok(glueImports.includes(register), `FEATURES 的 ${label} 指向 ${register}，而胶水没 import 它——apply 时撞 undefined，try/catch 接不住`)
	}
})

/**
 * 浏览器半的三件声明必须同进退：package.json 的 dsh.client、exports["./client"] 与盘上那个
 * 实体文件。宿主侧扫描（dsh-client-modules）只认 dsh.client.platform === 'web'，且声明在场
 * 而 exports["./client"] 缺失时是 loud throw——症状是整个 web 引导起不来，不是这一块不显示，
 * 故这三件的自洽留在接线单测里，不留给运行期发现。
 */
test('浏览器半的声明自洽（dsh.client / exports["./client"] / 实体文件三者同进退）', () => {
	const pkg = JSON.parse(readFileSync(join(libDir, '..', 'package.json'), 'utf8'))
	const decl = pkg.dsh?.client
	assert.ok(decl !== undefined, 'dsh.client 须声明：浏览器半靠它被宿主扫描进 web 引导（声明缺位时这条用例此前静默 return，整块断言变成空转）')
	assert.equal(decl.platform, 'web', 'dsh.client.platform 须为 web（宿主扫描跳过非 web 行）')
	assert.ok(Array.isArray(decl.inject) && decl.inject.every((item) => typeof item === 'string'), 'dsh.client.inject 须是字符串数组（解析器对形状是 fail fast）')
	// 两种合法形态：裸串与带 default 的一层条件对象（clientExportOf 收这两种）
	const raw = pkg.exports?.['./client']
	const clientRel = typeof raw === 'string' ? raw : raw?.default
	assert.ok(typeof clientRel === 'string', 'dsh.client 在场时 exports["./client"] 须指向客户端包体（缺了即宿主扫描 loud throw）')
	assert.ok(existsSync(join(libDir, '..', clientRel)), `exports["./client"] 指向的 ${clientRel} 不在盘上`)
	// 客户端模块的注册 id 与 bundle 槽位键都取包名：宿主按包名定位客户端包体、插件页按包名查 keyed 槽
	assert.ok(readLib('client.js').includes(`id: '${pkg.name}'`), 'client.js 的模块 id 须等于包名（宿主按包名定位客户端包体）')
})

/**
 * 浏览器半的依赖面：client.js 的静态 require 只认「前端壳的预置模块表 ＋ package.json 的
 * dsh.client.external／inject 声明」。新加一个依赖而不进声明面＝宿主不把它装进模块表，
 * 运行期 require 直接抛（client-modules：missed the module table），症状是这块界面整个不渲染，
 * 而报错指向 client.js，看不出根在 package.json。
 */
test('浏览器半的依赖面哨兵：client.js 静态 require 的每件都在预置表或声明面里', () => {
	const pkg = JSON.parse(readFileSync(join(libDir, '..', 'package.json'), 'utf8'))
	// 预置表里那两件（前端壳的静态模块种子：react 系与 ui-primitives）：基线模块，不进声明面。
	// 声明面两栏各收各的（宿主 client-modules 的口径）：external＝要解析成模块的非基线请求，
	// inject＝必须先就位的插件 row（本包那四件就是后者），两者都在解析序里，故都算已声明。
	const allowed = new Set([
		'react',
		'@deepseek-ai/dsh-client-ui-primitives',
		...(pkg.dsh?.client?.external ?? []),
		...(pkg.dsh?.client?.inject ?? []),
	])
	const required = [...readLib('client.js').matchAll(/\brequire\(\s*'([^']+)'\s*\)/g)].map((match) => match[1])
	// 扫描退化成空转时下面那条过滤恒真：先把「抽得到已知的两件」判红
	assert.ok(
		required.includes('react') && required.includes('@deepseek-ai/dsh-client-ui-primitives'),
		`client.js 的 require 扫描没抽到预置表那两件（抽到：${required.join('、')}）——正则与写法脱节时这条用例会空转`,
	)
	assert.deepEqual(
		required.filter((name) => !allowed.has(name)),
		[],
		'client.js require 了未声明的模块：非基线请求进 dsh.client.external，要按 row 就位的进 dsh.client.inject，两者都不是的话它就该在预置表里',
	)
})

/**
 * node:fs 直连的判定表（按文件，不按函数窗口）：false＝该文件零直连，true＝按设计
 * 直连且必须直连。取舍的理由写在各文件头，不写在测试里，测试只钉「直不直」。
 *
 * 判据的落点是**导入面**。窗口式放行名单有两个洞：一是名单跟着结构漂移（改个函数名
 * 就得改名单，而改名单的人不会重读它对不对），二是名单只圈得住已列名的函数——模块级
 * helper 的调用点落在任何窗口外时，这条判定对它就成了空转，回退了也不红。按文件判
 * 则两者都不存在：模块里任何一处（含模块级 helper）想摸 node:fs，都得先在这张面上
 * 登记，而登记是有人看着的显式动作。
 *
 * 表只回答「每个文件各自直不直」。各 true 行的理由各是各的：读侧的失控读与段扫描
 * 刻意直连（枚举与体检遍历不经端口——宿主 fs 契约只管会话内文件），data.js 读数据面。
 */
const NODE_FS_DIRECT = new Map([
	['memory/frontmatter.js', false],
	['memory/naming.js', false],
	['memory/core.js', false],
	['memory/patterns.js', false],
	['memory/assemble.js', true],
	['memory/segments.js', true],
	['memory/index.js', true],
	['see-image/vision.js', true],
	['see-image/index.js', false],
	// 识图路由内缝：与 vision.js 同款零宿主依赖的纯模块，值判据走 value.js
	['see-image/route.js', false],
	// 浏览器半：前端静态模块表的注册脚本，只碰 window/require 面，不碰磁盘
	['client.js', false],
	['dispatch/discipline.js', false],
	['dispatch/data.js', true],
	['working-dir.js', false],
	['paths.js', false],
	['value.js', false],
	['memory-root.js', false],
	['fs-guard.js', false],
	['index.js', false],
])

/**
 * 定性表必须覆盖到的模块域：lib/ 根与四个子目录。每个域下的 .js 都要在表上定性过——
 * 覆盖只到一部分时，「新增文件漏定性」就只在那部分成立，文档承诺比机器口径宽，
 * 读到的人会以为全仓都有牙。
 */
const NODE_FS_SCOPES = ['.', 'memory', 'see-image', 'dispatch']

/**
 * node:fs 的同步调用面：全量符号集（fs 同步 API，含 openSync/readSync/closeSync 这类
 * 低层句柄调用）。这份集子必须是全量而非「本仓用到的几个」——漏一个符号就是一类调用
 * 漏扫，而漏扫的那类在判定为零直连的文件里会被读成合规。
 */
const NODE_FS_SYNC_API = [
	'accessSync', 'appendFileSync', 'chmodSync', 'chownSync', 'closeSync', 'copyFileSync', 'cpSync', 'existsSync', 'fchmodSync',
	'fchownSync', 'fdatasyncSync', 'fstatSync', 'fsyncSync', 'ftruncateSync', 'futimesSync', 'globSync', 'lchmodSync', 'lchownSync',
	'linkSync', 'lstatSync', 'lutimesSync', 'mkdirSync', 'mkdtempSync', 'openSync', 'opendirSync', 'readdirSync', 'readFileSync',
	'readSync', 'readlinkSync', 'readvSync', 'realpathSync', 'renameSync', 'rmSync', 'rmdirSync', 'statSync', 'statfsSync',
	'symlinkSync', 'truncateSync', 'unlinkSync', 'utimesSync', 'watchSync', 'writeFileSync', 'writeSync', 'writevSync',
]

const NODE_FS_CALL_RE = new RegExp(`\\b(?:${NODE_FS_SYNC_API.join('|')})\\s*\\(`, 'g')

/**
 * 导入面里的 node:fs 条数：按 import 语句取源名，覆盖具名／默认／命名空间／裸副作用四种
 * 形态（`from` 可省——`import 'node:fs'` 是合法写法）。
 * 子路径一起算：node:fs/promises 的 readFile/writeFile 不在下面的同步符号集里，放过它
 * 等于放过 Node 里最自然的异步 fs 写法，而那正是这条保证最该堵的那个口子。
 */
function nodeFsImports(source) {
	let count = 0
	for (const match of stripComments(source).matchAll(/import\s*(?:\{[^}]*\}|\*\s*as\s+\w+|\w+(?:\s*,\s*\{[^}]*\})?)?\s*(?:from\s*)?'([^']+)'/g)) {
		if (/^node:fs(\/|$)/.test(match[1])) count += 1
	}
	return count
}

// 已知边界：stripComments 只剥注释不剥字符串，故字符串字面量里贴一段完整 import 语句
// （如文档示例）会被当成真导入而误红。方向是噪音不是漏网——真出现时是误报，删掉那段
// 示例即恢复，代价远小于为剥字符串再写一套会出错的词法扫描。
const nodeFsCalls = (source) => [...stripComments(source).matchAll(NODE_FS_CALL_RE)].length

test('lib/ 各模块的 node:fs 直连按文件判定（读侧与端口本尊显式直连，其余零直连）', () => {
	// 名单即覆盖：每个域下的每个模块都要在表上定性过。新模块漏登记＝这条判定对它空转，
	// 而「漏登记」恰好就是放行名单腐化的起点
	for (const scope of NODE_FS_SCOPES) {
		for (const name of readdirSync(join(libDir, scope)).filter((file) => file.endsWith('.js'))) {
			const key = scope === '.' ? name : `${scope}/${name}`
			assert.ok(NODE_FS_DIRECT.has(key), `${key} 未在 node:fs 判定表上定性——直不直是设计取舍，没登记就等于没判定`)
		}
	}
	for (const [file, direct] of NODE_FS_DIRECT) {
		// 文件不在即 ENOENT 抛错：搬家或改名会红，不必再单独钉一条存在性
		const source = readLib(file)
		const imports = nodeFsImports(source)
		const calls = nodeFsCalls(source)
		if (direct) {
			// 「必须」是反方向的那一半：只有它，文件哪天悄悄改走别的路（或多出新的直连模块）
			// 才会红；没有它，单向禁令分不出「设计变更」与「漏改」
			assert.ok(imports > 0, `${file} 按设计直连 node:fs（读侧失控读与段扫描、端口本尊、数据面读取各是自己的理由），导入面却没有登记`)
			assert.ok(calls > 0, `${file} 登记了 node:fs 直连却一个调用也没有——导入面与实际用法脱节，这条判定对它空转`)
		} else {
			assert.equal(imports, 0, `${file} 出现 node:fs 导入——它登记为零直连（该经端口的经端口，装配层由宿主能力代劳）`)
			assert.equal(calls, 0, `${file} 出现 node:fs 直连调用——它登记为零直连，模块级 helper 同样算`)
		}
	}
})
