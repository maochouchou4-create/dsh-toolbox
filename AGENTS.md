# dsh-toolbox（仓级）

DSH 插件包。README 是人读的能力与边界说明；本文件是改这个包的 Agent 的施工纪律。

## 开工前

- **插件改动要在下次启动后才算数**。本仓被宿主按模块代缓存，改完 `lib/` 不会热更新。
  本会话不重启宿主（重启会掐断会话），所以任何「装上了/生效了」的说法都不成立：
  交付时把运行期验证标成**待下次启动验证**，只报你真正验过的。
- 先读 `README.md` 的对应小节：写侧的文件策略边界（哪些动作受会话策略围栏）、
  索引与条目契约（预算与 frontmatter 两键），都在那里，代码注释不重复它。

## 改 memory 契约时

契约散在三处，**改一处必须同改另两处**：工具契约面 `lib/memory/index.js`
（`parameters`＋`output.schema`＋`content` 的描述词）、判定与派生
`lib/memory/frontmatter.js`、跨仓的书写规范
`/home/nvse/code/repos/agent-data/memory/WRITING.md`（memory 工具的 description 与
MANIFEST 指针都指向它）。
schema 与实现不同步＝子代理照 schema 传参撞上「参数不存在」；规范与实现不同步
＝条目按旧格式写进来、写侧当噪声拒收。

参数级写法细则（值按字面取、不解析 YAML、折行被拒）写进 `index.js` 的参数描述即可，
不必塞进 WRITING.md——后者每轮都进上下文，承载的是记忆书写纪律，不是单个参数的语法。

## 完成标准

一次交付在这两条都绿才算完（都是一条命令，秒级）：

```text
npm test            # exit 0 且 pass 数不低于改前
npm run check:memory -- <记忆根> <机器id>   # 记忆索引预算、frontmatter 契约与段内 title 重名（改记忆侧才跑）
```

`npm run check:memory` 判绿＝**exit 0 且输出末尾有自报名单**：它自己以顶层脚本形态
运行，检查项数组在 `scripts/checks.mjs`，薄壳 `scripts/check-memory-index.mjs` 没有
「被直接运行才执行」那道守卫，所以「静默没跑」和「跑绿了」只能靠这两样区分。

- 测试**删减须显式申报**：前提失效优先改写（旧断言换新断言，行为变化可见）；真要删
  在汇报里单独说明为什么——防施工者为过门静默拆守卫。
- `check:memory` 的第二个实参是**机器 id**（与 Config 的 `machine` 同形同值域），它决定
  哪一段算「本机段」：未给而 `machines/` 下已有带条目的机器段时，本次注入只装共享段、
  本机段整段缺失——空跑，该命令以 1 退出并说明该带什么；给了机器 id 而
  `machines/<id>/` 不存在也以 1 退出（配了机器名却没有私有目录，先做条目迁移）。
  只有共享段的记忆根未给第二参不算错，命令末尾会提示未给机器 id。
  覆盖项以脚本自报为准（`npm run check:memory`
  末尾逐项打印 id／判据／守的常量）——本文件不再手抄清单，脚本一改就会与手抄的那份分家。
- **超线先收敛**：新增或改写记忆条目后若整块超定档，先并／删条目、精修 `WRITING.md`
  散文；不自动抬线。确需抬线必须在 commit message 里写明新实测值与理由，且新余量按
  「还能装几条新条目」换算（用实测的条目派生行均长），不按百分比——百分比定的线在语料
  一变就名不副实，实测按百分比定的线连一条新条目都装不下，等于每次写记忆都要抬线。
- `npm test` 覆盖不到运行期（宿主接线、注入块在真实会话里的样子），所以它是下限
  不是上限：改动触及注入或工具契约时，附上你实际验到了什么、没验到什么。

## 硬边界

- 写侧 I/O 端口＝`lib/` 根的 `fs-port.js`（memory 与 dispatch 共用），它是写侧
  （`upsertEntry`/`editEntry`）唯一的 I/O 通道：契约、守卫、错误码
  （`FS_SANDBOX_DENIED`/`FS_STALE_VERSION`）、原子发布都不许为图省事削弱或绕过。要在写侧
  读目录就用端口的 `listDir`，别在 upsert/edit 里调 `node:fs`。
  这条边界的口径是**整个本地导入闭包**：给 `write.js` 的下游模块加一行 `import node:fs`
  同样算绕门（`test/imports.test.js` 的闭包断言就为此存在，逐文件定性表管不到那一跳）。
- `lib/memory/` 下除装配层（`index.js`）外一律零宿主依赖，可直接单测；
  `lib/see-image/vision.js` 同。新增文件按这条规则就位，不要维护枚举清单。
  `test/imports.test.js` 静态解析钉住导入面与 node:fs 直连的定性表，搬家断链、
  新模块漏定性都会红。
- 版本号随契约走：工具参数面、注入块结构、frontmatter 契约任一变更都算破坏性变更，
  0.x 的 minor 位就是破坏位（0.1.1 → 0.2.0），并与 README 的描述同批改。
