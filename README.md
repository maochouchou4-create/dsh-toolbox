# dsh-toolbox

自用工具箱插件：把「本机有用的工具」按深模块结构装进一个包，逐工具隔离注册——
单个工具初始化失败只丢那一件，不连坐整包。一件工具＋两件注入件（see_image；memory 索引、
dispatch 跑批纪律）：

- **memory**：单仓记忆注入（store 顶层＝两机共享条目，`machines/<机器名>/`＝本机私有条目）。
  会话 systemPrompt 索引注入（`memory:index`，order 200），分「共享（跨机同步）」与
  「本机（<机器名>）」两段；索引行由条目 frontmatter（恰好 `title`＋`description` 两键）
  现场派生，不落盘、不手写。条目的写改删不走插件工具：写＝宿主 write、改＝宿主 edit、
  删＝rm，落盘后跑 `npm run check:memory -- <记忆根> <机器id>` 离线自检（frontmatter
  契约／死链／日期戳／防膨胀线都在它里面机判）。
- **see_image**：把图片交给视觉模型转述成文字（先逐字转写可见文字，再按图型
  结构化描述），兜「图在磁盘上但当前会话模型看不见像素」的场景。两个入口：
  `path`（磁盘文件）与 `attachment`（会话占位符 hex，见下节）。
- **dispatch 纪律注入**：跑批工作流（需求→方法→出方案→方案证伪（自动派）→开工令→施工→证伪门→
  提交→删方案）的纪律与模板指针进每回合 systemPrompt（`dispatch:discipline`，order 130），
  不靠调用某件工具才看得见。文本住 `lib/dispatch/data/discipline.md`，每次请求现读；
  `{templates}` 由注入代码渲染成 `lib/dispatch/data/templates.md` 的绝对路径（方案骨架／
  三份 brief 模板／定稿自查／横切判据／门报行/安全五问都在那一份人读文件里）。读失败只
  warn 一条并跳过本回合，不阻断请求。

## memory 的索引与条目契约

记忆只有一处落点：agent-data 仓的 `memory/` 目录（下称 store；插件从配置的记忆根拼出
`<记忆根>/memory`，两机都把记忆根直接指到这个仓）。store 顶层放两机共享条目，
`machines/<机器名>/` 放各机私有条目，全部记忆同在这一处。注入分两段——「共享（跨机同步）」
与「本机（<机器名>）」，标题与基目录都写在块里。`machines/` 下非本机的段不进注入
（有几条都不进），只在块尾留一行
「另：machines/<id> N 条未注入，可直接读文件」，每条机器段一行、空段不报。机器名来自
Config 的 `machine`：未配置时注入只有共享段；`shared` 是保留字，
不可作机器名。跨机帮写帮改用 `file_path=machines/<机器名>/<文件名>` 全形式。

机器名与记忆根都写在 profile 的 cordis 配置里：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-toolbox
  name: dsh-toolbox
  config:
    machine: <机器名>                    # 小写字母数字与中划线，如 home
    memoryRoot: <agent-data 仓绝对路径>   # store＝<memoryRoot>/memory；两机都须显式配置
