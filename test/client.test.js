/**
 * 浏览器半的装配单测：宿主包（react／dsh-client-ui-primitives）在裸仓不可解析，前端壳也不在场，
 * 故这里给 client.js 一副手写的 require 面——它是前端静态模块表的注册脚本，顶层只碰
 * window.__ModuleLoader__，喂一个 window 就能整段取到注册项与 factory。
 *
 * 覆盖接线与四态出口（模块 id 与槽位键都取包名、词条五键齐、spec 键集与宿主半 configShape 的
 * volatile 键集对齐、目录四态各出各的文案、重试与重连作废在飞的旧响应、首帧经 useEffect 真拉目录、
 * 空白值按出厂路由显示），不覆盖视觉呈现——真实页面仍按仓规「待下次启动验证」。
 * 契约面（SettingsForm 的 props/labels、SettingsFormModel 的方法名）以宿主实例为旁证，这里的
 * 替身只实现本页真正用到的那几个方法：替身与宿主分家的地方，正是运行期目检要盯的地方。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../lib/see-image/route.js'
import { LIB_DIR } from './helpers.js'

const NS = 'dsh-toolbox.vision-route'
const 五键 = ['unavailable', 'readOnly', 'saveFailed', 'save', 'saving']

/**
 * 极简 react 替身：createElement 只留形状（type/props/children），够断言文案与层级。
 * useEffect 真调回调——「首帧拉目录」这条接线（useEffect → ensureCatalog）只有真跑才验得到，
 * 空实现顶回去时它是一条怎么改都绿的接线。依赖数组不比：那条 effect 的重跑由 ensureCatalog
 * 自己的守卫兜住（加载中不重发），替身再复刻一遍依赖比较只是把壳的行为抄第二份。
 */
const reactStub = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
	useId: () => 'dstb-id',
	useEffect: (fn) => { fn() },
}

/** 壳的替身：只作标识用——本页交给它的 props 才是要断言的东西。 */
const SettingsFormStub = () => null

/** 装配一次浏览器半：给 client.js 一副 require 面与假 ctx，交出接线各处与槽位组件。 */
function 装配({ modelCatalog } = {}) {
	let registration
	new Function('window', readFileSync(join(LIB_DIR, 'client.js'), 'utf8'))({
		__ModuleLoader__: { load: (entry) => { registration = entry } },
	})
	assert.ok(registration, 'client.js 须在引导期向 window.__ModuleLoader__ 注册自身')
	const specs = []
	class SettingsFormModel {
		constructor(scope, specList) { specs.push(...specList); this.scope = scope }
		bind(snapshot) {
			const store = { value: snapshot(), set: (next) => { store.value = next }, getSnapshot: () => store.value }
			return store
		}
		shell() { return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false } }
		// 逐字照宿主的 field()：只给 {text, overridden, invalid}（没有 value——那是另一套形状的键，
		// 多给一个本页从不读的键，等于让替身比宿主宽、本页真用了它也不会红）
		field(field) { return { text: field === 'visionProvider' ? 'zai-coding-cn' : 'glm-5.3-flash', overridden: false, invalid: false } }
		// 只给本页真调的动作：resetField（清回默认）本页没有出口，留着它只是替身与宿主的形状多一分岔口
		actions() { return { edit: () => {}, save: () => {}, discard: () => {} } }
		dispose() {}
	}
	const exports = registration.factory((name) => {
		if (name === 'react') return reactStub
		if (name === '@deepseek-ai/dsh-client-ui-primitives') return { SettingsForm: SettingsFormStub, SettingsFormModel, settingsTextField: (field) => ({ field }) }
		throw new Error(`意外的 require：${name}`)
	})
	const seen = { handlers: {}, connection: {}, slot: {}, watch: {} }
	const ctx = {
		effect: (fn) => fn(),
		// 两路订阅分开记：本地连接事件走 ctx.on，宿主事件转发面走 remote.$on——记在一处会让
		// 「挂错了总线」也绿，而那条错在运行期只是「重连后目录还是旧的」
		on: (name, handler) => { seen.connection[name] = handler; return () => {} },
		locale: { register: (ns, dicts) => { seen.ns = ns; seen.dicts = dicts; return () => {} } },
		configForms: {
			get: (id) => { seen.scopeId = id; return { id } },
			whileServed: (namespaces, register) => { seen.watch.namespaces = namespaces; seen.watch.off = register(new Set(namespaces)); return () => {} },
		},
		remote: {
			$on: (name, handler) => { seen.handlers[name] = handler; return () => {} },
			session: { modelCatalog: modelCatalog ?? (async () => ({ ok: true, value: { groups: [], failures: [] } })) },
		},
		slots: { inject: (name, fn) => fn(), register: (options, component) => { seen.slot.options = options; seen.slot.component = component; return () => {} } },
	}
	exports.apply(ctx)
	return { registration, exports, specs, seen, face: seen.slot.options.inject() }
}

