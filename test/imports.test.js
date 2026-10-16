/**
 * 接线单测（静态解析为主）：宿主包（dsh-tools/dsh-llm/schemastery）在裸仓不可
 * import，接线正确性分三层钉——
 * ① 胶水→工具模块：导入名须在目标模块 export 语句里（目标含宿主 import 只能
 *    静态验证；搬家断链的历史实锤见 dsh-memory 0.2 core→write 搬家事故）；
 * ② 工具模块→下游模块：动态 import 验导出面（纯模块的清单不在这里枚举——枚举随搬家
 *    漂移，而「某模块算不算纯模块」由下面的 node:fs 判定表与闭包断言回答）；
 * ③ inject 声明与模块内 ctx.* 服务消费双向对齐（少声明＝cordis DOA，多声明＝
 *    噪音），以及工具参数面→写侧函数签名一致性、memory 各模块的 node:fs 直连面
 *    （write.js 传递闭包零直连＝写入侧 I/O 只经 fs 端口）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LIB_DIR } from './helpers.js'

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
	assert.ok(imports.has('./memory/index.js') && imports.has('./see-image/index.js') && imports.has('./dispatch/index.js'), '胶水须装配 memory、see_image、dispatch 三模块')
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
		['dispatch/index.js', [
			'registerDispatchPlan', 'registerDispatchReview', 'registerDispatchBuild', 'registerDispatchVerify',
			'registerDispatchBatch', 'registerDispatchLessons', 'configShape',
		]],
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

test('memory 工具参数面与写侧函数签名一致（action→入参字段逐一对齐）', async () => {
	// 参数面单源在 params.js（纯模块）：这里 import 现值断言，不再静态解析 index.js 源码
	// 抽参数名——源码正则绑定的是写法不是契约，表挪个位置断言就空转（改写申报：原版对
	// index.js 的 /^\s{3}(\w+):\s*\{\s*type:/ 抽取退役，换成本条的 import 现值断言）
	const { MEMORY_PARAMS, RETIRED_PARAM_GUIDES, guardMemoryParams } = await loadModule('memory/params.js')
	const parameters = Object.keys(MEMORY_PARAMS)
	for (const expected of ['action', 'layer', 'file_path', 'content', 'heading', 'body', 'title', 'description']) {
		assert.ok(parameters.includes(expected), `工具 parameters 缺 "${expected}"`)
	}
	// 退役参数与派生名同退同进：schema 里留着而实现不接，子代理照 schema 传参就撞
	// 「参数不存在」；反过来实现还认着的退役名也不许从 schema 里凭空消失——两边同退
	for (const retired of ['file', 'oldString', 'newString', 'replaceAll', 'indexLine']) {
		assert.ok(!parameters.includes(retired), `退役参数 "${retired}" 不得回到工具 parameters`)
	}
	// action/layer 的 enum 各读单源（core.js），且是同一份引用不是抄本——抄本与单源在
	// 下一轮改词表时分叉，报错清单就会教一个 schema 不收的值
	const core = await loadModule('memory/core.js')
	assert.equal(MEMORY_PARAMS.action.enum, core.MEMORY_ACTIONS, 'action enum 须引用 MEMORY_ACTIONS 单源本体')
	assert.equal(MEMORY_PARAMS.layer.enum, core.LAYERS, 'layer enum 须引用 LAYERS 单源本体')
	assert.deepEqual([...core.LAYERS], ['profile', 'workspace'], '层值词表＝profile | workspace（目录名与值同名，注入索引教的即 schema 收的）')
	// 层值字面量不得回流：schema/路由/注入/标签全部走 LAYERS 单源后，'habit' 在 lib/memory
	// 下任何一处重新出现都是「一边收 profile 一边教 habit」那条老病根复发
	for (const file of ['memory/index.js', 'memory/core.js', 'memory/assemble.js', 'memory/layers.js', 'memory/params.js']) {
		assert.ok(!readLib(file).includes("'habit'"), `${file} 不得再出现层值字面量 'habit'（层值单源＝core 的 LAYERS）`)
	}
	// index.js 只引用单源表与守卫（宿主包导入不可加载，接线用源码钉）：parameters 直指
	// MEMORY_PARAMS、execute 先点名未知键再看动作、条件必填运行期点名——三处断线都会让
	// 契约测试测的与运行期跑的脱钩
	const source = readLib('memory/index.js')
	assert.ok(source.includes('parameters: MEMORY_PARAMS'), 'index.js 的 parameters 须引用 params.js 单源表')
	// 判层句按单源渲染的源码哨兵：description 模板串里出现的是具名引用（宿主包导入不可
	// 加载，接线用源码钉）——写成裸串「跨机成立→profile」即测这句与 LAYERS 脱钩
	assert.ok(source.includes('跨机成立→${PROFILE_LAYER}'), '工具 description 的判层句须按 LAYERS 单源渲染（PROFILE_LAYER 出场）')
	const executeBody = source.slice(source.indexOf('async execute'), source.indexOf('function renderToolResult'))
	assert.ok(executeBody.includes('guardMemoryParams'), 'execute 须先走入参守卫（未知键点名）')
	assert.ok(executeBody.indexOf('guardMemoryParams') < executeBody.indexOf("args.action === 'write'"), '入参守卫须先于动作分派（点名先于按动作取值）')
	assert.ok(executeBody.includes('assertRequiredParams'), 'execute 须运行期点名条件必填（layer/file_path/content 按动作）')
	// 写侧三个动作各成一文件（write.js 是端口写侧，delete/lint 刻意直连 node:fs），
	// execute 的分派面按模块归属一起核。动作模块的集合现场扫出来而不是手写枚举：枚举
	// 漏登记一个文件时不会红，而分派面恰恰靠「全部动作模块导出面的并集」才查得全
	const memoryDir = join(libDir, 'memory')
	const actionFiles = readdirSync(memoryDir).filter((file) => file.endsWith('.js') && file !== 'index.js')
	const writeSide = {}
	for (const file of actionFiles) Object.assign(writeSide, await loadModule(join('memory', file)))
	for (const fn of ['upsertEntry', 'editEntry', 'deleteEntry', 'lintMemory']) {
		assert.ok(typeof writeSide[fn] === 'function', `execute 分派的 "${fn}" 不在写侧任一动作模块的导出面`)
		assert.ok(executeBody.includes(fn), `execute 未分派 "${fn}"`)
	}
	assert.ok(executeBody.includes('未知 action'), '未知 action 须显式 throw（不得静默成功）')
	// 别名表逐键可指路（键按折叠口径匹配，退役名的每个常见拼写都得落进某一条指引），
	// 否则撞上那个拼写的调用方只会拿到兜底句，指路名存实亡
	const { foldParamName } = await loadModule('param-guard.js')
	assert.equal(typeof guardMemoryParams, 'function', 'guardMemoryParams 须可调用（execute 的入参守卫）')
	for (const retired of ['oldString', 'old_string', 'newString', 'new_string', 'replaceAll', 'file', 'indexLine']) {
		const folded = foldParamName(retired)
		assert.ok(
			Object.keys(RETIRED_PARAM_GUIDES).some((key) => foldParamName(key) === folded),
			`退役名 "${retired}" 在别名表没有折叠命中的键`,
		)
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
		...consumedServices(readLib('dispatch/index.js')),
		// 台账与复盘两个逻辑模块今天不消费 ctx.*，仍在扫描面里：它们经装配层拿端口，一旦将来
		// 自己伸手取服务，少了这两行 DOA 要到运行期才炸
		...consumedServices(readLib('dispatch/batch.js')),
		...consumedServices(readLib('dispatch/lessons.js')),
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
	// 反向钉住按需取用的识别：上面那个 continue 会把「正则退化成永不命中」伪装成
	// 「没问题」，而这正是本用例的立身之本（少声明＝DOA）
	assert.ok(used.has('sandboxPolicy'), "memory/index.js 的 ctx.get('sandboxPolicy') 须被服务引用扫描识别到（ctx.get 形态，非注入面消费）")

	for (const file of ['memory/index.js', 'see-image/index.js', 'dispatch/index.js']) {
		assert.ok(readLib(file).includes('ctx.tools.register'), `${file} 须注册自身工具`)
	}
	// 胶水的 FEATURES 表＝逐工具隔离的粒度：工具多一件而表里少一行，隔离就少一件；反过来，
	// 三件工具写进一行就是「一件起不来，另两件陪葬」——逐工具隔离正是本层存在的理由
	const features = [...glue.matchAll(/^\t\['([\w_]+)', (\w+)\],$/gm)].map((match) => [match[1], match[2]])
	assert.deepEqual(features.map(([label]) => label), ['dispatch_plan', 'dispatch_review', 'dispatch_build', 'dispatch_verify', 'dispatch_batch', 'dispatch_lessons', 'memory', 'see_image'], 'FEATURES 的标签集＝本包登记的工具面：装配四件、台账、复盘各占一行（彼此失败原因互不相干）——四件并一行＝逐工具隔离没了')
	const glueImports = [...parseLocalImports(glue).values()].flat()
	for (const [label, register] of features) {
		assert.ok(glueImports.includes(register), `FEATURES 的 ${label} 指向 ${register}，而胶水没 import 它——apply 时撞 undefined，try/catch 接不住`)
	}
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
 * 表只回答「每个文件各自直不直」。写侧那条硬边界（upsert/edit 的 I/O 只经 fs 端口）问的
 * 是另一个量：write.js 的**传递闭包**里有没有直连模块——写侧与全部下游都登记为零直连时，
 * 一个共享件直连 node:fs 照样能让写侧绕过端口，而这张表全绿。闭包断言在表之后。
 *
 * 共享机制也算一张表里的行：head-read.js 由端口的 node 适配器与读侧共用，它直连不等于
 * 写侧直连——端口适配器本来就是本仓的 node 实现，而它不在 write.js 的闭包内（下面那条
 * 闭包断言正是替这件事兜底）。
 */
