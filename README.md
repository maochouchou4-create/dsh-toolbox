# dsh-toolbox

自用工具箱插件：把「本机有用的工具」按深模块结构装进一个包，逐工具隔离注册——
单个工具初始化失败只丢那一件，不连坐整包。当前五件：

- **memory**：单仓记忆读写（store 顶层＝两机共享条目，`machines/<机器名>/`＝本机私有条目），
  `write/edit/delete/lint` 四动作。`write` 收可选 `scope`（缺省＝本机段，未配机器名时＝共享段）；
  `edit`/`delete` 只认 `file_path`：裸名（共享段与本机段范围内唯一命中）或
  `machines/<机器名>/<文件名>` 全形式——跨机帮写帮改走全形式，对机 pull 后生效。
  edit 按节锚定：`heading`（条目内唯一的 `##` 标题）定位＋`body` 整段替换，
  frontmatter 两键走 `title`/`description`；参数名与宿主自家编辑工具对齐（`file_path`）。
  附会话 systemPrompt 索引注入（`memory:index`，order 200），分「共享（跨机同步）」与
  「本机（<机器名>）」两段。索引行由条目
  frontmatter（恰好 `title`＋`description` 两键）现场派生，不落盘、不手写。
- **see_image**：把图片交给视觉模型转述成文字（先逐字转写可见文字，再按图型
  结构化描述），兜「图在磁盘上但当前会话模型看不见像素」的场景。两个入口：
  `path`（磁盘文件）与 `attachment`（会话占位符 hex，见下节）。
- **dispatch_plan / dispatch_review / dispatch_build / dispatch_verify**：派发装配器一拆四，
  各服务一个固定阶段（方案／门一／施工／门二；老 `dispatch` 的 `stage` 参数随拆分退役，选对
  工具即可）。按批型查出该派哪些复核形态、给每路拼出可直接粘贴的 brief（角色句＋必读链＋
  横切判据＋上报格式）、节奏提示与自检/裁决固定段；`dispatch_plan` 出方案任务书（十三节规范
  骨架＋定稿自查），`dispatch_build` 收锚点与根因分类。两个可选规模参数
  `diffLines`/`changedFiles` 喂节奏谓词：小规模时额外出那条「建议直修不派复核」的提示
  （提示层，不阻断出稿）。规则面是数据不是代码，见下节。
- **dispatch_batch**：批次台账。按 `start`/`advance`/`status`/`list` 把一个批次的
  一生记成结构化事件，状态从事件现推；装配四件传 `batch=` 即从台账回填该批的批型、意图、对象与
  拍板清单（只填这一趟真正消费的那几格，显式传参优先、与台账说岔了即报错）。见下节。
- **dispatch_lessons**：复盘辅助。读台账找上次复盘之后的增量批（复盘事件＝全仓销账点；无复盘
  事件时按全量算），按点位（攒 5–8 批覆盖 ≥3 批型）判断
  是不是到了复盘点（这三档阈值的单源是 `lifecycle.json` 复盘行的 `point` 字段，这里是它的
  快照）；到了出配对规则的**修订建议草稿**——只出建议给主会话裁决，
  **不自动改配对表、不落盘**（装配层只把端口的读方法传给它，写方法不在那个对象上，见下节）。

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

索引块每轮上下文都装一份，所以它有四重预算，全在 `lib/memory/core.js` 声明：段内索引的
**行数与字符数**、单条派生行的**字符数**，以及**注入块整块的字符数**（含写侧纪律
`WRITING.md`）。前三重由注入时逐段施加，越线截断并带显式标注（不静默丢）；整块这一重
**运行期不截**——截整块会连写侧纪律一起截掉，规则被静默丢掉比超预算更难查，所以它只判红，
由 `npm run check:memory` 离线做。数值别照抄本文档里的，那条命令会打印当前定档与实测。
`memory` 工具的 `lint` 与它逐条报病灶。整块那一重的线按「**还能装几条新条目**」换算（用
实测的条目派生行均长），不按百分比——百分比定的线在语料一变就名不副名。运行期关于「索引
没装全」只有一个信号：某一段真被截断时块尾多一行「本次注入有 N 段索引超预算已截断」，报出
段数、段名与切在哪一重；一段都没截断时那行不出现。