/** 卡片快照的基线：目录就绪、现值在目录外（用例各自覆盖要测的那一格）。形状逐字照 projection()。 */
const 状态 = (over) => ({
	available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false,
	provider: { text: 'zai-coding-cn', overridden: false, invalid: false },
	model: { text: 'glm-5.3-flash', overridden: false, invalid: false },
	catalogStatus: 'ready', groups: [], failures: [],
	...over,
})

/**
 * 卡片组件收到的 props：快照源、词条读法与动作回调（壳的 props 面由此可断言）。
 * 动作一律取注入面那一份本体而不写空实现——空替身让「接上了」与「没接上」长得一样，而本页真会调
 * 的那条（首帧的 useEffect → ensureCatalog）正是靠它现跑；转交壳的 save／discard 同样按本体比身份。
 */
function 卡片props(装配结果, state) {
	const dict = 装配结果.seen.dicts.zh
	const t = (key, params) => {
		const value = dict[key]
		assert.ok(value !== undefined, `词条 ${key} 不在字典里`)
		return params === undefined ? value : value.replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
	}
	const face = 装配结果.face
	return {
		t,
		useVisionRouteForm: (select) => select(state),
		ensureCatalog: face.ensureCatalog,
		save: face.save,
		discard: face.discard,
	}
}

/** 渲染一次卡片，收集树上所有文案（词条缺键当场报错：壳直读五键，缺一即渲染期崩）。 */
function 文案(装配结果, state) {
	const texts = []
	const walk = (node) => {
		if (typeof node === 'string') texts.push(node)
		else if (Array.isArray(node)) node.forEach(walk)
		else if (node !== null && typeof node === 'object' && node.type !== 'style') walk(node.children)
	}
	walk(装配结果.seen.slot.component(卡片props(装配结果, state)))
	return texts
}

/**
 * 文案收集到的是逐段字符串，`texts.includes(x)` 比的是整段相等。目录未就绪时现路由只出现在常驻
 * 那一行里（「当前生效：A / B」是整段），故跨段找要用这个。
 */
const 有文案 = (texts, 片段) => texts.some((text) => text.includes(片段))

