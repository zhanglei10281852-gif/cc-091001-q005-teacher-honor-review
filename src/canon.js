import { createHash } from 'node:crypto';

// 规范化序列化：对象键排序、数组保序，保证同一内容在任何时刻得到同一哈希，
// 材料版本、计票结果、公布内容、审计事件的可辨识性都建立在此基础上。
export function canonicalize(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashObject(value) {
  return sha256(canonicalize(value));
}
