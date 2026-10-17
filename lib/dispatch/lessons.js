/**
 * 复盘辅助（dispatch_lessons）的逻辑面：读台账全量事件 → 以最后一条复盘事件为全仓销账点切出
 * 增量批 → 对增量批统计 → 判复盘点位 → 出配对规则修订建议草稿。销账点切的是统计窗口：销掉的是
 * 「裁决待办」，零 findings 的降级证据不随销账消失、仍跨全量累积（见 collectStats 的 allForms）。
 * 工具装配在 ./index.js——本文件连 defineTool 都不 import，因此能被 node:test
 * 直接加载，接线单测动态 import 它时也不会撞宿主包。
 *
 * 只读不写是结构性的，不是纪律：装配层传进来的端口只挑了读方法（fs-port 的 createReadOnlyPort），
 * 写方法在那个对象上不存在——想自动改配对表先得在本文件里新增一次写入，而那正是要停下来问
 * 主会话的动作（判断永远留主会话）。复盘自动改规则＝绕过裁决，那类事不该靠「记得别写」维持。
 *
 * 读法与时间序复用 batch.js：台账是审计面，坏行 fail fast、文件缺失可判（undefined 而不是空数组）
 * 都是契约，两处各解析一次就会有一处开始静默跳过；时间序与 findings 求和同理，两份实现迟早在
 * 某次改坏值策略时各走各的，而「findings 上报 N」是批次视图与复盘共用的那个数。
 *
 * 点位判据不进代码：单源是 lifecycle 复盘行的 point 字段（见 pointOf），代码里不留第二份常量。
 *
 * 统计按事件自带的 rules 版本分组，不跨版本平均：配对表演进之后历史事件的口径已经变了，把它们
 * 揉成一个数等于报一个谁都没跑过的世界（形态被删掉的那些批与形态刚加上的那些批混在一起求和，
 * 分母是两套规则的并集）。各组各报各的，跨版本只能比形状不能比数值——这也是 rules 字段存在的
 * 唯一理由，它不在事件里就分不了组。
 */
import { isNonBlankString } from '../value.js'
import { byTime, countOf, normalizeFormCounts, readLedgerEvents, sortedByTime, sumFoundOf } from './batch.js'
import { GATE_LABELS, RETROSPECTIVE_STAGE } from './core.js'

/**
 * 文本定序按码位比，不用 localeCompare：两台机器的 ICU 版本可能不同，同一份台账要出同一份稿，
 * 而 locale 的排序结果随 ICU 变。形态 id 与批型名的排序在这份稿里只是让行序稳定，不承担语义。
 */
const byText = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

/**
 * 「派过 ≥2 次才算长期」的门槛（初始标定）：只出现过一次的形态没被找到，可能是形态不对口，
 * 也可能只是这一批没派足——一次样本说「降级」会把配对表改坏。两次以上仍零 findings 才是信号。
 */
const ZERO_FORM_TIMES = 2

/**
 * 采纳率的信号线（初始标定，复盘按台账调）：低于它才说明配对表的组合宽度偏宽。它写死不进数据面，
 * 因为它是判读口径不是门槛——门槛（「该不该现在复盘」）单源在 lifecycle 的 point 字段。标定值
 * 就摆在这里是为了让人能改它，而不是让它藏在某个百分比计算里。
 */
const SIGNAL_RATE = 80

/**
 * 漏网与重叠两条建议的聚合上限：描述承诺的是「趋势」，逐事件流水在几百批的台账上会写进上下文
 * 几万字符。按批型聚合计数、批型取前几条、每批型给少量样本，其余报「还有 M 条」——明细本来就在
 * 台账里，逐条抄一遍只是把同一份数据换个格式塞进上下文。
 */
const TOP_TYPES = 3
const SAMPLES_PER_TYPE = 2
const SAMPLE_TEXT_CAP = 60

/** 批型没记的那批归这个桶：不归零桶（会被当成一类批型把点位抬高），也不吞掉。 */
const UNKNOWN_TYPE = '（批型未记）'

/**
 * 点位判据的单源：lifecycle 里那行 uses 声明了 dispatch_lessons 的阶段行，它带的 point 字段就是
 * 「攒几批、覆盖几类批型、提示上限几批」。按 uses 找而不按行名找：行名是给人看的，uses 是这份
 * 数据与本工具之间已有的绑定。找不到或那行没有 point 就显式报错——静默回落一份默认值，等于让
 * 「该不该复盘」取决于代码里一个没人会看的常量。
 */
