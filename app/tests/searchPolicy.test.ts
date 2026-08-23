import { describe, expect, it } from 'vitest';
import { evidenceExclusionReason, normalizeEvidenceForSources, type EvidenceItem } from '../src/court/evidence';
import { shouldSupplementEvidence } from '../src/pipeline';
import type { SourceDoc } from '../src/court/types';

const clue = (detail: Record<string, unknown> = {}): EvidenceItem => ({
  id: 'EV-FP1-SRC1',
  level: 'E3',
  kind: '细节指纹',
  description: '具体对应',
  targetQuote: '错误扩展的被检段落',
  sourceQuote: '错误扩展的来源段落',
  targetQuoteLocated: true,
  sourceQuoteLocated: true,
  sourceId: 'SRC1',
  examVerdict: 'expression_copy',
  detail,
});

const source = (patch: Partial<SourceDoc> = {}): SourceDoc => ({
  id: 'SRC1',
  title: '候选来源',
  url: 'https://example.com/source',
  partial: false,
  reversed: false,
  origin: 'search',
  subjectRelation: 'direct_source',
  similarity: 90,
  ...patch,
});

describe('evidence and supplemental-search policy', () => {
  it('restores exact hit phrases for old archives and rejects postdated sources', () => {
    const normalized = normalizeEvidenceForSources([
      clue({
        hitPhraseTarget: '精确被检句。',
        hitPhraseSource: '开头句。真正相关的来源句连续存在于上下文中，而且长度足够用于核验。',
        contextTarget: '上文。精确被检句。下文。',
        contextSource: '开头句。页面导航和其他两段文字。真正相关的来源句连续存在于上下文中，而且长度足够用于核验。',
      }),
    ], [source({ reversed: true, subjectRelation: 'same_event' })]);

    expect(normalized[0].targetQuote).toBe('精确被检句。');
    expect(normalized[0].sourceQuote).toBeUndefined();
    expect(normalized[0].sourceQuoteLocated).toBe(false);
    expect(evidenceExclusionReason(normalized[0])).toContain('晚于被检内容');
  });

  it('keeps an unknown source relation out of the formal evidence count', () => {
    expect(evidenceExclusionReason(clue({ subjectRelation: 'unknown' }))).toContain('关系尚未完成确认');
  });

  it('requests one supplemental round when concrete clues exist but the filing threshold is unmet', () => {
    expect(shouldSupplementEvidence([clue({ subjectRelation: 'unknown' })], [source({ subjectRelation: 'unknown' })])).toBe(true);
    expect(shouldSupplementEvidence([], [source({ similarity: 20 })])).toBe(false);
    // v3.5 波次纪律：正式证据已达立案门槛（3 条可采信 ≥ 2 组）即不再补源——
    // 提前终止优先于扩张（旧策略「高相似候选恒补源」是 21 源恶性循环的推手，已废除）
    expect(shouldSupplementEvidence([
      clue({ subjectRelation: 'direct_source' }),
      { ...clue({ subjectRelation: 'direct_source' }), id: 'EV-FP2-SRC1' },
      { ...clue({ subjectRelation: 'direct_source' }), id: 'EV-FP3-SRC1' },
    ], [source({ similarity: 88 })])).toBe(false);
    // v3.5.1（UOF5I9 案）：负面证据（已查证无对应）不算正面组——
    // 第 1 波全负面时必须补源扩张（旧逻辑把 3 条负面算成「3 组证据」导致 11 源未对质即宣判）
    const negative = (id: string): EvidenceItem => ({
      id, level: 'E1', kind: '已查证无对应', description: '逐段比对无对应',
      sourceId: 'SRC1', targetQuoteLocated: true, sourceQuoteLocated: true,
      detail: { negative: true, subjectRelation: 'direct_source' },
    });
    expect(shouldSupplementEvidence([
      negative('EV-NEG-SRC1'), negative('EV-NEG-SRC2'), negative('EV-NEG-SRC3'),
    ], [source({ similarity: 88 })])).toBe(true);
  });
});
