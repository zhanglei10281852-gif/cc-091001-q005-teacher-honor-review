import { randomUUID } from 'node:crypto';
import {
  conflictKinds,
  scoringRules,
  canonicalize,
  sha256Hex,
  digestOf,
  validateCategoryScores,
  normalizeCategories,
  totalOf,
  aggregateScores,
  rankCandidates,
  verifyAuditChain,
} from './domain.js';

export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const newId = (prefix) => `${prefix}_${randomUUID()}`;

/**
 * 评审轮次服务。核心不变式：
 * 1. 评分必须绑定提交时的当前材料版本；材料变更后旧评分立即转为 stale。
 * 2. 回避关系一经申报，该评委对相应候选人的有效评分立即失效（记录保留在审计链）。
 * 3. 结果版本（resultVersion）的摘要包含材料版本，签署只认当前结果版本；
 *    重新评分与最终签署因此必然基于同一材料版本。
 * 4. 法定人数不足、存在未处理异议、签署不足或签署版本过期时不得公布。
 * 5. 评委只能看到获授权轮次的匿名信息；未授权轮次一律按“不存在”回应。
 */
export class ReviewService {
  constructor({ now } = {}) {
    this.now = now ?? (() => new Date().toISOString());
    this.rounds = new Map(); // roundId -> round
    this.tokens = new Map(); // token -> principal
    this.grants = new Map(); // reviewerId -> Set<roundId>
  }

  // ---------- 令牌与主体 ----------

  adoptToken(token, principal) {
    this.tokens.set(token, principal);
    return token;
  }

  issueToken(principal) {
    return this.adoptToken(newId('tok'), principal);
  }

  createSecretaryToken() {
    return this.issueToken({ role: 'secretary' });
  }

  authenticate(token) {
    return token ? this.tokens.get(token) ?? null : null;
  }

  _requireSecretary(principal) {
    if (!principal || principal.role !== 'secretary') {
      throw new ApiError(403, 'forbidden', '仅秘书组可执行该操作');
    }
  }

  _getRound(roundId) {
    const round = this.rounds.get(roundId);
    if (!round) throw new ApiError(404, 'not_found', '评审轮次不存在');
    return round;
  }

  // 评委访问：未获授权的轮次按不存在处理，避免泄露轮次及候选人信息
  _getRoundForReviewer(principal, roundId) {
    if (!principal || principal.role !== 'reviewer') {
      throw new ApiError(403, 'forbidden', '仅评委可执行该操作');
    }
    const round = this.rounds.get(roundId);
    const granted = this.grants.get(principal.reviewerId);
    if (!round || !granted || !granted.has(roundId)) {
      throw new ApiError(404, 'not_found', '评审轮次不存在');
    }
    return round;
  }

  _grant(reviewerId, roundId) {
    if (!this.grants.has(reviewerId)) this.grants.set(reviewerId, new Set());
    this.grants.get(reviewerId).add(roundId);
  }

  // ---------- 审计链 ----------

  _audit(round, actor, action, details = {}) {
    const prevHash = round.audit.length
      ? round.audit[round.audit.length - 1].hash
      : sha256Hex(`genesis:${round.id}`);
    const entry = {
      seq: round.audit.length + 1,
      ts: this.now(),
      actor: actor.role === 'secretary' ? 'secretary' : `reviewer:${actor.reviewerId}`,
      action,
      details,
      prevHash,
    };
    entry.hash = sha256Hex(canonicalize(entry));
    round.audit.push(entry);
    return entry;
  }

  // ---------- 轮次生命周期 ----------

