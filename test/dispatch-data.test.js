/**
 * dispatch 现读面数据加载单测（node:test，零宿主依赖）：坏 JSON、形状不合、悬空形态 id、
 * 孤儿形态只报不拦，以及「改文件后下次调用取新值」——最后这条钉的是现读本身：加载器哪天
 * 被改成 import 静态化或加一层缓存，改规则就变成「改了不生效还不报错」，而这里照样全绿。
 * 读法沿用仓内先例：node:fs 直读 JSON＋临时目录＋node:test（不 import 宿主包）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assembleDispatch, computeCombo, matchRhythm } from '../lib/dispatch/core.js'
import { DATA_FILES, DEFAULT_DATA_DIR, SAFETY_CARRIER_IDS, ZERO_READER_LIST_FIELDS, loadDispatchData } from '../lib/dispatch/data.js'
import { editData, withDataDir } from './helpers.js'

const GATE_COLUMNS = ['gate1', 'gate2']

/** 安全五问的两端锚（data.js 里同名常量守的是数据面，这里钉的是盘上真数据确实用这两个短语起止）。 */
const SAFETY_HEAD = '此用户能操作此资源吗'
const SAFETY_TAIL = 'PII 与 token 进日志吗'

const orphanId = (warning) => warning.match(/「(.+?)」/)[1]

/**
 * 形状规格里每份 JSON 的顶层列表字段（现读推导，不在本文件再抄第三份名单）：拿「该被计数的
 * 维度有哪些」当事实，键名剥掉 `?` 前缀，另记它是不是可缺省。派生的是维度名，不是条数——条数
 * 那一半在 COUNT_SNAPSHOT 里。
 *
 * 列表有两种写法都在规格里出现：元素规格的列表（`['string']`／`[{…}]`）与标记串收列表的
 * （`'string[]'`／`'string[]|null'`），两种都算——只认一种时另一种维度悄悄不参与对账，而症状是
 * 对账全绿。
 *
 * 只取顶层：快照数的是「五份 JSON 里各有多少条行/条」（形态、不做清单、配对行、节奏谓词、
 * 阶段表、方案节、定稿自查条），行内那些数组（门的形态 id 列表、requires/uses 成员）是条目的
 * 成员不是条目本身。行级零读者字段（lifecycle 的 produces/note、pairing 行上的 note）因此不在
 * 推导范围内，它们的恒缺席由「零读者字段」那条用例逐行反钉。
 */
const isListSpec = (fieldSpec) => Array.isArray(fieldSpec) || (typeof fieldSpec === 'string' && fieldSpec.includes('[]'))
const specListFields = () => DATA_FILES.flatMap((file) => (typeof file.shape === 'string' ? [] : Object.entries(file.shape)))
	.filter(([, fieldSpec]) => isListSpec(fieldSpec))
	.map(([key]) => ({ field: key.startsWith('?') ? key.slice(1) : key, optional: key.startsWith('?') }))

/**
 * 五份数据的计数快照。改数据时只改这一处：断言拿它对着盘上现读的 JSON 核，数据变了就红在
 * 这里并指明该改哪儿，而不是让人再去翻散在各用例里的字面量。
 *
 * 七个键＝五份 JSON 里每一条「行/条」列表。键集不靠人手对着规格抄：它由 specListFields 现场
 * 推导后与本快照对账（见下面那条用例），少一维就有一份文件的改动不触发任何红——例如 checklist
 * 增减一条，快照里没有那一格，改了它这条用例照样全绿，而它是方案任务书尾巴上的定稿自查清单。
 * 可缺省的那一维（零读者字段）刻意不在快照里，两侧各有一份名单对账，改一边忘了另一边即红。
 */
const COUNT_SNAPSHOT = {
	forms: 22,
	rejected: 3,
	rows: 11,
	rhythm: 14,
	stages: 6,
	blocks: 13,
	checklist: 12,
}

/**
 * 三段阶段模板的正文快照（门一／施工／方案任务书）。计数快照守的是「条目数没变」，而这三键的
 * 风险正相反：改一个字不改变任何计数，于是改规则这件事本身没有任何东西会拦——而模板正文就是
 * 派发出来的那份 brief 的骨架，它被顺手改掉时的症状是「派出去的活儿悄悄换了要求」。
 * 「裁决」「修复批增量」「横切判据」「checklist」「AGENTS 必读链」那几键不在这儿：前两者各有
 * 已有红点覆盖，后三者的正文由别处逐句断言（必读链整篇逐字比对在 data.js 的加载期校验里）。
 *
 * 改模板正文＝改规则，更新这份快照是有意的动作而不是善后：快照与盘面不一致时红，指的是「有人
 * 改了规则面而没打算改这里」或「改了而忘了说」。
 */
const TEMPLATE_SNAPSHOT = {
	门一: "\"〔形态角色句，forms.json 逐字带入〕。\\n本批意图一句话：〔intent〕。\\n对象：〔subject〕。\\n拍板清单（不得重开）：〔decisions 逐条；空则本行整体省略〕。\\n横切判据：〔下文四条原文〕\\n若本趟为前提推翻后的重派：重点核重写是否真正回应了前提问题，不在已裁决项上重开。\\n〔AGENTS 必读链·复核〕\\n上报格式＝{维度键, 严重度(阻断/建议/Nit), file:line, 现象与证据}，只报问题不附方案——低能力复核模型的「更优做法」会误导主会话裁决，根治法由主会话亲读原文后定；例外＝事实性信息可报（file:line／现状／机制描述——报事实不是给方案）；选项集与优劣比较禁含；无法判断的域标「转派」而不是硬答。\\n派发时 provider/model 显式指派（按你的派发纪律；model 用真 id，带 provider 查 list_subagent_models 可得）；省略＝继承主会话路线且绕过授权清单。\"",
	施工: "\"你是施工者，按实施方案对应批次节动工。\\n方案是未执行先写就的，落点级偏差（锚点行号漂移、现场结构微差、等效更优的局部做法、触及链路内几行级顺势精简）按现场实际施工，不逐字照搬；逐字档内容除外——改它＝设计级冲突，停下上报。偏差在收尾汇报里说明。设计级冲突（改语义、动拍板项、批级顺势重设计机会、范围外发现）停下上报（conflict/escalations），不自行换方案。\\n对象（动工前先读对应批次节）：〔subject〕。\\n本批意图一句话：〔intent〕。\\n锚点（符号名，禁行号）：〔anchors〕。\\n拍板清单（不得重开）：〔decisions 逐条；空则本行整体省略〕。\\n禁区：〔forbidden；空则本行省略〕。\\n自验封顶＝一条受影响单测：〔verifyCmd；空则本行省略〕。\\n自证：上报必须附自验证据——verifyCmd 实跑输出＋机器门（typecheck/lint/测试）全绿的命令与输出，证据不是陈述。\\n提交归主会话：施工完工＝自证＋汇报即止，git commit/push 一律不做——提交在门二判据过后由主会话执行。\\n〔AGENTS 必读链·施工〕\\n上报格式＝只报现象＋证据＋影响面事实；不附方案/选项/倾向——方案由主会话定。\\n裁决类上报必须等裁决再动工（不得「否则我按上述施工」）。\"",
	方案任务书: "\"按下列规范撰写实施方案（对象与意图注入在末尾）：\\n〔plan-spec 各节逐字〕\\n本批意图一句话：〔intent〕。\\n对象与落点：〔subject〕。\\n写完过定稿自查：〔plan-spec checklist 逐条〕。\"",
}