export function pointOf(lifecycle) {
	const rows = (lifecycle?.stages ?? []).filter((stage) => stage.uses.includes('dispatch_lessons'))
	const row = rows.find((entry) => entry.point !== undefined)
	if (row === undefined) {
		throw new Error(`复盘辅助：lifecycle.json 里没有带 point 字段的复盘阶段行（按 uses 含 dispatch_lessons 找，共 ${rows.length} 行命中、其中 0 行带 point）——点位判据单源在那行，缺它就没有「该不该复盘」的判据`)
	}
	return row.point
}

/** 百分比：分母为 0 时返回 null 而不是 0%——「一条推荐都没记」与「一条都没派」是两个数。 */
const rate = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null)

const percentText = (part, whole) => {
	const value = rate(part, whole)
	return value === null ? '不可算（分母为 0）' : `${value}%`
}

/** 形态 id 清单带次数：按次数降序再按 id 定序，让同一份台账每次出稿的行序一样。 */
function formCountsText(counts) {
	return [...counts.entries()]
		.sort((left, right) => right[1] - left[1] || byText(left[0], right[0]))
		.map(([form, times]) => `${form} ${times} 次`)
		.join('、')
}

const bump = (map, key, times = 1) => map.set(key, (map.get(key) ?? 0) + times)

/** 跨组合并计数时按次数求和：只并键会把同一形态在三组里各裁一次报成一次，合并就丢了份数。 */
const mergeCounts = (target, source) => {
	for (const [key, times] of source) bump(target, key, times)
	return target
}

/** 文本截断到上限字符——样本行的长度不该由某条事件的自由文本决定。 */
const clipped = (text) => (text.length > SAMPLE_TEXT_CAP ? `${text.slice(0, SAMPLE_TEXT_CAP)}…` : text)

/** 报出被聚合吃掉的那部分条数：不给这个数，读者会以为那就是全部。 */
const hiddenText = (hidden) => (hidden > 0 ? `；另有 ${hidden} 条未列` : '')

/**
 * 事件按 rules 版本分组（缺 rules 的归到空键，照样成组——丢事件比混版本更糟）。
 * 入参须已按时间序（collectStats 只排一次）：组内的时间序才是「趋势」读法的前提，而两处各排一次
 * 会有一处先改成别的排序还不知道。
 */
function groupByRules(rows) {
	const groups = new Map()
	for (const row of rows) {
		const key = isNonBlankString(row.rules) ? row.rules : ''
		if (!groups.has(key)) groups.set(key, [])
		groups.get(key).push(row)
	}
	return groups
}

/**
 * 一组（同一规则版本）内的统计。采纳率的分子取「实派 ∩ 推荐」：推荐之外加派的形态是主会话
 * 加的路，不算「采纳了推荐」，把它算进分子会把加派读成采纳。两个串都按**集合**算——同一个 id
 * 在串里重复两遍（手写台账时很常见）不该让它既进分母两次又让采纳率算出 100% 以上。
 */
function statsOfGroup(rows) {
	const forms = new Map()
	const trimmed = new Map()
	const added = new Map()
	const batches = new Set()
	let events = 0
	let adopted = 0
	let recommended = 0
	let dispatched = 0
	for (const row of rows) {
		events += 1
		batches.add(row.batch)
		adopted += countOf(row.adopted)
		const recommendedHere = new Set(row.recommendedForms)
		const dispatchedHere = new Set(row.comboForms)
		recommended += recommendedHere.size
		for (const form of recommendedHere) {
			if (!dispatchedHere.has(form)) bump(trimmed, form)
		}
		for (const form of dispatchedHere) {
			if (!recommendedHere.has(form)) bump(added, form)
		}
		dispatched += [...dispatchedHere].filter((form) => recommendedHere.has(form)).length
	}
	accumulateForms(forms, rows)
	return { batches: batches.size, events, found: sumFoundOf(rows), adopted, recommended, dispatched, forms, trimmed, added }
}