  createRound(principal, input = {}) {
    this._requireSecretary(principal);
    const { roundId, quorum, awardCount, reviewerIds = [], candidates = [] } = input;
    if (!roundId || typeof roundId !== 'string') throw new ApiError(400, 'invalid_input', '缺少 roundId');
    if (this.rounds.has(roundId)) throw new ApiError(409, 'round_exists', '评审轮次已存在');
    if (!Number.isInteger(quorum) || quorum < 1) throw new ApiError(400, 'invalid_input', '法定人数 quorum 须为正整数');
    if (!Number.isInteger(awardCount) || awardCount < 1) throw new ApiError(400, 'invalid_input', '入选名额 awardCount 须为正整数');
    if (!Array.isArray(candidates) || candidates.length === 0) throw new ApiError(400, 'invalid_input', '候选人名单不能为空');
    if (awardCount > candidates.length) throw new ApiError(400, 'invalid_input', '入选名额不能超过候选人数');
    if (!Array.isArray(reviewerIds) || new Set(reviewerIds).size !== reviewerIds.length) {
      throw new ApiError(400, 'invalid_input', '评委名单为空或存在重复');
    }
    if (reviewerIds.length < quorum) throw new ApiError(400, 'invalid_input', '评委人数不得少于法定人数');

    const candidateMap = new Map();
    for (const c of candidates) {
      if (!c || !c.candidateId || !c.name) throw new ApiError(400, 'invalid_input', '候选人缺少 candidateId 或 name');
      if (candidateMap.has(c.candidateId)) throw new ApiError(400, 'invalid_input', `候选人 ${c.candidateId} 重复`);
      candidateMap.set(c.candidateId, {
        id: c.candidateId,
        name: c.name,
        school: c.school ?? null,
        materials: typeof c.materials === 'string' ? c.materials : '',
        status: 'active',
        alias: null,
      });
    }

    const round = {
      id: roundId,
      state: 'collecting',
      quorum,
      awardCount,
      rules: scoringRules,
      candidates: candidateMap,
      aliasMap: new Map(), // alias -> candidateId（真实身份仅秘书可见）
      materialVersions: [],
      currentMaterialVersion: 0,
      reviewers: new Map(),
      scores: [],
      conflicts: [],
      objections: [],
      resultVersions: [],
      currentResultVersion: null,
      signatures: [],
      publications: [],
      audit: [],
    };
    const reviewerTokens = {};
    for (const rid of reviewerIds) {
      round.reviewers.set(rid, { reviewerId: rid, role: 'regular', addedAt: this.now() });
      this._grant(rid, roundId);
      reviewerTokens[rid] = this.issueToken({ role: 'reviewer', reviewerId: rid });
    }
    this.rounds.set(roundId, round);
    this._audit(round, principal, 'round.created', {
      quorum,
      awardCount,
      reviewers: reviewerIds,
      candidateCount: candidates.length,
    });
    return { roundId, state: round.state, reviewerTokens };
  }

  // 材料截止：生成匿名材料版本。别名按哈希排序分配，与报名顺序无关。
  closeMaterials(principal, roundId) {
    this._requireSecretary(principal);
    const round = this._getRound(roundId);
    if (round.state !== 'collecting') throw new ApiError(409, 'bad_state', '材料已截止封存');
    this._assignAliases(round);
    const version = this._sealMaterialVersion(round, '材料截止，生成匿名评审版本');
    round.state = 'sealed';
    this._audit(round, principal, 'materials.sealed', {
      version: version.version,
      hash: version.hash,
      aliases: [...round.aliasMap.keys()],
    });
    return { roundId, state: round.state, materialVersion: version.version, materialHash: version.hash };
  }

  _assignAliases(round) {
    const unaliased = [...round.candidates.values()].filter((c) => !c.alias);
    unaliased.sort((a, b) => {
      const ha = sha256Hex(`${round.id}:${a.id}`);
      const hb = sha256Hex(`${round.id}:${b.id}`);
      return ha < hb ? -1 : ha > hb ? 1 : 0;
    });
    let next = round.aliasMap.size + 1;
    for (const c of unaliased) {
      const alias = `C-${String(next).padStart(2, '0')}`;
      c.alias = alias;
      round.aliasMap.set(alias, c.id);
      next += 1;
    }
  }

  _sealMaterialVersion(round, note) {
    const version = round.currentMaterialVersion + 1;
    const materials = {};
    for (const [alias, cid] of round.aliasMap) {
      const c = round.candidates.get(cid);
      materials[alias] = { status: c.status, materials: c.materials };
    }
    const hash = digestOf({ roundId: round.id, version, materials });
    const record = { version, hash, note, createdAt: this.now(), materials };
    round.materialVersions.push(record);
    round.currentMaterialVersion = version;
    return record;
  }

