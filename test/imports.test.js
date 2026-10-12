/**
 * 接线单测（静态解析为主）：宿主包（dsh-tools/dsh-llm/schemastery）在裸仓不可
 * import，接线正确性分三层钉——
 * ① 胶水→工具模块：导入名须在目标模块 export 语句里（目标含宿主 import 只能
 *    静态验证；搬家断链的历史实锤见 dsh-memory 0.2 core→write 搬家事故）；
 * ② 工具模块→纯函数文件（memory/core.js、memory/write.js、see-image/vision.js
 *    零宿主依赖）：动态 import 验导出面；
 * ③ inject 声明与模块内 ctx.* 服务消费双向对齐（少声明＝cordis DOA，多声明＝
 *    噪音），以及工具参数面→写侧函数签名一致性。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')
const loadModule = (file) => import(pathToFileURL(join(libDir, file)).href)
const readLib = (file) => readFileSync(join(libDir, file), 'utf8')

/** 命中 import { a, b as c } from './x.js' 的多行形态；宿主包导入不在核对范围。
 * 别名只影响本地名，核对的是源名（目标导出面里的是源名）。 */
function parseLocalImports(source) {
	const imports = new Map()
	for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.\/[^']+)'/g)) {
		const names = match[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter((s) => s.length > 0)
		imports.set(match[2], names)
	}
	return imports
}

/** 静态收集 export 声明的名字（目标模块含宿主 import，不可动态加载）。 */
function parseExportNames(source) {
	const names = new Set()
	for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/g)) names.add(match[1])
	return names
}

/** 去注释后扫 ctx.<service> 消费（注释里的提及不算数）。 */
const SERVICES = ['systemPrompt', 'tools', 'llm', 'attachments', 'workingDirectory', 'fs']
function consumedServices(source) {
	const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
	const used = new Set()
	for (const service of SERVICES) {
		if (new RegExp(`ctx\\.${service}\\b`).test(code)) used.add(service)
	}
	return used
}

test('胶水→工具模块的导入名在目标 export 语句内（防搬家断链）', () => {
	const glue = readLib('index.js')
	const imports = parseLocalImports(glue)
	assert.ok(imports.has('./memory/index.js') && imports.has('./see-image/index.js'), '胶水须装配 memory 与 see_image 两模块')
	for (const [specifier, names] of imports) {
		const exported = parseExportNames(readLib(specifier.replace('./', '')))
		for (const name of names) {
			assert.ok(exported.has(name), `胶水从 ${specifier} 导入的 "${name}" 不在目标 export 面——搬家断链`)
		}
	}
})

test('工具模块→纯函数文件的导入名在目标导出面内（动态加载验证）', async () => {
	const cases = [
		['memory/index.js', ['registerMemory', 'configShape']],
		['see-image/index.js', ['registerSeeImage', 'configShape']],
	]
	for (const [file, expected] of cases) {
		const imports = parseLocalImports(readLib(file))
		for (const [specifier, names] of imports) {
			const mod = await loadModule(join(dirname(file), specifier))
			for (const name of names) {
				assert.ok(name in mod, `${file} 从 ${specifier} 导入的 "${name}" 不在导出面`)
			}
		}
		assert.ok(expected.every((name) => parseExportNames(readLib(file)).has(name)), `${file} 缺模块接口 ${expected.join('/')}`)
	}
})

test('memory 工具参数面与写侧函数签名一致（action→入参字段逐一对齐）', async () => {
	const source = readLib('memory/index.js')
	const parameters = [...source.matchAll(/^\s{3}(\w+):\s*\{\s*type:/gm)].map((m) => m[1])
	for (const expected of ['action', 'layer', 'file', 'content', 'oldString', 'newString', 'replaceAll', 'indexLine']) {
		assert.ok(parameters.includes(expected), `工具 parameters 缺 "${expected}"`)
	}
	const executeBody = source.slice(source.indexOf('async execute'), source.indexOf('function renderToolResult'))
	const write = await loadModule('memory/write.js')
	for (const fn of ['upsertEntry', 'editEntry', 'deleteEntry', 'lintMemory']) {
		assert.ok(typeof write[fn] === 'function', `execute 分派的 "${fn}" 不是 write.js 导出函数`)
		assert.ok(executeBody.includes(fn), `execute 未分派 "${fn}"`)
	}
	assert.ok(executeBody.includes('未知 action'), '未知 action 须显式 throw（不得静默成功）')
})

test('inject 声明与 ctx.* 消费双向对齐（少＝DOA，多＝噪音）', async () => {
	const glue = readLib('index.js')
	const match = /export const inject = \[([^\]]*)\]/.exec(glue)
	assert.ok(match, 'index.js 须导出 inject 数组')
	const declared = new Set(SERVICES.filter((service) => match[1].includes(`'${service}'`)))

	const used = new Set([...consumedServices(glue), ...consumedServices(readLib('memory/index.js')), ...consumedServices(readLib('see-image/index.js'))])
	for (const service of used) {
		assert.ok(declared.has(service), `模块消费了 ctx.${service} 但 inject 未声明——cordis 抛 cannot get property 而插件 DOA`)
	}
	for (const service of declared) {
		assert.ok(used.has(service), `inject 声明了 '${service}' 但无模块消费——多余的 DOA 风险/约束噪音`)
	}

	for (const file of ['memory/index.js', 'see-image/index.js']) {
		assert.ok(readLib(file).includes('ctx.tools.register'), `${file} 须注册自身工具`)
	}
})