索引不是数据：条目文件是唯一事实源，注入时按文件名排序扫目录、用
`frontmatter.title`＋`description` 重建每一行。组装入口 `composeMemory` 有一层**进程内缓存**，
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
首调即满算，不吃陈旧值。因此
**没有索引文件**，`write`/`edit` 也不碰索引；`delete` 只删条目文件，它那一行随文件消失。
frontmatter 出现第三键（如与文件名重复的 `name:`）直接抛错——两键之外没有消费者的字段
就是死字段；两键的值按字面取、不解析 YAML，引号会原样进索引行。派生行以 title 为准，
故段内同名条目会被写侧拦下（改 frontmatter 的 title 键，用 `edit` 的 `title` 参数）；写侧那道拦截只在
进程内拦得住自己，而共享段是跨机 git 同步语料——两台机器各自干净、合流后重名照样进索引，
所以 `lint` 也会点名同段撞名的条目。**写侧报错**＝你正要写的那条与另一条撞名了，
**体检 warning**＝盘上已经存在撞名对；两种口径处置同向，都不是 `delete`——撞上的每一
条都是各自带正文的现存条目（title 与文件名本就是两回事），要改的是那一组里的某一条。
edit 按节锚定的锚点是条目内唯一的 `##` 标题：未命中时报错列出全部节标题，重名节（`lint`
同报）在收敛前写不进——按节锚定消的是「逐字复述正文必漂」那类失败，不是再加一道门槛。
同段某条目 frontmatter 不合规时同名
判定不可信，写侧直接报错而不是放行，并列出段内全部不合规条目。**拦的只是别的条目**：
不合规的那条本身被扫描跳过，段内只有它一条时可以用 `write` 以修好 frontmatter 的全文
重写它（同名扫描把待写这条排除在外；`edit` 的按键编辑只改现存键行，补不出缺失的键）；
两条以上时重写任一条都会被另一条挡住，须先 `delete` 掉多余的，剩最后一条再 `write`
重写。修好之后该段立即恢复。

`edit`/`delete` 的裸名寻址按「共享段＋本机段」这个范围解析：唯一命中即动手，两段都有同名
条目则报错并列出候选，要跨机或消歧就用全形式。`scope` 只有 `write` 消费——`edit`/`delete`
收到它即报错，寻址一律走 `file_path`（同一个位置两种表述迟早说岔）。

## memory 与 dispatch 写侧的文件策略边界

memory 的写入走宿主自己的 fs 通道，因此受会话文件策略围栏；记忆根在哪决定它拦不拦——
记忆根在工作区之外时，写记忆才要求 `danger-full-access`（围栏范围是会话 cwd，
`workspace-write` 覆盖不到它）；两机现配置的记忆根都是 agent-data 仓，落在各自常用
工作区之内，所以常规会话里写记忆不受围栏影响。delete 与 lint 两族因宿主 fs 契约没有
删除能力而留在 node:fs，不受该围栏约束，但 delete 同样受只读策略前检（只读会话
一律拒写）。

`dispatch_batch` 的写侧同通道同前置：台账落在 store 下的 `data/` 里（＝agent-data 仓的
`memory/data/`）。它与记忆同处一仓、同在常用工作区之内，所以记账的门槛与写记忆完全一样
——记忆根出了工作区的会话里两者一起被拒，不是这个工具多要的一份权限。`dispatch_lessons`
只读台账，不受这条约束——装配层传给它的端口上压根没有写方法
（`fs-port.js` 的只读门面），边界是结构性的而不是靠记着别写。

## see_image 通道说明

走**宿主自己的 llm 通道**（不自带 HTTP、不存任何 key）：默认
`zai-coding-cn/glm-5.3-flash`（免费档；zai 适配层在该模型上自动关思考，见
pi-ai openai-completions 的 zai thinking 映射）。换路由＝profile 层覆盖配置，
例（真实存在的路由 id，本机 profile 声明过）：

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

## dispatch 数据资产（三面结构）

`dispatch` 族的规则与数据不在代码里，按**读取时机**分三面：

