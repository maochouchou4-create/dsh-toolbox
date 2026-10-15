/**
 * dispatch 纯函数核心单测（node:test，零宿主依赖）：拿真数据（lib/dispatch/data/ 五份 JSON）
 * 跑配对查表、特殊行语义、节奏谓词、brief 装配、参数校验与整份输出。数据与代码的边界由此
 * 可验——改 JSON 即改行为，发测试不依赖宿主（读法沿用仓内先例：node:fs 直读 JSON＋
 * node:test／node:assert/strict，同 test/memory-*.test.js）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	PARAM_FIELDS,
	assembleBrief,
	assembleDispatch,
	computeCombo,
	conditionalConsumers,
	consumedParams,
	dispatchStages,
	matchRhythm,
	placeholderTokens,
	stagesConsuming,
	stageRequires,
	stageVocabulary,
	templateKeyOf,
	validateParams,
} from '../lib/dispatch/core.js'
import { loadDispatchData } from '../lib/dispatch/data.js'

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'dispatch', 'data')
const readData = (name) => JSON.parse(readFileSync(join(dataDir, name), 'utf8'))
const data = {
	forms: readData('forms.json'),
	pairing: readData('pairing.json'),
	templates: readData('templates.json'),
	lifecycle: readData('lifecycle.json'),
	planSpec: readData('plan-spec.json'),
}

const formIds = (combo) => combo.map((entry) => entry.form)

/**
 * 现造的数据经真加载器走一遍再喂 core：core 吃得下不等于加载期放行（阶段表六处专核、模板键
 * 白名单、谓词可达都在加载期），绕过它测「加 stage 只改 JSON」等于给自己一份假信心——那份
 * 数据真装进工具时可能在加载期就被拦下。
 */
const DATA_FILES = ['forms.json', 'pairing.json', 'templates.json', 'lifecycle.json', 'plan-spec.json']