test('浏览器半接线：模块 id／槽位键都取包名，词条五键齐，spec 与宿主半的 volatile 键集对齐', () => {
	const 装配结果 = 装配()
	const { registration, exports, specs, seen, face } = 装配结果
	assert.equal(registration.id, 'dsh-toolbox', '客户端模块 id 取包名（宿主按包名定位客户端包体）')
	assert.deepEqual(exports.inject, ['slots', 'locale', 'remote', 'remote.session', 'configForms'])
	assert.equal(seen.scopeId, 'dsh-toolbox', '配置表单命名空间＝profile 里那一行的 id')
	assert.equal(seen.ns, NS)
	assert.deepEqual(seen.watch.namespaces, ['dsh-toolbox'], '只在宿主服务本行命名空间时挂载区块')
	assert.equal(seen.slot.options.name, 'plugins.bundle.config')
	assert.equal(seen.slot.options.key, 'dsh-toolbox', '槽位键取 bundle 包名：插件页按包名查 keyed 槽')
	assert.equal(seen.slot.options.locale, NS)
	assert.equal(typeof seen.slot.component, 'function')
	// spec 未覆盖的字段在壳的 field() 上直接抛，而那是渲染期才炸的错误
	assert.deepEqual(specs.map((spec) => spec.field), ['visionProvider', 'visionModel'])
	// 键集对齐：宿主半 configShape 里每个 volatile 字段都得有本页的输入框（少一个＝设置页看不见那个
	// 字段、工具却在按它跑），反过来本页声明的字段也必须在 configShape 里（否则壳的 field() 渲染期抛）。
	// 宿主半 import 了宿主包、这里加载不了，故静态读源码抽键集；抽不到东西时先判红，免得空转成绿。
	const 宿主半 = readFileSync(join(LIB_DIR, 'see-image', 'index.js'), 'utf8')
	const volatileKeys = [...宿主半.matchAll(/^\t(\w+):.*\.volatile\(\),?$/gm)].map((match) => match[1])
	assert.ok(volatileKeys.length > 0, 'configShape 的 volatile 键集没抽到（正则与写法脱节）——键集对齐那条断言会空转')
	assert.deepEqual(volatileKeys, specs.map((spec) => spec.field), 'configShape 的 volatile 键集须与本页的 spec 键集一致：一侧加字段而另一侧不知，就等于那个字段在设置页里不存在')
	const keys = Object.keys(seen.dicts.en)
	assert.deepEqual(五键.filter((key) => !keys.includes(key)), [], '壳直读的五键缺一即渲染期崩')
	assert.deepEqual(Object.keys(seen.dicts.zh).sort(), keys.sort(), '中英词条键集须一致')
	// 卡片头部说明行逐字（与工具描述的「路由见插件页·识图路由」互为指路：那侧的同字断言在
	// test/dispatch-assembly.test.js 的识图路由接线用例里）
	assert.equal(seen.dicts.zh.visionRouteTitle, '识图路由')
	assert.equal(seen.dicts.zh.visionRouteNotice, '图未直达模型时由这条路由转述；保存即生效，无需重启')
	// 交给壳的 props 面：labels 五键壳是直读的（缺一即渲染期崩），多传的键壳不认——两边都钉住。
	// 两个动作按身份比：包一层空实现同样能凑出这两个键，而那正是要挡的「接线看着在」
	const 树 = seen.slot.component(卡片props(装配结果, 状态({})))
	assert.deepEqual(Object.keys(树.props).sort(), ['labels', 'onDiscard', 'onSave', 'state'])
	assert.deepEqual(Object.keys(树.props.labels).sort(), [...五键].sort())
	assert.equal(树.props.onSave, face.save, '保存动作原样转交壳，不在中间另包一层')
	assert.equal(树.props.onDiscard, face.discard, '放弃动作同上')
	assert.equal(树.props.state.catalogStatus, 'ready', '整份快照原样交给壳（壳从里面取 available/writable/dirty/invalid/saving/failed）')
	assert.ok(树.children.length > 0, 'children 承载区块内容（样式与区块都在里面）')
})

