/**
 * dispatch 现读面数据加载单测（node:test，零宿主依赖）：坏 JSON、形状不合、悬空形态 id、
 * 孤儿形态只报不拦，以及「改文件后下次调用取新值」——最后这条钉的是现读本身：加载器哪天
 * 被改成 import 静态化或加一层缓存，改规则就变成「改了不生效还不报错」，而这里照样全绿。
 * 读法沿用仓内先例：node:fs 直读 JSON＋临时目录＋node:test（不 import 宿主包）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleDispatch, computeCombo } from '../lib/dispatch/core.js'
import { DEFAULT_DATA_DIR, loadDispatchData } from '../lib/dispatch/data.js'

const GATE_COLUMNS = ['gate1', 'gate2']

/** 现读面的五份数据：少拷一份＝临时目录里那份读不到，用例全红在无关的原因上。 */
const DATA_FILES = ['forms.json', 'pairing.json', 'templates.json', 'lifecycle.json', 'plan-spec.json']

/** 一份可随意改坏的临时数据目录：按盘上真数据落盘 → mutator 改坏 → 跑断言 → 删。 */
function withDataDir(mutate, run) {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-dispatch-data-'))
	try {
		for (const file of DATA_FILES) {
			writeFileSync(join(dir, file), readFileSync(join(DEFAULT_DATA_DIR, file)))
		}
		mutate?.(dir)
		return run(dir)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

/**
 * 改临时目录里的一份数据再写回。刻意只从磁盘文本重新解析、不复用任何一次加载返回的对象：
 * 复用的话，下面那条「改文件后取新值」的用例就会被自己写回的那份缓存喂绿。
 */
const editData = (dir, file, mutate) => {
	const value = JSON.parse(readFileSync(join(dir, file), 'utf8'))
	mutate(value)
	writeFileSync(join(dir, file), JSON.stringify(value))
}

const orphanId = (warning) => warning.match(/「(.+?)」/)[1]

test('盘上真数据加载即用：20 形态／10 配对行／9 节奏／6 阶段／13 节，warnings 只收两条预期孤儿', () => {
	const data = loadDispatchData()
	assert.deepEqual(Object.keys(data).sort(), ['forms', 'lifecycle', 'pairing', 'planSpec', 'templates', 'warnings'])
	assert.equal(data.forms.forms.length, 20)
	assert.equal(data.pairing.rows.length, 10)
	assert.equal(data.pairing.rhythm.length, 9)
	assert.equal(data.lifecycle.stages.length, 6)
	assert.equal(data.planSpec.blocks.length, 13)
	assert.deepEqual(data.warnings.map(orphanId).sort(), ['设计七维', '证伪复核'], '形状与引用自洽才加载得出来，孤儿只报不拦')
	assert.ok(data.warnings.every((warning) => warning.includes('预期孤儿')), '孤儿告警带出该形态自己的 notes，说明它是刻意的')
	// 加载出来的那份直接喂 core：这一条兜住「加载通过但核心函数吃不下」的缝
	const output = assembleDispatch(data, { stage: '门二', batchType: '纯后端管线批', subject: 'git diff HEAD~1', intent: '终审' })
	assert.equal(output.briefs.length, 5)
})

test('dataDir 省略或留空串＝模块同目录的 ./data/（Config 默认值走同一条路）', () => {
	assert.equal(loadDispatchData({ dataDir: '' }).forms.forms.length, 20)
	assert.deepEqual(loadDispatchData({ dataDir: DEFAULT_DATA_DIR }).warnings, loadDispatchData().warnings)
})

test('坏 JSON 显式报错，错误里点得出是哪个文件', () => {
	withDataDir(
		(dir) => writeFileSync(join(dir, 'pairing.json'), '{ "rows": [ '),
		(dir) => assert.throws(() => loadDispatchData({ dataDir: dir }), /pairing\.json 不是合法 JSON/),
	)
	withDataDir((dir) => rmSync(join(dir, 'templates.json')), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /dispatch 数据读取失败.*templates\.json/, '文件读不到也要报出路径，不静默出空数据')
	})
})

