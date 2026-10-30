/**
 * dispatch 数据面（两份人读 markdown）的行为测试：加载全绿冒烟（纪律两守卫顺带跑真文件）、
 * 模板骨架结构（骨架八节＋安全专项节按整行等值各恰一次／安全五问整节与锚点只此一处）、
 * 安全五问全仓单载体，外加「改坏必红」的埋雷体检。
 *
 * 模板的结构守卫落在这里而不是加载期：手滑改坏 templates.md 时纪律仍照常注入（fail-safe
 * 不静默缺席），本文件显式红、指回改坏的那一处。加载期只剩纪律两条——非空／`{templates}` 恰一次。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	DATA_FILES,
	DispatchDataError,
	TEMPLATES_PLACEHOLDER,
	loadDispatchData,
	resolveDataDir,
} from '../lib/dispatch/data.js'
import { DISPATCH_DATA_DIR, editText, withDataDir } from './helpers.js'

const REPO_ROOT = join(DISPATCH_DATA_DIR, '..', '..', '..')

/**
 * 模板骨架的三份判据（原先住在 data.js 的加载期校验里，断言逻辑与报错文案照搬）。
 * 放在测试里是本批的落点：结构坏了不要挡住纪律注入，改由测试指回改坏处。
 */
const SAFETY_SECTION_MARKER = '## 安全专项五问（单载体：鉴权／越权／输入／上传／PII）'
const SAFETY_ANCHORS = ['鉴权', '越权', '输入', '上传', 'PII']
const TEMPLATE_SECTIONS = [
	'## 方案文档规范',
	'## 方案证伪 brief（施工前，对象＝方案文档）',
	'## 复核形态词表（选形单源：保底每批必派，其余按触发列「改了什么派什么」）',
	'## 施工派单 brief（施工前，对象＝方案文档施工段）',
	'## 证伪门 brief（施工提交后、推送前，对象＝净 diff）',
	'## 横切判据',
	'## 门报行',
	'## 不做清单（形态口径）',
]

/**
 * 计数按整行等值，不是子串：标题被改写成「原文＋后缀」时子串计数仍为 1，漏判恰在那一档
 * （改坏了标题却全绿）；整行等值下同一处改写直接掉到 0。
 */
const countLines = (text, line) => text.split('\n').filter((candidate) => candidate.trim() === line).length

/** 模板骨架断言：节标题按整行等值各恰一次；安全五问整节只一份，五问锚点只落在整节内。 */
function assertTemplateShape(text) {
	for (const section of TEMPLATE_SECTIONS) {
		const count = countLines(text, section)
		assert.equal(count, 1, `templates.md: 节标题「${section}」必须恰好出现一次（实为 ${count} 次）`)
	}
	const markerCount = countLines(text, SAFETY_SECTION_MARKER)
	assert.equal(markerCount, 1, `templates.md: 安全专项整节「${SAFETY_SECTION_MARKER}」必须恰好出现一次（实为 ${markerCount} 次）`)
	const markerAt = text.indexOf(SAFETY_SECTION_MARKER)
	const nextSectionAt = text.indexOf('\n## ', markerAt + 1)
	const safetySection = text.slice(markerAt, nextSectionAt === -1 ? text.length : nextSectionAt)
	for (const anchor of SAFETY_ANCHORS) {
		assert.ok(safetySection.includes(anchor), `templates.md: 安全专项小节缺五问锚点「${anchor}」`)
		const outside = text.slice(0, markerAt) + text.slice(markerAt + safetySection.length)
		assert.ok(!outside.includes(anchor), `templates.md: 五问锚点「${anchor}」在安全专项小节之外也出现了——五问只许一处定义`)
	}
}

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

test('数据面加载全绿：两份现读、零 issue', () => {
	const loaded = loadDispatchData()
	assert.deepEqual(Object.keys(loaded.data).sort(), DATA_FILES.map((entry) => entry.name).sort())
})

test('模板骨架：骨架八节＋安全专项节各恰一次（整行等值）、五问锚点只此一处', () => {
	assertTemplateShape(loadDispatchData().data.templates)
})

