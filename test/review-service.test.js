import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService, ReviewError } from '../src/review-service.js';

const SEC = { role: 'secretary', id: 'sec-1' };
const rv = (id) => ({ role: 'reviewer', id });

// 可推进的时钟：征集期在 7 月，材料截止 9-01，封存及以后在 9-02
const newService = () => {
  const now = { d: new Date('2026-07-01T00:00:00Z') };
  const service = new ReviewService({ clock: () => now.d });
  service.setNow = (d) => { now.d = new Date(d); };
  return service;
};

const roundSpec = (over = {}) => ({
  roundId: 'R-1',
  quorum: 2,
  nominationDeadline: '2026-08-01T00:00:00Z',
  materialDeadline: '2026-09-01T00:00:00Z',
  ...over,
});

const candidateSpec = (id, over = {}) => ({
  candidateId: id,
  name: `教师${id}`,
  school: `学校${id}`,
  yearsOfService: 10,
  ethicsRecord: 'clean',
  materials: { note: `材料${id}` },
  nominatedBy: '工会小组',
  ...over,
});

const fullMarks = (v) => ({ ethics: v, teaching: v, 'student-development': v, 'public-service': v });

// 建一个已封存、已指派评委、处于 reviewing 的轮次；候选人 a→C-01, b→C-02
function reviewingRound(service, { candidateIds = ['a', 'b'], reviewers = ['r1', 'r2', 'r3'], quorum = 2 } = {}) {
  service.createRound(SEC, roundSpec({ quorum }));
  for (const id of candidateIds) {
    service.addCandidate(SEC, 'R-1', candidateSpec(id));
    service.verifyEligibility(SEC, 'R-1', id);
  }
  service.setNow('2026-09-02T00:00:00Z');
  service.sealMaterials(SEC, 'R-1');
  for (const r of reviewers) service.assignReviewer(SEC, 'R-1', { reviewerId: r, kind: 'regular' });
  service.startReview(SEC, 'R-1');
  return service;
}

function scoreByAll(service, alias, value, reviewers = ['r1', 'r2', 'r3'], version = 1) {
  for (const r of reviewers) {
    service.submitScore(rv(r), 'R-1', { alias, materialVersion: version, values: fullMarks(value) });
  }
}

test('资格核验：教龄不足与师德记录不合格将被拦截，更正后可重新核验', () => {
  const s = newService();
  s.createRound(SEC, roundSpec());
  s.addCandidate(SEC, 'R-1', candidateSpec('junior', { yearsOfService: 2 }));
  s.addCandidate(SEC, 'R-1', candidateSpec('flagged', { ethicsRecord: 'warned-2024' }));
  const r1 = s.verifyEligibility(SEC, 'R-1', 'junior');
  assert.equal(r1.eligible, false);
  assert.equal(r1.reasons[0].code, 'YEARS_OF_SERVICE_BELOW_MINIMUM');
  const r2 = s.verifyEligibility(SEC, 'R-1', 'flagged');
  assert.equal(r2.eligible, false);
  assert.equal(r2.reasons[0].code, 'ETHICS_RECORD_NOT_CLEAN');
  // 核验不合格或未核验都不能封存
  s.setNow('2026-09-02T00:00:00Z');
  assert.throws(() => s.sealMaterials(SEC, 'R-1'), (e) => e.code === 'ELIGIBILITY_INCOMPLETE' && e.details.ineligible.length === 2);
  s.setNow('2026-07-01T00:00:00Z');
  // 更正资料后重新核验通过
  s.updateCandidate(SEC, 'R-1', 'junior', { yearsOfService: 8 });
  s.updateCandidate(SEC, 'R-1', 'flagged', { ethicsRecord: 'clean' });
  assert.equal(s.verifyEligibility(SEC, 'R-1', 'junior').eligible, true);
  assert.equal(s.verifyEligibility(SEC, 'R-1', 'flagged').eligible, true);
  s.setNow('2026-09-02T00:00:00Z');
  const sealed = s.sealMaterials(SEC, 'R-1');
  assert.equal(sealed.version, 1);
  assert.ok(sealed.hash);
});

test('截止控制：提名截止后不能登记，材料截止前不能封存', () => {
  const s = new ReviewService({ clock: () => new Date('2026-07-15T00:00:00Z') });
  s.createRound(SEC, roundSpec());
  assert.throws(() => s.sealMaterials(SEC, 'R-1'), (e) => e.code === 'DEADLINE_NOT_PASSED');
  const late = new ReviewService({ clock: () => new Date('2026-09-18T00:00:00Z') });
  late.createRound(SEC, roundSpec());
  assert.throws(() => late.addCandidate(SEC, 'R-1', candidateSpec('x')), (e) => e.code === 'NOMINATION_CLOSED');
});