| 面 | 载体 | 什么时候被读 | 改它要不要重启 |
|---|---|---|---|
| 常驻召回面 | 六个工具的 `description`（装配四件＋`dispatch_batch`/`dispatch_lessons`） | 每个请求都随工具清单进上下文 | 要（改描述＝改代码） |
| 现读面 | `lib/dispatch/data/` 下五份 JSON（每次调用经 node:fs 现读） | 每次工具调用 | 不要，改 JSON 下次调用即生效（例外：参数面的 `enum` 是注册期快照，新增合法值要重启才进词表，见下节） |
| 追加面 | 台账 `memory/data/dispatch-ledger.jsonl`（两机 git 共享，`merge=union`） | `dispatch_batch` 写、装配四件与 `dispatch_lessons` 读 | 不要 |

现读面五份：

- `forms.json`：22 形态（`id`/`gate`/`catches`/`role`，部分形态带 `extras` 三件套）
  与 `rejected`（不做清单）。形态 id 全集在这里，别的文件按它校验。`role` 逐字落在那一路 brief
  的首句——子代理按这条念法干活，消融实证里去掉角色设定，复核质量掉得最狠。
- `pairing.json`：批型→各门形态组合的对照＝本文件各行（batchType 行的 `gate1`/`gate2` 列即该批型
  两道门的组合）——装配四件描述里那句「对照表唯一出处＝本节」落的就是这里。`rows` 11 条批型配对行（主行／`kind:addon` 加挂行／`kind:special`
  特殊行，后者用 `needsBase`/`needsRootCause` 表达批型条件必填）＋`rhythm` 12 条节奏谓词：
  `when` 的每个字段都要命中才输出该 `note`，取值两形，形态按字段类别守门——枚举字段
  （`batchType`/`stage`/`provider`）收字符串数组（本次参数值 ∈ 数组），规模字段
  （`diffLines`/`changedFiles`）收 `{max:N}`（本次参数 ≤ N，`diffLines=5` 那种边界含在内，
  `max` 须非负整数，缺参不命中）。两类写反当场报错：那种写法能加载通过又永不命中，是静默失效
  而不是坏数据。**混合批取各成分的组合**：改动形状混合时每个成分批型的配对行都该命中、行间取
  并集，而 `batchType` 是单值只收一个主行，其余成分经 `addons` 加挂后与主行并集去重（只有
  `kind:addon` 行能加挂，特殊行另经 `baseBatchType`）——参数面表达不全的口径落在这里。
  **加挂行并非每道门都可用**：`大工程方案` 只有门一那一列（`gate2` 写 null），`涉鉴权/上传/输入`
  两门都有——以配对表各行的 `gate1`/`gate2` 列为准，加挂本身不保证那道门得出这一路。
- `templates.json`：九键——门一/施工/修复批增量/方案任务书/AGENTS 必读链·复核/
  AGENTS 必读链·施工/横切判据/checklist/裁决。门二那行 `templateKey` 指向门一，故模板表
  里没有第二份逐字同文（将来两门要分叉＝改回自键＋补一份模板）。两张必读链辅助页分成复核
  版与施工版：复核那版带「只读禁写」，施工那版不带（施工者要动工）。模板里的 `〔…〕` 占位
  带各自的省略规则（空则整行省略）。
- `lifecycle.json`：`stages` 阶段表（`id`/`order`/`gate`/`kind`/`templateKey`（可缺省，
  缺省＝stage id）/`requires`（必填·stage 级必填矩阵的单源）/`uses`（必填）/`point`（可缺省，
  只有复盘那行有：`minBatches`/`minBatchTypes`/`upperBatches`））——阶段词表、模板键、stage 级
  必填参数与**复盘点位判据**的单源，core 与 dispatch_lessons 现算；加阶段、改阈值＝改这份 JSON。
  `gate` 是「这一行是门阶段」的第二处表述：判组合出不出走的是 `kind`，这一列由 `dispatch_batch`
  的门禁推导读，加载期只对本工具出稿的四行互验 `gate` 等于「kind 是复核」——提交/复盘两行不由
  本工具出稿，它们的门别语义归各自的工具。**阶段推进与门禁不在这份表里**——它归事件集合：
  `dispatch_batch status` 按台账已记到的最远阶段往后推出下一段，并把该批型（含特殊行按
  `baseBatchType` 落回原批型）判得上的门列逐条报成「门禁未过」；常见的那条链就是方案文档在盘
  → 门一 → 施工 → 门二 → 提交。