/**
 * 归一出的形态计数累进一张 map：found 按份数求和、times 记「被记过几趟」。旧对象与新数组两种
 * 事件形状在 normalizeFormCounts 那一处合流，各形状自己再数一遍就会有一处先漏改，症状是零
 * findings 的形态静默不出降级建议。增量分组与全量证据面（allForms）共用这一份累进逻辑。
 */
function accumulateForms(forms, rows) {
	for (const row of rows) {
		for (const [form, count] of normalizeFormCounts(row.perFormCounts)) {
			const entry = forms.get(form) ?? { found: 0, times: 0 }
			entry.found += count
			entry.times += 1
			forms.set(form, entry)
		}
	}
	return forms
}

/**
 * 一批的门二轮数：修复轮数＝门二 advance 事件数−1（第一轮不算修复），一轮都没有的批是 0 而
 * 不是 −1——免门二批型的门二列是 null，那不叫「修了一轮」。batch.js 的 stageState 报的是同一个
 * 数的「跑了几趟」口径，两者差这一位是两种问法。
 */
function fixRoundsOf(rows, gate2) {
	return Math.max(0, rows.filter((event) => event.action === 'advance' && event.stage === gate2).length - 1)
}

/**
 * 双报重叠的捕获-再捕获估算：两路各自找到 a、b 条，重叠 k 条，则总体规模 ≈ a×b÷k。
 * 只取该事件里 findings 最大的两路（复核组合常多于两路，逐对相乘会重复计同一份语料），
 * 且只数 findings 大于零的路——一条什么都没找到的路没有捕获样本，把它算进乘积只会把
 * 估算压低。少于两路、或 overlap 为 0 时估算不成立。
 *
 * overlap 大于次大那路时也算不成立：两路的交集比其中任何一路都大，写侧不校验交集、这种行只能
 * 是手写坏了，而那个式子会算出一条比任一路的命中还小的「全量规模」——报出来比不报更像结论。
 */
function overlapRowOf(event) {
	const found = [...normalizeFormCounts(event.perFormCounts).values()]
		.filter((count) => count > 0)
		.sort((left, right) => right - left)
	const [high = 0, second = 0] = found
	const overlap = countOf(event.overlap)
	const inconsistent = overlap > second
	const estimable = found.length >= 2 && overlap > 0 && !inconsistent
	return {
		batch: event.batch,
		stage: event.stage ?? '',
		t: event.t,
		routes: found.length,
		high,
		second,
		overlap,
		inconsistent,
		estimate: estimable ? Math.round((high * second) / overlap) : null,
	}
}

/**
 * 批与批型。同名批的多个 start 是跨机并发登记的正常吸收态（batch.js 的 foldBatch 对它出告警而
 * 不当事故），所以批型按**并集**取而不是「取第一条」——两台机器各自登记的批型若不同，取第一条
 * 等于把另一台的覆盖面连同它那条批型一起丢掉，而批型数正是点位门槛的一边。
 *
 * 行序按批名定序而不是按事件先后：输出是事件集合的函数，t 只到秒、union 合并又让行序与时间序
 * 无关，按先后排会让同一份台账两次读出两份不同的稿。
 */
function batchRowsOf(rows) {
	const byBatch = new Map()
	for (const row of rows) {
		if (row.action !== 'start') continue
		const entry = byBatch.get(row.batch) ?? { batch: row.batch, batchTypes: new Set(), baseBatchTypes: new Set(), t: row.t }
		if (isNonBlankString(row.batchType)) entry.batchTypes.add(row.batchType)
		if (isNonBlankString(row.baseBatchType)) entry.baseBatchTypes.add(row.baseBatchType)
		// t 取最早一条，只作显示与定序，不参与任何判据
		if (byTime({ t: row.t }, { t: entry.t }) < 0) entry.t = row.t
		byBatch.set(row.batch, entry)
	}
	return [...byBatch.values()]
		.map((entry) => ({
			batch: entry.batch,
			batchTypes: [...entry.batchTypes].sort(byText),
			baseBatchTypes: [...entry.baseBatchTypes].sort(byText),
			t: entry.t,
		}))
		.sort((left, right) => byText(left.batch, right.batch))
}

/**
 * 全仓销账点＝台账里最后一条复盘事件的时间（按 byTime 取最大；无复盘事件返回 null——首次复盘
 * 前工具必须可用，初始态是全量而不是错误）。判据只认 action/stage、不设时刻守卫：复盘事件自己
 * 就是销账点的 max，数学上不存在 t 晚于销账点的复盘事件，多写一道守卫是把同一件事判两次。
 */
