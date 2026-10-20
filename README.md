# dsh-toolbox

自用工具箱插件：把「本机有用的工具」按深模块结构装进一个包，逐工具隔离注册——
单个工具初始化失败只丢那一件，不连坐整包。当前六件：

- **memory**：单仓记忆注入（store 顶层＝两机共享条目，`machines/<机器名>/`＝本机私有条目）。
  会话 systemPrompt 索引注入（`memory:index`，order 200），分「共享（跨机同步）」与
  「本机（<机器名>）」两段；索引行由条目 frontmatter（恰好 `title`＋`description` 两键）
  现场派生，不落盘、不手写。条目的写改删不走插件工具：写＝宿主 write、改＝宿主 edit、
  删＝rm，落盘后跑 `npm run check:memory -- <记忆根> <机器id>` 离线自检（frontmatter
  契约／死链／日期戳／防膨胀线都在它里面机判）。
- **see_image**：把图片交给视觉模型转述成文字（先逐字转写可见文字，再按图型
  结构化描述），兜「图在磁盘上但当前会话模型看不见像素」的场景。两个入口：
  `path`（磁盘文件）与 `attachment`（会话占位符 hex，见下节）。
- **dispatch_task**：施工派发的装配（跑批工作流 v2 两件之一）。按分诊档位 S/M/L 出任务书
  （≤15 行骨架：意图／锚点符号／禁区／预算／验收命令／回报 schema＋固定门报行；S 档免任务书、
  只出自验口径但同样落 start 事件），并直出可派参数两种形态（`workflowArgs`＝subagent 可直接粘贴；
  workflow 用 `args.workflowArgs`）。`diffLines` 超 `pairing.json` 阈值（1000 行）直接报错并强制
  升 L、不降档收；语义域关键词在分诊行里命中即自动加挂安全专项。出稿即落 start 事件（档位／
  分诊行／拍板清单＋规则指纹），台账已有该批则只提醒、不重复登记。
- **dispatch_challenge**：证伪门／方案证伪的派发与记账（两件之二）。出独立复核 brief：每形态
  一段（角色句＋模板继承的横切判据＋四维判据＋对象＝净 diff 生成命令），只拿任务书与净 diff、
  不读施工汇报、一轮为限；`adjudicate=true` 时同一件工具把 findings 裁决写进 gate 事件（采纳／
  拒收／双报重叠／漏网／施工段标记）。档位、分诊行、意图、拍板清单未传则从台账回填（`subject`
  不回填——证伪门要的是净 diff 命令）。
- **dispatch_batch**：批次台账。四事件 `start`/`gate`/`commit`/`review`，一个批次一生记成 JSONL
  追加行，状态从事件现推（`status`/`list`）；`commit` 记提交号与推送结果，`review` 记复盘行＋
  门效能（也是复盘销账点）。旧六阶段事件按 stage 名归一后标 legacy：能读能算，不参与门禁硬判。
- **dispatch_lessons**：复盘辅助。读 `review` 事件之后的增量批（无 review 时按全量算），按点位
  （攒 5–8 批、覆盖 ≥3 档位；阈值单源是 `lifecycle.json` 复盘行的 `point`）判断是否到点，到了
  出配对规则修订建议草稿（长期零 findings 形态降级／漏网加派／修复轮数收敛／双报重叠趋势；
  历史统计按规则指纹分组）。只出建议给主会话裁决，不自动改配对表、不落盘（装配层只给它只读端口）。
