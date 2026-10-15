/**
 * 宿主包 schemastery 的替身（装配层冒烟用）：configShape 里只用到 z.string().default('')，这里
 * 给一条可链式的假链子。冒烟要验的是「configShape 那个对象建得起来、键名对」，不是校验库本身。
 */
const chainable = new Proxy(function () {}, {
	get: (_target, key) => (key === 'default' || key === 'optional' || key === 'min' || key === 'max' ? () => chainable : () => chainable),
	apply: () => chainable,
})

const z = new Proxy({}, { get: () => () => chainable })

export default z
