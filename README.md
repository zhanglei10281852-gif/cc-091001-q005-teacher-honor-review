# 教师荣誉推荐评审

面向“年度好老师”推荐评审的轮次管理服务。把提名资格核验、材料封存、评委回避、异议处理、签署与结果公布放进同一条可信流程，替代无法判断回避后法定人数、无法解释并列处理的纸面流程。

运行环境为 Node.js 20 或更高版本，无第三方依赖。

```bash
npm test        # 运行全部测试
npm run demo    # 演示一次完整评审（含回避、补充评委、签署、公布）
npm start       # 启动 HTTP 服务（默认 :8080，PORT 环境变量可改）
```

真实候选人资料、评委关系及签名密钥不可提交；`fixtures/` 与测试中均为演示数据。

## 评审流程（状态机）

```
collecting → sealed → reviewing → signing → published
                ↑________|________|            |
                材料更正不迁移状态    重新开启(reopenRound) ┘
signing → reviewing（reopenScoring，签署过期后补评分）
```

1. **提名与资格核验**（collecting）：秘书组登记候选人，按轮次规则核验（默认：教龄 ≥ 5 年、师德记录无问题），核验留痕；提名截止后不能再登记。存在未核验或不合格提名时不能封存。
2. **材料封存**（sealed）：材料截止时间到后方可封存。封存为每位合格候选人生成匿名版本——别名 `C-01…` + 白名单字段（教龄、申报材料），姓名、单位、工号等身份信息不下发给评委。版本内容计算 SHA-256，任何事后更正都产生新的可辨识版本（版本号 + 哈希 + 原因 + 影响范围）。
3. **评审**（reviewing）：评委按别名评分，评分绑定提交时的材料版本；重复提交视为重新评分，旧评分被取代但保留痕迹。
4. **签署**（signing）：评委领取签署包（当前材料版本 + 计票哈希）后签署。签署与评分必须基于同一材料版本：材料更正或计票变化后，旧签署自动过期。
5. **公布**（published）：阻塞原因清零后方可公布。公布内容包含规则计算过程（聚合方式、法定人数规则、并列规则）、并列处理轨迹、签署摘要与内容哈希。公布后如需更正，重新开启轮次并再次公布，形成递增的公布版本（v1、v2…），旧版本保留可追溯。

## 关键机制

- **回避即时生效**：评委（或秘书组代录）申报亲属、同校等关系后，该评委对涉事候选人的有效评分立即失效并逐条留痕；回避撤销后失效评分不自动恢复，须重新评分。每个候选人的有效评审人数 = 已指派评委 − 有效回避人数，低于法定人数即阻塞公布，秘书组可补充评委恢复人数。
- **补充评委隔离**：评委（含补充评委）只能访问获授权的轮次，其余一律 403。
- **防反推**：评委视图只含匿名白名单字段；不下发法定人数、计票、他人评分与他人回避信息；对“别名不存在”和“存在回避关系”返回同一错误码与文案；回避申报回执不含别名映射。已知残余通道：评委申报回避后，涉事候选人从其评审列表消失，时间上存在相关性，这是“回避立即生效”的固有代价，已在设计上尽量收敛（不告知原因、不暴露数量以外的信息）。
- **公布阻塞原因**：`getPublicationBlockers` 返回结构化原因——`ROUND_NOT_IN_SIGNING`、`QUORUM_NOT_MET`（含候选人、现有/要求人数）、`INSUFFICIENT_SCORES`、`OPEN_OBJECTIONS`（含异议编号）、`SIGNATURES_STALE`（含当前版本与计票哈希）、`INSUFFICIENT_SIGNATURES`，秘书组可据此逐项排除。
- **并列处理**：默认按 总分 → 师德 → 教学 → 学生发展 → 公益服务 → 别名 依次区分；每一步的取值与区分结果记入 `tieTrace`，规则耗尽仍相同则共享名次（`tied`）。
- **审计链**：每轮次一条哈希链式追加日志（建轮、提名、核验、封存、更正、申报、评分、失效、异议、签署、公布），`verifyAudit` 可检出任何事后篡改。

## 角色与接口

操作者：`{ role: 'secretary' | 'reviewer', id }`。HTTP 下通过请求头 `x-actor-role` / `x-actor-id` 传入。

| 能力 | 方法 / 路由 | 角色 |
| --- | --- | --- |
| 建轮 | `createRound` / `POST /rounds` | 秘书组 |
| 登记/更正/退出提名、资格核验 | `addCandidate` `updateCandidate` `withdrawCandidate` `verifyEligibility` / `POST /rounds/:rid/candidates…` | 秘书组 |
| 封存 / 材料更正 | `sealMaterials` `amendMaterials` / `POST /rounds/:rid/seal` `…/amend` | 秘书组 |
| 指派评委 | `assignReviewer` / `POST /rounds/:rid/reviewers` | 秘书组 |
| 回避申报 / 撤销 | `declareConflict` `revokeConflict` / `POST /rounds/:rid/conflicts…` | 评委本人或秘书组 |
| 评分 | `submitScore` / `POST /rounds/:rid/scores` | 获授权评委 |
| 异议提出 / 处理 | `raiseObjection` `resolveObjection` / `POST /rounds/:rid/objections…` | 评委或秘书组 / 秘书组 |
| 流程推进 | `startReview` `closeScoring` `reopenScoring` `reopenRound` | 秘书组 |
| 签署包 / 签署 | `getSigningPackage` `sign` / `GET …/signing-package` `POST …/sign` | 获授权评委 |
| 阻塞原因 | `getPublicationBlockers` / `GET …/blockers` | 秘书组 |
| 公布 / 查看公布 | `publish`（秘书组） `getPublication`（公开） / `POST …/publish` `GET …/publication` | — |
| 视图与审计 | `getReviewerView` `getSecretaryView` `getAuditLog` `verifyAudit` | 评委 / 秘书组 |

## 资料文件

- `fixtures/review-context.json`：演示轮次上下文（材料版本、法定人数等）。
- `src/domain.js`：评分类目、回避关系类型、异议状态、并列规则等公共约定。
- `src/review-service.js`：领域服务；`src/server.js`：HTTP 封装；`src/audit.js`、`src/canon.js`：审计链与规范化哈希。