- `plan-spec.json`：`blocks` 十三节方案规范正文＋`checklist` 定稿自查 11 条——`dispatch_plan`
  那一趟装配「方案任务书」的正文与清单尾。11 条＝剪切 8 条＋新增 3 条（术语只定义一次／判据
  两列齐／读我层不夹带用户没拍过的新决策），来源＝规范「拍板方可读性」节。

**追加面的台账事件字段**（台账一行一事件，字段与 `dispatch_batch` 的 `start`/`advance` 参数
一字同源，`rules` 由工具自动记）：两种事件各有 `t`（ISO-8601 带显式时区偏移）、`batch`、
`action`（`start|advance`）、`rules`；`start` 再带 `batchType`、`baseBatchType`（缺原批型写空串）、
`intent`、`subject`（缺省写空串）、`decisions`（缺省写空数组）；`advance` 再带 `stage`、`combo`、
`recommended`（当趟推荐组合 id 列表，未裁剪＝`combo`）、`perFormCounts`（`[{form, count}]` 数组——
形态 id＋该形态 findings 数；旧事件的「形态 id → 数」对象形状读侧归一兼容）、
`adopted`、`overlap`、`missed`、`note`——后八项的数字与短串缺省即写 0／空串（数组格写 `[]`），不省略。
**读法钉死：`fold` 与复盘读事件时，可选字段缺失＝零值**（数字缺失作 0、字符串作 ''、数组作 []、
对象作 {}），与写侧「0 写 0」的口径对称，历史事件不必补写；坏行由读面带行号报错，不按缺字段
静默放过。

**复盘事件的双重身份**：advance stage=复盘 的事件除了收尾那批的生命周期一格，还是 dispatch_lessons 的
全仓销账点——复盘辅助统计增量批（存在晚于销账点事件的批，批粒度：跨点活跃批整批重看），点位判据与
建议草稿都从增量出；唯一例外是长期零 findings 的降级线索跨全量台账累积（销账点只销「裁决待办」不销
证据）。台账没有复盘事件时按全量统计（首次复盘前的兼容面）。

**改规则＝改 JSON，下一次调用即生效，不发版不重启；需要重启的只有代码改动**（本仓被
宿主按模块代缓存）——外加一处例外：参数面的 `enum` 是注册期快照（工具定义定型那一刻冻结），
新增的合法值要重启才进词表，而调用侧立刻认新值；那半句见下节「enum 参数面」一节。装载时形状与双向引用一并校验：坏 JSON、形状不合、配对指向未定义
形态，一律带文件名（与字段路径）报错不静默出稿；阶段表另核一批互验（id/order 唯一、order 正
整数、kind 落在词表内、复核阶段的门别可反查、gate 与 kind 等价、requires 无重复且在参数名全集内、
uses 声明与模板占位互为充要，装配四件的契约阶段行与 kind=提交 那行各与代码里的常量互认——逐条清单见
`data.js` 的装载期校验段，硬计数写在文档里只会与代码分家）；模板键的双向核＝白名单（lifecycle
各行的 templateKey 加那几张辅助页，多出来的键没有任何阶段会读到它）＋反向（某行显式指了
templateKey 却没有那份模板＝拼错键名与忘了写模板长得一样，加载期就分不开）；两张必读链辅助页
除分工那一句外须整篇逐字相同，而分工句的方向与次数也核（写反＝施工那一路拿到一条做不到的只读
约束，写重＝那句连同整行从比对里消失，原先那道整篇比对正好瞎在这一处）；阶段表里恰有一行
kind=提交（少了则记到收尾的批次永远算在飞，多了则提交这一步能被推到没有下一行的 order）；
节奏谓词按字段类别守形态（枚举字段收数组、规模字段收非负整数的 `{max:N}`，写反当场报错），
`stage`／`batchType` 的取值再对着可达词表核，且两个在字段的交集非空（谓词值各自合法但永不相交
＝那条规则永不命中）；安全五问按载体点名——那两个 id（安全专项／安全清单行）必须在 forms 里且
两端锚点齐全，带锚的第三个形态（＝第三种念法）当场报错；两个载体各自锚点只出现一次、两段核心串
逐字同形（前缀框定语有意不同，中间那串五问本体不是）。反方向（定义了却
没有任何配对行引用＝孤儿形态）只进 warnings 随输出返回——`设计七维`/`证伪复核` 是刻意留着
的预期孤儿，来由写在各自形态的 `notes` 字段里。改规则的改动走本仓 git，两机各自 pull。

