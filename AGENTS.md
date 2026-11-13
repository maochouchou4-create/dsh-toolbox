# dsh-toolbox（仓级）

DSH 插件包。README 只留插件页展示的短卡（宿主把已装包 README 全文渲染进插件页，长文会把
「识图路由」卡顶出首屏）；本文件＝开发文档＋施工纪律：能力边界、契约、通道机制、结构都在这里。

## 开工前

- **改动落点地图（先看这条再找文件）**：本包终态＝一件工具（`lib/see-image/` 识图转述）＋一件
  注入件（`lib/memory/` 记忆索引）。**数据文件现读不缓存——改完下次请求即生效；代码（`lib/*.js`）
  随新会话加载，运行中会话保持旧代**。
- **插件改动：新会话即新代，宿主不必重启**。宿主（web 形态）对插件 `lib/*.js` 逐会话导入：
  宿主进程不重启，新起会话（含 subagent）即加载盘上当前代码；运行中会话保持旧代到它结束。
  本会话不重启宿主（重启会掐断会话）；交付时报实际验到的，运行中会话的旧代行为不归本批背书。
  例外＝**装卸/替换已装包不换模块代**：`plugin_manager install_bundle D:\code\repos\dsh-toolbox`
  之后必须重启 dsh web 才激活。

## memory 机制（写侧契约同改面＝插件三码件＋AGENTS.md 记忆书写节，此处只记它们不载的）

- profile 接线（`~/.dsh/profiles/web/cordis.patch.yml` 的 `- id: dsh-toolbox` 行）：
  `machine: <机器名>`（小写字母数字与中划线）＋`memoryRoot: <agent-data 仓绝对路径>`
  （store＝memoryRoot/memory；两机都须显式配置）。
- 四重预算在 `lib/memory/core.js` 声明（段内索引行数/字符、单条派生行、注入块整块）；数值别照抄
  文档——`check:memory` 末尾自报当前定档与实测。整块超线**运行期不截**（截整块会整批静默丢
  索引行，丢了比超预算难查），只判红归离线自检。段真被截时块尾多一行
  「本次注入有 N 段索引超预算已截断」；一段没截那行不出现。
- `composeMemory` 每回合现读现算、不留任何跨回合结果：条目原地手改（改正文/触发词）下回合
  即见；实测成本对照模型调用无感（具体数字归 git 历史）。读侧诊断（frontmatter 不合规、重名
  那几条）每趟如实上报，日志去重由外层 warnOnce 兜。
- 共享段跨机 git 合流：两台各自干净、合流后仍可能 title 撞名——合流后跑一次 `check:memory` 兜；
  修法＝改撞名条目的 frontmatter title 键（title 与文件名本就是两回事），不是删条目。
- 写侧围栏：memory 写改删走宿主 write/edit/rm，受会话文件策略围栏——记忆根在工作区之外时写记忆
  才要求 `danger-full-access`；两机记忆根都指 agent-data 仓、落在常用工作区内，常规会话不受围栏
  影响。批次的记账落在记忆条目，插件没有第二份过程数据档。

## see_image 通道

- 走宿主 llm 通道（不自带 HTTP、不存任何 key）。出厂路由 `zai-coding-cn/glm-5.3-flash`（免费档；
  zai 适配层在该模型自动关 thinking）；空白回落出厂——`lib/client.js` 的 FALLBACK_ROUTE 与
  `lib/see-image/route.js` 必须逐字一致，`test/client.test.js` 对拍。
- 换路由改的是同一份值，两个口：插件页「识图路由」卡片（主口，选中保存即生效、不必重启）／
  profile 层 `visionProvider`＋`visionModel` 覆盖（跳过 UI 的口子）。
- 图片经 attachments 存为 durable 引用后，适配层按模型目录 inputLimits 自动缩放/压缩
  （flash 档：≤2000×2000、≤4.5 MiB、jpegQuality 80）。
- 输出预算单次 16384 token＝防模型复读失控的保险丝；撞线不报错，正文尾注「转写被截断」降级交货，
  要剩余内容就把图裁块分别再识。
- 每次调用在宿主附件仓留 durable 附件（内容寻址、同图去重）；宿主无附件 GC/释放 API，长期单调
  增长＝已知边界（F5 口径），不接受就别把 see_image 开给高频自动化流程。
- attachment 入口：占位符 hex（≥8 位前缀或完整 64 位）在 `<DSH_HOME>/attachments/v1/objects/`
  按前缀定位（DSH home＝宿主 profileContext.home，本仓不自行推算）；前缀歧义与零命中显式报错。
  占位符真实场景＝会话先用视觉模型收图、中途切纯文本模型后的历史图回放；**往纯文本模型的新消息
  贴图不产生占位符**——宿主 prompt 入口整条拒收（session/attachment-invalid，
  MODEL_DOES_NOT_SUPPORT_IMAGES）；给纯文本模型喂图的正路＝`see_image(path=…)`。

## 结构（深模块口径）

```text
lib/index.js            胶水：工具走 FEATURES 表、注入件 try/catch 隔离；configShape 并集
lib/paths.js            跨工具族路径原语（~ 展开）
lib/value.js            跨工具族值判据原语（isNonBlankString）
lib/warn-once.js        告警去重工厂（makeWarnOnce：注入告警「同消息只报一次」）
lib/working-dir.js      会话活目录收口（session.header.cwd，工具与注入同读一处）
lib/fs-guard.js         错误码词表与族标识（codedFsError，零 node:fs）
lib/memory-root.js      记忆根默认值/归一、store 落点、错误文案归一（零 node:fs）
lib/memory/             记忆注入＋自检：index.js 装配；core/frontmatter/patterns/naming/assemble/segments 纯模块
lib/see-image/          识图工具：index.js 装配＋route.js 路由现读＋vision.js 嗅探/终态映射（直连 node:fs）
lib/client.js           浏览器半：插件页「识图路由」卡（经典脚本、createElement、无构建）
test/ scripts/          node:test 单测；checks.mjs 检查项数组＋check-memory-index.mjs 薄壳
```

