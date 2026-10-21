/**
 * 入参守卫的契约测试：lib/param-guard.js 的机械（折叠归一/未知键点名/非对象拦截）。
 * 机械属所有工具（现消费方＝dispatch 两族），折叠归一用 dispatch 自己的参数键做例——
 * 「归一命中必须是声明名」在这组键上最容易读出差别。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LIB_DIR } from './helpers.js'

const loadModule = (file) => import(pathToFileURL(join(LIB_DIR, file)).href)

test('折叠归一的机械面：归一命中声明名即给变体写法指路（落空才轮到兜底句）', async () => {
	const { foldParamName, assertNoUnknownParams } = await loadModule('param-guard.js')
	// 折叠口径本身：小写＋去分隔符，两侧同折叠后精确比对
	assert.equal(foldParamName('File-Path'), 'filepath')
	assert.equal(foldParamName('_old_STRING_'), 'oldstring')
	const declared = ['action', 'file_path']
	// File_Path 折叠命中声明名 file_path → 变体句
	assert.throws(
		() => assertNoUnknownParams({ action: 'edit', File_Path: 'x' }, { declared, action: 'edit' }),
		(error) => {
			assert.match(error.message, /「File_Path」是「file_path」的变体写法——直接改用「file_path」重发。/)
			return true
		},
	)
	// 归一不中 → 兜底句指回工具描述（钉反向：不同词不得误中变体句）
	assert.throws(
		() => assertNoUnknownParams({ action: 'delete', fileName: 'a.md' }, { declared, action: 'delete' }),
		(error) => {
			assert.match(error.message, /未知参数「fileName」/)
			assert.match(error.message, /delete 的参数见工具描述/)
			assert.doesNotMatch(error.message, /变体写法/)
			return true
		},
	)
})

test('多未知键一次点名齐全，报错头带完整收到清单；全声明在案时原样放行', async () => {
	const { assertNoUnknownParams } = await loadModule('param-guard.js')
	const declared = ['action', 'file_path']
	assert.throws(
		() => assertNoUnknownParams({ action: 'edit', file_path: 'x.md', oldString: 'a', replaceAll: true }, { declared, action: 'edit' }),
		(error) => {
			assert.match(error.message, /未知参数「oldString、replaceAll」/)
			assert.match(error.message, /本次收到：action、file_path、oldString、replaceAll。/)
			return true
		},
		'多键未知要一次点名齐全，逐键各给指路行',
	)
	const args = { action: 'edit' }
	assert.equal(assertNoUnknownParams(args, { declared, action: 'edit' }), args, '全部键声明在案时原样返回入参（不洗不裁）')
})

test('非对象 params 是接线错误：TypeError（数组与 null 同拦），不是调用方的用法错误', async () => {
	const { assertNoUnknownParams } = await loadModule('param-guard.js')
	const opts = { declared: ['action'], action: 'write' }
	for (const bad of [null, undefined, 42, 'write', ['action'], true]) {
		assert.throws(
			() => assertNoUnknownParams(bad, opts),
			(error) => {
				assert.ok(error instanceof TypeError)
				assert.match(error.message, /入参守卫收到非对象 params（/)
				return true
			},
			`params=${String(bad)} 应以 TypeError 拦下`,
		)
	}
})
