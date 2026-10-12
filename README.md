# dsh-toolbox

自用工具箱插件：把「本机有用的工具」按深模块结构装进一个包，逐工具隔离注册——
单个工具初始化失败只丢那一件，不连坐整包。当前两件：

- **memory**：分层记忆读写（习惯层/工作层，`write/edit/delete/lint` 四动作），
  附会话 systemPrompt 索引注入（`memory:index`，order 200）。
- **see_image**：把图片交给视觉模型转述成文字（先逐字转写可见文字，再按图型
  结构化描述），兜「图在磁盘上但当前会话模型看不见像素」的场景。两个入口：
  `path`（磁盘文件）与 `attachment`（会话占位符 hex，见下节）。

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

## 纯文本会话贴图闭环（attachment 入口）

纯文本模型（inputModalities 不含 image）的会话里粘贴图片时，宿主把消息里的
图片替换为占位符：`[image omitted because this model accepts text only;
attachment sha256:053eb17e]`——图已落宿主附件仓，模型只见 8 位 hex 前缀。
`see_image(attachment="053eb17e")`（也收 `sha256:…` 前缀或完整 64 位）即在
存区 `~/.dsh/attachments/v1/objects/`（$DSH_HOME 可移）按前缀定位唯一对象、
转述回会话。前缀歧义（同头多对象）与零命中都显式报错，不做静默兜底。

## 安装（本地仓直装）

```text
plugin_manager install_bundle /home/nvse/code/repos/dsh-toolbox
```

然后重启 dsh web（宿主模块代缓存：替换/装卸已装包不换模块代，必须重启才激活）。

## 验收口径

- 单测：`npm test`（node --test；零宿主依赖的纯函数层＋接线静态解析）。
- 识图质量端到端：合成四考区图（如 /tmp/vision_probe_q4.png）＋大字 OCR，
  答案与图吻合才留——不测易分辨的图，测「像素真喂进去了」。

## 结构（深模块口径）

```text
lib/index.js            胶水：FEATURES 表逐工具 try/catch 注册，configShape 并集
lib/memory/             记忆工具：index.js 装配 + core.js/write.js 纯函数
lib/see-image/          识图工具：index.js 装配 + vision.js 纯函数（嗅探/终态映射）
test/                   node:test 单测（纯函数直测 + 接线静态解析）
```

每工具目录的模块接口只有两件：`register(ctx, config)` 与 `configShape`。
纯函数文件零宿主依赖，可直接单测；含宿主 import 的装配文件由 test/imports.test.js
静态解析钉住接线（防搬家断链、防 inject 漏声明）。

MIT