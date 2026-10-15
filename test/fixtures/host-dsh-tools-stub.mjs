/**
 * 宿主包 dsh-tools 的替身（装配层冒烟用）：defineTool 原样交回定义对象——冒烟要验的是「宿主
 * 真正会调的那几个口」（register/parameters/execute/output.render）接得对不对，defineTool 自己
 * 怎么包一层与本仓无关。裸仓装不上宿主包，故由 registerHooks 把那个说明符指到这里。
 */
export const defineTool = (definition) => ({ ...definition })
