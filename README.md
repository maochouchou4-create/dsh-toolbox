# dsh-toolbox

自用工具箱插件：把「本机有用的工具」按深模块结构装进一个包，逐工具隔离注册——
单个工具初始化失败只丢那一件，不连坐整包。当前五件：

- **memory**：分层记忆读写（习惯层/工作层，`write/edit/delete/lint` 四动作），
  附会话 systemPrompt 索引注入（`memory:index`，order 200）。索引行由条目
  frontmatter（恰好 `title`＋`description` 两键）现场派生，不落盘、不手写。
- **see_image**：把图片交给视觉模型转述成文字（先逐字转写可见文字，再按图型
  结构化描述），兜「图在磁盘上但当前会话模型看不见像素」的场景。两个入口：
  `path`（磁盘文件）与 `attachment`（会话占位符 hex，见下节）。
- **dispatch**：派发装配器。按批型查出该派哪些复核形态、给每路拼出可直接粘贴的
  brief（角色句＋必读链＋横切判据＋上报格式）、节奏提示与自检/裁决固定段；阶段＝方案时
  出方案任务书（十三节规范骨架＋定稿自查）。两个可选规模参数 `diffLines`/`changedFiles`
  喂节奏谓词：小规模时额外出那条「建议直修不派复核」的提示（提示层，不阻断出稿）。
  规则面是数据不是代码，见下节。
- **dispatch_batch**：批次台账。按 `start`/`advance`/`status`/`list` 把一个批次的
  一生记成结构化事件，状态从事件现推；`dispatch(batch=…)` 从台账回填该批的批型、意图、对象与
  拍板清单（只填这一趟真正消费的那几格，显式传参优先、与台账说岔了即报错）。见下节。
- **dispatch_lessons**：复盘辅助。读台账全量事件，按点位（攒 5–8 批覆盖 ≥3 批型）判断
  是不是到了复盘点（这三档阈值的单源是 `lifecycle.json` 复盘行的 `point` 字段，这里是它的
  快照）；到了出配对规则的**修订建议草稿**——只出建议给主会话裁决，
  **不自动改配对表、不落盘**（装配层只把端口的读方法传给它，写方法不在那个对象上，见下节）。

## memory 的索引与条目契约

索引块每轮上下文都装一份，所以它有四重预算，全在 `lib/memory/core.js` 声明：层内索引的
**行数与字符数**、单条派生行的**字符数**，以及**注入块整块的字符数**（含写侧纪律
`WRITING.md`）。前三重由注入时逐层施加，越线截断并带显式标注（不静默丢）；整块这一重
**运行期不截**——截整块会连写侧纪律一起截掉，规则被静默丢掉比超预算更难查，所以它只判红，
由 `npm run check:memory` 离线做。数值别照抄本文档里的，那条命令会打印当前定档与实测。
`memory` 工具的 `lint` 与它逐条报病灶。

索引不是数据：条目文件是唯一事实源，注入时按文件名排序扫目录、用
`frontmatter.title`＋`description` 重建每一行（读侧不做跨调用缓存，故同长度改写也
立刻可见）。因此
**没有索引文件**，`write`/`edit` 也不碰索引；`delete` 只删条目文件，它那一行随文件消失。
frontmatter 出现第三键（如与文件名重复的 `name:`）直接抛错——两键之外没有消费者的字段
就是死字段；两键的值按字面取、不解析 YAML，引号会原样进索引行。派生行以 title 为准，
故层内同名条目会被写侧拦下（改 frontmatter 的 title 行，用 `edit`）；写侧那道拦截只在
进程内拦得住自己，而习惯层是跨机 git 同步语料——两台机器各自干净、合流后重名照样进索引，
所以 `lint` 也会点名同层撞名的条目。**写侧报错**＝你正要写的那条与另一条撞名了，
**体检 warning**＝盘上已经存在撞名对；两种口径处置同向，都不是 `delete`——撞上的每一
条都是各自带正文的现存条目（title 与文件名本就是两回事），要改的是那一组里的某一条。
同层某条目 frontmatter 不合规时同名
判定不可信，写侧直接报错而不是放行，并列出层内全部不合规条目。**拦的只是别的条目**：
不合规的那条本身被扫描跳过，层内只有它一条时可以用 edit 改它（oldString 先用宿主
read 工具取现文）；两条以上时 edit 改任一条都会被另一条挡住，须先 delete 掉多余的，
剩最后一条再 edit。修好之后该层立即恢复。

## memory 与 dispatch 写侧的文件策略边界