test('形状不合显式报错，错误点名文件与字段（缺字段／类型错／枚举越界／多出字段）', () => {
	withDataDir((dir) => editData(dir, 'forms.json', (forms) => delete forms.rejected), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /forms\.json 缺字段「rejected」/)
	})
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => { pairing.rows[0].gate1 = '锚点核对' }), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /pairing\.json\.rows\[0\]\.gate1 须是 string\[\]/)
	})
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => { pairing.rows[5].kind = 'addonn' }), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /rows\[5\]\.kind 须是 enum\(addon,special\)/)
	})
	withDataDir((dir) => editData(dir, 'templates.json', (templates) => { templates.checklistt = '拼错的键' }), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /多出未声明的模板键「checklistt」.*没有任何阶段会读到它/, '模板键的白名单＝lifecycle 各行的 templateKey 加那几张辅助页（拼错的键没有任何阶段会读到它）')
	})
})

test('配对指向未定义形态＝加载失败（悬空即错：静默出稿的代价是漏派一整门复核）', () => {
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => { pairing.rows[0].gate2[0] = '没定过的形态' }), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /悬空引用.*纯后端管线批.*没定过的形态/)
	})
})

test('去掉一条配对引用不失败：该形态进 warnings，数据照常返回', () => {
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		for (const row of pairing.rows) {
			for (const column of GATE_COLUMNS) {
				if (row[column] !== null) row[column] = row[column].filter((id) => id !== '砍刀')
			}
		}
	}), (dir) => {
		const data = loadDispatchData({ dataDir: dir })
		assert.equal(data.forms.forms.length, 20, '孤儿只报不拦：三份数据照常返回，装配层继续可用')
		assert.ok(data.warnings.some((warning) => orphanId(warning) === '砍刀'), '无引用（且自己没写 notes）的形态也进 warnings')
		assert.deepEqual(data.warnings.filter((warning) => warning.includes('预期孤儿')).map(orphanId).sort(), ['设计七维', '证伪复核'])
	})
})

test('改文件后下次调用取新值（现读不被偷偷改成 import 缓存）', () => {
	withDataDir(undefined, (dir) => {
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

test('空集下限：forms／rows／rhythm／stages／blocks／checklist 任一被清空＝加载失败（规则面装不出东西却装得上＝有人整段删了规则没报错）', () => {
	for (const [file, mutate, where] of [
		['forms.json', (value) => { value.forms = [] }, /forms\.json 的 forms/],
		['pairing.json', (value) => { value.rows = [] }, /pairing\.json 的 rows/],
		['pairing.json', (value) => { value.rhythm = [] }, /pairing\.json 的 rhythm/],
		['lifecycle.json', (value) => { value.stages = [] }, /lifecycle\.json 的 stages/],
		['plan-spec.json', (value) => { value.blocks = [] }, /plan-spec\.json 的 blocks/],
		['plan-spec.json', (value) => { value.checklist = [] }, /plan-spec\.json 的 checklist/],
	]) {
		withDataDir((dir) => editData(dir, file, mutate), (dir) => {
			assert.throws(() => loadDispatchData({ dataDir: dir }), where)
		})
	}
})

test('唯一性：行名或形态 id 重名＝加载失败（重名那条等于悄悄失效）', () => {
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		pairing.rows.push(structuredClone(pairing.rows[0]))
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /pairing\.json 的批型行名.*出现两次「纯后端管线批」/)
	})
	withDataDir((dir) => editData(dir, 'forms.json', (forms) => {
		forms.forms.push(structuredClone(forms.forms[0]))
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /forms\.json 的形态 id.*出现两次「锚点核对」/)
	})
})

test('主行的 gate 列写成空数组＝告警不拦（有意免派该门请写 null，空数组疑似漏配）', () => {
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		pairing.rows[0].gate2 = []
	}), (dir) => {
		const data = loadDispatchData({ dataDir: dir })
		assert.ok(data.warnings.some((warning) => warning.includes('批型「纯后端管线批」') && warning.includes('空数组疑似漏配')))
		assert.equal(data.pairing.rows[0].gate2.length, 0, '数据照常返回，装配层把这一趟出成空组合')
	})
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		pairing.rows[8].gate2 = []
	}), (dir) => {
		assert.ok(!loadDispatchData({ dataDir: dir }).warnings.some((warning) => warning.includes('空数组疑似漏配')), 'needsBase 行本来就走 base 行解析，空列不算漏配')
	})
})

