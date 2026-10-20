/**
 * 入参守卫的契约测试：lib/param-guard.js 的机械（折叠归一/优先级规则/别名表/缺必填点名）。
 * 机械属所有工具（现消费方＝dispatch 两族），别名表用 memory 退役期留下那组键做例——
 * 「归一命中必须是声明名、退役名一律走别名表」这条优先级在那组键上最容易读出差别。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LIB_DIR } from './helpers.js'

const loadModule = (file) => import(pathToFileURL(join(LIB_DIR, file)).href)

test('优先级规则的机械面：归一先查声明名、落空才查别名表（两条路不得互换）', async () => {
	const { foldParamName, assertNoUnknownParams } = await loadModule('param-guard.js')
	// 折叠口径本身：小写＋去分隔符，两侧同折叠后精确比对
	assert.equal(foldParamName('File-Path'), 'filepath')
	assert.equal(foldParamName('_old_STRING_'), 'oldstring')
	const declared = ['action', 'file_path']
	const aliases = { oldString: '按节编辑改用 heading＋body' }
	// File_Path 折叠命中**声明名** file_path → 变体句（不得因别名表里也有相近键而改道）
	assert.throws(
		() => assertNoUnknownParams({ action: 'edit', File_Path: 'x' }, { declared, aliases, action: 'edit' }),
		(error) => {
			assert.match(error.message, /「File_Path」是「file_path」的变体写法——直接改用「file_path」重发。/)
			assert.doesNotMatch(error.message, /已退役/)
			return true
		},
	)
	// old_string 折叠落向**退役名** → 归一对声明名落空、别名表接住（不得给变体句）
	assert.throws(
		() => assertNoUnknownParams({ action: 'edit', old_string: 'x' }, { declared, aliases, action: 'edit' }),
		(error) => {
			assert.match(error.message, /「old_string」已退役——按节编辑改用 heading＋body。/)
			assert.doesNotMatch(error.message, /变体写法/)
			return true
		},
	)
	// 别名表键也按折叠口径匹配：OldString 能中表键 oldString
	assert.throws(
		() => assertNoUnknownParams({ action: 'edit', OldString: 'x' }, { declared, aliases, action: 'edit' }),
		/「OldString」已退役——按节编辑改用 heading＋body。/,
	)
})

test('多未知键一次点名齐全，报错头带完整收到清单；全声明在案时原样放行', async () => {
	const { assertNoUnknownParams } = await loadModule('param-guard.js')
	const declared = ['action', 'file_path']
	assert.throws(
		() => assertNoUnknownParams({ action: 'edit', file_path: 'x.md', oldString: 'a', replaceAll: true }, { declared, aliases: {}, action: 'edit' }),
		(error) => {
			assert.match(error.message, /未知参数「oldString、replaceAll」/)
			assert.match(error.message, /本次收到：action、file_path、oldString、replaceAll。/)
			return true
		},
		'多键未知要一次点名齐全，逐键各给指路行',
	)
	// 归一与别名表都不中 → 兜底句指回工具描述（钉反向：不同词不得误中变体句）
	assert.throws(
		() => assertNoUnknownParams({ action: 'delete', fileName: 'a.md' }, { declared, aliases: {}, action: 'delete' }),
		(error) => {
			assert.match(error.message, /未知参数「fileName」/)
			assert.match(error.message, /delete 的参数见工具描述/)
			assert.doesNotMatch(error.message, /变体写法/)
			return true
		},
	)
	const args = { action: 'edit' }
	assert.equal(assertNoUnknownParams(args, { declared, aliases: {}, action: 'edit' }), args, '全部键声明在案时原样返回入参（不洗不裁）')
})

test('缺必填点名：缺哪个报哪个＋收到键清单（「别猜，看描述」）', async () => {
	const { assertRequiredParams } = await loadModule('param-guard.js')
	assert.throws(
		() => assertRequiredParams({ action: 'delete' }, ['file_path'], { action: 'delete' }),
		(error) => {
			assert.match(error.message, /缺必填「file_path」（delete）/)
			assert.match(error.message, /本次收到的键：action——缺的就在没收的那几个里，别猜，看描述。/)
			return true
		},
	)
	assert.doesNotThrow(
		() => assertRequiredParams({ file_path: 'a.md' }, ['file_path'], { action: 'edit' }),
		'必填全在时不抛',
	)
})

test('非对象 params 是接线错误：TypeError（数组与 null 同拦），不是调用方的用法错误', async () => {
	const { assertNoUnknownParams } = await loadModule('param-guard.js')
	const opts = { declared: ['action'], aliases: {}, action: 'write' }
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
