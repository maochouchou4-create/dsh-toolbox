/**
 * dsh-toolbox 的浏览器半：把「识图路由」区块注册进插件页的 plugins.bundle.config 槽
 * （key＝bundle 包名 dsh-toolbox，与宿主半共用 profile 里同一个 cordis 行 id）。
 *
 * 为什么是手写脚本：前端壳给第三方包的不是打包器，而是一张静态模块表——本文件在页面引导期由
 * window.__ModuleLoader__.load({id, factory}) 收走，factory 只拿得到一个受限 require
 * （react／@deepseek-ai/dsh-client-ui-primitives／-store／-slots 等预置包）。故 JSX 与构建步骤
 * 都不在场：界面一律 react.createElement；要加新依赖先确认它在静态表里，否则运行期才炸。
 *
 * 契约面（宿主没有 .d.ts 落盘，签名以宿主实例为旁证，运行期不匹配即停上报）：
 * ① SettingsForm 的 props 恰为 {state, labels, onSave, onDiscard, children}；labels 五键
 *    （unavailable/readOnly/saveFailed/save/saving）由壳直读、无兜底，缺一即渲染期崩。
 * ② SettingsFormModel(scope, specs)：specs 未声明的字段在 field() 上直接抛，故下面全量声明；
 *    actions() 给 {edit, resetField, save, discard}——save() 经 scope.mutate 提交一次版本围栏的
 *    写，失败只置 shell().failed 不抛。
 * ③ 模型目录走 ctx.remote.session.modelCatalog()，结果形状 {ok:true, value:{groups, failures, …}}
 *    或 {ok:false, error}——失败在 ok 里、不抛，故四态要自己分。
 * ④ 模型候选的单选卡片没有现成组件，本页自绘。
 *
 * 词条为什么写在文件里：壳的本地化只读包内 locale/*.json 的 meta.title/description（插件列表
 * 卡片用），字典只认运行期 ctx.locale.register——往 locale/*.json 里另加字典键没有任何读方。
 */