/** 三键的序列化快照（现读加载器那一端）。 */
const templateTextsOf = (templates) => Object.fromEntries(
	Object.keys(TEMPLATE_SNAPSHOT).map((key) => [key, JSON.stringify(templates[key])]),
)

/** 加载结果那一端：把已加载的数据归成与快照同形的计数。 */
const countsOf = (data) => ({
	forms: data.forms.forms.length,
	rejected: data.forms.rejected.length,
	rows: data.pairing.rows.length,
	rhythm: data.pairing.rhythm.length,
	stages: data.lifecycle.stages.length,
	blocks: data.planSpec.blocks.length,
	checklist: data.planSpec.checklist.length,
})

/**
 * 盘上那一端：直接解析五份 JSON 数条目，**不经加载器**。
 *
 * 「必须不经加载器」不是洁癖：三个来源（快照／加载器／盘面）塌成两个时，两边都是同一段读法的
 * 产物，单侧变异全部放行——实测过，加载器少读一条 rhythm 时若盘面那端也走加载器，这条用例照样
 * 全绿，只有「数据与加载器同时变」的复合变异才红得了。三条腿各走各的路，对账才有对账的形状。
 */
const countsOnDisk = (dir = DEFAULT_DATA_DIR) => {
	const read = (file) => JSON.parse(readFileSync(join(dir, file), 'utf8'))
	return {
		forms: read('forms.json').forms.length,
		rejected: read('forms.json').rejected.length,
		rows: read('pairing.json').rows.length,
		rhythm: read('pairing.json').rhythm.length,
		stages: read('lifecycle.json').stages.length,
		blocks: read('plan-spec.json').blocks.length,
		checklist: read('plan-spec.json').checklist.length,
	}
}

test('盘上真数据加载即用：五份数据的计数与数据文件现读对账（快照一致＋加载器与盘上一致），warnings 只收四条预期孤儿', () => {
	const data = loadDispatchData()
	assert.deepEqual(Object.keys(data).sort(), ['forms', 'lifecycle', 'pairing', 'planSpec', 'templates', 'warnings'])
	// 对账式而非钉死式：数据是 SSOT，测试守「快照与源同步」不守「数不变」。加一条形态、改一条节奏
	// 条目都该由这一条红着告诉人「快照该更新了」，而不是让人自己数一遍五个数字对不对
	assert.deepEqual(countsOf(data), COUNT_SNAPSHOT, '测试内快照与盘上现读一致（改数据时改这一处即可）')
	assert.deepEqual(countsOf(data), countsOnDisk(), '加载器交出的条数与盘上 JSON 一致：加载器自己少读一条照样红')
	// 键集对账：快照的七个键与形状规格现读推导出的必填顶层列表字段逐个对上，而可缺省的那一维
	// （零读者）逐个对 data.js 登记的名单——两侧各自手抄时症状是「多一维/少一维而两边全绿」，
	// 因为漏掉的那一维在两边都「不存在」。规格里加一个列表字段而不进快照即红。
	const specs = specListFields()
	assert.deepEqual(
		specs.filter((row) => !row.optional).map((row) => row.field).sort(),
		Object.keys(COUNT_SNAPSHOT).sort(),
		'快照键集 ≡ 形状规格里必填的顶层列表字段（现读推导，不手抄）：新增一个列表字段却没在快照里给它一维计数，红在这里',
	)
	assert.deepEqual(
		specs.filter((row) => row.optional).map((row) => row.field).sort(),
		[...ZERO_READER_LIST_FIELDS].sort(),
		'形状规格里可缺省的顶层列表字段须逐个在零读者名单（data.js 的 ZERO_READER_LIST_FIELDS）里：那一维不进快照是因为没人读它，不是因为漏了一维',
	)
	assert.deepEqual(data.warnings.map(orphanId).sort(), ['性能放大问', '性质测试问', '设计七维', '证伪复核'], '形状与引用自洽才加载得出来，孤儿只报不拦（性能/性质两问＝加挂制预期孤儿，仅 rhythm 点名）')
	assert.ok(data.warnings.every((warning) => warning.includes('预期孤儿')), '孤儿告警带出该形态自己的 notes，说明它是刻意的')
	// 加载出来的那份直接喂 core：这一条兜住「加载通过但核心函数吃不下」的缝
	const output = assembleDispatch(data, { stage: '门二', batchType: '纯后端管线批', subject: 'git diff HEAD~1', intent: '终审' })
	assert.equal(output.briefs.length, 3)
})

test('三段阶段模板的正文与快照逐字一致（改模板＝改规则，红在这里指明该改快照）', () => {
	// 两端分立：加载器返回的是解析后的值，快照是序列化文本，拿加载结果跟自己比恒真
	const data = loadDispatchData()
	assert.deepEqual(templateTextsOf(data.templates), TEMPLATE_SNAPSHOT, '模板正文与快照不一致：改模板正文＝改规则')
	const onDisk = JSON.parse(readFileSync(join(DEFAULT_DATA_DIR, 'templates.json'), 'utf8'))
	assert.deepEqual(templateTextsOf(onDisk), TEMPLATE_SNAPSHOT, '盘上现读的 templates.json 与快照一致：加载器自己改写正文照样红')
})

