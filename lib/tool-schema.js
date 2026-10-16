/**
 * 工具 schema 的共用形状工厂：memory／see_image／dispatch 三族工具的输出里反复出现同两件
 * 形状——「字符串数组」与「object 节点」。此前 stringList 是 dispatch/index.js 的模块内 const，
 * 于是「同一个形状在三族里各写一遍」这件事没有任何东西拦着：某天某族漏一个字段标记、两族
 * 对同一形状给出不同写法，两边各自都合法，症状要到调用方按错形状取值时才出现。
 *
 * 收口真正要防的第二件事更贵：**object 节点必须显式声明 additionalProperties**，这是宿主的硬
 * 要求（defineTool 编译时抛「unsupported JSON schema」，整件工具注册失败——症状是「工具整件
 * 从上下文里消失」，不是「某个字段被拒」，定位成本远高于漏写一行）。所以 objectShape 默认闭集，
 * 要开口必须显式写 additionalProperties: true——开口是一个决定，不是一个缺省值，缺省就该是
 * 拒掉意外字段的那一档。
 *
/**
 * 工厂一律返回新对象而不是共用一份：schema 节点会被编译与遍历，共用同一份的话，将来任何一处
 * 就地改写会顺着对象身份漏到另外几族（症状与「数据没现读」同型，极难查）。入参那份 properties
 * 包则**按引用透传**：它由调用方自己持有（多半是模块级常量），深拷贝一份既费又不改语义——
 * 真是共用一份而调用方就地改写时该红的是那条就地改写，不是这个工厂。
 *
 * 入参 fail fast：形状规格是给宿主编译的，造错时宿主要么整件工具注册失败、要么编出一个字段
 * 悄悄少一截的类型，两个症状都不指向「这里传错了」。所以假值（null／0／''）当场点名报错，
 * 而 undefined 是「空壳」那一档的正规写法，不算错。
 *
 * 本模块零宿主依赖、零 fs：它只造数据形状，装配层与单测都能直接 import，不需要宿主包。
 */
export const stringList = () => ({ type: 'array', items: { type: 'string' } })

/**
 * object 节点的数组（如 dispatch 台账的 [{form}] / [{form, count}]）：条目形状逐字段列，
 * objectShape 的闭集缺省与 additionalProperties 硬要求对每个条目同样生效——数组这层只管
 * 「条目都得是这份形状」，不重复实现那两道。
 */
export const objectList = (properties, options) => ({ type: 'array', items: objectShape(properties, options) })

/**
 * object 节点。properties 省略（＝undefined）＝空壳对象节点（当前只有「事件行/摘要行那类任意多键
 * 的载荷」用得上，它们的键集由写侧事件构造处决定，逐字段列在这里就成了第二份事件契约）。
 * additionalProperties 缺省闭集：开口要显式传，见文件头注。
 */
export const objectShape = (properties, { additionalProperties = false } = {}) => {
	if (properties !== undefined && (typeof properties !== 'object' || properties === null || Array.isArray(properties))) {
		throw new Error(`objectShape 的 properties 包须是键值对象或 undefined（空壳），实得 ${JSON.stringify(properties) ?? String(properties)}——假值与数组都会安静造出一份形状不对的 schema`)
	}
	return {
		type: 'object',
		additionalProperties,
		...(properties === undefined ? {} : { properties }),
	}
}
