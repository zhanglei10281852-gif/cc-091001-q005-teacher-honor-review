import { AuditLog } from './audit.js';
import { hashObject } from './canon.js';
import {
  conflictKinds,
  scoreCategories,
  reviewerKinds,
  defaultTiePolicy,
  defaultEligibilityRules,
  anonymousFields,
} from './domain.js';

export class ReviewError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const fail = (code, message, details) => {
  throw new ReviewError(code, message, details);
};

const SCORE_MIN = 0;
const SCORE_MAX = 100;
const IDENTITY_FIELDS = ['name', 'school', 'employeeId'];
const CANDIDATE_EDITABLE_FIELDS = ['name', 'school', 'employeeId', 'yearsOfService', 'ethicsRecord', 'materials', 'nominatedBy'];

const round4 = (n) => Math.round(n * 10000) / 10000;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// —— 并列处理：按 tiePolicy 依次比较，同时产出可解释的处理过程 ——
function criterionValue(entry, criterion) {
  if (criterion === 'total') return entry.total;
  if (criterion === 'alias') return entry.alias;
  return entry.categories[criterion];
}

function compareEntries(tiePolicy, a, b) {
  for (const criterion of tiePolicy) {
    const va = criterionValue(a, criterion);
    const vb = criterionValue(b, criterion);
    if (va === vb) continue;
    if (criterion === 'alias') return va < vb ? -1 : 1;
    return va > vb ? -1 : 1; // 分数高者优先
  }
  return 0;
}

function rankEntries(entries, tiePolicy) {
  const sorted = [...entries].sort((a, b) => compareEntries(tiePolicy, a, b));
  const ranked = [];
  let rank = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    if (i === 0 || compareEntries(tiePolicy, sorted[i - 1], sorted[i]) !== 0) rank = i + 1;
    ranked.push({ ...sorted[i], rank });
  }
  for (const entry of ranked) {
    entry.tied = ranked.some((other) => other !== entry && other.rank === entry.rank);
  }
  return { ranking: ranked, tieTrace: buildTieTrace(entries, tiePolicy) };
}

// 对总分相同的候选组，逐步记录每条并列规则的取值与区分结果，直到完全排序或规则耗尽（共享名次）
function buildTieTrace(entries, tiePolicy) {
  const trace = [];
  const byTotal = new Map();
  for (const e of entries) {
    const key = String(e.total);
    if (!byTotal.has(key)) byTotal.set(key, []);
    byTotal.get(key).push(e);
  }
  for (const [totalKey, group] of byTotal) {
    if (group.length < 2) continue;
    const steps = [];
    let resolved = false;
    for (let i = 1; i < tiePolicy.length; i += 1) {
      const criterion = tiePolicy[i];
      const values = {};
      for (const e of group) values[e.alias] = criterionValue(e, criterion);
      const applied = tiePolicy.slice(0, i + 1);
      const distinct = new Set(group.map((e) => applied.map((c) => String(criterionValue(e, c))).join(' '))).size;
      steps.push({ criterion, values, distinguished: distinct === group.length });
      if (distinct === group.length) {
        resolved = true;
        break;
      }
    }
    trace.push({
      total: Number(totalKey),
      candidates: group.map((e) => e.alias).sort(),
      steps,
      outcome: resolved ? 'ordered' : 'tied-shared-rank',
    });
  }
  return trace;
}

export class ReviewService {
  constructor({ clock } = {}) {
    this.clock = clock ?? (() => new Date());
    this.rounds = new Map();
    this.seq = 0;
  }