test('dataDir 省略或留空串＝模块同目录的 ./data/（Config 默认值走同一条路）', () => {
	assert.deepEqual(countsOf(loadDispatchData({ dataDir: '' })), countsOnDisk(), '空串与省略走同一条路：拿到的就是盘上那份数据，一个条目不多不少')
	assert.deepEqual(loadDispatchData({ dataDir: DEFAULT_DATA_DIR }).warnings, loadDispatchData().warnings)
})

test('坏 JSON 显式报错，错误里点得出是哪个文件', (t) => {
	withDataDir(t, (dir) => {
		writeFileSync(join(dir, 'pairing.json'), '{ "rows": [ ')
		assert.throws(() => loadDispatchData({ dataDir: dir }), /pairing\.json 不是合法 JSON/)
	})
	withDataDir(t, (dir) => {
		rmSync(join(dir, 'templates.json'))
		assert.throws(() => loadDispatchData({ dataDir: dir }), /dispatch 数据读取失败.*templates\.json/, '文件读不到也要报出路径，不静默出空数据')
	})
})

test('形状不合显式报错，错误点名文件与字段（缺字段／类型错／枚举越界／多出字段）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'forms.json', (forms) => delete forms.rejected)
		assert.throws(() => loadDispatchData({ dataDir: dir }), /forms\.json 缺字段「rejected」/)
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => { pairing.rows[0].gate1 = '锚点核对' })
		assert.throws(() => loadDispatchData({ dataDir: dir }), /pairing\.json\.rows\[0\]\.gate1 须是 string\[\]/)
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => { pairing.rows[5].kind = 'addonn' })
		assert.throws(() => loadDispatchData({ dataDir: dir }), /rows\[5\]\.kind 须是 enum\(addon,special\)/)
	})
	withDataDir(t, (dir) => {
		editData(dir, 'templates.json', (templates) => { templates.checklistt = '拼错的键' })
		assert.throws(() => loadDispatchData({ dataDir: dir }), /多出未声明的模板键「checklistt」.*没有任何阶段会读到它/, '模板键的白名单＝lifecycle 各行的 templateKey 加那几张辅助页（拼错的键没有任何阶段会读到它）')
	})
})

test('配对指向未定义形态＝加载失败（悬空即错：静默出稿的代价是漏派一整门复核）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => { pairing.rows[0].gate2[0] = '没定过的形态' })
		assert.throws(() => loadDispatchData({ dataDir: dir }), /悬空引用.*纯后端管线批.*没定过的形态/)
	})
})

test('去掉一条配对引用不失败：该形态进 warnings，数据照常返回', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
				for (const row of pairing.rows) {
					for (const column of GATE_COLUMNS) {
						if (row[column] !== null) row[column] = row[column].filter((id) => id !== '砍刀')
					}
				}
			})
			const data = loadDispatchData({ dataDir: dir })
			assert.deepEqual(countsOf(data), countsOnDisk(dir), '孤儿只报不拦：三份数据照常返回（被形变的是引用，不是条目本身），装配层继续可用')
			assert.ok(data.warnings.some((warning) => orphanId(warning) === '砍刀'), '无引用（且自己没写 notes）的形态也进 warnings')
			assert.deepEqual(data.warnings.filter((warning) => warning.includes('预期孤儿')).map(orphanId).sort(), ['性能放大问', '性质测试问', '设计七维', '证伪复核'])
		})
})

test('改文件后下次调用取新值（现读不被偷偷改成 import 缓存）', (t) => {
	withDataDir(t, (dir) => {
		const first = loadDispatchData({ dataDir: dir })
		editData(dir, 'forms.json', (forms) => {
				forms.forms.find((form) => form.id === '砍刀').catches = '改写后的专抓文案'
			})
			const second = loadDispatchData({ dataDir: dir })
			assert.equal(second.forms.forms.find((form) => form.id === '砍刀').catches, '改写后的专抓文案', '同一次进程内两次加载取到不同值')
			assert.notEqual(second.forms, first.forms, '每次调用现读现解析，不复用同一份对象')
			const combo = computeCombo(second, { batchType: '用户可见功能批', stage: '门一' })
			assert.equal(combo.find((entry) => entry.form === '砍刀').reason, '改写后的专抓文案', '改动随装配结果走：组合理由取的就是改后的 catches')
		})
})

test('空集下限：forms／rows／rhythm／stages／blocks／checklist 任一被清空＝加载失败（规则面装不出东西却装得上＝有人整段删了规则没报错）', (t) => {
	for (const [file, mutate, where] of [
		['forms.json', (value) => { value.forms = [] }, /forms\.json 的 forms/],
		['pairing.json', (value) => { value.rows = [] }, /pairing\.json 的 rows/],
		['pairing.json', (value) => { value.rhythm = [] }, /pairing\.json 的 rhythm/],
		['lifecycle.json', (value) => { value.stages = [] }, /lifecycle\.json 的 stages/],
		['plan-spec.json', (value) => { value.blocks = [] }, /plan-spec\.json 的 blocks/],
		['plan-spec.json', (value) => { value.checklist = [] }, /plan-spec\.json 的 checklist/],
	]) {
		withDataDir(t, (dir) => {
			editData(dir, file, mutate)
			assert.throws(() => loadDispatchData({ dataDir: dir }), where)
		})
	}
})

test('唯一性：行名或形态 id 重名＝加载失败（重名那条等于悄悄失效）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			pairing.rows.push(structuredClone(pairing.rows[0]))
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /pairing\.json 的批型行名.*出现两次「纯后端管线批」/)
	})
	withDataDir(t, (dir) => {
		editData(dir, 'forms.json', (forms) => {
			forms.forms.push(structuredClone(forms.forms[0]))
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /forms\.json 的形态 id.*出现两次「锚点核对」/)
	})
})

