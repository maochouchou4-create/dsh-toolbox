/**
 * see_image 的识图路由内缝（零宿主依赖，node --test 直测）：把「现读 volatile 句柄 ＋ 空值回落」
 * 收成一处，胶水层只把 config 句柄递进来。与 vision.js 同款分层——宿主包不可解析的裸仓环境也能
 * 整段跑单测，故「改设置即生效」这件事有处可验。
 *
 * 为什么是现读而不是注册期快照：路由存在 volatile 字段里，宿主保存时走 updateVolatile 就地改
 * 句柄取值、不重挂插件，插件这侧唯一的活值来源就是 .get()。注册期把字符串解构进闭包，等于把
 * 「保存即生效」退化成「下次重启才生效」，而症状只在用户改完设置、看下一张图时才显形。
 *
 * 为什么句柄缺席要报错而不是回默认：取值空白＝用户清空了字段，回默认是设计；句柄本身不在场是
 * 接线错（configShape 少声明 .volatile()，或有人把 config 换成了取值快照），那时默认值会把接线
 * 错误伪装成一条正常路由，直到有人发现改设置不生效——报错把诊断点落在首次调用工具时（路由在
 * execute 里才现读，注册期压根不碰 config）。
 */
import { isNonBlankString } from '../value.js'

/** 出厂识图路由：configShape 的默认值与本回落同源，单源在这里。 */
export const DEFAULT_PROVIDER = 'zai-coding-cn'
export const DEFAULT_MODEL = 'glm-5.3-flash'

/**
 * 取当次生效的识图路由。config 是插件的 config 对象（字段为 volatile 句柄，不是取值），
 * 每次调用都向句柄现读——工具执行与返回值回显因此拿到的都是保存后的新值。
 */
export function resolveVisionRoute(config) {
	return {
		provider: readVolatile(config, 'visionProvider', DEFAULT_PROVIDER),
		model: readVolatile(config, 'visionModel', DEFAULT_MODEL),
	}
}

function readVolatile(config, key, fallback) {
	const ref = config?.[key]
	if (typeof ref?.get !== 'function') {
		throw new Error(`识图路由读不到 ${key} 的 volatile 句柄：configShape 须声明 .volatile()，且注册期传的是 config 句柄而非取值快照`)
	}
	const value = ref.get()
	return isNonBlankString(value) ? value : fallback
}
