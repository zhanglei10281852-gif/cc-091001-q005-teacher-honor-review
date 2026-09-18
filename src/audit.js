import { hashObject } from './canon.js';

// 追加式审计日志：每条事件携带前一条的哈希形成链，
// 任何事后篡改都会破坏链条并被 verify() 检出。
export class AuditLog {
  constructor() {
    this.events = [];
  }

  append({ type, actor = null, payload = {}, at }) {
    const seq = this.events.length + 1;
    const prevHash = this.events.length === 0 ? 'GENESIS' : this.events[this.events.length - 1].hash;
    const entry = {
      seq,
      type,
      at: new Date(at).toISOString(),
      actor: actor ? { role: actor.role, id: actor.id } : null,
      payload,
    };
    const hash = hashObject({ ...entry, prevHash });
    const stored = { ...entry, prevHash, hash };
    this.events.push(stored);
    return stored;
  }

  verify() {
    let prevHash = 'GENESIS';
    for (const event of this.events) {
      const { prevHash: storedPrev, hash, ...core } = event;
      if (storedPrev !== prevHash) {
        return { ok: false, brokenAt: event.seq, reason: 'PREV_HASH_MISMATCH' };
      }
      if (hashObject({ ...core, prevHash }) !== hash) {
        return { ok: false, brokenAt: event.seq, reason: 'HASH_MISMATCH' };
      }
      prevHash = hash;
    }
    return { ok: true, length: this.events.length };
  }
}