test('门别交叉核：gate1 列混进门二形态＝加载失败（错了门＝派错形态，主会话看不出来）', () => {
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		pairing.rows[0].gate1 = ['设计七维·终审']
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /门别不合.*纯后端管线批.*gate1.*设计七维·终审/)
	})
})

test('阶段表专核：stage id／order 重名、复核阶段不在门别映射内＝加载失败（阶段表是 stage 词表与必填矩阵的单源，坏行等于静默失效）', () => {
	withDataDir((dir) => editData(dir, 'lifecycle.json', (lifecycle) => {
		lifecycle.stages.push(structuredClone(lifecycle.stages[0]))
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /lifecycle\.json 的 stage id.*出现两次「方案」/)
	})
	withDataDir((dir) => editData(dir, 'lifecycle.json', (lifecycle) => {
		lifecycle.stages[2].order = 2
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /lifecycle\.json 的 order.*出现两次「2」/)
	})
	withDataDir((dir) => editData(dir, 'lifecycle.json', (lifecycle) => {
		lifecycle.stages[1].id = '形式审查'
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /门别不明.*复核阶段「形式审查」.*门一、门二/, '复核阶段反查不到配对列就出空组合，那一门复核等于没派')
	})
	withDataDir((dir) => editData(dir, 'lifecycle.json', (lifecycle) => {
		lifecycle.stages[0].kind = '随便'
	}), (dir) => {
		assert.doesNotThrow(() => loadDispatchData({ dataDir: dir }), '非复核阶段的 kind 不参与门别推导（认不出的值不拦——它只决定出不出组合，出空是安全侧）')
	})
	withDataDir((dir) => editData(dir, 'lifecycle.json', (lifecycle) => {
		lifecycle.stages[0].requires = 'subject'
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /lifecycle\.json\.stages\[0\]\.requires 须是 string\[\]/)
	})
})

test('阶段表专核：order 非正整数、requires 重复或域外、gate 与 kind 不等价＝加载失败（都是「改了不报错」那一类）', () => {
	for (const [order, where] of [[0, '须是正整数'], [-1, '须是正整数'], [1.5, '须是正整数']]) {
		withDataDir((dir) => editData(dir, 'lifecycle.json', (lifecycle) => { lifecycle.stages[0].order = order }), (dir) => {
			assert.throws(() => loadDispatchData({ dataDir: dir }), new RegExp(`stage「方案」order ${where}`), `order=${order}：阶段先后与词表顺序都按它排，非正整数排出来的先后是任意的`)
		})
	}
	withDataDir((dir) => editData(dir, 'lifecycle.json', (lifecycle) => {
		lifecycle.stages[1].requires = ['batchType', 'subject', 'intent', 'intent']
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /stage「门一」的 requires 里出现两次「intent」/, '重复项让必填矩阵与消费集各算一次，两处结果可能不同')
	})
	withDataDir((dir) => editData(dir, 'lifecycle.json', (lifecycle) => {
		lifecycle.stages[1].requires = ['batchType', 'subject', 'intent', '锚点']
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /取值域外.*stage「门一」requires 含「锚点」.*参数名全集/, '凭空的必填名等于向调用方要一个不存在的参数')
	})
	assert.doesNotThrow(() => loadDispatchData(), '空 requires 是合法边界：提交/复盘两行就是（那两行归各自的工具，本工具不为它们要参数）')
	withDataDir((dir) => editData(dir, 'lifecycle.json', (lifecycle) => {
		lifecycle.stages[1].gate = false
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /门别表述不一致.*stage「门一」gate=false 而 kind='复核'.*复核阶段该置 true/, 'gate 与 kind 是同一件事的两处表述，互验后不会再各错一次')
	})
	withDataDir((dir) => editData(dir, 'lifecycle.json', (lifecycle) => {
		lifecycle.stages[2].gate = true
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /门别表述不一致.*stage「施工」gate=true 而 kind='施工'.*非复核阶段该置 false/)
	})
	assert.doesNotThrow(() => loadDispatchData(), '提交那行 gate=true 而 kind=提交：互验只管本工具服务的那四行，提交/复盘的 gate 语义归各自的工具')
})

