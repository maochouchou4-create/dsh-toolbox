/**
 * dispatch 数据面（两份人读 markdown ＋ 一份阶段表 JSON）的镜像与互验：形状、跨文件绑死、
 * 模板整份指纹、安全五问单载体，外加「改坏必红」的变异演示（埋雷体检内置于测试，nip 在数据面
 * 而不是人脑）。
 *
 * 镜像为什么放这里：这几份文件是规则面，改一个字就改行为；测试不镜像时，改动只在下次注入/调用时
 * 才现形，而那时已经进了生产。指纹只钉「正文有没有变」——逐字副本每次改模板都要抄一遍，抄漏是静默的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	DATA_FILES,
	DISCIPLINE_LINE_LIMIT,
	DispatchDataError,
	SAFETY_ANCHORS,
	SAFETY_SECTION_MARKER,
	TEMPLATES_PLACEHOLDER,
	TEMPLATE_SECTIONS,
	loadDispatchData,
	resolveDataDir,
} from '../lib/dispatch/data.js'
import { KIND_ACTIONS, LIFECYCLE_KINDS } from '../lib/dispatch/vocab.js'
import { DISPATCH_DATA_DIR, editData, editText, withDataDir } from './helpers.js'

/** templates.md 整份正文的指纹（sha256 前 16 位）：改正文＝改规则，同步更新这里的指纹。 */
const TEMPLATES_SNAPSHOT = '9e402644749bbd61'

const digestOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

const REPO_ROOT = join(DISPATCH_DATA_DIR, '..', '..', '..')

/** 仓内全部 .md 文件（跳过 node_modules 与 .git）：安全五问整节的全仓计数就在这个面上做。 */
const collectMarkdown = (dir, out = []) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === '.git') continue
		const path = join(dir, entry.name)
		if (entry.isDirectory()) collectMarkdown(path, out)
		else if (entry.name.endsWith('.md')) out.push(path)
	}
	return out
}

test('数据面加载全绿：三份现读、零 issue', () => {
	const loaded = loadDispatchData()
	assert.deepEqual(Object.keys(loaded.data).sort(), DATA_FILES.map((entry) => entry.name).sort())
	for (const entry of DATA_FILES) {
		assert.equal(typeof loaded.raw[entry.name], 'string', `${entry.file} 的原始字节要留着（规则指纹取它）`)
	}
})

test('阶段表：四阶段只有 id/order/kind 三键，顺序与词表逐位相等', () => {
	const { data } = loadDispatchData()
	const stages = [...data.lifecycle.stages].sort((a, b) => a.order - b.order)
	assert.deepEqual(stages.map((stage) => stage.id), LIFECYCLE_KINDS)
	assert.deepEqual(stages.map((stage) => stage.kind), LIFECYCLE_KINDS)
	assert.deepEqual(stages.map((stage) => stage.order), [1, 2, 3, 4])
	for (const stage of stages) {
		assert.deepEqual(Object.keys(stage).sort(), ['id', 'kind', 'order'], '阶段表只留三键——requires/gate/note 的语义已随装配工具退役')
	}
})

test('模板八节骨架：每节标题恰一次且按序出现（缺节＝模板迁移漏内容）', () => {
	const { data } = loadDispatchData()
	const headings = data.templates.split('\n').filter((line) => line.startsWith('## '))
	assert.deepEqual(headings, [...TEMPLATE_SECTIONS.slice(0, 6), headings[6], TEMPLATE_SECTIONS[6]], '节序固定')
	for (const section of TEMPLATE_SECTIONS) {
		assert.equal(data.templates.split(section).length - 1, 1, `节标题「${section}」必须恰一次`)
	}
	assert.ok(headings[6].startsWith(SAFETY_SECTION_MARKER), '安全专项节排在门报行之后、不做清单之前')
})

test('模板整份指纹：改正文＝改规则（同步更新 TEMPLATES_SNAPSHOT）', () => {
	const { data } = loadDispatchData()
	assert.equal(digestOf(data.templates), TEMPLATES_SNAPSHOT)
})

test('去渲染占位符语法：模板与纪律正文里不再有〔…〕（模板已变人读文件）', () => {
	const { data } = loadDispatchData()
	assert.ok(!data.templates.includes('〔'), 'templates.md 不该再有渲染占位符')
	assert.ok(!data.discipline.includes('〔'), 'discipline.md 不该再有渲染占位符')
})

