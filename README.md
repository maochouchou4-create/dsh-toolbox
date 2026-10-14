# dsh-toolbox

自用工具箱插件：把「本机有用的工具」按深模块结构装进一个包，逐工具隔离注册——
单个工具初始化失败只丢那一件，不连坐整包。当前两件：

- **memory**：分层记忆读写（习惯层/工作层，`write/edit/delete/lint` 四动作），
  附会话 systemPrompt 索引注入（`memory:index`，order 200）。索引行由条目
  frontmatter（恰好 `title`＋`description` 两键）现场派生，不落盘、不手写。
- **see_image**：把图片交给视觉模型转述成文字（先逐字转写可见文字，再按图型
  结构化描述），兜「图在磁盘上但当前会话模型看不见像素」的场景。两个入口：
  `path`（磁盘文件）与 `attachment`（会话占位符 hex，见下节）。

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

## memory 写侧的文件策略边界

memory 的写入走宿主自己的 fs 通道，因此受会话文件策略围栏；而记忆文件按设计住在
工作目录之外（`~/.dsh/memory`），所以写记忆要求 `danger-full-access`（本 profile 的
`permission-presets.defaultPreset` 即如此）。若把权限切到 `workspace-write`，写记忆
会被宿主判成越界而拒——设计后果，不是故障。delete 与 lint 两族因宿主 fs 契约没有
删除能力而留在 node:fs，不受该围栏约束，但 delete 同样受只读策略前检（只读会话
一律拒写）。

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
lib/memory/             记忆工具：index.js 装配 + core/frontmatter/patterns 纯模块 + write/delete/lint/assemble/layers + fs-port.js 端口 + fs-guard.js（写侧 I/O 前置守卫与错误码，零 node:fs 以免拖进写侧闭包）+ head-read.js（分块头读，端口适配器与读侧共用）。逐文件谁直连 node:fs 见 test/imports.test.js 的判定表，别照抄本文档的枚举；写侧 write.js 的本地导入闭包零 node:fs 由同文件的闭包断言钉住
lib/see-image/          识图工具：index.js 装配（零直连）+ vision.js（嗅探/终态映射，直连 node:fs）
test/                   node:test 单测（纯函数直测＋端口宿主适配器替身＋共享原语直测＋接线静态解析）
scripts/                checks.mjs：注入块自检的检查项数组与现场采集（可单测）；check-memory-index.mjs：跑上面那份数组的薄壳，末尾自报覆盖清单，不依赖宿主启动；migrate-frontmatter.mjs：老布局条目迁到 frontmatter 两键（默认 dry-run，`--apply` 才落盘并先备份）
```

每工具目录的模块接口只有两件：`register(ctx, config)` 与 `configShape`。
纯函数文件零宿主依赖，可直接单测；含宿主 import 的装配文件由 test/imports.test.js
静态解析钉住接线（防搬家断链、防 inject 漏声明）。

MIT
