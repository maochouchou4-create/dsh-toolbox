/**
 * 版本号机械递增的单测。测的是 scripts/version.mjs 的纯函数面——外壳（写盘、调 git）
 * 由 pre-commit 钩子实际跑，这里钉住的就是「该不该升、升哪一位、格式有没有被动过」。
 * 为什么要测：钩子静默 no-op 与钩子真的生效，在提交历史里长得一模一样，只能在这里分辨。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bumpVersion, needsBump, readVersion, replaceVersion, touchesRuntime } from '../scripts/version.mjs'

const TABBED = `{
\t"name": "probe",
\t"version": "2.0.0",
\t"scripts": {
\t\t"test": "node --test"
\t}
}
`

test('bumpVersion：patch／minor／major 各升一位，进位时低位归零', () => {
	assert.equal(bumpVersion('2.0.0'), '2.0.1')
	assert.equal(bumpVersion('2.0.0', 'patch'), '2.0.1')
	assert.equal(bumpVersion('1.9.9', 'patch'), '1.9.10')
	assert.equal(bumpVersion('1.8.0', 'minor'), '1.9.0')
	assert.equal(bumpVersion('1.9.9', 'minor'), '1.10.0')
	assert.equal(bumpVersion('1.9.9', 'major'), '2.0.0')
})

test('bumpVersion：非三段式与未知 level 一律判错，不静默兜底', () => {
	assert.throws(() => bumpVersion('2.0'), /三段式/)
	assert.throws(() => bumpVersion('v2.0.0'), /三段式/)
	assert.throws(() => bumpVersion('2.0.0', 'big'), /level/)
})

test('replaceVersion：只换 version 的值，tab 缩进与行尾原样', () => {
	const next = replaceVersion(TABBED, '2.0.1')
	assert.equal(next, TABBED.replace('"2.0.0"', '"2.0.1"'))
	assert.equal(next.split('\n').length, TABBED.split('\n').length)
	assert.ok(next.includes('\t"version": "2.0.1",'))
	assert.ok(!next.includes('"2.0.0"'))
})

test('replaceVersion：CRLF 文本不被改写行尾', () => {
	const crlf = TABBED.replace(/\n/g, '\r\n')
	const next = replaceVersion(crlf, '3.0.0')
	assert.equal(next.split('\r\n').length, crlf.split('\r\n').length)
	assert.ok(!/[^\r]\n/.test(next), '不得出现裸 LF')
})

test('replaceVersion：找不到 version 字段就判错，不写半个文件', () => {
	assert.throws(() => replaceVersion('{ "name": "probe" }', '2.0.1'), /version 字段/)
})

test('readVersion：读得到三段式，读不到返回 null', () => {
	assert.equal(readVersion(TABBED), '2.0.0')
	assert.equal(readVersion('{ "name": "probe" }'), null)
	assert.equal(readVersion('{ "version": "2.0" }'), null)
})

test('touchesRuntime：lib/ 下的一切算运行时，scripts/ 与文档不算', () => {
	assert.equal(touchesRuntime(['lib/memory/index.js']), true)
	assert.equal(touchesRuntime(['scripts/version.mjs', 'AGENTS.md', 'lib/x.js']), true)
	assert.equal(touchesRuntime(['scripts/version.mjs', 'README.md']), false)
	assert.equal(touchesRuntime(['libx/a.js']), false)
})

test('needsBump：动了 lib/ 且版本与 HEAD 相同才升', () => {
	const bumped = { paths: ['lib/x.js'], currentVersion: '2.0.0', headVersion: '2.0.0' }
	assert.equal(needsBump(bumped), true)
	assert.equal(needsBump({ ...bumped, currentVersion: '2.1.0' }), false)
	assert.equal(needsBump({ ...bumped, paths: ['AGENTS.md', 'package.json'] }), false)
	assert.equal(needsBump({ ...bumped, headVersion: null }), false)
	assert.equal(needsBump({ ...bumped, currentVersion: null }), false)
})