const NODE_FS_DIRECT = new Map([
	['memory/write.js', false],
	['memory/frontmatter.js', false],
	['memory/core.js', false],
	['memory/patterns.js', false],
	['memory/params.js', false],
	['memory/delete.js', true],
	['memory/lint.js', true],
	['memory/assemble.js', true],
	['memory/layers.js', true],
	['memory/index.js', true],
	['see-image/vision.js', true],
	['see-image/index.js', false],
	['dispatch/core.js', false],
	['dispatch/parameters.js', false],
	['dispatch/batch.js', false],
	['dispatch/lessons.js', false],
	['dispatch/data.js', true],
	['dispatch/index.js', false],
	['working-dir.js', false],
	['paths.js', false],
	['value.js', false],
	['param-guard.js', false],
	['memory-root.js', false],
	['fs-port.js', true],
	['fs-guard.js', false],
	['head-read.js', true],
	['index.js', false],
	// schema 形状工厂：三族工具共用的 object/stringList 构造处，纯数据形状、零 I/O——
	// 把它漏登记的话，「新增文件漏定性」那条承诺对它就不成立，而它恰好是三族输出 schema
	// 汇进去的那一格
	['tool-schema.js', false],
])

/**
 * 定性表必须覆盖到的模块域：lib/ 根与三个子目录。每个域下的 .js 都要在表上定性过——
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

test('lib/ 各模块的 node:fs 直连按文件判定（端口写侧与装配层零直连，其余必须显式直连）', () => {
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
			// 「必须」是反方向的那一半：只有它，文件哪天悄悄改走端口（或多出第五个直连模块）
			// 才会红；没有它，单向禁令分不出「设计变更」与「漏改」
			assert.ok(imports > 0, `${file} 按设计直连 node:fs（宿主 fs 契约无删除能力／读侧枚举与体检遍历不经端口），导入面却没有登记`)
			assert.ok(calls > 0, `${file} 登记了 node:fs 直连却一个调用也没有——导入面与实际用法脱节，这条判定对它空转`)
		} else {
			assert.equal(imports, 0, `${file} 出现 node:fs 导入——它登记为零直连（端口写侧 I/O 只经 fs-port.js，装配层由宿主能力代劳）`)
			assert.equal(calls, 0, `${file} 出现 node:fs 直连调用——它登记为零直连，模块级 helper 同样算`)
		}
	}
})

/**
 * 本地 import 的目标（任意形态：具名/默认/命名空间/副作用/`export *` 从句/动态 import）。
 * 要的是「依赖到谁」，故不按花括号形态过滤；动态 `import('./x.js')` 也是一条边——
 * 漏了它，闭包就停在调用点那一层，而那个文件照样能摸 node:fs。
 */
