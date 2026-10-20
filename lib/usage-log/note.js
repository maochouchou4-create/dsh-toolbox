/**
 * usage_note 工具（第九件）：结构化字段装不下的隐性坑，事后补记一行到使用日志——复盘 grep
 * 日志时它与调用行同处一条时间线，不必再翻对话考古。
 *
 * 为什么单独一件工具而不是让日志自己猜：调用行只有参数与结果，拿不到「为什么这步不顺利、
 * 试过什么、怎么绕开的」。这类判断只有当时的 Agent 有，故留一个显式的补记口子。
 *
 * 为什么写失败当场抛（与 recorder 的旁路 fail soft 相反）：记手记是调用方的显式请求，失败必须
 * 让它看见——回一句「已记下」而其实没落盘是撒谎；recorder 那条是旁听，丢一行只影响复盘取样。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { objectShape } from '../tool-schema.js'
import { isNonBlankString } from '../value.js'
import { appendUsageLine, usageLogFile, usageLogRoot, usageNoteEvent, usageProfile, NOTE_MAX_CHARS } from './recorder.js'

function makeUsageNoteTool(ctx, { memoryRoot, machine } = {}) {
	return defineTool({
		name: 'usage_note',
		description: '使用日志的手记口子：结构化日志装不下的隐性坑（哪一步不顺利、试过什么、怎么绕开的、产出被弃用的原因），事后补记一行到当日使用日志，复盘时与调用行同一条时间线。只记与本包工具相关的事，不写流水账。',
		parameters: {
			note: { type: 'string', required: true, description: `手记正文：现象＋原因（或试过什么）＋处置，两句因果就够；超 ${NOTE_MAX_CHARS} 字符按通用值级截断只留头部` },
			tool: { type: 'string', description: '关联工具名（缺省＝usage_note，表示这条不针对某一件工具）' },
			ok: { type: 'boolean', description: '关联那次调用是否算不顺利（缺省＝不表态；复盘按 false 找坑，中性手记别传 true）' },
		},
		// 输出 schema 必须在场：宿主对每件工具强制 canonical output（漏声明＝整件工具静默消失，
		// 症状是工具从上下文里整个不见，看不出是 schema 的问题）
		output: {
			schema: objectShape({
				ok: { type: 'boolean', required: true },
				file: { type: 'string', required: true },
			}),
			render: (_args, value) => [{ type: 'text', text: `已记入手记：${value.file}` }],
		},
		// ts 与分片同一个 at：手记行与它落进的文件不会差一天。这里只补「没配」那句手记语境的
		// 文案（与 recorder 的旁路 fail soft 相反，见文件头）；值域（含非法值）由 usageLogFile
		// 单源判，不在这一层另立一条判据——判据抄两遍，值域一改就有一处过期
		execute(args) {
			if (!isNonBlankString(machine)) {
				throw new Error('未配置 machine（记忆根配置的机器名）——手记无法归因到某台机器')
			}
			const at = new Date()
			const file = usageLogFile(usageLogRoot(memoryRoot), at, machine)
			// at 一并交给写入缝：轮转与分片、ts 共用同一个时刻（自取一次 now 会在跨零点按明天判龄）
			appendUsageLine(file, usageNoteEvent(args, at, usageProfile(ctx)), at)
			return { ok: true, file }
		},
	})
}

/**
 * 注册手记工具。日志目录不是可配项（落点由记忆根决定）；machine 与 memory 族同键，值域由
 * memory/core.js 的 MACHINE_ID_RE 单源判定（判在 usageLogFile，这里不抄第二遍）。
 *
 * `= {}` 缺省不能去掉：没传 config 会让注册期就抛，而 apply 里逐工具的 try 会把它吞成
 * 「手记工具静默消失」——比一条带原因的 execute 报错难查得多。于是两种缺席都在 execute 侧
 * 现形：config 整个没传（装配层的编程错误）与 config 在场但 machine 没配（合法状态，README
 * 写明未配置＝共享-only）确实不是一件事，但调用方的补救动作相同（把机器名配好），故不按
 * 来源分叉文案。
 */
export function registerUsageNote(ctx, config) {
	ctx.tools.register(makeUsageNoteTool(ctx, config))
}
