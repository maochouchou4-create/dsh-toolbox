#!/usr/bin/env node
/**
 * 升版本号。为什么必须有这件事：市场判定「仓库里有没有新东西可装」只读仓库
 * package.json 的 version（dshmarket/lib/updates.js 的 gitVersionUpdate：已装版本 vs
 * raw 上 HEAD 的版本），版本不动就只显示「有新提交（未发版）」，更新按钮永远不出来。
 * 所以版本号不能靠记性——`.githooks/pre-commit` 以 --staged 调本脚本，本次提交动了
 * lib/ 而版本与 HEAD 相同就自动 patch 升一位并进同一次提交。
 *
 * 用法：
 *   node scripts/bump-version.mjs patch|minor|major   手动升一位并 git add
 *   node scripts/bump-version.mjs --staged            pre-commit 钩子入口（条件见上）
 *
 * 判定与纯函数在 scripts/version.mjs（单测 test/bump-version.test.js），本文件只管
 * 取参、读盘、写盘、调 git。不要改用 npm version：它把 tab 缩进压成单行。
 */
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bumpVersion, needsBump, readVersion, replaceVersion } from './version.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(root, 'package.json')
const USAGE = '用法：node scripts/bump-version.mjs [patch|minor|major|--staged]'

function gitOutput(args) {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

/** 暂存区里的路径。用 -z 拿，免去 core.quotepath 的引号与转义。 */
function stagedPaths() {
	return gitOutput(['diff', '--cached', '--name-only', '-z']).split('\0').filter((path) => path !== '')
}

/** HEAD 那份 package.json 的版本；没有 HEAD（首个提交）或读不到就返回 null。 */
function headVersion() {
	try {
		return readVersion(gitOutput(['show', 'HEAD:package.json']))
	} catch {
		return null
	}
}

function writeVersion(version) {
	const text = readFileSync(pkgPath, 'utf8')
	const current = readVersion(text)
	if (current === null) throw new Error('package.json 里读不到三段式 version')
	writeFileSync(pkgPath, replaceVersion(text, version), 'utf8')
	return current
}

function main(argv) {
	const arg = argv[2] ?? 'patch'
	const staged = arg === '--staged'
	if (!staged && !['patch', 'minor', 'major'].includes(arg)) {
		console.error(USAGE)
		process.exitCode = 1
		return
	}
	const current = readVersion(readFileSync(pkgPath, 'utf8'))
	if (current === null) throw new Error('package.json 里读不到三段式 version')

	if (staged) {
		const paths = stagedPaths()
		if (!needsBump({ paths, currentVersion: current, headVersion: headVersion() })) return
		const next = bumpVersion(current, 'patch')
		writeVersion(next)
		gitOutput(['add', '--', 'package.json'])
		// 路径限定提交（git commit <路径>）不吃索引，版本会落盘但不进这次提交——不静默。
		if (!stagedPaths().includes('package.json')) {
			console.error(`[版本] 已升到 ${next}，但这次提交带路径限定，版本号不在里面；git add package.json 后 git commit --amend。`)
			return
		}
		console.log(`[版本] lib/ 有改动、版本未动：${current} → ${next}（已并入本次提交）`)
		console.log('       破坏性改动（工具参数面／注入块结构／frontmatter 契约）应升 minor：先 npm run bump -- minor 再提交，钩子见版本已变就不碰。')
		return
	}

	const previous = writeVersion(bumpVersion(current, arg))
	gitOutput(['add', '--', 'package.json'])
	console.log(`[版本] ${previous} → ${readVersion(readFileSync(pkgPath, 'utf8'))}（已 git add package.json）`)
}

try {
	main(process.argv)
} catch (error) {
	console.error(`[版本] ${error.message}`)
	process.exitCode = 1
}
