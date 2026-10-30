# dsh-toolbox（仓级）

DSH 插件包。README 是人读的能力与边界说明；本文件是改这个包的 Agent 的施工纪律。

## 开工前

- **改动落点地图（先看这条再找文件）**：本包终态＝一件工具（`lib/see-image/`）＋两件注入件
  （`lib/memory/` 记忆索引／`lib/dispatch/` 跑批纪律）。派发规则面＝`lib/dispatch/data/` 两份文件
  （`discipline.md` 跑批纪律全文，每回合注入／`templates.md` 人读模板单文件：方案规范、三份
  brief、形态词表、横切判据、门报行、安全五问（全仓唯一载体）、不做清单）。
  **数据文件现读不缓存——改完下次请求即生效；代码（`lib/*.js`）随新会话加载，运行中会话保持旧代**。
  `discipline.md` 的加载期守卫在 `lib/dispatch/data.js`（非空／≤14 行／`{templates}` 恰一次）；
  `templates.md` 的结构断言（骨架八节＋安全专项节各恰一次、五问锚点只在安全小节内）在 `test/dispatch-data.test.js`
  ——改模板不挡加载（纪律照样注入），测试红指回改坏处；`test/dispatch-assembly.test.js` 钉住纪律
  注入的注册形状。
  数据面怎么读见 `README.md`「dispatch 数据资产」节。
- **插件改动：新会话即新代，宿主不必重启**。宿主（web 形态）对插件 `lib/*.js` 逐会话导入：
  宿主进程不重启，新起会话（含 subagent）即加载盘上当前代码；运行中会话保持旧代到它结束。
  本会话不重启宿主（重启会掐断会话）；交付时报实际验到的，运行中会话的旧代行为不归本批背书。
- 先读 `README.md` 的对应小节：写侧的文件策略边界（哪些动作受会话策略围栏）、
  索引与条目契约（预算与 frontmatter 两键），都在那里，代码注释不重复它。

## 改 memory 契约时

契约散在三处，**改一处必须同改其余处**：注入装配面 `lib/memory/index.js`（注册与
描述词）、判定与派生 `lib/memory/naming.js`（条目名与保留名判定）与
`lib/memory/frontmatter.js`（frontmatter 契约与索引行派生）、跨仓的书写规范
`D:\code\repos\agent-data\memory\WRITING.md`（每轮随索引注入进上下文的写侧
纪律）。规范与实现不同步＝条目按旧格式写进来、`check:memory` 判红或漏判；改判定
常量（防膨胀两条线等）时同步 `scripts/checks.mjs` 的 guard 文案与镜像测试，数字不在
两处各抄一份。

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

- 写侧 I/O 端口＝`lib/` 根的 `fs-port.js`（写侧工具已随改版退役，现消费方＝迁移脚本
  `scripts/migrate-frontmatter.mjs` 与单测），它是写侧唯一的 I/O 通道：契约、守卫、错误码
  （`FS_STALE_VERSION`/`FS_NOT_OBSERVED`/`FS_NOT_REGULAR_FILE`）、原子发布都不许为图省事削弱或绕过；
  要落盘就走端口方法（`resolve/stat/readText/writeText`），别直调 `node:fs`。
  这条边界的口径是**整个本地导入闭包**：给消费端模块加一行 `import node:fs`
  同样算绕门（`test/imports.test.js` 的闭包断言就为此存在，逐文件定性表管不到那一跳）。
- `lib/memory/` 下除装配层（`index.js`）外一律零宿主依赖，可直接单测；
  `lib/see-image/vision.js` 同。新增文件按这条规则就位，不要维护枚举清单。
  `test/imports.test.js` 静态解析钉住导入面与 node:fs 直连的定性表，搬家断链、
  新模块漏定性都会红。
- 版本号随契约走：工具参数面、注入块结构、frontmatter 契约任一变更都算破坏性变更，
  minor 位就是破坏位（1.8.0 → 1.9.0），并与 README 的描述同批改。
- 版本号不靠记性：市场判「有没有新东西可装」只读仓库 `package.json` 的 `version`（与已装版本比），
  版本不动就只显示「有新提交（未发版）」。`.githooks/pre-commit` 于是把「动了 `lib/**` 而版本与 HEAD
  相同」的提交自动 patch 升一位并进同一次提交（壳 `scripts/bump-version.mjs`／判定 `scripts/version.mjs`／
  单测 `test/bump-version.test.js`）；破坏性改动依上一条先 `npm run bump -- minor` 再提交，钩子见版本已变
  就不碰。**新克隆一次性启用：`git config core.hooksPath .githooks`**——没启用就是不跑，等于回到靠记性。