  // 材料事后变更：形成新的可辨识版本，旧版本评分立即失效（记录保留）
  amendMaterials(principal, roundId, input = {}) {
    this._requireSecretary(principal);
    const round = this._getRound(roundId);
    if (!['sealed', 'reviewing', 'signing', 'published'].includes(round.state)) {
      throw new ApiError(409, 'bad_state', '当前状态不能变更材料');
    }
    const { changes = [], newCandidates = [], withdrawAliases = [], note = '' } = input;
    if (!changes.length && !newCandidates.length && !withdrawAliases.length) {
      throw new ApiError(400, 'invalid_input', '变更内容为空');
    }
    for (const ch of changes) {
      const cid = round.aliasMap.get(ch.alias);
      if (!cid) throw new ApiError(404, 'not_found', `匿名编号 ${ch.alias} 不存在`);
      if (round.candidates.get(cid).status !== 'active') {
        throw new ApiError(409, 'bad_state', `候选人 ${ch.alias} 已退出，不能修改材料`);
      }
      if (typeof ch.materials !== 'string' || !ch.materials) {
        throw new ApiError(400, 'invalid_input', '材料内容不能为空');
      }
    }
    for (const alias of withdrawAliases) {
      if (!round.aliasMap.has(alias)) throw new ApiError(404, 'not_found', `匿名编号 ${alias} 不存在`);
    }
    for (const nc of newCandidates) {
      if (!nc || !nc.candidateId || !nc.name) throw new ApiError(400, 'invalid_input', '新增候选人缺少 candidateId 或 name');
      if (round.candidates.has(nc.candidateId)) throw new ApiError(409, 'invalid_input', `候选人 ${nc.candidateId} 已存在`);
    }

    for (const ch of changes) {
      round.candidates.get(round.aliasMap.get(ch.alias)).materials = ch.materials;
    }
    for (const nc of newCandidates) {
      round.candidates.set(nc.candidateId, {
        id: nc.candidateId,
        name: nc.name,
        school: nc.school ?? null,
        materials: typeof nc.materials === 'string' ? nc.materials : '',
        status: 'active',
        alias: null,
      });
    }
    this._assignAliases(round);
    for (const alias of withdrawAliases) {
      round.candidates.get(round.aliasMap.get(alias)).status = 'withdrawn';
    }
    const version = this._sealMaterialVersion(round, note || '材料变更');

    const staled = [];
    for (const s of round.scores) {
      if (s.status === 'valid') {
        s.status = 'stale';
        staled.push(s.scoreId);
      }
    }
    if (round.state === 'signing' || round.state === 'published') {
      // 材料版本已变，原结果版本与签署全部过期，重新开放评分
      round.state = 'reviewing';
      round.currentResultVersion = null;
      this._audit(round, principal, 'round.reopened', {
        reason: '材料变更形成新版本，需重新评分与签署',
        materialVersion: version.version,
      });
    }
    this._audit(round, principal, 'materials.amended', {
      version: version.version,
      hash: version.hash,
      note,
      changedAliases: changes.map((c) => c.alias),
      newAliases: newCandidates.map((nc) => round.candidates.get(nc.candidateId).alias),
      withdrawnAliases: withdrawAliases,
      staledScoreIds: staled,
    });
    return {
      roundId,
      state: round.state,
      materialVersion: version.version,
      materialHash: version.hash,
      staledScores: staled.length,
    };
  }

  openReview(principal, roundId) {
    this._requireSecretary(principal);
    const round = this._getRound(roundId);
    if (round.state !== 'sealed') throw new ApiError(409, 'bad_state', '仅封存状态可开放评分');
    round.state = 'reviewing';
    this._audit(round, principal, 'round.opened', { materialVersion: round.currentMaterialVersion });
    return { roundId, state: round.state };
  }

  // 补充评委：仅获得本轮次授权，看不到其他轮次
  addReviewer(principal, roundId, input = {}) {
    this._requireSecretary(principal);
    const round = this._getRound(roundId);
    if (round.state === 'published') throw new ApiError(409, 'bad_state', '轮次已公布，不能追加评委');
    const { reviewerId, role = 'supplementary' } = input;
    if (!reviewerId) throw new ApiError(400, 'invalid_input', '缺少 reviewerId');
    if (round.reviewers.has(reviewerId)) throw new ApiError(409, 'reviewer_exists', '评委已在该轮次中');
    round.reviewers.set(reviewerId, { reviewerId, role, addedAt: this.now() });
    this._grant(reviewerId, roundId);
    const token = this.issueToken({ role: 'reviewer', reviewerId });
    this._audit(round, principal, 'reviewer.added', { reviewerId, role });
    return { roundId, reviewerId, role, token };
  }

  // ---------- 回避 ----------