function withLoadedData(edits, run) {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-dispatch-core-'))
	try {
		for (const file of DATA_FILES) writeFileSync(join(dir, file), readFileSync(join(dataDir, file)))
		for (const [file, mutate] of Object.entries(edits ?? {})) {
			const value = JSON.parse(readFileSync(join(dir, file), 'utf8'))
			mutate(value)
			writeFileSync(join(dir, file), JSON.stringify(value))
		}
		return run(loadDispatchData({ dataDir: dir }))
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

/**
 * 未知阶段的报错整句钉死：词表只列本工具真能出稿的四个阶段，另把提交/复盘归给谁说清——照着一份
 * 含出不了稿阶段的名单选阶段，模型只会从「未知 stage」撞到「本工具不装配该阶段」，两道错。
 */
const unknownStageError = (stage) => new RegExp(
	`未知 stage「${stage}」.*能出稿的阶段＝${dispatchStages(data).join('、')}；提交/复盘由 dispatch_batch/dispatch_lessons 服务`,
)

/** 一份过得了校验的施工调用，省得每条用例重复必填项。 */
const construction = (overrides = {}) => ({
	stage: '施工',
	batchType: '纯后端管线批',
	subject: '/home/nvse/code/实施方案/方案.md 批 1',
	intent: '装配 dispatch 工具',
	anchors: ['computeCombo', 'assembleBrief'],
	...overrides,
})

/** 一份过得了校验的方案调用：方案阶段不判批型，只认对象与意图。 */
const planning = (overrides = {}) => ({
	stage: '方案',
	subject: '/home/nvse/code/实施方案/方案.md 批 2',
	intent: '写实施方案',
	...overrides,
})

test('computeCombo：主行命中取该门组合，每形态一句理由（专抓什么即理由）', () => {
	assert.deepEqual(formIds(computeCombo(data, { batchType: '纯后端管线批', stage: '门二' })), [
		'设计七维·终审', '连带面', '性能放大问', '性质测试问', '蜕变关系问',
	])
	assert.deepEqual(formIds(computeCombo(data, { batchType: '纯后端管线批', stage: '门一' })), ['锚点核对', '事实校准', '工程复用'])
	for (const entry of computeCombo(data, { batchType: '纯后端管线批', stage: '门二' })) {
		assert.equal(entry.reason, data.forms.forms.find((form) => form.id === entry.form).catches, `${entry.form} 的理由取自 forms 的 catches`)
		assert.notEqual(entry.reason, '')
	}
})

test('computeCombo：加挂行并集叠加，与主行重复的形态只出一次', () => {
	const combo = computeCombo(data, { batchType: '纯后端管线批', stage: '门二', addons: ['涉鉴权/上传/输入', '大数值/通知批'] })
	assert.deepEqual(formIds(combo), [
		'设计七维·终审', '连带面', '性能放大问', '性质测试问', '蜕变关系问', '安全专项',
	], '大数值/通知批的终审与连带面与主行重复，去重后不出第二份')
	const gate1 = computeCombo(data, { batchType: '纯后端管线批', stage: '门一', addons: ['涉鉴权/上传/输入', '大数值/通知批'] })
	assert.deepEqual(formIds(gate1), ['锚点核对', '事实校准', '工程复用', '安全清单行', '数字口径问'])
})

test('computeCombo：修复批按原批型主行取组合，两个门都缺 baseBatchType 即拒绝', () => {
	assert.deepEqual(formIds(computeCombo(data, { batchType: '修复批', stage: '门二', baseBatchType: '配置/迁移批' })), ['迁移执行核对', '连带面', '蜕变关系问'])
	assert.deepEqual(formIds(computeCombo(data, { batchType: '修复批', stage: '门一', baseBatchType: '纯后端管线批' })), ['锚点核对', '事实校准', '工程复用'])
	assert.throws(() => computeCombo(data, { batchType: '修复批', stage: '门二' }), /baseBatchType/)
	assert.throws(() => computeCombo(data, { batchType: '修复批', stage: '门一' }), /baseBatchType/)
	assert.throws(() => computeCombo(data, { batchType: '修复批', stage: '门二', baseBatchType: '不存在的批型' }), /不是配对表的行名/)
})

test('computeCombo：新功能·形态未定的门一带自带形态，门二才要落点批型', () => {
	assert.deepEqual(formIds(computeCombo(data, { batchType: '新功能·形态未定', stage: '门一' })), ['锚点核对', '第一性原理'])
	assert.deepEqual(formIds(computeCombo(data, { batchType: '新功能·形态未定', stage: '门一', baseBatchType: '用户可见功能批' })), ['锚点核对', '第一性原理'], '门一自带形态优先于 base 行')
	assert.throws(() => computeCombo(data, { batchType: '新功能·形态未定', stage: '门二' }), /baseBatchType/)
	assert.deepEqual(formIds(computeCombo(data, { batchType: '新功能·形态未定', stage: '门二', baseBatchType: '用户可见功能批' })), ['设计七维·终审', '连带面', 'GUI 目检'])
})

test('批型条件必填来自数据不在代码（改配对行的 needsBase／needsRootCause 即改行为，文件不动）', () => {
	const tweaked = structuredClone(data)
	const fixRow = tweaked.pairing.rows.find((row) => row.batchType === '修复批')
	const review = { stage: '门二', batchType: '修复批', subject: 'git diff HEAD~1', intent: '终审' }
	assert.throws(() => validateParams(data, review), /baseBatchType/, '真数据下修复批门二必填 baseBatchType')

	fixRow.needsBase = false
	assert.doesNotThrow(() => validateParams(tweaked, review), 'needsBase 关掉后不再向主会话要 baseBatchType')
	assert.throws(() => computeCombo(tweaked, { batchType: '修复批', stage: '门二' }), /不走门二/, '不再落回 base 行：门二为空且行上未标 needsBase')

	fixRow.gate2 = ['设计七维·终审']
	assert.deepEqual(formIds(computeCombo(tweaked, { batchType: '修复批', stage: '门二' })), ['设计七维·终审'], '自带形态的门列不需要原批型')

	const fixBuild = { ...construction(), batchType: '修复批' }
	assert.throws(() => validateParams(tweaked, fixBuild), /rootCause/, 'needsRootCause 为真时施工 rootCause 必填')
	fixRow.needsRootCause = false
	assert.doesNotThrow(() => validateParams(tweaked, fixBuild), 'needsRootCause 关掉后施工不再要根因分类')
	assert.ok(!assembleBrief(tweaked, fixBuild)[0].text.includes('根因分类'), '同一个开关也决定施工模板是否追加修复增量')
})

test('computeCombo：直做批门二固定双路起步，不带 baseBatchType；门一不成立即拒绝', () => {
	assert.deepEqual(formIds(computeCombo(data, { batchType: '直做批', stage: '门二' })), ['设计七维·终审', '连带面'])
	assert.throws(() => computeCombo(data, { batchType: '直做批', stage: '门一' }), /不走门一/)
})

test('computeCombo：未知批型拒绝出稿并把两类行分清列出（主行可作 batchType、addon 行只走 addons）', () => {
	const rows = data.pairing.rows
	const main = rows.filter((row) => row.kind !== 'addon').map((row) => row.batchType)
	const addons = rows.filter((row) => row.kind === 'addon').map((row) => row.batchType)
	assert.throws(
		() => computeCombo(data, { batchType: '没听过的批型', stage: '门二' }),
		(error) => {
			assert.match(error.message, /不是配对表的行名/)
			assert.match(error.message, new RegExp(`可用主行：${main.join('、')}`), '主行清单逐个点名，供主会话自选')
			assert.match(error.message, new RegExp(`addon 行（用 addons 参数加挂，不作 batchType）：${addons.join('、')}`))
			return true
		},
	)
	assert.throws(() => assembleDispatch(data, construction({ batchType: '没听过的批型' })), /不是配对表的行名/, '施工阶段也过批型这一关，不放行未知批型')
})

test('computeCombo：未知 stage、未知加挂行名、加挂行当主批型都显式拒绝', () => {
	assert.throws(() => computeCombo(data, { batchType: '直做批', stage: '没定过的阶段' }), unknownStageError('没定过的阶段'))
	assert.throws(() => computeCombo(data, { batchType: '直做批', stage: '门二', addons: ['不存在的加挂行'] }), /没有的行名/)
	assert.throws(() => computeCombo(data, { batchType: '涉鉴权/上传/输入', stage: '门二' }), /加挂行不是批型/)
})

test('入参形状错时报出签名本身（只传 params 的错法不该报成 data.pairing undefined）', () => {
	for (const call of [computeCombo, matchRhythm, assembleBrief, assembleDispatch, validateParams]) {
		assert.throws(() => call({ stage: '门二', batchType: '纯后端管线批', subject: 'x', intent: 'y' }), /签名一律是 \(data, params\)/)
	}
})

test('门一 brief：固定段一条不缺（角色句／必读链／横切判据／上报格式／显式指派）', () => {
	const [brief] = assembleBrief(data, { stage: '门一', batchType: '纯后端管线批', subject: '方案.md 批 1', intent: '复核方案形状' })
	assert.equal(brief.form, '锚点核对')
	for (const fragment of [
		'你是方案审计员，逐条核对方案锚点与当前代码是否一致',
		'本批意图一句话：复核方案形状。',
		'对象：方案.md 批 1。',
		'横切判据：- 阈值标定',
		'变异翻红',
		'先读用户级 ~/.dsh/AGENTS.md 全文，再读批次所在仓的 AGENTS.md（无则跳过）；只读禁写',
		'上述两份 AGENTS.md 的工程与注释规范是硬约束（注释只写 why、无日期/批次号叙事；测试只增不删，改写不删）——违反＝返工。',
		'上报格式＝{维度键, 严重度(阻断/建议/Nit), file:line, 现象与证据}',
		'派发时 provider/model 必须显式指派',
	]) {
		assert.ok(brief.text.includes(fragment), `门一 brief 缺固定段「${fragment}」`)
	}
	assert.ok(!brief.text.includes('你是你是'), '模板首行不叠「你是」——role 句自带该前缀')
	assert.ok(!brief.text.includes('〔'), '占位须全部替换，不留半截模板')
})

test('门一与门二同款模板；带 extras 的形态把三件套只附在自己那路', () => {
	const gate2 = assembleBrief(data, { stage: '门二', batchType: '用户可见功能批', subject: 'git diff HEAD~1', intent: '终审实现' })
	assert.ok(gate2.find((brief) => brief.form === 'GUI 目检').text.includes('GUI 目检五组清单'))
	assert.ok(!gate2.find((brief) => brief.form === '连带面').text.includes('GUI 目检五组清单'))
	assert.ok(gate2.every((brief) => brief.text.includes('先读用户级 ~/.dsh/AGENTS.md 全文')))
	const walk = assembleBrief(data, { stage: '门一', batchType: '用户可见功能批', subject: '方案.md', intent: '场景走查' })
	assert.ok(walk.find((brief) => brief.form === '场景走查·升级版').text.includes('出路质量判定'), '场景走查三件套逐字带进那路 brief')
})

test('decisions 空则整行省略，非空则逐条带入', () => {
	const params = { stage: '门二', batchType: '纯后端管线批', subject: 'git diff HEAD~1', intent: '终审' }
	assert.ok(!assembleBrief(data, params)[0].text.includes('拍板清单'), '无拍板可空时该行整体省略')
	const withDecisions = assembleBrief(data, { ...params, decisions: ['拍板 1：零宿主依赖', '拍板 2：判断归主会话'] })[0]
	assert.ok(withDecisions.text.includes('拍板清单（不得重开）：拍板 1：零宿主依赖；拍板 2：判断归主会话。'))
})

test('施工 brief：执行纪律内联在首段、对象行在位，自证与必读链在位，禁区／自验命令可省；修复批追加增量三行', () => {
	const [plain] = assembleBrief(data, construction())
	assert.equal(plain.form, '施工')
	for (const fragment of [
		'方案是未执行先写就的，落点级偏差（锚点行号漂移、现场结构微差、等效更优的局部做法、触及链路内几行级顺势精简）按现场实际施工，不逐字照搬；逐字档内容除外——改它＝设计级冲突，停下上报。',
		'对象（动工前先读对应批次节）：/home/nvse/code/实施方案/方案.md 批 1。',
		'本批意图一句话：装配 dispatch 工具。',
		'锚点（符号名，禁行号）：computeCombo、assembleBrief。',
		'自证：上报必须附自验证据',
		'先读用户级 ~/.dsh/AGENTS.md 全文，再读批次所在仓的 AGENTS.md（无则跳过）。',
		'上述两份 AGENTS.md 的工程与注释规范是硬约束（注释只写 why、无日期/批次号叙事；测试只增不删，改写不删）——违反＝返工。',
		'上报格式＝只报现象＋证据＋影响面事实',
		'裁决类上报必须等裁决再动工',
	]) {
		assert.ok(plain.text.includes(fragment), `施工 brief 缺固定段「${fragment}」`)
	}
	assert.ok(!plain.text.includes('先读 implementation-plan skill'), '方案 skill 已剪切进 plan-spec，施工 brief 不再指它')
	assert.ok(!plain.text.includes('〔'), '占位须全部替换，不留半截模板')
	assert.equal(plain.text.split('\n')[1], '对象（动工前先读对应批次节）：/home/nvse/code/实施方案/方案.md 批 1。', '对象行紧跟执行纪律首段——方案路径不丢在这一趟')
	assert.ok(!plain.text.includes('禁区：'), '禁区空则本行省略')
	assert.ok(!plain.text.includes('自验封顶'), '自验命令空则本行省略')
	assert.ok(!plain.text.includes('根因分类'), '非修复批不加修复增量')

	const [fix] = assembleBrief(data, construction({
		batchType: '修复批',
		rootCause: '错行：特殊行少了 baseBatchType 分支',
		forbidden: '不动 lib/dispatch/data/',
		verifyCmd: 'cd /home/nvse/code/repos/dsh-toolbox && npm test',
	}))
	for (const fragment of [
		'根因分类：错行：特殊行少了 baseBatchType 分支。',
		'红灯先行',
		'本批新增守门断言须变异抽查',
		'禁区：不动 lib/dispatch/data/',
		'自验封顶＝一条受影响单测：cd /home/nvse/code/repos/dsh-toolbox && npm test',
	]) {
		assert.ok(fix.text.includes(fragment), `修复批施工 brief 缺「${fragment}」`)
	}
})

test('validateParams：缺必填点名拒绝（stage 级矩阵＋修复批的 rootCause／baseBatchType）', () => {
	assert.throws(() => validateParams(data, { stage: '施工', batchType: '纯后端管线批', subject: 'x', intent: 'y' }), /anchors/)
	assert.throws(() => validateParams(data, { stage: '施工', batchType: '修复批', subject: 'x', intent: 'y', anchors: ['a'] }), /rootCause/)
	assert.doesNotThrow(() => validateParams(data, { stage: '施工', batchType: '修复批', subject: 'x', intent: 'y', anchors: ['a'], rootCause: '错行' }), '组合门在门一/门二，施工这一趟不消费 baseBatchType')
	assert.throws(() => validateParams(data, { stage: '门一', batchType: '纯后端管线批', subject: 'x' }), /intent/)
	assert.throws(() => validateParams(data, { stage: '没定过的阶段', batchType: '纯后端管线批' }), /未知 stage/)
	assert.doesNotThrow(() => validateParams(data, { stage: '门一', batchType: '新功能·形态未定', subject: 'x', intent: 'y' }), '门一自带形态、不落回 base 行，故不要 baseBatchType')
	assert.doesNotThrow(() => validateParams(data, { stage: '门二', batchType: '直做批', subject: 'x', intent: 'y' }), '直做批行无 needsBase')
	assert.doesNotThrow(() => validateParams(data, construction()))
})

test('matchRhythm：谓词两侧都验（修复批二轮／机械搬运免派／Flash 拆批／未传 provider 不出 Flash）', () => {
	assert.ok(matchRhythm(data, { batchType: '修复批', stage: '门二' }).some((note) => note.includes('默认二轮复核')))
	assert.ok(matchRhythm(data, { batchType: '机械搬运/小修', stage: '门二' }).some((note) => note.includes('小批免派')))
	assert.ok(!matchRhythm(data, { batchType: '机械搬运/小修', stage: '门二' }).some((note) => note.includes('默认二轮复核')), '谓词互斥：修复批那条不该命中机械搬运批')
	assert.ok(matchRhythm(data, { batchType: '直做批', stage: '门二' }).some((note) => note.includes('终审不可替代批内双路')), 'stage=门二 的终审条目独立命中')

	const flash = matchRhythm(data, { batchType: '纯后端管线批', stage: '施工', provider: 'minimax-cn' })
	assert.ok(flash.some((note) => note.includes('Flash 施工批只设上限')))
	assert.ok(flash.some((note) => note.includes('机器门前置')), '多命中全出：stage 与 provider 两条同时命中')

	const noProvider = matchRhythm(data, { batchType: '纯后端管线批', stage: '施工' })
	assert.ok(!noProvider.some((note) => note.includes('Flash')), '未传 provider 时含 provider 字段的条目不命中')
	assert.ok(noProvider.some((note) => note.includes('机器门前置')))
	assert.deepEqual(matchRhythm(data, { stage: '方案' }), [], '无命中输出空数组')
	assert.ok(matchRhythm(data, { batchType: '纯后端管线批', stage: '门一' }).some((note) => note.includes('施工走查')), '门一通用提示：大工程方案走查加挂')
})

test('施工阶段：combo 出空（复核组合是复核阶段的产物，门二调用时现取），brief 与 rhythm 照常', () => {
	const output = assembleDispatch(data, construction())
	assert.deepEqual(output.combo, [], '施工不预告复核组合')
	assert.equal(output.briefs.length, 1, '施工模板不带角色句，逐形态渲染只会产出多份逐字相同的文本')
	assert.equal(output.briefs[0].form, '施工')
	assert.ok(output.rhythm.some((note) => note.includes('机器门前置')), 'rhythm 照常输出〔机器门句〕')
})

test('assembleDispatch：总结构齐、裁决五条随所有 stage 返回、行号锚点机器告警', () => {
	const output = assembleDispatch(data, construction({ anchors: ['lib/dispatch/core.js:42', 'computeCombo'] }))
	assert.deepEqual(Object.keys(output), ['combo', 'briefs', 'rhythm', 'checklist', 'rejected', 'warnings', 'adjudication'])
	assert.equal(output.adjudication.length, 5)
	assert.ok(output.adjudication[0].includes('findings 无 evidence'))
	assert.ok(output.adjudication.some((line) => line.includes('最大化口径')))
	assert.deepEqual(output.rejected, data.forms.rejected)
	assert.equal(output.checklist.length, 5, '自检抬头＋四条逐条')
	assert.ok(output.checklist.some((line) => line.startsWith('①')))
	assert.equal(output.warnings.length, 1)
	assert.ok(output.warnings[0].includes('lib/dispatch/core.js:42'), '行号锚点逐条点名')
	assert.equal(assembleDispatch(data, construction()).warnings.length, 0, '符号名锚点不告警')

	const review = assembleDispatch(data, { stage: '门二', batchType: '纯后端管线批', subject: 'git diff HEAD~1', intent: '终审' })
	assert.equal(review.adjudication.length, 5, '裁决段不随阶段变')
	assert.equal(review.briefs.length, 5, '门二逐形态一路')
	assert.deepEqual(review.warnings, [], '门二无 anchors 参数，不产出锚点告警')
	assert.throws(() => assembleDispatch(data, { stage: '施工', batchType: '纯后端管线批', subject: 'x' }), /intent、anchors/)
})

/**
 * 深冻：把「core 不改传入的数据」从口头承诺变成可验事实（模块是严格模式，冻结后任何写入
 * 直接抛）。喂进去的是规则面本身，被调用方改坏了＝下一次调用出稿跟着变，且没有报错。
 */
const deepFreeze = (value) => {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const entry of Object.values(value)) deepFreeze(entry)
		Object.freeze(value)
	}
	return value
}

