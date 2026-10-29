/**
 * 版本号的纯函数面：读、递增、只换值不换格式。零副作用、零 I/O，单测直接 import。
 *
 * 为什么单独成文件：薄壳 scripts/bump-version.mjs 要「既能手跑又能被 pre-commit 钩子调」，
 * 逻辑留在它能被测试的地方，壳子只管取参、读盘、写盘、调 git。与同目录
 * checks.mjs + check-memory-index.mjs 的拆分同因（见 check-memory-index.mjs 文件头）。
 */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const LEVELS = new Set(['patch', 'minor', 'major'])
const VERSION_FIELD = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/

/** 从 package.json 文本里读 version；读不到三段式就返回 null，判红交给调用点。 */
export function readVersion(text) {
	const matched = VERSION_FIELD.exec(text)
	return matched === null ? null : matched[2]
}

/**
 * 只替换 version 那个值，缩进、行尾、键顺序原样保留。
 * 不用 npm version：它把 tab 缩进压成单行，整个 package.json 变成一大块 diff。
 */
export function replaceVersion(text, version) {
	if (!SEMVER.test(version)) throw new Error(`不是三段式版本号：${version}`)
	if (!VERSION_FIELD.test(text)) throw new Error('package.json 里找不到可替换的 version 字段')
	return text.replace(VERSION_FIELD, `$1${version}$3`)
}

/** 递增一位：minor / major 进位时低位归零。 */
export function bumpVersion(version, level = 'patch') {
	if (!LEVELS.has(level)) throw new Error(`level 只能是 patch/minor/major，收到：${level}`)
	const matched = SEMVER.exec(version)
	if (matched === null) throw new Error(`不是三段式版本号：${version}`)
	const [major, minor, patch] = matched.slice(1).map(Number)
	if (level === 'major') return `${major + 1}.0.0`
	if (level === 'minor') return `${major}.${minor + 1}.0`
	return `${major}.${minor}.${patch + 1}`
}

/** 提交里是否动了运行时代码（lib/ 下的一切；scripts/ 与文档不算）。 */
export function touchesRuntime(paths) {
	return paths.some((path) => path === 'lib' || path.startsWith('lib/'))
}

/**
 * pre-commit 的判定：这回该不该自动补版本。只在「动了 lib/ 且版本与 HEAD 相同」时为真——
 * 人已经手动升过（含 minor/major 的破坏位）就不碰，首个提交没有基线也不碰。
 */
export function needsBump({ paths, currentVersion, headVersion }) {
	if (currentVersion === null || headVersion === null) return false
	if (currentVersion !== headVersion) return false
	return touchesRuntime(paths)
}