test('封存生成匿名版本：别名稳定、内容哈希可辨识', () => {
  const s = newService();
  s.createRound(SEC, roundSpec());
  s.addCandidate(SEC, 'R-1', candidateSpec('b'));
  s.addCandidate(SEC, 'R-1', candidateSpec('a'));
  s.verifyEligibility(SEC, 'R-1', 'a');
  s.verifyEligibility(SEC, 'R-1', 'b');
  s.setNow('2026-09-02T00:00:00Z');
  const sealed = s.sealMaterials(SEC, 'R-1');
  assert.deepEqual(sealed.aliases, [
    { candidateId: 'a', alias: 'C-01' },
    { candidateId: 'b', alias: 'C-02' },
  ]);
  const view = s.getSecretaryView(SEC, 'R-1');
  assert.equal(view.materialVersion, 1);
  assert.equal(view.materialHistory.length, 1);
});

test('评分：必须基于当前材料版本，重新评分取代旧分并留痕', () => {
  const s = reviewingRound(newService());
  assert.throws(
    () => s.submitScore(rv('r1'), 'R-1', { alias: 'C-01', materialVersion: 99, values: fullMarks(80) }),
    (e) => e.code === 'STALE_MATERIAL_VERSION' && e.details.current === 1,
  );
  const first = s.submitScore(rv('r1'), 'R-1', { alias: 'C-01', materialVersion: 1, values: fullMarks(80) });
  const second = s.submitScore(rv('r1'), 'R-1', { alias: 'C-01', materialVersion: 1, values: fullMarks(90) });
  assert.equal(second.superseded, first.scoreId);
  const scores = s.getSecretaryView(SEC, 'R-1').scores;
  assert.equal(scores.find((x) => x.id === first.scoreId).status, 'superseded');
  assert.equal(scores.find((x) => x.id === second.scoreId).status, 'active');
  // 类目不完整或越界被拒绝
  assert.throws(
    () => s.submitScore(rv('r2'), 'R-1', { alias: 'C-01', materialVersion: 1, values: { ethics: 80 } }),
    (e) => e.code === 'VALIDATION',
  );
  assert.throws(
    () => s.submitScore(rv('r2'), 'R-1', { alias: 'C-01', materialVersion: 1, values: { ...fullMarks(80), ethics: 101 } }),
    (e) => e.code === 'VALIDATION',
  );
});

test('回避申报：立即失效受影响评分并留痕，回避候选人从评委视图消失', () => {
  const s = reviewingRound(newService());
  s.submitScore(rv('r1'), 'R-1', { alias: 'C-01', materialVersion: 1, values: fullMarks(80) });
  const receipt = s.declareConflict(rv('r1'), 'R-1', {
    reviewerId: 'r1',
    identity: { name: '教师a', school: '学校a' },
    kind: 'relative',
    note: '直系亲属',
  });
  assert.deepEqual(Object.keys(receipt).sort(), ['declarationId', 'status']); // 回执不含别名映射
  const view = s.getSecretaryView(SEC, 'R-1');
  const score = view.scores.find((x) => x.reviewerId === 'r1');
  assert.equal(score.status, 'invalidated');
  assert.equal(score.invalidationReason, 'CONFLICT_DECLARED');
  const reviewerView = s.getReviewerView(rv('r1'), 'R-1');
  assert.deepEqual(reviewerView.candidates.map((c) => c.alias), ['C-02']);
  // 审计链包含申报与失效两条痕迹
  const types = s.getAuditLog(SEC, 'R-1').map((e) => e.type);
  assert.ok(types.includes('CONFLICT_DECLARED'));
  assert.ok(types.includes('SCORE_INVALIDATED'));
});

test('回避撤销：失效评分不自动恢复，评委可重新评分', () => {
  const s = reviewingRound(newService());
  s.submitScore(rv('r1'), 'R-1', { alias: 'C-01', materialVersion: 1, values: fullMarks(80) });
  s.declareConflict(rv('r1'), 'R-1', { reviewerId: 'r1', identity: { name: '教师a', school: '学校a' }, kind: 'declared-other' });
  const declaration = s.getSecretaryView(SEC, 'R-1').conflicts[0];
  s.revokeConflict(SEC, 'R-1', declaration.id, '申报有误');
  const scores = s.getSecretaryView(SEC, 'R-1').scores.filter((x) => x.reviewerId === 'r1');
  assert.equal(scores[0].status, 'invalidated'); // 不自动恢复
  const again = s.submitScore(rv('r1'), 'R-1', { alias: 'C-01', materialVersion: 1, values: fullMarks(85) });
  assert.ok(again.scoreId);
});