test('B1：施工不消费 baseBatchType（传了即报错并点名哪些阶段消费它），门一/门二的 needsBase 照旧', () => {
	const constructionFix = { stage: '施工', batchType: '修复批', subject: 'x', intent: 'y', anchors: ['a'], rootCause: '错行' }
	assert.throws(
		() => validateParams(data, { ...constructionFix, baseBatchType: '纯后端管线批' }),
		/^Error: stage=施工 不消费 baseBatchType——消费它的是门一\/门二\+needsBase 批型（新功能·形态未定、修复批），删掉它或改调那一类$/,
		'错文案整句钉死：模型照着改就能改对，且点名是从现算的槽位消费集里取的，不是手抄的阶段名单',
	)
	assert.throws(() => assembleBrief(data, { ...constructionFix, baseBatchType: '纯后端管线批' }), /不消费 baseBatchType/)
	assert.throws(() => assembleDispatch(data, { ...constructionFix, baseBatchType: '纯后端管线批' }), /不消费 baseBatchType/)
	assert.deepEqual(formIds(computeCombo(data, constructionFix)), [], '施工不出组合，也就不该要原批型')
	for (const stage of ['门一', '门二']) {
		assert.throws(() => validateParams(data, { stage, batchType: '修复批', subject: 'x', intent: 'y' }), /baseBatchType/, `${stage} 修复批仍按 needsBase 要原批型`)
		assert.doesNotThrow(() => validateParams(data, { stage, batchType: '修复批', subject: 'x', intent: 'y', baseBatchType: '纯后端管线批' }))
	}
	assert.deepEqual(formIds(computeCombo(data, { stage: '门一', batchType: '新功能·形态未定', subject: 'x', intent: 'y' })), ['锚点核对', '第一性原理'], '门一自带形态，仍不落回 base 行')
})

test('B3：行上的 formNotes 限定只附在命中那个形态的那路（跨端契约批门二的连带面路带双仓口径，别路不带）', () => {
	const gate2 = assembleBrief(data, { stage: '门二', batchType: '跨端契约批', subject: 'git diff HEAD~1', intent: '终审契约' })
	const lianchulian = gate2.find((brief) => brief.form === '连带面')
	const role = data.forms.forms.find((form) => form.id === '连带面').role
	assert.equal(data.pairing.rows.find((row) => row.batchType === '跨端契约批').formNotes.连带面, '按双仓口径执行——契约两侧的仓都要 grep，不只 grep 改动侧')
	assert.ok(lianchulian.text.startsWith(`${role}\n批型限定：按双仓口径执行——契约两侧的仓都要 grep，不只 grep 改动侧。`), '限定句紧跟角色句，在它作用的位置上')
	assert.ok(!gate2.find((brief) => brief.form === '契约一致性').text.includes('双仓'), '限定句只安在该形态那路，不污染同一门里的其他形态')
	assert.ok(!assembleBrief(data, { stage: '门二', batchType: '用户可见功能批', subject: 'x', intent: 'y' }).find((brief) => brief.form === '连带面').text.includes('双仓'), '别的批型行不共享这条限定')
})