  declareConflict(principal, roundId, input = {}) {
    if (!principal) throw new ApiError(401, 'unauthenticated', '未认证');
    const { alias, kind } = input;
    if (!conflictKinds.includes(kind)) {
      throw new ApiError(400, 'invalid_input', `回避关系类型须为: ${conflictKinds.join(', ')}`);
    }
    let round;
    let rid;
    if (principal.role === 'secretary') {
      round = this._getRound(roundId);
      rid = input.reviewerId;
      if (!rid || !round.reviewers.has(rid)) throw new ApiError(404, 'not_found', '评委不存在');
    } else if (principal.role === 'reviewer') {
      round = this._getRoundForReviewer(principal, roundId);
      if (input.reviewerId && input.reviewerId !== principal.reviewerId) {
        throw new ApiError(403, 'forbidden', '评委只能申报本人回避关系');
      }
      rid = principal.reviewerId;
    } else {
      throw new ApiError(403, 'forbidden', '无权操作');
    }
    if (!['sealed', 'reviewing', 'signing'].includes(round.state)) {
      throw new ApiError(409, 'bad_state', '当前状态不能申报回避');
    }
    if (!round.aliasMap.has(alias)) throw new ApiError(404, 'not_found', `匿名编号 ${alias} 不存在`);
    if (round.conflicts.some((c) => c.reviewerId === rid && c.alias === alias && c.active)) {
      throw new ApiError(409, 'conflict_exists', '该回避关系已存在');
    }
    const conflict = {
      conflictId: newId('conf'),
      reviewerId: rid,
      alias,
      kind,
      declaredBy: principal.role,
      declaredAt: this.now(),
      active: true,
      retractedAt: null,
    };
    round.conflicts.push(conflict);
    // 受影响评分立即失效，记录保留在审计链中
    const invalidated = [];
    for (const s of round.scores) {
      if (s.reviewerId === rid && s.alias === alias && s.status === 'valid') {
        s.status = 'invalidated';
        s.invalidatedBy = conflict.conflictId;
        invalidated.push(s.scoreId);
      }
    }
    this._audit(round, principal, 'conflict.declared', {
      conflictId: conflict.conflictId,
      reviewerId: rid,
      alias,
      kind,
      invalidatedScoreIds: invalidated,
    });
    if (invalidated.length) this._refreshResultIfSigning(round, principal, `回避申报 ${conflict.conflictId}`);
    return { conflictId: conflict.conflictId, invalidatedScores: invalidated.length };
  }

  retractConflict(principal, roundId, conflictId) {
    this._requireSecretary(principal);
    const round = this._getRound(roundId);
    const conflict = round.conflicts.find((c) => c.conflictId === conflictId);
    if (!conflict) throw new ApiError(404, 'not_found', '回避记录不存在');
    if (!conflict.active) throw new ApiError(409, 'bad_state', '回避关系已解除');
    conflict.active = false;
    conflict.retractedAt = this.now();
    // 已失效评分不自动恢复，评委需重新评分，保证过程可追溯
    this._audit(round, principal, 'conflict.retracted', {
      conflictId,
      reviewerId: conflict.reviewerId,
      alias: conflict.alias,
    });
    return { conflictId, active: false };
  }

  _hasActiveConflict(round, reviewerId, alias) {
    return round.conflicts.some((c) => c.reviewerId === reviewerId && c.alias === alias && c.active);
  }

  // ---------- 评分 ----------

  submitScore(principal, roundId, input = {}) {
    const round = this._getRoundForReviewer(principal, roundId);
    if (round.state !== 'reviewing') throw new ApiError(409, 'bad_state', '当前状态不接收评分');
    const { alias, materialVersion } = input;
    const cid = round.aliasMap.get(alias);
    if (!cid) throw new ApiError(404, 'not_found', `匿名编号 ${alias} 不存在`);
    if (round.candidates.get(cid).status !== 'active') {
      throw new ApiError(409, 'bad_state', '该候选人已退出评审');
    }
    if (materialVersion !== round.currentMaterialVersion) {
      throw new ApiError(409, 'version_mismatch', '评分必须基于当前材料版本', {
        currentMaterialVersion: round.currentMaterialVersion,
      });
    }
    if (this._hasActiveConflict(round, principal.reviewerId, alias)) {
      throw new ApiError(409, 'recused', '已申报回避，不能对该候选人评分');
    }
    const errors = validateCategoryScores(input.categories);
    if (errors.length) throw new ApiError(400, 'invalid_score', '评分不合法', { errors });
    const categories = normalizeCategories(input.categories);
    const replaced = round.scores.find(
      (s) => s.reviewerId === principal.reviewerId && s.alias === alias
        && s.materialVersion === materialVersion && s.status === 'valid',
    );
    const score = {
      scoreId: newId('score'),
      reviewerId: principal.reviewerId,
      alias,
      materialVersion,
      categories,
      total: totalOf(categories),
      status: 'valid',
      submittedAt: this.now(),
      invalidatedBy: null,
      replaces: replaced?.scoreId ?? null,
    };
    if (replaced) replaced.status = 'replaced';
    round.scores.push(score);
    this._audit(round, principal, 'score.submitted', {
      scoreId: score.scoreId,
      reviewerId: score.reviewerId,
      alias,
      materialVersion,
      categories,
      total: score.total,
      replaces: score.replaces,
    });
    return { scoreId: score.scoreId, total: score.total, materialVersion };
  }

