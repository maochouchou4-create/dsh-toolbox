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

/** 一份可随意改坏的临时数据目录：按盘上真数据落盘 → mutator 改坏 → 跑断言 → 删。 */
function withDataDir(mutate, run) {
	const dir = mkdtempSync(join(tmpdir(), 'dsh-dispatch-data-'))
	try {
		for (const file of ['forms.json', 'pairing.json', 'templates.json']) {
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

test('盘上真数据加载即用：20 形态／10 配对行／9 节奏，warnings 只收两条预期孤儿', () => {
	const data = loadDispatchData()
	assert.deepEqual(Object.keys(data).sort(), ['forms', 'pairing', 'templates', 'warnings'])
	assert.equal(data.forms.forms.length, 20)
	assert.equal(data.pairing.rows.length, 10)
	assert.equal(data.pairing.rhythm.length, 9)
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
		assert.throws(() => loadDispatchData({ dataDir: dir }), /templates\.json 多出未声明字段「checklistt」/)
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

test('空集下限：forms／rows／rhythm 任一被清空＝加载失败（规则面装不出东西却装得上＝有人整段删了规则没报错）', () => {
	for (const [file, mutate, where] of [
		['forms.json', (value) => { value.forms = [] }, /forms\.json 的 forms/],
		['pairing.json', (value) => { value.rows = [] }, /pairing\.json 的 rows/],
		['pairing.json', (value) => { value.rhythm = [] }, /pairing\.json 的 rhythm/],
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
	assert.ok(loadDispatchData().templates.方案任务书.includes('〔plan-spec 13 节逐字'), '方案任务书那两条占位已在册——数据面先于接线就位，渲染到即显式报错')
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
