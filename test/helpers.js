import { ReviewService } from '../src/service.js';

export const SECRETARY = { role: 'secretary' };
export const reviewer = (reviewerId) => ({ role: 'reviewer', reviewerId });

export function makeService() {
  const service = new ReviewService({ now: () => '2026-09-18T08:00:00.000Z' });
  const secretaryToken = service.createSecretaryToken();
  return { service, secretaryToken };
}

export const CANDIDATES = [
  { candidateId: 'T1', name: '张老师', school: '第一中学', materials: '事迹材料甲（已匿名化）' },
  { candidateId: 'T2', name: '李老师', school: '第二中学', materials: '事迹材料乙（已匿名化）' },
  { candidateId: 'T3', name: '王老师', school: '第三中学', materials: '事迹材料丙（已匿名化）' },
];

export function makeRound(service, overrides = {}) {
  const input = {
    roundId: 'ROUND-1',
    quorum: 3,
    awardCount: 2,
    reviewerIds: ['R1', 'R2', 'R3', 'R4', 'R5'],
    candidates: CANDIDATES,
    ...overrides,
  };
  const { reviewerTokens } = service.createRound(SECRETARY, input);
  return { input, reviewerTokens };
}

// 建立到评分阶段，返回 别名 -> candidateId 映射
export function setupReviewing(service, overrides = {}) {
  const { input, reviewerTokens } = makeRound(service, overrides);
  service.closeMaterials(SECRETARY, input.roundId);
  service.openReview(SECRETARY, input.roundId);
  const view = service.getRoundForSecretary(SECRETARY, input.roundId);
  const aliasOf = Object.fromEntries(view.candidates.map((c) => [c.candidateId, c.alias]));
  return { input, reviewerTokens, aliasOf, aliases: Object.values(aliasOf).sort() };
}

export function cats(v) {
  return { ethics: v, teaching: v, 'student-development': v, 'public-service': v };
}

// 全体评委给所有候选人评分；scoreOf(alias) 返回每类目分值
export function scoreAll(service, roundId, reviewerIds, aliases, materialVersion, scoreOf) {
  for (const rid of reviewerIds) {
    for (const alias of aliases) {
      service.submitScore(reviewer(rid), roundId, {
        alias,
        materialVersion,
        categories: cats(scoreOf(alias)),
      });
    }
  }
}
