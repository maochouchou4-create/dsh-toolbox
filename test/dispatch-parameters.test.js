/**
 * dispatch 族参数面单测（node:test，零宿主依赖）：装配四件（各一张表）与台账工具各验各的。
 * 参数面是模型选型的唯一依据——它写的取值清单与必填标注会被原样抄进调用。这里核四件：
 * ①各件键集＝方案 D2 的参数集（手抄名单在这里是判据不是漂移源：它钉住「声明面不长回 stage、
 * 不漏 batch」），并集与 core 的 PARAM_FIELDS 同源；②schema required＝派生公式（lifecycle
 * requires − 回填基础集）直调比对；③专属参数断言（anchors/rootCause 只在 build、baseBatchType
 * 只在 review/verify）；④批型条件槽位的描述与 core 的 holders 同读一份判定。外加规模参数的
 * 取值域与 enum 对账。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	ASSEMBLER_CONTRACTS, BACKFILL_FIELDS, CONDITION_PARAMS, NUMERIC_PARAMS, PARAM_FIELDS,
	RHYTHM_FIELDS, mainBatchTypes, schemaRequiredOf, stageRequires, stageVocabulary, validateParams,
} from '../lib/dispatch/core.js'
import { assemblerParameters, batchParameters, declaredSlots } from '../lib/dispatch/parameters.js'
import { DISPATCH_DIR } from './helpers.js'

const dispatchDir = DISPATCH_DIR
const dataDir = join(dispatchDir, 'data')
const parametersPath = join(dispatchDir, 'parameters.js')
const readData = (name) => JSON.parse(readFileSync(join(dataDir, name), 'utf8'))
const data = {
	forms: readData('forms.json'),
	pairing: readData('pairing.json'),
	templates: readData('templates.json'),
	lifecycle: readData('lifecycle.json'),
	planSpec: readData('plan-spec.json'),
}

// 四件面：按契约表各拼一张（键序即 PARAM_FIELDS 定序）
const surfaces = new Map(ASSEMBLER_CONTRACTS.map((contract) => [contract.name, assemblerParameters(data, contract.stage)]))
const plan = surfaces.get('dispatch_plan')
const review = surfaces.get('dispatch_review')
const build = surfaces.get('dispatch_build')
const verify = surfaces.get('dispatch_verify')
const batch = batchParameters(data)

test('四件键集＝D2 参数集（手抄名单是判据）：并集 ≡ PARAM_FIELDS、各件键集 ≡ declaredSlots、stage 不在任何一件', () => {
	const expected = {
		dispatch_plan: ['subject', 'intent', 'batch', 'provider', 'diffLines', 'changedFiles'],
		dispatch_review: ['batchType', 'subject', 'intent', 'baseBatchType', 'batch', 'decisions', 'addons', 'provider', 'diffLines', 'changedFiles'],
		dispatch_build: ['batchType', 'subject', 'intent', 'batch', 'decisions', 'anchors', 'forbidden', 'verifyCmd', 'rootCause', 'provider', 'diffLines', 'changedFiles'],
		dispatch_verify: ['batchType', 'subject', 'intent', 'baseBatchType', 'batch', 'decisions', 'addons', 'provider', 'diffLines', 'changedFiles'],
	}
	for (const [name, keys] of Object.entries(expected)) {
		assert.deepEqual(Object.keys(surfaces.get(name)), keys, `${name} 的键集（多一个＝声明了不消费，少一个＝模型传了收不到）`)
	}
	const union = [...new Set(Object.values(expected).flat())]
	assert.deepEqual([...union].sort(), [...PARAM_FIELDS].sort(), '四件并集 ≡ PARAM_FIELDS：stage 出局后 14 键，一份不多一份不少')
	for (const contract of ASSEMBLER_CONTRACTS) {
		assert.deepEqual(
			Object.keys(surfaces.get(contract.name)),
			declaredSlots(data, contract.stage),
			`${contract.name} 键集 ≡ declaredSlots（消费集 ∪ 条件槽位）：声明面与消费面同源`,
		)
		assert.ok(!('stage' in surfaces.get(contract.name)), `${contract.name} 不收 stage——阶段已随一拆四固化进工具`)
	}
	// build 不声明 addons：施工无门列，addons 在那一趟没有任何读点——按消费面派生它就不在面里
	assert.ok(!('addons' in build), 'build 不声明 addons（无门列→无读点）；verify/review 才有')
})

test('schema required＝派生公式（lifecycle requires − 回填基础集），直调派生函数比对：只有 build 标 anchors', () => {
	for (const contract of ASSEMBLER_CONTRACTS) {
		const surface = surfaces.get(contract.name)
		const required = Object.keys(surface).filter((field) => surface[field].required === true)
		assert.deepEqual(required, schemaRequiredOf(data, contract.stage), `${contract.name} 的 required 集＝schemaRequiredOf 直调`)
		assert.deepEqual(
			schemaRequiredOf(data, contract.stage),
			stageRequires(data, contract.stage).filter((field) => !BACKFILL_FIELDS.includes(field)),
			`${contract.name}：派生公式＝lifecycle requires − 回填基础集（必填单源仍在 lifecycle）`,
		)
	}
	assert.deepEqual(schemaRequiredOf(data, '施工'), ['anchors'], '施工 schema required＝anchors（宿主层拦缺参，invalid arguments 待宿主重启后真机验）')
	for (const name of ['dispatch_plan', 'dispatch_review', 'dispatch_verify']) {
		const stage = ASSEMBLER_CONTRACTS.find((contract) => contract.name === name).stage
		assert.deepEqual(schemaRequiredOf(data, stage), [], `${name} 的 requires 全在回填面：schema 一格必填都不标`)
	}
	assert.equal(build.anchors.required, true, 'build.anchors 是四件里唯一的 schema required')
})

test('专属参数断言：anchors/rootCause 只在 build、baseBatchType 只在 review/verify、decisions 不进 plan', () => {
	const declaredIn = (field) => ASSEMBLER_CONTRACTS.filter((contract) => field in surfaces.get(contract.name)).map((contract) => contract.name)
	assert.deepEqual(declaredIn('anchors'), ['dispatch_build'])
	assert.deepEqual(declaredIn('rootCause'), ['dispatch_build'])
	assert.deepEqual(declaredIn('baseBatchType'), ['dispatch_review', 'dispatch_verify'], 'baseBatchType 只在两道门：有门列才有「落回原批型主行」的读点')
	assert.deepEqual(declaredIn('decisions'), ['dispatch_review', 'dispatch_build', 'dispatch_verify'], 'decisions 不进 plan：方案是给用户拍板的输入，不是已拍板的载体')
	// verify 的 subject 语义分离写进两处描述：参数格与 batch 格（回填口径见 batch.js 的 BACKFILL_EXCLUDE）
	assert.match(verify.subject.description, /净 diff 生成命令/)
	assert.match(verify.subject.description, /不从台账回填/)
	assert.match(verify.batch.description, /subject 不在此列/)
	assert.match(plan.subject.description, /缺省可由 batch 回填/, '方案/门一/施工的 subject 仍是台账回填面那格')
})

test('回填基础集的格不标必填、描述都带「缺省可由 batch 回填」（schema 标必填＝台账回填永远到不了）', () => {
	for (const contract of ASSEMBLER_CONTRACTS) {
		const surface = surfaces.get(contract.name)
		for (const field of BACKFILL_FIELDS) {
			if (!(field in surface)) continue
			assert.equal(surface[field].required, undefined, `${contract.name}.${field}：必填判定归 core.validateParams（回填之后按数据点名）`)
		}
	}
	for (const [surface, name] of [[plan, 'dispatch_plan'], [review, 'dispatch_review'], [build, 'dispatch_build']]) {
		for (const field of ['batchType', 'intent', 'subject'].filter((field) => field in surface)) {
			assert.ok(surface[field].description.includes('缺省可由 batch 回填'), `${name}.${field} 的描述要告诉模型这格可以从台账来`)
		}
	}
	// 类型面三档照旧：字符串、字符串数组、整数
	for (const contract of ASSEMBLER_CONTRACTS) {
		for (const [field, spec] of Object.entries(surfaces.get(contract.name))) {
			const type = ['decisions', 'addons', 'anchors'].includes(field)
				? 'array'
				: ['diffLines', 'changedFiles'].includes(field) ? 'integer' : 'string'
			assert.equal(spec.type, type, `${contract.name}.${field} 的类型`)
		}
	}
	// 数值槽位三链互验（core 的 NUMERIC_PARAMS＝参数面标 integer 的键集＝rhythm 按区间比的那几个）
	const numeric = Object.keys(build).filter((field) => build[field].type === 'integer')
	assert.deepEqual(numeric, NUMERIC_PARAMS, '参数面标 integer 的键集 ≡ core 的 NUMERIC_PARAMS')
	assert.deepEqual(RHYTHM_FIELDS.filter((field) => NUMERIC_PARAMS.includes(field)), NUMERIC_PARAMS, '数值槽位就是节奏谓词里按区间比的那几个字段')
})

test('规模参数按非负安全整数收：字符串数字／负数／小数当场点名（changedFiles 侧同样，不只 diffLines）', () => {
	// 直接调 core 的用例按「注入后的 params 形态」给 stage（装配层注入后 core 才见它）
	const base = { stage: '门二', batchType: '纯后端管线批', subject: 'git diff HEAD~1', intent: '终审' }
	for (const value of ['5', -1, 4.5]) {
		assert.throws(
			() => validateParams(data, { ...base, diffLines: 3, changedFiles: value }),
			/参数「changedFiles」须是非负安全整数/,
			`changedFiles=${JSON.stringify(value)}：不是非负安全整数就点出来，不让它表现成「提示没出」`,
		)
	}
	assert.throws(() => validateParams(data, { ...base, diffLines: Number.NaN, changedFiles: 1 }), /参数「diffLines」须是非负安全整数.*实得 NaN/, 'NaN 打成 null 会把方向指错：调用方传的不是 null')
	assert.doesNotThrow(() => validateParams(data, { ...base, diffLines: 0, changedFiles: 0 }), '0 是有效规模（零行净 diff 正是免派那一档）')
	assert.match(build.diffLines.description, /与 changedFiles 成对给/, '成对给写在描述里：只给一半按不命中是静默的，模型照旧传一个不会知道自己漏了')
	assert.match(build.changedFiles.description, /与 diffLines 成对给/)
})

test('规模参数的取值域边界＝非负安全整数（0/1/MAX_SAFE_INTEGER 过，越界的四种当场点名）', () => {
	const base = { stage: '门二', batchType: '纯后端管线批', subject: 'git diff HEAD~1', intent: '终审' }
	for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
		assert.doesNotThrow(
			() => validateParams(data, { ...base, diffLines: value, changedFiles: 1 }),
			`diffLines=${value}：边界之内合法（含零行与最大安全计数）`,
		)
	}
	for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_VALUE, 2 ** 53]) {
		assert.throws(
			() => validateParams(data, { ...base, diffLines: value, changedFiles: 1 }),
			/参数「diffLines」须是非负安全整数/,
			`diffLines=${value}：${Number.isInteger(value) ? '它是整数却不是计数——双精度里已不是数出来的行数' : '连整数都不是'}，当成规模比阈值等于凭空造一档免派`,
		)
	}
	for (const field of ['diffLines', 'changedFiles']) {
		assert.match(build[field].description, /非负安全整数[，、]上限 2\^53−1/, `${field} 的描述与 core.assertNumericParams 收的是同一个域`)
	}
})

test('enum 对账：enum 里每个合法值都在描述里被点名（描述是模型得知合法值的唯一路径）', () => {
	// 两处分隔符本就不同（stage 用「 | 」、批型用顿号拼），切分比不了；判据取「enum 每个值都在
	// 描述里出现过」——描述里没有而 enum 收着的值＝模型没有任何路径得知它
	for (const field of ['stage', 'batchType']) {
		for (const value of batch[field].enum) {
			assert.ok(batch[field].description.includes(value), `dispatch_batch 的 ${field} enum 收了「${value}」而描述里没点名它`)
		}
	}
	for (const value of review.batchType.enum) {
		assert.ok(review.batchType.description.includes(value), `dispatch_review 的 batchType enum 收了「${value}」而描述里没点名它`)
	}
	assert.deepEqual(batch.stage.enum, stageVocabulary(data), '台账 stage enum＝全量词表（advance 记提交/复盘是正当一步）')
	assert.deepEqual(batch.batchType.enum, mainBatchTypes(data), '台账与装配件同一份批型词表：按名字索引，两边认的不同＝登记与出稿指两个东西')
})

test('批型条件槽位：core 的 holders 与参数面的描述读的是同一份判定（改一行，两处一起变）', () => {
	// 两处各判一次就会一边点名要、一边说不要，调用方照着描述传参然后撞上「不消费」而不知道该信
	// 哪个。故参数面不自己按条件字段名 filter，它调 core 的 holders——下面把行上的条件标记全部
	// 翻掉再断言一次：翻掉之后两处必须同时改口，而它们只有那一份判定可改
	const call = { stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: 'y' }
	const valueOf = { baseBatchType: '纯后端管线批', rootCause: '错行' }
	const holdersInMessage = (rules, field) => {
		try {
			validateParams(rules, { ...call, [field]: valueOf[field] })
			return '（没报错）'
		} catch (error) {
			return error.message
		}
	}
	assert.match(holdersInMessage(data, 'baseBatchType'), /消费它的是新功能·形态未定、修复批那一类批型/, 'core 点名的那类批型＝配对表里标 needsBase 的行（次序照表）')
	assert.match(review.batchType.description, /需 baseBatchType 的特殊行：新功能·形态未定、修复批/, '参数面点名的也是那几行——同读 core 的 holders')
	assert.match(holdersInMessage(data, 'rootCause'), /消费它的是施工\+needsRootCause 批型（修复批）/)
	assert.match(build.rootCause.description, /修复批施工必填/)

	const flipped = structuredClone(data)
	for (const row of flipped.pairing.rows) {
		if (row.needsBase === true) row.needsBase = false
		if (row.needsRootCause === true) row.needsRootCause = false
	}
	const changedReview = assemblerParameters(flipped, '门一')
	const changedBuild = assemblerParameters(flipped, '施工')
	assert.ok(!changedReview.batchType.description.includes('需 baseBatchType 的特殊行'), '行上不标 needsBase：参数面不再点名那类批型')
	assert.ok(!changedBuild.rootCause.description.includes('施工必填'), '行上不标 needsRootCause：参数面不再说那类批型施工必填')
	assert.match(holdersInMessage(flipped, 'baseBatchType'), /配对表里没有任何一行标 needsBase/, '行上不再有 needsBase 时 core 那侧改说「没人标这个条件」，而不是印出一个空名单冒充集合')
	assert.throws(
		() => validateParams(flipped, { ...call, batchType: '修复批', rootCause: '错行' }),
		/已上线的阶段都不消费它/,
		'两个标记都摘掉后 rootCause 真的没人消费：core 的 holders 与描述同时空了，两处仍一致',
	)

	// 输出等价对账：条件值换成 truthy 但非 true 的东西，两侧仍须给出同一答案——描述那几格是
	// core 的 holders 现读拼出来的，与 core 的判定同源。结构那一半由下面那道源码守卫把着
	const odd = structuredClone(data)
	for (const row of odd.pairing.rows) {
		if (row.needsBase === true) row.needsBase = 'true'
		if (row.needsRootCause === true) row.needsRootCause = 'true'
	}
	const oddReview = assemblerParameters(odd, '门一')
	const oddBuild = assemblerParameters(odd, '施工')
	assert.ok(!oddReview.batchType.description.includes('需 baseBatchType 的特殊行'), '条件值不是 true 就不算带条件：描述与 core 的 holders 同一口径')
	assert.ok(!oddBuild.rootCause.description.includes('施工必填'), '同上，rootCause 侧')
	assert.match(holdersInMessage(odd, 'baseBatchType'), /配对表里没有任何一行标 needsBase/, 'core 那侧对同一个数据也判「没人标这个条件」')

	// 结构守卫（机械证据）：条件字段字面量只许出现在 core.js 的槽位表一处——参数面自己再 filter
	// 一份就是同一个判定落了两处，而两份各自都对时上面那条输出等价对账一声不响。注释行同样不许
	// 出现这两个词：否则注释随时能退回成第二处判定说明，而这道守卫还绿
	const parametersSource = readFileSync(parametersPath, 'utf8')
	assert.ok(!/needsBase|needsRootCause/.test(parametersSource), '参数面源码里出现条件字段字面量：判定不只落在 core 的槽位表一处')

	// 性质：条件槽位每加一格／减一格，参数面都要显式过这一格——现读调用点的集合与槽位表键集互为
	// 充要，不靠「恰好都写了」蒙着
	const callSites = [...parametersSource.matchAll(/conditionHolders\(data, '([^']+)'\)/g)].map((match) => match[1])
	assert.deepEqual([...callSites].sort(), ['baseBatchType', 'baseBatchType', 'rootCause'], '三处调用点：批型那份要列两段（需依赖的特殊行与不带依赖的特殊行），baseBatchType 与 rootCause 各一处')
	assert.deepEqual([...new Set(callSites)].sort(), ['baseBatchType', 'rootCause'], '条件槽位的现读清单写死当前两键：加减槽位都要显式改这一格')
	assert.deepEqual([...new Set(callSites)].sort(), Object.keys(CONDITION_PARAMS).sort(), '调用点集合 ≡ core 的 CONDITION_PARAMS 键集：core 加一格而参数面没跟上，模型照旧描述传值就撞「未消费」')
})

test('描述名单与消费集一致（描述说施工要，契约就得真在施工消费它）', () => {
	assert.match(build.anchors.description, /施工必填$/)
	assert.match(build.forbidden.description, /施工可选$/)
	assert.match(build.verifyCmd.description, /施工可选$/)
	assert.match(review.baseBatchType.description, /只在这一趟的组合可能落回原批型时消费（有门列，且该行标 needsBase 或主行该列为空），否则收到即报错/, '条件槽位把条件写进描述：只说「不消费」会让模型在门一/纯后端管线批那一趟反复重试')
	assert.match(build.rootCause.description, /别的批型收到即报错/)
	assert.throws(() => validateParams(data, { stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: 'y', anchors: ['a'] }), /stage=门一 不消费 anchors——消费它的是施工阶段/, '描述说施工才要 anchors，别的阶段传它就该被拒')
	assert.throws(
		() => validateParams(data, { stage: '方案', subject: 'x', intent: 'y', decisions: ['拍板'] }),
		/stage=方案 不消费 decisions——方案是给用户拍板的输入，不是已拍板的载体：拍板清单随派发\/施工阶段的 brief 下发，删掉它/,
		'方案那一趟传 decisions 被拒且理由说人话',
	)
})

test('台账工具的名单现读：新阶段进 stage 的 enum、新形态进形态 id 的 enum（不手抄名单）', () => {
	const extended = structuredClone(data)
	extended.lifecycle.stages.push({
		id: '验收', order: 7, gate: false, kind: '复盘',
		requires: ['subject', 'intent', 'anchors'], produces: ['验收结论'], uses: [], note: '单测现造的阶段',
	})
	extended.templates.验收 = '验收结论：〔intent〕。〔subject〕〔anchors〕'
	extended.forms.forms.push({ id: '单测新增形态', role: '单测现造的形态角色句。' })
	const extendedBatch = batchParameters(extended)
	assert.ok(extendedBatch.stage.enum.includes('验收'), '新阶段自动进台账 stage 的 enum（stage 不再是装配件参数，清单随 lifecycle 走到台账这边）')
	assert.ok(extendedBatch.perFormCounts.items.properties.form.enum.includes('单测新增形态'), '新形态自动进形态 id 的 enum')
	// 台账 subject 的占位口径写进描述：start 时还没定对象先登记「（待写）」，回填按未登记处理
	assert.match(batch.subject.description, /（待写）/, '占位字面量在描述里点名：不写，主会话不知道可以先占位')
})
