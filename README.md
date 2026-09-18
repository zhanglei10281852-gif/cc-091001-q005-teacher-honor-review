# 教师荣誉推荐评审

管理年度好老师推荐评审轮次的 Node.js 服务，覆盖提名资格核验、材料封存、评委回避与结果确认全流程，确保评审过程可信、可解释、可审计。

运行环境为 Node.js 20 或更高版本，无第三方依赖。`npm test` 运行测试，`npm start` 启动服务（`PORT` 指定端口，`SECRETARY_TOKEN` 指定秘书组令牌，缺省自动生成并打印）。真实候选人资料、评委关系及签名密钥不可提交。

## 评审流程与状态机

```
collecting → sealed → reviewing → signing → published
```

1. **材料截止（close-materials）**：候选人按哈希排序分配匿名编号 `C-01…`（与报名顺序无关），生成带内容摘要的匿名材料版本，进入 `sealed`。此后评委只能看到匿名编号与匿名化材料。
2. **开放评分（open-review）**：评委按四个类目评分（师德表现 / 教学育人 / 学生发展 / 公益服务，各 0–25 分，总分 100）。评分必须绑定当前材料版本。
3. **结束评分（close-scoring）**：校验每位候选人的有效评分份数达到法定人数后，生成结果版本（含排名计算过程与摘要），进入 `signing`。
4. **签署（signatures）**：评委签署当前结果版本，签署声明绑定结果摘要（摘要内含材料版本）。
5. **公布（publish）**：全部前置条件满足后公布，仅入选者解除匿名。

## 核心保证

- **回避即时生效**：申报回避关系（亲属 / 同校 / 直接师生 / 其他申报）后，该评委对相应候选人的有效评分立即失效，失效记录与原始提交都保留在审计链中。已回避评委的材料视图被屏蔽，且不能再对该候选人评分。
- **版本一致**：材料每次事后变更都形成新的可辨识版本（版本号 + 内容摘要递增），旧版本评分立即失效；重新评分与最终签署必须基于同一材料版本，由结果摘要绑定强制保证。
- **授权隔离**：补充评委仅获授权特定轮次，访问未授权轮次一律返回 404（不泄露轮次存在性）；评委视图不含真实身份、他人评分与他人回避信息。
- **公布门槛**：法定人数不足、存在未处理异议、签署不足或签署版本过期时不得公布；`GET /rounds/:id/blockers` 向秘书组返回明确的结构化阻塞原因。
- **可解释公布**：公布结果包含完整规则计算过程（每位候选人有效份数、均值、排序与并列处理步骤）与签署摘要；并列候选共享名次，录取线处并列一并入选，处理过程写入说明。
- **审计链**：每次变更追加带链式哈希的审计条目，`GET /rounds/:id/audit` 返回校验结果，任何篡改都会被发现；公布后更正材料会形成新的材料版本与公布版本（`supersedes` 链）。

## 主要接口

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/rounds` | 秘书 | 创建轮次（法定人数、名额、评委、候选人），返回评委令牌 |
| POST | `/rounds/:id/close-materials` | 秘书 | 材料截止，生成匿名版本 |
| POST | `/rounds/:id/material-versions` | 秘书 | 材料变更（修改/新增/退出），形成新版本 |
| POST | `/rounds/:id/open-review` | 秘书 | 开放评分 |
| POST | `/rounds/:id/reviewers` | 秘书 | 追加补充评委（仅本轮次授权） |
| POST | `/rounds/:id/close-scoring` | 秘书 | 结束评分，生成结果版本 |
| POST | `/rounds/:id/publish` | 秘书 | 公布（幂等；阻塞时返回 409 + blockers） |
| GET | `/rounds/:id/blockers` | 秘书 | 当前阻塞原因 |
| GET | `/rounds/:id/audit` | 秘书 | 审计链与校验结果 |
| GET | `/rounds/:id` | 秘书 | 轮次全量视图（含真实身份映射） |
| GET | `/rounds/:id/workspace` | 评委 | 本人工作台（匿名候选人、本人评分/回避/异议） |
| POST | `/rounds/:id/scores` | 评委 | 提交/更新评分（须为当前材料版本） |
| POST | `/rounds/:id/conflicts` | 评委/秘书 | 申报回避（评委仅限本人） |
| DELETE | `/rounds/:id/conflicts/:cid` | 秘书 | 解除回避（已失效评分不自动恢复） |
| POST | `/rounds/:id/objections` | 评委/秘书 | 提出异议 |
| POST | `/rounds/:id/objections/:oid/handle` | 秘书 | 处理异议（resolved/dismissed） |
| POST | `/rounds/:id/signatures` | 评委 | 签署当前结果版本 |
| GET | `/publications/:id` | 公开 | 查询最新公布结果 |

认证方式：`Authorization: Bearer <token>`。错误响应统一为 `{"error":{"code","message","details?"}}`。

## 阻塞原因代码

| 代码 | 含义 |
| --- | --- |
| `ROUND_NOT_IN_SIGNING` | 尚未进入签署环节 |
| `QUORUM_NOT_MET` | 部分候选人有效评审人数不足法定人数（含逐候选人明细） |
| `OPEN_OBJECTIONS` | 存在未处理异议 |
| `NO_RESULT_SNAPSHOT` | 尚未形成结果版本 |
| `SIGNATURE_VERSION_STALE` | 已有签署基于过期结果版本，需重新签署 |
| `SIGNATURES_INSUFFICIENT` | 当前结果版本签署数量不足法定人数 |

## 代码结构

- `src/domain.js` — 评审常量、评分/排名/并列规则、摘要与审计链校验（纯函数）
- `src/service.js` — 轮次生命周期、回避、评分、异议、签署、公布与视图（业务核心）
- `src/server.js` — HTTP 路由与认证
- `src/index.js` — 服务启动入口
- `fixtures/review-context.json` — 评审样例（版本、法定人数等公共约定）
