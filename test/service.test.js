import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAuditChain } from '../src/domain.js';
import { SECRETARY, reviewer, makeService, makeRound, setupReviewing, cats, scoreAll } from './helpers.js';

const RID = 'ROUND-1';
const REVIEWERS = ['R1', 'R2', 'R3', 'R4', 'R5'];
// T1 最高、T2 次之、T3 最低
const defaultScoreOf = (aliasOf) => (a) => (a === aliasOf.T1 ? 23 : a === aliasOf.T2 ? 20 : 15);

function reachSigning(service, aliasOf, scoreOf = defaultScoreOf(aliasOf)) {
  scoreAll(service, RID, REVIEWERS, Object.values(aliasOf), 1, scoreOf);
  return service.closeScoring(SECRETARY, RID);
}

function signBy(service, reviewerIds) {
  for (const rid of reviewerIds) service.sign(reviewer(rid), RID);
}

test('完整流程：截止生成匿名版本，公布含规则计算过程与签署摘要', () => {
  const { service } = makeService();
  const { aliasOf } = setupReviewing(service);

  const closed = reachSigning(service, aliasOf);
  assert.equal(closed.state, 'signing');
  assert.equal(closed.resultVersion, 1);
  assert.match(closed.resultDigest, /^sha256:[0-9a-f]{64}$/);

  signBy(service, ['R1', 'R2', 'R3']);
  const pub = service.publish(SECRETARY, RID);

  assert.equal(pub.publicationVersion, 1);
  assert.equal(pub.materialVersion, 1);
  assert.equal(pub.resultDigest, closed.resultDigest);
  // 入选者解除匿名
  assert.deepEqual(pub.awardees.map((a) => a.name).sort(), ['张老师', '李老师']);
  assert.equal(pub.awardees[0].rank, 1);
  // 未入选者保持匿名：公布内容中不出现其姓名与学校
  assert.ok(!JSON.stringify(pub).includes('王老师'));
  assert.ok(!JSON.stringify(pub).includes('第三中学'));
  // 规则计算过程可解释
  assert.equal(pub.rules.quorum, 3);
  assert.equal(pub.computation.perCandidate.length, 3);
  assert.ok(pub.computation.explanation.some((s) => s.includes('排序规则')));
  assert.ok(pub.computation.explanation.some((s) => s.includes('法定人数 3')));
  // 签署摘要
  assert.equal(pub.signatures.count, 3);
  assert.match(pub.signatures.digest, /^sha256:/);
  assert.equal(pub.signatures.signers.length, 3);
  // 审计链头与公布记录一致
  const audit = service.getAudit(SECRETARY, RID);
  assert.equal(pub.auditHead, audit.entries[audit.entries.length - 1].hash);
  assert.equal(audit.verification.ok, true);

  // 重复公布幂等
  const again = service.publish(SECRETARY, RID);
  assert.equal(again.publicationId, pub.publicationId);
});

test('材料截止前评委看不到候选人，截止后只见匿名别名', () => {
  const { service } = makeService();
  makeRound(service);
  // 截止前：工作台不含任何候选人
  const before = service.getWorkspace(reviewer('R1'), RID);
  assert.equal(before.materialVersion, 0);
  assert.equal(before.candidates.length, 0);

  service.closeMaterials(SECRETARY, RID);
  const ws = service.getWorkspace(reviewer('R1'), RID);
  assert.equal(ws.materialVersion, 1);
  assert.equal(ws.candidates.length, 3);
  for (const c of ws.candidates) {
    assert.match(c.alias, /^C-\d{2}$/);
    assert.ok(!('name' in c) && !('school' in c));
  }
  // 响应中不出现任何真实姓名与学校
  const text = JSON.stringify(ws);
  for (const leaked of ['张老师', '李老师', '王老师', '第一中学', '第二中学', '第三中学']) {
    assert.ok(!text.includes(leaked), `泄露了 ${leaked}`);
  }
});