**why 随消费点走**：判断理由跟着会读到它的那一面走——模型读得到的进活字段（形态的 `notes`
点明预期例外，如上面那两个孤儿形态；`formNotes` 是行×形态的批型限定句），只对代码自身成立的
机制理由进代码注释（注释只写 why），需要人读的整体口径进本节。同一句理由在三类去处各摆一份
就成了三份拷贝，改一处忘另两处必漂。写了没人读的字段一律不摆——摆着只会让人以为它在起作用。
「恒缺席」那一层不归文档管：可缺省只保证写回去也装得上，写回盘上要由 dispatch-data 的用例对着
真盘面反钉（红的时候自问「它有消费者吗」）。追加面见下节。

## 装配四件的 workflow 消费（批量派发）

`dispatch_verify`（门二）输出的结构化值里有 `briefs` 数组（每路 `{form, text}`——形态名＋完整 brief 文本），可直接喂给 workflow 工具的 `agent()` 并行跑多路复核，替代逐路 subagent 手工派发。脚本骨架：

```js
const briefs = args.briefs;                    // 从 dispatch_verify 输出值转抄 briefs 数组
const results = await parallel(briefs.map(b => async () => {
  try {
    return { form: b.form, ok: true, out: await agent(b.text, {
      label: b.form, provider: '…', model: '…',   // 显式指派，走授权路线
      schema: { /* findings 结构化校验 */ }
    }) };
  } catch (e) { return { form: b.form, ok: false, error: String(e) }; }
}));
```

三个坑（实测踩过）：①workflow 返回值严格 JSON 校验——成功分支不要带 `error: undefined` 这类字段，整趟直接拒；②`parallel` 里 throwing thunk 解析为 `null`——先 filter 再取字段，失败路单独收进「failed_routes」保住「各路成功失败分开可查」；③`briefs` 在输出值（value）里不在 render 文本里，转抄进脚本 `args` 是手工步骤。首单实测（2026-10，批 G）：双路并行 270s、零失败、结构化 findings 20 条（含对已过双路门二对象的第三轮增量 8 处）——报告见当批实施方案目录。

## 装配四件的 enum 参数面：注册期快照与运行期现读是两速

装配四件与两件台账工具里有词表取值的参数，除描述里那份词表外还带着 schema 的 `enum`
（宿主 `defineTool` 在 execute 之前按它逐值校验，不过就抛 `ToolArgsError` 并把合法值清单带出来）。
装配四件的 `batchType` 取 `mainBatchTypes`（配对表主行行名，含带 `needsBase`/`needsRootCause`
的特殊行；**addon 行不作 batchType**，只能经 `addons` 参数加挂）——`stage` 不在参数面上，
一拆四后阶段是各件的内部常量；台账两件的 `stage` 取全量阶段词表（它的 `advance` 要把提交与
复盘记进台账，而那两步是生命周期里正当的一步）、`batchType` 同款取 `mainBatchTypes`；
台账的 `perFormCounts`/`combo`/`recommended` 条目里的形态 id 也带 enum，取 forms.json 现读。

**两速的含义**：注册期工具定义定型，参数面（含 `enum`）就在那一刻冻结成一份快照；而 execute
每次调用现读数据。所以运行中往 `lifecycle.json`/`pairing.json` 加一个新阶段或新批型时——
**调用立刻认它**（那一趟的判定与出稿都按新值走），但新值要等**重启宿主**才进 enum 词表，
在那之前传它会被参数校验按「不在词表内」挡下。这是宿主「参数面注册期冻结」这一层架构的使然，
不是缺陷：想要合法值立刻进词表，重启即可（改 JSON 本身不用重启，两速说的就是这一层差别）。
描述那份词表不受此限——它随注册期那份定义走，与 enum 同速。单测里各件的 enum 都逐字对着
`dispatchStages`/`stageVocabulary`/`mainBatchTypes`/forms 现读结果核（注册快照 ≡ 当刻盘面）。

加阶段时连带要动的不止 lifecycle.json：新阶段还得在 `templates.json` 里有模板（键＝stage id 或
该行的 `templateKey`），否则加载期的模板键双向核当场拦下（显式指了键却没有那份模板＝拼错键名与
忘了写模板长得一样，分不开）。

