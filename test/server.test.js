import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../src/review-service.js';
import { createServer } from '../src/server.js';

const SEC_HEADERS = { 'content-type': 'application/json', 'x-actor-role': 'secretary', 'x-actor-id': 'sec-1' };
const RV_HEADERS = { 'content-type': 'application/json', 'x-actor-role': 'reviewer', 'x-actor-id': 'r1' };

async function call(base, method, path, { headers = SEC_HEADERS, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('HTTP 端到端：建轮 → 提名 → 封存 → 评分 → 签署 → 公布', async () => {
  const now = { d: new Date('2026-07-01T00:00:00Z') };
  const service = new ReviewService({ clock: () => now.d });
  const server = createServer(service);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await call(base, 'POST', '/rounds', {
      body: {
        roundId: 'R-HTTP',
        quorum: 1,
        nominationDeadline: '2026-08-01T00:00:00Z',
        materialDeadline: '2026-09-01T00:00:00Z',
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    r = await call(base, 'POST', '/rounds/R-HTTP/candidates', {
      body: { candidateId: 'a', name: '教师a', school: '学校a', yearsOfService: 9, ethicsRecord: 'clean', materials: { note: 'x' } },
    });
    assert.equal(r.status, 200);
    r = await call(base, 'POST', '/rounds/R-HTTP/candidates/a/verify');
    assert.equal(r.json.eligible, true);
    now.d = new Date('2026-09-02T00:00:00Z');
    r = await call(base, 'POST', '/rounds/R-HTTP/seal');
    assert.equal(r.json.version, 1);
    r = await call(base, 'POST', '/rounds/R-HTTP/reviewers', { body: { reviewerId: 'r1', kind: 'regular' } });
    assert.equal(r.status, 200);
    await call(base, 'POST', '/rounds/R-HTTP/start-review');
    r = await call(base, 'GET', '/rounds/R-HTTP/reviewer-view', { headers: RV_HEADERS });
    assert.equal(r.json.candidates[0].alias, 'C-01');
    assert.equal(JSON.stringify(r.json).includes('教师a'), false);
    r = await call(base, 'POST', '/rounds/R-HTTP/scores', {
      headers: RV_HEADERS,
      body: { alias: 'C-01', materialVersion: 1, values: { ethics: 90, teaching: 88, 'student-development': 86, 'public-service': 84 } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await call(base, 'POST', '/rounds/R-HTTP/close-scoring');
    r = await call(base, 'GET', '/rounds/R-HTTP/signing-package', { headers: RV_HEADERS });
    const pkg = r.json;
    r = await call(base, 'POST', '/rounds/R-HTTP/sign', { headers: RV_HEADERS, body: { materialVersion: pkg.materialVersion, tallyHash: pkg.tallyHash } });
    assert.equal(r.json.signed, true);
    r = await call(base, 'GET', '/rounds/R-HTTP/blockers');
    assert.deepEqual(r.json, []);
    r = await call(base, 'POST', '/rounds/R-HTTP/publish');
    assert.equal(r.json.publicationVersion, 1);
    r = await call(base, 'GET', '/rounds/R-HTTP/publication', { headers: {} });
    assert.equal(r.json.results[0].name, '教师a');
    r = await call(base, 'GET', '/rounds/R-HTTP/audit/verify');
    assert.equal(r.json.ok, true);
    // 未授权访问被拒
    r = await call(base, 'GET', '/rounds/R-HTTP/secretary-view', { headers: RV_HEADERS });
    assert.equal(r.status, 403);
    r = await call(base, 'GET', '/rounds/R-HTTP/secretary-view', { headers: {} });
    assert.equal(r.status, 403);
  } finally {
    server.close();
  }
});
