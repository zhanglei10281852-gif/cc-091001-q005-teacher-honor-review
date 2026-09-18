import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../src/review-service.js';

const SEC = { role: 'secretary', id: 'sec-1' };
const rv = (id) => ({ role: 'reviewer', id });

const candidateSpec = (id, over = {}) => ({
  candidateId: id,
  name: `张伟${id}`,
  school: `第一中学${id}`,
  yearsOfService: 10,
  ethicsRecord: 'clean',
  materials: { note: `材料${id}` },
  ...over,
});

function setup() {
  const now = { d: new Date('2026-07-01T00:00:00Z') };
  const s = new ReviewService({ clock: () => now.d });
  s.createRound(SEC, {
    roundId: 'R-1',
    quorum: 2,
    nominationDeadline: '2026-08-01T00:00:00Z',
    materialDeadline: '2026-09-01T00:00:00Z',
  });
  for (const id of ['a', 'b']) {
    s.addCandidate(SEC, 'R-1', candidateSpec(id));
    s.verifyEligibility(SEC, 'R-1', id);
  }
  now.d = new Date('2026-09-02T00:00:00Z');
  s.sealMaterials(SEC, 'R-1');
  for (const r of ['r1', 'r2']) s.assignReviewer(SEC, 'R-1', { reviewerId: r, kind: 'regular' });
  s.startReview(SEC, 'R-1');
  return s;
}

test('评委视图不含任何身份信息，只有匿名白名单字段', () => {
  const s = setup();
  const view = s.getReviewerView(rv('r1'), 'R-1');
  const text = JSON.stringify(view);
  assert.ok(!text.includes('张伟'), '不得泄露姓名');
  assert.ok(!text.includes('第一中学'), '不得泄露单位');
  assert.equal(view.candidates.length, 2);
  for (const c of view.candidates) {
    assert.deepEqual(Object.keys(c).sort(), ['alias', 'materials', 'yearsOfService']);
  }
  // 视图不下发法定人数、计票、他人评分等可反推信息
  assert.equal(view.quorum, undefined);
  assert.equal(view.tally, undefined);
  assert.equal(view.conflicts, undefined);
});

test('回避申报回执与申报列表均不泄露别名映射', () => {
  const s = setup();
  const receipt = s.declareConflict(rv('r1'), 'R-1', {
    reviewerId: 'r1',
    identity: { name: '张伟a', school: '第一中学a' },
    kind: 'relative',
  });
  assert.ok(!('candidateId' in receipt) && !('alias' in receipt));
  const view = s.getReviewerView(rv('r1'), 'R-1');
  assert.equal(view.myDeclarations.length, 1);
  assert.ok(!('candidateId' in view.myDeclarations[0]));
  assert.ok(!('alias' in view.myDeclarations[0]));
  assert.equal(view.myDeclarations[0].identity.name, '张伟a'); // 本人申报时提供的信息可以回显
});

test('对回避候选人与不存在别名的评分返回同一错误，防止反推', () => {
  const s = setup();
  s.declareConflict(rv('r1'), 'R-1', { reviewerId: 'r1', identity: { name: '张伟a', school: '第一中学a' }, kind: 'relative' });
  const values = { ethics: 80, teaching: 80, 'student-development': 80, 'public-service': 80 };
  let conflicted;
  try { s.submitScore(rv('r1'), 'R-1', { alias: 'C-01', materialVersion: 1, values }); } catch (e) { conflicted = e; }
  let nonexistent;
  try { s.submitScore(rv('r1'), 'R-1', { alias: 'C-99', materialVersion: 1, values }); } catch (e) { nonexistent = e; }
  assert.equal(conflicted.code, 'CANDIDATE_NOT_ACTIONABLE');
  assert.equal(nonexistent.code, 'CANDIDATE_NOT_ACTIONABLE');
  assert.equal(conflicted.message, nonexistent.message);
});

test('补充评委只能看到获授权轮次', () => {
  const s = setup();
  s.createRound(SEC, {
    roundId: 'R-2',
    quorum: 1,
    nominationDeadline: '2026-08-01T00:00:00Z',
    materialDeadline: '2026-09-01T00:00:00Z',
  });
  s.assignReviewer(SEC, 'R-1', { reviewerId: 'supp-1', kind: 'supplementary' });
  const view = s.getReviewerView(rv('supp-1'), 'R-1');
  assert.equal(view.roundId, 'R-1');
  assert.throws(() => s.getReviewerView(rv('supp-1'), 'R-2'), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => s.getReviewerView(rv('outsider'), 'R-1'), (e) => e.code === 'FORBIDDEN');
});

test('评委无法访问秘书组接口与审计日志', () => {
  const s = setup();
  assert.throws(() => s.getSecretaryView(rv('r1'), 'R-1'), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => s.getPublicationBlockers(rv('r1'), 'R-1'), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => s.getAuditLog(rv('r1'), 'R-1'), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => s.verifyAudit(rv('r1'), 'R-1'), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => s.getReviewerView(null, 'R-1'), (e) => e.code === 'FORBIDDEN');
});

test('评委视图不暴露他人评分，仅本人评分（失效原因中立化）', () => {
  const s = setup();
  const values = { ethics: 80, teaching: 80, 'student-development': 80, 'public-service': 80 };
  s.submitScore(rv('r1'), 'R-1', { alias: 'C-01', materialVersion: 1, values });
  s.submitScore(rv('r2'), 'R-1', { alias: 'C-01', materialVersion: 1, values });
  const view = s.getReviewerView(rv('r1'), 'R-1');
  assert.equal(view.myScores.length, 1);
  assert.ok(!('reviewerId' in view.myScores[0]) || view.myScores[0].reviewerId === undefined);
  // 因回避失效后，评委只看到中立状态，不暴露具体原因
  s.declareConflict(rv('r1'), 'R-1', { reviewerId: 'r1', identity: { name: '张伟a', school: '第一中学a' }, kind: 'relative' });
  const after = s.getReviewerView(rv('r1'), 'R-1');
  assert.equal(after.myScores[0].status, 'invalidated');
  assert.ok(!('invalidationReason' in after.myScores[0]));
});
