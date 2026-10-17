/**
 * 入参守卫的契约测试：lib/param-guard.js 的机械（折叠归一/优先级规则/别名表/缺必填点名）
 * ＋memory 工具接线后的三类报错（机判判据①②③）。execute 首行调用 guardMemoryParams 的
 * 接线由 imports.test 静态钉住；裸仓解析不了宿主包，这里以「守卫收同一 payload」的形态
 * 断言报错文案——文案由 params.js 单源装配，与真实 execute 抛出的串同源。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LIB_DIR } from './helpers.js'

const loadModule = (file) => import(pathToFileURL(join(LIB_DIR, file)).href)

test('折叠归一：变体写法点名到正名（filePath／file-path → file_path），不同词不误中', async () => {
	const { guardMemoryParams } = await loadModule('memory/params.js')
	// 机判②：filePath 去分隔符＋小写后与 file_path 同形 → 变体句指回正名
	assert.throws(
		() => guardMemoryParams({ action: 'write', filePath: 'a.md', content: 'x' }),
		(error) => {
			assert.match(error.message, /未知参数「filePath」/)
			assert.match(error.message, /「filePath」是「file_path」的变体写法——直接改用「file_path」重发。/)
			return true
		},
		'filePath 须按折叠归一命中 file_path 的变体句',
	)
	// file-path 同折为 filepath，同一条变体路
	assert.throws(
		() => guardMemoryParams({ action: 'delete', 'file-path': 'a.md' }),
		/「file-path」是「file_path」的变体写法/,
	)
	// fileName 与 file_path 是不同的词：归一不中、别名表也没有 → 兜底句。钉的是反向
	// （不同词不得误中变体句），归一若退化成子串包含就会在这里红
	assert.throws(
		() => guardMemoryParams({ action: 'delete', fileName: 'a.md' }),
		(error) => {
			assert.match(error.message, /未知参数「fileName」/)
			assert.match(error.message, /delete 的参数见工具描述/)
			assert.doesNotMatch(error.message, /变体写法/)
			return true
		},
	)
})

test('退役别名表：old_string／OldString 走别名指引（heading＋body），不得教回退役名', async () => {
	const { guardMemoryParams } = await loadModule('memory/params.js')
	// 机判①：edit 撞 old_string → 未知参数点名＋别名文案（含 heading 指引）。优先级规则：
	// old_string 折叠后落向的是退役名 oldString 而非任何声明名——必须走别名表教
	// heading＋body，而不是「改用 oldString」把调用方教回退役名
	assert.throws(
		() => guardMemoryParams({ action: 'edit', file_path: 'x.md', old_string: '…' }),
		(error) => {
			assert.match(error.message, /未知参数「old_string」/)
			assert.match(error.message, /「old_string」已退役——按节编辑改用 heading＋body。/)
			assert.doesNotMatch(error.message, /改用「oldString」/)
			return true
		},
		'old_string 须走别名表文案且不得教回退役名',
	)
	// 机判③：别名表键也按折叠口径匹配——OldString 能中表键 oldString
	assert.throws(
		() => guardMemoryParams({ action: 'edit', file_path: 'x.md', OldString: '…' }),
		/「OldString」已退役——按节编辑改用 heading＋body。/,
	)
	// 其余退役键各有各的指引
	assert.throws(
		() => guardMemoryParams({ action: 'write', file: 'a.md', content: 'x' }),
		/「file」已退役——改用 file_path。/,
	)
	assert.throws(
		() => guardMemoryParams({ action: 'write', file_path: 'a.md', content: 'x', indexLine: '- [t](f) — d' }),
		/「indexLine」已退役——索引行由插件按 frontmatter 自动生成，不用手写。/,
	)
	// 层值退役后的指路：layer 不得只落在兜底句上（照旧值传参的人要能一次改对）
	assert.throws(
		() => guardMemoryParams({ action: 'write', layer: 'home', file_path: 'a.md', content: 'x' }),
		/「layer」已退役——改用 scope（/,
	)
})

test('多未知键一次点名齐全，报错头带完整收到清单；全声明在案时原样放行', async () => {
	const { guardMemoryParams } = await loadModule('memory/params.js')
	assert.throws(
		() => guardMemoryParams({ action: 'edit', file_path: 'x.md', oldString: 'a', replaceAll: true }),
		(error) => {
			assert.match(error.message, /未知参数「oldString、replaceAll」/)
			assert.match(error.message, /本次收到：action、file_path、oldString、replaceAll。/)
			return true
		},
		'多键未知要一次点名齐全，逐键各给指路行',
	)
	const args = { action: 'lint' }
	assert.equal(guardMemoryParams(args), args, '全部键声明在案时原样返回入参（不洗不裁）')
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