- **usage_note**：使用日志的手记口子。本包七件的调用行由订阅层旁路落进记忆仓
  `memory/data/usage-log/` 下按天、按机器分片的 jsonl，两种行：**成功行瘦**——只有
  ts/type/tool/callId/ok/agent/profile/`argKeys`（参数键集，不含值）/`ms`（执行耗时），
  memory 写条目的几千字正文不进日志；**失败行胖**——保持既有全量（`args` 值级摘要＋结果摘要
  ＋`error` 整块，宿主 `ToolFailure` 的 `info` 只在这一处留存，两次复盘还原调错现场都靠
  args）。白名单＝本包七件的注册名现读；文件名 `<日期>.<机器名>.jsonl`，两台机器各写各的
  文件、git 永不冲突；**14 天轮转**——写入与注册时各清一趟超过窗口的日档，判龄看档名里的
  日期、不看 mtime（同步仓 checkout 会把所有档 mtime 刷新），窗口常量在 recorder 顶部单源、
  不进配置面；删除只对**已提交到 HEAD 的档**开口——untracked 或有未提交改动的档跳过并
  `console.warn` 一条（历史在 git 里，删了不可恢复），写失败只 `warn`、不污染调用链。结构化
  字段装不下的隐性坑（哪步不顺利、试过什么、怎么绕开的）用 `note`/`tool`/`ok` 事后补记一行，
  复盘时与调用行同一条时间线。三条
  边界如实写明：①它是追加型旁路，**不接会话只读策略**——只读会话里日志照写、记忆仓会脏；
  ②落点由配置的记忆根决定，**记忆根未配置时落默认根 `~/.dsh/memory` 下、不进任何 git 仓**
  （与批次台账同款行为）；机器的 `machine` 未配置或不在值域内时不写日志（旁路只 `warn`、
  手记直接报错），不造「未归因」的文件。③**日志进 git 历史，删除不会抹掉历史**：失败行的
  `args` 是值级截断后的参数（含记忆条目正文前 200 字、派发决策原文），成功行只有参数名，
  手记正文上限 500 字——写入前不要让它承载机密；单行总长没有上界（截断只限单个字符串），
  旧日志按需
  `git rm`。

## memory 的索引与条目契约

记忆只有一处落点：agent-data 仓的 `memory/` 目录（下称 store；插件从配置的记忆根拼出
`<记忆根>/memory`，两机都把记忆根直接指到这个仓）。store 顶层放两机共享条目，
`machines/<机器名>/` 放各机私有条目，全部记忆同在这一处。注入分两段——「共享（跨机同步）」
与「本机（<机器名>）」，标题与基目录都写在块里。`machines/` 下非本机的段不进注入
（有几条都不进），只在块尾留一行
「另：machines/<id> N 条未注入，可直接读文件」，每条机器段一行、空段不报。机器名来自
Config 的 `machine`：未配置时注入只有共享段、`write` 缺省也落共享段；`shared` 是保留字，
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

注入块首行固定是**工作流引导行**（跑批 v2 四事件：立项→门报→提交→复盘——每步先调对应装配工具：
`dispatch_task`→`dispatch_challenge`→`dispatch_batch`，四事件自动落账），它不是记忆数据、不进
`composeMemory`，由注册层在记忆块之前另拼；阶段序列的单源是 `lifecycle.json`，改版漏改这一行
测试即红。

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
变即换键全量重算，故写侧工具的增删改名立刻可见。缓存**不含条目内容指纹**：不经写侧工具的原地
手改某个条目，要到下一次增删改名才刷新那一行的触发词（正文本来就不注入，窗口只到「一行触发词
陈旧」）。不经写侧工具的原地改法（手改某个条目、或 `git checkout` 在两台之间对齐同一批文件）
在任何文件系统精度下都既不动目录 mtime 也不动名字集合——这类改法一律要等下一次增删改名才
刷新；粗粒度文件系统（秒级 mtime）上，写侧工具自己的发布在一秒内连做两次同样落进这格。命中
那一趟**不重复上报读侧诊断**（frontmatter 不合规、条目重名那几条），要等键变了重算时才再报一次
——同进程同根同机器名的第二次调用起就在这个窗口里（换根或换机器名反而安全：键里有它们，不串块也不吞诊断）。
体检走纯函数那条路（`scanSegment`）；离线自检（`check:memory`）是独立进程、每进程只调一次，
首调即满算，不吃陈旧值。因此**没有索引文件**：条目文件是唯一事实源，增删改直接作用文件，
它那一行随下一次扫描消失或重生。frontmatter 出现第三键（如与文件名重复的 `name:`）判
不合规——两键之外没有消费者的字段就是死字段；两键的值按字面取、不解析 YAML，引号会
原样进索引行。派生行以 title 为准，段内同名条目进索引就是两条触发器抢一个名字；写侧
工具退役后这道拦截只剩离线自检一档——共享段是跨机 git 同步语料，两台机器各自干净、
合流后重名照样进索引，所以合流后要跑一次 `check:memory` 兜住它。修法＝改其中一条的
frontmatter title 键（title 与文件名本就是两回事），不是删条目——撞名的每一条都是各自
带正文的现存条目。条目内节标题重名同样由自检点名：两节同名，wikilink 与人读都指不对
那一段。

