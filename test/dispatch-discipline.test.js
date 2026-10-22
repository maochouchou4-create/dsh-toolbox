/**
 * 纪律注入件（discipline.js）：形状与 fail-safe。
 *
 * 注入是「不调用也必须在场」的通道，它的失效形态没有报错——会话照常跑，只是流程没人提。
 * 所以这里既钉它真的注册进 systemPrompt.context（不是 tools.register），也钉 text 回调
 * 「每回合现读」与「读失败吞错留痕」两条边界。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerDiscipline } from '../lib/dispatch/discipline.js'
import { loadDispatchData } from '../lib/dispatch/data.js'
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
	registerDiscipline(handle.ctx, { dispatchDataDir: '' })
	assert.equal(handle.contexts.length, 1)
	assert.equal(handle.registered.length, 0, '纪律注入没有可调用面，不该注册成工具')
	assert.equal(handle.contexts[0].name, 'dispatch:discipline', '注入块 name 是宿主日志与排障的锚')
	assert.equal(handle.contexts[0].order, 130)
	assert.equal(typeof handle.contexts[0].text, 'function', 'text 必须是回调：每回合现读，改纪律不发版')
})

test('块体＝discipline.md 原文＋模板指针绝对路径（占位符一个不留）', () => {
	const handle = ctxOf()
	registerDiscipline(handle.ctx, { dispatchDataDir: '' })
	const text = handle.contexts[0].text()
	const { data } = loadDispatchData()
	assert.equal(text, data.discipline.replaceAll('{templates}', join(DISPATCH_DATA_DIR, 'templates.md')))
	assert.ok(!text.includes('{templates}'), '占位符渲染不掉＝模型看到的是花括号，不是模板位置')
	assert.ok(text.includes(join(DISPATCH_DATA_DIR, 'templates.md')), '模板指针必须是现算的绝对路径（模型按它去读）')
})

test('现读：改数据目录里的 discipline.md 后下一回合拿到新文本（无缓存）', (t) => {
	const dir = copyDataFiles(tempRoot(t, 'discipline-live'), ['lifecycle.json', 'discipline.md', 'templates.md'])
	const handle = ctxOf()
	registerDiscipline(handle.ctx, { dispatchDataDir: dir })
	const before = handle.contexts[0].text()
	editText(dir, 'discipline.md', (text) => `${text}- 新增一行：改纪律只改文件。\n`)
	assert.equal(handle.contexts[0].text(), `${before}- 新增一行：改纪律只改文件。\n`, '改数据文件后下一回合即生效（这正是纪律不装包里的理由）')
	assert.equal(handle.warnings.length, 0)
})

test('模板路径按数据目录现算，不写死仓内默认目录', (t) => {
	const dir = copyDataFiles(tempRoot(t, 'discipline-dir'), ['lifecycle.json', 'discipline.md', 'templates.md'])
	const handle = ctxOf()
	registerDiscipline(handle.ctx, { dispatchDataDir: dir })
	const text = handle.contexts[0].text()
	assert.ok(text.includes(join(dir, 'templates.md')), '自定义数据目录时模板指针跟着走（写死仓内路径会让配置失效而毫无报错）')
	assert.ok(!text.includes(join(DISPATCH_DATA_DIR, 'templates.md')))
})

test('fail-safe：数据目录读不到时 text() 返回空串，不抛（注入是增强不是依赖）', (t) => {
	const dir = join(tempRoot(t, 'discipline-missing'), 'nope')
	const handle = ctxOf()
	assert.doesNotThrow(() => registerDiscipline(handle.ctx, { dispatchDataDir: dir }), '注册期不读盘，读不到也不该在注册时抛')
	assert.equal(handle.contexts[0].text(), '', '读失败返回空串（宿主据此过滤空块），不许把异常冒进请求链')
	assert.equal(handle.warnings.length, 1)
	assert.match(handle.warnings[0], /\[dispatch\]/, 'warn 带模块前缀，便于宿主日志检索')
})

test('warnOnce：连续多回合读失败只 warn 一条（状态不变不刷屏）', (t) => {
	const dir = join(tempRoot(t, 'discipline-warn-once'), 'nope')
	const handle = ctxOf()
	registerDiscipline(handle.ctx, { dispatchDataDir: dir })
	handle.contexts[0].text()
	handle.contexts[0].text()
	handle.contexts[0].text()
	assert.equal(handle.warnings.length, 1, '同一故障连续回合只留一条痕迹')
})

test('缺省数据目录：未配置时读仓内 data/（与 dispatch 台账工具同一份数据面）', () => {
	const handle = ctxOf()
	registerDiscipline(handle.ctx, {})
	const text = handle.contexts[0].text()
	assert.ok(text.length > 0)
	assert.ok(text.includes(join(DISPATCH_DATA_DIR, 'templates.md')))
	assert.equal(text, readFileSync(join(DISPATCH_DATA_DIR, 'discipline.md'), 'utf8').replaceAll('{templates}', join(DISPATCH_DATA_DIR, 'templates.md')))
})