test('槽位对称：addons 只收加挂行，baseBatchType 只收主行（原批型是加挂行＝解析走不通即报错）', () => {
	assert.throws(() => computeCombo(data, { stage: '门二', batchType: '纯后端管线批', addons: ['配置/迁移批'] }), /「配置\/迁移批」是主批型\/特殊行——addons 只收加挂行/)
	assert.throws(() => computeCombo(data, { stage: '门二', batchType: '纯后端管线批', addons: ['修复批'] }), /addons 只收加挂行/)
	assert.throws(() => computeCombo(data, { stage: '门二', batchType: '修复批', baseBatchType: '涉鉴权/上传/输入' }), /baseBatchType「涉鉴权\/上传\/输入」是加挂行不是主批型/)
})

test('类型边界：必填槽位传非字符串、列表槽位传 null／非数组都点名报错，不抛裸 TypeError', () => {
	for (const [params, field] of [
		[{ stage: '门一', batchType: '纯后端管线批', subject: 0, intent: 'y' }, 'subject'],
		[{ stage: '门一', batchType: '纯后端管线批', subject: false, intent: 'y' }, 'subject'],
		[{ stage: '门一', batchType: '纯后端管线批', subject: { a: 1 }, intent: 'y' }, 'subject'],
		[{ stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: ['y'] }, 'intent'],
	]) {
		assert.throws(() => validateParams(data, params), new RegExp(`参数「${field}」须是字符串`), `${JSON.stringify(params[field])} 要点名说清类型边界`)
	}
	for (const field of ['addons', 'decisions', 'anchors']) {
		for (const value of [null, '涉鉴权/上传/输入', { a: 1 }, ['ok', 7]]) {
			const params = { stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: 'y' }
			if (field === 'anchors') params.stage = '施工'
			params[field] = value
			assert.throws(() => validateParams(data, params), new RegExp(`参数「${field}」须是字符串数组`), `${field}=${JSON.stringify(value)} 要点名报错`)
		}
	}
	assert.throws(() => assembleBrief(data, { stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: 'y', decisions: '拍板 1' }), /参数「decisions」须是字符串数组/)
})

test('模板一行里出现多个「空则本行」可选占位＝报错（这行删不删没有唯一答案，渲染器不替模板取舍）', () => {
	const twisted = structuredClone(data)
	twisted.templates.门一 = twisted.templates.门一.replace('〔decisions 逐条；空则本行整体省略〕。', '〔decisions 逐条；空则本行整体省略〕。〔forbidden；空则本行省略〕')
	assert.throws(() => assembleBrief(twisted, { stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: 'y' }), /多个「空则本行」可选占位/)
})

test('P2 combo 与 briefs 逐字对齐：门一/门二每个形态组合恰好一路 brief，加挂后仍对齐', () => {
	for (const [stage, batchType] of [
		['门一', '纯后端管线批'], ['门一', '跨端契约批'], ['门一', '新功能·形态未定'],
		['门二', '用户可见功能批'], ['门二', '配置/迁移批'], ['门二', '机械搬运/小修'],
	]) {
		const params = { stage, batchType, subject: 'x', intent: 'y' }
		assert.deepEqual(formIds(computeCombo(data, params)), assembleBrief(data, params).map((brief) => brief.form), `${stage}/${batchType} 组合与 brief 路由一一对应`)
	}
	const addoned = { stage: '门二', batchType: '纯后端管线批', subject: 'x', intent: 'y', addons: ['涉鉴权/上传/输入'] }
	assert.deepEqual(formIds(computeCombo(data, addoned)), assembleBrief(data, addoned).map((brief) => brief.form), '加挂增的路在 brief 里也在')
})

test('P3/P4 加挂单调且幂等：combo(A) ⊆ combo(A∪B)，重复加挂与加挂顺序都不改结果', () => {
	const base = { stage: '门二', batchType: '纯后端管线批', subject: 'x', intent: 'y' }
	const alone = formIds(computeCombo(data, base))
	const both = formIds(computeCombo(data, { ...base, addons: ['涉鉴权/上传/输入', '大数值/通知批'] }))
	assert.ok(alone.every((form) => both.includes(form)), '加挂只增不减')
	assert.deepEqual(both, formIds(computeCombo(data, { ...base, addons: ['大数值/通知批', '涉鉴权/上传/输入'] })), '加挂顺序无关')
	assert.deepEqual(both, formIds(computeCombo(data, { ...base, addons: ['涉鉴权/上传/输入', '大数值/通知批', '涉鉴权/上传/输入'] })), '重复加挂幂等')
	assert.deepEqual(alone, formIds(computeCombo(data, base)), '读同一份数据两次结果一致')
})

test('MU13 加挂只增路不改路：加挂后主行已生成那路 brief 逐字不变', () => {
	const base = { stage: '门二', batchType: '纯后端管线批', subject: 'git diff HEAD~1', intent: '终审' }
	const before = assembleBrief(data, base)
	const after = assembleBrief(data, { ...base, addons: ['涉鉴权/上传/输入', '大数值/通知批'] })
	assert.ok(after.length > before.length, '加挂确实增了路')
	for (const brief of before) {
		assert.deepEqual(after.find((entry) => entry.form === brief.form), brief, `${brief.form} 那路逐字不变（加挂不许顺手改别人的 brief）`)
	}
})

test('P6 role 归属：全部 21 个形态都扫一遍——该形态那路 brief 以本形态 role 句起头', () => {
	// 两个预期孤儿（设计七维、证伪复核）配对表没有行引用，借一条收容行把它们扫进来，
	// 否则「角色句取成别的形态」这件事在它们身上永远无人验
	const swept = structuredClone(data)
	swept.pairing.rows.push({ batchType: '孤儿收容批', gate1: ['设计七维', '证伪复核'], gate2: [] })
	const seen = new Set()
	// 主行各走一趟；加挂行不作 batchType（那是槽位对称那条用例），改由主行把它加挂进来
	const sweepCalls = swept.pairing.rows.flatMap((row) => (row.kind === 'addon'
		? [{ batchType: '纯后端管线批', addons: [row.batchType] }]
		: [{ batchType: row.batchType }]))
	for (const call of sweepCalls) {
		for (const stage of ['门一', '门二']) {
			const params = { stage, subject: 'x', intent: 'y', ...call }
			// baseBatchType 按消费集给：这一趟不消费它时传了会被契约拒（这条扫的是形态归属，不是契约）
			if (consumedParams(swept, stage, call.batchType).has('baseBatchType')) params.baseBatchType = '纯后端管线批'
			let briefs
			try {
				briefs = assembleBrief(swept, params)
			} catch (error) {
				assert.match(error.message, /不走门|加挂行不是批型|baseBatchType|无可派组合/, `角色归属扫描遇到非预期报错：${error.message}`)
				continue
			}
			for (const brief of briefs) {
				const entry = swept.forms.forms.find((form) => form.id === brief.form)
				assert.ok(brief.text.startsWith(entry.role), `${brief.form} 那路应以本形态 role 起头，实得「${brief.text.slice(0, 12)}…」`)
				seen.add(brief.form)
			}
		}
	}
	assert.equal(seen.size, 21, `全部 21 个形态都被扫到，实扫 ${seen.size}：${[...swept.forms.forms.map((form) => form.id)].filter((id) => !seen.has(id)).join('、')}`)
})