test('主行的 gate 列写成空数组＝告警不拦（有意免派该门请写 null，空数组疑似漏配）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			pairing.rows[0].gate2 = []
		})
		const data = loadDispatchData({ dataDir: dir })
		assert.ok(data.warnings.some((warning) => warning.includes('批型「纯后端管线批」') && warning.includes('空数组疑似漏配')))
		assert.equal(data.pairing.rows[0].gate2.length, 0, '数据照常返回，装配层把这一趟出成空组合')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			pairing.rows[8].gate2 = []
		})
		assert.ok(!loadDispatchData({ dataDir: dir }).warnings.some((warning) => warning.includes('空数组疑似漏配')), 'needsBase 行本来就走 base 行解析，空列不算漏配')
	})
})

test('门别交叉核：gate1 列混进门二形态＝加载失败（错了门＝派错形态，主会话看不出来）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			pairing.rows[0].gate1 = ['设计七维·终审']
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /门别不合.*纯后端管线批.*gate1.*设计七维·终审/)
	})
})

test('阶段表专核：stage id／order 重名、复核阶段不在门别映射内＝加载失败（阶段表是 stage 词表与必填矩阵的单源，坏行等于静默失效）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages.push(structuredClone(lifecycle.stages[0]))
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /lifecycle\.json 的 stage id.*出现两次「方案」/)
	})
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages[2].order = 2
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /lifecycle\.json 的 order.*出现两次「2」/)
	})
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages[1].id = '形式审查'
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /门别不明.*复核阶段「形式审查」.*门一、门二/, '复核阶段反查不到配对列就出空组合，那一门复核等于没派')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages[0].requires = 'subject'
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /lifecycle\.json\.stages\[0\]\.requires 须是 string\[\]/)
	})
})

test('阶段表专核：order 非正整数、requires 重复或域外、gate 与 kind 不等价＝加载失败（都是「改了不报错」那一类）', (t) => {
	for (const [order, where] of [[0, '须是正整数'], [-1, '须是正整数'], [1.5, '须是正整数']]) {
		withDataDir(t, (dir) => {
			editData(dir, 'lifecycle.json', (lifecycle) => { lifecycle.stages[0].order = order })
			assert.throws(() => loadDispatchData({ dataDir: dir }), new RegExp(`stage「方案」order ${where}`), `order=${order}：阶段先后与词表顺序都按它排，非正整数排出来的先后是任意的`)
		})
	}
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages[1].requires = ['batchType', 'subject', 'intent', 'intent']
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /stage「门一」的 requires 里出现两次「intent」/, '重复项让必填矩阵与消费集各算一次，两处结果可能不同')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages[1].requires = ['batchType', 'subject', 'intent', '锚点']
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /取值域外.*stage「门一」requires 含「锚点」.*参数名全集/, '凭空的必填名等于向调用方要一个不存在的参数')
	})
	assert.doesNotThrow(() => loadDispatchData(), '空 requires 是合法边界：提交/复盘两行就是（那两行归各自的工具，本工具不为它们要参数）')
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages[1].gate = false
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /门别表述不一致.*stage「门一」gate=false 而 kind='复核'.*复核阶段该置 true/, 'gate 与 kind 是同一件事的两处表述，互验后不会再各错一次')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages[2].gate = true
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /门别表述不一致.*stage「施工」gate=true 而 kind='施工'.*非复核阶段该置 false/)
	})
	assert.doesNotThrow(() => loadDispatchData(), '提交那行 gate=true 而 kind=提交：互验只管本工具服务的那四行，提交/复盘的 gate 语义归各自的工具')
})

test('阶段表专核：uses 里的 plan-spec.json 与模板里的 plan-spec 占位双向互为充要（勾了不用、用了没勾都拦）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages[3].uses = ['plan-spec.json', 'pairing.json', 'templates.json']
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /引用不一致.*stage「门二」uses 声明了 plan-spec\.json，模板里却没有 plan-spec 占位/, '勾了不用：清单说这一趟吃 plan-spec，正文里却没有它的位置')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages[0].uses = ['templates.json']
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /引用不一致.*stage「方案」模板里有 plan-spec 占位，uses 却没声明 plan-spec\.json/, '用了没勾：正文在吃 plan-spec，清单上查不到')
	})
})

test('阶段表专核：装配四件的契约阶段行缺席＝加载失败（拆分后四件各按固定阶段出稿，改 id 要同时改 core）', (t) => {
	// 施工改名：根因分类三行按 stage id 匹配，落空时施工 brief 末尾少三行而其余部分照样出稿——
	// 这个静默面在加载期就拦下（方案/门一/门二的缺行过去没有任何机器核，同一道检查一并管住）
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages.find((row) => row.id === '施工').id = '动手'
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /装配工具的阶段行在 lifecycle\.json 里缺席（dispatch_build＝施工；现存 方案、门一、动手、门二、提交、复盘）/)
	})
	// 整行删掉：四件里缺谁、现存哪些阶段，错误里逐一点名（改的人一眼知道要在两边对表）
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages = lifecycle.stages.filter((row) => row.id !== '方案')
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /缺席（dispatch_plan＝方案；现存 门一、施工、门二、提交、复盘）/, '方案行缺席同样拦下——dispatch_plan 出稿时才炸是数据坏行最远的余波')
	})
})

test('阶段表专核：kind 落词表内且恰有一行 kind=提交＝加载失败（kind 决定 core 与台账各按哪种语义读这一行）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages[0].kind = '随便'
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /lifecycle\.json\.stages\[0\]\.kind 须是 enum\(方案,复核,施工,提交,复盘\)，实得 "随便"/, 'kind 落域外：复核门按它反查配对列、台账按它筛行，认不出的值落在哪一档都是静默的')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages = lifecycle.stages.filter((row) => row.kind !== '提交')
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /kind='提交' 的行须恰有一行，实得 0 行/, '没有提交行：台账判「在飞」的那道边界消失，记到收尾的批次永远算在飞')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages.push({ ...structuredClone(lifecycle.stages.find((row) => row.kind === '提交')), id: '提交流', order: 7 })
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /kind='提交' 的行须恰有一行，实得 2 行/, '两行提交：门禁推进与在飞集合按最晚那行算，提交这一步可以被推到没有下一行的 order')
	})
	assert.doesNotThrow(() => loadDispatchData(), '盘上真数据恰有一行 kind=提交（提交/复盘两行没有模板，故不进模板那几道互验，进的是这一道）')
})

