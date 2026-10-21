/**
 * dispatch 族工具的参数面（schema 声明层）。参数名清单与 core 的 taskParamNames／
 * challengeParamNames 必须一致（单测对账），描述只写「怎么填」，不复述规则正文。
 */
import { stringList, objectList } from '../tool-schema.js'

/** 立项出稿：方案先行，出稿即落 start 事件。 */
export function taskParameters() {
  return {
    batch: {
      type: 'string',
      required: true,
      description: '批次名（全仓唯一小写短名）。出稿即自动落 start 事件（意图／拍板清单＋规则指纹）。',
    },
    intent: { type: 'string', required: true, description: '本批意图一句话（设计判断要知道目标才谈得上最优）。' },
    subject: {
      type: 'string',
      description: '对象（可选）：方案文档绝对路径＋批次节指针；方案证伪从台账回填它，未定先不传（台账写占位「（待写）」）。',
    },
    anchors: { ...stringList(), required: true, description: '锚点符号名（禁行号）：施工者按名定位，测试按名做变异。' },
    decisions: { ...stringList(), description: '拍板清单（不得重开），逐条原文；台账登记后由 dispatch_challenge 回填。' },
    forbidden: { type: 'string', description: '禁区（本批不许碰的域）；空则登记行省略。' },
    budget: { type: 'string', description: '预算（如「文件≤30」）；空则登记行省略。' },
    acceptance: { type: 'string', description: '验收命令（单行，带闭包查询）；改守门断言须变异必红后复原。' },
    decisionCards: {
      ...objectList(
        {
          question: { type: 'string', required: true },
          options: { type: 'string', required: true },
          recommendation: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          impact: { type: 'string', required: true },
        },
        { additionalProperties: false },
      ),
      description: '决策卡（≤6 行/卡，仅架构级与产品语义级）：question／options（用／分隔）／recommendation／reason／impact。',
    },
  }
}

/** 证伪门／方案证伪：出 brief 与裁决记账同一件工具（adjudicate 分野）。 */
export function challengeParameters() {
  return {
    batch: { type: 'string', required: true, description: '批次名：除 subject 外，意图/拍板清单从台账回填；adjudicate=true 时按批写 gate 事件。' },
    gate: { type: 'string', description: '门名：证伪门（施工后，对象＝净 diff 生成命令；缺省）／方案证伪（施工前，对象＝方案文档）。' },
    subject: {
      type: 'string',
      description: '复核对象（单行）：证伪门＝净 diff 生成命令，必传（如 git diff 起点..HEAD，不从台账回填）；方案证伪＝方案原文路径＋批次节指针，未传从台账 start 事件回填。',
    },
    intent: { type: 'string', description: '本批意图；缺省从台账回填。' },
    decisions: { ...stringList(), description: '拍板清单；缺省从台账回填。' },
    segment: { type: 'string', description: '施工段标记：判的是哪个施工段的净 diff（缺省 方案／净 diff）。' },
    adjudicate: {
      type: 'boolean',
      description: 'true＝这一趟是裁决后记账（写 gate 事件，findings 裁决字段见下）；false＝出 brief（缺省）。',
    },
    forms: {
      ...stringList(),
      description: '追加形态 id（追加不替换）：缺省按门给标准形态，点名的逐个追加进 brief；安全专项缺省被滤除，显式点名才进 brief。',
    },
    recommended: { ...stringList(), description: '当趟装配的推荐组合（脚本次账的分母；未裁剪时＝forms）。' },
    perFormCounts: {
      ...objectList({ form: { type: 'string', required: true }, count: { type: 'number', required: true } }),
      description: '各形态 findings 数（结构化落库；缺省=0）。',
    },
    adopted: { type: 'number', description: '采纳的 findings 数（缺省 0；与 rejected 各自落账，不互相推导）。' },
    rejected: { type: 'number', description: '显式拒收数（部分场景与推导值并列展示）。' },
    overlap: { type: 'number', description: '双路重复上报的 findings 数（重叠高＝两路在看同一处）。' },
    missed: { type: 'string', description: '漏网标记：用户事后实测暴露的问题＋本可由哪形态抓到；无漏网不传此字段（写『无』会被统计当真漏网）。' },
    note: { type: 'string', description: '自由附注一句（status/list 渲染尾注）。' },
  }
}

/** 台账四动作的参数面：commit/review 各要两格，status/list 只要批次（list 可省）。 */
export function batchParameters() {
  return {
    action: { type: 'string', required: true, description: 'commit｜review｜status｜list。commit 记提交与推送结果；review 记复盘行＋门效能（收官即清账）；status 查门禁；list 列全量批次。' },
    batch: { type: 'string', description: '批次名（commit/review/status 必填；list 可省）。' },
    commit: { type: 'string', description: 'commit 号（action=commit 必填，单行）。' },
    pushed: { type: 'string', description: '推送结果（action=commit 必填，单行；如 ok／failed: <原因>／not-pushed）。' },
    retro: { type: 'string', description: '复盘行（action=review 必填，单行）：本批结论＋下一轮口径。' },
    efficacy: { type: 'string', description: '门效能一句（action=review 可选）：哪道门拦住了什么、哪道门零拦截。' },
    note: { type: 'string', description: '自由附注。' },
  }
}