memory 的写入走宿主自己的 fs 通道，因此受会话文件策略围栏；而记忆文件按设计住在
工作目录之外（`~/.dsh/memory`），所以写记忆要求 `danger-full-access`（本 profile 的
`permission-presets.defaultPreset` 即如此）。若把权限切到 `workspace-write`，写记忆
会被宿主判成越界而拒——设计后果，不是故障。delete 与 lint 两族因宿主 fs 契约没有
删除能力而留在 node:fs，不受该围栏约束，但 delete 同样受只读策略前检（只读会话
一律拒写）。

`dispatch_batch` 的写侧同通道同前置：台账落在记忆根的 `data/` 下、同样在工作目录之外，
`workspace-write` 的会话里记账一样会被当场拒——那是同一个前提，不是这个工具多要的一份
权限。`dispatch_lessons` 只读台账，不受这条约束——装配层传给它的端口上压根没有写方法
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
| 常驻召回面 | 三个工具的 `description`（`dispatch`/`dispatch_batch`/`dispatch_lessons`） | 每个请求都随工具清单进上下文 | 要（改描述＝改代码） |
| 现读面 | `lib/dispatch/data/` 下五份 JSON（每次调用经 node:fs 现读） | 每次工具调用 | 不要，改 JSON 下次调用即生效 |
| 追加面 | 台账 `profile-memory/data/dispatch-ledger.jsonl`（两机 git 共享，`merge=union`） | `dispatch_batch` 写、`dispatch`/`dispatch_lessons` 读 | 不要 |

现读面五份：

- `forms.json`：21 形态（`id`/`gate`/`catches`/`role`，部分形态带 `extras` 三件套），
  另有 `principles`（可缺省·只给人读）与 `rejected`（不做清单）。形态 id 全集在这里，
  别的文件按它校验。
- `pairing.json`：`rows` 11 条批型配对行（主行／`kind:addon` 加挂行／`kind:special`
  特殊行，后者用 `needsBase`/`needsRootCause` 表达批型条件必填；行上的 `note` 可缺省·
  只给人读）＋`rhythm` 11 条节奏谓词：`when` 的每个字段都要命中才输出该 `note`，取值两形，
  形态按字段类别守门——枚举字段（`batchType`/`stage`/`provider`）收字符串数组（本次参数值 ∈
  数组），规模字段（`diffLines`/`changedFiles`）收 `{max:N}`（本次参数 ≤ N，`diffLines=5`
  那种边界含在内，`max` 须非负整数，缺参不命中）。两类写反当场报错：那种写法能加载通过又永不
  命中，是静默失效而不是坏数据。
- `templates.json`：九键——门一/施工/修复批增量/方案任务书/AGENTS 必读链·复核/
  AGENTS 必读链·施工/横切判据/checklist/裁决。门二那行 `templateKey` 指向门一，故模板表
  里没有第二份逐字同文（将来两门要分叉＝改回自键＋补一份模板）。两张必读链辅助页分成复核
  版与施工版：复核那版带「只读禁写」，施工那版不带（施工者要动工）。模板里的 `〔…〕` 占位
  带各自的省略规则（空则整行省略）。
- `lifecycle.json`：`stages` 阶段表（`id`/`order`/`gate`/`kind`/`templateKey`（可缺省，
  缺省＝stage id）/`requires`（必填·stage 级必填矩阵的单源）/`produces`（可缺省·只给人读）/
  `uses`/`note`（可缺省·只给人读）/`point`（可缺省，只有复盘那行
  有：`minBatches`/`minBatchTypes`/`upperBatches`））——阶段词表、模板键、stage 级必填参数与
  **复盘点位判据**的单源，core 与 dispatch_lessons 现算；加阶段、改阈值＝改这份 JSON。
  `gate` 是「这一行是门阶段」的第二处表述：判组合出不出走的是 `kind`，这一列由 `dispatch_batch`
  的门禁推导读，加载期只对本工具出稿的四行互验 `gate` 等于「kind 是复核」——提交/复盘两行不由
  本工具出稿，它们的门别语义归各自的工具。`produces` 是给台账预留的产物面，本工具不读。
- `plan-spec.json`：`blocks` 十三节方案规范正文＋`checklist` 定稿自查 11 条——阶段＝方案
  时装配「方案任务书」的正文与清单尾。11 条＝剪切 8 条＋新增 3 条（术语只定义一次／判据
  两列齐／读我层不夹带用户没拍过的新决策），来源＝规范「拍板方可读性」节。

**追加面的台账事件字段**（台账一行一事件，字段与 `dispatch_batch` 的 `start`/`advance` 参数
一字同源，`rules` 由工具自动记）：两种事件各有 `t`（ISO-8601 带显式时区偏移）、`batch`、
`action`（`start|advance`）、`rules`；`start` 再带 `batchType`、`baseBatchType`（缺原批型写空串）、
`intent`、`subject`（缺省写空串）、`decisions`（缺省写空数组）；`advance` 再带 `stage`、`combo`、
`recommended`（当趟推荐组合 id 列表，未裁剪＝`combo`）、`perFormCounts`（形态 id → findings 数）、
`adopted`、`overlap`、`missed`、`note`——后八项的数字与短串缺省即写 0／空串，不省略。
**读法钉死：`fold` 与复盘读事件时，可选字段缺失＝零值**（数字缺失作 0、字符串作 ''、数组作 []、
对象作 {}），与写侧「0 写 0」的口径对称，历史事件不必补写；坏行由读面带行号报错，不按缺字段
静默放过。

