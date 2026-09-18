import { createServer as createHttpServer } from 'node:http';
import { ReviewService, ReviewError } from './review-service.js';

// 操作者通过请求头识别：x-actor-role: secretary|reviewer，x-actor-id: <id>
function actorOf(req) {
  const role = req.headers['x-actor-role'];
  if (!role) return null;
  return { role, id: req.headers['x-actor-id'] ?? '' };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ReviewError('VALIDATION', '请求体不是合法 JSON');
  }
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function statusFor(error) {
  switch (error.code) {
    case 'FORBIDDEN': return 403;
    case 'NOT_FOUND': return 404;
    case 'CONFLICT':
    case 'BAD_STATE':
    case 'PUBLICATION_BLOCKED':
    case 'STALE_MATERIAL_VERSION':
    case 'SIGNATURE_VERSION_STALE':
    case 'TALLY_STALE':
      return 409;
    default: return 400;
  }
}

// 路由表：handler(service, actor, params, body)
const routes = [
  ['POST', '/rounds', (s, a, p, b) => s.createRound(a, b)],
  ['POST', '/rounds/:rid/candidates', (s, a, p, b) => s.addCandidate(a, p.rid, b)],
  ['POST', '/rounds/:rid/candidates/:cid/update', (s, a, p, b) => s.updateCandidate(a, p.rid, p.cid, b)],
  ['POST', '/rounds/:rid/candidates/:cid/withdraw', (s, a, p, b) => s.withdrawCandidate(a, p.rid, p.cid, b.reason)],
  ['POST', '/rounds/:rid/candidates/:cid/verify', (s, a, p) => s.verifyEligibility(a, p.rid, p.cid)],
  ['POST', '/rounds/:rid/seal', (s, a, p) => s.sealMaterials(a, p.rid)],
  ['POST', '/rounds/:rid/amend', (s, a, p, b) => s.amendMaterials(a, p.rid, b)],
  ['POST', '/rounds/:rid/start-review', (s, a, p) => s.startReview(a, p.rid)],
  ['POST', '/rounds/:rid/close-scoring', (s, a, p) => s.closeScoring(a, p.rid)],
  ['POST', '/rounds/:rid/reopen-scoring', (s, a, p, b) => s.reopenScoring(a, p.rid, b.reason)],
  ['POST', '/rounds/:rid/reopen', (s, a, p, b) => s.reopenRound(a, p.rid, b.reason)],
  ['POST', '/rounds/:rid/reviewers', (s, a, p, b) => s.assignReviewer(a, p.rid, b)],
  ['POST', '/rounds/:rid/conflicts', (s, a, p, b) => s.declareConflict(a, p.rid, b)],
  ['POST', '/rounds/:rid/conflicts/:did/revoke', (s, a, p, b) => s.revokeConflict(a, p.rid, p.did, b.reason)],
  ['POST', '/rounds/:rid/scores', (s, a, p, b) => s.submitScore(a, p.rid, b)],
  ['POST', '/rounds/:rid/objections', (s, a, p, b) => s.raiseObjection(a, p.rid, b)],
  ['POST', '/rounds/:rid/objections/:oid/resolve', (s, a, p, b) => s.resolveObjection(a, p.rid, p.oid, b)],
  ['POST', '/rounds/:rid/sign', (s, a, p, b) => s.sign(a, p.rid, b)],
  ['POST', '/rounds/:rid/publish', (s, a, p) => s.publish(a, p.rid)],
  ['GET', '/rounds/:rid/secretary-view', (s, a, p) => s.getSecretaryView(a, p.rid)],
  ['GET', '/rounds/:rid/reviewer-view', (s, a, p) => s.getReviewerView(a, p.rid)],
  ['GET', '/rounds/:rid/signing-package', (s, a, p) => s.getSigningPackage(a, p.rid)],
  ['GET', '/rounds/:rid/blockers', (s, a, p) => s.getPublicationBlockers(a, p.rid)],
  ['GET', '/rounds/:rid/publication', (s, a, p) => s.getPublication(p.rid)],
  ['GET', '/rounds/:rid/audit', (s, a, p) => s.getAuditLog(a, p.rid)],
  ['GET', '/rounds/:rid/audit/verify', (s, a, p) => s.verifyAudit(a, p.rid)],
];

function compile(path) {
  const keys = [];
  const pattern = path.replace(/:[^/]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${pattern}$`), keys };
}

const compiled = routes.map(([method, path, handler]) => ({ method, handler, ...compile(path) }));

export function createServer(service = new ReviewService()) {
  return createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const actor = actorOf(req);
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      for (const route of compiled) {
        if (route.method !== req.method) continue;
        const match = route.regex.exec(url.pathname);
        if (!match) continue;
        const params = {};
        route.keys.forEach((key, i) => {
          params[key] = decodeURIComponent(match[i + 1]);
        });
        const result = route.handler(service, actor, params, body ?? {});
        return send(res, 200, result);
      }
      return send(res, 404, { error: { code: 'NOT_FOUND', message: '路由不存在' } });
    } catch (error) {
      if (error instanceof ReviewError) {
        return send(res, statusFor(error), { error: { code: error.code, message: error.message, details: error.details } });
      }
      return send(res, 500, { error: { code: 'INTERNAL', message: '服务内部错误' } });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  createServer().listen(port, () => {
    console.log(`评审服务已启动: http://localhost:${port}`);
  });
}