test('P7 占位残留：主行×三个判批型阶段全组合扫，加方案阶段单扫一次；渲染结果里不留占位、未替换值与 null 拼串', () => {
	const residues = ['〔', '〕', 'undefined', 'null', '[object Object]']
	const mainRows = data.pairing.rows.filter((row) => row.kind !== 'addon')
	let rendered = 0
	const rejected = []
	for (const row of mainRows) {
		for (const stage of ['门一', '门二', '施工']) {
			// 按各阶段真正消费的槽位给参（现算，不手抄）：多给一个没消费的槽位会被契约拒，
			// 扫组合得按契约给，否则全红在无关的原因上
			const values = { batchType: row.batchType, subject: '方案.md 批 1', intent: '扫全组合', anchors: ['computeCombo'], rootCause: '错行：占位没替换', baseBatchType: '纯后端管线批' }
			const params = { stage }
			for (const slot of consumedParams(data, stage, row.batchType)) {
				if (slot in values) params[slot] = values[slot]
			}
			try {
				for (const brief of assembleDispatch(data, params).briefs) {
					for (const residue of residues) {
						assert.ok(!brief.text.includes(residue), `${stage}/${row.batchType}/${brief.form} 的 brief 残留「${residue}」`)
					}
				}
				rendered += 1
			} catch (error) {
				rejected.push(`${stage}/${row.batchType}：${error.message}`)
			}
		}
	}
	assert.equal(rendered, 22, `主行 8×3 阶段＝24 组合，去掉「这一趟不走该门」的两个`)
	assert.deepEqual(rejected.map((entry) => entry.split('：')[0]), ['门一/机械搬运/小修', '门一/直做批'], '且只有这两个组合该被拒')

	const taskBook = assembleDispatch(data, planning()).briefs[0].text
	for (const residue of residues) {
		assert.ok(!taskBook.includes(residue), `方案任务书残留「${residue}」——13 节正文与自查清单都该逐字替换进来`)
	}
})

test('P9 必填全枚举：每个必填槽位单独删掉都点名（stage 级＋批型条件级），空数组与空白串同样算缺', () => {
	for (const [stage, batchType, required] of [
		['门一', '纯后端管线批', ['batchType', 'subject', 'intent']],
		['门二', '纯后端管线批', ['batchType', 'subject', 'intent']],
		['施工', '纯后端管线批', ['batchType', 'subject', 'intent', 'anchors']],
		['门二', '修复批', ['baseBatchType']],
		['施工', '修复批', ['rootCause']],
	]) {
		for (const field of required) {
			// 基线参数＝该阶段消费的那一套：多给一个不消费的槽位，报错会点名它而不是缺的那个字段
			const values = { batchType, subject: 'x', intent: 'y', anchors: ['a'], baseBatchType: '纯后端管线批', rootCause: '错行' }
			const params = { stage }
			for (const [slot, value] of Object.entries(values)) {
				if (consumedParams(data, stage, batchType).has(slot)) params[slot] = value
			}
			delete params[field]
			assert.throws(() => validateParams(data, params), new RegExp(`缺必填参数：${field}`), `${stage}/${batchType} 缺 ${field} 要被点名`)
		}
	}
	assert.throws(() => validateParams(data, { stage: '施工', batchType: '纯后端管线批', subject: 'x', intent: 'y', anchors: [] }), /缺必填参数：anchors/, '空数组算缺，不让模板渲染出「锚点：」空行')
	assert.throws(() => validateParams(data, { stage: '门一', batchType: '纯后端管线批', subject: '   ', intent: 'y' }), /缺必填参数：subject/, '空白串算缺')
})

test('P10 模板与必填矩阵对齐：每阶段模板的非可选占位都落在该阶段的必填槽位上（否则必有一处静默渲染空段）', () => {
	// 这些占位的值不来自本次调用：形态角色句取自 forms.json、下文四条原文取自 templates.横切判据、
	// 两条 plan-spec 占位取自 plan-spec.json（方案任务书正文与自查清单都在那份数据里）
	const dataBacked = ['形态角色句', '下文四条原文', 'plan-spec']
	for (const stage of dispatchStages(data)) {
		const allowed = [...stageRequires(data, stage), ...dataBacked]
		for (const token of placeholderTokens(data.templates[templateKeyOf(data, stage)])) {
			if (token.includes('空则本行')) continue
			assert.ok(
				allowed.some((slot) => token.startsWith(slot)),
				`${stage} 模板的占位〔${token}〕不在该阶段的必填槽位与数据源占位里：${allowed.join('、')}`,
			)
		}
	}
	const planRow = data.lifecycle.stages.find((row) => row.id === '方案')
	assert.equal(templateKeyOf(data, '方案'), planRow.templateKey, '模板键取自 lifecycle 那行的 templateKey（键名与阶段不同名的那一档写在数据里）')
	assert.ok(!data.lifecycle.stages.some((row) => row.id === '门一' && 'templateKey' in row), '门一那行不写 templateKey')
	assert.equal(templateKeyOf(data, '门一'), '门一', '没写 templateKey 的行缺省用 stage id——代码里不再有键名表')
	assert.deepEqual(stageRequires(data, '施工'), ['batchType', 'subject', 'intent', 'anchors'], '施工比门阶段多 anchors 一项')
	assert.deepEqual(stageRequires(data, '门一'), stageRequires(data, '门二'), '两个门阶段必填项相同')
	assert.deepEqual(stageRequires(data, '方案'), ['subject', 'intent'], '方案阶段不判批型，必填只有对象与意图')
	assert.deepEqual(stageVocabulary(data), ['方案', '门一', '施工', '门二', '提交', '复盘'], '阶段词表按 lifecycle 的 order 排')
	assert.deepEqual(dispatchStages(data), ['方案', '门一', '施工', '门二'], '提交/复盘归另两个工具，本工具不出稿的阶段不列进可服务清单')
	assert.throws(() => stageRequires(data, '没定过的阶段'), /未知 stage/)
})

test('P11/P12 rhythm：放宽谓词命中变多不放宽、结果与无关参数无关、多字段须同时命中', () => {
	const scoped = { batchType: '修复批', stage: '门一' }
	const narrowed = matchRhythm(data, scoped)
	assert.ok(narrowed.some((note) => note.includes('默认二轮复核')), '批型谓词命中')
	assert.ok(!matchRhythm(data, { ...scoped, batchType: '纯后端管线批' }).some((note) => note.includes('默认二轮复核')), '谓词不命中就不出')

	const widened = structuredClone(data)
	const fixEntry = widened.pairing.rhythm.find((entry) => entry.when.batchType?.includes('修复批'))
	delete fixEntry.when
	const relaxed = matchRhythm(widened, scoped)
	assert.ok(relaxed.includes(fixEntry.note), '去掉谓词＝放宽，命中集合只增不减')
	assert.ok(narrowed.every((note) => relaxed.includes(note)), '放宽后原先命中的仍在（单调）')

	const review = { stage: '门二', batchType: '纯后端管线批', subject: 'x', intent: 'y' }
	assert.deepEqual(
		matchRhythm(data, review),
		matchRhythm(data, { ...review, subject: '换了对象', intent: '换了意图', anchors: ['computeCombo'], decisions: ['拍板'], provider: '其他路线' }),
		'节奏提示只看谓词字段，别人的参数改了它不动',
	)

	const and = structuredClone(data)
	and.pairing.rhythm.push({ when: { batchType: ['纯后端管线批'], stage: ['门二'] }, note: 'AND 探测条目' })
	const hits = (params) => matchRhythm(and, params).some((note) => note === 'AND 探测条目')
	assert.ok(hits({ stage: '门二', batchType: '纯后端管线批' }), '两个在字段都命中才出')
	assert.ok(!hits({ stage: '门一', batchType: '纯后端管线批' }), 'stage 不合即不出')
	assert.ok(!hits({ stage: '门二', batchType: '用户可见功能批' }), 'batchType 不合即不出')
	assert.ok(matchRhythm(data, { stage: '门一', batchType: '纯后端管线批' }).every((note) => note.includes('施工走查')), '真数据里门一纯后端管线批只命中走查通用提示（放宽基线也随之更新）')
})