test('两张必读链辅助页整篇同形：摘掉分工那一句后逐字不同、缺一张、或分工句写反写重＝加载失败（两份页各写一次口径，改一处忘了另一处＝两个子代理对着两份 AGENTS 读同一批文件）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'templates.json', (templates) => {
			templates['AGENTS 必读链·施工'] += '\n汇报格式＝只报现象＋证据'
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /两页漂移.*除「；只读禁写」外须整篇逐字相同.*第 3 行起/, '漂的是追加那几行：原用例按下标只比第 2 行，比不出这类漂移')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'templates.json', (templates) => {
			templates['AGENTS 必读链·施工'] = templates['AGENTS 必读链·施工'].replace('测试删减须显式申报', '测试可改可删')
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /两页漂移.*第 2 行起/, '硬约束那句是两份同源的口径，各改一处就等于给两边两套约束')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'templates.json', (templates) => {
			delete templates['AGENTS 必读链·施工']
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /缺模板键「AGENTS 必读链·施工」/, '键白名单只查「多出来的键」，少写一张时那一路的 brief 静默少掉必读链与硬约束两句')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'templates.json', (templates) => {
			templates['AGENTS 必读链·复核'] = templates['AGENTS 必读链·复核'].split('；只读禁写').join('')
			templates['AGENTS 必读链·施工'] += '；只读禁写'
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /分工句走位.*须在「AGENTS 必读链·复核」里恰一次.*实得前者 0 次／后者 1 次/, '分工句写反：施工那一路拿到一条做不到的只读约束，而摘掉那句之后两页逐字相同，原先那道比对一声不响')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'templates.json', (templates) => {
			templates['AGENTS 必读链·复核'] += '；只读禁写'
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /分工句走位.*实得前者 2 次/, '同一句写两次：比对摘的是全部出现处，写重的那处连同整行从比对里消失了')
	})
	assert.doesNotThrow(() => loadDispatchData(), '盘上真数据两页本来就只差「；只读禁写」那一句')
})

test('plan-spec 节 id 唯一：重名＝加载失败（查表取第一条，重名那条等于悄悄失效）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'plan-spec.json', (planSpec) => {
			planSpec.blocks.push({ ...structuredClone(planSpec.blocks[2]), title: '另一个写前必读' })
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /plan-spec\.json 的节 id.*出现两次「read-first」/)
	})
})

test('缺文件报错：五份数据任何一份读不到都带路径报错（lifecycle 与 planSpec 同样显式，不静默出空规则面）', (t) => {
	for (const file of ['forms.json', 'pairing.json', 'templates.json', 'lifecycle.json', 'plan-spec.json']) {
		withDataDir(t, (dir) => {
			rmSync(join(dir, file))
			assert.throws(
				() => loadDispatchData({ dataDir: dir }),
				new RegExp(`dispatch 数据读取失败.*${file.replace('.', '\\.')}`),
				`${file} 读不到也要报出路径，不静默出空数据`,
			)
		})
	}
})

test('节奏谓词取值交叉核：batchType／stage 拼错＝加载失败（拼错的谓词永不命中＝规则静默失效）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			pairing.rhythm[0].when.batchType = ['修副批']
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /谓词取值不存在.*when\.batchType.*修副批/)
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			pairing.rhythm[6].when.stage = ['施攻']
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /谓词取值不存在.*when\.stage.*施攻/)
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			pairing.rhythm[6].when.batchType = ['纯后端管线批']
		})
		assert.doesNotThrow(() => loadDispatchData({ dataDir: dir }), 'provider 是自由文本（两机各自的模型 id），无词表可核；batchType 与 stage 有词表才核')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			pairing.rhythm[6].when.stage = ['提交']
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /谓词取值不存在.*when\.stage.*提交/, 'stage 谓词只对着本工具能出稿的阶段：提交归台账工具，以它为谓词值那条规则永不命中')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			pairing.rhythm[0].when.batchType = ['涉鉴权/上传/输入']
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /谓词取值不存在.*when\.batchType.*涉鉴权\/上传\/输入/, 'batchType 谓词只对着主行：addon 行不作 batchType，那条谓词永不命中')
	})
})