test('回避申报立即使受影响评分失效并保留审计痕迹', () => {
  const { service } = makeService();
  const { aliasOf } = setupReviewing(service);
  const alias = aliasOf.T1;
  service.submitScore(reviewer('R1'), RID, { alias, materialVersion: 1, categories: cats(22) });

  const { conflictId, invalidatedScores } = service.declareConflict(SECRETARY, RID, {
    reviewerId: 'R1', alias, kind: 'relative',
  });
  assert.equal(invalidatedScores, 1);

  // 评分记录仍在但已失效
  const view = service.getRoundForSecretary(SECRETARY, RID);
  const score = view.scores.find((s) => s.reviewerId === 'R1' && s.alias === alias);
  assert.equal(score.status, 'invalidated');
  assert.equal(score.invalidatedBy, conflictId);

  // 审计链同时保留提交与失效痕迹
  const actions = view && service.getAudit(SECRETARY, RID).entries.map((e) => e.action);
  assert.ok(actions.includes('score.submitted'));
  assert.ok(actions.includes('conflict.declared'));
  const declared = service.getAudit(SECRETARY, RID).entries.find((e) => e.action === 'conflict.declared');
  assert.equal(declared.details.invalidatedScoreIds.length, 1);

  // 已回避评委不能对该候选人评分，工作台屏蔽其材料
  assert.throws(
    () => service.submitScore(reviewer('R1'), RID, { alias, materialVersion: 1, categories: cats(20) }),
    (e) => e.code === 'recused',
  );
  const ws = service.getWorkspace(reviewer('R1'), RID);
  const entry = ws.candidates.find((c) => c.alias === alias);
  assert.equal(entry.recused, true);
  assert.equal(entry.materials, null);
});

test('回避后有效评审人数不足法定人数时，结束评分与公布均被阻塞且原因明确', () => {
  const { service } = makeService();
  const { aliasOf } = setupReviewing(service);
  const alias = aliasOf.T2;
  // 5 名评委中 3 人回避 T2，仅剩 2 人 < 法定人数 3
  for (const rid of ['R1', 'R2', 'R3']) {
    service.declareConflict(SECRETARY, RID, { reviewerId: rid, alias, kind: 'same-school' });
  }
  scoreAll(service, RID, ['R4', 'R5'], Object.values(aliasOf), 1, () => 20);
  scoreAll(service, RID, ['R1', 'R2', 'R3'], [aliasOf.T1, aliasOf.T3], 1, () => 20);

  assert.throws(
    () => service.closeScoring(SECRETARY, RID),
    (e) => {
      assert.equal(e.code, 'quorum_not_met');
      const detail = e.details.blockers[0].candidates.find((c) => c.alias === alias);
      assert.equal(detail.validScores, 2);
      assert.equal(detail.effectiveReviewers, 2);
      assert.equal(detail.required, 3);
      return true;
    },
  );
  const { blockers } = service.getBlockers(SECRETARY, RID);
  assert.ok(blockers.some((b) => b.code === 'QUORUM_NOT_MET'));
});

test('未处理异议阻塞公布，处理后放行', () => {
  const { service } = makeService();
  const { aliasOf } = setupReviewing(service);
  reachSigning(service, aliasOf);
  signBy(service, ['R1', 'R2', 'R3']);

  const { objectionId } = service.raiseObjection(reviewer('R4'), RID, {
    alias: aliasOf.T1, text: '对材料真实性有异议',
  });
  assert.throws(
    () => service.publish(SECRETARY, RID),
    (e) => {
      assert.equal(e.code, 'publish_blocked');
      assert.ok(e.details.blockers.some((b) => b.code === 'OPEN_OBJECTIONS' && b.count === 1));
      return true;
    },
  );
  service.handleObjection(SECRETARY, RID, objectionId, { outcome: 'resolved', note: '已核实' });
  const pub = service.publish(SECRETARY, RID);
  assert.equal(pub.roundId, RID);
});

test('材料变更形成新版本：旧评分失效、签署过期，重评与签署必须基于同一新版本', () => {
  const { service } = makeService();
  const { aliasOf } = setupReviewing(service);
  const v1 = reachSigning(service, aliasOf);
  signBy(service, ['R1', 'R2', 'R3']);

  // 签署期间变更材料 -> 回到评分阶段
  const amended = service.amendMaterials(SECRETARY, RID, {
    changes: [{ alias: aliasOf.T1, materials: '事迹材料甲（补充，已匿名化）' }],
    note: '补充证明材料',
  });
  assert.equal(amended.materialVersion, 2);
  assert.equal(amended.state, 'reviewing');
  assert.notEqual(amended.materialHash, service.getRoundForSecretary(SECRETARY, RID).materialVersions[0].hash);

  // 旧版本评分全部失效但保留记录
  const view = service.getRoundForSecretary(SECRETARY, RID);
  assert.ok(view.scores.filter((s) => s.status === 'stale').length > 0);
  assert.equal(view.scores.filter((s) => s.status === 'valid').length, 0);

  // 阻塞原因对秘书明确：不在签署环节 + 签署版本过期
  const { blockers } = service.getBlockers(SECRETARY, RID);
  assert.ok(blockers.some((b) => b.code === 'ROUND_NOT_IN_SIGNING'));
  assert.ok(blockers.some((b) => b.code === 'SIGNATURE_VERSION_STALE' && b.staleCount === 3));

  // 用旧材料版本评分被拒绝
  assert.throws(
    () => service.submitScore(reviewer('R1'), RID, { alias: aliasOf.T1, materialVersion: 1, categories: cats(20) }),
    (e) => e.code === 'version_mismatch' && e.details.currentMaterialVersion === 2,
  );

  // 基于新版本重新评分与签署
  scoreAll(service, RID, REVIEWERS, Object.values(aliasOf), 2, defaultScoreOf(aliasOf));
  const closed2 = service.closeScoring(SECRETARY, RID);
  assert.equal(closed2.resultVersion, 2);
  assert.notEqual(closed2.resultDigest, v1.resultDigest);

  // 旧签署不计入：只签 2 人时仍不足
  signBy(service, ['R1', 'R2']);
  const mid = service.getBlockers(SECRETARY, RID);
  assert.ok(mid.blockers.some((b) => b.code === 'SIGNATURES_INSUFFICIENT' && b.have === 2 && b.need === 3));
  service.sign(reviewer('R3'), RID);

  const pub = service.publish(SECRETARY, RID);
  assert.equal(pub.materialVersion, 2);
  assert.equal(pub.resultVersion, 2);
  assert.equal(pub.signatures.count, 3);
});

