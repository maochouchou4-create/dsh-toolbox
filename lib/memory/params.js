/**
 * memory 工具的参数面单源：parameters 表＋退役参数别名表＋入参守卫的预接线。
 *
 * 为什么 parameters 不直接写进 index.js：裸仓解析不了宿主包，而机判判据要对着这份表逐条
 * 点名（未知键/变体/别名三类报错）——表独立成纯模块后契约测试 import 本文件即可，index.js
 * 只引用；parameters 的编译面（宿主 defineTool 吃的形状）仍在 index.js 一处注册。
 *
 * 退役别名表的键按折叠口径匹配（lib/param-guard.js），故每种折叠形只收一个拼写：
 * oldString/old_string 同折为 oldstring，表里收 oldString 一条即可覆盖两者。
 */
import { assertNoUnknownParams } from '../param-guard.js'
import { LAYERS, MEMORY_ACTIONS, PROFILE_LAYER, WORKSPACE_LAYER } from './core.js'

export const MEMORY_PARAMS = {
	action: { type: 'string', required: true, enum: MEMORY_ACTIONS, description: MEMORY_ACTIONS.join(' | ') },
	layer: {
		type: 'string',
		enum: LAYERS,
		description: 'profile=习惯层（跨机同步，目录 ~/.dsh/memory/profile） | workspace=工作层（本工作区·本机专属，目录 ~/.dsh/memory/workspaces/<桶>）。write/edit/delete 必填（运行期点名）',
	},
	file_path: { type: 'string', description: '条目文件名，小写 kebab、.md 结尾（如 tauritavern-toolkit.md）。write/edit/delete 必填（运行期点名）' },
	content: {
		type: 'string',
		description:
			'条目全文（markdown）：首行 --- 起的 frontmatter 恰好两键 title（中文语义名，不必等于文件名）＋ description（单行纯触发器），多出第三键直接抛错；两键的值按字面取、不解析 YAML，引号会原样进索引行，要引号就别加；折行写成多行会被拒。正文至少一个 ## 节（「## 标题」行，条目内按节组织）。其余是正文，销账即删。write 必填',
	},
	heading: { type: 'string', description: '节标题（## 级，条目内唯一）——edit 编辑正文时必填；按节锚定：heading 定位节标题行，不逐字复述正文' },
	body: { type: 'string', description: '该节标题行之下、下一同级标题之前的整段正文（含尾部空行）——edit+heading 必填；空串＝删除该节正文保留标题行' },
	title: { type: 'string', description: '可选，出现即改 frontmatter 的 title（单行，按字面取）；两键可同传；与 heading 并存报错' },
	description: { type: 'string', description: '可选，出现即改 frontmatter 的 description（单行，按字面取）；两键可同传；与 heading 并存报错' },
}

/** 退役参数名→新用法的固定指引（参数描述、enum、报错之外的第二张契约面：教回正道）。 */
export const RETIRED_PARAM_GUIDES = {
	oldString: '按节编辑改用 heading＋body',
	newString: '按节编辑改用 heading＋body',
	replaceAll: '按节编辑改用 heading＋body',
	file: '改用 file_path',
	indexLine: '索引行由插件按 frontmatter 自动生成，不用手写',
}

/** memory 工具的入参守卫：声明名＝MEMORY_PARAMS 的键，别名表见上。execute 一进来先走它。 */
export const guardMemoryParams = (args) =>
	assertNoUnknownParams(args, { declared: Object.keys(MEMORY_PARAMS), aliases: RETIRED_PARAM_GUIDES, action: args?.action })