test('安全五问按载体点名＋两处逐字同形：删判定／追加写岔段／锚整体换掉／载体改名／第三种念法，五种错法都加载失败', (t) => {
	const carriers = loadDispatchData().forms.forms.filter((form) => form.role.includes(SAFETY_HEAD))
	assert.deepEqual(carriers.map((form) => form.id), SAFETY_CARRIER_IDS, '盘上承载五问的形态＝data.js 登记的载体名单（名单单源，测试不再各抄一份）')
	const cores = carriers.map((form) => form.role.slice(form.role.indexOf(SAFETY_HEAD), form.role.indexOf(SAFETY_TAIL) + SAFETY_TAIL.length))
	assert.equal(cores[0], cores[1], '中间那串五问本体逐字相同')
	const formOf = (forms, id) => forms.forms.find((form) => form.id === id)
	withDataDir(t, (dir) => {
		editData(dir, 'forms.json', (forms) => {
			formOf(forms, '安全清单行').role = formOf(forms, '安全清单行').role.replace('输入校验（长度/类型/格式/注入）', '输入校验')
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /形态「安全清单行」与「安全专项」的安全五问核心串不逐字相同/, '少问一条——那一条永远漏查，且没有任何代码会报错')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'forms.json', (forms) => {
			const form = formOf(forms, '安全专项')
			const original = form.role
			const rewritten = original.slice(original.indexOf(SAFETY_HEAD)).replace('上传（类型/大小/路径）', '上传免了')
			form.role = `${original}／补一段：${rewritten}`
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /形态「安全专项」的安全五问锚点「此用户能操作此资源吗」在角色句里出现 2 次/, '追加一段写岔的五问：按切出来的那一串数只数到一次（两段文字本就不同），按锚点数才抓得住')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'forms.json', (forms) => {
			const form = formOf(forms, '安全专项')
			form.role = form.role.replaceAll(SAFETY_HEAD, '该用户能操作此资源吗').replaceAll(SAFETY_TAIL, 'PII 会进日志吗')
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /形态「安全专项」的安全五问两端锚点不齐/, '锚被整体改掉时「按锚数载体」只剩零个，自比恒真放行——载体由名单点名，锚齐不齐才报得出来')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'forms.json', (forms) => {
			formOf(forms, '安全专项').id = '安全专项甲'
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /安全五问载体丢失：forms\.json 里没有形态「安全专项」/, '载体改名：登记的那个 id 不在了，而改名后的那个成了没人校验的载体')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'forms.json', (forms) => {
			formOf(forms, '事实校准').role = `${formOf(forms, '事实校准').role}／${SAFETY_HEAD}／${SAFETY_TAIL}`
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /意外的五问载体：forms\.json 的形态「事实校准」/, '第三个形态带锚＝第三种念法，它不受同形校验保护，两边迟早写岔')
	})
})

test('rhythm 谓词按字段类别守形态：枚举字段写区间、规模字段写数组、区间两键都缺或值域错＝加载失败', (t) => {
	const entryWith = (pairing, field) => pairing.rhythm.find((entry) => entry.when[field] !== undefined)
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			entryWith(pairing, 'diffLines').when.provider = { max: 3 }
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /when\.provider 须是 string\[\]，实得 \{"max":3\}/, 'provider 收区间加载通过又永不命中（provider 无词表可核，词表核那层拦不住——形态按字段类别守门才拦得住）')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			entryWith(pairing, 'diffLines').when.diffLines = ['5']
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /when\.diffLines 须是 minMaxBound/, '规模字段收数组：比的是成员包含，本次参数是个数字，比出来恒不命中')
	})
	for (const bound of ['min', 'max']) {
		for (const value of [-1, 4.5]) {
			withDataDir(t, (dir) => {
				editData(dir, 'pairing.json', (pairing) => {
					entryWith(pairing, 'diffLines').when.diffLines = { [bound]: value }
				})
				assert.throws(() => loadDispatchData({ dataDir: dir }), new RegExp(`when\\.diffLines\\.${bound} 须是 非负整数`), `${bound}=${value}：负数与小数都让阈值落在不存在的一档上`)
			})
		}
	}
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			entryWith(pairing, 'diffLines').when.diffLines = {}
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /when\.diffLines 须至少给 min 或 max 一键/, '两键都缺＝该条规则恒命中：加载期必须拒，放行＝提示看起来在场实则与本次规模无关')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			entryWith(pairing, 'diffLines').when.diffLines = { min: 0, max: 5 }
		})
		assert.doesNotThrow(() => loadDispatchData({ dataDir: dir }), '双键同给是合法形态：min 与 max 各收窄一头，不是互斥的两形')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			entryWith(pairing, 'diffLines').when.diffLines = { min: 1, max: 0 }
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /when\.diffLines 的 min 不得大于 max/, '空区间：加载得过而该条规则永不命中，是静默失效而不是坏数据')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			entryWith(pairing, 'diffLines').when.diffLines = { max: 5, mid: 1 }
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /when\.diffLines 多出未声明字段「mid」/, '多写的键不生效＝规则按一条不存在的口径出提示，与只认 min/max 是同一道门')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			entryWith(pairing, 'diffLines').when.diffLines = '5'
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /when\.diffLines 须是 minMaxBound/, '字符串数字两形都不是')
	})
	assert.doesNotThrow(() => loadDispatchData(), '真数据两形都加载得过：免派条目收 {max}、拆批条目收 {min}')
	// 配置侧区间值有意比输入侧（安全整数）宽一档：它量的是自配规则、只由本仓维护者改——
	// 这条断言钉住这个不对称是有意的，后来者「统一两侧」时这里会红，先读 data.js 的 why 注释再动
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			entryWith(pairing, 'diffLines').when.diffLines = { max: 1e300 }
		})
		assert.doesNotThrow(() => loadDispatchData({ dataDir: dir }), '配置侧收非负整数不设安全上限：1e300 也过——口径差是设计，不是漏洞')
	})
})

test('模板键反向核：lifecycle 显式指了 templateKey 而 templates 没有这一键＝加载失败（拼错键名与忘了写模板长得一样）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => {
			lifecycle.stages[3].templateKey = '门一正文'
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /悬空引用：lifecycle\.json 的 stage「门二」指了 templateKey「门一正文」，templates\.json 里没有这一键/, '指错键名时出稿才报「没有按模板键写的模板」，那句话读不出是键拼错还是模板没写')
	})
	assert.doesNotThrow(() => loadDispatchData(), '提交/复盘两行没有 templateKey 也没有模板：缺省行不进这项核（它们归各自的工具）')
})

test('零读者字段：形状仍可缺省（写回不炸装载、删净仍出稿），而真盘面上恒缺席（写回即红）', (t) => {
	// 两层各有各的守法，合成一条断言就等于只守了一层：形状层（可缺省）归 data.js 的形状规格，
	// 盘面层（恒缺席）归下面这段真盘面反向断言。前者只保证「写进去/删掉都装得上」，不保证没人写
	withDataDir(t, (dir) => {
		editData(dir, 'forms.json', (forms) => { forms.principles = ['临时写回去的一段'] })
		editData(dir, 'lifecycle.json', (lifecycle) => { for (const row of lifecycle.stages) row.produces = ['临时写回'] })
		editData(dir, 'pairing.json', (pairing) => { for (const row of pairing.rows) row.note = '临时写回' })
		assert.doesNotThrow(() => loadDispatchData({ dataDir: dir }), '形状按可缺省登记：写回去也加载得过——改成必填只会逼每份数据补一段没人读的文案，少补一份直接整件工具缺席')
		editData(dir, 'forms.json', (forms) => { delete forms.principles })
		editData(dir, 'lifecycle.json', (lifecycle) => { for (const row of lifecycle.stages) delete row.produces })
		editData(dir, 'pairing.json', (pairing) => { for (const row of pairing.rows) delete row.note })
		const loaded = loadDispatchData({ dataDir: dir })
		assert.equal(loaded.forms.principles, undefined)
		assert.ok(loaded.lifecycle.stages.every((row) => row.produces === undefined && row.note === undefined))
		assert.ok(loaded.pairing.rows.every((row) => row.note === undefined))
		assert.ok(assembleDispatch(loaded, { stage: '门二', batchType: '纯后端管线批', subject: 'git diff HEAD~1', intent: '终审' }).briefs.length > 0, '缺省不是「加载得过但出不了稿」：出稿链照常走')
	})

	// 真盘面这一层钉的是「恒缺席」：本工具一个都不读这几类字段，写回盘上只会让人以为它在起作用。
	// 这一段红的时候自问「它有消费者吗」，有就改 data.js 的零读者名单，没有就别写回去
	const onDisk = loadDispatchData()
	assert.equal(onDisk.forms.principles, undefined, 'forms.principles 恒缺席（本工具零读者）')
	assert.ok(onDisk.lifecycle.stages.every((row) => row.produces === undefined), 'lifecycle 各行 produces 恒缺席')
	assert.ok(onDisk.lifecycle.stages.every((row) => row.note === undefined), 'lifecycle 行级 note 恒缺席（同名的 rhythm note 是活输出面，不在零读者之列）')
	assert.ok(onDisk.pairing.rows.every((row) => row.note === undefined), 'pairing 行级 note 恒缺席（formNotes 进 brief 正文，是活输出面）')
	assert.ok(onDisk.pairing.rhythm.every((row) => row.note !== undefined), 'rhythm note 必在：它进 matchRhythm 的输出与不可达条目的报错文案')
})