  // ---------- 异议 ----------

  raiseObjection(principal, roundId, input = {}) {
    if (!principal) throw new ApiError(401, 'unauthenticated', '未认证');
    let round;
    let raisedBy;
    if (principal.role === 'secretary') {
      round = this._getRound(roundId);
      raisedBy = 'secretary';
    } else {
      round = this._getRoundForReviewer(principal, roundId);
      raisedBy = `reviewer:${principal.reviewerId}`;
    }
    if (!['reviewing', 'signing'].includes(round.state)) {
      throw new ApiError(409, 'bad_state', '当前状态不能提出异议');
    }
    const { alias = null, text } = input;
    if (!text || typeof text !== 'string') throw new ApiError(400, 'invalid_input', '异议内容不能为空');
    if (alias !== null && !round.aliasMap.has(alias)) {
      throw new ApiError(404, 'not_found', `匿名编号 ${alias} 不存在`);
    }
    const objection = {
      objectionId: newId('obj'),
      alias,
      text,
      raisedBy,
      state: 'open',
      raisedAt: this.now(),
      handledAt: null,
      note: null,
    };
    round.objections.push(objection);
    this._audit(round, principal, 'objection.raised', {
      objectionId: objection.objectionId,
      alias,
      text,
      raisedBy,
    });
    return { objectionId: objection.objectionId, state: 'open' };
  }

  handleObjection(principal, roundId, objectionId, input = {}) {
    this._requireSecretary(principal);
    const round = this._getRound(roundId);
    const objection = round.objections.find((o) => o.objectionId === objectionId);
    if (!objection) throw new ApiError(404, 'not_found', '异议不存在');
    if (objection.state !== 'open') throw new ApiError(409, 'bad_state', '异议已处理');
    const { outcome, note = '' } = input;
    if (!['resolved', 'dismissed'].includes(outcome)) {
      throw new ApiError(400, 'invalid_input', '处理结果须为 resolved 或 dismissed');
    }
    objection.state = outcome;
    objection.note = note;
    objection.handledAt = this.now();
    this._audit(round, principal, 'objection.handled', { objectionId, outcome, note });
    return { objectionId, state: outcome };
  }

  // ---------- 结果版本与签署 ----------

  _validScores(round, alias) {
    return round.scores.filter(
      (s) => s.alias === alias && s.status === 'valid' && s.materialVersion === round.currentMaterialVersion,
    );
  }

  _quorumBlocker(round) {
    const lacking = [];
    for (const [alias, cid] of round.aliasMap) {
      if (round.candidates.get(cid).status !== 'active') continue;
      const valid = this._validScores(round, alias);
      const effectiveReviewers = [...round.reviewers.keys()].filter(
        (rid) => !this._hasActiveConflict(round, rid, alias),
      ).length;
      if (valid.length < round.quorum) {
        lacking.push({ alias, validScores: valid.length, effectiveReviewers, required: round.quorum });
      }
    }
    return lacking.length
      ? { code: 'QUORUM_NOT_MET', message: '部分候选人有效评审人数不足法定人数', candidates: lacking }
      : null;
  }