## memory 与 dispatch 写侧的文件策略边界

memory 的写改删走宿主自己的 write/edit 工具与 rm，受会话文件策略围栏；记忆根在哪决定它
拦不拦——记忆根在工作区之外时，写记忆才要求 `danger-full-access`（围栏范围是会话 cwd，
`workspace-write` 覆盖不到它）；两机现配置的记忆根都是 agent-data 仓，落在各自常用
工作区之内，所以常规会话里写记忆不受围栏影响。

`dispatch_batch` 的写侧同通道同前置：台账落在 store 下的 `data/` 里（＝agent-data 仓的
`memory/data/`）。它与记忆同处一仓、同在常用工作区之内，所以记账的门槛与写记忆完全一样
——记忆根出了工作区的会话里两者一起被拒，不是这个工具多要的一份权限。`dispatch_lessons`
只读台账，不受这条约束——装配层传给它的端口上压根没有写方法
（`fs-port.js` 的只读门面），边界是结构性的而不是靠记着别写。

同一处 `data/` 里还有使用日志，两族按「记什么」分工而不是按「谁写的」：**批次语义归台账**
（哪一批、哪一档、过了哪道门、复盘结论——两机共写、状态从事件现推），**调用痕迹归
usage-log**（哪件工具、参数键集、成败、耗时——各机各写、按天追加、14 天轮转）。复盘时一处
读齐两族，但它们回答的是不同问题，别互相替代：台账回答「这批怎么过的」，日志回答「当时用了
什么、哪里不顺」。

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

## dispatch 数据资产（现读面与追加面）

`dispatch` 族的规则与数据不在代码里，按**读取时机**分三面：

| 面 | 载体 | 什么时候被读 | 改它要不要重启 |
|---|---|---|---|
| 常驻召回面 | 四件工具的 `description`（`dispatch_task`／`dispatch_challenge`／`dispatch_batch`／`dispatch_lessons`） | 每个请求都随工具清单进上下文 | 要（改描述＝改代码） |
| 现读面 | `lib/dispatch/data/` 下五份 JSON（每次调用经 node:fs 现读） | 每次工具调用 | 不要，改 JSON 下次调用即生效 |
| 追加面 | 台账 `memory/data/dispatch-ledger.jsonl`（两机 git 共享，`merge=union`） | `dispatch_task`/`dispatch_challenge`/`dispatch_batch` 写，四件工具与 `dispatch_lessons` 读 | 不要 |

现读面五份（v2 骨架）：

- `forms.json`：**三件存活形态**（`id`/`gate`/`catches`/`role`，可带 `extras`）——证伪门、方案证伪、
  安全专项——加 `rejected`（不做清单）。v1 的 22 件只迁这三件，其余 19 件删除不迁移。安全专项
  是**五问的唯一载体**（鉴权／越权／输入／上传／PII 进日志），`role` 里必须逐条出现，别的形态
  复述五问即加载失败（单数载体由 `SAFETY_CARRIER_IDS` 钉住）。
- `pairing.json`：**三档行＋三硬触发行**。档位行字段 `tier`（S/M/L 三行齐全，缺一即残表）／
  `taskBook`（S 为 false：免任务书不免记账）／`challenge`（证伪门形态 id 数组或 null）／
  `planChallenge`（方案证伪，仅 L 档）／`note`（档位口径人话）；硬触发行字段 `id`／`match`／
  `upgrade`（命中后必须达到的档位）／`form`（可缺省；语义域行＝安全专项）／`threshold`
  （只有 diff 超阈行带，1000 行）。