test('签署期间新增回避：结果版本更新，旧签署立即过期', () => {
  const { service } = makeService();
  const { aliasOf } = setupReviewing(service);
  reachSigning(service, aliasOf);
  signBy(service, ['R1', 'R2', 'R3']);

  // R4 临时申报与 T1 为亲属 -> R4 对 T1 的评分失效 -> 结果版本变为 2
  service.declareConflict(reviewer('R4'), RID, { alias: aliasOf.T1, kind: 'relative' });
  const view = service.getRoundForSecretary(SECRETARY, RID);
  assert.equal(view.currentResultVersion, 2);
  assert.equal(view.state, 'signing');

  const { blockers } = service.getBlockers(SECRETARY, RID);
  assert.ok(blockers.some((b) => b.code === 'SIGNATURE_VERSION_STALE' && b.staleVersions.includes(1)));
  assert.ok(blockers.some((b) => b.code === 'SIGNATURES_INSUFFICIENT' && b.have === 0));
  assert.throws(() => service.publish(SECRETARY, RID), (e) => e.code === 'publish_blocked');

  // 重新签署当前版本后可公布
  signBy(service, ['R1', 'R2', 'R3']);
  const pub = service.publish(SECRETARY, RID);
  assert.equal(pub.resultVersion, 2);
  // T1 的有效评分为 4 份（R4 被排除）
  const t1 = pub.computation.perCandidate.find((p) => p.alias === aliasOf.T1);
  assert.equal(t1.validScoreCount, 4);
});

test('并列候选共享名次，录取线处并列一并入选且过程可解释', () => {
  const { service } = makeService();
  const { aliasOf } = setupReviewing(service, { awardCount: 1 });
  // T1 与 T2 各项完全相同 -> 并列
  reachSigning(service, aliasOf, (a) => (a === aliasOf.T3 ? 10 : 20));
  signBy(service, ['R1', 'R2', 'R3']);
  const pub = service.publish(SECRETARY, RID);

  assert.equal(pub.computation.tieGroups.length, 1);
  const tied = pub.computation.perCandidate.filter((p) => p.tied);
  assert.equal(tied.length, 2);
  assert.ok(tied.every((p) => p.rank === 1));
  // awardCount 为 1，但并列者一并入选
  assert.equal(pub.awardees.length, 2);
  assert.ok(pub.computation.explanation.some((s) => s.includes('并列处理')));
  assert.ok(pub.computation.explanation.some((s) => s.includes('录取线处并列一并入选')));
});

test('同一材料版本内重新评分以最新为准，旧评分标记为 replaced', () => {
  const { service } = makeService();
  const { aliasOf } = setupReviewing(service);
  const alias = aliasOf.T1;
  service.submitScore(reviewer('R1'), RID, { alias, materialVersion: 1, categories: cats(10) });
  service.submitScore(reviewer('R1'), RID, { alias, materialVersion: 1, categories: cats(24) });

  const view = service.getRoundForSecretary(SECRETARY, RID);
  const mine = view.scores.filter((s) => s.reviewerId === 'R1');
  assert.equal(mine.find((s) => s.status === 'replaced').total, 40);
  assert.equal(mine.find((s) => s.status === 'valid').total, 96);
});