test('谓词交集可达性：stage 与 batchType 各限一批而两者不相交＝加载失败（谓词值各自合法但永不命中）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			pairing.rhythm.push({ when: { batchType: ['修复批'], stage: ['方案'] }, note: '永不可达条目' })
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /谓词永不可达.*永不可达条目.*不会同时成立/, '方案那一趟不判批型，两个在字段的交集为空——这条规则在任何调用下都不命中')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			pairing.rhythm.push({ when: { batchType: ['修复批'], stage: ['施工'] }, note: '可达条目' })
		})
		assert.doesNotThrow(() => loadDispatchData({ dataDir: dir }), '交集非空即放行：施工判批型，那一趟两个在字段同时成立')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			pairing.rhythm.push({ when: { stage: ['方案'] }, note: '只限阶段的条目' })
		})
		assert.doesNotThrow(() => loadDispatchData({ dataDir: dir }), '只有一个在字段时按它自己核，不因另一字段缺省而判不可达')
	})
})

test('模板键白名单：lifecycle 声明过的键放行（加阶段不改代码），没声明的键＝加载失败', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => lifecycle.stages.push({
			id: '验收', order: 7, gate: false, kind: '方案', requires: ['subject', 'intent'], produces: ['验收结论'], uses: [],
		}))
		editData(dir, 'templates.json', (templates) => { templates.验收 = '验收结论：〔subject〕。' })
		const data = loadDispatchData({ dataDir: dir })
		assert.equal(assembleDispatch(data, { stage: '验收', subject: '净 diff', intent: '验收' }).briefs[0].text, '验收结论：净 diff。', '加 stage 只改 JSON：新阶段经真加载就能出稿')
	})
	withDataDir(t, (dir) => {
		editData(dir, 'templates.json', (templates) => { templates.门三 = '没人会读它：〔subject〕。' })
		assert.throws(() => loadDispatchData({ dataDir: dir }), /多出未声明的模板键「门三」.*没有任何阶段会读到它/, '闭集照旧拦新模板：多出来的键没有任何阶段会读到它')
	})
})

test('占位登记校验：模板里出现未登记的占位＝加载失败（留到渲染期才炸＝规则删了不报错）', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'templates.json', (templates) => {
			templates.门一 = templates.门一.replace('〔intent〕', '〔本批想要什么〕')
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /占位未登记.*templates\.json.*门一.*本批想要什么/)
	})
	withDataDir(t, (dir) => {
		editData(dir, 'templates.json', (templates) => {
			templates.施工 = `${templates.施工}\n收尾句：〔逐条列出来〕。`
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /占位未登记.*施工.*逐条列出来/)
	})
	const taskBook = assembleDispatch(loadDispatchData(), { stage: '方案', subject: '方案.md 批 1', intent: '出方案' }).briefs[0]
	assert.ok(!taskBook.text.includes('〔'), '方案任务书那两条占位已接到 plan-spec 数据上——渲染到的是 13 节正文与自查清单，不是半截模板')
	assert.ok(taskBook.text.includes('## 根设计原则') && taskBook.text.includes('①软前提两档制'))
})

test('formNotes：限定句的值须是字符串，键须是 forms 定义过的形态 id', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			pairing.rows[2].formNotes.连带面 = '   '
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /formNotes\.连带面 须是 string/)
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			pairing.rows[2].formNotes['没定过的形态'] = '限定句安在没定义的形态上'
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /悬空引用.*formNotes.*没定过的形态/)
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => {
			pairing.rows[2].formNotes = ['连带面']
		})
		assert.throws(() => loadDispatchData({ dataDir: dir }), /formNotes 须是 stringMap/)
	})
})

test('元素级与空白级校验：数组里有空串／空白串／非串元素即报错（数据里的空字段多半是漏写）', (t) => {
	for (const [value, pattern] of [
		[['锚点核对', ''], /rows\[0\]\.gate1 须是 string\[\]/],
		[['锚点核对', '   '], /rows\[0\]\.gate1 须是 string\[\]/],
		[['锚点核对', 7], /rows\[0\]\.gate1 须是 string\[\]/],
	]) {
		withDataDir(t, (dir) => {
			editData(dir, 'pairing.json', (pairing) => { pairing.rows[0].gate1 = value })
			assert.throws(() => loadDispatchData({ dataDir: dir }), pattern)
		})
	}
	withDataDir(t, (dir) => {
		editData(dir, 'forms.json', (forms) => { forms.forms[0].role = '' })
		assert.throws(() => loadDispatchData({ dataDir: dir }), /forms\[0\]\.role 须是 string/)
	})
	withDataDir(t, (dir) => {
		editData(dir, 'templates.json', (templates) => { templates.checklist = '  ' })
		assert.throws(() => loadDispatchData({ dataDir: dir }), /templates\.json\.checklist 须是 string/)
	})
	withDataDir(t, (dir) => {
		editData(dir, 'pairing.json', (pairing) => { delete pairing.rhythm[0].note })
		assert.throws(() => loadDispatchData({ dataDir: dir }), /rhythm\[0\] 缺字段「note」/)
	})
})