window.__ModuleLoader__.load({
	id: 'dsh-toolbox',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
		const react = require('react')
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

		/** 词条命名空间。 */
		const NS = 'dsh-toolbox.vision-route'
		/** 配置表单命名空间＝profile 里那一行的 id（cordis 条目名）。 */
		const SCOPE_ID = 'dsh-toolbox'
		/** 槽位键＝bundle 包名：插件页按包名查 keyed 槽，configured 台账也用包名。 */
		const PACKAGE_ID = 'dsh-toolbox'
		/** 浏览器半要的 cordis 服务（与 package.json 的 dsh.client.inject 不是一回事：那里是客户端模块图的依赖清单，这里是服务注入面）。 */
		const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']
		/** provider 增删改后模型目录失效（宿主在模型目录变更时广播）。 */
		const MODEL_CATALOG_EVENT = 'llm/adapters-updated'
		/** 自绘卡片与区块的类名；前端壳不带 CSS 管道，样式随组件注入。 */
		const CSS = `
.dstb-vision { display: flex; flex-direction: column; gap: 8px; }
.dstb-vision-heading { color: var(--dsw-alias-label-primary); margin: 0; font-size: 13px; font-weight: 600; line-height: 1.5; }
.dstb-vision-notice { color: var(--dsw-alias-label-secondary); margin: 0; font-size: 12px; line-height: 1.6; }
.dstb-vision-current { color: var(--dsw-alias-label-primary); margin: 0; font-size: 12px; line-height: 1.6; }
.dstb-vision-error { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-error); font-size: 12px; line-height: 1.6; }
.dstb-vision-retry { padding: 2px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; cursor: pointer; }
.dstb-vision-retry:disabled { cursor: not-allowed; opacity: 0.6; }
.dstb-vision-group { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
.dstb-vision-group-name { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 600; line-height: 1.6; }
.dstb-vision-models { display: flex; flex-direction: column; gap: 4px; }
.dstb-vision-model { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; cursor: pointer; }
.dstb-vision-model-selected { border-color: var(--dsw-alias-brand-primary); }
.dstb-vision-model-disabled { cursor: not-allowed; opacity: 0.6; }
.dstb-vision-model-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dstb-vision-model-name { color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.5; }
.dstb-vision-model-route { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.5; }
`
		/** 壳的五键文案：中文。 */
		const zh = {
			unavailable: '该插件当前未加载，暂时无法配置。',
			readOnly: '本部署的设置为只读。',
			saveFailed: '本部署没有接受这些值，已保留供你修改。',
			save: '保存',
			saving: '保存中…',
			visionRouteTitle: '识图路由',
			visionRouteNotice: '图未直达模型时由这条路由转述；保存即生效，无需重启',
			visionRouteCurrent: '当前生效：{provider} / {model}',
			visionRouteLoading: '目录加载中',
			visionRouteLoadFailed: '模型目录加载失败。',
			visionRouteRetry: '重试',
			visionRoutePartial: '{count} 个 provider 目录拉取失败',
			visionRouteCurrentGroup: '当前生效（不在目录中）',
			visionRouteEmpty: '目录里没有任何可选模型。',
		}
		/** 壳的五键文案：英文。 */
		const en = {
			unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
			readOnly: 'This deployment stores settings read-only.',
			saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
			save: 'Save',
			saving: 'Saving…',
			visionRouteTitle: 'Vision routing',
			visionRouteNotice: 'Images that do not reach the model directly are transcribed through this route; saving takes effect immediately, no restart needed.',
			visionRouteCurrent: 'Currently effective: {provider} / {model}',
			visionRouteLoading: 'Loading the catalog',
			visionRouteLoadFailed: 'The model catalog could not be loaded.',
			visionRouteRetry: 'Retry',
			visionRoutePartial: '{count} provider catalog(s) failed to load',
			visionRouteCurrentGroup: 'Currently effective (not in the catalog)',
			visionRouteEmpty: 'No selectable model is listed in the catalog.',
		}

		/**
		 * 路由卡片的控制器：配置句柄（scope）＋模型目录（remote）两处异步源的合流点。
		 *
		 * 投影＝form.shell() 叠上两个字段与目录三态——组件只订阅一个快照源（注入面给的那个 store），
		 * 目录请求的结果因此必须走同一个 store 推出去（目录另起一个 useState 的话，壳的按钮态与
		 * 卡片态会各自刷新，出现「保存亮着但卡片还没换」这种半拍画面）。
		 */
		class VisionRouteCard {
			constructor(scope, ctx) {
				this.ctx = ctx
				this.scope = scope
				// specs 必须覆盖全部可编辑字段：壳的 field() 对未声明字段直接抛，而那是渲染期才炸的错误
				this.form = new primitives.SettingsFormModel(scope, [
					primitives.settingsTextField('visionProvider'),
					primitives.settingsTextField('visionModel'),
				])
				this.catalogStatus = 'idle'
				this.catalogGroups = []
				this.catalogFailures = []
				// 代际号：重试与目录失效重读会让在飞的旧请求作废，回来时不许覆盖新结果
				this.catalogGeneration = 0
				this.disposed = false
				this.snapshot = () => this.projection()
				this.store = this.form.bind(this.snapshot)
			}

			projection() {
				return {
					...this.form.shell(),
					provider: this.form.field('visionProvider'),
					model: this.form.field('visionModel'),
					catalogStatus: this.catalogStatus,
					groups: this.catalogGroups,
					failures: this.catalogFailures,
				}
			}

			publish() {
				this.store.set(this.snapshot())
			}

			async loadCatalog() {
				if (this.disposed || this.catalogStatus === 'loading') return
				const generation = (this.catalogGeneration += 1)
				this.catalogStatus = 'loading'
				this.publish()
				let response
				try {
					response = await this.ctx.remote.session.modelCatalog()
				} catch (error) {
					// 契约是失败进 ok:false、不抛；真抛了按同一态收，不让异常冒进渲染树
					response = { ok: false }
				}
				if (this.disposed || generation !== this.catalogGeneration) return
				if (response.ok) {
					this.catalogGroups = response.value.groups
					this.catalogFailures = response.value.failures
					this.catalogStatus = 'ready'
				} else {
					this.catalogStatus = 'error'
				}
				this.publish()
			}

			/** 用户点「重试」：置回 idle 再拉一次。作废在飞的旧响应归 loadCatalog 里那次代际自增——
			 * 代际号只此一处前进，这里再自增一次只是白跳一代（判据仍是同一个号）。 */
			retryCatalog() {
				if (this.disposed) return
				this.catalogStatus = 'idle'
				this.loadCatalog()
			}

			/** provider 增删改后目录可能变：只在卡片已经拉过目录时才重拉（没打开过设置页的会话不发请求）。 */
			refreshCatalog() {
				if (this.disposed || this.catalogStatus === 'idle') return
				this.retryCatalog()
			}

			/**
			 * 连接重置（重连）：这是一条新连接，在飞的目录响应归属旧连接、旧连接拉到的候选也不再可信。
			 * 清掉候选后按上面那道「已经拉过才重拉」的同一道闸重读，在飞的旧响应由 loadCatalog 前进的
			 * 代际号作废。
			 */
			resetConnection() {
				if (this.disposed) return
				this.catalogGroups = []
				this.catalogFailures = []
				this.refreshCatalog()
			}

			/** 选卡片＝把两个字段一起改（路由是成对的，单选一格会留下半截路由）。 */
			selectRoute(provider, model) {
				const shell = this.form.shell()
				if (this.disposed || !shell.writable || shell.saving) return
				const actions = this.form.actions()
				actions.edit('visionProvider', provider)
				actions.edit('visionModel', model)
			}

			/** 交给壳的注入面：卡片侧只拿到回调，拿不到控制器本身（与壳的契约就是这几个动作）。 */
			face() {
				return {
					hooks: { visionRouteForm: this.store },
					ensureCatalog: () => {
						if (this.catalogStatus === 'idle') this.loadCatalog()
					},
					retryCatalog: () => {
						this.retryCatalog()
					},
					selectRoute: (provider, model) => {
						this.selectRoute(provider, model)
					},
					save: () => {
						this.form.actions().save()
					},
					discard: () => {
						this.form.actions().discard()
					},
				}
			}

			dispose() {
				this.disposed = true
				this.catalogGeneration += 1
				this.form.dispose()
			}
		}

		/**
		 * 出厂识图路由：与路由内缝（lib/see-image/route.js 的 DEFAULT_PROVIDER／DEFAULT_MODEL）必须逐字一致。
		 * 为什么这里是副本而不是 import：浏览器半由宿主按经典脚本收走（<script src> 进页面，工厂只拿得到一个
		 * 受限 require），顶层 import 在这份文件里是语法错误、整个 web 引导起不来；而 require 只认预置包与
		 * dsh.client.inject 声明的模块，取不到包内相对文件。漂移由 test/client.test.js 拦下——那条用例
		 * import route.js 的导出现读对拍页面显示。
		 */
		const FALLBACK_ROUTE = { provider: 'zai-coding-cn', model: 'glm-5.3-flash' }

		/**
		 * 现路由的显示值：与工具那侧的 resolveVisionRoute 同语义——空白回落出厂路由。
		 * 页面照原样显示空白，就会出现「页面说这条路由是空的、工具却按出厂路由跑」的认知分叉，
		 * 而它只在用户清空过字段之后显形（那时最不容易想到是显示层的问题）。
		 */
		function resolveRoute(state) {
			const pick = (text, fallback) => (typeof text === 'string' && text.trim() !== '' ? text : fallback)
			return {
				provider: pick(state.provider.text, FALLBACK_ROUTE.provider),
				model: pick(state.model.text, FALLBACK_ROUTE.model),
			}
		}

		/**
		 * 目录分组行：命中判定在同一趟遍历里记账（判据单源）——另起一个函数对目录扫第二遍时，两处对
		 * 「命中」的看法会分家，症状是同一个路由既在目录里、又多出一组「不在目录中」。
		 * 未就绪态（idle／loading／error）不判 in/out：目录还没到，此刻说「不在目录中」是无根据的断言。
		 */
		function catalogRows(state, selectedRoute) {
			let hit = false
			const rows = state.groups.map((group) => ({
				key: group.id,
				name: group.name,
				entries: group.models.map((entry) => {
					if (group.id === selectedRoute.provider && entry.id === selectedRoute.model) hit = true
					return { key: `${group.id}\u0000${entry.id}`, provider: group.id, model: entry.id, name: entry.name }
				}),
			}))
			return { rows, outside: state.catalogStatus === 'ready' && !hit }
		}

		/** 「当前生效（不在目录中）」那一组：现路由不在候选目录里时并列出来，卡片因此保持选中。 */
		function currentRouteRow(t, selectedRoute) {
			return {
				key: '\u0000current',
				name: t('visionRouteCurrentGroup'),
				entries: [{ key: '\u0000current', provider: selectedRoute.provider, model: selectedRoute.model, name: selectedRoute.model }],
			}
		}

		function renderModelCard(props, entry, selected, disabled, radioName) {
			return react.createElement('label', { className: selected ? 'dstb-vision-model dstb-vision-model-selected' : 'dstb-vision-model', key: entry.key }, [
				react.createElement('input', { type: 'radio', name: radioName, checked: selected, disabled, onChange: () => props.selectRoute(entry.provider, entry.model), key: 'radio' }),
				react.createElement('span', { className: 'dstb-vision-model-text', key: 'text' }, [
					react.createElement('span', { className: 'dstb-vision-model-name', key: 'name' }, entry.name),
					react.createElement('span', { className: 'dstb-vision-model-route', key: 'route' }, `${entry.provider} / ${entry.model}`),
				]),
			])
		}

		function renderGroup(props, row, selectedRoute, disabled, radioName) {
			return react.createElement('div', { className: 'dstb-vision-group', key: row.key }, [
				react.createElement('div', { className: 'dstb-vision-group-name', key: 'name' }, row.name),
				react.createElement('div', { className: 'dstb-vision-models', key: 'models' }, row.entries.map((entry) => renderModelCard(props, entry, entry.provider === selectedRoute.provider && entry.model === selectedRoute.model, disabled, radioName))),
			])
		}

		/**
		 * 目录区：失败四态各自有出口——加载中、整请求失败（带重试）、部分 provider 失败（不吞）、
		 * 目录空；现路由不在目录里时另加一组（见 currentRouteRow）。
		 */
		function renderCatalog(props, state, t, view) {
			const { disabled, radioName, selectedRoute } = view
			const { rows, outside } = catalogRows(state, selectedRoute)
			if (outside) rows.push(currentRouteRow(t, selectedRoute))
			const blocks = []
			if (state.catalogStatus === 'idle' || state.catalogStatus === 'loading') {
				blocks.push(react.createElement('p', { className: 'dstb-vision-notice', role: 'status', key: 'status' }, t('visionRouteLoading')))
			} else if (state.catalogStatus === 'error') {
				blocks.push(react.createElement('div', { className: 'dstb-vision-error', role: 'alert', key: 'status' }, [
					react.createElement('span', { key: 'text' }, t('visionRouteLoadFailed')),
					react.createElement('button', { type: 'button', className: 'dstb-vision-retry', disabled: state.saving, onClick: props.retryCatalog, key: 'retry' }, t('visionRouteRetry')),
				]))
			} else if (state.failures.length > 0) {
				blocks.push(react.createElement('p', { className: 'dstb-vision-notice', key: 'failures' }, t('visionRoutePartial', { count: state.failures.length })))
			} else if (state.groups.length === 0) {
				// 目录 ready 却一个候选都没有：这句与「当前生效」伪组并存——一个说没有可选项，
				// 一个说现在按什么路由跑（现路由另有常驻文本行，不靠这一组兜底）
				blocks.push(react.createElement('p', { className: 'dstb-vision-notice', key: 'empty' }, t('visionRouteEmpty')))
			}
			for (const row of rows) {
				blocks.push(renderGroup(props, row, selectedRoute, disabled, radioName))
			}
			return blocks
		}

		/** 壳的五键文案（键名与壳直读的那五个逐字同名）。 */
		const formLabels = (t) => ({
			unavailable: t('unavailable'),
			readOnly: t('readOnly'),
			saveFailed: t('saveFailed'),
			save: t('save'),
			saving: t('saving'),
		})

		/** 区块组件：包一层壳的 SettingsForm，壳负责按钮、只读提示与错误行。 */
		function VisionRouteSettings(props) {
			const t = props.t
			const state = props.useVisionRouteForm((value) => value)
			const headingId = react.useId()
			const radioName = react.useId()
			// 首帧就要开始拉目录（目录没到之前只剩加载行，卡片无从渲染）；但配置面本身没就绪时
			// 壳只渲染一句「未加载」，那时发请求是白跑，故等 available 再拉。
			react.useEffect(() => {
				if (state.available) props.ensureCatalog()
			}, [props.ensureCatalog, state.available])
			const selectedRoute = resolveRoute(state)
			return react.createElement(
				primitives.SettingsForm,
				{ state, labels: formLabels(t), onSave: props.save, onDiscard: props.discard },
				react.createElement('style', { key: 'css' }, CSS),
				react.createElement('section', { className: 'dstb-vision', 'aria-labelledby': headingId, key: 'section' }, [
					react.createElement('h3', { className: 'dstb-vision-heading', id: headingId, key: 'title' }, t('visionRouteTitle')),
					react.createElement('p', { className: 'dstb-vision-notice', key: 'notice' }, t('visionRouteNotice')),
					// 现路由文本行常驻：目录未就绪时它是唯一的现路由出口（「当前生效」伪组只在目录 ready
					// 后才出现），值走 resolve 语义——与工具那侧现读的同一口径
					react.createElement('p', { className: 'dstb-vision-current', key: 'current' }, t('visionRouteCurrent', selectedRoute)),
					renderCatalog(props, state, t, { disabled: !state.writable || state.saving, radioName, selectedRoute }),
				]),
			)
		}

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-toolbox: 识图路由词条')
			const card = new VisionRouteCard(ctx.configForms.get(SCOPE_ID), ctx)
			ctx.effect(() => () => card.dispose(), 'dsh-toolbox: 识图路由控制器')
			ctx.effect(() => ctx.remote.$on(MODEL_CATALOG_EVENT, () => card.refreshCatalog()), 'dsh-toolbox: 模型目录失效重读')
			// connection/reset 是本地连接事件（宿主重连后在本地 ctx 上 emit），不走 remote 的宿主事件转发面
			ctx.effect(() => ctx.on('connection/reset', () => card.resetConnection()), 'dsh-toolbox: 重连后作废在飞目录请求')
			// whileServed：设置页把插件卡片逐块挂载，块被卸载时注入一并撤销；key 取包名＝插件页的查表键
			ctx.effect(
				() =>
					ctx.configForms.whileServed([SCOPE_ID], () =>
						ctx.slots.inject('plugins.bundle.config', () =>
							ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_ID, locale: NS, inject: () => card.face() }, VisionRouteSettings),
						),
					),
				'dsh-toolbox: 识图路由区块',
			)
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