每工具目录的模块接口只有两件：`register(ctx, config)` 与 `configShape`（注入件同样按
`register(ctx, config)` 调）。胶水逐件独立 try/catch，一件起不来
不连坐另一件。纯函数文件零宿主依赖、可直接单测；含宿主 import 的装配文件由 `test/imports.test.js`
静态解析钉住接线（防搬家断链、防 inject 漏声明）；各文件为什么落在这层，理由在文件头注释。

## 改 memory 契约时

契约散在三处，**改一处必须同改其余处**：注入装配面 `lib/memory/index.js`（注册与
描述词）、判定与派生 `lib/memory/naming.js`（条目名与保留名判定）与
`lib/memory/frontmatter.js`（frontmatter 契约与索引行派生）、跨仓的书写规范
agent-data 的 AGENTS.md「记忆书写」节（规则唯一家——写侧纪律原文住在那里，
不再随索引注入）。规范与实现不同步＝条目按旧格式写进来、`check:memory` 判红或漏判；改判定
常量（防膨胀两条线等）时同步 `scripts/checks.mjs` 的 guard 文案与镜像测试，数字不在
两处各抄一份。

## 完成标准

一次交付在这两条都绿才算完（都是一条命令，秒级）：

```text
npm test            # exit 0 且 pass 数不低于改前
node D:\code\repos\dsh-toolbox\scripts\check-memory-index.mjs <记忆根> <机器id>   # 记忆索引预算、frontmatter 契约与段内 title 重名（改记忆侧才跑）
```

`npm test` 三类面：零宿主依赖层直测（纯函数＋node 适配器真 I/O，跑临时目录）、注入/装配层的
宿主替身、接线静态解析。`check:memory` 判绿＝**exit 0 且输出末尾有自报名单**：它自己以顶层脚本形态
运行，检查项数组在 `scripts/checks.mjs`，薄壳 `scripts/check-memory-index.mjs` 没有
「被直接运行才执行」那道守卫，所以「静默没跑」和「跑绿了」只能靠这两样区分。

- 测试**删减须显式申报**：前提失效优先改写（旧断言换新断言，行为变化可见）；真要删
  在汇报里单独说明为什么——防施工者为过门静默拆守卫。
- `check:memory` 的第二个实参是**机器 id**（与 Config 的 `machine` 同形同值域），它决定
  哪一段算「本机段」：未给而 `machines/` 下已有带条目的机器段时，本次注入只装共享段、
  本机段整段缺失——空跑，该命令以 1 退出并说明该带什么；给了机器 id 而
  `machines/<id>/` 不存在也以 1 退出（配了机器名却没有私有目录，先做条目迁移）。
  只有共享段的记忆根未给第二参不算错，命令末尾会提示未给机器 id。
  覆盖项与定档数值都以脚本自报为准（跑上面那条命令，末尾逐项打印 id／判据／守的常量）——本文件不手抄清单，脚本一改就会与手抄的那份分家。
- **超线先收敛**：新增或改写记忆条目后若整块超定档，先并／删条目、精修 AGENTS.md
  「记忆书写」节散文；不自动抬线。确需抬线必须在 commit message 里写明新实测值与理由，且新余量按
  「还能装几条新条目」换算（用实测的条目派生行均长），不按百分比——百分比定的线在语料
  一变就名不副实，实测按百分比定的线连一条新条目都装不下，等于每次写记忆都要抬线。
- 识图面改动加一道端到端：合成四考区图（如 /tmp/vision_probe_q4.png）＋大字 OCR，
  答案与图吻合才留——不测易分辨的图，测「像素真喂进去了」。
- `npm test` 覆盖不到运行期（宿主接线、注入块在真实会话里的样子），所以它是下限
  不是上限：改动触及注入或工具契约时，附上你实际验到了什么、没验到什么。

## 硬边界

- `lib/memory/` 下除装配层（`index.js`）外一律零宿主依赖，可直接单测；
  `lib/see-image/vision.js` 同。新增文件按这条规则就位，不要维护枚举清单。
  `test/imports.test.js` 静态解析钉住导入面与 node:fs 直连的定性表，搬家断链、
  新模块漏定性都会红。
- 版本号随契约走：工具参数面、注入块结构、frontmatter 契约任一变更都算破坏性变更，
  minor 位就是破坏位（1.8.0 → 1.9.0），并与本文件的对应描述同批改。
- 版本号不靠记性：市场判「有没有新东西可装」只读仓库 `package.json` 的 `version`（与已装版本比），
  版本不动就只显示「有新提交（未发版）」。`.githooks/pre-commit` 于是把「动了 `lib/**` 而版本与 HEAD
  相同」的提交自动 patch 升一位并进同一次提交（壳 `scripts/bump-version.mjs`／判定 `scripts/version.mjs`／
  单测 `test/bump-version.test.js`）；破坏性改动依上一条先 `npm run bump -- minor` 再提交，钩子见版本已变
  就不碰。**新克隆一次性启用：`git config core.hooksPath .githooks`**——没启用就是不跑，等于回到靠记性。
- `.githooks/pre-push` 同一条启用（同一个 hooksPath）：push 前自动跑全量 `npm test`，
  不绿不放行——完成标准第一条由它结构保证；绕过＝`git push --no-verify`（这次 push
  的代码没被测试背书）。