test('补充评委仅能看到获授权轮次', () => {
  const { service } = makeService();
  setupReviewing(service);
  setupReviewing(service, { roundId: 'ROUND-2' });
  const { token } = service.addReviewer(SECRETARY, 'ROUND-2', { reviewerId: 'S1' });
  const principal = service.authenticate(token);
  assert.deepEqual(principal, { role: 'reviewer', reviewerId: 'S1' });

  // 列表只含获授权轮次
  const list = service.listRounds(principal);
  assert.deepEqual(list.map((r) => r.roundId), ['ROUND-2']);
  assert.equal(list[0].myRole, 'supplementary');
  // 访问未授权轮次按不存在处理
  assert.throws(() => service.getWorkspace(principal, RID), (e) => e.status === 404);
  // 获授权轮次可正常评分
  const ws = service.getWorkspace(principal, 'ROUND-2');
  service.submitScore(principal, 'ROUND-2', {
    alias: ws.candidates[0].alias, materialVersion: 1, categories: cats(18),
  });
});

test('评委视图不包含他人评分、他人回避与真实身份', () => {
  const { service } = makeService();
  const { aliasOf } = setupReviewing(service);
  service.submitScore(reviewer('R1'), RID, { alias: aliasOf.T1, materialVersion: 1, categories: cats(21) });
  service.declareConflict(SECRETARY, RID, { reviewerId: 'R2', alias: aliasOf.T2, kind: 'declared-other' });

  const ws = service.getWorkspace(reviewer('R3'), RID);
  const text = JSON.stringify(ws);
  assert.ok(!text.includes('R1') && !text.includes('R2'));
  assert.ok(!text.includes('张老师') && !text.includes('第一中学'));
  // 他人的回避不影响本人查看材料
  assert.equal(ws.candidates.find((c) => c.alias === aliasOf.T2).recused, false);
});

test('公布后再次变更形成新的可辨识版本，重新公布带 superseded 链', () => {
  const { service } = makeService();
  const { aliasOf } = setupReviewing(service);
  reachSigning(service, aliasOf);
  signBy(service, ['R1', 'R2', 'R3']);
  const pub1 = service.publish(SECRETARY, RID);

  // 公布后更正材料 -> 新版本、重新评审
  service.amendMaterials(SECRETARY, RID, {
    changes: [{ alias: aliasOf.T3, materials: '事迹材料丙（更正，已匿名化）' }],
    note: '更正错别字',
  });
  scoreAll(service, RID, REVIEWERS, Object.values(aliasOf), 2, defaultScoreOf(aliasOf));
  service.closeScoring(SECRETARY, RID);
  signBy(service, ['R1', 'R2', 'R3']);
  const pub2 = service.publish(SECRETARY, RID);

  assert.equal(pub2.publicationVersion, 2);
  assert.equal(pub2.supersedes, pub1.publicationId);
  assert.equal(pub2.materialVersion, 2);
  assert.notEqual(pub2.resultDigest, pub1.resultDigest);
  assert.notEqual(pub2.materialHash, pub1.materialHash);
  // 公开查询返回最新版本
  assert.equal(service.getPublication(RID).publicationId, pub2.publicationId);
});

test('审计链可校验，篡改条目会被发现', () => {
  const { service } = makeService();
  const { aliasOf } = setupReviewing(service);
  reachSigning(service, aliasOf);
  const { entries, verification } = service.getAudit(SECRETARY, RID);
  assert.equal(verification.ok, true);
  assert.ok(entries.length > 0);

  const tampered = entries.map((e) => ({ ...e }));
  tampered[1].details = { ...tampered[1].details, injected: true };
  const result = verifyAuditChain(tampered, RID);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, tampered[1].seq);
});

test('非法评分与越权操作被拒绝', () => {
  const { service } = makeService();
  const { aliasOf } = setupReviewing(service);
  const alias = aliasOf.T1;
  // 分值超上限
  assert.throws(
    () => service.submitScore(reviewer('R1'), RID, { alias, materialVersion: 1, categories: cats(26) }),
    (e) => e.code === 'invalid_score',
  );
  // 缺少类目
  assert.throws(
    () => service.submitScore(reviewer('R1'), RID, { alias, materialVersion: 1, categories: { ethics: 20 } }),
    (e) => e.code === 'invalid_score',
  );
  // 评委不能代他人申报回避
  assert.throws(
    () => service.declareConflict(reviewer('R1'), RID, { reviewerId: 'R2', alias, kind: 'relative' }),
    (e) => e.status === 403,
  );
  // 评委不能执行秘书操作
  assert.throws(() => service.publish(reviewer('R1'), RID), (e) => e.status === 403);
  // 非法回避类型
  assert.throws(
    () => service.declareConflict(reviewer('R1'), RID, { alias, kind: 'friend' }),
    (e) => e.code === 'invalid_input',
  );
});