**改规则＝改 JSON，下一次调用即生效，不发版不重启；需要重启的只有代码改动**（本仓被
宿主按模块代缓存）。装载时形状与双向引用一并校验：坏 JSON、形状不合、配对指向未定义
形态，一律带文件名（与字段路径）报错不静默出稿；阶段表另核一批互验（id/order 唯一、order 正
整数、kind 落在词表内、复核阶段的门别可反查、gate 与 kind 等价、requires 无重复且在参数名全集内、
uses 声明与模板占位互为充要，施工那行的 id 与 kind=提交 那行各与代码里的常量互认——逐条清单见
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

**why 写进数据、不写进注释**：JSON 没有注释位，所以设计意图与踩过的坑落成结构化字段——
行与形态的判断理由进 `note`/`notes`，预期例外（如上面那两个孤儿形态）也在 `notes` 里点明；
代码注释只写代码自己的 why。改配对规则时「为什么这么派」与「为什么这么排」因此跟着规则走，
不用另找一份散文对齐。追加面见下节。

**复盘修订配对的入口＝`dispatch_lessons`**：它读追加面那一整份台账，按点位（攒 5–8 批
覆盖 ≥3 批型，判据单源＝`lifecycle.json` 复盘行的 `point` 字段）判断该不该复，到了出草稿——
各形态 findings 数、组合采纳率（分母＝事件 `recommended` 逐事件求和且按集合去重，事件没自存
推荐时输出注明不可算）、推荐与实派的差（裁剪/加派记录）、修复轮数收敛（从门二事件数推导）、
双报重叠的捕获-再捕获估算（两路有交集且交集不大于次大那路才成立）、漏网清单，后两条按批型
聚合成一两条并报「另有 M 条」而不是逐事件铺开；全部统计按事件里的规则版本分组报（不跨版本
平均），同一份台账两次读出逐字相同（行序不依赖事件先后与时间戳并列）。统计分组这件事本身
也是 rules 字段存在的唯一理由。`force=true` 跳过点位判断直接出草稿。**它只读**：装配层传给它
的是只读端口（写方法不在那个对象上），建议给主会话裁决，改配对表是主会话的动作。

## dispatch_batch 批次台账

一个批次的一生记成一行一事件的 JSONL，默认落在**习惯层底目录下的
`data/dispatch-ledger.jsonl`**：Config 的 `dispatchLedgerPath` 显式路径优先，空串按
`memoryRoot` 推导，与 memory 写侧共用同一份「记忆根 → 层目录」归一（`~` 展开、绝对化都走
那一处）。习惯层在两台机器上都落在 agent-data 仓里，台账跟着它走才叫两机共享——
`agent-data/.gitattributes` 给这一行配 `merge=union`：两台同时追加的行都保留、零文本冲突，
行序非时间序由集合式推导吸收（展示按事件时间 `t` 排序）。跨机并发 `start` 各登各自合法，
合并后出现双 `start` 是正常吸收态：`status` 取 `t` 最小的一条并出告警，不当事故。

四个 action：`start` 登记批次（拍板清单随这次登记进台账，此后每次 `dispatch(batch=…)` 自动
带出）、`advance` 记一次阶段完成、`status` 查门禁（不给批次＝列在飞批次及各自下一道
未过门）、`list` 列全量。**状态永远从事件现推**，不存状态文件、不另设缓存——台账是唯一真相，
另存一份就是两份真相，且跨机合并出的乱序行会让「按行序累加出来的状态」漂。

`start` 是唯一的自举入口：台账与其目录都不存在时由它建出来，其余 action 遇台账缺失一律显式
报错「批次未登记（先 start）」，不静默建。写入经包级 fs 端口（与 memory 写侧同一条通道：
会话文件策略、原子发布与版本守卫都在那一层），追加时先给末行补一个换行再拼一行 JSON——
两行 JSON 直接相邻会长成一行不可解析的内容。写前拿的是旧版本就报版本失配（并发写不整篇
覆盖别人的行）。台账里出现坏行时 `status`/`list` 带行号报错，不静默跳过一行继续出稿。

写侧前提与 memory 写工具同一条：台账落在工作目录之外（记忆根下的 `data/`），会话文件策略是
`workspace-write` 时写入会被宿主当场拒——要记账就得给这一次会话全权（或放宽到记忆根），
不是这个工具多要的一份权限。

