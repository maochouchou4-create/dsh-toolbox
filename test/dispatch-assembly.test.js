/**
 * 装配层动态冒烟（node:test，零宿主依赖）：直接 import 纪律注入件，真调注入块回调。
 *
 * 钉的是接线单测照不到的缺口：注入件没注册进 systemPrompt.context、块体没现读数据文件——
 * 这些只有真执行一次才现形（历史上装配层整条工具抛 ReferenceError 而全部纯函数用例全绿）。
 * 纪律注入块在这里验「真的注册进了 systemPrompt.context、真的现读默认数据面」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { loadDispatchData } from '../lib/dispatch/data.js'
import { registerDiscipline } from '../lib/dispatch/discipline.js'
import { DISPATCH_DATA_DIR } from './helpers.js'

/** 宿主上下文替身：systemPrompt.context 收下注入件，tools.register 收下工具定义（纪律注入不该用它）。 */
const ctxOf = () => {
	const registered = []
	const contexts = []
	const warnings = []
	return {
		ctx: {
			logger: { warn: (message) => warnings.push(message), error: () => {} },
			systemPrompt: { context: (definition) => contexts.push(definition) },
			tools: { register: (definition) => registered.push(definition) },
		},
		registered,
		contexts,
		warnings,
	}
}

test('纪律注入：注册 name/order 正确，text 现读两文件并渲染模板绝对路径', () => {
	const handle = ctxOf()
	registerDiscipline(handle.ctx)
	assert.equal(handle.registered.length, 0, '纪律注入不是工具，不进 tools.register')
	assert.equal(handle.contexts.length, 1)
	const block = handle.contexts[0]
	assert.equal(block.name, 'dispatch:discipline')
	assert.equal(block.order, 130)
	assert.equal(typeof block.text, 'function', 'text 必须是现读回调（改纪律不必发版重启）')

	const text = block.text()
	assert.deepEqual(handle.warnings, [], '真数据加载不该有 warning')
	assert.ok(text.length > 0, '注入块不能为空（哨兵一：读失败静默缺席是最坏故障）')
	assert.ok(text.includes(join(DISPATCH_DATA_DIR, 'templates.md')), '模板指针必须是现算的绝对路径')
	assert.ok(!text.includes('{templates}'), '占位符必须被渲染掉，模型看不到花括号')

	const { data } = loadDispatchData()
	assert.equal(text, data.discipline.replaceAll('{templates}', join(DISPATCH_DATA_DIR, 'templates.md')), '块体＝discipline.md 现读原文（占位符已渲染）')
	assert.ok(text.includes('方案证伪') && text.includes('证伪门'), '注入块要点名门「方案证伪」「证伪门」')
})