```

索引块每轮上下文都装一份，所以它有四重预算，全在 `lib/memory/core.js` 声明：段内索引的
**行数与字符数**、单条派生行的**字符数**，以及**注入块整块的字符数**（含写侧纪律
`WRITING.md`）。前三重由注入时逐段施加，越线截断并带显式标注（不静默丢）；整块这一重
**运行期不截**——截整块会连写侧纪律一起截掉，规则被静默丢掉比超预算更难查，所以它只判红，
由 `npm run check:memory` 离线做。数值别照抄本文档里的，那条命令会打印当前定档与实测。
`memory` 工具的 `lint` 已随写侧退役，这活现在由离线自检 `check:memory` 逐条报病灶。整块那一重的线按「**还能装几条新条目**」换算（用
实测的条目派生行均长），不按百分比——百分比定的线在语料一变就名不副名。运行期关于「索引
没装全」只有一个信号：某一段真被截断时块尾多一行「本次注入有 N 段索引超预算已截断」，报出
段数、段名与切在哪一重；一段都没截断时那行不出现。

索引不是数据：条目文件是唯一事实源，注入时按文件名排序扫目录、用
`frontmatter.title`＋`description` 重建每一行。哪些 `.md` 算条目只有一份判据——**小写 kebab
名且非保留名**（`naming.js` 单源，注入侧枚举与离线自检都问它）；非 kebab 名的文件（存量里的
`Foo.md`）因此不进索引也不进注入，离线自检的段表把它们逐条点名（收紧判据的代价面——「记忆里那条不见了」得有可发现路径）。组装入口
`composeMemory` 有一层**进程内缓存**，
键＝store 根路径＋本机机器名＋store 顶层的目录 mtime 与文件名列表＋`machines/` 下的子目录名
清单与各子目录自己的 mtime 与文件名列表＋`WRITING.md` 的 size/mtime，任一维度
变即换键全量重算，故条目文件的增删改名立刻可见。缓存**不含条目内容指纹**：不经增删改名的原地
手改某个条目，要到下一次增删改名才刷新那一行的触发词（正文本来就不注入，窗口只到「一行触发词
陈旧」）。不经增删改名的原地改法（手改某个条目、或 `git checkout` 在两台之间对齐同一批文件）
在任何文件系统精度下都既不动目录 mtime 也不动名字集合——这类改法一律要等下一次增删改名才
刷新；粗粒度文件系统（秒级 mtime）上，宿主写入在一秒内连做两次同样落进这格。命中
那一趟**不重复上报读侧诊断**（frontmatter 不合规、条目重名那几条），要等键变了重算时才再报一次
——同进程同根同机器名的第二次调用起就在这个窗口里（换根或换机器名反而安全：键里有它们，不串块也不吞诊断）。
运行期诊断走纯函数那条路（`scanSegment`）；离线自检（`check:memory`）是独立进程、每进程只调一次，
首调即满算，不吃陈旧值。因此**没有索引文件**：条目文件是唯一事实源，增删改直接作用文件，
它那一行随下一次扫描消失或重生。frontmatter 出现第三键（如与文件名重复的 `name:`）判
不合规——两键之外没有消费者的字段就是死字段；两键的值按字面取、不解析 YAML，引号会
原样进索引行。派生行以 title 为准，段内同名条目进索引就是两条触发器抢一个名字；写侧
工具退役后这道拦截只剩离线自检一档——共享段是跨机 git 同步语料，两台机器各自干净、
合流后重名照样进索引，所以合流后要跑一次 `check:memory` 兜住它。修法＝改其中一条的
frontmatter title 键（title 与文件名本就是两回事），不是删条目——撞名的每一条都是各自
带正文的现存条目。条目内节标题重名同样由自检点名：两节同名，wikilink 与人读都指不对
那一段。

## memory 写侧的文件策略边界

memory 的写改删走宿主自己的 write/edit 工具与 rm，受会话文件策略围栏；记忆根在哪决定它
拦不拦——记忆根在工作区之外时，写记忆才要求 `danger-full-access`（围栏范围是会话 cwd，
`workspace-write` 覆盖不到它）；两机现配置的记忆根都是 agent-data 仓，落在各自常用
工作区之内，所以常规会话里写记忆不受围栏影响。

跑批纪律不写盘：批次的记账落在记忆条目里，与写记忆走同一道围栏；插件没有第二份过程数据档
要写。

## see_image 通道说明

走**宿主自己的 llm 通道**（不自带 HTTP、不存任何 key）：默认
`zai-coding-cn/glm-5.3-flash`（免费档；zai 适配层在该模型上自动关思考，见
pi-ai openai-completions 的 zai thinking 映射）。换路由有两条路，改的是同一份值：**插件页 →
dsh-toolbox → 「识图路由」卡片**（浏览器半，按宿主模型目录列出候选，选中保存即生效、不必重启）
为主；**profile 层覆盖配置**仍在，是跳过 UI 的口子。例（真实存在的路由 id，本机 profile 声明过）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-toolbox
  config:
    visionProvider: zai-coding-cn   # 或任何 inputModalities 含 image 的 provider id
    visionModel: glm-4.6v            # 该 provider 目录里吃图的模型
```

图片经 attachments 服务存为 durable 引用后，由适配层按模型目录的 inputLimits
自动缩放/压缩（glm-5.3-flash：≤2000×2000、≤4.5 MiB、jpegQuality 80）。

输出预算单次 16384 token——防模型复读失控的保险丝，不是功能旋钮（省略不发给
服务商时，上限换成对方的隐藏默认值，不受本仓控制）。真撞线时不报错：正文末尾加
「转写被截断」尾注降级交货，需要剩余内容时把图裁块分别再识。

**存储增长口径**：每次 see_image 调用都会在宿主附件仓留下 durable 附件（内容
寻址、同图去重）；宿主当前没有附件 GC/释放 API，长期使用会单调增长，属已知
边界——不接受就别把 see_image 开给高频自动化流程。

## attachment 入口（会话内图片占位符）

会话里已落存的图片以占位符形态出现时——`[image omitted because this model
accepts text only; attachment sha256:053eb17e]`——`see_image(attachment="053eb17e")`
（也收 `sha256:…` 前缀或完整 64 位）在宿主附件存区
`<DSH_HOME>/attachments/v1/objects/` 按前缀定位唯一对象、转述回会话——DSH home 取自宿主
`profileContext.home`（宿主自己算的那份，含 `$DSH_HOME` 与 `~` 展开），本仓不自行推算。
前缀歧义（同头多对象）与
零命中都显式报错，不做静默兜底。占位符的真实出现场景＝会话先用视觉模型
收过图、中途切到纯文本模型后的**历史图回放**（适配层逐图替换）。

