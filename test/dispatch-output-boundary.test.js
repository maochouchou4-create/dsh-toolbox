import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { appendStartOnce, runBatchAction } from '../lib/dispatch/batch.js'
import { createNodeFsPort } from '../lib/fs-port.js'

/** MCP 出口守卫：宿主对工具返回值做 schema＋无损序列化校验——undefined 值键、非有限数、函数都过不去
 *  （JSON.stringify 静默丢 undefined，node 深比较也把「有 undefined 键」与「无该键」视作相等，故必须显式走键）。
 *  旧批 next null、可选字段 undefined 键这类真炸都从「测试只测内部形状」这道缝漏出去过——
 *  本文件把出口层钉进 npm test：台账六动作的代表性返回值（含边角输入）逐一过守卫。 */
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

test('出口边界：batch 空台账 status/list 返回值 MCP 安全', async () => {
  const dir = mkdtempSync(join('/tmp', 'boundary-'))
  const path = join(dir, 'ledger.jsonl')
  const port = createNodeFsPort()
  assertMcpSafe(await runBatchAction({ port, path, action: 'status' }), 'batch.emptyStatus')
  assertMcpSafe(await runBatchAction({ port, path, action: 'list' }), 'batch.emptyList')
})

test('出口边界：start 全字段/裸字段与重复登记返回值 MCP 安全', async () => {
  const dir = mkdtempSync(join('/tmp', 'boundary-'))
  const path = join(dir, 'ledger.jsonl')
  const port = createNodeFsPort()
  await appendStartOnce({ port, path, event: { action: 'start', batch: 'old', t: '2026-01-01T00:00:00.000Z' } })
  assertMcpSafe(await runBatchAction({ port, path, action: 'status', params: { batch: 'old' } }), 'batch.legacyStart')
  assertMcpSafe(
    await runBatchAction({ port, path, action: 'start', params: { batch: 'b1', intent: 'i', decisions: ['d'], subject: '/x/方案.md 的「批1」节' } }),
    'batch.startFull',
  )
  assertMcpSafe(await runBatchAction({ port, path, action: 'start', params: { batch: 'b2', intent: 'i' } }), 'batch.startBare')
  assertMcpSafe(await runBatchAction({ port, path, action: 'start', params: { batch: 'b1', intent: 'i' } }), 'batch.startDup')
})

test('出口边界：gate 全字段/裸字段、commit、review、list 返回值 MCP 安全', async () => {
  const dir = mkdtempSync(join('/tmp', 'boundary-'))
  const path = join(dir, 'ledger.jsonl')
  const port = createNodeFsPort()
  await runBatchAction({ port, path, action: 'start', params: { batch: 'b', intent: 'i', decisions: ['d'] } })
  assertMcpSafe(
    await runBatchAction({
      port,
      path,
      action: 'gate',
      params: {
        batch: 'b',
        gate: '证伪门',
        segment: '净 diff',
        forms: ['证伪复核'],
        recommended: ['证伪复核'],
        perFormCounts: [{ form: '证伪复核', count: 2 }],
        adopted: 1,
        rejected: 1,
        overlap: 0,
        missed: '',
        note: '一轮为限',
      },
    }),
    'batch.gateFull',
  )
  assertMcpSafe(await runBatchAction({ port, path, action: 'gate', params: { batch: 'b', gate: '方案证伪' } }), 'batch.gateBare')
  assertMcpSafe(await runBatchAction({ port, path, action: 'commit', params: { batch: 'b', commit: 'abc1234', pushed: 'ok' } }), 'batch.commit')
  assertMcpSafe(await runBatchAction({ port, path, action: 'review', params: { batch: 'b', retro: 'r', efficacy: 'e' } }), 'batch.review')
  assertMcpSafe(await runBatchAction({ port, path, action: 'list' }), 'batch.list')
})

test('出口守卫自身判别力：塞 undefined／NaN 必抛，null 不误伤', () => {
  assert.throws(() => assertMcpSafe({ a: 1, b: undefined }, 'x'), /undefined/)
  assert.throws(() => assertMcpSafe({ a: Number.NaN }, 'x'), /非有限数/)
  assert.doesNotThrow(() => assertMcpSafe({ a: null, b: '未登记' }, 'x'), 'null 是合法 JSON 值——占位修在装配层，不在守卫层拒')
})