  _id(prefix) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  _now(at) {
    const d = at === undefined || at === null ? this.clock() : new Date(at);
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) fail('VALIDATION', '时间格式无效');
    return d;
  }

  _round(roundId) {
    const round = this.rounds.get(roundId);
    if (!round) fail('NOT_FOUND', `评审轮次不存在: ${roundId}`);
    return round;
  }

  _requireSecretary(actor) {
    if (!actor || actor.role !== 'secretary') fail('FORBIDDEN', '需要秘书组权限');
  }

  // 评委（含补充评委）只能操作获授权的轮次
  _requireAssignedReviewer(actor, round) {
    if (!actor || actor.role !== 'reviewer') fail('FORBIDDEN', '需要评委身份');
    const reviewer = round.reviewers.get(actor.id);
    if (!reviewer) fail('FORBIDDEN', '评委未被授权该轮次');
    return reviewer;
  }

  _audit(round, type, actor, payload, at) {
    return round.audit.append({ type, actor: actor ? { role: actor.role, id: actor.id } : null, payload, at });
  }

  _transition(round, from, to, actor, at, extra = {}) {
    if (round.state !== from) fail('BAD_STATE', `当前状态为 ${round.state}，不能从 ${from} 迁移到 ${to}`);
    round.state = to;
    this._audit(round, 'ROUND_STATE', actor, { from, to, ...extra }, at);
  }

  _activeConflict(round, reviewerId, candidateId) {
    for (const d of round.conflicts.values()) {
      if (d.status === 'active' && d.reviewerId === reviewerId && d.candidateId === candidateId) return d;
    }
    return null;
  }

  _candidateByAlias(round, alias) {
    for (const c of round.candidates.values()) {
      if (c.alias === alias) return c;
    }
    return null;
  }

  // 匿名化：只保留白名单字段，姓名、学校、工号等身份信息绝不下发给评委
  _anonymized(candidate) {
    const view = { alias: candidate.alias };
    for (const field of anonymousFields) view[field] = candidate[field];
    return view;
  }

  _invalidateScore(round, score, reason, at) {
    score.status = 'invalidated';
    score.invalidationReason = reason;
    score.invalidatedAt = at.toISOString();
  }

  // —— 轮次与提名 ——

  createRound(actor, spec = {}, at) {
    this._requireSecretary(actor);
    const when = this._now(at);
    const { roundId, quorum } = spec;
    if (!roundId || typeof roundId !== 'string') fail('VALIDATION', '缺少 roundId');
    if (this.rounds.has(roundId)) fail('CONFLICT', `评审轮次已存在: ${roundId}`);
    if (!Number.isInteger(quorum) || quorum < 1) fail('VALIDATION', '法定人数 quorum 须为正整数');
    const nominationAt = this._now(spec.nominationDeadline);
    const materialAt = this._now(spec.materialDeadline);
    if (nominationAt > materialAt) fail('VALIDATION', '提名截止不能晚于材料截止');
    const categories = spec.categories ?? [...scoreCategories];
    if (!Array.isArray(categories) || categories.length === 0 || !categories.every((c) => scoreCategories.includes(c))) {
      fail('VALIDATION', '评分类目无效');
    }
    const tiePolicy = spec.tiePolicy ?? [...defaultTiePolicy];
    if (!Array.isArray(tiePolicy) || tiePolicy.length === 0
      || !tiePolicy.every((c) => c === 'total' || c === 'alias' || categories.includes(c))) {
      fail('VALIDATION', '并列规则无效');
    }
    if (spec.slots !== undefined && spec.slots !== null && (!Number.isInteger(spec.slots) || spec.slots < 1)) {
      fail('VALIDATION', '推荐名额 slots 须为正整数');
    }
    const round = {
      roundId,
      quorum,
      nominationDeadline: nominationAt.toISOString(),
      materialDeadline: materialAt.toISOString(),
      state: 'collecting',
      categories,
      tiePolicy,
      slots: spec.slots ?? null,
      eligibilityRules: { ...defaultEligibilityRules, ...(spec.eligibilityRules ?? {}) },
      candidates: new Map(),
      reviewers: new Map(),
      conflicts: new Map(),
      scores: new Map(),
      objections: new Map(),
      signatures: new Map(),
      material: { version: 0, history: [] },
      publications: [],
      audit: new AuditLog(),
    };
    this.rounds.set(roundId, round);
    this._audit(round, 'ROUND_CREATED', actor, { roundId, quorum, categories, tiePolicy, slots: round.slots }, when);
    return { roundId, state: round.state };
  }

  addCandidate(actor, roundId, spec = {}, at) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    const when = this._now(at);
    if (round.state !== 'collecting') fail('BAD_STATE', '仅征集阶段可以登记提名');
    if (when > new Date(round.nominationDeadline)) fail('NOMINATION_CLOSED', '提名已截止');
    const { candidateId, name, school, yearsOfService, ethicsRecord, materials } = spec;
    if (!candidateId || typeof candidateId !== 'string') fail('VALIDATION', '缺少 candidateId');
    if (round.candidates.has(candidateId)) fail('CONFLICT', `候选人已登记: ${candidateId}`);
    if (!name || !school) fail('VALIDATION', '候选人姓名与单位必填');
    if (typeof yearsOfService !== 'number' || !(yearsOfService >= 0)) fail('VALIDATION', '教龄须为非负数字');
    if (!ethicsRecord || typeof ethicsRecord !== 'string') fail('VALIDATION', '缺少师德记录');
    if (!materials || typeof materials !== 'object' || Array.isArray(materials)) fail('VALIDATION', '申报材料须为对象');
    const candidate = {
      candidateId,
      name,
      school,
      employeeId: spec.employeeId ?? null,
      yearsOfService,
      ethicsRecord,
      materials,
      nominatedBy: spec.nominatedBy ?? null,
      eligibility: null,
      alias: null,
      currentVersion: 0,
      withdrawn: false,
    };
    round.candidates.set(candidateId, candidate);
    this._audit(round, 'CANDIDATE_ADDED', actor, { candidateId, name, school }, when);
    return { candidateId };
  }

  updateCandidate(actor, roundId, candidateId, changes = {}, at) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    const when = this._now(at);
    if (round.state !== 'collecting') fail('BAD_STATE', '仅征集阶段可以更正提名资料');
    const candidate = round.candidates.get(candidateId);
    if (!candidate) fail('NOT_FOUND', `候选人不存在: ${candidateId}`);
    for (const key of Object.keys(changes)) {
      if (!CANDIDATE_EDITABLE_FIELDS.includes(key)) fail('VALIDATION', `不允许修改字段: ${key}`);
    }
    Object.assign(candidate, changes);
    candidate.eligibility = null; // 资料变更后须重新核验资格
    this._audit(round, 'CANDIDATE_UPDATED', actor, { candidateId, fields: Object.keys(changes) }, when);
    return { candidateId };
  }

  withdrawCandidate(actor, roundId, candidateId, reason, at) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    const when = this._now(at);
    if (round.state !== 'collecting') fail('BAD_STATE', '封存后退出须走材料更正流程');
    const candidate = round.candidates.get(candidateId);
    if (!candidate) fail('NOT_FOUND', `候选人不存在: ${candidateId}`);
    candidate.withdrawn = true;
    this._audit(round, 'CANDIDATE_WITHDRAWN', actor, { candidateId, reason: reason ?? '' }, when);
    return { candidateId, withdrawn: true };
  }

  // 提名资格核验：按轮次规则检查教龄与师德记录，结果留痕
  verifyEligibility(actor, roundId, candidateId, at) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    const when = this._now(at);
    if (round.state !== 'collecting') fail('BAD_STATE', '仅征集阶段可以核验资格');
    const candidate = round.candidates.get(candidateId);
    if (!candidate) fail('NOT_FOUND', `候选人不存在: ${candidateId}`);
    const rules = round.eligibilityRules;
    const reasons = [];
    if (candidate.yearsOfService < rules.minYearsOfService) {
      reasons.push({ code: 'YEARS_OF_SERVICE_BELOW_MINIMUM', required: rules.minYearsOfService, actual: candidate.yearsOfService });
    }
    if (rules.requireCleanEthics && candidate.ethicsRecord !== 'clean') {
      reasons.push({ code: 'ETHICS_RECORD_NOT_CLEAN', actual: candidate.ethicsRecord });
    }
    candidate.eligibility = {
      eligible: reasons.length === 0,
      reasons,
      verifiedAt: when.toISOString(),
      verifiedBy: actor.id,
    };
    this._audit(round, 'ELIGIBILITY_VERIFIED', actor, { candidateId, eligible: candidate.eligibility.eligible, reasons }, when);
    return candidate.eligibility;
  }

  // —— 材料封存与版本 ——

  // 材料截止后封存：为合格候选人生成匿名版本（别名 + 白名单字段），内容哈希使版本可辨识
  sealMaterials(actor, roundId, at) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    const when = this._now(at);
    if (round.state !== 'collecting') fail('BAD_STATE', '仅征集阶段可以封存材料');
    if (when < new Date(round.materialDeadline)) {
      fail('DEADLINE_NOT_PASSED', '材料截止时间未到，不能封存', { materialDeadline: round.materialDeadline });
    }
    const active = [...round.candidates.values()]
      .filter((c) => !c.withdrawn)
      .sort((a, b) => (a.candidateId < b.candidateId ? -1 : 1));
    if (active.length === 0) fail('BAD_STATE', '无有效候选人，不能封存');
    const pending = active.filter((c) => !c.eligibility).map((c) => c.candidateId);
    const ineligible = active.filter((c) => c.eligibility && !c.eligibility.eligible).map((c) => c.candidateId);
    if (pending.length > 0 || ineligible.length > 0) {
      fail('ELIGIBILITY_INCOMPLETE', '存在未核验或核验不合格的提名', { pending, ineligible });
    }
    active.forEach((c, i) => {
      c.alias = `C-${String(i + 1).padStart(2, '0')}`;
      c.currentVersion = 1;
    });
    const payloads = active.map((c) => this._anonymized(c));
    const version = 1;
    const hash = hashObject({ version, payloads });
    round.material.version = version;
    round.material.history.push({
      version,
      hash,
      at: when.toISOString(),
      type: 'seal',
      reason: '材料截止封存',
      affectedCandidateIds: active.map((c) => c.candidateId),
    });
    round.state = 'sealed';
    this._audit(round, 'MATERIALS_SEALED', actor, {
      version,
      hash,
      aliases: active.map((c) => ({ candidateId: c.candidateId, alias: c.alias })),
    }, when);
    return { version, hash, aliases: active.map((c) => ({ candidateId: c.candidateId, alias: c.alias })) };
  }

  // 封存后的任何材料更正都生成新的可辨识版本，并使受影响候选人的既有评分失效（保留审计痕迹）
  amendMaterials(actor, roundId, amendment = {}, at) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    const when = this._now(at);
    if (!['sealed', 'reviewing', 'signing'].includes(round.state)) {
      fail('BAD_STATE', `当前状态 ${round.state} 不能更正材料`);
    }
    const { candidateId, changes, reason, withdraw } = amendment;
    if (!candidateId) fail('VALIDATION', '缺少 candidateId');
    if (!reason) fail('VALIDATION', '材料更正必须说明原因');
    const candidate = round.candidates.get(candidateId);
    if (!candidate || !candidate.alias) fail('NOT_FOUND', `候选人不存在或未封存: ${candidateId}`);
    if (candidate.withdrawn) fail('BAD_STATE', '候选人已退出');
    if (!withdraw) {
      if (!changes || typeof changes !== 'object') fail('VALIDATION', '缺少更正内容');
      for (const key of Object.keys(changes)) {
        if (!CANDIDATE_EDITABLE_FIELDS.includes(key)) fail('VALIDATION', `不允许修改字段: ${key}`);
      }
      Object.assign(candidate, changes);
    } else {
      candidate.withdrawn = true;
    }
    const version = round.material.version + 1;
    candidate.currentVersion = version;
    const invalidatedScoreIds = [];
    for (const score of round.scores.values()) {
      if (score.status === 'active' && score.candidateId === candidateId) {
        this._invalidateScore(round, score, withdraw ? 'CANDIDATE_WITHDRAWN' : 'MATERIAL_AMENDED', when);
        invalidatedScoreIds.push(score.id);
        this._audit(round, 'SCORE_INVALIDATED', actor, {
          scoreId: score.id,
          reviewerId: score.reviewerId,
          candidateId,
          reason: score.invalidationReason,
        }, when);
      }
    }
    const payloads = [...round.candidates.values()]
      .filter((c) => c.alias && !c.withdrawn)
      .sort((a, b) => (a.alias < b.alias ? -1 : 1))
      .map((c) => this._anonymized(c));
    const hash = hashObject({ version, payloads });
    round.material.version = version;
    round.material.history.push({
      version,
      hash,
      at: when.toISOString(),
      type: withdraw ? 'withdraw' : 'amend',
      reason,
      affectedCandidateIds: [candidateId],
    });
    this._audit(round, 'MATERIALS_AMENDED', actor, {
      version,
      hash,
      candidateId,
      reason,
      withdraw: Boolean(withdraw),
      invalidatedScoreIds,
    }, when);
    return { version, hash, invalidatedScoreIds };
  }

  // —— 评委与回避 ——

  assignReviewer(actor, roundId, spec = {}, at) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    const when = this._now(at);
    if (round.state === 'published') fail('BAD_STATE', '轮次已公布，不能指派评委');
    const { reviewerId, kind } = spec;
    if (!reviewerId || typeof reviewerId !== 'string') fail('VALIDATION', '缺少 reviewerId');
    if (!reviewerKinds.includes(kind)) fail('VALIDATION', `评委类型须为 ${reviewerKinds.join('/')}`);
    if (round.reviewers.has(reviewerId)) fail('CONFLICT', `评委已指派: ${reviewerId}`);
    round.reviewers.set(reviewerId, { reviewerId, kind, assignedAt: when.toISOString(), assignedBy: actor.id });
    this._audit(round, 'REVIEWER_ASSIGNED', actor, { reviewerId, kind }, when);
    return { reviewerId, kind };
  }

  // 回避申报：评委可申报本人关系（按真实身份），秘书组亦可代录。
  // 申报生效立即将该评委对涉事候选人的有效评分置为失效，并逐条留痕。
  declareConflict(actor, roundId, spec = {}, at) {
    const round = this._round(roundId);
    const when = this._now(at);
    const { reviewerId, identity, kind, note } = spec;
    if (!conflictKinds.includes(kind)) fail('VALIDATION', `回避关系类型须为 ${conflictKinds.join('/')}`);
    if (!round.reviewers.has(reviewerId)) fail('NOT_FOUND', `评委未被指派到该轮次: ${reviewerId}`);
    const isSelf = actor && actor.role === 'reviewer' && actor.id === reviewerId;
    if (!isSelf) this._requireSecretary(actor);
    if (round.state === 'published') fail('BAD_STATE', '轮次已公布，如需调整请先重新开启');
    const candidate = this._resolveIdentity(round, identity);
    if (candidate && this._activeConflict(round, reviewerId, candidate.candidateId)) {
      const existing = this._activeConflict(round, reviewerId, candidate.candidateId);
      return this._conflictProjection(actor, existing, []);
    }
    const declaration = {
      id: this._id('CONF'),
      reviewerId,
      candidateId: candidate ? candidate.candidateId : null,
      kind,
      note: note ?? '',
      identity: this._sanitizeIdentity(round, identity, candidate),
      status: 'active',
      declaredAt: when.toISOString(),
      declaredBy: { role: actor.role, id: actor.id },
    };
    round.conflicts.set(declaration.id, declaration);
    const invalidatedScoreIds = [];
    if (candidate) {
      for (const score of round.scores.values()) {
        if (score.status === 'active' && score.reviewerId === reviewerId && score.candidateId === candidate.candidateId) {
          this._invalidateScore(round, score, 'CONFLICT_DECLARED', when);
          invalidatedScoreIds.push(score.id);
          this._audit(round, 'SCORE_INVALIDATED', actor, {
            scoreId: score.id,
            reviewerId,
            candidateId: candidate.candidateId,
            reason: 'CONFLICT_DECLARED',
            declarationId: declaration.id,
          }, when);
        }
      }
    }
    this._audit(round, 'CONFLICT_DECLARED', actor, {
      declarationId: declaration.id,
      reviewerId,
      candidateId: declaration.candidateId,
      kind,
      matched: Boolean(candidate),
      invalidatedScoreIds,
    }, when);
    return this._conflictProjection(actor, declaration, invalidatedScoreIds);
  }

  // 撤销回避：失效评分不自动恢复（防止受质疑评分悄悄回流），评委可在撤销后重新评分
  revokeConflict(actor, roundId, declarationId, reason, at) {
    const round = this._round(roundId);
    const when = this._now(at);
    const declaration = round.conflicts.get(declarationId);
    if (!declaration) fail('NOT_FOUND', `回避申报不存在: ${declarationId}`);
    const isSelf = actor && actor.role === 'reviewer' && actor.id === declaration.reviewerId;
    if (!isSelf) this._requireSecretary(actor);
    if (declaration.status !== 'active') fail('BAD_STATE', '该回避申报已撤销');
    declaration.status = 'revoked';
    declaration.revokedAt = when.toISOString();
    declaration.revokeReason = reason ?? '';
    this._audit(round, 'CONFLICT_REVOKED', actor, {
      declarationId,
      reviewerId: declaration.reviewerId,
      candidateId: declaration.candidateId,
      reason: reason ?? '',
      note: '此前失效的评分不自动恢复，评委可基于当前材料版本重新评分',
    }, when);
    return this._conflictProjection(actor, declaration, []);
  }

  _resolveIdentity(round, identity) {
    if (!identity || typeof identity !== 'object') fail('VALIDATION', '缺少回避对象身份');
    if (identity.candidateId) {
      return round.candidates.get(identity.candidateId) ?? null;
    }
    const provided = IDENTITY_FIELDS.filter((f) => identity[f]);
    if (provided.length === 0) fail('VALIDATION', '回避对象身份须至少包含姓名、单位或工号之一');
    const matches = [...round.candidates.values()].filter(
      (c) => !c.withdrawn && provided.every((f) => c[f] === identity[f]),
    );
    if (matches.length > 1) fail('AMBIGUOUS_IDENTITY', '身份信息匹配到多名候选人，请补充单位或工号');
    return matches[0] ?? null;
  }

  _sanitizeIdentity(round, identity, candidate) {
    const safe = {};
    for (const f of IDENTITY_FIELDS) {
      if (identity && identity[f]) safe[f] = identity[f];
    }
    // 秘书组按 candidateId 代录时，回填姓名与单位，便于评委本人核对自己的申报记录
    if (Object.keys(safe).length === 0 && candidate) {
      safe.name = candidate.name;
      safe.school = candidate.school;
    }
    return safe;
  }

  // 评委视角的申报回执不含 candidateId/alias，避免泄露匿名映射
  _conflictProjection(actor, declaration, invalidatedScoreIds) {
    if (actor.role === 'reviewer') {
      return { declarationId: declaration.id, status: declaration.status === 'active' ? 'recorded' : declaration.status };
    }
    return { ...declaration, invalidatedScoreIds };
  }

  // —— 评分 ——

  // 评分必须基于当前材料版本；重复提交视为重新评分，旧评分被取代但保留痕迹
  submitScore(actor, roundId, spec = {}, at) {
    const round = this._round(roundId);
    const when = this._now(at);
    const reviewer = this._requireAssignedReviewer(actor, round);
    if (round.state !== 'reviewing') fail('BAD_STATE', `当前状态 ${round.state} 不能评分`);
    const { alias, materialVersion, values } = spec;
    if (materialVersion !== round.material.version) {
      fail('STALE_MATERIAL_VERSION', '评分必须基于当前材料版本', { current: round.material.version });
    }
    const candidate = this._candidateByAlias(round, alias);
    // 对“别名不存在”与“存在回避关系”返回同一错误码与文案，防止评委反推匿名映射
    if (!candidate || candidate.withdrawn) fail('CANDIDATE_NOT_ACTIONABLE', '候选人不在你的评审范围内');
    if (this._activeConflict(round, reviewer.reviewerId, candidate.candidateId)) {
      fail('CANDIDATE_NOT_ACTIONABLE', '候选人不在你的评审范围内');
    }
    if (!values || typeof values !== 'object') fail('VALIDATION', '缺少评分值');
    const keys = Object.keys(values).sort();
    const expected = [...round.categories].sort();
    if (keys.length !== expected.length || !expected.every((c, i) => keys[i] === c)) {
      fail('VALIDATION', `评分须完整覆盖类目: ${round.categories.join(', ')}`);
    }
    for (const cat of round.categories) {
      const v = values[cat];
      if (typeof v !== 'number' || Number.isNaN(v) || v < SCORE_MIN || v > SCORE_MAX) {
        fail('VALIDATION', `类目 ${cat} 分值须在 ${SCORE_MIN}~${SCORE_MAX} 之间`);
      }
    }
    const existing = [...round.scores.values()].find(
      (s) => s.status === 'active' && s.reviewerId === reviewer.reviewerId && s.candidateId === candidate.candidateId,
    );
    const score = {
      id: this._id('SCORE'),
      reviewerId: reviewer.reviewerId,
      candidateId: candidate.candidateId,
      materialVersion,
      values: { ...values },
      status: 'active',
      submittedAt: when.toISOString(),
    };
    round.scores.set(score.id, score);
    let supersededScoreId = null;
    if (existing) {
      existing.status = 'superseded';
      existing.supersededBy = score.id;
      existing.supersededAt = when.toISOString();
      supersededScoreId = existing.id;
      this._audit(round, 'SCORE_SUPERSEDED', actor, { scoreId: existing.id, by: score.id }, when);
    }
    this._audit(round, 'SCORE_SUBMITTED', actor, {
      scoreId: score.id,
      reviewerId: reviewer.reviewerId,
      candidateId: candidate.candidateId,
      materialVersion,
      values: score.values,
    }, when);
    return { scoreId: score.id, materialVersion, superseded: supersededScoreId };
  }

  // —— 异议 ——

  raiseObjection(actor, roundId, spec = {}, at) {
    const round = this._round(roundId);
    const when = this._now(at);
    if (!actor || !['secretary', 'reviewer'].includes(actor.role)) fail('FORBIDDEN', '需要秘书组或评委身份');
    if (round.state === 'collecting') fail('BAD_STATE', '材料封存后方可提出异议');
    const { text } = spec;
    if (!text || typeof text !== 'string') fail('VALIDATION', '异议内容必填');
    let candidateId = null;
    if (actor.role === 'reviewer') {
      this._requireAssignedReviewer(actor, round);
      if (spec.alias) {
        const candidate = this._candidateByAlias(round, spec.alias);
        if (!candidate) fail('CANDIDATE_NOT_ACTIONABLE', '候选人不在你的评审范围内');
        candidateId = candidate.candidateId;
      }
    } else if (spec.candidateId) {
      if (!round.candidates.has(spec.candidateId)) fail('NOT_FOUND', `候选人不存在: ${spec.candidateId}`);
      candidateId = spec.candidateId;
    }
    const objection = {
      id: this._id('OBJ'),
      candidateId,
      text,
      raisedBy: { role: actor.role, id: actor.id },
      raisedAt: when.toISOString(),
      status: 'open',
    };
    round.objections.set(objection.id, objection);
    this._audit(round, 'OBJECTION_RAISED', actor, { objectionId: objection.id, candidateId, text }, when);
    if (actor.role === 'reviewer') return { objectionId: objection.id, status: 'open' };
    return objection;
  }

  resolveObjection(actor, roundId, objectionId, resolution = {}, at) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    const when = this._now(at);
    const objection = round.objections.get(objectionId);
    if (!objection) fail('NOT_FOUND', `异议不存在: ${objectionId}`);
    if (objection.status !== 'open') fail('BAD_STATE', '该异议已处理');
    const { outcome, note } = resolution;
    if (!['resolved', 'dismissed'].includes(outcome)) fail('VALIDATION', '处理结果须为 resolved 或 dismissed');
    objection.status = outcome;
    objection.resolution = note ?? '';
    objection.resolvedAt = when.toISOString();
    this._audit(round, 'OBJECTION_RESOLVED', actor, { objectionId, outcome, note: note ?? '' }, when);
    return objection;
  }

  // —— 流程推进 ——

  startReview(actor, roundId, at) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    const when = this._now(at);
    this._transition(round, 'sealed', 'reviewing', actor, when);
    return { roundId, state: round.state };
  }

  closeScoring(actor, roundId, at) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    const when = this._now(at);
    this._transition(round, 'reviewing', 'signing', actor, when);
    return { roundId, state: round.state };
  }

  reopenScoring(actor, roundId, reason, at) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    const when = this._now(at);
    if (!reason) fail('VALIDATION', '重新开放评分必须说明原因');
    this._transition(round, 'signing', 'reviewing', actor, when, { reason });
    return { roundId, state: round.state };
  }

  // 公布后如需更正，重新开启轮次；再次公布将生成新的公布版本
  reopenRound(actor, roundId, reason, at) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    const when = this._now(at);
    if (!reason) fail('VALIDATION', '重新开启轮次必须说明原因');
    this._transition(round, 'published', 'reviewing', actor, when, {
      reason,
      publicationVersion: round.publications.length,
    });
    return { roundId, state: round.state };
  }

  // —— 计票与签署 ——

  // 计票只统计：有效状态、基于候选人当前材料版本、评分人无有效回避的评分
  _tally(round) {
    const perCandidate = [];
    for (const c of round.candidates.values()) {
      if (!c.alias || c.withdrawn) continue;
      const conflicted = new Set(
        [...round.conflicts.values()]
          .filter((d) => d.status === 'active' && d.candidateId === c.candidateId)
          .map((d) => d.reviewerId),
      );
      const effectiveReviewers = [...round.reviewers.keys()].filter((id) => !conflicted.has(id));
      const counted = [...round.scores.values()].filter(
        (s) => s.status === 'active'
          && s.candidateId === c.candidateId
          && s.materialVersion === c.currentVersion
          && round.reviewers.has(s.reviewerId)
          && !conflicted.has(s.reviewerId),
      );
      const categories = {};
      for (const cat of round.categories) {
        categories[cat] = counted.length === 0 ? null : round4(mean(counted.map((s) => s.values[cat])));
      }
      const total = counted.length === 0
        ? null
        : round4(mean(counted.map((s) => round.categories.reduce((acc, cat) => acc + s.values[cat], 0))));
      perCandidate.push({
        candidateId: c.candidateId,
        alias: c.alias,
        currentVersion: c.currentVersion,
        effectiveReviewers: effectiveReviewers.length,
        scoredCount: counted.length,
        quorumMet: effectiveReviewers.length >= round.quorum,
        categories,
        total,
        countedScoreIds: counted.map((s) => s.id).sort(),
      });
    }
    const tallyHash = hashObject({
      materialVersion: round.material.version,
      quorum: round.quorum,
      categories: round.categories,
      tiePolicy: round.tiePolicy,
      candidates: perCandidate
        .map((p) => ({ candidateId: p.candidateId, currentVersion: p.currentVersion, countedScoreIds: p.countedScoreIds }))
        .sort((a, b) => (a.candidateId < b.candidateId ? -1 : 1)),
    });
    const { ranking, tieTrace } = rankEntries(perCandidate.filter((p) => p.total !== null), round.tiePolicy);
    return { materialVersion: round.material.version, perCandidate, tallyHash, ranking, tieTrace };
  }

  // 评委获取签署包：当前材料版本与计票哈希，签署必须与之完全一致
  getSigningPackage(actor, roundId) {
    const round = this._round(roundId);
    const reviewer = this._requireAssignedReviewer(actor, round);
    const tally = this._tally(round);
    const mine = round.signatures.get(reviewer.reviewerId);
    return {
      roundId,
      state: round.state,
      materialVersion: tally.materialVersion,
      tallyHash: tally.tallyHash,
      alreadySigned: Boolean(mine),
      signatureCurrent: Boolean(mine && mine.materialVersion === tally.materialVersion && mine.tallyHash === tally.tallyHash),
    };
  }

  // 签署与重新评分必须基于同一材料版本：版本或计票哈希不符即拒绝
  sign(actor, roundId, spec = {}, at) {
    const round = this._round(roundId);
    const when = this._now(at);
    const reviewer = this._requireAssignedReviewer(actor, round);
    if (round.state !== 'signing') fail('BAD_STATE', `当前状态 ${round.state} 不能签署`);
    const tally = this._tally(round);
    if (spec.materialVersion !== round.material.version) {
      fail('SIGNATURE_VERSION_STALE', '签署的材料版本已过期，请重新获取签署包', { current: round.material.version });
    }
    if (spec.tallyHash !== tally.tallyHash) {
      fail('TALLY_STALE', '计票结果已变化，请重新获取签署包后再签署');
    }
    round.signatures.set(reviewer.reviewerId, {
      reviewerId: reviewer.reviewerId,
      materialVersion: spec.materialVersion,
      tallyHash: spec.tallyHash,
      signedAt: when.toISOString(),
    });
    this._audit(round, 'SIGNED', actor, { reviewerId: reviewer.reviewerId, materialVersion: spec.materialVersion, tallyHash: spec.tallyHash }, when);
    return { signed: true, materialVersion: spec.materialVersion, tallyHash: spec.tallyHash };
  }

  _validSignatures(round, tally) {
    return [...round.signatures.values()].filter(
      (s) => s.materialVersion === round.material.version && s.tallyHash === tally.tallyHash,
    );
  }

  // 公布阻塞原因：秘书组据此获得明确、可执行的解释
  _blockers(round) {
    const reasons = [];
    if (round.state !== 'signing') {
      reasons.push({
        code: 'ROUND_NOT_IN_SIGNING',
        message: `当前状态为 ${round.state}，须处于 signing 才能公布`,
        details: { state: round.state },
      });
    }
    const tally = this._tally(round);
    for (const p of tally.perCandidate) {
      if (p.effectiveReviewers < round.quorum) {
        reasons.push({
          code: 'QUORUM_NOT_MET',
          message: `候选人 ${p.alias} 的有效评审人数为 ${p.effectiveReviewers}，低于法定人数 ${round.quorum}（回避后人数不足，可补充评委）`,
          details: { candidateId: p.candidateId, alias: p.alias, effective: p.effectiveReviewers, required: round.quorum },
        });
      } else if (p.scoredCount < round.quorum) {
        reasons.push({
          code: 'INSUFFICIENT_SCORES',
          message: `候选人 ${p.alias} 的有效评分数为 ${p.scoredCount}，低于法定人数 ${round.quorum}`,
          details: { candidateId: p.candidateId, alias: p.alias, scored: p.scoredCount, required: round.quorum },
        });
      }
    }
    const open = [...round.objections.values()].filter((o) => o.status === 'open');
    if (open.length > 0) {
      reasons.push({
        code: 'OPEN_OBJECTIONS',
        message: `存在 ${open.length} 条未处理异议`,
        details: { objectionIds: open.map((o) => o.id) },
      });
    }
    const valid = this._validSignatures(round, tally);
    const stale = round.signatures.size - valid.length;
    if (stale > 0) {
      reasons.push({
        code: 'SIGNATURES_STALE',
        message: `${stale} 份签署基于过期的材料版本或旧计票结果，须重新签署`,
        details: { stale, currentMaterialVersion: round.material.version, currentTallyHash: tally.tallyHash },
      });
    }
    if (valid.length < round.quorum) {
      reasons.push({
        code: 'INSUFFICIENT_SIGNATURES',
        message: `有效签署 ${valid.length} 份，不足法定人数 ${round.quorum}`,
        details: { valid: valid.length, required: round.quorum },
      });
    }
    return reasons;
  }

  getPublicationBlockers(actor, roundId) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    return this._blockers(round);
  }

  // 公布：阻塞原因清零后方可执行；公布内容包含规则计算过程与签署摘要，并带内容哈希
  publish(actor, roundId, at) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    const when = this._now(at);
    const blockers = this._blockers(round);
    if (blockers.length > 0) {
      fail('PUBLICATION_BLOCKED', '存在阻塞原因，无法公布', { reasons: blockers });
    }
    const tally = this._tally(round);
    const valid = this._validSignatures(round, tally);
    const publication = {
      publicationVersion: round.publications.length + 1,
      roundId,
      publishedAt: when.toISOString(),
      materialVersion: round.material.version,
      materialHash: round.material.history[round.material.history.length - 1].hash,
      quorum: round.quorum,
      slots: round.slots,
      ruleExplanation: {
        categories: round.categories,
        aggregation: '每位评委对候选人四类目打分，类目分之和为个人总分；候选人得分为全部有效评委个人总分的平均值（保留 4 位小数）',
        quorumRule: '有效评审人数 = 已指派评委 − 对该候选人存在有效回避的评委，须不低于法定人数；有效评分数同样须不低于法定人数',
        tiePolicy: round.tiePolicy,
        slots: round.slots,
      },
      results: tally.ranking.map((r) => {
        const c = round.candidates.get(r.candidateId);
        return {
          rank: r.rank,
          tied: r.tied,
          candidateId: r.candidateId,
          name: c.name,
          school: c.school,
          alias: r.alias,
          total: r.total,
          categories: r.categories,
          scoredCount: r.scoredCount,
          effectiveReviewers: r.effectiveReviewers,
          quorumMet: r.quorumMet,
          recommended: round.slots === null ? null : r.rank <= round.slots,
        };
      }),
      tieTrace: tally.tieTrace,
      signingSummary: {
        required: round.quorum,
        valid: valid.length,
        tallyHash: tally.tallyHash,
        signers: valid
          .map((s) => ({ reviewerId: s.reviewerId, signedAt: s.signedAt }))
          .sort((a, b) => (a.reviewerId < b.reviewerId ? -1 : 1)),
      },
      objectionsSummary: {
        resolved: [...round.objections.values()].filter((o) => o.status === 'resolved').length,
        dismissed: [...round.objections.values()].filter((o) => o.status === 'dismissed').length,
      },
      withdrawn: [...round.candidates.values()]
        .filter((c) => c.alias && c.withdrawn)
        .map((c) => ({ alias: c.alias, candidateId: c.candidateId })),
      supersedes: round.publications.length === 0 ? null : round.publications[round.publications.length - 1].publicationVersion,
    };
    publication.hash = hashObject(publication);
    round.publications.push(publication);
    round.state = 'published';
    this._audit(round, 'PUBLISHED', actor, {
      publicationVersion: publication.publicationVersion,
      hash: publication.hash,
      materialVersion: publication.materialVersion,
    }, when);
    return publication;
  }

  // 公布结果对社会公开，无需身份
  getPublication(roundId) {
    const round = this._round(roundId);
    if (round.publications.length === 0) fail('NOT_FOUND', '该轮次尚未公布');
    return round.publications[round.publications.length - 1];
  }

  // —— 视图 ——

  // 评委视图：仅匿名白名单字段；存在有效回避的候选人整体不可见；
  // 不下发法定人数、计票、他人评分与回避信息，防止反推
  getReviewerView(actor, roundId) {
    const round = this._round(roundId);
    const reviewer = this._requireAssignedReviewer(actor, round);
    const conflictedIds = new Set(
      [...round.conflicts.values()]
        .filter((d) => d.status === 'active' && d.reviewerId === reviewer.reviewerId && d.candidateId)
        .map((d) => d.candidateId),
    );
    const candidates = [...round.candidates.values()]
      .filter((c) => c.alias && !c.withdrawn && !conflictedIds.has(c.candidateId))
      .map((c) => this._anonymized(c))
      .sort((a, b) => (a.alias < b.alias ? -1 : 1));
    const myScores = [...round.scores.values()]
      .filter((s) => s.reviewerId === reviewer.reviewerId)
      .map((s) => ({
        scoreId: s.id,
        alias: round.candidates.get(s.candidateId)?.alias ?? null,
        values: s.values,
        materialVersion: s.materialVersion,
        status: s.status,
        submittedAt: s.submittedAt,
      }));
    const myDeclarations = [...round.conflicts.values()]
      .filter((d) => d.reviewerId === reviewer.reviewerId)
      .map((d) => ({
        declarationId: d.id,
        kind: d.kind,
        note: d.note,
        status: d.status,
        declaredAt: d.declaredAt,
        identity: d.identity,
      }));
    return {
      roundId,
      state: round.state,
      materialVersion: round.material.version,
      categories: round.categories,
      candidates,
      myScores,
      myDeclarations,
    };
  }

  // 秘书组视图：完整内部状态（含身份映射、回避、评分、异议、签署、阻塞原因）
  getSecretaryView(actor, roundId) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    const tally = this._tally(round);
    return {
      roundId,
      state: round.state,
      quorum: round.quorum,
      categories: round.categories,
      tiePolicy: round.tiePolicy,
      slots: round.slots,
      eligibilityRules: round.eligibilityRules,
      nominationDeadline: round.nominationDeadline,
      materialDeadline: round.materialDeadline,
      materialVersion: round.material.version,
      materialHistory: round.material.history.map((h) => ({ ...h })),
      candidates: [...round.candidates.values()].map((c) => ({ ...c, materials: c.materials })),
      reviewers: [...round.reviewers.values()].map((r) => ({ ...r })),
      conflicts: [...round.conflicts.values()].map((d) => ({ ...d })),
      scores: [...round.scores.values()].map((s) => ({ ...s })),
      objections: [...round.objections.values()].map((o) => ({ ...o })),
      signatures: [...round.signatures.values()].map((s) => ({ ...s })),
      tally,
      blockers: this._blockers(round),
      publications: round.publications.map((p) => ({
        publicationVersion: p.publicationVersion,
        publishedAt: p.publishedAt,
        materialVersion: p.materialVersion,
        hash: p.hash,
      })),
      audit: {
        length: round.audit.events.length,
        headHash: round.audit.events.length === 0 ? null : round.audit.events[round.audit.events.length - 1].hash,
        ...round.audit.verify(),
      },
    };
  }

  getAuditLog(actor, roundId) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    return round.audit.events.map((e) => ({ ...e }));
  }

  verifyAudit(actor, roundId) {
    this._requireSecretary(actor);
    const round = this._round(roundId);
    return round.audit.verify();
  }
}
