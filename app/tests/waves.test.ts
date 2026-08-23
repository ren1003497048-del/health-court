import { describe, expect, it } from 'vitest';
import { rankForWaves, WAVE1_SIZE, WAVE2_SIZE, WAVE_HARD_CAP } from '../src/pipeline/waves';
import type { SourceDoc } from '../src/court/types';
import type { CaseFile } from '../src/court/types';

// v3.5 波次检索单元测试：排序信号 / 三波分配 / 提前终止由集成验证，此处固化纯函数行为

const mkSource = (patch: Partial<SourceDoc> = {}): SourceDoc => ({
  id: 'SRC1',
  title: 'A history article',
  url: 'https://example.com/article',
  partial: false,
  reversed: false,
  origin: 'search',
  similarity: 50,
  ...patch,
});

const mkCf = (kw: string[] = []): CaseFile => ({
  caseId: 'T1',
  createdAt: new Date().toISOString(),
  input: {},
  target: { title: '测试目标', text: 'x'.repeat(200), contentType: 'unknown', degraded: false },
  fingerprints: kw.map((k, i) => ({
    id: `FP${i}`,
    type: 'rare_case',
    priority: 'normal',
    targetQuote: '引文',
    searchKeywordsZh: [],
    searchKeywordsEn: [k],
  })),
  leads: [],
  attribution: 'unknown',
});

describe('v3.5 波次排序信号', () => {
  it('播客单集（同媒介）加权高于普通文章', () => {
    const cf = mkCf();
    const article = mkSource({ id: 'SRC1', similarity: 60 });
    const episode = mkSource({ id: 'SRC2', similarity: 55, url: 'https://podcasts.apple.com/x?i=12345', title: 'Some Episode' });
    const ranked = rankForWaves(cf, [article, episode]);
    expect(ranked[0].id).toBe('SRC2');
  });

  it('百科/通史降权——同分时排在普通文章之后', () => {
    const cf = mkCf();
    const wiki = mkSource({ id: 'SRC1', similarity: 60, url: 'https://en.wikipedia.org/wiki/KKK', title: 'KKK - Wikipedia' });
    const article = mkSource({ id: 'SRC2', similarity: 60 });
    const ranked = rankForWaves(cf, [wiki, article]);
    expect(ranked[0].id).toBe('SRC2');
  });

  it('标题含指纹英文检索词的源获得命中加成', () => {
    const cf = mkCf(['Ku Klux Klan', '1866 Pulaski']);
    const plain = mkSource({ id: 'SRC1', similarity: 60, title: 'A general history essay', snippet: 'nothing relevant' });
    const hit = mkSource({ id: 'SRC2', similarity: 60, title: 'Ku Klux Klan origins', snippet: 'the 1866 Pulaski founding' });
    const ranked = rankForWaves(cf, [plain, hit]);
    expect(ranked[0].id).toBe('SRC2');
  });

  it('相似度仍为主信号——高相似百科不因降权被普通文章反超过多', () => {
    const cf = mkCf();
    const wiki = mkSource({ id: 'SRC1', similarity: 95, url: 'https://baike.baidu.com/item/x', title: '百科条目' });
    const article = mkSource({ id: 'SRC2', similarity: 50 });
    const ranked = rankForWaves(cf, [wiki, article]);
    expect(ranked[0].id).toBe('SRC1'); // 95-15=80 > 50
  });
});

describe('v3.5 波次常量（用户定稿参数）', () => {
  it('第1波 3 源 / 第2波累计 8 源 / 硬上限 14', () => {
    expect(WAVE1_SIZE).toBe(3);
    expect(WAVE2_SIZE).toBe(8);
    expect(WAVE_HARD_CAP).toBe(14);
  });
});