  _buildResultVersion(round, cause) {
    const perCandidate = [];
    for (const [alias, cid] of round.aliasMap) {
      if (round.candidates.get(cid).status !== 'active') continue;
      const valid = this._validScores(round, alias);
      // 不变式断言：计入结果的评分必须基于当前材料版本
      for (const s of valid) {
        if (s.materialVersion !== round.currentMaterialVersion) {
          throw new Error('评分版本与材料版本不一致');
        }
      }
      const agg = aggregateScores(valid);
      perCandidate.push({
        alias,
        validScoreCount: valid.length,
        totalAvg: agg.totalAvg,
        categoryAvgs: agg.categoryAvgs,
      });
    }
    const { ranked, tieGroups, explanation } = rankCandidates(perCandidate, round.quorum);
    const awardees = ranked.filter((r) => r.rank <= round.awardCount).map((r) => r.alias);
    explanation.push(`入选规则：名次不超过 ${round.awardCount} 者入选；录取线处并列一并入选`);
    explanation.push(`入选名单：${awardees.join('、')}`);
    const computation = { perCandidate: ranked, tieGroups, awardees, explanation };
    const resultVersion = round.resultVersions.length + 1;
    const record = {
      resultVersion,
      materialVersion: round.currentMaterialVersion,
      digest: digestOf({
        roundId: round.id,
        resultVersion,
        materialVersion: round.currentMaterialVersion,
        rules: scoringRules,
        computation,
      }),
      computation,
      cause,
      createdAt: this.now(),
    };
    round.resultVersions.push(record);
    round.currentResultVersion = resultVersion;
    return record;
  }

  // 签署期间若有效评分发生变化（如回避申报），结果版本立即更新，旧签署随之过期
  _refreshResultIfSigning(round, principal, cause) {
    if (round.state !== 'signing') return;
    const rv = this._buildResultVersion(round, cause);
    this._audit(round, principal, 'result.refreshed', {
      resultVersion: rv.resultVersion,
      digest: rv.digest,
      cause,
    });
  }

  closeScoring(principal, roundId) {
    this._requireSecretary(principal);
    const round = this._getRound(roundId);
    if (round.state !== 'reviewing') throw new ApiError(409, 'bad_state', '仅评分中状态可结束评分');
    const quorumBlocker = this._quorumBlocker(round);
    if (quorumBlocker) {
      throw new ApiError(409, 'quorum_not_met', '有效评审人数不足法定人数，不能结束评分', {
        blockers: [quorumBlocker],
      });
    }
    const rv = this._buildResultVersion(round, 'scoring-closed');
    round.state = 'signing';
    this._audit(round, principal, 'scoring.closed', {
      resultVersion: rv.resultVersion,
      digest: rv.digest,
      materialVersion: rv.materialVersion,
    });
    return { roundId, state: round.state, resultVersion: rv.resultVersion, resultDigest: rv.digest };
  }

  sign(principal, roundId) {
    const round = this._getRoundForReviewer(principal, roundId);
    if (round.state !== 'signing') throw new ApiError(409, 'bad_state', '当前状态不能签署');
    const rv = round.resultVersions.find((r) => r.resultVersion === round.currentResultVersion);
    if (!rv) throw new ApiError(409, 'no_result', '当前没有可签署的结果版本');
    if (rv.materialVersion !== round.currentMaterialVersion) {
      throw new ApiError(409, 'version_mismatch', '结果版本与材料版本不一致，需重新评审');
    }
    if (round.signatures.some((s) => s.reviewerId === principal.reviewerId && s.resultVersion === rv.resultVersion)) {
      throw new ApiError(409, 'already_signed', '已签署当前结果版本');
    }
    const statement = `本人确认轮次 ${round.id} 结果版本 ${rv.resultVersion}（材料版本 ${rv.materialVersion}，结果摘要 ${rv.digest}）的评审结果`;
    const sig = {
      signatureId: newId('sig'),
      reviewerId: principal.reviewerId,
      resultVersion: rv.resultVersion,
      digest: rv.digest,
      statement,
      signedAt: this.now(),
    };
    round.signatures.push(sig);
    this._audit(round, principal, 'signature.added', {
      signatureId: sig.signatureId,
      reviewerId: sig.reviewerId,
      resultVersion: rv.resultVersion,
      digest: rv.digest,
    });
    return { signatureId: sig.signatureId, resultVersion: rv.resultVersion, digest: rv.digest };
  }

  // ---------- 公布 ----------

