/**
 * 纪律注入件（discipline.js）：注册形状与默认数据面。
 *
 * 注入是「不调用也必须在场」的通道，它的失效形态没有报错——会话照常跑，只是流程没人提。
 * 所以这里既钉它真的注册进 systemPrompt.context（不是 tools.register），也钉 text 回调现读
 * 仓内默认数据面：块体就是 discipline.md 原文加模板绝对路径。
 *
 * 数据目录已收口成固定默认目录（配置键随日志/台账退役），注入层没有换目录的入口，故现读、
 * 显式目录、读失败这三条数据面行为直调 loadDispatchData 验（其参数化仅测试用）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { DispatchDataError, loadDispatchData } from '../lib/dispatch/data.js'
import { registerDiscipline } from '../lib/dispatch/discipline.js'
import { DISPATCH_DATA_DIR, copyDataFiles, editText, tempRoot } from './helpers.js'

/** 收下 systemPrompt.context 与 warn 的最小 ctx 替身；tools.register 也在场，用来证明注入件不走工具面。 */
const ctxOf = () => {
	const contexts = []
	const registered = []
	const warnings = []
	return {
		ctx: {
			logger: { warn: (message) => warnings.push(message), error: () => {} },
			systemPrompt: { context: (definition) => contexts.push(definition) },
			tools: { register: (definition) => registered.push(definition) },
		},
		contexts,
		registered,
		warnings,
	}
}

test('注册面：只进 systemPrompt.context 一次、name/order 固定、不进工具注册面', () => {
	const handle = ctxOf()
	registerDiscipline(handle.ctx)
	assert.equal(handle.contexts.length, 1)
	assert.equal(handle.registered.length, 0, '纪律注入没有可调用面，不该注册成工具')
	assert.equal(handle.contexts[0].name, 'dispatch:discipline', '注入块 name 是宿主日志与排障的锚')
	assert.equal(handle.contexts[0].order, 130)
	assert.equal(typeof handle.contexts[0].text, 'function', 'text 必须是回调：每回合现读，改纪律不发版')
})

test('块体＝discipline.md 原文＋模板指针绝对路径（无参注册读默认数据面）', () => {
	const handle = ctxOf()
	registerDiscipline(handle.ctx)
	const text = handle.contexts[0].text()
	assert.deepEqual(handle.warnings, [], '真数据加载不该有 warning')
	const { data } = loadDispatchData()
	assert.equal(text, data.discipline.replaceAll('{templates}', join(DISPATCH_DATA_DIR, 'templates.md')))
	assert.ok(!text.includes('{templates}'), '占位符渲染不掉＝模型看到的是花括号，不是模板位置')
	assert.ok(text.includes(join(DISPATCH_DATA_DIR, 'templates.md')), '模板指针必须是现算的绝对路径（模型按它去读）')
})

test('数据面现读：改目录里的 discipline.md 后下一次加载拿到新文本（无缓存）', (t) => {
	const dir = copyDataFiles(tempRoot(t, 'discipline-live'), ['discipline.md', 'templates.md'])
	const before = loadDispatchData(dir).data.discipline
	editText(dir, 'discipline.md', (text) => `${text}- 新增一行：改纪律只改文件。\n`)
	assert.equal(loadDispatchData(dir).data.discipline, `${before}- 新增一行：改纪律只改文件。\n`, '改数据文件后下一次加载即生效（这正是纪律不装包里的理由）')
})

test('显式目录参数化仅测试用：加载器读给定目录，不读默认目录', (t) => {
	const dir = copyDataFiles(tempRoot(t, 'discipline-dir'), ['discipline.md', 'templates.md'])
	editText(dir, 'discipline.md', (text) => `${text}- 只属于临时目录的一行。\n`)
	assert.ok(loadDispatchData(dir).data.discipline.includes('只属于临时目录的一行'))
	assert.ok(!loadDispatchData().data.discipline.includes('只属于临时目录的一行'), '默认目录的数据面不受临时目录影响')
})

test('数据面读失败：目录读不到即抛 DispatchDataError，不返回半截数据', (t) => {
	const dir = join(tempRoot(t, 'discipline-missing'), 'nope')
	try {
		loadDispatchData(dir)
		assert.fail('应抛 DispatchDataError')
	} catch (error) {
		assert.ok(error instanceof DispatchDataError)
		assert.match(error.message, /读不到数据文件/)
	}
})
