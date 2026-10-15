/**
 * dispatch 的工具参数面（宿主 defineTool 吃的那张 parameters 表）：字段名与形状在这一处，
 * 字段的必填性由 core.validateParams 按数据判定并点名缺哪几个——schema 里再抄一遍必填矩阵
 * 就是两份真相源，改一处就有一处对不上。必填的只有所有阶段都要的那三个（stage/subject/
 * intent）；batchType 尤其不能标必填：方案阶段不判批型，在那一趟标成必填等于逼模型为了过
 * schema 编一个批型，把「出方案前没有批型可判」从契约降级成参数噪声。
 *
 * 描述里凡出现「哪几个阶段／哪几个批型要填它」，一律现读数据拼，不手抄：那些名单是模型唯一
 * 的选型依据，手抄一份等于配对表或 lifecycle 改名、加行后描述还停在旧名单，模型照旧名单
 * 传值就撞「未知批型／未知 stage」。手抄的只有两类——固定两态的对象语义（方案路径 vs 净 diff
 * 命令）与规则本身的写法，那些不是清单而是语义。
 */
import { dispatchStages, stagesConsuming } from './core.js'

/** 加挂行名与主行名在描述里分开列：addon 行不作 batchType，混列等于把一条走不通的路给出去。 */
const names = (rows) => rows.map((row) => row.batchType).join('、')

/** 「哪几个阶段要填它」现读：core 的槽位消费集（模板占位＋必填矩阵＋组合那一路）。 */
const stages = (data, field) => stagesConsuming(data, field).join('/')

/** rootCause 的消费面由批型行上的 needsRootCause 决定（施工模板按批型追加那三行），故查配对行。 */
const rootCauseRows = (data) => data.pairing.rows.filter((row) => row.needsRootCause === true)

/**
 * 组装参数面。三个槽位的描述带现读清单，其余是固定语义：batchType（判批型阶段与主行名单）、
 * subject（两态语义）、anchors/forbidden/verifyCmd（消费它的那几个阶段）、rootCause（带
 * needsRootCause 的批型在施工要它）。
 */
export function dispatchParameters(data) {
	const rows = data.pairing.rows
	const main = rows.filter((row) => row.kind !== 'addon')
	const needsBase = main.filter((row) => row.needsBase === true)
	const plainSpecial = main.filter((row) => row.kind === 'special' && row.needsBase !== true)
	const addon = rows.filter((row) => row.kind === 'addon')
	const rootCause = rootCauseRows(data)
	return {
		stage: { type: 'string', required: true, description: dispatchStages(data).join(' | ') },
		batchType: {
			type: 'string',
			description: [
				`批型（${stages(data, 'batchType')}阶段必填，方案阶段不判批型；配对表主行行名：${names(main)}`,
				needsBase.length > 0 ? `需 baseBatchType 的特殊行：${names(needsBase)}` : null,
				plainSpecial.length > 0 ? `不带 baseBatchType 的特殊行：${names(plainSpecial)}（门二固定双路起步）` : null,
				`addon 行不作 batchType，用 addons 参数加挂：${names(addon)}）`,
			].filter((part) => part !== null).join('；'),
		},
		subject: { type: 'string', required: true, description: '对象：方案/门一/施工＝方案绝对路径＋批次节指针；门二＝净 diff 生成命令' },
		intent: { type: 'string', required: true, description: '本批意图一句话（设计判断要知道目标才谈得上最优）' },
		baseBatchType: { type: 'string', description: '特殊行依赖的批型：needsBase 行按原批型取组合，修复批＝原批型、新功能·形态未定＝落点批型；只在这一趟的组合可能落回原批型时消费（有门列，且该行标 needsBase 或主行该列为空），否则收到即报错' },
		decisions: { type: 'array', items: { type: 'string' }, description: `拍板清单（不得重开），逐条原文；${stages(data, 'decisions')}阶段逐条成行（直做/机械批无拍板可空，模板该行整体省略），方案那一趟不消费它——方案是给用户拍板的输入，不是已拍板的载体` },
		addons: { type: 'array', items: { type: 'string' }, description: '加挂行行名（与主行组合并集；混合批＝主批型＋各成分批型的加挂并集）。不判批型的阶段不消费它' },
		anchors: { type: 'array', items: { type: 'string' }, description: `锚点（符号名，禁行号——含「:数字」形态会告警）。${stages(data, 'anchors')}必填` },
		forbidden: { type: 'string', description: `禁区（本批不许碰的域）。${stages(data, 'forbidden')}可选` },
		verifyCmd: { type: 'string', description: `自验封顶＝一条受影响单测的命令。${stages(data, 'verifyCmd')}可选` },
		rootCause: {
			type: 'string',
			description: [
				rootCause.length > 0 ? `${names(rootCause)}施工必填：「错行|错结构」＋一句机制解释（结构错→整块重写而非点修）` : null,
				'别的阶段与别的批型收到即报错（复核组合在门一/门二、施工模板按 needsRootCause 批型追加那三行）',
			].filter((part) => part !== null).join('；'),
		},
		provider: { type: 'string', description: '子代理的 provider（如 minimax-cn），用于模型路线相关的节奏提示（Flash 拆批上限）；与阶段无关，传了即被 rhythm 谓词读' },
	}
}