注意：**向纯文本模型的新消息里贴图/拖图并不产生占位符**——宿主在 prompt
入口直接拒收整条消息（session/attachment-invalid，
MODEL_DOES_NOT_SUPPORT_IMAGES，客户端 toast「当前模型不支持图片」）。给纯文本
模型喂图的正路＝磁盘路径：`see_image(path=…)`。

## dispatch 数据资产（两份现读文件）

`dispatch` 族的规则不在代码里：只有 `lib/dispatch/data/` 下两份人读 markdown，每回合现读、
不经缓存。

| 文件 | 是什么 | 什么时候被读 |
|---|---|---|
| `discipline.md` | 跑批纪律全文——流程顺序、角色分工、两道门的位置与停点 | 每回合随注入块进上下文（`dispatch:discipline`，order 130） |
| `templates.md` | 人读模板单文件——方案规范、方案证伪 brief、复核形态词表、施工派单 brief、证伪门 brief、横切判据、门报行、安全专项五问、不做清单 | 注入块把它的绝对路径渲染进纪律（`{templates}` 恰一处）；写方案、派复核时照抄对应节 |

`templates.md` 九节标题各恰一次（八个骨架节＋安全专项节）；**安全五问全仓只此一处**（锚点落在安全小节内），别处复述由
`test/dispatch-data.test.js` 判红。

**加载期只守纪律两条**（`data.js`）：非空、`{templates}` 恰一次，任一条对不上即加载
失败。模板的骨架结构（骨架八节＋安全专项节各恰一次、五问锚点只在安全小节内）由 `test/dispatch-data.test.js`
断言——它不挡加载：手滑改坏模板时纪律照常注入，红的是那条测试、指回改坏处。纪律注入读失败
只 warn 一条并跳过本回合，不阻断请求。

**改规则＝改数据文件，下一次请求即生效，不发版不重启**；代码改动（`lib/*.js`）新会话即新代——
宿主不重启，新起会话（含 subagent）都加载当前盘上代码，运行中会话保持旧代到它结束。

## 派发口径（批量派发）

委派形态的固定口径（用户拍板，规则不外置到 memory 或批清单）：**复核固定走 workflow**——每路
brief 一个子代理、喂 `parallel` 攒齐一次返回；**施工与修正轮走独立 subagent**——单批单 agent，
回报可针对性追问。brief 文本不再由工具装配：主会话按 `templates.md` 的 brief 模板手写每路 prompt（门一/门二门位 brief＋施工派单 brief；
角色句＋横切判据＋判据＋对象命令，只拿方案文档或净 diff、不读施工汇报、一轮为限），
拼进 workflow 的 `args` 由脚本分派：

```js
  const briefs = args.briefs; // [{form, text}]，主会话按模板手写后放进 workflow args
  const results = await parallel(briefs.map(b => async () => {
    const out = await agent(b.text, { label: b.form /* provider/model 显式指派，按你的派发纪律；可加 schema 收结构化 findings */ });
    return out === null ? { form: b.form, ok: false, error: "agent 返回 null（子代理未正常收尾）" } : { form: b.form, ok: true, out };
  }));
```

判活看 out 是否为 null——agent 失败是返回 null 不是抛错；聚合后按 ok 分流，失败路收进
`failed_routes` 别静默丢。施工单与修正轮不走此路：独立 subagent 后台派发（run_in_background），
派完结束回合等完工通知；修正轮优先 send_message 回原施工者续聊。

一个坑（实测踩过）：workflow 返回值严格 JSON 校验——成功分支不要带 `error: undefined` 这类
字段，整趟直接拒。

## 安装（本地仓直装）

```text
plugin_manager install_bundle D:\code\repos\dsh-toolbox
```

然后重启 dsh web（宿主模块代缓存：替换/装卸已装包不换模块代，必须重启才激活）。

## 验收口径

- 单测：`npm test`（node --test；三类面：零宿主依赖层（纯函数直测＋node 适配器的
  真 I/O，跑在临时目录上）、注入/装配层的宿主**替身**（`systemPrompt`／`tools` 收定义，
  不是宿主通道）、接线静态解析）。