function lastRetrospectiveOf(rows) {
	let latest = null
	for (const row of rows) {
		if (row.action !== 'advance' || row.stage !== RETROSPECTIVE_STAGE) continue
		// 同刻并列按 t 串字典序取大：同一时刻的两种时区偏移拼写（'+00:00' 与 '+08:00'，Date.parse
		// 相等）是跨机台账 union 的常态，不定向的话谁大就看输入行序，输出不再是事件集合的函数。
		const cmp = latest === null ? 1 : byTime(row, { t: latest })
		if (cmp > 0 || (cmp === 0 && row.t > latest)) latest = row.t
	}
	return latest
}

/**
 * 统计切分：销账点（最后一条复盘事件）管窗口——统计吃增量批（存在晚于销账点事件的批，批粒度：
 * 跨点活跃批整批重看），零 findings 的降级证据面（allForms）跨全量。一个对象读完台账就算完，
 * 没有缓存也没有第二份落盘——复盘是读侧的一次性聚合，存下来就多一份能与台账分家的数（台账还在
 * 追加，存的统计第二天就是旧的）。
 */
export function collectStats(events, { point, gate2 = GATE_LABELS.gate2, vocabulary = new Set() } = {}) {
	for (const key of ['minBatches', 'minBatchTypes', 'upperBatches']) {
		if (!Number.isFinite(point?.[key])) {
			throw new Error(`复盘辅助：点位判据 point.${key} 缺或不是数字（实得 ${JSON.stringify(point?.[key])}）——单源是 lifecycle 复盘行的 point 字段，纯函数调用方也得把它显式传进来`)
		}
	}
	// combo/recommended 每个事件只归一一次：它们同时喂采纳率、裁剪与加派、记账缺格三处，两处各
	// 归一一次就会有一处先改口径而另一处没跟上。归一出的键挂在此行的副本上，不回写事件对象
	// （那会被复用成别的读法）；旧事件的串形状与新事件的数组形状在同一处合流。
	const rows = sortedByTime(events).map((event) => ({
		...event,
		comboForms: [...normalizeFormCounts(event.combo, vocabulary).keys()],
		recommendedForms: [...normalizeFormCounts(event.recommended, vocabulary).keys()],
	}))
	// 「批→事件」分组只做一次：增量集判定与修复轮数查的是同一份分组，另建第二份迟早有一处先改口径。
	const byBatch = new Map()
	for (const row of rows) {
		if (!byBatch.has(row.batch)) byBatch.set(row.batch, [])
		byBatch.get(row.batch).push(row)
	}
	const cutoff = lastRetrospectiveOf(rows)
	// 批进增量的判据＝该批存在任一事件严格晚于销账点：不是「start 在后」，跨着销账点活跃的在途
	// 批同样进。判据只看事件时刻、不看 action/stage（理由见 lastRetrospectiveOf）；被销的批整批
	// 出窗，跨点活跃批则整批留下——销账点前的旧事件也进统计（修复轮数/采纳率以批为天然单元，切
	// 事件会造出半批统计），跨点批带回的已裁决旧事件由复盘 SOP 对照裁决日志去重，不在这里猜。
	// 活跃批名先一轮算出再按名过滤：逐行现查批内事件是 O(Σe²)，大批台账上会把一趟复盘拖成秒级；
	// 两步与一步判据同字（任一事件严格晚于销账点），只省重复扫描。
	const activeNames = cutoff === null
		? null
		: new Set([...byBatch]
			.filter(([, batchRows]) => batchRows.some((event) => byTime(event, { t: cutoff }) > 0))
			.map(([batch]) => batch))
	const activeRows = cutoff === null ? rows : rows.filter((row) => activeNames.has(row.batch))
	// 全量证据面（跨销账点累积）：长期零 findings 的判据语义是「长期」，增量窗口切分证据会让真实
	// 疲软形态在窗口内凑不齐样本，降级信号被制度性吞掉——销账点销裁决待办，不销证据。
	const allForms = accumulateForms(new Map(), rows)
	const versions = [...groupByRules(activeRows).entries()]
		.map(([rules, groupRows]) => ({ rules, ...statsOfGroup(groupRows) }))
		.sort((left, right) => byText(left.rules, right.rules))
	const totals = versions.reduce(
		(total, group) => ({
			found: total.found + group.found,
			adopted: total.adopted + group.adopted,
			recommended: total.recommended + group.recommended,
			dispatched: total.dispatched + group.dispatched,
		}),
		{ found: 0, adopted: 0, recommended: 0, dispatched: 0 },
	)
	const trimmed = new Map()
	const added = new Map()
	for (const group of versions) {
		mergeCounts(trimmed, group.trimmed)
		mergeCounts(added, group.added)
	}
	const batches = batchRowsOf(activeRows)
	// 批型取增量批登记的批型并集；批型空串不贡献（拿空串凑出「第三种批型」会让点位提前到点）。
	const batchTypes = [...new Set(batches.flatMap((row) => row.batchTypes))].sort(byText)
	const typesOfBatch = new Map(batches.map((row) => [row.batch, row.batchTypes]))
	// 修复轮数查的是全量分组：增量批按批粒度整批重看，该批销账点前的门二事件也属于「这批修了几轮」。
	const fixRounds = batches.map((row) => ({ ...row, rounds: fixRoundsOf(byBatch.get(row.batch) ?? [], gate2) }))
	// 「带形态计数的 advance」＝归一后非空（旧对象与新数组两种形状在这里合流——按形状各判一次，
	// 改形状时必有一处漏改，漏的那处把复核事件静默排除在漏记/重叠两项统计之外）
	const reviewEvents = activeRows.filter((row) => row.action === 'advance' && normalizeFormCounts(row.perFormCounts).size > 0)
	const missed = activeRows
		.filter((row) => isNonBlankString(row.missed))
		.map((row) => ({ batch: row.batch, stage: row.stage ?? '', text: row.missed }))
		.sort((left, right) => byText(left.batch, right.batch) || byText(left.stage, right.stage) || byText(left.text, right.text))
	// 实派了但计数里没有的形态：记账漏了整格，不是「零 findings」（后者会写 0）。它们不能进零
	// findings 候选——分不清是形态没派还是派了没记，按记漏报。
	const unrecorded = new Map()
	for (const row of reviewEvents) {
		// 逐行归一一次再查键：对原始值做形状特判（旧代码 Object.hasOwn 对数组恒 false）会把新形状
		// 的每一行都判成「整格漏记」，漏记建议虚高到没眼看——漏记的判定必须吃归一后的键域
		const counted = normalizeFormCounts(row.perFormCounts)
		for (const form of row.comboForms) {
			if (!counted.has(form)) bump(unrecorded, form)
		}
	}
	const overlap = reviewEvents
		.map(overlapRowOf)
		.filter((row) => row.routes > 1)
		.sort((left, right) => byText(left.batch, right.batch) || byText(left.stage, right.stage) || left.overlap - right.overlap || left.high - right.high)
	// 口径注记：某项统计在这份台账上算不出来时点名原因（文本进点位统计，动作进建议草稿），
	// 而不是让它以 0% 或「没问题」的样子混进去——读的人看不出那是缺数据还是真为零。
	const notes = []
	if (totals.recommended === 0) {
		notes.push({
			text: '采纳率分母＝0：现有事件一条 recommended 都没自存（那是分母的唯一来源），补记前采纳率不可算',
			action: '组合采纳率不可算：全部事件的 recommended 为空——该字段是采纳率的唯一分母，后续 advance 逐趟填 recommended（当趟推荐组合 id 数组，如 [\'锚点核对\',\'砍刀\']）后此项自动可算',
		})
	}
	const inconsistent = overlap.filter((row) => row.inconsistent)
	if (inconsistent.length > 0) {
		notes.push({
			text: `重叠数大于次大路的捕获数 ${inconsistent.length} 趟：两路交集不该比其中任何一路的命中还大，该字段是手写坏的`,
			action: `重叠数与捕获数自相矛盾 ${inconsistent.length} 趟（${inconsistent.map((row) => `${row.batch}·${row.stage}`).join('、')}）：overlap 大于次大路的 findings——请裁决该按哪一路的记录改，或补记正确交集后此项自动可算`,
		})
	}
	return {
		point,
		cutoff,
		ledgerBatchCount: byBatch.size,
		batches,
		batchCount: batches.length,
		batchTypes,
		batchTypeCount: batchTypes.length,
		typesOfBatch,
		versions,
		totals,
		allForms,
		trimmed,
		added,
		unrecorded,
		fixRounds,
		missed,
		overlap,
		reviewEventCount: reviewEvents.length,
		notes,
		gate2,
	}
}