test('现读的深等价：两次加载内容逐字一致，且首份返回值被深改不影响次次', (t) => {
	withDataDir(t, (dir) => {
		const first = loadDispatchData({ dataDir: dir })
		const second = loadDispatchData({ dataDir: dir })
		assert.deepEqual(first.forms, second.forms, '同内容两次现读深等价')
		assert.deepEqual(first.pairing, second.pairing)
		assert.deepEqual(first.templates, second.templates)
		assert.deepEqual(first.warnings, second.warnings)
		first.forms.forms[0].catches = '调用方改坏的'
		first.pairing.rows[0].gate1.push('凭空加的形态')
		first.templates.checklist = ''
		assert.equal(loadDispatchData({ dataDir: dir }).forms.forms[0].catches, second.forms.forms[0].catches, '上一份返回值被深改，下一次现读不受污染')
		assert.ok(!loadDispatchData({ dataDir: dir }).pairing.rows[0].gate1.includes('凭空加的形态'))
	})
})

test('批1 数据迁移：砍刀/砍刀·diff 进对齐的主行门列、用户可见 gate2 终值、addon 行两门逐字不动、砍刀·diff 形态与门一重派节奏条在位（改前值硬编码，防回退与误扩）', () => {
	const data = loadDispatchData()
	const rowOf = (batchType) => data.pairing.rows.find((row) => row.batchType === batchType)
	// 四主行 gate1 终值逐字钉住（含砍刀；乱序/多挂/漏一项都红——includes 只守成员守不住顺序与长度）
	assert.deepEqual(rowOf('纯后端管线批').gate1, ['锚点核对', '事实校准', '工程复用', '砍刀'])
	assert.deepEqual(rowOf('跨端契约批').gate1, ['锚点核对', '事实校准', '砍刀'])
	assert.deepEqual(rowOf('配置/迁移批').gate1, ['锚点核对', '砍刀'])
	assert.deepEqual(rowOf('新功能·形态未定').gate1, ['锚点核对', '第一性原理', '砍刀'])
	// 六主行 gate2 终值逐字钉住（各含砍刀·diff；用户可见终值另列）
	assert.deepEqual(rowOf('纯后端管线批').gate2, ['设计七维·终审', '连带面', '砍刀·diff'])
	assert.deepEqual(rowOf('跨端契约批').gate2, ['契约一致性', '连带面', '砍刀·diff'])
	assert.deepEqual(rowOf('配置/迁移批').gate2, ['迁移执行核对', '连带面', '蜕变关系问', '砍刀·diff'])
	assert.deepEqual(rowOf('机械搬运/小修').gate2, ['连带面', '金主比对', '砍刀·diff'])
	assert.deepEqual(rowOf('直做批').gate2, ['设计七维·终审', '连带面', '砍刀·diff'])
	// 用户可见功能批 gate2 终值（三问改加挂制后基组合＝七维终审＋连带面＋GUI 目检＋砍刀·diff）
	assert.deepEqual(rowOf('用户可见功能批').gate2, ['设计七维·终审', '连带面', 'GUI 目检', '砍刀·diff'])
	// addon 行两门与批1 改前逐字相等（砍刀/砍刀·diff 不进 addon 行是钉死口径）
	assert.deepEqual(rowOf('涉鉴权/上传/输入').gate1, ['安全清单行'])
	assert.deepEqual(rowOf('涉鉴权/上传/输入').gate2, ['安全专项'])
	assert.deepEqual(rowOf('大数值/通知批').gate1, ['数字口径问'])
	assert.deepEqual(rowOf('大数值/通知批').gate2, ['设计七维·终审', '连带面'])
	assert.deepEqual(rowOf('大工程方案').gate1, ['施工走查'])
	assert.equal(rowOf('大工程方案').gate2, null)
	// 新形态四字段齐全（catches 缺了加载器直接抛，这里钉它真的在且门别正确）
	const machete = data.forms.forms.find((form) => form.id === '砍刀·diff')
	assert.ok(machete, 'forms 含 id=砍刀·diff')
	assert.equal(machete.gate, '门二')
	assert.ok(machete.catches.length > 0, '砍刀·diff 的 catches 非空')
	// 门一重派节奏条：when.stage 深等于 ["门一"]、note 为非空动作句——按「整套重派门一」点新条，
	// 不按「stage=门一」泛找：旧的大工程走查条本就命中那个泛判据，泛找在改前也恒绿，等于没断言
	const reentries = data.pairing.rhythm.filter((entry) => Array.isArray(entry.when.stage) && entry.when.stage.length === 1 && entry.when.stage[0] === '门一')
	assert.ok(
		reentries.some((entry) => entry.note.includes('整套重派门一')),
		'rhythm 含 when.stage=["门一"] 的重派动作条',
	)
})

test('rhythm 的 when.stage 条目逐条可达（判据）：按条目自己的谓词合成参数，note 必须真的从 matchRhythm 出来', () => {
	// 数据驱动：盘上加一条 when.stage 条目而它的谓词合成不出命中参数时，这条先红——
	// 「可达性」不靠人眼对 pairing.json，也不在测试里手抄五条 note
	const staged = loadDispatchData().pairing.rhythm.filter((row) => row.when.stage !== undefined)
	assert.ok(staged.length >= 5, `盘上 when.stage 条目少于 5 条时这份样本失了代表性：实得 ${staged.length} 条`)
	for (const row of staged) {
		const params = {
			stage: row.when.stage[0],
			batchType: row.when.batchType?.[0] ?? '纯后端管线批',
			provider: row.when.provider?.[0] ?? 'minimax-cn',
			// 规模谓词两键：取本条自己声明的那一头即落在区间内（无规模谓词的条目给非零值不碍事）
			diffLines: row.when.diffLines?.max ?? row.when.diffLines?.min ?? 3,
			changedFiles: row.when.changedFiles?.max ?? row.when.changedFiles?.min ?? 1,
		}
		assert.ok(
			matchRhythm(loadDispatchData(), params).includes(row.note),
			`when.stage 条目「${row.note.slice(0, 24)}…」按自身谓词合成的参数命不中自己：${JSON.stringify(row.when)}`,
		)
	}
})