返回值分两种：给批次名的那一趟连事件一起回（单批有界，程序侧要能自己复算），`list` 与不给
批次名的 `status` 不回事件——一百分批就是几百 KB，那是往上下文里灌垃圾；那两种视图改带一批一行的
`rows` 摘要（批次名/批型/阶段进度/下一步/未过的门/最近事件时间/尾注/该行告警），既是给程序侧的
可直接读的那一份，也是展示文本的唯一渲染输入：宿主会把结构化值深拷贝冻结后再交给渲染函数，
任何按对象身份的缓存在那条路上必然不命中（渲染是同步纯投影，不在里面读盘也不重跑查询）。「这道门有没有」看配对表那一列：直做批之类
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
- 记忆注入块：`npm run check:memory -- <记忆根> <工作区 cwd>`——**两参必须带全**（少给任一参
  或给空串，桶在场那项判红、命令以 1 退出：工作层按 `process.cwd()` 算出
  `home-nvse-code-repos-dsh-toolbox` 这个不存在的桶，该层在**注入块装配**里被省略，整块
  定档只量得到习惯层——扫到多少就量多少，扫不到层时接线那项也不许拿「全绿」收场）。
  本机正确形态：
  `npm run check:memory -- /home/nvse/.dsh/memory /home/nvse/code`
  （扫两层目录，按注入侧同一份判定验预算、frontmatter 契约与层内 title 重名；接参
  `[记忆根] [工作区 cwd]`；覆盖项见命令末尾自报名单）。
- 老布局条目迁移：`node scripts/migrate-frontmatter.mjs <记忆根>` 默认 dry-run，逐条打印
  将要做什么（含「这批文件会把 CRLF 行尾整篇归一为 LF」）；确认后加 `--apply`——落盘前先
  把待改文件的改前原文备份到记忆根同级的 `memory-migrate-backups/<时间戳>/`，脚本可反复跑
  （已合规条目不动、不进备份）。
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
lib/head-read.js         分块头读（开句柄/分块/累积/末尾解码），端口适配器与读侧共用一份——曾有两份拷贝连块大小都分家，漂起来的症状是「某些条目读不到头」这种没法定位的偶发
lib/memory-root.js       记忆根默认值与归一、工作区路径→桶名、错误文案归一（零 node:fs）。落 lib 根因为要它的不止 memory 一族：dispatch 族的台账与离线自检脚本要的是「这个根归一成什么样」而不是「记忆怎么装配」，留在 memory/ 等于把整个 memory 族的 I/O 拖进它们；上移之后本模块只承诺「根与桶名」，谁要谁向下指
lib/memory/             记忆工具：index.js 装配 + core/frontmatter/patterns 纯模块 + write/delete/lint/assemble/layers。逐文件谁直连 node:fs 见 test/imports.test.js 的判定表，别照抄本文档的枚举；写侧 write.js 的本地导入闭包零 node:fs 由同文件的闭包断言钉住
lib/see-image/          识图工具：index.js 装配（零直连）+ vision.js（嗅探/终态映射，直连 node:fs）
lib/dispatch/           派发工具、批次台账与复盘工具：index.js 装配（零直连）+ core.js（查表/谓词/模板渲染纯函数）+ parameters.js（前两件工具的参数面，清单现读拼，零直连）+ batch.js（事件构造/集合式推导/台账读写/回填/展示文本，经包级 fs 端口，零直连）+ lessons.js（跨批统计/点位判定/建议草稿/展示文本，复用台账读法、经同一 fs 端口，零直连）+ data.js（现读五份数据 JSON 并验形状与双向引用，直连 node:fs）＋ data/（21 形态／11 配对行＋11 节奏／九键模板／6 阶段表／13 节方案规范）
test/                   node:test 单测（纯函数直测＋端口宿主适配器替身＋共享原语直测＋接线静态解析）
scripts/                checks.mjs：注入块自检的检查项数组与现场采集（可单测）；check-memory-index.mjs：跑上面那份数组的薄壳，末尾自报覆盖清单，不依赖宿主启动；migrate-frontmatter.mjs：老布局条目迁到 frontmatter 两键（默认 dry-run，`--apply` 才落盘并先备份）
```

每工具目录的模块接口只有两件：`register(ctx, config)` 与 `configShape`（dispatch 目录那一族
装配三件工具，故导出 `registerDispatch`、`registerDispatchBatch` 与 `registerDispatchLessons`
三个注册函数、共用一张 `configShape`——胶水的 FEATURES 表按工具逐条 try/catch，一件起不来
不连坐另一件）。
纯函数文件零宿主依赖，可直接单测；含宿主 import 的装配文件由 test/imports.test.js
静态解析钉住接线（防搬家断链、防 inject 漏声明）。

MIT