/**
 * 点位判定：批数与批型数双门槛（配对表只在多种批型上被验证过，同批型的五个批次统计出来的
 * 规则修订没有代表性）。阈值来自 lifecycle 的 point 字段（单源，见 pointOf）。force 只跳判定，
 * 不改统计——跳的是「该不该现在复」，不是「复什么」。
 */
export function judgePoint(stats, { force = false } = {}) {
	const reached = stats.batchCount >= stats.point.minBatches && stats.batchTypeCount >= stats.point.minBatchTypes
	return {
		force: force === true,
		batchCount: stats.batchCount,
		batchTypeCount: stats.batchTypeCount,
		reached,
		due: force === true || reached,
		overUpper: stats.batchCount > stats.point.upperBatches,
	}
}

/** 按批型归堆：一个批次登记了多个批型时它进每个桶（批型数本身就是并集口径）。 */
function groupByBatchType(rows, typesOfBatch) {
	const groups = new Map()
	for (const row of rows) {
		const types = typesOfBatch.get(row.batch) ?? []
		for (const type of types.length > 0 ? types : ['']) {
			const key = type === '' ? UNKNOWN_TYPE : type
			if (!groups.has(key)) groups.set(key, [])
			groups.get(key).push(row)
		}
	}
	return groups
}

/** 条数最多的前几个批型；同条数按名定序，两台机器选的是同一批批型。 */
function topTypes(groups, cap) {
	return [...groups.entries()]
		.sort((left, right) => right[1].length - left[1].length || byText(left[0], right[0]))
		.slice(0, cap)
}

