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
`/home/nvse/code/repos/agent-data/profile-memory/WRITING.md`（本机软链到
`~/.dsh/memory/profile/WRITING.md`；memory 工具的 description 与 MANIFEST 指针都指向它）。
schema 与实现不同步＝子代理照 schema 传参撞上「参数不存在」；规范与实现不同步
＝条目按旧格式写进来、写侧当噪声拒收。

参数级写法细则（值按字面取、不解析 YAML、折行被拒）写进 `index.js` 的参数描述即可，
不必塞进 WRITING.md——后者每轮都进上下文，承载的是判层与纪律，不是单个参数的语法。

## 完成标准

一次交付在这两条都绿才算完（都是一条命令，秒级）：

```text
npm test            # exit 0 且 pass 数不低于改前
npm run check:memory   # 记忆索引预算与 frontmatter 契约（改记忆侧才跑）
```

- 测试**只增不删**：既有用例的前提失效时要改写它，不是删掉它；真要删，在汇报里
  单独说明为什么。
- `npm test` 覆盖不到运行期（宿主接线、注入块在真实会话里的样子），所以它是下限
  不是上限：改动触及注入或工具契约时，附上你实际验到了什么、没验到什么。

## 硬边界

- `lib/memory/fs-port.js` 的端口是写侧（`upsertEntry`/`editEntry`）唯一的 I/O 通道：
  契约、守卫、错误码（`FS_SANDBOX_DENIED`/`FS_STALE_VERSION`）、原子发布都不许为图省事
  削弱或绕过。要在写侧读目录就用端口的 `listDir`，别在 upsert/edit 里调 `node:fs`。
- 纯函数文件（`core.js`/`write.js`/`frontmatter.js`/`vision.js`）零宿主依赖，
  可直接单测；`test/imports.test.js` 静态解析钉住装配文件的导入面，搬家断链会红。
- 版本号随契约走：工具参数面、注入块结构、frontmatter 契约任一变更都算破坏性变更，
  0.x 的 minor 位就是破坏位（0.1.1 → 0.2.0），并与 README 的描述同批改。
