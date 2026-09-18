import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../src/review-service.js';

const SEC = { role: 'secretary', id: 'sec-1' };
const rv = (id) => ({ role: 'reviewer', id });

const newService = () => {
  const now = { d: new Date('2026-07-01T00:00:00Z') };
  const service = new ReviewService({ clock: () => now.d });
  service.setNow = (d) => { now.d = new Date(d); };
  return service;
};

const candidateSpec = (id, over = {}) => ({
  candidateId: id,
  name: `教师${id}`,
  school: `学校${id}`,
  yearsOfService: 10,
  ethicsRecord: 'clean',
  materials: { note: `材料${id}` },
  ...over,
});

function setup(service, { candidateIds = ['a', 'b'], reviewers = ['r1', 'r2'], quorum = 2, extra = {} } = {}) {
  service.createRound(SEC, {
    roundId: 'R-1',
    quorum,
    nominationDeadline: '2026-08-01T00:00:00Z',
    materialDeadline: '2026-09-01T00:00:00Z',
    ...extra,
  });
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

function signAll(service, reviewers = ['r1', 'r2']) {
  for (const r of reviewers) service.sign(rv(r), 'R-1', service.getSigningPackage(rv(r), 'R-1'));
}

test('公布结果包含规则计算过程、并列处理过程与签署摘要', () => {
  const s = setup(newService(), { extra: { slots: 1 } });
  // 两位候选人总分相同，师德分不同 → 并列规则应给出解释
  const a = { ethics: 90, teaching: 80, 'student-development': 70, 'public-service': 60 };
  const b = { ethics: 80, teaching: 90, 'student-development': 70, 'public-service': 60 };
  for (const r of ['r1', 'r2']) {
    s.submitScore(rv(r), 'R-1', { alias: 'C-01', materialVersion: 1, values: a });
    s.submitScore(rv(r), 'R-1', { alias: 'C-02', materialVersion: 1, values: b });
  }
  s.closeScoring(SEC, 'R-1');
  signAll(s);
  const pub = s.publish(SEC, 'R-1');
  assert.equal(pub.results[0].alias, 'C-01'); // 师德 90 > 80
  assert.equal(pub.results[0].name, '教师a');
  assert.equal(pub.results[0].recommended, true);
  assert.equal(pub.results[1].recommended, false);
  assert.equal(pub.tieTrace.length, 1);
  assert.equal(pub.tieTrace[0].total, 300);
  assert.deepEqual(pub.tieTrace[0].candidates, ['C-01', 'C-02']);
  assert.equal(pub.tieTrace[0].steps[0].criterion, 'ethics');
  assert.equal(pub.tieTrace[0].steps[0].distinguished, true);
  assert.equal(pub.tieTrace[0].outcome, 'ordered');
  assert.equal(pub.signingSummary.valid, 2);
  assert.equal(pub.signingSummary.required, 2);
  assert.equal(pub.signingSummary.signers.length, 2);
  assert.ok(pub.signingSummary.tallyHash);
  assert.ok(pub.ruleExplanation.tiePolicy.includes('ethics'));
  assert.ok(pub.hash);
  assert.equal(s.getSecretaryView(SEC, 'R-1').state, 'published');
});

test('完全并列且规则未覆盖时共享名次', () => {
  const s = setup(newService(), { extra: { tiePolicy: ['total'] } });
  const same = { ethics: 80, teaching: 80, 'student-development': 80, 'public-service': 80 };
  for (const r of ['r1', 'r2']) {
    s.submitScore(rv(r), 'R-1', { alias: 'C-01', materialVersion: 1, values: same });
    s.submitScore(rv(r), 'R-1', { alias: 'C-02', materialVersion: 1, values: same });
  }
  s.closeScoring(SEC, 'R-1');
  signAll(s);
  const pub = s.publish(SEC, 'R-1');
  assert.equal(pub.results[0].rank, 1);
  assert.equal(pub.results[1].rank, 1);
  assert.equal(pub.results[0].tied, true);
  assert.equal(pub.tieTrace[0].outcome, 'tied-shared-rank');
});

test('未处理异议阻塞公布，处理后解除', () => {
  const s = setup(newService());
  const v = { ethics: 80, teaching: 80, 'student-development': 80, 'public-service': 80 };
  for (const r of ['r1', 'r2']) {
    s.submitScore(rv(r), 'R-1', { alias: 'C-01', materialVersion: 1, values: v });
    s.submitScore(rv(r), 'R-1', { alias: 'C-02', materialVersion: 1, values: v });
  }
  s.closeScoring(SEC, 'R-1');
  signAll(s);
  const objection = s.raiseObjection(SEC, 'R-1', { candidateId: 'a', text: '申报材料真实性待核' });
  const blockers = s.getPublicationBlockers(SEC, 'R-1');
  assert.ok(blockers.some((b) => b.code === 'OPEN_OBJECTIONS' && b.details.objectionIds.includes(objection.id)));
  assert.throws(() => s.publish(SEC, 'R-1'), (e) => e.code === 'PUBLICATION_BLOCKED');
  s.resolveObjection(SEC, 'R-1', objection.id, { outcome: 'resolved', note: '已核实无误' });
  assert.equal(s.getPublicationBlockers(SEC, 'R-1').length, 0);
  const pub = s.publish(SEC, 'R-1');
  assert.equal(pub.objectionsSummary.resolved, 1);
});

test('评委可按别名提出异议', () => {
  const s = setup(newService());
  const objection = s.raiseObjection(rv('r1'), 'R-1', { alias: 'C-01', text: '课堂实录与材料不符' });
  assert.deepEqual(Object.keys(objection).sort(), ['objectionId', 'status']);
  const view = s.getSecretaryView(SEC, 'R-1');
  assert.equal(view.objections[0].candidateId, 'a');
  assert.equal(view.objections[0].status, 'open');
});

test('公布后再更正会形成新的可辨识版本', () => {
  const s = setup(newService());
  const v = { ethics: 80, teaching: 80, 'student-development': 80, 'public-service': 80 };
  for (const r of ['r1', 'r2']) {
    s.submitScore(rv(r), 'R-1', { alias: 'C-01', materialVersion: 1, values: v });
    s.submitScore(rv(r), 'R-1', { alias: 'C-02', materialVersion: 1, values: v });
  }
  s.closeScoring(SEC, 'R-1');
  signAll(s);
  const first = s.publish(SEC, 'R-1');
  assert.equal(first.publicationVersion, 1);
  // 事后更正：重新开启 → 材料更正 → 重评 → 重签 → 再公布
  s.reopenRound(SEC, 'R-1', '接到举报需更正材料');
  s.amendMaterials(SEC, 'R-1', { candidateId: 'a', changes: { materials: { note: '更正后材料' } }, reason: '材料勘误' });
  for (const r of ['r1', 'r2']) {
    s.submitScore(rv(r), 'R-1', { alias: 'C-01', materialVersion: 2, values: v });
  }
  s.closeScoring(SEC, 'R-1');
  signAll(s);
  const second = s.publish(SEC, 'R-1');
  assert.equal(second.publicationVersion, 2);
  assert.equal(second.supersedes, 1);
  assert.equal(second.materialVersion, 2);
  assert.notEqual(second.hash, first.hash);
  assert.equal(s.getPublication('R-1').publicationVersion, 2);
  const history = s.getSecretaryView(SEC, 'R-1').publications;
  assert.equal(history.length, 2); // 两个版本都可追溯
});

test('签署不足法定人数时阻塞公布', () => {
  const s = setup(newService(), { quorum: 2 });
  const v = { ethics: 80, teaching: 80, 'student-development': 80, 'public-service': 80 };
  for (const r of ['r1', 'r2']) {
    s.submitScore(rv(r), 'R-1', { alias: 'C-01', materialVersion: 1, values: v });
    s.submitScore(rv(r), 'R-1', { alias: 'C-02', materialVersion: 1, values: v });
  }
  s.closeScoring(SEC, 'R-1');
  s.sign(rv('r1'), 'R-1', s.getSigningPackage(rv('r1'), 'R-1'));
  const blockers = s.getPublicationBlockers(SEC, 'R-1');
  assert.ok(blockers.some((b) => b.code === 'INSUFFICIENT_SIGNATURES' && b.details.valid === 1));
});

test('状态机约束：未到签署阶段不能公布', () => {
  const s = setup(newService());
  const blockers = s.getPublicationBlockers(SEC, 'R-1');
  assert.ok(blockers.some((b) => b.code === 'ROUND_NOT_IN_SIGNING'));
});