  computeBlockers(round) {
    const blockers = [];
    if (round.state === 'published') return { state: round.state, blockers };
    if (round.state !== 'signing') {
      blockers.push({ code: 'ROUND_NOT_IN_SIGNING', message: `轮次处于 ${round.state} 状态，尚未进入签署环节` });
    }
    const quorumBlocker = this._quorumBlocker(round);
    if (quorumBlocker) blockers.push(quorumBlocker);
    const open = round.objections.filter((o) => o.state === 'open');
    if (open.length) {
      blockers.push({
        code: 'OPEN_OBJECTIONS',
        message: '存在未处理异议',
        count: open.length,
        objectionIds: open.map((o) => o.objectionId),
      });
    }
    const currentRv = round.currentResultVersion;
    const validSigs = currentRv ? round.signatures.filter((s) => s.resultVersion === currentRv) : [];
    const staleSigs = round.signatures.filter((s) => s.resultVersion !== currentRv);
    if (!currentRv) {
      blockers.push({ code: 'NO_RESULT_SNAPSHOT', message: '尚未形成结果版本，无法签署与公布' });
    }
    if (staleSigs.length && validSigs.length < round.quorum) {
      blockers.push({
        code: 'SIGNATURE_VERSION_STALE',
        message: '已有签署基于过期的结果版本，需重新签署',
        currentResultVersion: currentRv,
        staleCount: staleSigs.length,
        staleVersions: [...new Set(staleSigs.map((s) => s.resultVersion))],
      });
    }
    if (validSigs.length < round.quorum) {
      blockers.push({
        code: 'SIGNATURES_INSUFFICIENT',
        message: '当前结果版本签署数量不足法定人数',
        have: validSigs.length,
        need: round.quorum,
      });
    }
    return { state: round.state, blockers };
  }

  getBlockers(principal, roundId) {
    this._requireSecretary(principal);
    const round = this._getRound(roundId);
    return { roundId, ...this.computeBlockers(round) };
  }

  publish(principal, roundId) {
    this._requireSecretary(principal);
    const round = this._getRound(roundId);
    if (round.state === 'published') {
      return round.publications[round.publications.length - 1];
    }
    const { blockers } = this.computeBlockers(round);
    if (blockers.length) throw new ApiError(409, 'publish_blocked', '公布条件未满足', { blockers });
    const rv = round.resultVersions.find((r) => r.resultVersion === round.currentResultVersion);
    if (rv.materialVersion !== round.currentMaterialVersion) {
      throw new ApiError(409, 'version_mismatch', '签署版本已过期，需重新评审与签署');
    }
    const mv = round.materialVersions.find((m) => m.version === rv.materialVersion);
    const validSigs = round.signatures.filter((s) => s.resultVersion === rv.resultVersion);
    const publication = {
      publicationId: newId('pub'),
      publicationVersion: round.publications.length + 1,
      supersedes: round.publications.length
        ? round.publications[round.publications.length - 1].publicationId
        : null,
      roundId,
      publishedAt: this.now(),
      materialVersion: rv.materialVersion,
      materialHash: mv.hash,
      resultVersion: rv.resultVersion,
      resultDigest: rv.digest,
      rules: { ...scoringRules, quorum: round.quorum, awardCount: round.awardCount },
      computation: rv.computation,
      // 仅入选者解除匿名，其余候选人保持匿名
      awardees: rv.computation.awardees.map((alias) => {
        const c = round.candidates.get(round.aliasMap.get(alias));
        const ranked = rv.computation.perCandidate.find((p) => p.alias === alias);
        return { alias, name: c.name, school: c.school, rank: ranked.rank, finalScore: ranked.totalAvg, tied: ranked.tied };
      }),
      signatures: {
        count: validSigs.length,
        digest: digestOf(validSigs.map((s) => ({
          reviewerId: s.reviewerId,
          resultVersion: s.resultVersion,
          digest: s.digest,
          signedAt: s.signedAt,
        }))),
        signers: validSigs.map((s) => ({ reviewerId: s.reviewerId, signedAt: s.signedAt, digest: s.digest })),
      },
      auditHead: null,
    };
    round.publications.push(publication);
    round.state = 'published';
    const entry = this._audit(round, principal, 'result.published', {
      publicationId: publication.publicationId,
      publicationVersion: publication.publicationVersion,
      resultDigest: rv.digest,
      materialVersion: rv.materialVersion,
    });
    publication.auditHead = entry.hash;
    return publication;
  }

  // ---------- 视图 ----------

