import { createHash } from 'node:crypto';

export const roundStates = ['collecting', 'sealed', 'reviewing', 'signing', 'published'];
export const conflictKinds = ['relative', 'same-school', 'direct-supervision', 'declared-other'];
export const objectionStates = ['open', 'resolved', 'dismissed'];
export const scoreCategories = ['ethics', 'teaching', 'student-development', 'public-service'];

export const categoryLabels = Object.freeze({
  ethics: '师德表现',
  teaching: '教学育人',
  'student-development': '学生发展',
  'public-service': '公益服务',
});

// 评审规则（写入公布结果，保证计算过程可解释、可复核）
export const scoringRules = Object.freeze({
  ruleVersion: 'rules-v1',
  categoryMax: 25, // 每个类目 0-25 分
  totalMax: 100, // 四类合计满分 100
  // 并列规则：依次比较 总分 → 师德 → 教学育人 → 学生发展 → 公益服务；
  // 全部相同判定为并列，共享名次，录取线处并列的一并入选。
  tieBreakOrder: Object.freeze(['total', 'ethics', 'teaching', 'student-development', 'public-service']),
  tiePolicy: 'share-rank-include-all',
});

// 稳定序列化：键排序，保证同一内容永远得到同一摘要
export function canonicalize(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function digestOf(value) {
  return `sha256:${sha256Hex(canonicalize(value))}`;
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function round1(n) {
  return Math.round((n + Number.EPSILON) * 10) / 10;
}

export function validateCategoryScores(input) {
  const errors = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return ['评分必须按类目给出'];
  }
  for (const cat of scoreCategories) {
    const v = input[cat];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`类目 ${cat}（${categoryLabels[cat]}）缺少有效分值`);
    } else if (v < 0 || v > scoringRules.categoryMax) {
      errors.push(`类目 ${cat}（${categoryLabels[cat]}）分值须在 0 到 ${scoringRules.categoryMax} 之间`);
    }
  }
  const extra = Object.keys(input).filter((k) => !scoreCategories.includes(k));
  if (extra.length) errors.push(`未知评分类目: ${extra.join(', ')}`);
  return errors;
}

export function normalizeCategories(input) {
  const out = {};
  for (const cat of scoreCategories) out[cat] = round1(input[cat]);
  return out;
}

export function totalOf(categories) {
  return round2(scoreCategories.reduce((sum, cat) => sum + categories[cat], 0));
}

// 单个候选人的有效评分聚合：总分均值 + 各类目均值（保留两位小数，保证可解释）
export function aggregateScores(scores) {
  const count = scores.length;
  if (count === 0) {
    return {
      count: 0,
      totalAvg: 0,
      categoryAvgs: Object.fromEntries(scoreCategories.map((c) => [c, 0])),
    };
  }
  const categoryAvgs = {};
  for (const cat of scoreCategories) {
    categoryAvgs[cat] = round2(scores.reduce((s, x) => s + x.categories[cat], 0) / count);
  }
  const totalAvg = round2(scores.reduce((s, x) => s + x.total, 0) / count);
  return { count, totalAvg, categoryAvgs };
}

const EPS = 1e-9;

function keyOf(entry, key) {
  return key === 'total' ? entry.totalAvg : entry.categoryAvgs[key];
}

// 返回值 < 0 表示 a 优于 b
export function compareEntries(a, b, order = scoringRules.tieBreakOrder) {
  for (const key of order) {
    const d = keyOf(b, key) - keyOf(a, key);
    if (Math.abs(d) > EPS) return d;
  }
  return 0;
}

// 排名与并列处理。entries: [{alias, validScoreCount, totalAvg, categoryAvgs}]
// 返回带名次、并列标记和完整中文解释的计算过程。
export function rankCandidates(entries, quorum) {
  const order = scoringRules.tieBreakOrder;
  const sorted = [...entries].sort((a, b) => {
    const c = compareEntries(a, b, order);
    if (c !== 0) return c;
    return a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0;
  });
  const ranked = sorted.map((entry) => ({
    ...entry,
    rank: 1,
    tied: false,
    quorumMet: entry.validScoreCount >= quorum,
  }));
  for (const e of ranked) {
    e.rank = 1 + ranked.filter((o) => compareEntries(o, e, order) < 0).length;
  }
  const groups = new Map();
  for (const e of ranked) {
    const key = order.map((k) => keyOf(e, k)).join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e.alias);
  }
  const tieGroups = [...groups.values()].filter((g) => g.length > 1);
  for (const e of ranked) e.tied = tieGroups.some((g) => g.includes(e.alias));

  const categoryNames = order.slice(1).map((k) => categoryLabels[k]);
  const explanation = [];
  for (const e of ranked) {
    explanation.push(
      `候选人 ${e.alias}：有效评分 ${e.validScoreCount} 份（法定人数 ${quorum}，${e.quorumMet ? '满足' : '不满足'}），` +
        `总分均值 ${e.totalAvg}，类目均值 ${order.slice(1).map((k) => `${categoryLabels[k]} ${e.categoryAvgs[k]}`).join(' / ')}`,
    );
  }
  explanation.push(`排序规则：依次比较 总分 → ${categoryNames.join(' → ')}，全部相同判定为并列`);
  for (const g of tieGroups) {
    explanation.push(`并列处理：${g.join('、')} 各项比较完全一致，共享名次`);
  }
  return { ranked, tieGroups, explanation };
}

// 校验审计链：序号连续、链式哈希衔接、条目内容未被篡改
export function verifyAuditChain(entries, roundId) {
  let prev = sha256Hex(`genesis:${roundId}`);
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e.seq !== i + 1) return { ok: false, brokenAt: e.seq, reason: '审计序号不连续' };
    if (e.prevHash !== prev) return { ok: false, brokenAt: e.seq, reason: '链式哈希断裂' };
    const { hash, ...rest } = e;
    if (sha256Hex(canonicalize(rest)) !== hash) {
      return { ok: false, brokenAt: e.seq, reason: '条目哈希不匹配，内容可能被篡改' };
    }
    prev = e.hash;
  }
  return { ok: true, head: prev, length: entries.length };
}