test('阶段表专核：uses 里的 plan-spec.json 与模板里的 plan-spec 占位双向互为充要（勾了不用、用了没勾都拦）', () => {
	withDataDir((dir) => editData(dir, 'lifecycle.json', (lifecycle) => {
		lifecycle.stages[3].uses = ['plan-spec.json', 'pairing.json', 'templates.json']
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /引用不一致.*stage「门二」uses 声明了 plan-spec\.json，模板里却没有 plan-spec 占位/, '勾了不用：清单说这一趟吃 plan-spec，正文里却没有它的位置')
	})
	withDataDir((dir) => editData(dir, 'lifecycle.json', (lifecycle) => {
		lifecycle.stages[0].uses = ['templates.json']
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /引用不一致.*stage「方案」模板里有 plan-spec 占位，uses 却没声明 plan-spec\.json/, '用了没勾：正文在吃 plan-spec，清单上查不到')
	})
})

test('plan-spec 节 id 唯一：重名＝加载失败（查表取第一条，重名那条等于悄悄失效）', () => {
	withDataDir((dir) => editData(dir, 'plan-spec.json', (planSpec) => {
		planSpec.blocks.push({ ...structuredClone(planSpec.blocks[2]), title: '另一个写前必读' })
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /plan-spec\.json 的节 id.*出现两次「read-first」/)
	})
})

test('缺文件报错：五份数据任何一份读不到都带路径报错（lifecycle 与 planSpec 同样显式，不静默出空规则面）', () => {
	for (const file of ['forms.json', 'pairing.json', 'templates.json', 'lifecycle.json', 'plan-spec.json']) {
		withDataDir((dir) => rmSync(join(dir, file)), (dir) => {
			assert.throws(
				() => loadDispatchData({ dataDir: dir }),
				new RegExp(`dispatch 数据读取失败.*${file.replace('.', '\\.')}`),
				`${file} 读不到也要报出路径，不静默出空数据`,
			)
		})
	}
})

test('节奏谓词取值交叉核：batchType／stage 拼错＝加载失败（拼错的谓词永不命中＝规则静默失效）', () => {
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		pairing.rhythm[0].when.batchType = ['修副批']
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /谓词取值不存在.*when\.batchType.*修副批/)
	})
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		pairing.rhythm[6].when.stage = ['施攻']
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /谓词取值不存在.*when\.stage.*施攻/)
	})
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		pairing.rhythm[6].when.batchType = ['纯后端管线批']
	}), (dir) => {
		assert.doesNotThrow(() => loadDispatchData({ dataDir: dir }), 'provider 是自由文本（两机各自的模型 id），无词表可核；batchType 与 stage 有词表才核')
	})
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		pairing.rhythm[6].when.stage = ['提交']
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /谓词取值不存在.*when\.stage.*提交/, 'stage 谓词只对着本工具能出稿的阶段：提交归台账工具，以它为谓词值那条规则永不命中')
	})
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		pairing.rhythm[0].when.batchType = ['涉鉴权/上传/输入']
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /谓词取值不存在.*when\.batchType.*涉鉴权\/上传\/输入/, 'batchType 谓词只对着主行：addon 行不作 batchType，那条谓词永不命中')
	})
})

test('谓词交集可达性：stage 与 batchType 各限一批而两者不相交＝加载失败（谓词值各自合法但永不命中）', () => {
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		pairing.rhythm.push({ when: { batchType: ['修复批'], stage: ['方案'] }, note: '永不可达条目' })
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /谓词永不可达.*永不可达条目.*不会同时成立/, '方案那一趟不判批型，两个在字段的交集为空——这条规则在任何调用下都不命中')
	})
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		pairing.rhythm.push({ when: { batchType: ['修复批'], stage: ['施工'] }, note: '可达条目' })
	}), (dir) => {
		assert.doesNotThrow(() => loadDispatchData({ dataDir: dir }), '交集非空即放行：施工判批型，那一趟两个在字段同时成立')
	})
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		pairing.rhythm.push({ when: { stage: ['方案'] }, note: '只限阶段的条目' })
	}), (dir) => {
		assert.doesNotThrow(() => loadDispatchData({ dataDir: dir }), '只有一个在字段时按它自己核，不因另一字段缺省而判不可达')
	})
})

