import { beforeEach, describe, expect, it, vi } from 'vitest';
// v3.6 快照模块：localStorage 需 mock（Node 环境无 DOM）
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
});

import { saveTrialSnapshot, loadTrialSnapshot, clearTrialSnapshot, stageLabelZh, type TrialSnapshot } from '../src/store/trialSnapshot';

const mkSnap = (patch: Partial<TrialSnapshot> = {}): TrialSnapshot => ({
  version: 1,
  savedAt: new Date().toISOString(),
  stage: 'discovered',
  cf: { caseId: 'T1', createdAt: new Date().toISOString(), input: {}, target: { title: 't', text: 'x', contentType: 'unknown', degraded: false }, fingerprints: [], leads: [], attribution: 'unknown' },
  sources: [{ id: 'SRC1', title: 's', url: 'https://a.com', partial: false, reversed: false, origin: 'search' }],
  evidence: [],
  logs: [],
  ...patch,
});

describe('v3.6 庭审中断快照', () => {
  beforeEach(() => store.clear());

  it('保存与恢复往返一致；快照不含任何 Key 字段', () => {
    const snap = mkSnap();
    expect(saveTrialSnapshot(snap)).toBe(true);
    const back = loadTrialSnapshot();
    expect(back?.cf.caseId).toBe('T1');
    expect(back?.sources.length).toBe(1);
    // Key 安全：快照结构里不允许出现 apiKey/groqKey 类字段
    const raw = store.get('health-court.trialSnapshot.v1') || '';
    expect(/apikey|groqkey|serperkey|jinakey|sk-|gsk_/i.test(raw)).toBe(false);
  });

  it('quota 超限时三级降级：截断源全文仍可写', () => {
    const big = mkSnap({
      sources: [{ id: 'SRC1', title: 's', url: 'https://a.com', partial: false, reversed: false, origin: 'search', fullText: 'A'.repeat(5 * 1024 * 1024) }],
    });
    const ok = saveTrialSnapshot(big);
    expect(ok).toBe(true);
    const back = loadTrialSnapshot();
    // 降级后 fullText 被截断（<=40K+截断标记）或整段丢弃，但源条目仍在
    expect(back?.sources.length).toBe(1);
    expect((back?.sources[0].fullText || '').length).toBeLessThanOrEqual(41000);
  });

  it('写入抛异常（真超配额）不阻塞：返回 false', () => {
    const realSet = store.set.bind(store);
    store.set = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    expect(saveTrialSnapshot(mkSnap())).toBe(false);
    store.set = realSet;
  });

  it('损坏的快照返回 null（不炸主流程）；清除后为 null', () => {
    store.set('health-court.trialSnapshot.v1', '{broken json');
    expect(loadTrialSnapshot()).toBeNull();
    store.set('health-court.trialSnapshot.v1', JSON.stringify({ version: 2 }));
    expect(loadTrialSnapshot()).toBeNull();
    const ok = saveTrialSnapshot(mkSnap());
    expect(ok).toBe(true);
    clearTrialSnapshot();
    expect(loadTrialSnapshot()).toBeNull();
  });

  it('阶段中文名映射齐全（用户可见文案）', () => {
    for (const s of ['filed', 'investigated', 'discovered', 'waves', 'supplemented'] as const) {
      expect(stageLabelZh(s)).toBeTruthy();
    }
  });
});