test('安全五问单载体：整节标题全仓只有 templates.md 一处，五问锚点只在小节内', () => {
	const { data } = loadDispatchData()
	const safetyHeading = data.templates.split('\n').find((line) => line.startsWith(SAFETY_SECTION_MARKER))
	assert.ok(safetyHeading, 'templates.md 必须有安全专项整节标题')
	const offenders = collectMarkdown(REPO_ROOT).filter((path) => readFileSync(path, 'utf8').includes(safetyHeading))
	assert.deepEqual(offenders, [join(DISPATCH_DATA_DIR, 'templates.md')], '安全五问整节全仓只许一处定义（README/纪律/别的模板复述即红）')
	const markerAt = data.templates.indexOf(SAFETY_SECTION_MARKER)
	const sectionEnd = data.templates.indexOf('\n## ', markerAt + 1)
	const safety = data.templates.slice(markerAt, sectionEnd === -1 ? undefined : sectionEnd)
	for (const anchor of SAFETY_ANCHORS) assert.ok(safety.includes(anchor), `安全专项节缺五问锚点「${anchor}」`)
})

test('纪律文本：行数与占位符在限内，四个台账动作按阶段序出现', () => {
	const { data } = loadDispatchData()
	const lines = data.discipline.replace(/\n$/, '').split('\n').length
	assert.ok(lines <= DISCIPLINE_LINE_LIMIT, `纪律 ${lines} 行超 ${DISCIPLINE_LINE_LIMIT} 行上限`)
	assert.equal(data.discipline.split(TEMPLATES_PLACEHOLDER).length - 1, 1, '模板路径占位必须恰一处')
	let last = -1
	for (const kind of LIFECYCLE_KINDS) {
		const at = data.discipline.indexOf(`action=${KIND_ACTIONS[kind]}`)
		assert.ok(at > last, `阶段「${kind}」的 action 必须出现且在上一阶段之后`)
		last = at
	}
})