test('去渲染占位符语法：模板与纪律正文里不再有〔…〕（模板已变人读文件）', () => {
	const { data } = loadDispatchData()
	assert.ok(!data.templates.includes('〔'), 'templates.md 不该再有渲染占位符')
	assert.ok(!data.discipline.includes('〔'), 'discipline.md 不该再有渲染占位符')
})

test('安全五问单载体：整节标题全仓只有 templates.md 一处', () => {
	const { data } = loadDispatchData()
	const safetyHeading = data.templates.split('\n').find((line) => line.startsWith(SAFETY_SECTION_MARKER))
	assert.ok(safetyHeading, 'templates.md 必须有安全专项整节标题')
	const offenders = collectMarkdown(REPO_ROOT).filter((path) => readFileSync(path, 'utf8').includes(safetyHeading))
	assert.deepEqual(offenders, [join(DISPATCH_DATA_DIR, 'templates.md')], '安全五问整节全仓只许一处定义（README/纪律/别的模板复述即红）')
})

test('纪律文本：占位符恰一处', () => {
	const { data } = loadDispatchData()
	assert.equal(data.discipline.split(TEMPLATES_PLACEHOLDER).length - 1, 1, '模板路径占位必须恰一处')
})

test('埋雷体检：模板骨架改坏——结构断言必红，加载期不拦（纪律照常注入）', (t) => {
	withDataDir(t, (dir) => {
		assert.doesNotThrow(() => assertTemplateShape(loadDispatchData(dir).data.templates), '拷来的真数据先要过结构断言')

		editText(dir, 'templates.md', (text) => text.replace(/^## 横切判据$/m, '## 横向判据'))
		assert.throws(() => assertTemplateShape(loadDispatchData(dir).data.templates), /节标题「## 横切判据」必须恰好出现一次/)
		assert.doesNotThrow(() => loadDispatchData(dir), '模板结构坏了不挡加载——纪律不能因此静默缺席')

		editText(dir, 'templates.md', (text) => text.replace(/^## 横向判据$/m, '## 横切判据'))
		assert.doesNotThrow(() => assertTemplateShape(loadDispatchData(dir).data.templates), '复原后应回绿')

		editText(dir, 'templates.md', (text) => `${text}\n鉴权：横切里顺手提一句五问。\n`)
		assert.throws(() => assertTemplateShape(loadDispatchData(dir).data.templates), /在安全专项小节之外也出现了/)
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

test('埋雷体检：模板节标题重复出现必红', (t) => {
	withDataDir(t, (dir) => {
		editText(dir, 'templates.md', (text) => `${text}\n## 门报行\n\n重复的一节。\n`)
		assert.throws(() => assertTemplateShape(loadDispatchData(dir).data.templates), /节标题「## 门报行」必须恰好出现一次/)
	})
})

test('埋雷体检：安全专项节出现两次必红（单载体是硬约束）', (t) => {
	withDataDir(t, (dir) => {
		editText(dir, 'templates.md', (text) => `${text}\n${SAFETY_SECTION_MARKER}\n\n复述一遍。\n`)
		assert.throws(() => assertTemplateShape(loadDispatchData(dir).data.templates), /安全专项整节「## 安全专项五问（单载体：鉴权／越权／输入／上传／PII）」必须恰好出现一次/)
	})
})

test('埋雷体检：节标题被改写（原文只剩子串）必红——计数是整行等值，不是子串', (t) => {
	withDataDir(t, (dir) => {
		editText(dir, 'templates.md', (text) => text.replace(/^## 门报行$/m, '## 门报行（旧版）'))
		assert.throws(() => assertTemplateShape(loadDispatchData(dir).data.templates), /节标题「## 门报行」必须恰好出现一次（实为 0 次）/)

		editText(dir, 'templates.md', (text) => text.replace(/^## 门报行（旧版）$/m, '## 门报行'))
		editText(dir, 'templates.md', (text) => text.replace(/^## 安全专项五问.*$/m, '## 安全专项五问（旧版）'))
		assert.throws(() => assertTemplateShape(loadDispatchData(dir).data.templates), /安全专项整节/)
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
