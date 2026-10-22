/**
 * dispatch 参数面（只剩台账一件）：schema 声明是模型选型的唯一依据——它写的取值清单与必填标注会被
 * 原样抄进调用，所以这里钉四件事：键集与执行侧接受的字段逐名一致、错键进不了 schema（未知参数守卫
 * 在 execute 前先拦）、六动作的文案齐全、退役槽位不得回流（两件装配工具连同它们的锚点/拍板卡/裁决
 * 字段一并退役；旧四件的 stage/baseBatchType/rootCause 与档位改制的 tier/triage 同样不许回来）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { batchParameters } from '../lib/dispatch/parameters.js'
import { GATE_NAMES } from '../lib/dispatch/vocab.js'

const batch = batchParameters()
const requiredOf = (parameters) =>
  Object.entries(parameters)
    .filter(([, spec]) => spec.required === true)
    .map(([name]) => name)
    .sort()

test('键集与顺序：六个动作的完整参数面，action 永远第一格（模型先看到动作再看到字段）', () => {
  assert.deepEqual(Object.keys(batch), [
    'action',
    'batch',
    'intent',
    'subject',
    'decisions',
    'gate',
    'segment',
    'forms',
    'recommended',
    'perFormCounts',
    'adopted',
    'rejected',
    'overlap',
    'missed',
    'note',
    'commit',
    'pushed',
    'retro',
    'efficacy',
  ])
})

test('必填只有 action：其余按动作条件必填（在 execute/batch 层报错，不靠 schema 分叉）', () => {
  assert.deepEqual(requiredOf(batch), ['action'])
})

test('动作词表进描述：六个动作全写在 action 说明里且口径为「只落账不判」', () => {
  for (const action of ['start', 'gate', 'commit', 'review', 'status', 'list']) {
    assert.ok(batch.action.description.includes(action), `action 说明缺 ${action}`)
  }
  assert.match(batch.action.description, /只落账不判/)
})

test('门名词表进描述：门报的两道门名都写进 gate 参数说明', () => {
  for (const gate of GATE_NAMES) assert.ok(batch.gate.description.includes(gate))
  assert.match(batch.gate.description, /必填/)
})

test('退役参数不得回流：两件装配工具的参数与旧四件槽位一个都不许有', () => {
  for (const retired of ['anchors', 'forbidden', 'budget', 'acceptance', 'decisionCards', 'adjudicate', 'planSpec']) {
    assert.ok(!(retired in batch), `dispatch_batch 不该再有 ${retired}`)
  }
  for (const name of ['stage', 'advance', 'gateName', 'perForm', 'baseBatchType', 'rootCause', 'tier', 'triage', 'changedFiles', 'diffLines']) {
    assert.ok(!(name in batch), `dispatch_batch 不该再有 ${name}`)
  }
})

test('值类型：裁决数字是 number、清单是 array、提交与复盘是 string', () => {
  for (const field of ['adopted', 'rejected', 'overlap']) assert.equal(batch[field].type, 'number')
  assert.equal(batch.perFormCounts.type, 'array')
  assert.equal(batch.forms.type, 'array')
  assert.equal(batch.recommended.type, 'array')
  assert.equal(batch.decisions.type, 'array')
  for (const field of ['intent', 'subject', 'segment', 'missed', 'note', 'commit', 'pushed', 'retro', 'efficacy']) {
    assert.equal(batch[field].type, 'string')
  }
})

test('台账动作格：commit/review 的必填写法在描述里点明条件', () => {
  assert.match(batch.commit.description, /action=commit 必填/)
  assert.match(batch.pushed.description, /action=commit 必填/)
  assert.match(batch.retro.description, /复盘行（action=review 必填，单行）：本批结论＋下一轮口径/)
  assert.match(batch.efficacy.description, /门效能/)
})
