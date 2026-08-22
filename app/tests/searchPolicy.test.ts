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
    expect(shouldSupplementEvidence([
      clue({ subjectRelation: 'direct_source' }),
      { ...clue({ subjectRelation: 'direct_source' }), id: 'EV-FP2-SRC1' },
      { ...clue({ subjectRelation: 'direct_source' }), id: 'EV-FP3-SRC1' },
    ], [source({ similarity: 88 })])).toBe(true);
  });
});