function missedSuggestion(missed, typesOfBatch) {
	if (missed.length === 0) return null
	const parts = []
	let listed = 0
	for (const [type, entries] of topTypes(groupByBatchType(missed, typesOfBatch), TOP_TYPES)) {
		const samples = entries.slice(0, SAMPLES_PER_TYPE)
		listed += samples.length
		const text = samples.map((row) => `${row.batch}·${row.stage}：${clipped(row.text)}`).join('、')
		parts.push(`${type} ${entries.length} 条（${text}${entries.length > samples.length ? '、…' : ''}）`)
	}
	return `漏网标记（按批型聚合，明细见台账）：${parts.join('；')}${hiddenText(missed.length - listed)}——用户事后实测暴露的问题，请裁决该批型是否加派本可抓到的形态`
}

/** 估算区间：单个值就报那个值，多个报最小–最大，一个都不可算时说清为什么。 */
function rangeText(values) {
	if (values.length === 0) return '不可算（两路无交集，或重叠数与捕获数自相矛盾，见口径注记）'
	return values.length === 1 ? `${values[0]} 条` : `${Math.min(...values)}–${Math.max(...values)} 条`
}

function overlapSuggestion(overlap, typesOfBatch) {
	if (overlap.length === 0) return null
	const parts = []
	let listed = 0
	for (const [type, entries] of topTypes(groupByBatchType(overlap, typesOfBatch), TOP_TYPES)) {
		listed += entries.length
		const estimates = entries.map((row) => row.estimate).filter((value) => value !== null)
		const disjoint = entries.filter((row) => row.overlap === 0).length
		parts.push(`${type} 复核 ${entries.length} 趟、重叠 0 的 ${disjoint} 趟、捕获-再捕获估算 ${rangeText(estimates)}`)
	}
	return `双报重叠（按批型聚合）：${parts.join('；')}${hiddenText(overlap.length - listed)}——重叠那部分说明组合里两路有冗余；重叠 0 的那部分有两种读法（两路互补、覆盖面够，或检出面仍有缺口），台账本身判不出是哪一种，请主会话裁决`
}

/**
 * 修订建议草稿。每条自带数字证据与动作，主会话拿到的是可直接裁决的材料而不是结论——
 * 「降级某形态」是判断，判断权在主会话，这里只负责把够格进裁决队列的形态点名。
 */