test('P15 core 无突变：数据深冻后五个入口都不抛；rejected 是拷贝，调用方改不动规则面', () => {
	const frozen = deepFreeze(structuredClone(data))
	assert.doesNotThrow(() => validateParams(frozen, { stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: 'y' }))
	assert.doesNotThrow(() => computeCombo(frozen, { stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: 'y' }))
	assert.doesNotThrow(() => matchRhythm(frozen, { stage: '门二', batchType: '纯后端管线批', subject: 'x', intent: 'y' }))
	assert.doesNotThrow(() => assembleBrief(frozen, { stage: '门二', batchType: '纯后端管线批', subject: 'x', intent: 'y' }))
	const output = assembleDispatch(frozen, construction())
	assert.ok(Array.isArray(output.rejected))
	assert.deepEqual(output.rejected, frozen.forms.rejected)
	output.rejected.push('调用方塞进来的私货')
	assert.deepEqual(assembleDispatch(frozen, construction()).rejected, frozen.forms.rejected, 'rejected 是拷贝，输出侧推不动规则面')
	assert.ok(!frozen.forms.rejected.includes('调用方塞进来的私货'))
})

test('P17 重入幂等：同一份 params 连续两次装配逐字一致（没有随机／时间／隐藏状态）', () => {
	const params = { stage: '门二', batchType: '用户可见功能批', subject: 'git diff HEAD~1', intent: '终审', decisions: ['拍板 1'], addons: ['大数值/通知批'] }
	assert.deepEqual(assembleBrief(data, params), assembleBrief(data, params))
	assert.deepEqual(assembleDispatch(data, params), assembleDispatch(data, params))
	assert.deepEqual(computeCombo(data, params), computeCombo(data, params))
	assert.deepEqual(matchRhythm(data, params), matchRhythm(data, params))
})

