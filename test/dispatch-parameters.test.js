/**
 * dispatch 工具参数面单测（node:test，零宿主依赖）：参数面是模型选型的唯一依据——它写的
 * 取值清单与必填标注会被原样抄进调用，而那份面在 data 现读拼出来之后，「改了 JSON 描述还在
 * 旧名单」这件事就有了可验的地方。这里核三件：键集与 core 的参数名全集同源、stage 取值清单
 * ＝可服务阶段且按 order 排、batchType 不标必填（方案阶段不判批型，标了等于逼模型编批型），
 * 外加三处单源对账：数值槽位的键集、批型条件槽位的点名、规模参数的取值域。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONDITION_PARAMS, NUMERIC_PARAMS, PARAM_FIELDS, RHYTHM_FIELDS, dispatchStages, stageVocabulary, validateParams } from '../lib/dispatch/core.js'
import { dispatchParameters } from '../lib/dispatch/parameters.js'

const dispatchDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'dispatch')
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

const parameters = dispatchParameters(data)

test('参数面的键集＝core 的参数名全集（两份名单同源，多一个少一个都红）', () => {
	assert.deepEqual(Object.keys(parameters), PARAM_FIELDS)
	// 类型面三档：字符串、字符串数组、整数——scale 两项是 integer，漏进白名单外它们会被当成
	// string 判红，而反过来把它写成 string 就是宿主按字符串收、rhythm 拿不到数比大小
	for (const field of PARAM_FIELDS) {
		const type = ['decisions', 'addons', 'anchors'].includes(field)
			? 'array'
			: ['diffLines', 'changedFiles'].includes(field) ? 'integer' : 'string'
		assert.equal(parameters[field].type, type, `${field} 的类型`)
	}
	// 数值槽位三链互验：core 的 NUMERIC_PARAMS（空判据与取值域按它判）＝参数面标 number/integer 的
	// 那几格＝数值那几格在 core 的 rhythm 谓词里按 {max:N} 区间比。三处各列一份，任一处漏一个字段，
	// 漏的那处表现是「传了不报类型错、谓词那条也不生效」，没有任何错误会响
	const numeric = Object.entries(parameters).filter(([, spec]) => spec.type === 'number' || spec.type === 'integer').map(([field]) => field)
	assert.deepEqual(numeric, NUMERIC_PARAMS, '参数面标 number/integer 的键集 ≡ core 的 NUMERIC_PARAMS')
	assert.deepEqual(RHYTHM_FIELDS.filter((field) => NUMERIC_PARAMS.includes(field)), NUMERIC_PARAMS, '数值槽位就是节奏谓词里按区间比的那几个字段')
})

test('规模参数在 schema 层就标 integer：小数由宿主在调用边界拒掉（core 的运行期检查仍在，留给不经宿主 schema 的路）', () => {
	// 这条与上一条的「类型面三档」是同一件事的两面：那边核键集与类型名，这边核「为什么是
	// integer 而不是 number」——行数与文件数是计数，宿主 DSL 有 IntegerValueSchemaSpec，
	// 标 number 的话 4.5 能过 schema，之后只由 core.assertNumericParams 兜着。兜得住，
	// 但两道的落点不同：schema 那道在调用边界、点名参数；core 那道要等整趟参数校验走到它。
	// schema 那道对 2^53 与 Number.MAX_VALUE 这类「是整数但不是计数」的值拦不拦得下来，
	// 属运行期（宿主注册边界），待下次启动验证；判据留在 core 那道，见下面那条边界枚举
	assert.equal(parameters.diffLines.type, 'integer')
	assert.equal(parameters.changedFiles.type, 'integer')
})

test('规模参数按非负安全整数收：字符串数字／负数／小数当场点名（changedFiles 侧同样，不只 diffLines）', () => {
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
	assert.match(parameters.diffLines.description, /与 changedFiles 成对给/, '成对给写在描述里：只给一半按不命中是静默的，模型照旧传一个不会知道自己漏了')
	assert.match(parameters.changedFiles.description, /与 diffLines 成对给/)
})

test('规模参数的取值域边界＝非负安全整数（0/1/MAX_SAFE_INTEGER 过，越界的四种当场点名）', () => {
	const base = { stage: '门二', batchType: '纯后端管线批', subject: 'git diff HEAD~1', intent: '终审' }
	// 过侧：安全整数是分界而不是「整数」。Number.isInteger 对下面四种全判真（Infinity 除外），
	// 于是按「整数」收的判据会让 2^53 与 1.79e308 安静地被当成合法规模拿去比 {max:N}
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
	// 描述面与运行期同一口径：模型照描述传的域就是运行期收的域，两句不一致时它看不出自己会被拒在哪
	for (const field of ['diffLines', 'changedFiles']) {
		assert.match(parameters[field].description, /非负安全整数[，、]上限 2\^53−1/, `${field} 的描述与 core.assertNumericParams 收的是同一个域`)
	}
})

test('stage 取值清单＝本工具能出稿的阶段，按 lifecycle 的 order 排（提交/复盘归各自的工具，不列）', () => {
	assert.equal(parameters.stage.required, true)
	const listed = parameters.stage.description.split(' | ')
	assert.deepEqual(listed, ['方案', '门一', '施工', '门二'])
	assert.deepEqual(listed, dispatchStages(data), '清单现读：不手抄就停了上一次改 JSON 之前的名字')
	assert.deepEqual(listed, stageVocabulary(data).filter((stage) => listed.includes(stage)), '清单是阶段词表按 order 排后的子集（手抄成别的顺序这里就红）')
	for (const out of ['提交', '复盘']) {
		assert.ok(!listed.includes(out), `${out} 不在本工具的服务范围内，列进去等于让模型照着调一个出不了稿的阶段`)
	}
	assert.ok(!parameters.stage.description.includes(' | 提交'), '清单里不许出现不可达阶段')
})

test('回填面四格都不标必填（宿主按 schema 拦必填发生在进 execute 之前，台账回填就永远到不了；必填判定归 core.validateParams）', () => {
	assert.equal(parameters.batchType.required, undefined)
	assert.deepEqual(parameters.batchType.required, undefined, '手抄回 required:true 这里红')
	assert.equal(parameters.subject.required, undefined, '对象那格能由 batch 回填，schema 标必填＝回填到不了')
	assert.equal(parameters.intent.required, undefined, '意图那格能由 batch 回填，schema 标必填＝回填到不了')
	assert.equal(parameters.decisions.required, undefined)
	assert.equal(parameters.anchors.required, undefined, '阶段级必填由 core.validateParams 按数据点名，schema 里不标')
	assert.equal(parameters.stage.required, true, 'stage 是调用形态参数、不在回填面，宿主层拦形态错误是好事')
	for (const field of ['batchType', 'subject', 'intent', 'decisions']) {
		assert.ok(parameters[field].description.includes('缺省可由 batch 回填'), `${field} 的描述要告诉模型这格可以从台账来，否则不传就以为该编`)
	}
	assert.ok(parameters.batchType.description.startsWith('批型（门一/施工/门二阶段必填'), '必填阶段名单现读自 lifecycle 的 requires')
	for (const row of data.pairing.rows.filter((entry) => entry.kind !== 'addon')) {
		assert.ok(parameters.batchType.description.includes(row.batchType), `主行「${row.batchType}」漏在描述外，模型照着挑不到`)
	}
	for (const row of data.pairing.rows.filter((entry) => entry.kind === 'addon')) {
		assert.ok(parameters.batchType.description.includes(row.batchType), `加挂行「${row.batchType}」漏在描述外，模型改用 addons 时挑不到`)
	}
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
	assert.match(parameters.batchType.description, /需 baseBatchType 的特殊行：新功能·形态未定、修复批/, '参数面点名的也是那几行——同读 core 的 holders')
	assert.match(holdersInMessage(data, 'rootCause'), /消费它的是施工\+needsRootCause 批型（修复批）/)
	assert.match(parameters.rootCause.description, /修复批施工必填/)

	const flipped = structuredClone(data)
	for (const row of flipped.pairing.rows) {
		if (row.needsBase === true) row.needsBase = false
		if (row.needsRootCause === true) row.needsRootCause = false
	}
	const changed = dispatchParameters(flipped)
	assert.ok(!changed.batchType.description.includes('需 baseBatchType 的特殊行'), '行上不标 needsBase：参数面不再点名那类批型')
	assert.ok(!changed.rootCause.description.includes('施工必填'), '行上不标 needsRootCause：参数面不再说那类批型施工必填')
	assert.match(holdersInMessage(flipped, 'baseBatchType'), /配对表里没有任何一行标 needsBase/, '行上不再有 needsBase 时 core 那侧改说「没人标这个条件」，而不是印出一个空名单冒充集合')
	assert.throws(
		() => validateParams(flipped, { ...call, batchType: '修复批', rootCause: '错行' }),
		/已上线的阶段都不消费它/,
		'两个标记都摘掉后 rootCause 真的没人消费：core 的 holders 与描述同时空了，两处仍一致',
	)

	// 输出等价对账：把行上的条件值换成 truthy 但非 true 的东西，两侧仍须给出同一答案——描述那
	// 几格是 core 的 holders 现读拼出来的，与 core 的判定同源。这条守的是「两侧答案一致」，不守
	// 「本文件没有自持 filter」：两侧各 filter 一份、哪怕判据逐字相同，这份断言照样绿。结构那一
	// 半由下面那道源码守卫把着——守卫拦的是「字面量倒退」这类常见形态；语义等价的间接自持
	// （借 CONDITION_PARAMS 的 condition 字段名现读、却复制 filter 逻辑）拦不住，那层的兜底
	// 在时间维度：core 改判据时两侧分岔，odd 这份数据会红
	const odd = structuredClone(data)
	for (const row of odd.pairing.rows) {
		if (row.needsBase === true) row.needsBase = 'true'
		if (row.needsRootCause === true) row.needsRootCause = 'true'
	}
	const oddDescription = dispatchParameters(odd)
	assert.ok(!oddDescription.batchType.description.includes('需 baseBatchType 的特殊行'), '条件值不是 true 就不算带条件：描述与 core 的 holders 同一口径')
	assert.ok(!oddDescription.rootCause.description.includes('施工必填'), '同上，rootCause 侧')
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

test('描述里的阶段名单与 core 的槽位消费集一致（描述说某阶段可填，契约就得真消费它）', () => {
	assert.match(parameters.anchors.description, /施工必填$/)
	assert.match(parameters.forbidden.description, /施工可选$/)
	assert.match(parameters.verifyCmd.description, /施工可选$/)
	assert.match(parameters.baseBatchType.description, /只在这一趟的组合可能落回原批型时消费（有门列，且该行标 needsBase 或主行该列为空），否则收到即报错/, '条件槽位把条件写进描述：只说「不消费」会让模型在门一/纯后端管线批那一趟反复重试')
	assert.match(parameters.decisions.description, /门一\/施工\/门二阶段逐条成行.*方案那一趟不消费它/, 'decisions 的描述说清哪些阶段消费它')
	assert.match(parameters.rootCause.description, /别的阶段与别的批型收到即报错/)
	assert.match(parameters.subject.description, /门二＝净 diff 生成命令/, '两态语义是规则本身，不是可变的阶段清单')
	assert.throws(() => validateParams(data, { stage: '门一', batchType: '纯后端管线批', subject: 'x', intent: 'y', anchors: ['a'] }), /stage=门一 不消费 anchors——消费它的是施工阶段/, '描述说施工才要 anchors，别的阶段传它就该被拒')
})

test('描述面不残留手抄的阶段名单（加了阶段或改了 requires，描述跟着走）', () => {
	const extended = structuredClone(data)
	extended.lifecycle.stages.push({
		id: '验收', order: 7, gate: false, kind: '复盘',
		requires: ['subject', 'intent', 'anchors'], produces: ['验收结论'], uses: [], note: '单测现造的阶段',
	})
	extended.templates.验收 = '验收结论：〔intent〕。〔subject〕〔anchors〕'
	const extendedParameters = dispatchParameters(extended)
	assert.match(extendedParameters.stage.description, /验收$/, '新阶段自动进 stage 取值清单')
	assert.match(extendedParameters.anchors.description, /施工\/验收必填$/, '新阶段要 anchors 后描述里的名单跟着走')
})