- 记忆注入块：`npm run check:memory -- <记忆根> <机器id>`——机器 id 决定「本机段」是哪一段，
  与 Config 的 `machine` 同形同值域。**两参必须带全**：未给机器 id 而 `machines/` 下已有带
  条目的机器段时判红（本次只装共享段、本机段整段缺失，是空跑而不是全绿）；给了机器 id 而
  `machines/<id>/` 不存在也判红（配了机器名却没有私有目录——先做条目迁移，见
  `agent-data-sync.md` 的「记忆仓直连」节）。只有共享段的记忆根（还没分机器段）未给第二个
  实参不算错，命令末尾会提示未给机器 id。家机正确形态：
  `npm run check:memory -- D:\code\repos\agent-data home`
  （扫 store 顶层与 `machines/<id>/` 两段，按注入侧同一份判定验预算、frontmatter 契约、
  段内 title 重名与条目内 ## 节重名；接参 `[记忆根] [机器id]`；覆盖项见命令末尾自报名单）。
- 数据面自检：`npm test` 里 `test/dispatch-data.test.js` 对本包数据资产做断言——加载全绿冒烟
  （data.js 的纪律两守卫顺带跑真文件）、**模板骨架结构**（骨架八节＋安全专项节各恰一次、安全五问整节与锚点
  只在安全小节内）、**安全五问全仓单载体**（按节标题计数，别处复述即红）、守卫行为测试
  （埋雷体检，含「改坏模板不挡加载、由测试红」一条）；`test/dispatch-assembly.test.js` 钉住
  纪律注入的注册形状（名称/order/thunk 非空）。
- 识图质量端到端：合成四考区图（如 /tmp/vision_probe_q4.png）＋大字 OCR，
  答案与图吻合才留——不测易分辨的图，测「像素真喂进去了」。

## 结构（深模块口径）

```text
lib/index.js            胶水：工具走 FEATURES 表、两件注入各自 try/catch 隔离，一件起不来不连坐；configShape 并集
lib/paths.js            跨工具族的路径原语（目前只有 ~ 展开）。落 lib 根是因为记忆根与附件存区两条来路都要它，而它是文件系统约定不是记忆约定——留在 lib/memory/ 就越了那层自述的界
lib/value.js            跨工具族的值判据原语（isNonBlankString：非空白的字符串才算「给了」）。落 lib 根同理由：Config 回退、脚本入参判定、宿主注入的路径校验问的是同一个问题
lib/working-dir.js      会话活目录的取用收口（工具执行与注入两条路径读同一处 session.header.cwd，理由见文件内注释）。落 lib 根因为两个工具族都要它
lib/fs-port.js          包级 fs 端口的 node 半：原子发布、写前守卫（仅当不存在／版本比对）与错误码归一（词表见 fs-guard.js）；生产消费方已随迁移脚本退役，现消费方＝单测
lib/fs-guard.js         文件系统守卫与错误码词表（端口与读侧探针共用一份，零 node:fs——并进端口会把直连拖进写侧模块的本地导入闭包，「写侧 I/O 只经端口」当场失效）
lib/memory-root.js      记忆根默认值与归一、根 → store 落点、错误文案归一（零 node:fs）。落 lib 根因为要它的不止 memory 族注入：离线自检要的是「这个根归一成什么样」而不是「记忆怎么装配」，留在 memory/ 等于把整个 memory 族的 I/O 拖进它们
lib/memory/             记忆注入与自检：index.js 装配（只注册注入，无工具）+ core/frontmatter/patterns/naming/assemble/segments 纯模块（写侧 write/delete/lint/params 已随工具退役删除）。逐文件谁直连 node:fs 见 test/imports.test.js 的判定表，别照抄本文档的枚举
lib/see-image/          识图工具：index.js 装配（零直连）+ route.js（识图路由现读内缝：volatile 句柄取值＋空白回落出厂路由，零直连）+ vision.js（嗅探/终态映射，直连 node:fs）
lib/client.js           浏览器半：插件页里的「识图路由」卡片（注册 plugins.bundle.config 槽，选路由保存即生效）。经典脚本形态——宿主按静态模块表收走、JSX 与构建都不在场
lib/dispatch/           跑批纪律注入（一件注入件）：discipline.js（纪律注入：每请求现读 discipline.md 并渲染 templates.md 绝对路径，零直连）+ data.js（现读两份数据文件，加载期只验纪律两条，直连 node:fs）＋ data/（discipline.md 跑批纪律／templates.md 模板单文件＋安全五问单载体）
test/                   node:test 单测（纯函数直测＋注入/装配层宿主替身＋共享原语直测＋接线静态解析）
scripts/                checks.mjs：注入块自检的检查项数组与现场采集（可单测）；check-memory-index.mjs：跑上面那份数组的薄壳，末尾自报覆盖清单，不依赖宿主启动
```

每工具目录的模块接口只有两件：`register(ctx, config)` 与 `configShape`（dispatch 目录只有
纪律注入一件，导出 `registerDiscipline`；注入件同样按 `register(ctx, config)` 调，胶水逐件
独立 try/catch，一件起不来不连坐另一件）。
纯函数文件零宿主依赖，可直接单测；含宿主 import 的装配文件由 test/imports.test.js
静态解析钉住接线（防搬家断链、防 inject 漏声明）。

MIT
