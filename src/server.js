import { createServer as createHttpServer } from 'node:http';
import { ApiError } from './service.js';

const MAX_BODY = 1024 * 1024;

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ApiError(413, 'too_large', '请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json', '请求体不是合法 JSON');
  }
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

/**
 * 路由角色：
 * - secretary：仅秘书组令牌；评委访问一律 403（不区分轮次是否存在，避免存在性探测）
 * - reviewer：仅评委令牌；未授权轮次在服务层按 404 处理
 * - any：秘书或评委均可
 * - public：无需令牌
 */
export function createServer(service) {
  const routes = [
    { method: 'POST', pattern: /^\/rounds$/, role: 'secretary', status: 201, handler: (p, b) => service.createRound(p, b) },
    { method: 'GET', pattern: /^\/rounds$/, role: 'any', handler: (p) => service.listRounds(p) },
    { method: 'GET', pattern: /^\/rounds\/([^/]+)$/, role: 'secretary', handler: (p, b, m) => service.getRoundForSecretary(p, m[1]) },
    { method: 'POST', pattern: /^\/rounds\/([^/]+)\/close-materials$/, role: 'secretary', handler: (p, b, m) => service.closeMaterials(p, m[1]) },
    { method: 'POST', pattern: /^\/rounds\/([^/]+)\/material-versions$/, role: 'secretary', handler: (p, b, m) => service.amendMaterials(p, m[1], b) },
    { method: 'POST', pattern: /^\/rounds\/([^/]+)\/open-review$/, role: 'secretary', handler: (p, b, m) => service.openReview(p, m[1]) },
    { method: 'POST', pattern: /^\/rounds\/([^/]+)\/reviewers$/, role: 'secretary', status: 201, handler: (p, b, m) => service.addReviewer(p, m[1], b) },
    { method: 'POST', pattern: /^\/rounds\/([^/]+)\/close-scoring$/, role: 'secretary', handler: (p, b, m) => service.closeScoring(p, m[1]) },
    { method: 'POST', pattern: /^\/rounds\/([^/]+)\/publish$/, role: 'secretary', handler: (p, b, m) => service.publish(p, m[1]) },
    { method: 'GET', pattern: /^\/rounds\/([^/]+)\/blockers$/, role: 'secretary', handler: (p, b, m) => service.getBlockers(p, m[1]) },
    { method: 'GET', pattern: /^\/rounds\/([^/]+)\/audit$/, role: 'secretary', handler: (p, b, m) => service.getAudit(p, m[1]) },
    { method: 'GET', pattern: /^\/rounds\/([^/]+)\/workspace$/, role: 'reviewer', handler: (p, b, m) => service.getWorkspace(p, m[1]) },
    { method: 'POST', pattern: /^\/rounds\/([^/]+)\/scores$/, role: 'reviewer', status: 201, handler: (p, b, m) => service.submitScore(p, m[1], b) },
    { method: 'POST', pattern: /^\/rounds\/([^/]+)\/conflicts$/, role: 'any', status: 201, handler: (p, b, m) => service.declareConflict(p, m[1], b) },
    { method: 'DELETE', pattern: /^\/rounds\/([^/]+)\/conflicts\/([^/]+)$/, role: 'secretary', handler: (p, b, m) => service.retractConflict(p, m[1], m[2]) },
    { method: 'POST', pattern: /^\/rounds\/([^/]+)\/objections$/, role: 'any', status: 201, handler: (p, b, m) => service.raiseObjection(p, m[1], b) },
    { method: 'POST', pattern: /^\/rounds\/([^/]+)\/objections\/([^/]+)\/handle$/, role: 'secretary', handler: (p, b, m) => service.handleObjection(p, m[1], m[2], b) },
    { method: 'POST', pattern: /^\/rounds\/([^/]+)\/signatures$/, role: 'reviewer', status: 201, handler: (p, b, m) => service.sign(p, m[1]) },
    { method: 'GET', pattern: /^\/publications\/([^/]+)$/, role: 'public', handler: (p, b, m) => service.getPublication(m[1]) },
  ];

  return createHttpServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const route = routes.find((r) => r.method === req.method && r.pattern.test(pathname));
      if (!route) throw new ApiError(404, 'not_found', '资源不存在');
      const match = pathname.match(route.pattern);

      let principal = null;
      if (route.role !== 'public') {
        const auth = req.headers.authorization ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        principal = service.authenticate(token);
        if (!principal) throw new ApiError(401, 'unauthenticated', '缺少或无效的访问令牌');
        if (route.role === 'secretary' && principal.role !== 'secretary') {
          throw new ApiError(403, 'forbidden', '仅秘书组可执行该操作');
        }
        if (route.role === 'reviewer' && principal.role !== 'reviewer') {
          throw new ApiError(403, 'forbidden', '仅评委可执行该操作');
        }
      }

      const body = req.method === 'POST' ? await readJson(req) : {};
      const result = await route.handler(principal, body, match);
      send(res, route.status ?? 200, result ?? { ok: true });
    } catch (err) {
      if (err instanceof ApiError) {
        send(res, err.status, {
          error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
        });
      } else {
        send(res, 500, { error: { code: 'internal', message: '服务内部错误' } });
      }
    }
  });
}