- `templates.json`：**六键**——任务书骨架（≤15 行）／证伪门／方案证伪／横切判据／拍板卡（≤6 行）／
  门报行。模板里的 `〔…〕` 占位符必须登记在 `data.js` 的 `PLACEHOLDER_REGISTRY`（越表＝加载失败），
  空值整行省略（可选行靠这条省出来）。
- `lifecycle.json`：**四阶段**（立项／门报／提交／复盘）——阶段词表、各阶段的参数必填清单
  （`requires`，取值必须在 `PARAM_FIELDS` 里）与**复盘点位判据**（复盘行的 `point`：
  `minBatches`/`minTiers`/`upperBatches`）的单源。`gate` 列只对「门报」为 true（加载期核）。
- `plan-spec.json`：**例外件**——仅 L 档、且只在设计未定或用户要方案时成文的方案规范
  （`blocks` 八节＋`checklist` 自查八条），由 `dispatch_task` 在 L 档输出的「方案文档」段直出。

**跨文件互验（`data.js` 装载期一次做全，任一条对不上即加载失败）**：形态的 `gate` ∈ 门名词表；
档位门列指向的形态必须存在且 `gate` 与列名一致；「语义域」触发行必须带 `form=安全专项`；三档
齐全；`taskBook=true` 的档位必须至少配一道证伪门、免任务书的档位不得配门；只有 diff 超阈行
能带 `threshold` 且恰好一条；`lifecycle.requires` 的每个字段都必须是 task/challenge 参数面
认识的字段；`ASSEMBLER_CONTRACTS`（工具名→阶段→事件）与 lifecycle 行互认；模板键与
`TEMPLATE_KEYS` 双向相等（多一个键＝没人会读它）；占位符白名单；安全五问单载体；孤儿形态
（没被任何档位行或硬触发行引用）只进 warnings 随输出返回。

**追加面的四事件字段**（一行一事件，字符串单行、数组格写 `[]`、数字缺省写 0，不省略）：

- `start`：`t`／`action`／`batch`／`tier`／`triage`（分诊一行）／`intent`／`subject`（未登记写
  占位 `（待写）`）／`decisions`／`rules`（配对与形态两份原始字节的指纹，复盘分组用）。
- `gate`：`t`／`batch`／`gate`（证伪门｜方案证伪）／`tier`／`segment`（方案｜净 diff）／
  `recommended`（当趟推荐组合）／`forms`（实派形态）／`perFormCounts`（`[{form,count}]`）／
  `adopted`／`rejected`／`overlap`／`missed`／`note`／`rules`。
- `commit`：`t`／`batch`／`commit`（commit 号）／`pushed`（推送结果）／`note`。
- `review`：`t`／`batch`／`retro`（复盘行）／`efficacy`（门效能）／`note`。

**旧事件兼容读**：v1 的 `advance` 事件按 stage 名归一（门一／方案→方案证伪、门二→证伪门、
提交／复盘各归一），归一后标 `legacy`。有 `start` 的旧批照常展示与计算（标「旧事件」），但门禁
硬判跳过 legacy；仅 `advance`、没有 `start` 的历史批不进单批 `status`（会提示先立项），只出现在
`list`／全量 `status` 的历史行里——它们没有分诊档位，按 v2 门禁判只会永远差一道门。读侧可选
字段缺失＝零值；坏行由读面带行号报错，不静默跳过。

**review 事件的双重身份**：它既是那批的收尾，也是 `dispatch_lessons` 的全仓销账点——增量统计从
最近一条 review 之后算；无 review 时按全量算（首次复盘前的兼容面）。唯一例外是长期零 findings
的降级线索跨全量台账累积（销账点只销「裁决待办」不销证据）。

**改规则＝改 JSON，下一次调用即生效，不发版不重启**；需要重启的只有代码改动（宿主按模块代缓存）。
v2 的参数面**不再用 schema `enum`**：档位/门名/形态 id 的词表校验在 execute 与 core 里做，报错带
合法值清单——词表随数据面现读，不会出现「注册期快照与盘面不一致」那一层。

