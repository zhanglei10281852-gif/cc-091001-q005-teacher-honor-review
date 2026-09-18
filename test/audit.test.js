import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewService } from '../src/review-service.js';

const SEC = { role: 'secretary', id: 'sec-1' };

function setup() {
  const now = { d: new Date('2026-07-01T00:00:00Z') };
  const s = new ReviewService({ clock: () => now.d });
  s.createRound(SEC, {
    roundId: 'R-1',
    quorum: 1,
    nominationDeadline: '2026-08-01T00:00:00Z',
    materialDeadline: '2026-09-01T00:00:00Z',
  });
  s.addCandidate(SEC, 'R-1', {
    candidateId: 'a', name: '教师a', school: '学校a', yearsOfService: 10, ethicsRecord: 'clean', materials: {},
  });
  s.verifyEligibility(SEC, 'R-1', 'a');
  now.d = new Date('2026-09-02T00:00:00Z');
  s.sealMaterials(SEC, 'R-1');
  return s;
}

test('审计日志哈希链完整可校验', () => {
  const s = setup();
  const result = s.verifyAudit(SEC, 'R-1');
  assert.equal(result.ok, true);
  assert.ok(result.length >= 4); // 建轮、登记、核验、封存
  const events = s.getAuditLog(SEC, 'R-1');
  assert.equal(events[0].prevHash, 'GENESIS');
  for (let i = 1; i < events.length; i += 1) {
    assert.equal(events[i].prevHash, events[i - 1].hash);
  }
});

test('篡改历史事件会被校验发现', () => {
  const s = setup();
  const round = s.rounds.get('R-1');
  round.audit.events[1].payload.note = '事后篡改';
  const result = s.verifyAudit(SEC, 'R-1');
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 2);
});

test('追加事件携带操作者身份', () => {
  const s = setup();
  const events = s.getAuditLog(SEC, 'R-1');
  for (const e of events) {
    assert.equal(e.actor.role, 'secretary');
    assert.equal(e.actor.id, 'sec-1');
  }
});