test('埋雷体检：缺模板节／五问锚点挪出小节／纪律脱节——数据面必红', (t) => {
	withDataDir(t, (dir) => {
		assert.doesNotThrow(() => loadDispatchData(dir), '拷来的真数据先要能加载')

		editText(dir, 'templates.md', (text) => text.replace(/^## 横切判据$/m, '## 横向判据'))
		assert.throws(() => loadDispatchData(dir), /节标题「## 横切判据」必须恰好出现一次/)

		editText(dir, 'templates.md', (text) => text.replace(/^## 横向判据$/m, '## 横切判据'))
		assert.doesNotThrow(() => loadDispatchData(dir), '复原后应回绿')

		editText(dir, 'templates.md', (text) => `${text}\n鉴权：横切里顺手提一句五问。\n`)
		assert.throws(() => loadDispatchData(dir), /在安全专项小节之外也出现了/)
	})
})

test('埋雷体检：纪律缺阶段动作／顺序颠倒／超行数——数据面必红', (t) => {
	withDataDir(t, (dir) => {
		editText(dir, 'discipline.md', (text) => text.replaceAll('action=gate', 'action=审批'))
		assert.throws(() => loadDispatchData(dir), /缺阶段动作 action=gate/)

		editText(dir, 'discipline.md', (text) => text.replaceAll('action=审批', 'action=gate'))
		editText(dir, 'discipline.md', (text) => {
			const rows = text.replace(/\n$/, '').split('\n')
			const iStart = rows.findIndex((row) => row.includes('action=start'))
			const iGate = rows.findIndex((row) => row.includes('action=gate'))
			;[rows[iStart], rows[iGate]] = [rows[iGate], rows[iStart]]
			return `${rows.join('\n')}\n`
		})
		assert.throws(() => loadDispatchData(dir), /顺序与阶段表不一致/)

		editText(dir, 'discipline.md', (text) => `${text}${Array.from({ length: DISCIPLINE_LINE_LIMIT }, (_, i) => `- 补行 ${i}`).join('\n')}\n`)
		assert.throws(() => loadDispatchData(dir), /超过 12 行上限/)
	})
})

test('埋雷体检：阶段表多字段／order 断裂／kind 不在词表——数据面必红', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (value) => { value.stages[0].gate = true })
		assert.throws(() => loadDispatchData(dir), /未知字段 gate/)

		editData(dir, 'lifecycle.json', (value) => { delete value.stages[0].gate; value.stages[2].order = 5 })
		assert.throws(() => loadDispatchData(dir), /order 必须从 1 连续编号/)

		editData(dir, 'lifecycle.json', (value) => { value.stages[2].order = 3; value.stages[2].kind = '验收' })
		assert.throws(() => loadDispatchData(dir), /kind 必须是四阶段名之一/)
	})
})

test('数据文件缺失即红：读不到不当空表处理', (t) => {
	withDataDir(t, (dir) => {
		rmSync(join(dir, 'templates.md'))
		assert.throws(() => loadDispatchData(dir), /读不到数据文件/)
	})
})

test('空数据文件即红：空文件不是「没有规则」而是没装好', (t) => {
	withDataDir(t, (dir) => {
		writeFileSync(join(dir, 'discipline.md'), '   \n')
		assert.throws(() => loadDispatchData(dir), /discipline\.md 是空的/)
	})
})

test('坏 JSON 即红：报出文件名与解析原因', (t) => {
	withDataDir(t, (dir) => {
		writeFileSync(join(dir, 'lifecycle.json'), '{ not json')
		assert.throws(() => loadDispatchData(dir), /lifecycle\.json 不是合法 JSON/)
	})
})

test('DispatchDataError 是加载期唯一错误类型（调用方只 catch 这一种）', () => {
	try {
		loadDispatchData(join(DISPATCH_DATA_DIR, 'missing'))
		assert.fail('应抛 DispatchDataError')
	} catch (error) {
		assert.ok(error instanceof DispatchDataError)
		assert.match(error.message, /读不到数据文件/)
	}
})

test('数据目录解析：显式目录优先、空串与未配置回落到仓内 data/', () => {
	assert.equal(resolveDataDir(''), DISPATCH_DATA_DIR)
	assert.equal(resolveDataDir(undefined), DISPATCH_DATA_DIR)
	assert.equal(resolveDataDir('/tmp/whatever'), '/tmp/whatever')
})

test('埋雷体检：模板节标题重复出现（安全专项除外）必红', (t) => {
	withDataDir(t, (dir) => {
		editText(dir, 'templates.md', (text) => `${text}\n## 拍板卡\n\n重复的一节。\n`)
		assert.throws(() => loadDispatchData(dir), /节标题「## 拍板卡」必须恰好出现一次/)
	})
})

test('埋雷体检：安全专项节出现两次必红（单载体是硬约束）', (t) => {
	withDataDir(t, (dir) => {
		editText(dir, 'templates.md', (text) => `${text}\n## 安全专项五问\n\n复述一遍。\n`)
		assert.throws(() => loadDispatchData(dir), /安全专项整节「## 安全专项五问…」必须恰好出现一次/)
	})
})

test('埋雷体检：阶段表 kind 缺失或重复必红', (t) => {
	withDataDir(t, (dir) => {
		editData(dir, 'lifecycle.json', (value) => { delete value.stages[0].kind })
		assert.throws(() => loadDispatchData(dir), /缺字段 kind/)
		editData(dir, 'lifecycle.json', (value) => {
			value.stages[0].kind = '立项'
			value.stages[1].kind = '立项'
		})
		assert.throws(() => loadDispatchData(dir), /kind 重复：立项/)
	})
})

test('埋雷体检：纪律缺模板占位或占位两次必红', (t) => {
	withDataDir(t, (dir) => {
		editText(dir, 'discipline.md', (text) => text.replaceAll(TEMPLATES_PLACEHOLDER, '模板文件'))
		assert.throws(() => loadDispatchData(dir), /模板占位 \{templates\} 必须恰好出现一次/)
		editText(dir, 'discipline.md', (text) => text.replaceAll('模板文件', TEMPLATES_PLACEHOLDER))
		editText(dir, 'discipline.md', (text) => `${text}模板：${TEMPLATES_PLACEHOLDER}\n`)
		assert.throws(() => loadDispatchData(dir), /模板占位 \{templates\} 必须恰好出现一次/)
	})
})