  // 评委工作台：仅匿名信息、本人评分、本人回避与本人异议
  getWorkspace(principal, roundId) {
    const round = this._getRoundForReviewer(principal, roundId);
    const rid = principal.reviewerId;
    const candidates = [];
    if (round.currentMaterialVersion > 0) {
      for (const [alias, cid] of round.aliasMap) {
        const cand = round.candidates.get(cid);
        const recused = this._hasActiveConflict(round, rid, alias);
        const myScore = round.scores.find(
          (s) => s.reviewerId === rid && s.alias === alias && s.status === 'valid'
            && s.materialVersion === round.currentMaterialVersion,
        );
        candidates.push({
          alias,
          status: cand.status,
          // 已回避或已退出的候选人材料对本人屏蔽
          materials: recused || cand.status !== 'active' ? null : cand.materials,
          recused,
          myScore: myScore
            ? { categories: myScore.categories, total: myScore.total, materialVersion: myScore.materialVersion }
            : null,
        });
      }
    }
    const rv = round.resultVersions.find((r) => r.resultVersion === round.currentResultVersion);
    return {
      roundId: round.id,
      state: round.state,
      materialVersion: round.currentMaterialVersion,
      quorum: round.quorum,
      candidates,
      canScore: round.state === 'reviewing',
      canSign: round.state === 'signing',
      currentResultDigest: round.state === 'signing' && rv ? rv.digest : null,
      mySignatureOnCurrentResult: rv
        ? round.signatures.some((s) => s.reviewerId === rid && s.resultVersion === rv.resultVersion)
        : false,
      myObjections: round.objections
        .filter((o) => o.raisedBy === `reviewer:${rid}`)
        .map((o) => ({ objectionId: o.objectionId, alias: o.alias, text: o.text, state: o.state })),
    };
  }

  getRoundForSecretary(principal, roundId) {
    this._requireSecretary(principal);
    const round = this._getRound(roundId);
    return {
      roundId: round.id,
      state: round.state,
      quorum: round.quorum,
      awardCount: round.awardCount,
      currentMaterialVersion: round.currentMaterialVersion,
      materialVersions: round.materialVersions.map((m) => ({
        version: m.version, hash: m.hash, note: m.note, createdAt: m.createdAt,
      })),
      candidates: [...round.candidates.values()].map((c) => ({
        candidateId: c.id, alias: c.alias, name: c.name, school: c.school, status: c.status,
      })),
      reviewers: [...round.reviewers.values()].map((r) => ({ reviewerId: r.reviewerId, role: r.role })),
      scores: round.scores.map((s) => ({ ...s })),
      conflicts: round.conflicts.map((c) => ({ ...c })),
      objections: round.objections.map((o) => ({ ...o })),
      resultVersions: round.resultVersions.map((r) => ({
        resultVersion: r.resultVersion, materialVersion: r.materialVersion,
        digest: r.digest, cause: r.cause, createdAt: r.createdAt,
      })),
      currentResultVersion: round.currentResultVersion,
      signatures: round.signatures.map((s) => ({ ...s })),
      publications: round.publications.map((p) => ({
        publicationId: p.publicationId, publicationVersion: p.publicationVersion,
        publishedAt: p.publishedAt, resultDigest: p.resultDigest,
      })),
      blockers: this.computeBlockers(round).blockers,
      auditHead: round.audit.length ? round.audit[round.audit.length - 1].hash : null,
    };
  }

  getAudit(principal, roundId) {
    this._requireSecretary(principal);
    const round = this._getRound(roundId);
    return { roundId, entries: round.audit, verification: verifyAuditChain(round.audit, round.id) };
  }

  listRounds(principal) {
    if (!principal) throw new ApiError(401, 'unauthenticated', '未认证');
    if (principal.role === 'secretary') {
      return [...this.rounds.values()].map((r) => ({
        roundId: r.id, state: r.state, currentMaterialVersion: r.currentMaterialVersion,
      }));
    }
    const granted = this.grants.get(principal.reviewerId) ?? new Set();
    return [...granted].filter((id) => this.rounds.has(id)).map((id) => {
      const r = this.rounds.get(id);
      return {
        roundId: r.id,
        state: r.state,
        currentMaterialVersion: r.currentMaterialVersion,
        myRole: r.reviewers.get(principal.reviewerId)?.role,
      };
    });
  }

  getPublication(roundId) {
    const round = this.rounds.get(roundId);
    if (!round || !round.publications.length) throw new ApiError(404, 'not_found', '公布结果不存在');
    return round.publications[round.publications.length - 1];
  }
}