## 两件工具的输出怎么消费（批量派发）

委派形态的固定口径（用户拍板，规则不外置到 memory 或批清单）：**复核固定走 workflow**——briefs
喂 `parallel` 攒齐一次返回；**施工与修正轮走独立 subagent**——单批单 agent，回报可针对性追问。
两件工具的输出都自带派发参数（单一真相源在工具输出，本节留完整版与实测坑）。

`dispatch_task` 的结构化值里 `workflowArgs`＝`{label, prompt}`，`prompt` 就是任务书全文；文本视图
里有一段「派发参数」JSON，可直接粘进 subagent 调用。S 档免任务书时 `prompt` 换成自验口径（贴
现存断言命令＋退出码），S 档升 M 的唯一触发就是贴不出这一条。

`dispatch_challenge` 的结构化值里 `briefs` 是 `[{form, text}]`（每路形态名＋完整 brief），
`workflowArgs` 是 `[{label, prompt}]`，可直接喂给 workflow 的 `agent()` 并行跑多路复核：

```js
  const briefs = args.briefs; // 从本工具结构化值把 briefs 数组转抄进 workflow 调用的 args
  const results = await parallel(briefs.map(b => async () => {
    const out = await agent(b.text, { label: b.form /* provider/model 显式指派，按你的派发纪律；可加 schema 收结构化 findings */ });
    return out === null ? { form: b.form, ok: false, error: "agent 返回 null（子代理未正常收尾）" } : { form: b.form, ok: true, out };
  }));
```

判活看 out 是否为 null——agent 失败是返回 null 不是抛错；聚合后按 ok 分流，失败路收进
`failed_routes` 别静默丢。施工单与修正轮不走此路：独立 subagent 后台派发（run_in_background），
派完结束回合等完工通知；修正轮优先 send_message 回原施工者续聊。

三个坑（实测踩过）：①workflow 返回值严格 JSON 校验——成功分支不要带 `error: undefined` 这类
字段，整趟直接拒；②`agent()` 失败返回 `null` 不抛——判活看 `out`，骨架已内联处理；③`briefs`
在输出值（value）里不在 render 文本里，转抄进脚本 `args` 是手工步骤。

## dispatch_batch 批次台账

一个批次的一生记成一行一事件的 JSONL，默认落在**store 下的 `data/dispatch-ledger.jsonl`**：
Config 的 `dispatchLedgerPath` 显式路径优先，空串按 `memoryRoot` 推导（与 memory 写侧共用同一份
「记忆根 → store」归一）。store 在两台机器上都落在 agent-data 仓里，`agent-data/.gitattributes`
给这一行配 `merge=union`：两台同时追加的行都保留、零文本冲突，行序非时间序由集合式推导吸收
（展示按事件时间 `t` 排序）。跨机并发 `start` 各登各自合法，合并后出现双 `start` 是正常吸收态：
`status` 出告警，不当事故。

四个 action：`commit` 记提交（commit 号＋推送结果，**提交前先 status 查门禁**）、`review` 记复盘
（复盘行＋门效能，同时是销账点）、`status` 查单批门禁或列在飞批次、`list` 列全量。**状态永远从
事件现推**，不存状态文件、不另设缓存。台账只追加：`dispatch_task` 出稿自动落 start（同批已登记
就不重复写），`dispatch_challenge` 裁决时落 gate，`dispatch_batch` 只补 commit/review 两句。

`dispatch_challenge` 传 `batch=` 时，档位／分诊行／意图／拍板清单从 start 回填；显式传参优先，
与台账说岔即报错（`subject` 例外：证伪门的对象是净 diff 命令，只认显式传值）。台账里出现坏行时
`status`/`list` 带行号报错。

返回值：给批次名的那一趟连事件一起回（单批有界）；`list` 与不给批次名的 `status` 只带一批一行的
`rows` 摘要与 `text`（一百分批的 events 是几百 KB 的上下文垃圾）。展示文本在 execute 那一趟算好
放进值的 `text`，render 只投影它（渲染是同步纯投影，宿主深拷贝冻结后才交 render）。

