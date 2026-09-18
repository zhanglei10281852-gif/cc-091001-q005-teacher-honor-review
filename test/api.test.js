import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../src/service.js';
import { createServer } from '../src/server.js';
import { CANDIDATES } from './helpers.js';

async function startServer(service) {
  const server = createServer(service);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (path, { method = 'GET', token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { server, api };
}

function cats(v) {
  return { ethics: v, teaching: v, 'student-development': v, 'public-service': v };
}

test('HTTP 全流程：建轮次到公布，权限与错误形态符合约定', async (t) => {
  const service = new ReviewService({ now: () => '2026-09-18T08:00:00.000Z' });
  const secretaryToken = service.createSecretaryToken();
  const { server, api } = await startServer(service);
  t.after(() => server.close());

  // 未认证
  const noAuth = await api('/rounds', { method: 'POST', body: {} });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.body.error.code, 'unauthenticated');

  // 创建轮次
  const created = await api('/rounds', {
    method: 'POST',
    token: secretaryToken,
    body: {
      roundId: 'ROUND-HTTP', quorum: 2, awardCount: 1,
      reviewerIds: ['R1', 'R2', 'R3'],
      candidates: CANDIDATES,
    },
  });
  assert.equal(created.status, 201);
  const tokens = created.body.reviewerTokens;

  // 评委访问秘书接口 -> 403；访问未授权轮次 -> 404
  const forbidden = await api('/rounds/ROUND-HTTP', { token: tokens.R1 });
  assert.equal(forbidden.status, 403);
  const hidden = await api('/rounds/ROUND-HTTP/workspace', { token: service.issueToken({ role: 'reviewer', reviewerId: 'OUTSIDER' }) });
  assert.equal(hidden.status, 404);

  // 截止 -> 开放评分 -> 评分
  await api('/rounds/ROUND-HTTP/close-materials', { method: 'POST', token: secretaryToken });
  await api('/rounds/ROUND-HTTP/open-review', { method: 'POST', token: secretaryToken });
  const ws = await api(`/rounds/ROUND-HTTP/workspace`, { token: tokens.R1 });
  assert.equal(ws.status, 200);
  assert.equal(ws.body.candidates.length, 3);
  assert.ok(!JSON.stringify(ws.body).includes('张老师'));

  for (const rid of ['R1', 'R2', 'R3']) {
    for (const c of ws.body.candidates) {
      const scored = await api('/rounds/ROUND-HTTP/scores', {
        method: 'POST',
        token: tokens[rid],
        body: { alias: c.alias, materialVersion: 1, categories: cats(c.alias === ws.body.candidates[0].alias ? 24 : 18) },
      });
      assert.equal(scored.status, 201);
    }
  }

  // 结束评分 -> 签署 -> 公布
  const closed = await api('/rounds/ROUND-HTTP/close-scoring', { method: 'POST', token: secretaryToken });
  assert.equal(closed.status, 200);
  for (const rid of ['R1', 'R2']) {
    const signed = await api('/rounds/ROUND-HTTP/signatures', { method: 'POST', token: tokens[rid] });
    assert.equal(signed.status, 201);
  }
  // 公布前公开查询 404
  const before = await api('/publications/ROUND-HTTP');
  assert.equal(before.status, 404);

  const published = await api('/rounds/ROUND-HTTP/publish', { method: 'POST', token: secretaryToken });
  assert.equal(published.status, 200);
  assert.equal(published.body.signatures.count, 2);
  assert.equal(published.body.awardees.length, 1);

  // 公开查询公布结果（无需令牌）
  const pub = await api('/publications/ROUND-HTTP');
  assert.equal(pub.status, 200);
  assert.equal(pub.body.roundId, 'ROUND-HTTP');
  assert.ok(Array.isArray(pub.body.computation.explanation));

  // 秘书审计接口包含校验结果
  const audit = await api('/rounds/ROUND-HTTP/audit', { token: secretaryToken });
  assert.equal(audit.body.verification.ok, true);
});

test('HTTP 阻塞原因通过 details.blockers 返回', async (t) => {
  const service = new ReviewService({ now: () => '2026-09-18T08:00:00.000Z' });
  const secretaryToken = service.createSecretaryToken();
  const { server, api } = await startServer(service);
  t.after(() => server.close());

  await api('/rounds', {
    method: 'POST',
    token: secretaryToken,
    body: { roundId: 'ROUND-B', quorum: 2, awardCount: 1, reviewerIds: ['R1', 'R2'], candidates: CANDIDATES },
  });
  await api('/rounds/ROUND-B/close-materials', { method: 'POST', token: secretaryToken });
  await api('/rounds/ROUND-B/open-review', { method: 'POST', token: secretaryToken });

  // 未评分直接结束 -> 法定人数不足
  const res = await api('/rounds/ROUND-B/close-scoring', { method: 'POST', token: secretaryToken });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'quorum_not_met');
  assert.equal(res.body.error.details.blockers[0].code, 'QUORUM_NOT_MET');
  assert.equal(res.body.error.details.blockers[0].candidates.length, 3);

  const blockers = await api('/rounds/ROUND-B/blockers', { token: secretaryToken });
  assert.ok(blockers.body.blockers.some((b) => b.code === 'QUORUM_NOT_MET'));
});