test('模板键白名单：lifecycle 声明过的键放行（加阶段不改代码），没声明的键＝加载失败', () => {
	withDataDir((dir) => {
		editData(dir, 'lifecycle.json', (lifecycle) => lifecycle.stages.push({
			id: '验收', order: 7, gate: false, kind: '验收', requires: ['subject', 'intent'], produces: ['验收结论'], uses: [],
		}))
		editData(dir, 'templates.json', (templates) => { templates.验收 = '验收结论：〔subject〕。' })
	}, (dir) => {
		const data = loadDispatchData({ dataDir: dir })
		assert.equal(assembleDispatch(data, { stage: '验收', subject: '净 diff', intent: '验收' }).briefs[0].text, '验收结论：净 diff。', '加 stage 只改 JSON：新阶段经真加载就能出稿')
	})
	withDataDir((dir) => editData(dir, 'templates.json', (templates) => { templates.门三 = '没人会读它：〔subject〕。' }), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /多出未声明的模板键「门三」.*没有任何阶段会读到它/, '闭集照旧拦新模板：多出来的键没有任何阶段会读到它')
	})
})

test('占位登记校验：模板里出现未登记的占位＝加载失败（留到渲染期才炸＝规则删了不报错）', () => {
	withDataDir((dir) => editData(dir, 'templates.json', (templates) => {
		templates.门一 = templates.门一.replace('〔intent〕', '〔本批想要什么〕')
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /占位未登记.*templates\.json.*门一.*本批想要什么/)
	})
	withDataDir((dir) => editData(dir, 'templates.json', (templates) => {
		templates.施工 = `${templates.施工}\n收尾句：〔逐条列出来〕。`
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /占位未登记.*施工.*逐条列出来/)
	})
	const taskBook = assembleDispatch(loadDispatchData(), { stage: '方案', subject: '方案.md 批 1', intent: '出方案' }).briefs[0]
	assert.ok(!taskBook.text.includes('〔'), '方案任务书那两条占位已接到 plan-spec 数据上——渲染到的是 13 节正文与自查清单，不是半截模板')
	assert.ok(taskBook.text.includes('## 根设计原则') && taskBook.text.includes('①软前提两档制'))
})

test('formNotes：限定句的值须是字符串，键须是 forms 定义过的形态 id', () => {
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		pairing.rows[2].formNotes.连带面 = '   '
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /formNotes\.连带面 须是 string/)
	})
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		pairing.rows[2].formNotes['没定过的形态'] = '限定句安在没定义的形态上'
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /悬空引用.*formNotes.*没定过的形态/)
	})
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => {
		pairing.rows[2].formNotes = ['连带面']
	}), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /formNotes 须是 stringMap/)
	})
})

test('元素级与空白级校验：数组里有空串／空白串／非串元素即报错（数据里的空字段多半是漏写）', () => {
	for (const [value, pattern] of [
		[['锚点核对', ''], /rows\[0\]\.gate1 须是 string\[\]/],
		[['锚点核对', '   '], /rows\[0\]\.gate1 须是 string\[\]/],
		[['锚点核对', 7], /rows\[0\]\.gate1 须是 string\[\]/],
	]) {
		withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => { pairing.rows[0].gate1 = value }), (dir) => {
			assert.throws(() => loadDispatchData({ dataDir: dir }), pattern)
		})
	}
	withDataDir((dir) => editData(dir, 'forms.json', (forms) => { forms.forms[0].role = '' }), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /forms\[0\]\.role 须是 string/)
	})
	withDataDir((dir) => editData(dir, 'templates.json', (templates) => { templates.checklist = '  ' }), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /templates\.json\.checklist 须是 string/)
	})
	withDataDir((dir) => editData(dir, 'pairing.json', (pairing) => { delete pairing.rhythm[0].note }), (dir) => {
		assert.throws(() => loadDispatchData({ dataDir: dir }), /rhythm\[0\] 缺字段「note」/)
	})
})

test('现读的深等价：两次加载内容逐字一致，且首份返回值被深改不影响次次', () => {
	withDataDir(undefined, (dir) => {
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
