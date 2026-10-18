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
import { appendUsageLine, usageLogFile, usageLogRoot, usageNoteEvent, usageProfile, NOTE_MAX_CHARS } from './recorder.js'

function makeUsageNoteTool(ctx) {
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
		// ts 与分片同一个 at：手记行与它落进的文件不会差一天
		execute(args) {
			const at = new Date()
			const file = usageLogFile(usageLogRoot(ctx), at)
			appendUsageLine(file, usageNoteEvent(args, at, usageProfile(ctx)))
			return { ok: true, file }
		},
	})
}

/** 注册手记工具。无 config 键：日志目录与白名单都不是可配项（目录求根走宿主 profileContext）。 */
export function registerUsageNote(ctx) {
	ctx.tools.register(makeUsageNoteTool(ctx))
}
