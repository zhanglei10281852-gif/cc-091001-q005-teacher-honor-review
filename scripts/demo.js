// 演示：一次完整的评审轮次（含回避、补充评委、材料更正与重新签署）
import { ReviewService } from '../src/review-service.js';

const SEC = { role: 'secretary', id: 'sec-1' };
const rv = (id) => ({ role: 'reviewer', id });
const now = { d: new Date('2026-07-01T00:00:00Z') };
const service = new ReviewService({ clock: () => now.d });
const say = (text) => console.log(`\n== ${text}`);

say('创建轮次并登记提名');
service.createRound(SEC, {
  roundId: 'ROUND-2026-DEMO',
  quorum: 3,
  slots: 1,
  nominationDeadline: '2026-08-01T00:00:00Z',
  materialDeadline: '2026-09-01T00:00:00Z',
});
for (const [id, name, school] of [
  ['t1', '张伟', '第一中学'],
  ['t2', '李芳', '第二中学'],
  ['t3', '王强', '第三中学'],
]) {
  service.addCandidate(SEC, 'ROUND-2026-DEMO', {
    candidateId: id, name, school, yearsOfService: 12, ethicsRecord: 'clean',
    materials: { achievements: `${name}的教学事迹`, ethicsNarrative: '师德自述' }, nominatedBy: '校工会',
  });
  service.verifyEligibility(SEC, 'ROUND-2026-DEMO', id);
}

say('材料截止，封存并生成匿名版本');
now.d = new Date('2026-09-02T00:00:00Z');
const sealed = service.sealMaterials(SEC, 'ROUND-2026-DEMO');
console.log('材料版本:', sealed.version, '哈希:', sealed.hash.slice(0, 16) + '…');
console.log('匿名映射（仅秘书组可见）:', sealed.aliases.map((a) => `${a.candidateId}→${a.alias}`).join(', '));

say('指派评委并开始评审');
for (const r of ['r1', 'r2', 'r3']) service.assignReviewer(SEC, 'ROUND-2026-DEMO', { reviewerId: r, kind: 'regular' });
service.startReview(SEC, 'ROUND-2026-DEMO');
const score = (r, alias, total) => service.submitScore(rv(r), 'ROUND-2026-DEMO', {
  alias, materialVersion: 1,
  values: { ethics: total, teaching: total, 'student-development': total, 'public-service': total },
});
score('r1', 'C-01', 88); score('r1', 'C-02', 90); score('r1', 'C-03', 85);
score('r2', 'C-01', 86); score('r2', 'C-02', 91); score('r2', 'C-03', 84);

say('评委 r3 临时申报与张伟（第一中学）为亲属关系');
service.declareConflict(rv('r3'), 'ROUND-2026-DEMO', {
  reviewerId: 'r3', identity: { name: '张伟', school: '第一中学' }, kind: 'relative', note: '直系亲属',
});
let blockers = service.getPublicationBlockers(SEC, 'ROUND-2026-DEMO');
console.log('回避后阻塞原因（节选）:', blockers.find((b) => b.code === 'QUORUM_NOT_MET')?.message ?? '无');

say('补充评委 r4 加入该轮次并完成评分');
service.assignReviewer(SEC, 'ROUND-2026-DEMO', { reviewerId: 'r4', kind: 'supplementary' });
score('r3', 'C-02', 89); score('r3', 'C-03', 83); // r3 的评审范围已不含 C-01
score('r4', 'C-01', 87); score('r4', 'C-02', 90); score('r4', 'C-03', 86);

say('收取异议并处理');
const objection = service.raiseObjection(SEC, 'ROUND-2026-DEMO', { candidateId: 't2', text: '群众反映材料有一处时间存疑' });
service.resolveObjection(SEC, 'ROUND-2026-DEMO', objection.id, { outcome: 'resolved', note: '已核实为笔误，不影响资格' });

say('关闭评分并签署');
service.closeScoring(SEC, 'ROUND-2026-DEMO');
for (const r of ['r1', 'r2', 'r3', 'r4']) {
  service.sign(rv(r), 'ROUND-2026-DEMO', service.getSigningPackage(rv(r), 'ROUND-2026-DEMO'));
}

say('公布结果');
const pub = service.publish(SEC, 'ROUND-2026-DEMO');
for (const r of pub.results) {
  console.log(`第 ${r.rank} 名 ${r.name}（${r.school}）总分 ${r.total}，有效评审 ${r.effectiveReviewers} 人${r.recommended ? '，列入推荐' : ''}`);
}
console.log('签署摘要:', `${pub.signingSummary.valid}/${pub.signingSummary.required} 份有效签署`);
console.log('公布哈希:', pub.hash.slice(0, 16) + '…');
console.log('审计链校验:', JSON.stringify(service.verifyAudit(SEC, 'ROUND-2026-DEMO')));