test('目录四态各自出口：加载中／整请求失败带重试／部分失败不吞／现值不在目录单独一组', () => {
	const 装配结果 = 装配()
	const 现值行 = ['zai-coding-cn / glm-5.3-flash']
	const 在目录 = { id: 'zai-coding-cn', name: 'Z.ai', models: [{ id: 'glm-5.3-flash', name: 'GLM-5.3' }] }
	const 别的组 = { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] }

	const 未开始 = 文案(装配结果, 状态({ catalogStatus: 'idle' }))
	assert.ok(未开始.includes('目录加载中'), 'idle 与加载中共用同一句出口')
	assert.ok(!未开始.includes('当前生效（不在目录中）'), '目录未就绪不判 in/out：此刻说「不在目录中」是无根据的断言')

	const 加载中 = 文案(装配结果, 状态({ catalogStatus: 'loading' }))
	assert.ok(加载中.includes('目录加载中'), '加载中须有出口')
	assert.ok(加载中.includes('图未直达模型时由这条路由转述；保存即生效，无需重启'), '说明行常驻')
	assert.ok(有文案(加载中, 现值行[0]), '目录未就绪时也要看得见现路由（常驻文本行，否则认知断线）')
	assert.ok(!加载中.includes('当前生效（不在目录中）'), '加载中同样不判 in/out')

	const 失败 = 文案(装配结果, 状态({ catalogStatus: 'error' }))
	assert.ok(失败.includes('模型目录加载失败。') && 失败.includes('重试'), '整请求失败须带重试出口')
	assert.ok(有文案(失败, 现值行[0]), '失败态同样要看得见现路由')
	assert.ok(!失败.includes('当前生效（不在目录中）'), '失败态同样不判 in/out——目录没拉到，凭什么说现路由不在里面')

	const 部分失败 = 文案(装配结果, 状态({ groups: [别的组], failures: [{ provider: 'x', message: 'boom' }] }))
	assert.ok(部分失败.includes('1 个 provider 目录拉取失败'), '部分失败不许吞（某分组消失须可解释）')
	assert.ok(部分失败.includes('当前生效（不在目录中）'), '现值不在拉到的目录里＝单独一组')
	assert.ok(部分失败.includes('OpenAI') && 部分失败.includes('openai / gpt-5'), '拉到的分组照常列出')

	const 命中 = 文案(装配结果, 状态({ groups: [在目录] }))
	assert.ok(命中.includes('zai-coding-cn / glm-5.3-flash'), '现值在目录里时按其分组列出')
	assert.ok(!命中.includes('当前生效（不在目录中）'), '命中目录时不得多出「不在目录」组')

	const 空目录 = 文案(装配结果, 状态({ provider: { text: '' }, model: { text: '' } }))
	assert.ok(空目录.includes('目录里没有任何可选模型。'), '目录 ready 却一个候选都没有时须明说')
})