写侧前提与 memory 写工具同一条（口径见「memory 与 dispatch 写侧的文件策略边界」节）：台账落在
store 下的 `data/`，与记忆同仓同围栏，不是这个工具多要的一份权限。

## 安装（本地仓直装）

```text
plugin_manager install_bundle /home/nvse/code/repos/dsh-toolbox
```

然后重启 dsh web（宿主模块代缓存：替换/装卸已装包不换模块代，必须重启才激活）。

## 验收口径

- 单测：`npm test`（node --test；三类面：零宿主依赖层（纯函数直测＋node 适配器的
  真 I/O，跑在临时目录上）、端口宿主适配器的**替身**（`ctx.fs` 替身，不是宿主
  通道）、接线静态解析）。
- 记忆注入块：`npm run check:memory -- <记忆根> <机器id>`——机器 id 决定「本机段」是哪一段，
  与 Config 的 `machine` 同形同值域。**两参必须带全**：未给机器 id 而 `machines/` 下已有带
  条目的机器段时判红（本次只装共享段、本机段整段缺失，是空跑而不是全绿）；给了机器 id 而
  `machines/<id>/` 不存在也判红（配了机器名却没有私有目录——先做条目迁移，见
  `agent-data-sync.md` 的「记忆仓直连」节）。只有共享段的记忆根（还没分机器段）未给第二个
  实参不算错，命令末尾会提示未给机器 id。家机正确形态：
  `npm run check:memory -- D:\code\agent-data home`
  （扫 store 顶层与 `machines/<id>/` 两段，按注入侧同一份判定验预算、frontmatter 契约、
  段内 title 重名与条目内 ## 节重名；接参 `[记忆根] [机器id]`；覆盖项见命令末尾自报名单）。
- 老布局条目迁移：`node scripts/migrate-frontmatter.mjs <记忆根>` 默认 dry-run，逐条打印
  将要做什么（含「这批文件会把 CRLF 行尾整篇归一为 LF」）；确认后加 `--apply` 才落盘。脚本
  可反复跑（已合规条目不动）；单仓化后全部记忆都在 agent-data 仓里，改写与删除都进 git，
  要回退走版本控制，脚本不再自己另存备份。
- 识图质量端到端：合成四考区图（如 /tmp/vision_probe_q4.png）＋大字 OCR，
  答案与图吻合才留——不测易分辨的图，测「像素真喂进去了」。

## 结构（深模块口径）

