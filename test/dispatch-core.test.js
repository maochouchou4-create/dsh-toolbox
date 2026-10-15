/**
 * dispatch 纯函数核心单测（node:test，零宿主依赖）：拿真数据（lib/dispatch/data/ 三份 JSON）
 * 跑配对查表、特殊行语义、节奏谓词、brief 装配、参数校验与整份输出。数据与代码的边界由此
 * 可验——改 JSON 即改行为，发测试不依赖宿主（读法沿用仓内先例：node:fs 直读 JSON＋
 * node:test／node:assert/strict，同 test/memory-*.test.js）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	STAGES,
	assembleBrief,
	assembleDispatch,
	computeCombo,
	matchRhythm,
	placeholderTokens,
	stageRequires,
	validateParams,
} from '../lib/dispatch/core.js'

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'dispatch', 'data')
const readData = (name) => JSON.parse(readFileSync(join(dataDir, name), 'utf8'))
const data = { forms: readData('forms.json'), pairing: readData('pairing.json'), templates: readData('templates.json') }

const formIds = (combo) => combo.map((entry) => entry.form)

/** 一份过得了校验的施工调用，省得每条用例重复必填项。 */
const construction = (overrides = {}) => ({
	stage: '施工',
	batchType: '纯后端管线批',
	subject: '/home/nvse/code/实施方案/方案.md 批 1',
	intent: '装配 dispatch 工具',
	anchors: ['computeCombo', 'assembleBrief'],
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
	assert.throws(() => computeCombo(data, { batchType: '直做批', stage: '方案' }), /未知 stage/)
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

test('施工 brief：自证与必读链在位，禁区／自验命令可省；修复批追加增量三行', () => {
	const [plain] = assembleBrief(data, construction())
	assert.equal(plain.form, '施工')
	for (const fragment of [
		'先读 implementation-plan skill 全文，再读方案（/home/nvse/code/实施方案/方案.md 批 1）。',
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
	assert.throws(() => validateParams(data, { stage: '方案', batchType: '纯后端管线批' }), /未知 stage/)
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
	assert.deepEqual(matchRhythm(data, { batchType: '纯后端管线批', stage: '门一' }), [], '无命中输出空数组')
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

test('B1：施工不消费 baseBatchType（传了即报错并说清改调哪一门），门一/门二的 needsBase 照旧', () => {
	const constructionFix = { stage: '施工', batchType: '修复批', subject: 'x', intent: 'y', anchors: ['a'], rootCause: '错行' }
	assert.throws(
		() => validateParams(data, { ...constructionFix, baseBatchType: '纯后端管线批' }),
		/^Error: stage=施工 不消费 baseBatchType——组合门在门一\/门二，删掉它或改调门二$/,
		'错文案整句钉死：模型照着改就能改对，措辞漂了＝它猜要不要改调门二',
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

test('P6 role 归属：全部 20 个形态都扫一遍——该形态那路 brief 以本形态 role 句起头', () => {
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
			let briefs
			try {
				briefs = assembleBrief(swept, { stage, subject: 'x', intent: 'y', baseBatchType: '纯后端管线批', ...call })
			} catch (error) {
				assert.match(error.message, /不走门|加挂行不是批型|baseBatchType/, `角色归属扫描遇到非预期报错：${error.message}`)
				continue
			}
			for (const brief of briefs) {
				const entry = swept.forms.forms.find((form) => form.id === brief.form)
				assert.ok(brief.text.startsWith(entry.role), `${brief.form} 那路应以本形态 role 起头，实得「${brief.text.slice(0, 12)}…」`)
				seen.add(brief.form)
			}
		}
	}
	assert.equal(seen.size, 20, `全部 20 个形态都被扫到，实扫 ${seen.size}：${[...swept.forms.forms.map((form) => form.id)].filter((id) => !seen.has(id)).join('、')}`)
})

test('P7 占位残留：主行×三个阶段全组合扫，渲染结果里不留占位、未替换值与 null 拼串', () => {
	const residues = ['〔', '〕', 'undefined', 'null', '[object Object]']
	const mainRows = data.pairing.rows.filter((row) => row.kind !== 'addon')
	let rendered = 0
	const rejected = []
	for (const row of mainRows) {
		for (const stage of ['门一', '门二', '施工']) {
			const params = { stage, batchType: row.batchType, subject: '方案.md 批 1', intent: '扫全组合', anchors: ['computeCombo'], rootCause: '错行：占位没替换' }
			// 施工这一趟不消费 baseBatchType（组合门在门一/门二），一给就报错——扫组合得按契约给
			if (stage !== '施工') params.baseBatchType = '纯后端管线批'
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
			const params = { stage, batchType, subject: 'x', intent: 'y', anchors: ['a'], baseBatchType: '纯后端管线批', rootCause: '错行' }
			delete params[field]
			assert.throws(() => validateParams(data, params), new RegExp(`缺必填参数：${field}`), `${stage}/${batchType} 缺 ${field} 要被点名`)
		}
	}
	assert.throws(() => validateParams(data, { stage: '施工', batchType: '纯后端管线批', subject: 'x', intent: 'y', anchors: [] }), /缺必填参数：anchors/, '空数组算缺，不让模板渲染出「锚点：」空行')
	assert.throws(() => validateParams(data, { stage: '门一', batchType: '纯后端管线批', subject: '   ', intent: 'y' }), /缺必填参数：subject/, '空白串算缺')
})

test('P10 模板与必填矩阵对齐：每阶段模板的非可选占位都落在该阶段的必填槽位上（否则必有一处静默渲染空段）', () => {
	// 两个占位的值不来自本次调用：形态角色句来自 forms.json、下文四条原文来自 templates.横切判据
	const dataBacked = ['形态角色句', '下文四条原文']
	for (const stage of STAGES) {
		const allowed = [...stageRequires(stage), ...dataBacked]
		for (const token of placeholderTokens(data.templates[stage])) {
			if (token.includes('空则本行')) continue
			assert.ok(
				allowed.some((slot) => token.startsWith(slot)),
				`${stage} 模板的占位〔${token}〕不在该阶段的必填槽位与数据源占位里：${allowed.join('、')}`,
			)
		}
	}
	assert.deepEqual(stageRequires('施工'), ['batchType', 'subject', 'intent', 'anchors'], '施工比门阶段多 anchors 一项')
	assert.deepEqual(stageRequires('门一'), stageRequires('门二'), '两个门阶段必填项相同')
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
	assert.ok(matchRhythm(data, { stage: '门一', batchType: '纯后端管线批' }).length === 0, '真数据里门一纯后端管线批无命中，空数组')
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

test('句号归一：占位值自带句号与模板尾句号叠加时压回一个（装配噪声不让调用方买单）', () => {
	const params = { stage: '门一', batchType: '纯后端管线批', subject: '净 diff 生成命令。', intent: '验证意图一句话。' }
	const { briefs } = assembleDispatch(data, params)
	assert.ok(briefs.length > 0)
	for (const brief of briefs) {
		assert.ok(!brief.text.includes('。。'), `brief 出现连续句号：${brief.form}`)
		assert.ok(brief.text.includes('验证意图一句话。'), '单句号保留（归一不能把正常句号吃掉）')
	}
})
