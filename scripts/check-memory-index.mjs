#!/usr/bin/env node
/**
 * 记忆注入块离线自检。必须带 <记忆根> <工作区 cwd> 两参：**少给任一参**工作层都落到
 * process.cwd()，算出仓库自己的桶，该层在注入块装配里被省略，整块定档只量到习惯层——空跑。
 * 空跑不再是假绿而是判红：桶不存在且两参没给全时，本命令以 1 退出并说明该带什么。
 *
 * 为什么有它：注入块每轮上下文都要装一份，涨起来是看不见的成本；插件改动又只能在
 * 下次启动后才在运行期观察。本脚本用注入侧同一份判定（core.js 的扫描与预算常量）
 * 把「这块会长成什么样、有没有超预算」变成一条命令的当场结论。
 *
 * 扫全部层而非只扫当前工作区：工作层桶名由 cwd 归一而来，脚本从仓库目录跑时自然
 * 落到一个不存在的桶上，于是只检一层就等于放过了真正在注入的那层。
 *
 * 本文件只是薄壳：采集与检查项在同目录的 checks.mjs（模块），这里负责取参、跑、打印。
 * 拆开是为了让「.mjs 兼模块与运行器」那种形态连带的那道「被直接运行才执行」守卫不必存在——
 * 守卫能把自己关掉（软链调用时不成立，命令就零输出并以 0 退出），而一个「必须绿才算完」
 * 的闸门静默变 no-op 比误报红坏得多。本文件因此没有 import.meta.main / argv[1] 守卫。
 *
 * 用法：node scripts/check-memory-index.mjs [记忆根] [工作区 cwd]
 * 记忆根默认 ~/.dsh/memory，工作区 cwd 默认 process.cwd()。
 * 退出码：0＝CHECKS 全部通过；1＝至少一项判红，逐条列出检查项 id。
 */
import process from 'node:process'
import { collectSite, readOptions, renderReport } from './checks.mjs'

const site = collectSite(readOptions())
const { report, violations } = renderReport(site)
console.log(report)
if (violations.length > 0) process.exitCode = 1