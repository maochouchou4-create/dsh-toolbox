/**
 * 记忆根归一：根的默认值、绝对化与 store 落点，外加错误文案归一。
 *
 * 两族共用：memory 族的注入装配与离线自检脚本（`npm run check:memory` 带的那两个参数
 * 就是喂给下面这份归一的），迁移脚本也从这里取根与错误文案。
 *
 * 为什么上移到 lib 根而不是留在 memory/core.js：后两者要的并不是「记忆怎么装配」，只是
 * 「这个根归一成什么样」。指进 memory 目录等于宣称「凡是 memory 的东西我都要」，而 core.js
 * 恰恰是纯函数与 I/O 刻意分开的那条边界——自检脚本与迁移脚本都不走注入装配那条闭包，
 * 不该为了它们把整个 memory 族拖进来。上移之后本模块只承诺三件事：根、store、错误文案，
 * 谁要谁向下指。
 *
 * 零宿主依赖（只用 node:path 与 lib/paths.js、lib/value.js），可独立单测；导入它不会把
 * memory 族的任何 I/O 带进调用方的导入闭包（test/imports.test.js 的闭包断言据此判定）。
 */
import { join, resolve } from 'node:path'
import { expandHome } from './paths.js'
import { isNonBlankString } from './value.js'

/** 记忆根默认值的唯一事实源；生产取默认值的地方只有 resolveRoot 一处经 nonEmptyOrDefault 取值。 */
export const DEFAULT_MEMORY_ROOT = '~/.dsh/memory'

/**
 * 非空白的字符串原样取用，其余（undefined／null／空串／纯空白／非字符串）回落到缺省值。
 * 判据本身问 lib/value.js 那份跨族原语。
 *
 * 记忆侧现在只有 resolveRoot 一处经它取值。还要取默认值的另有两处，口径各归各自入口：
 * 胶水层的 zod `.default()`、离线脚本的 `argv[2] || env || DEFAULT`——它们判的是
 * 「调用方给了什么」，不是「非空则用」。三处必须对同一个空串给同一个答案，否则空串会在
 * 一条路径上被当缺省、在另一条上被当有效值传下去，读写两侧于是算出两个记忆根，
 * 症状要到条目写进了相对路径才发现。
 */
export function nonEmptyOrDefault(value, fallback) {
	return isNonBlankString(value) ? value : fallback
}

/**
 * 记忆根归一成绝对路径（模块私有，唯一出口是 resolveRoot，它自己先做完缺省兜底才调
 * 这里）：相对路径在不同后端会被不同基目录解析——宿主工具走宿主 fs 后端自己的基目录，
 * 读侧走本进程 cwd，两套语义迟早把读写分家。归一后两侧拿到的都是同一个绝对根。
 *
 * 不自己兜缺省是有意的：expandHome 对空串原样透传，而 resolve('') 返回进程 cwd，
 * 谁漏掉兜底直调它，记忆根就静默变成 cwd——正是这段归一要防的那件事。私有化是那道
 * 「不许漏兜底」的实现方式：出口只有一个，出口自带兜底，不靠注释维持。
 *
 * 幂等：对已是绝对路径的入参再解析一次结果不变，所以已经归一过的值再传进来不会二次
 * 变形，下游因此可以无条件地信任这一步。
 */
function absoluteMemoryRoot(memoryRoot) {
	return resolve(expandHome(memoryRoot))
}

/**
 * 记忆根归一后的两个值：根串与单仓目录。缺省兜底与绝对化在这一步一次做完
 * （入参空或纯空白取默认根，其余经 absoluteMemoryRoot 归成绝对路径）。根串一并返回，
 * 是为了需要它的调用方不必绕过这一步去重算：拿 store 的取 store，拿根串的取 root，
 * 两者是同一次归一的产物而不是各算一遍。
 *
 * store＝根下的 memory/：它下面顶层放两机共享条目、`machines/<机器id>/` 放各机私有条目，
 * 全部记忆同在这一处。段名与配置键名同形（memoryRoot → memory/），读代码的人不必再记
 * 「键名与目录名不同」这条隐式约定——名字与所指不符时，人会按名字去写本机条目，落进共享段。
 *
 * 归一是幂等的，所以已经归一过的值传进来结果不变——那是「一次归一」成立的前提，
 * 也是下游可以不再各自拼回退形态的依据。
 */
export function resolveRoot(memoryRoot) {
	const root = absoluteMemoryRoot(nonEmptyOrDefault(memoryRoot, DEFAULT_MEMORY_ROOT))
	return { root, store: join(root, 'memory') }
}

/**
 * 错误文案归一，读侧与写侧共用一份：同一个错误两处各拼一次，拼歪了就是两种口径的
 * 诊断文案，比诊断本身更费解。放在根路由这一层是因为它跨模块——memory 族的装配/体检/删除与
 * 两个离线脚本都要同一份口径。单函数不另立文件：它没有自己的领域知识，只是「各调用方对同一个
 * 错误说同一句话」这一件事的实现。
 */
export const describeError = (error) => (error instanceof Error ? error.message : String(error))