**复盘修订配对的入口＝`dispatch_lessons`**：它读台账找上次复盘之后的增量批（销账点语义见
「追加面的台账事件字段」节），按点位（攒 5–8 批
覆盖 ≥3 批型，判据单源＝`lifecycle.json` 复盘行的 `point` 字段）判断该不该复，到了出草稿——
各形态 findings 数、组合采纳率（分母＝事件 `recommended` 逐事件求和且按集合去重，事件没自存
推荐时输出注明不可算）、推荐与实派的差（裁剪/加派记录）、修复轮数收敛（从门二事件数推导）、
双报重叠的捕获-再捕获估算（两路有交集且交集不大于次大那路才成立）、漏网清单，后两条按批型
聚合成一两条并报「另有 M 条」而不是逐事件铺开；增量统计面按事件里的规则版本分组报（不跨版本
平均；唯一例外是长期零 findings 降级线索跨全量累积、不分组），同一份台账两次读出逐字相同（行序
不依赖事件先后与时间戳并列）。统计分组这件事本身
也是 rules 字段存在的唯一理由。`force=true` 跳过点位判断直接出草稿。**它只读**：装配层传给它
的是只读端口（写方法不在那个对象上），建议给主会话裁决，改配对表是主会话的动作。

## dispatch_batch 批次台账

一个批次的一生记成一行一事件的 JSONL，默认落在**store 下的
`data/dispatch-ledger.jsonl`**：Config 的 `dispatchLedgerPath` 显式路径优先，空串按
`memoryRoot` 推导，与 memory 写侧共用同一份「记忆根 → store」归一（`~` 展开、绝对化都走
那一处）。store 在两台机器上都落在 agent-data 仓里，台账跟着它走才叫两机共享——
`agent-data/.gitattributes` 给这一行配 `merge=union`：两台同时追加的行都保留、零文本冲突，
行序非时间序由集合式推导吸收（展示按事件时间 `t` 排序）。跨机并发 `start` 各登各自合法，
合并后出现双 `start` 是正常吸收态：`status` 取 `t` 最小的一条并出告警，不当事故。

四个 action：`start` 登记批次（拍板清单随这次登记进台账，此后装配四件传 `batch=` 自动
带出）、`advance` 记一次阶段完成、`status` 查门禁（不给批次＝列在飞批次及各自下一道
未过门）、`list` 列全量。**状态永远从事件现推**，不存状态文件、不另设缓存——台账是唯一真相，
另存一份就是两份真相，且跨机合并出的乱序行会让「按行序累加出来的状态」漂。

`start` 是唯一的自举入口：台账与其目录都不存在时由它建出来，其余 action 遇台账缺失一律显式
报错「批次未登记（先 start）」，不静默建。写入经包级 fs 端口（与 memory 写侧同一条通道：
会话文件策略、原子发布与版本守卫都在那一层），追加时先给末行补一个换行再拼一行 JSON——
两行 JSON 直接相邻会长成一行不可解析的内容。写前拿的是旧版本就报版本失配（并发写不整篇
覆盖别人的行）。台账里出现坏行时 `status`/`list` 带行号报错，不静默跳过一行继续出稿。

写侧前提与 memory 写工具同一条（口径见「memory 与 dispatch 写侧的文件策略边界」节）：
台账落在 store 下的 `data/`，与记忆同仓同围栏，不是这个工具多要的一份权限。