function draftSuggestions(stats, verdict) {
	const out = []
	if (verdict.overUpper) {
		out.push(`已攒 ${stats.batchCount} 批，超过提示上限 ${stats.point.upperBatches} 批——点位看的是覆盖面够不够（批型 ${verdict.batchTypeCount} 种），不是攒够月数；请裁决是否立刻复盘`)
	}
	if (stats.totals.recommended > 0) {
		out.push(`组合采纳率 ${percentText(stats.totals.dispatched, stats.totals.recommended)}（推荐 ${stats.totals.recommended} 路／采纳 ${stats.totals.dispatched} 路）：低于 ${SIGNAL_RATE}% 才是信号（初始标定，复盘按台账调），达标则配对表的组合宽度是合用的`)
	}
	// 裁剪/加派是「推荐与实派的差」，而推荐的基线为 0 时那个差等于整份实派清单——那不是加派，
	// 是「没有基线可比」。分母为 0 的那一趟只报不可算（见 notes），不拿它冒充加派记录。
	if (stats.totals.recommended > 0) {
		if (stats.trimmed.size > 0) {
			out.push(`裁剪记录（推荐了没派）：${formCountsText(stats.trimmed)}——主会话在削减推荐组合，请核这几路是否该留在配对表里`)
		}
		if (stats.added.size > 0) {
			out.push(`加派记录（推荐之外派的）：${formCountsText(stats.added)}——最大化口径下主会话手动加的路，请核是否该进配对表`)
		}
	}
	// 零 findings 的降级证据跨全量台账累积（销账点销裁决待办不销证据，理由见 collectStats 的
	// allForms）；合一条、不按规则版本分组——增量 versions 组容不下纯旧批的形态，版本考古归复盘
	// 裁决日志。后缀点明口径，读者不至于把这条读成增量面。
	const zeroForms = [...stats.allForms.entries()]
		.filter(([, entry]) => entry.found === 0 && entry.times >= ZERO_FORM_TIMES)
		.map(([form]) => form)
		.sort(byText)
	if (zeroForms.length > 0) {
		out.push(`长期零 findings 形态：${zeroForms.join('、')}——派过 ≥${ZERO_FORM_TIMES} 次仍零 findings，请裁决降级（配对表改派）或转手动指派（跨全量台账累积，含已复盘批）`)
	}
	for (const row of stats.fixRounds.filter((entry) => entry.rounds > 0)) {
		const kind = row.baseBatchTypes.length > 0 ? `（依赖原批型 ${row.baseBatchTypes.join('、')}）` : ''
		out.push(`修复轮数：批次 ${row.batch}${kind}：${stats.gate2} 记了 ${row.rounds + 1} 轮（修复轮数 ${row.rounds}）——多轮才收敛，请复核这批的修法是否停在症状上`)
	}
	const missed = missedSuggestion(stats.missed, stats.typesOfBatch)
	if (missed !== null) out.push(missed)
	const overlap = overlapSuggestion(stats.overlap, stats.typesOfBatch)
	if (overlap !== null) out.push(overlap)
	if (stats.unrecorded.size > 0) {
		out.push(`实派了却没记 findings 数的形态：${formCountsText(stats.unrecorded)}——记账缺格（不是零 findings），请裁决补记口径`)
	}
	for (const note of stats.notes) out.push(note.action)
	return out
}

/**
 * 点位统计文本（逐字档里它是输出 schema 的一个字段）。首行是点位摘要——有销账点时首行自带增量
 * 口径（增量 N 批／台账全量 M 批），无销账点（首次复盘前）保持全量文本；其后按规则版本分组列
 * 形态计数与口径注记——分组的意义是让每组数字各自成立，跨版本只比形状。
 */