test('法定人数：回避导致有效评审人数不足时给出明确阻塞原因，补充评委后解除', () => {
  const s = reviewingRound(newService(), { quorum: 3, reviewers: ['r1', 'r2', 'r3'] });
  scoreByAll(s, 'C-01', 80);
  scoreByAll(s, 'C-02', 85);
  s.declareConflict(SEC, 'R-1', { reviewerId: 'r1', identity: { candidateId: 'a' }, kind: 'same-school' });
  s.closeScoring(SEC, 'R-1');
  const blockers = s.getPublicationBlockers(SEC, 'R-1');
  const quorumBlocker = blockers.find((b) => b.code === 'QUORUM_NOT_MET');
  assert.ok(quorumBlocker, '应报告法定人数不足');
  assert.equal(quorumBlocker.details.alias, 'C-01');
  assert.equal(quorumBlocker.details.effective, 2);
  assert.equal(quorumBlocker.details.required, 3);
  // 补充评委只能加入获授权轮次，加入后人数恢复
  s.assignReviewer(SEC, 'R-1', { reviewerId: 'r4', kind: 'supplementary' });
  s.reopenScoring(SEC, 'R-1', '补充评委后补评分');
  s.submitScore(rv('r4'), 'R-1', { alias: 'C-01', materialVersion: 1, values: fullMarks(82) });
  s.submitScore(rv('r4'), 'R-1', { alias: 'C-02', materialVersion: 1, values: fullMarks(86) });
  s.closeScoring(SEC, 'R-1');
  const after = s.getPublicationBlockers(SEC, 'R-1');
  assert.ok(!after.some((b) => b.code === 'QUORUM_NOT_MET'));
});

test('材料更正：生成新可辨识版本，受影响评分失效，旧签署过期', () => {
  const s = reviewingRound(newService());
  scoreByAll(s, 'C-01', 80);
  scoreByAll(s, 'C-02', 85);
  s.closeScoring(SEC, 'R-1');
  for (const r of ['r1', 'r2', 'r3']) s.sign(rv(r), 'R-1', s.getSigningPackage(rv(r), 'R-1'));
  assert.equal(s.getPublicationBlockers(SEC, 'R-1').length, 0);
  const amended = s.amendMaterials(SEC, 'R-1', { candidateId: 'a', changes: { materials: { note: '补充获奖证明' } }, reason: '候选人补充材料' });
  assert.equal(amended.version, 2);
  assert.notEqual(amended.hash, s.getSecretaryView(SEC, 'R-1').materialHistory[0].hash);
  assert.equal(amended.invalidatedScoreIds.length, 3); // C-01 的三份评分失效
  const blockers = s.getPublicationBlockers(SEC, 'R-1');
  assert.ok(blockers.some((b) => b.code === 'SIGNATURES_STALE'));
  assert.ok(blockers.some((b) => b.code === 'INSUFFICIENT_SCORES'));
  assert.throws(() => s.publish(SEC, 'R-1'), (e) => e.code === 'PUBLICATION_BLOCKED' && e.details.reasons.length > 0);
  // 未受影响的 C-02 评分仍然计入，C-01 须基于 v2 重新评分
  s.reopenScoring(SEC, 'R-1', '材料更正后重新评分');
  scoreByAll(s, 'C-01', 81, ['r1', 'r2', 'r3'], 2);
  s.closeScoring(SEC, 'R-1');
  for (const r of ['r1', 'r2', 'r3']) s.sign(rv(r), 'R-1', s.getSigningPackage(rv(r), 'R-1'));
  const pub = s.publish(SEC, 'R-1');
  assert.equal(pub.materialVersion, 2);
  assert.equal(pub.results.length, 2);
});

test('签署必须基于同一材料版本与当前计票', () => {
  const s = reviewingRound(newService());
  scoreByAll(s, 'C-01', 80);
  scoreByAll(s, 'C-02', 85);
  s.closeScoring(SEC, 'R-1');
  const pkg = s.getSigningPackage(rv('r1'), 'R-1');
  assert.throws(
    () => s.sign(rv('r1'), 'R-1', { materialVersion: pkg.materialVersion + 1, tallyHash: pkg.tallyHash }),
    (e) => e.code === 'SIGNATURE_VERSION_STALE',
  );
  assert.throws(
    () => s.sign(rv('r1'), 'R-1', { materialVersion: pkg.materialVersion, tallyHash: 'deadbeef' }),
    (e) => e.code === 'TALLY_STALE',
  );
  const ok = s.sign(rv('r1'), 'R-1', pkg);
  assert.equal(ok.signed, true);
});
