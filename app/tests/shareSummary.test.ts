import { describe, expect, it } from 'vitest';
import { buildShareSummary } from '../src/ui/verdictExport';

// v3.7 核查摘要：五裁决差异化 + 零内部代号 + 边界段恒在（内容规范见协作基点 2026-08-23）

const baseDoc = (over: Record<string, unknown> = {}) => ({
  caseFile: {
    caseId: 'HC-TEST',
    target: { title: '324-为什么美国会出现3K党这样的组织？ - 独树不成林 - Apple 播客', text: 'x', contentType: 'podcast_episode', degraded: false },
    createdAt: '2026-08-23T08:53:50.203Z',
  },
  sources: [
    { id: 'SRC1', title: 'The Ku Klux Klan: The Rise of Evil (Part 1)', url: 'https://podcasts.apple.com/us/podcast/x?i=1', partial: false, reversed: false, origin: 'search', subjectRelation: 'direct_source' },
    { id: 'SRC2', title: 'An article', url: 'https://example.com/a', partial: false, reversed: false, origin: 'search', subjectRelation: 'unknown' },
  ],
  evidence: [],
  verdict: { word: '可能卫生', rule: 'r', counts: {}, attribution: 'unknown' },
  overview: '已完成 2 个候选源核查；0 组正式查证，0 条线索未准入。',
  admission: { required: 2, admitted: 0, discovered: 0, status: 'insufficient' },
  generatedAt: '2026-08-23T08:53:50.203Z',
  limits: [],
  ...over,
});

const strongEvidence = (id: string) => ({
  id, level: 'E3', kind: '细节指纹', description: 'FP8（data_combo）在 SRC1 命中——25万南方白人死亡与近五分之一成年男性的数字组合完全对应。',
  targetQuote: '二十五万南方白人士兵死亡', sourceQuote: 'some english quote', targetQuoteLocated: true, sourceQuoteLocated: true,
  sourceId: 'SRC1', sourceTitle: 'The Ku Klux Klan: The Rise of Evil (Part 1)', sourceUrl: 'https://podcasts.apple.com/us/podcast/x?i=1',
  examVerdict: 'expression_copy', plainTitle: '相同统计数字组合',
  detail: { subjectRelation: 'direct_source' },
});
const negativeEvidence = (id: string, src = 'SRC1') => ({
  id, level: 'E1', kind: '已查证无对应', description: '已逐段比对：无对应', sourceId: src,
  targetQuoteLocated: true, sourceQuoteLocated: true, detail: { negative: true, subjectRelation: 'direct_source' },
});

describe('v3.7 核查摘要 buildShareSummary', () => {
  it('不卫生：列最强证据，含源链接与边界段', () => {
    const doc = baseDoc({
      verdict: { word: '不卫生', rule: 'r', counts: {}, attribution: 'partial' },
      evidence: [strongEvidence('EV-FP8-SRC1')],
      admission: { required: 2, admitted: 3, discovered: 3, status: 'sufficient' },
      overview: '认可3组证据：多组罕见统计数字与命名细节逐字对应。',
    });
    const s = buildShareSummary(doc);
    expect(s).toContain('裁决：不卫生');
    expect(s).toContain('最强证据');
    expect(s).toContain('相同统计数字组合');
    expect(s).toContain('https://podcasts.apple.com');
    expect(s).toContain('边界：检索不穷尽');
    expect(s).toContain('https://ren1003497048-del.github.io/health-court/');
  });

  it('可能卫生：改列负面查证规模，不出现最强证据字样', () => {
    const doc = baseDoc({
      evidence: [negativeEvidence('EV-NEG-SRC1'), negativeEvidence('EV-NEG-SRC2', 'SRC2')],
    });
    const s = buildShareSummary(doc);
    expect(s).toContain('裁决：可能卫生');
    expect(s).toContain('正式证据 0 组');
    expect(s).toContain('2 个候选源中 2 个已逐段比对');
    expect(s).not.toContain('最强证据');
  });

  it('不足立案与休庭：不出具倾向性表述', () => {
    const s1 = buildShareSummary(baseDoc({
      verdict: { word: '不足立案', rule: 'r', counts: {}, attribution: 'unknown' },
      evidence: [negativeEvidence('EV-NEG-SRC1')],
    }));
    expect(s1).toContain('线索 1 条');
    expect(s1).toContain('不出具倾向性裁决');
    const s2 = buildShareSummary(baseDoc({
      verdict: { word: '休庭', rule: 'r', counts: {}, attribution: 'unknown' },
    }));
    expect(s2).toContain('休庭');
    expect(s2).toContain('未能进入对质');
  });

  it('零内部代号（公理2）：E3/SRC/FP/expression_copy 不得出现', () => {
    const doc = baseDoc({
      verdict: { word: '不卫生', rule: 'r', counts: {}, attribution: 'partial' },
      evidence: [strongEvidence('EV-FP8-SRC1')],
      admission: { required: 2, admitted: 3, discovered: 3, status: 'sufficient' },
    });
    const s = buildShareSummary(doc);
    expect(/\bE[1-5]\b/.test(s)).toBe(false);
    expect(/\bSRC\d+/.test(s)).toBe(false);
    expect(/\bFP\d+/.test(s)).toBe(false);
    expect(s).not.toContain('expression_copy');
  });

  it('标题截断去掉平台尾巴（- 独树不成林 - Apple 播客）', () => {
    const s = buildShareSummary(baseDoc());
    expect(s).toContain('【卫生法庭·核查摘要】324-为什么美国会出现3K党这样的组织？');
    expect(s).not.toContain('Apple 播客');
  });

  it('边界段五种裁决均存在（公理5，不可谈判）', () => {
    for (const word of ['不卫生', '可能不卫生', '可能卫生', '不足立案', '休庭']) {
      const s = buildShareSummary(baseDoc({ verdict: { word, rule: 'r', counts: {}, attribution: 'unknown' } }));
      expect(s).toContain('边界：检索不穷尽');
      expect(s).toContain('非法律认定');
    }
  });
});