返回值分两种：给批次名的那一趟连事件一起回（单批有界，程序侧要能自己复算），`list` 与不给
批次名的 `status` 不回事件——一百分批就是几百 KB，那是往上下文里灌垃圾；那两种视图改带一批一行的
`rows` 摘要（批次名/批型/阶段进度/下一步/未过的门/最近事件时间/尾注/该行告警），既是给程序侧的
可直接读的那一份，也是展示文本的唯一来源：展示文本在 execute 那一趟就算好放进值的 `text` 字段，
工具的 render 只投影它。宿主会把结构化值深拷贝冻结后再交给渲染函数，所以渲染里读盘、重跑
查询、按对象身份挂缓存这三条路都不可用（渲染是同步纯投影）；值自带是唯一可靠的通道。多批视图
里「在飞集合」与那批行摘要读的是**同一次折叠**的结果——同一次查询里状态不算两遍。「这道门有没有」看配对表那一列：直做批之类
`gate1: null` 的批型免门一，不会每次都收一条「门一 缺记录」；`needsBase` 的行（修复批、
新功能·形态未定）按 `start` 时登记的 `baseBatchType` 落回那一行的门列判，判得出就不告警。

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
lib/fs-guard.js          文件系统守卫与错误码词表（写侧四条路径共用一份，零 node:fs——并进端口会把直连拖进 write.js 的本地导入闭包，写侧「I/O 只经端口」当场失效）
lib/tool-schema.js       工具 schema 的共用形状工厂（stringList／objectShape，三族工具的输出 schema 共用）。object 节点默认闭集、每次返回新对象、假值入参当场拒；「形状写一份」是宿主要求（object 节点缺 additionalProperties 整件工具注册失败，症状是工具从上下文里消失而不是某字段被拒）
lib/head-read.js         分块头读（开句柄/分块/累积/末尾解码），端口适配器与读侧共用一份——曾有两份拷贝连块大小都分家，漂起来的症状是「某些条目读不到头」这种没法定位的偶发
lib/param-guard.js       execute 入参守卫（未知键点名＋折叠归一＋退役别名表，零 node:fs、零依赖）。落 lib 根因为它是「工具入参形状」的守门人而不是 memory 的私产，批3 的四件 dispatch 工具复用同一份机械
lib/memory-root.js       记忆根默认值与归一、根 → store 落点、错误文案归一（零 node:fs）。落 lib 根因为要它的不止 memory 一族：dispatch 族的台账与离线自检脚本要的是「这个根归一成什么样」而不是「记忆怎么装配」，留在 memory/ 等于把整个 memory 族的 I/O 拖进它们；上移之后本模块只承诺「根与 store」，谁要谁向下指
lib/memory/             记忆工具：index.js 装配 + params.js（工具 parameters 单源表＋退役别名表，enum 引 core.js 的 MEMORY_ACTIONS）+ core/frontmatter/patterns 纯模块 + write/delete/lint/assemble/segments。逐文件谁直连 node:fs 见 test/imports.test.js 的判定表，别照抄本文档的枚举；写侧 write.js 的本地导入闭包零 node:fs 由同文件的闭包断言钉住
lib/see-image/          识图工具：index.js 装配（零直连）+ vision.js（嗅探/终态映射，直连 node:fs）
lib/dispatch/           派发装配四件、批次台账与复盘工具：index.js 装配（零直连）+ core.js（查表/谓词/模板渲染纯函数）+ parameters.js（装配四件与台账两件的参数面，清单现读拼，零直连）+ batch.js（事件构造/集合式推导/台账读写/回填/展示文本，经包级 fs 端口，零直连）+ lessons.js（跨批统计/点位判定/建议草稿/展示文本，复用台账读法、经同一 fs 端口，零直连）+ data.js（现读五份数据 JSON 并验形状与双向引用，直连 node:fs）＋ data/（22 形态／11 配对行＋12 节奏／九键模板／6 阶段表／13 节方案规范）
test/                   node:test 单测（纯函数直测＋端口宿主适配器替身＋共享原语直测＋接线静态解析）
scripts/                checks.mjs：注入块自检的检查项数组与现场采集（可单测）；check-memory-index.mjs：跑上面那份数组的薄壳，末尾自报覆盖清单，不依赖宿主启动；migrate-frontmatter.mjs：老布局条目迁到 frontmatter 两键（默认 dry-run，`--apply` 才落盘）
```

每工具目录的模块接口只有两件：`register(ctx, config)` 与 `configShape`（dispatch 目录那一族
装配六件工具，故导出 `registerDispatchPlan`/`registerDispatchReview`/`registerDispatchBuild`/
`registerDispatchVerify`/`registerDispatchBatch`/`registerDispatchLessons` 六个注册函数、共用一张
`configShape`——胶水的 FEATURES 表按工具逐条 try/catch，一件起不来不连坐另一件；装配四件各由
同一份工厂按契约阶段实例化，老 `registerDispatch` 已随 `stage` 参数一并退役，不留别名）。
纯函数文件零宿主依赖，可直接单测；含宿主 import 的装配文件由 test/imports.test.js
静态解析钉住接线（防搬家断链、防 inject 漏声明）。

MIT