function statsText(stats, verdict) {
	const multiRounds = stats.fixRounds.filter((row) => row.rounds > 0)
	// 未到点时首行不写点位结论：渲染那层的固定框「未到复盘点（…）」已经说了同一句，两处各写
	// 一次就是叠词；stats 单读时首行不带结论也读得懂（全量路以「N 批」起，增量路以「上次复盘」起）。
	const where = verdict.force ? '点位判断已跳过（force）' : (verdict.reached ? '已到复盘点位' : '')
	// 批型数与清单不可丢：点位是批数∧批型数双门槛，增量口径下首行仍要报得出增量批型的清单。
	const typeSummary = `${stats.batchTypes.length} 种：${stats.batchTypes.join('、') || '—'}`
	const head = (stats.cutoff === null
		? `${stats.batchCount} 批（批型 ${typeSummary}）`
		: `上次复盘〔${stats.cutoff}〕后增量 ${stats.batchCount} 批／台账全量 ${stats.ledgerBatchCount} 批（增量批型 ${typeSummary}）`)
		+ `｜${stats.gate2} 修复轮数合计 ${multiRounds.reduce((total, row) => total + row.rounds, 0)}（多轮批 ${multiRounds.length}）`
		+ `｜组合采纳率 ${percentText(stats.totals.dispatched, stats.totals.recommended)}（推荐 ${stats.totals.recommended} 路／采纳 ${stats.totals.dispatched} 路／裁剪 ${stats.totals.recommended - stats.totals.dispatched}）`
		+ `｜findings 上报 ${stats.totals.found}、采纳 ${stats.totals.adopted}｜规则版本 ${stats.versions.length} 组｜复核事件 ${stats.reviewEventCount} 趟｜漏网 ${stats.missed.length} 条`
	const lines = [where === '' ? head : `${where}：${head}`]
	for (const group of stats.versions) {
		lines.push(`规则版本 ${group.rules || '（事件未记版本）'}：${group.batches} 批／${group.events} 事件｜组合采纳率 ${percentText(group.dispatched, group.recommended)}（推荐 ${group.recommended}／采纳 ${group.dispatched}）｜findings 上报 ${group.found}、采纳 ${group.adopted}`)
		const forms = [...group.forms.entries()]
			.sort((left, right) => right[1].found - left[1].found || byText(left[0], right[0]))
			.map(([form, entry]) => `${form} ${entry.found}`)
		lines.push(`  表单 findings：${forms.length > 0 ? forms.join('、') : '（无复核事件）'}`)
	}
	for (const note of stats.notes) lines.push(`  口径注记：${note.text}`)
	return lines.join('\n')
}

/**
 * 复盘这一趟的全部动作（工具 execute 直接调它）。结构化值就是 stats 与 suggestions 本身：
 * 宿主对返回值做深拷贝冻结后才交给 render，所以渲染输入必须在值自己身上——render 里现读台账
 * 做不到（同步纯投影），而这份值里已经带着渲染要的全部文本。
 *
 * 形态词表与阶段表逐趟现读（loadTables 与台账工具同一份注入，交回 { tables, bytes }，这里只
 * 取 tables 那一半——这趟不记规则指纹，指纹是台账 advance 的事）：词表是 combo/recommended
 * 那两个串的词法，阶段表里那行 point 是点位判据——而「现读」那条纪律（改 JSON 下次调用即
 * 生效）在这两处正是要害：数据变了，解析与判据跟着变，不必等重启。台账缺文件时报错而不是出
 * 一份空复盘：空复盘读起来像「没有异常项」。
 */
export async function runLessons({ port, path, loadTables, force = false, signal }) {
	const events = await readLedgerEvents({ port, path, signal })
	if (events === undefined) {
		throw new Error(`复盘辅助：批次台账不存在：${path}——台账里还没有任何批次事件可统计（先 dispatch_batch start 登记批次）`)
	}
	const { tables: { forms, lifecycle } } = loadTables({ names: ['forms', 'lifecycle'] })
	const stats = collectStats(events, {
		point: pointOf(lifecycle),
		vocabulary: new Set(forms.forms.map((form) => form.id)),
	})
	const verdict = judgePoint(stats, { force })
	return { due: verdict.due, stats: statsText(stats, verdict), suggestions: draftSuggestions(stats, verdict) }
}

/**
 * 展示文本：到点＝三段（点位统计／建议草稿／裁决归属），未到点＝一句带点位摘要。
 * 纯投影——只读 value 上的两个文本字段，不碰 I/O、不看对象身份。
 */
export function renderLessonsResult(value) {
	if (value.due !== true) return `未到复盘点（${value.stats}）`
	const out = ['【点位统计】', value.stats, '', '【修订建议草稿】']
	for (const suggestion of value.suggestions) out.push(`· ${suggestion}`)
	out.push('', '建议给主会话裁决，不自动改配对表——本工具只读台账、不落盘。')
	return out.join('\n')
}
