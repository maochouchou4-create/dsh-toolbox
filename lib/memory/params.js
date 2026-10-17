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
import { MEMORY_ACTIONS } from './core.js'

export const MEMORY_PARAMS = {
	action: { type: 'string', required: true, enum: MEMORY_ACTIONS, description: MEMORY_ACTIONS.join(' | ') },
	// scope 的 schema 只有 type：宿主的参数 DSL 白名单是 type/oneOf/properties/required/
	// additionalProperties/items/enum/const，没有 pattern 键——写了它这个工具会在注册期整件
	// 消失（schema 编译不过）。值域校验因此落 core.js 的 MACHINE_ID_RE 单源，报错也由它给
	scope: {
		type: 'string',
		description: '可选，缺省＝本机机器 id（未配置 machine 时缺省 shared）。值＝shared（仓顶层，跨机注入）或机器 id（machines/<id>/，写该机私有条目——含帮对机写）。仅 write 消费；edit/delete 不收（裸名自动在共享＋本机范围解析，跨机改用 file_path 全形式 machines/<id>/<文件名>）',
	},
	file_path: { type: 'string', description: '条目文件名，小写 kebab、.md 结尾（如 tauritavern-toolkit.md）；跨机帮写或本机同名消歧用全形式 machines/<机器id>/<文件名>。write/edit/delete 必填（运行期点名）' },
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
	layer: '改用 scope（可选，缺省＝本机机器 id；跨机写用 file_path 全形式 machines/<机器id>/<文件名>）',
	indexLine: '索引行由插件按 frontmatter 自动生成，不用手写',
}

/** memory 工具的入参守卫：声明名＝MEMORY_PARAMS 的键，别名表见上。execute 一进来先走它。 */
export const guardMemoryParams = (args) =>
	assertNoUnknownParams(args, { declared: Object.keys(MEMORY_PARAMS), aliases: RETIRED_PARAM_GUIDES, action: args?.action })
