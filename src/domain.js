export const roundStates = ['collecting', 'sealed', 'reviewing', 'signing', 'published'];
export const conflictKinds = ['relative', 'same-school', 'direct-supervision', 'declared-other'];
export const objectionStates = ['open', 'resolved', 'dismissed'];
export const scoreCategories = ['ethics', 'teaching', 'student-development', 'public-service'];

// 评分生命周期：active（有效）→ superseded（被本人重评取代）/ invalidated（因回避或材料更正失效，保留审计痕迹）
export const scoreStatuses = ['active', 'superseded', 'invalidated'];
export const scoreInvalidationReasons = ['CONFLICT_DECLARED', 'MATERIAL_AMENDED', 'CANDIDATE_WITHDRAWN'];

// regular 为初始评委，supplementary 为回避导致人数不足时补充的评委（仅可见获授权轮次）
export const reviewerKinds = ['regular', 'supplementary'];

// 匿名化白名单：评委视图中候选人仅暴露这些字段，身份信息一律不下发
export const anonymousFields = ['yearsOfService', 'materials'];

// 并列处理默认顺序：总分 → 师德 → 教学 → 学生发展 → 公益服务 → 别名（稳定兜底，保证结果可复现）
export const defaultTiePolicy = ['total', 'ethics', 'teaching', 'student-development', 'public-service', 'alias'];

// 提名资格核验默认规则
export const defaultEligibilityRules = { minYearsOfService: 5, requireCleanEthics: true };

// 公布阻塞原因代码（秘书组据此获得明确解释）
export const publicationBlockerCodes = [
  'ROUND_NOT_IN_SIGNING',
  'QUORUM_NOT_MET',
  'INSUFFICIENT_SCORES',
  'OPEN_OBJECTIONS',
  'SIGNATURES_STALE',
  'INSUFFICIENT_SIGNATURES',
];
