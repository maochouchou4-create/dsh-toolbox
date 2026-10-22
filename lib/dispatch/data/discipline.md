# 跑批工作流（决策级改动一律走此流程；咨询级问答与小修不进）

- 主会话纪律：出方案与一切裁决以亲自验证为准——现状亲查（file:line、命令输出）、施工完工亲验（比对方案逐项）、复核 findings 亲核（可复跑命令亲跑），不采信 subagent 转述或「无偏离」自述。
- 立项：主会话亲查亲写方案文档（工作区实施方案目录；骨架与定稿自查规范见模板文件）；dispatch_batch action=start 落账（batch/intent/subject/decisions）。
- 方案证伪（拍板前）：派 subagent 只拿方案文档做前提攻击（一轮为限）；主会话逐条裁决（采纳/拒收＋依据）→ dispatch_batch action=gate 记账 → 修方案 → 请用户过目拍板；用户说开工才施工。
- 施工：派 subagent 按方案文档＋锚点施工；完工自证＋汇报，不 commit。
- 证伪门（提交前）：派 subagent 只拿方案文档＋净 diff 复核（不读施工汇报）；主会话裁决 → action=gate 记账 → 修正 → 主会话 commit/push → action=commit 记账。
- 收官：action=review 记复盘，收官即清账。台账只记事实，不做该不该判断。
- 方案骨架／证伪 brief 模板／定稿自查：{templates}