test('空白值走 resolve 语义：字段清空时页面按出厂路由显示（与工具那侧的回落同源）', () => {
	// test/client.test.js 与 lib/see-image/route.js 的这条对拍就是浏览器半那份副本的漂移闸：
	// client.js 拿不到 ESM 相对导入（经典脚本），改了 route.js 而忘了那份副本时，这条红
	const 装配结果 = 装配()
	const 空白 = 文案(装配结果, 状态({
		provider: { text: '   ' },
		model: { text: '' },
		groups: [{ id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5' }] }],
	}))
	assert.ok(有文案(空白, `${DEFAULT_PROVIDER} / ${DEFAULT_MODEL}`), '空白字段按出厂路由显示：页面照原样显示空白＝与工具那侧实际跑的路由分家')
	assert.ok(空白.includes('当前生效（不在目录中）'), '回落到的出厂路由不在拉到的目录里＝单独一组')
})

test('目录请求：加载中不重发，重试作废在飞的旧响应，目录失效只在拉过之后重读', async () => {
	const pending = []
	const { face, seen } = 装配({ modelCatalog: () => new Promise((resolve) => pending.push(resolve)) })
	const store = face.hooks.visionRouteForm
	const 拍 = () => new Promise((resolve) => setTimeout(resolve, 0))

	seen.handlers['llm/adapters-updated']()
	assert.equal(pending.length, 0, '没打开过设置页的会话不发目录请求')
	face.ensureCatalog()
	face.ensureCatalog()
	assert.equal(pending.length, 1, '加载中不重复发请求')
	assert.equal(store.getSnapshot().catalogStatus, 'loading')
	seen.handlers['llm/adapters-updated']()
	assert.equal(pending.length, 2, '拉过之后目录失效要重读')

	pending[0]({ ok: true, value: { groups: [{ id: '旧', name: '旧', models: [] }], failures: [] } })
	await 拍()
	assert.equal(store.getSnapshot().catalogStatus, 'loading', '在飞的旧响应不得改状态')
	assert.deepEqual(store.getSnapshot().groups, [], '在飞的旧响应不得写进候选')

	pending[1]({ ok: true, value: { groups: [{ id: 'zai-coding-cn', name: 'Z.ai', models: [{ id: 'glm-5.3-flash', name: 'GLM-5.3' }] }], failures: [] } })
	await 拍()
	assert.equal(store.getSnapshot().catalogStatus, 'ready')
	assert.equal(store.getSnapshot().groups.length, 1)
})

test('首帧拉目录：区块可用即经 useEffect→ensureCatalog 发请求（未就位不发、加载中不重发）', () => {
	const calls = []
	const 装配结果 = 装配({ modelCatalog: () => { calls.push(1); return new Promise(() => {}) } })
	const store = 装配结果.face.hooks.visionRouteForm

	const 未就位 = 文案(装配结果, 状态({ available: false, catalogStatus: 'idle' }))
	assert.equal(calls.length, 0, '配置面没就位时壳只渲染一句「未加载」，此刻发请求是白跑')
	assert.ok(未就位.includes('目录加载中'), '未就位不渲染目录区')

	文案(装配结果, 状态({ catalogStatus: 'idle' }))
	assert.equal(calls.length, 1, '首帧 available 即拉目录：useEffect → ensureCatalog 这条接线此前零覆盖')
	assert.equal(store.getSnapshot().catalogStatus, 'loading')

	文案(装配结果, 状态({ catalogStatus: 'idle' }))
	assert.equal(calls.length, 1, '已在加载中不重发')
})

test('重连（connection/reset）：清掉候选并重读，在飞的旧响应不许写回', async () => {
	const pending = []
	const { face, seen } = 装配({ modelCatalog: () => new Promise((resolve) => pending.push(resolve)) })
	const store = face.hooks.visionRouteForm
	const 拍 = () => new Promise((resolve) => setTimeout(resolve, 0))

	assert.equal(typeof seen.connection['connection/reset'], 'function', 'connection/reset 须挂在本地事件总线（ctx.on）上——挂错总线时症状只是「重连后目录还是旧的」')
	seen.connection['connection/reset']()
	assert.equal(pending.length, 0, '没打开过设置页的会话不因重连多发请求')

	face.ensureCatalog()
	pending[0]({ ok: true, value: { groups: [{ id: '旧连接', name: '旧连接', models: [] }], failures: [] } })
	await 拍()
	assert.equal(store.getSnapshot().catalogStatus, 'ready', '旧连接的候选先到位')

	seen.connection['connection/reset']()
	assert.equal(pending.length, 2, '拉过目录的会话重连后重读')
	assert.deepEqual(store.getSnapshot().groups, [], '重连先清掉旧连接的候选：旧连接拉到的东西不再可信')
	assert.equal(store.getSnapshot().catalogStatus, 'loading')

	seen.connection['connection/reset']()
	assert.equal(pending.length, 3, '在飞期间再重连照样重读一次')
	pending[1]({ ok: true, value: { groups: [{ id: '旧连接', name: '旧连接', models: [] }], failures: [] } })
	await 拍()
	assert.equal(store.getSnapshot().catalogStatus, 'loading', '在飞的旧响应不得改状态')
	assert.deepEqual(store.getSnapshot().groups, [], '在飞的旧响应不得写进候选')

	pending[2]({ ok: true, value: { groups: [{ id: 'zai-coding-cn', name: 'Z.ai', models: [{ id: 'glm-5.3-flash', name: 'GLM-5.3' }] }], failures: [] } })
	await 拍()
	assert.equal(store.getSnapshot().catalogStatus, 'ready')
	assert.deepEqual(store.getSnapshot().groups.map((group) => group.id), ['zai-coding-cn'])
})
