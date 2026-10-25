#!/usr/bin/env node
/**
 * 记忆注入块离线自检。必须带 <记忆根> <机器id> 两参：**少给机器 id** 注入块就只装共享段，
 * 整块定档量不到本机段——空跑。空跑不再是假绿而是判红：machines/ 下有条目而机器 id 没给时，
 * 本命令以 1 退出并说明该带什么。
 *
 * 为什么有它：注入块每轮上下文都要装一份，涨起来是看不见的成本；插件改动又只能在
 * 下次启动后才在运行期观察。本脚本用注入侧同一份判定（core.js 的扫描与预算常量）
 * 把「这块会长成什么样、有没有超预算」变成一条命令的当场结论。
 *
 * 扫全部段而非只扫共享段：本机段（machines/<机器id>/）只在这一段的条目被算进来时才是
 * 全量，而机器名由各机配置给，脚本从命令行拿。
 *
 * 本文件只是薄壳：采集与检查项在同目录的 checks.mjs（模块），这里负责取参、跑、打印。
 * 拆开是为了让「.mjs 兼模块与运行器」那种形态连带的那道「被直接运行才执行」守卫不必存在——
 * 守卫能把自己关掉（软链调用时不成立，命令就零输出并以 0 退出），而一个「必须绿才算完」
 * 的闸门静默变 no-op 比误报红坏得多。本文件因此没有 import.meta.main / argv[1] 守卫。
 *
 * 用法：node scripts/check-memory-index.mjs [记忆根|记忆目录] [机器id]
 * 记忆根默认 ~/.dsh/memory（store＝<记忆根>/memory），机器 id 默认未给（只检共享段，
 * 并在 machines/ 下有条目时判红）。第一个实参给记忆根或记忆目录本身都收：路径末段是
 * memory 按记忆目录算（root 取其父目录）——注入块头句里的基目录就是记忆目录，照抄也收。
 * 退出码：0＝CHECKS 全部通过；1＝至少一项判红，逐条列出检查项 id。
 */
import process from 'node:process'
import { collectSite, readOptions, renderReport } from './checks.mjs'

const site = collectSite(readOptions())
const { report, violations } = renderReport(site)
console.log(report)
if (violations.length > 0) process.exitCode = 1
