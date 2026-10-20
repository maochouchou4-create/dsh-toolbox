import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { assembleTask, assembleChallenge } from '../lib/dispatch/core.js'
import { loadDispatchData } from '../lib/dispatch/data.js'
import { runBatchAction, appendStartOnce } from '../lib/dispatch/batch.js'
import { createNodeFsPort } from '../lib/fs-port.js'

/** MCP 出口守卫：宿主对工具返回值做 schema＋无损序列化校验——undefined 值键、非有限数、函数都过不去
 *  （JSON.stringify 静默丢 undefined，node 深比较也把「有 undefined 键」与「无该键」视作相等，故必须显式走键）。
 *  两类真炸（旧批 tier null、diffBudget undefined 键）都从「测试只测内部形状」这道缝漏出去的——
 *  本文件把出口层钉进 npm test：四件工具的代表性返回值（含边角输入）逐一过守卫。 */
export function assertMcpSafe(value, label) {
  const walk = (v, p) => {
    if (v === undefined) throw new Error(`${label}${p} 含 undefined 值键（宿主 lossless 校验必拒）`)
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${label}${p} 非有限数（NaN/Infinity 不可序列化）`)
    if (typeof v === 'function') throw new Error(`${label}${p} 含函数`)
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`))
      else for (const k of Object.keys(v)) walk(v[k], `${p}.${k}`)
    }
  }
  walk(value, '')
}

const data = loadDispatchData().data

test('出口边界：task 三档（免预算/带预算/超阈）返回值 MCP 安全', () => {
  assertMcpSafe(assembleTask(data, { batch: 'b', tier: 'M', triage: 'M｜触公开契约：探针', intent: 'i', anchors: ['a'], decisions: ['d'] }), 'task.M')
  assertMcpSafe(assembleTask(data, { batch: 'b', tier: 'S', triage: 'S｜五行内小修', intent: 'i', anchors: ['a'] }), 'task.S')
  assertMcpSafe(assembleTask(data, { batch: 'b', tier: 'L', triage: 'L｜机制重写', intent: 'i', anchors: ['a'], changedFiles: 5, diffLines: 1200 }), 'task.L.over')
})

test('出口边界：challenge 有回填/裸参数返回值 MCP 安全', () => {
  assertMcpSafe(assembleChallenge(data, { batch: 'b', gate: '证伪门', subject: 'git diff', tier: 'M', intent: 'i', decisions: ['d'] }), 'challenge.full')
  assertMcpSafe(assembleChallenge(data, { batch: 'b', gate: '方案证伪', subject: '方案路径' }), 'challenge.bare')
})

test('出口边界：batch 空台账/旧 start/list 返回值 MCP 安全', async () => {
  const dir = mkdtempSync(join('/tmp', 'boundary-'))
  const path = join(dir, 'ledger.jsonl')
  const port = createNodeFsPort({ root: dir })
  assertMcpSafe(await runBatchAction({ port, path, action: 'status' }), 'batch.empty')
  await appendStartOnce({ port, path, event: { action: 'start', batch: 'old', t: '2026-01-01T00:00:00.000Z' } })
  assertMcpSafe(await runBatchAction({ port, path, action: 'status', params: { batch: 'old' } }), 'batch.legacyStart')
  assertMcpSafe(await runBatchAction({ port, path, action: 'list' }), 'batch.list')
})

test('出口守卫自身判别力：塞 undefined／NaN 必抛，null 不误伤', () => {
  assert.throws(() => assertMcpSafe({ a: 1, b: undefined }, 'x'), /undefined/)
  assert.throws(() => assertMcpSafe({ a: Number.NaN }, 'x'), /非有限数/)
  assert.doesNotThrow(() => assertMcpSafe({ a: null, b: '未登记' }, 'x'), 'null 是合法 JSON 值——占位修在装配层，不在守卫层拒')
})