function localImportTargets(source) {
	const code = stripComments(source)
	return [
		...code.matchAll(/\bfrom\s+'(\.[^']+)'/g),
		...code.matchAll(/\bimport\s+'(\.[^']+)'/g),
		...code.matchAll(/\bimport\s*\(\s*'(\.[^']+)'\s*\)/g),
	].map((match) => match[1])
}

/** 从入口沿本地 import 递归求传递闭包（lib 内相对路径集合，含入口自己）。 */
function localClosure(entry) {
	const seen = new Set()
	const queue = [entry]
	while (queue.length > 0) {
		const file = queue.pop()
		if (seen.has(file)) continue
		seen.add(file)
		for (const specifier of localImportTargets(readLib(file))) queue.push(join(dirname(file), specifier))
	}
	return seen
}

test('memory/write.js 的本地导入闭包零 node:fs（端口写侧 I/O 只经 fs 端口的真实保证）', () => {
	// 逐文件判定只证「本文件零直连」，一进一跳就空转：下游模块里加一行 import node:fs，
	// upsert/edit 的 I/O 立刻能绕过端口，而判定表与行为测试照样全绿。逐跳递归才够到那一层
	const closure = localClosure('memory/write.js')
	// 闭包只剩入口自己时下面那些断言恒真：先把「扫描退化成空转」本身判红，免得闭包断言成假绿
	assert.ok(closure.size > 1, `write.js 的本地导入闭包只有入口自己（${[...closure].join('、')}）——本地 import 扫描退化成空转`)
	for (const file of closure) {
		const source = readLib(file)
		assert.equal(nodeFsImports(source), 0, `${file} 在 write.js 的传递闭包内且 import node:fs——upsert/edit 的 I/O 须只经 fs 端口`)
		assert.equal(nodeFsCalls(source), 0, `${file} 在 write.js 的传递闭包内且直连 node:fs 调用——同上`)
	}
})