```text
lib/index.js            胶水：FEATURES 表逐工具 try/catch 注册，configShape 并集
lib/paths.js            跨工具族的路径原语（目前只有 ~ 展开）。落 lib 根是因为记忆根与附件存区两条来路都要它，而它是文件系统约定不是记忆约定——留在 lib/memory/ 就越了那层自述的界
lib/value.js            跨工具族的值判据原语（isNonBlankString：非空白的字符串才算「给了」）。落 lib 根同理由：Config 回退、脚本入参判定、宿主注入的路径校验问的是同一个问题
lib/working-dir.js      会话活目录的取用收口（工具执行与注入两条路径读同一处 session.header.cwd，理由见文件内注释）。落 lib 根因为两个工具族都要它
lib/fs-port.js           包级 fs 端口：宿主 ctx.fs 与 node:fs 收敛成同一组方法，写侧 I/O 的唯一通道（memory 与 dispatch 共用这一份）。落 lib 根因为第二个工具族也要它——留在 lib/memory/ 就是 memory 私产，另一族 import 它等于跨族借私产
lib/fs-guard.js          文件系统守卫与错误码词表（写侧路径共用一份，零 node:fs——并进端口会把直连拖进写侧模块的本地导入闭包，「写侧 I/O 只经端口」当场失效）
lib/tool-schema.js       工具 schema 的共用形状工厂（stringList／objectShape，三族工具的输出 schema 共用）。object 节点默认闭集、每次返回新对象、假值入参当场拒；「形状写一份」是宿主要求（object 节点缺 additionalProperties 整件工具注册失败，症状是工具从上下文里消失而不是某字段被拒）
lib/head-read.js         分块头读（开句柄/分块/累积/末尾解码），端口适配器与读侧共用一份——曾有两份拷贝连块大小都分家，漂起来的症状是「某些条目读不到头」这种没法定位的偶发
lib/param-guard.js       execute 入参守卫（未知键点名＋折叠归一＋退役别名表，零 node:fs、零依赖）。落 lib 根因为它是「工具入参形状」的守门人而不是 memory 的私产，批3 的四件 dispatch 工具复用同一份机械
lib/memory-root.js       记忆根默认值与归一、根 → store 落点、store 下数据域落点、错误文案归一（零 node:fs）。落 lib 根因为要它的不止 memory 一族：dispatch 族的台账、使用日志与离线自检脚本要的是「这个根归一成什么样」而不是「记忆怎么装配」，留在 memory/ 等于把整个 memory 族的 I/O 拖进它们；上移之后本模块只承诺「根、store、store 下的数据域」，谁要谁向下指
lib/memory/             记忆注入与自检：index.js 装配（只注册注入，无工具）+ core/frontmatter/patterns/naming/assemble/segments 纯模块（写侧 write/delete/lint/params 已随工具退役删除）。逐文件谁直连 node:fs 见 test/imports.test.js 的判定表，别照抄本文档的枚举
lib/see-image/          识图工具：index.js 装配（零直连）+ route.js（识图路由现读内缝：volatile 句柄取值＋空白回落出厂路由，零直连）+ vision.js（嗅探/终态映射，直连 node:fs）
lib/usage-log/          使用日志与手记工具：recorder.js（订阅 tools/execute＋tools/result 旁路落 store 下 data/usage-log/ 的按天按机器分片 jsonl——成功行瘦（参数键集＋耗时）、失败行胖（args 摘要＋error），写入与注册时按 14 天窗口轮转（只删已提交到 HEAD 的档）；白名单由胶水从 FEATURES 现读传入，直连 node:fs——同步 append 单行＋写前递归建目录，整体 try/catch 只 warn）+ note.js（usage_note 工具＝手记口子，零直连）
lib/client.js           浏览器半：插件页里的「识图路由」卡片（注册 plugins.bundle.config 槽，选路由保存即生效）。经典脚本形态——宿主按静态模块表收走、JSX 与构建都不在场
lib/dispatch/           跑批工作流 v2 四件工具（两件装配＋台账＋复盘）：index.js 装配（零直连）+ vocab.js（档位/门名/阶段词表单源，零依赖）+ core.js（分诊/任务书/证伪门 brief 组装与渲染纯函数）+ parameters.js（task/challenge/batch 参数面，零直连）+ batch.js（四事件构造/集合式推导/台账读写/回填/展示文本，经包级 fs 端口，零直连）+ lessons.js（跨批统计/点位判定/建议草稿/展示文本，经同一 fs 端口，零直连）+ data.js（现读五份数据 JSON 并验形状与跨文件互验，直连 node:fs）＋ data/（3 形态／3 档位＋3 硬触发／六键模板／四阶段表／八节方案规范）
test/                   node:test 单测（纯函数直测＋端口宿主适配器替身＋共享原语直测＋接线静态解析）
scripts/                checks.mjs：注入块自检的检查项数组与现场采集（可单测）；check-memory-index.mjs：跑上面那份数组的薄壳，末尾自报覆盖清单，不依赖宿主启动；migrate-frontmatter.mjs：老布局条目迁到 frontmatter 两键（默认 dry-run，`--apply` 才落盘）
```

每工具目录的模块接口只有两件：`register(ctx, config)` 与 `configShape`（dispatch 目录那一族
两件装配＋台账＋复盘，故导出 `registerDispatchTask`/`registerDispatchChallenge`/`registerDispatchBatch`/
`registerDispatchLessons` 四个注册函数、共用一张 `configShape`——胶水的 FEATURES 表按工具逐条
try/catch，一件起不来不连坐另一件）。
纯函数文件零宿主依赖，可直接单测；含宿主 import 的装配文件由 test/imports.test.js
静态解析钉住接线（防搬家断链、防 inject 漏声明）。

MIT