test('方案装配：13 节规范逐字成文、自查 11 条、单路「方案任务书」，combo/rhythm 空', () => {
	const output = assembleDispatch(data, planning())
	assert.deepEqual(output.combo, [], '方案无配对组合——出方案前还没有批型可判')
	assert.deepEqual(output.rhythm, [], '节奏谓词都指向复核/施工阶段，方案这一趟无命中')
	assert.equal(output.briefs.length, 1, '单路出稿：任务书不是形态，逐形态渲染只会产出多份逐字相同的文本')
	const [taskBook] = output.briefs
	assert.equal(taskBook.form, '方案任务书')
	assert.equal(taskBook.text.match(/^## .*$/gm).length, 13, '13 节各起一个标题')
	for (const block of data.planSpec.blocks) {
		assert.ok(taskBook.text.includes(block.title), `方案任务书缺节「${block.title}」`)
		assert.ok(taskBook.text.includes(block.text.slice(0, 10)), `节「${block.title}」的正文没渲染进来`)
	}
	assert.deepEqual(taskBook.text.match(/^## .*$/gm), data.planSpec.blocks.map((block) => `## ${block.title}`), '节序＝blocks 的 title 序列逐项相等（重排/丢节/多节都红），相邻块以空行分隔')
	assert.ok(taskBook.text.includes('本批意图一句话：写实施方案。'), '意图注入在末尾')
	assert.ok(taskBook.text.includes('对象与落点：/home/nvse/code/实施方案/方案.md 批 2。'), '对象与落点注入在末尾')
	assert.ok(!taskBook.text.includes('〔'), '两条 plan-spec 占位都换成正文，不留半截模板')

	const checklistAnchor = '写完过定稿自查：'
	const checklistEnd = taskBook.text.indexOf(checklistAnchor) + checklistAnchor.length
	const checklistText = data.planSpec.checklist.join('\n')
	// 模板尾那个句号与末条自带的终止符叠成连续终止符，归一压回自带那个——末条自带问号即不加句号
	const expectedTail = checklistText + (/[。？！!?]$/.test(checklistText) ? '' : '。')
	assert.equal(
		taskBook.text.slice(checklistEnd),
		expectedTail,
		'自查段＝checklist 数组逐条 join 的整串：挤成一段（join(空串)）、改动一条或多挂一句都红',
	)
	assert.deepEqual(output.checklist, data.planSpec.checklist, '11 条逐条成行，不重排不丢条')
	assert.ok(!output.checklist.some((line) => line.includes('锚点全部亲核过吗')), '派 brief 的自检四条不混进方案自查')
	assert.ok(taskBook.text.includes('执行纪律全文随施工 brief 固定段下发'), '拍板后的执行节改指 brief 固定段，不再随任务书复述全文')
	assert.ok(!taskBook.text.includes('落点级偏差（锚点行号漂移'), '执行纪律全文只在施工 brief 固定段留一份——双副本等于改一处漏一处')
	assert.ok(!taskBook.text.includes('不依赖 brief 转述'), '何时写那节的反向句也已翻转')

	assert.throws(
		() => assembleDispatch(data, { stage: '复盘', subject: 'x', intent: 'y' }),
		/stage「复盘」本工具不装配该阶段.*该行 uses 指的载体＝dispatch_lessons/,
		'lifecycle 里有、但本工具还没有模板的阶段（提交/复盘）fail fast 并指向归哪个工具，不让模型去补模板',
	)
	assert.throws(() => assembleDispatch(data, { stage: '提交', subject: 'x', intent: 'y' }), /stage「提交」本工具不装配该阶段/)
})

test('lifecycle 是 stage 词表单源：不在表里的阶段一律点名拒绝，错误带出整份词表', () => {
	const unknown = { stage: '评审', batchType: '纯后端管线批', subject: 'x', intent: 'y' }
	const rejected = unknownStageError('评审')
	for (const call of [computeCombo, validateParams, assembleBrief, assembleDispatch]) {
		assert.throws(() => call(data, unknown), rejected, `${call.name} 要按词表拒绝未注册的阶段`)
	}
	assert.deepEqual(matchRhythm(data, unknown), [], '节奏提示只按谓词命中，不过词表校验——未注册的阶段自然无命中')
})

test('requires 参数校验：门一缺 subject 拒绝；方案阶段传 batchType 拒绝（那一趟不判批型）', () => {
	assert.throws(() => validateParams(data, { stage: '门一', batchType: '纯后端管线批', intent: 'y' }), /缺必填参数：subject/)
	assert.doesNotThrow(() => validateParams(data, planning()), '方案只要对象与意图')
	assert.throws(
		() => validateParams(data, planning({ batchType: '纯后端管线批' })),
		/stage=方案 不消费 batchType——消费它的是门一\/施工\/门二阶段，删掉它或改调其中之一/,
		'不消费的槽位收到值即报错：静默忽略等于让调用方以为判了批型',
	)
	assert.throws(() => assembleDispatch(data, planning({ batchType: '纯后端管线批' })), /不消费 batchType/)
	assert.throws(() => assembleDispatch(data, planning({ batchType: '没听过的批型' })), /不消费 batchType/, '先按「不消费」拒，不按「未知批型」拒——两种错法混起来调用方会改错方向')
	assert.doesNotThrow(() => validateParams(data, construction()), '施工判批型，传得')
	assert.throws(() => validateParams(data, planning({ subject: '   ' })), /缺必填参数：subject/, '空白串算缺')
})

test('加 stage 只改 JSON：lifecycle 副本里加一行自定义阶段，必填/词表/模板全跟着数据走（代码一行不改，且经真加载器验过）', () => {
	const addRow = (lifecycle) => lifecycle.stages.push({
		id: '验收', order: 7, gate: false, kind: '验收',
		requires: ['batchType', 'subject', 'intent'], produces: ['验收结论'], uses: [], note: '单测现造的阶段',
	})
	const addTemplate = (templates) => { templates.验收 = '验收结论：〔intent〕。〔subject〕' }
	const call = { stage: '验收', batchType: '纯后端管线批', subject: '净 diff', intent: '验收' }

	withLoadedData({ 'lifecycle.json': addRow }, (loaded) => {
		assert.deepEqual(stageRequires(loaded, '验收'), ['batchType', 'subject', 'intent'], '必填矩阵现算自该行的 requires')
		assert.equal(stageVocabulary(loaded).at(-1), '验收', '词表现算，跟着 order 排')
		assert.deepEqual(dispatchStages(loaded), ['方案', '门一', '施工', '门二'], '没有模板键就不算本工具能出稿的阶段——加载期就分得清')
		assert.deepEqual(formIds(computeCombo(loaded, call)), [], '这一趟不判批型（requires 里没有 batchType 那一位也不必），组合为空')
		for (const fn of [validateParams, assembleBrief, assembleDispatch]) {
			assert.throws(
				() => fn(loaded, call),
				/stage「验收」本工具不装配该阶段.*templates\.json 没有按模板键「验收」写的模板/,
				'模板缺失仍 fail fast，不返回半截模板，也不绕去问别的参数',
			)
		}
	})

	withLoadedData({ 'lifecycle.json': addRow, 'templates.json': addTemplate }, (loaded) => {
		assert.deepEqual(dispatchStages(loaded).at(-1), '验收', '模板键存在即进可服务清单（数据驱动，加阶段不改代码）')
		assert.throws(() => validateParams(loaded, { ...call, batchType: undefined }), /缺必填参数：batchType/, '模板补上之后才轮到必填矩阵说话')
		assert.doesNotThrow(() => validateParams(loaded, call))
		const [brief] = assembleBrief(loaded, call)
		assert.equal(brief.form, '验收', '单路出稿，路由名＝模板键')
		assert.equal(brief.text, '验收结论：验收。净 diff')
	})

	assert.throws(
		() => withLoadedData({ 'templates.json': addTemplate }, () => {}),
		/多出未声明的模板键「验收」.*没有任何阶段会读到它/,
		'只加模板不加 lifecycle 行＝加载失败：那个键没有任何阶段会读到，留着等于让人以为写了就生效',
	)

	assert.throws(() => validateParams(data, call), unknownStageError('验收'), '真数据里没有这一行——单源不是「认得所有词」')
})

test('加 stage 不扰动既有阶段：临时加一行后，四个已上线阶段的输出逐字不变', () => {
	const extended = withLoadedData({
		'lifecycle.json': (lifecycle) => lifecycle.stages.push({
			id: '验收', order: 7, gate: false, kind: '验收',
			requires: ['subject', 'intent'], produces: ['验收结论'], uses: [], note: '单测现造的阶段',
		}),
		'templates.json': (templates) => { templates.验收 = '验收结论：〔intent〕。' },
	}, (loaded) => loaded)
	for (const params of [
		planning(),
		{ stage: '门一', batchType: '纯后端管线批', subject: '方案.md 批 2', intent: '证伪复核' },
		construction(),
		{ stage: '门二', batchType: '纯后端管线批', subject: 'git diff HEAD~1', intent: '终审' },
	]) {
		assert.deepEqual(assembleDispatch(extended, params), assembleDispatch(data, params), `加行后 ${params.stage} 的输出逐字不变——新阶段不许顺手改别人的 brief`)
	}
	assert.deepEqual(stageVocabulary(extended).at(-1), '验收', '词表按 order 把新阶段接在末尾')
})

test('词表排序按数值：order 混进 10／1.5／-1 时仍是数值严格升序（字符串排序会排反）', () => {
	const scrambled = structuredClone(data)
	const orders = { 方案: 10, 门一: 1.5, 施工: -1, 门二: 2, 提交: 3, 复盘: 4 }
	for (const row of scrambled.lifecycle.stages) row.order = orders[row.id]
	const sorted = stageVocabulary(scrambled)
	assert.deepEqual(sorted, ['施工', '门一', '门二', '提交', '复盘', '方案'], '数值序：-1 < 1.5 < 2 < 3 < 4 < 10（字符串序会把 10 排到 2 前面）')
	const numbers = sorted.map((stage) => orders[stage])
	for (let index = 1; index < numbers.length; index += 1) {
		assert.ok(numbers[index] > numbers[index - 1], `${sorted[index]}（${numbers[index]}）须严格大于前一个 ${sorted[index - 1]}（${numbers[index - 1]}）——sort() 不带比较器时是字符串序，10 会排在 2 前面`)
	}
})

test('plan-spec 消费由数据决定：第二个 uses 含 plan-spec.json 的阶段也走同一份 13 节与自查清单', () => {
	const twin = withLoadedData({
		'lifecycle.json': (lifecycle) => lifecycle.stages.push({
			id: '定稿', order: 7, gate: false, kind: '定稿',
			requires: ['subject', 'intent'], produces: ['定稿文档'], uses: ['plan-spec.json'], note: '单测现造的阶段',
		}),
		'templates.json': (templates) => { templates.定稿 = '按下列规范定稿：\n〔plan-spec 各节逐字〕\n〔plan-spec checklist 逐条〕' },
	}, (loaded) => loaded)
	const output = assembleDispatch(twin, { stage: '定稿', subject: '方案.md', intent: '定稿' })
	assert.deepEqual(output.checklist, twin.planSpec.checklist, '判据是 uses 引用了 plan-spec.json，不按阶段名叫「方案」')
	assert.ok(output.briefs[0].text.includes('## 根设计原则'), '两条 plan-spec 占位照样接到那份数据上')
	assert.throws(() => assembleDispatch(data, { stage: '定稿', subject: 'x', intent: 'y' }), /未知 stage「定稿」/, '真数据里没有这一行——判据是数据，单源不是「认得所有词」')
})

test('槽位消费完备：全阶段×全参数矩阵——不消费的参数收到值即报错并点名消费它的是哪些阶段', () => {
	const batchType = '纯后端管线批'
	const values = {
		batchType, subject: 'x', intent: 'y', baseBatchType: '纯后端管线批',
		forbidden: '禁区', verifyCmd: 'npm test', rootCause: '错行', provider: 'minimax-cn',
		decisions: ['拍板'], addons: ['涉鉴权/上传/输入'], anchors: ['a'],
	}
	for (const stage of dispatchStages(data)) {
		const consumed = consumedParams(data, stage, batchType)
		const base = { stage }
		for (const slot of consumed) if (slot in values) base[slot] = values[slot]
		assert.doesNotThrow(() => validateParams(data, base), `${stage}：照消费集给参即过（消费集自洽）`)
		for (const field of PARAM_FIELDS) {
			if (field === 'stage') continue
			const params = { ...base, [field]: values[field] }
			if (consumed.has(field)) {
				assert.doesNotThrow(() => validateParams(data, params), `${stage} 消费 ${field}（模板占位或组合那一路读它），传了即报错＝契约说谎`)
			} else {
				assert.throws(
					() => validateParams(data, params),
					new RegExp(`stage=${stage} 不消费 ${field}——`),
					`${stage} 不消费 ${field}：静默忽略等于让调用方以为它生效`,
				)
			}
		}
	}
	assert.deepEqual(stagesConsuming(data, 'anchors'), ['施工'])
	assert.deepEqual(stagesConsuming(data, 'baseBatchType'), ['门一', '门二'])
	assert.deepEqual(stagesConsuming(data, 'decisions'), ['门一', '施工', '门二'], 'decisions 按模板占位消费：方案任务书没有拍板清单那一行（方案是给用户拍板的输入，不是已拍板的载体）')
	assert.deepEqual(stagesConsuming(data, 'provider'), ['方案', '门一', '施工', '门二'], 'provider 由 rhythm 谓词消费，与阶段无关')
	assert.deepEqual([...consumedParams(data, '方案')], ['subject', 'intent', 'provider'], '方案那一趟消费的槽位只有这三个：模板占位＋必填矩阵＋通用槽位，无门列故不消费组合那三项，任务书无拍板清单行故不消费 decisions')
})

test('decisions 按模板占位消费：方案那一趟传它即报错并说清为什么（方案是给用户拍板的输入，不是已拍板的载体）', () => {
	assert.throws(
		() => validateParams(data, planning({ decisions: ['拍板 1：零宿主依赖'] })),
		/stage=方案 不消费 decisions——方案是给用户拍板的输入，不是已拍板的载体：拍板清单随派发\/施工阶段的 brief 下发，删掉它/,
		'静默丢弃＝主会话以为它随任务书出去了，方案里就没了那一条',
	)
	for (const params of [
		{ stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: 'y', decisions: ['拍板 1'] },
		{ stage: '门二', batchType: '纯后端管线批', subject: 'x', intent: 'y', decisions: ['拍板 1'] },
		construction({ decisions: ['拍板 1'] }),
	]) {
		assert.doesNotThrow(() => validateParams(data, params), `${params.stage} 的模板有拍板清单那一行，传了即消费`)
	}
	assert.ok(assembleBrief(data, { stage: '门二', batchType: '纯后端管线批', subject: 'x', intent: 'y', decisions: ['拍板 1：零宿主依赖'] })[0].text.includes('拍板清单（不得重开）：拍板 1：零宿主依赖。'))
})

test('批型条件槽位的点名带条件：门一传 baseBatchType／rootCause 各说清为什么这一趟不用它', () => {
	const review = { stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: 'y' }
	assert.throws(
		() => validateParams(data, { ...review, baseBatchType: '纯后端管线批' }),
		/stage=门一 不消费 baseBatchType——此门主行列非空，不需要 baseBatchType——消费它的是新功能·形态未定、修复批那一类批型/,
		'点名「这一趟用不上」而不是笼统一句不消费：模型照笼统那句只会换个值再试',
	)
	assert.throws(
		() => validateParams(data, { ...review, rootCause: '错行' }),
		/stage=门一 不消费 rootCause——消费它的是施工\+needsRootCause 批型（修复批），删掉它或改调那一类/,
		'条件槽位连条件一起点名，否则「谁消费它」这句话与事实相反',
	)
	assert.throws(
		() => validateParams(data, { ...construction(), rootCause: '错行' }),
		/stage=施工 不消费 rootCause——这一趟的批型行没标 needsRootCause，施工模板不追加根因分类那三行/,
		'施工+非修复批传根因分类同样点名（修复批那一趟才追加那三行）',
	)
	assert.deepEqual(conditionalConsumers(data, 'rootCause'), { condition: 'needsRootCause', holders: ['修复批'], stages: ['施工'] })
	assert.deepEqual(conditionalConsumers(data, 'baseBatchType').stages, ['门一', '门二'])
	assert.equal(conditionalConsumers(data, 'decisions'), null, 'decisions 不是批型条件槽位，按模板占位消费')
	assert.doesNotThrow(() => validateParams(data, { stage: '门二', batchType: '修复批', baseBatchType: '纯后端管线批', subject: 'x', intent: 'y' }), 'needsBase 行在有门列的阶段仍然消费它')
})

test('复核阶段出一路都没有＝报错点名两种成因（静默空转：briefs 空数组，调用方以为派了门复核）', () => {
	const noBatchType = withLoadedData({
		'lifecycle.json': (lifecycle) => { lifecycle.stages[1].requires = ['subject', 'intent'] },
	}, (loaded) => loaded)
	assert.deepEqual(stageRequires(noBatchType, '门一'), ['subject', 'intent'], '必填矩阵里没有判批型参数')
	assert.deepEqual(formIds(computeCombo(noBatchType, { stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: 'y' })), [], '组合先空掉')
	for (const fn of [assembleBrief, assembleDispatch]) {
		assert.throws(
			() => fn(noBatchType, { stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: 'y' }),
			/stage=门一 复核阶段无可派组合——检查该 stage 的 requires 是否漏了判批型参数（漏了 combo 就是空的）、配对行该列是否为空/,
			'空转要当场报错：出稿结果里 briefs=[] 没人读得出来',
		)
	}
	assert.throws(
		() => assembleDispatch(withLoadedData({
			'pairing.json': (pairing) => { pairing.rows[0].gate1 = [] },
		}, (loaded) => loaded), { stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: 'y' }),
		/复核阶段无可派组合/,
		'配对行该列是空数组时同样空转（另一种成因，报错文案点名了它）',
	)
	assert.doesNotThrow(() => assembleDispatch(data, { stage: '方案', subject: 'x', intent: 'y' }), '非复核阶段单路出稿不受这条约束')
})

test('占位不带计数与名单：方案任务书那条占位只说「各节逐字」（节数与节名随 plan-spec 变，抄进模板即第二次真相源）', () => {
	assert.ok(data.templates.方案任务书.includes('〔plan-spec 各节逐字〕'))
	assert.ok(!data.templates.方案任务书.includes('13 节'), '模板里不写节数——改 plan-spec 加一节就得分两处')
	assert.ok(!data.templates.方案任务书.includes('根设计原则/'), '模板里不写节名清单——节名随数据变')
	const taskBook = assembleDispatch(data, planning()).briefs[0].text
	assert.equal(taskBook.match(/^## /gm).length, data.planSpec.blocks.length, '前缀匹配接上全部节，一条不多一条不少')
})

test('方案任务书：执行纪律指针、语义判定段位置、自查第 ⑨ 条都在（数据面三处口径收齐）', () => {
	const taskBook = assembleDispatch(data, planning()).briefs[0].text
	assert.ok(taskBook.includes('执行纪律全文随施工 brief 固定段下发'), '拍板后的执行节改指 brief 固定段')
	assert.ok(taskBook.includes('施工方动工前必读施工 brief「对象」行所指方案文档的对应批次节'), '何时写那节与 brief 的对象行同一口径')
	assert.ok(taskBook.includes('**本批语义判定**'), '每批任务块节里有语义判定段')
	assert.ok(taskBook.includes('- 本段位置：每批任务块的判据行之后、块末尾'), '该段自报位置：判据行之后没有它即视为漏写')
	assert.ok(taskBook.includes('语义判定清单已答（无两读点写明）'), '定稿自查第 ⑨ 条带上这半句（不新开一条）')
	const layout = data.planSpec.blocks.find((block) => block.id === 'layout')
	assert.ok(layout.text.includes('（见本节三档表）'), '版面节里的自指改成节内三档表，不指回节名')
	assert.ok(!layout.text.includes('（见「版面」节）'), '悬空自指清掉')
})

test('requireData：五份数据缺任何一份都点名（含 lifecycle 与 planSpec），不静默出空稿', () => {
	for (const missing of ['forms', 'pairing', 'templates', 'lifecycle', 'planSpec']) {
		const incomplete = structuredClone(data)
		delete incomplete[missing]
		assert.throws(() => assembleDispatch(incomplete, construction()), (error) => {
			assert.match(error.message, /签名一律是 \(data, params\)/)
			assert.match(error.message, /forms\/pairing\/templates\/lifecycle\/planSpec/, `缺 ${missing} 时错误仍要列出五份名字`)
			return true
		}, `缺 ${missing} 要点名，不让它飘成 data.${missing} undefined`)
	}
})

test('重复 stage id 取第一条：core 的查表语义被钉住（改成取最后一条等于让重名行悄悄生效）', () => {
	const doubled = structuredClone(data)
	doubled.lifecycle.stages.push({ ...structuredClone(doubled.lifecycle.stages.find((row) => row.id === '施工')), requires: [], note: '重名的第二条' })
	assert.deepEqual(stageRequires(doubled, '施工'), ['batchType', 'subject', 'intent', 'anchors'], '取第一条：第二条的空 requires 不生效（findLast 变异会让施工不再要 anchors 而此处仍绿）')
	assert.throws(() => validateParams(doubled, { stage: '施工', batchType: '纯后端管线批', subject: 'x', intent: 'y' }), /缺必填参数：anchors/, '重名行在加载期就被拦，这里钉的是 core 自身的取哪一条')
})

test('句号归一：占位值自带终止符与模板尾叠加时压回一个（各终止符混排也只留最后一个）', () => {
	for (const [subject, expected] of [
		['净 diff 生成命令', '对象：净 diff 生成命令。'],
		['净 diff 生成命令。', '对象：净 diff 生成命令。'],
		['净 diff 生成命令？', '对象：净 diff 生成命令？'],
	]) {
		const params = { stage: '门一', batchType: '纯后端管线批', subject, intent: '验证意图一句话' }
		const { briefs } = assembleDispatch(data, params)
		assert.ok(briefs.length > 0)
		for (const brief of briefs) {
			assert.ok(!brief.text.includes('。。'), `brief 出现连续句号：${brief.form}`)
			assert.ok(brief.text.includes(expected), `归一后取最后一个终止符（不能把正常句号吃掉），实得该行：${brief.text.split('\n')[2]}`)
		}
	}
	const mixed = structuredClone(data)
	mixed.templates.门一 = mixed.templates.门一.replace('本批意图一句话：〔intent〕。', '这个设计点会怎么两读？〔intent〕。')
	const [brief] = assembleBrief(mixed, { stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: '两侧读法各是什么后果' })
	assert.ok(brief.text.includes('这个设计点会怎么两读？两侧读法各是什么后果。'), '「？。」压成最后一个「。」，模板尾的句号压掉占位值的句号')
	assert.ok(!brief.text.includes('？。'), '连续终止符不留原样')
})
