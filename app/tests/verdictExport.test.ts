import { describe, expect, it } from 'vitest';
import { buildVerdictHtml } from '../src/ui/verdictExport';

describe('判决书导出回归', () => {
  it('清理媒体噪声、链接化局限 URL，并对历史档案执行 3 组门槛', () => {
    const html = buildVerdictHtml({
      generatedAt: '2026-08-22T10:00:00+08:00',
      caseFile: { caseId: 'HC-TEST', target: { title: '测试标的', url: 'https://target.example.com' }, profile: { summaryZh: '测试' }, trialLog: [{ at: '2026-08-22T10:00:00+08:00', role: 'clerk', action: '完成立案' }] },
      verdict: { word: '可能不卫生', rule: '旧裁决', attribution: 'none', counts: { E1: 0, E2: 0, E3: 1, E4: 0, E5: 0 } },
      sources: [], overview: '数据组合相似度为90%', opinion: '保持克制', disclaimer: '非法律结论',
      limits: ['【外界指控】错误收录 https://www.reddit.com/r/AskHistorians/x', '详见 https://example.com/very/long/path?q=1'],
      evidence: [{ id: 'EV1', level: 'E3', kind: 'data_combo', description: '一组线索', sourceId: 'SRC1', sourceTitle: '来源', sourceUrl: 'https://source.example.com', targetQuote: '[Image 9: 评论数](https://cdn.example.com/c.svg)154 正文', sourceQuote: '![Politico 头图](https://cdn.example.com/p.jpg) 源文', targetQuoteLocated: true, sourceQuoteLocated: true, examVerdict: 'expression_copy' }],
    } as any);
    expect(html).toContain('不足立案');
    expect(html).not.toContain('Image 9');
    expect(html).not.toContain('Politico 头图');
    expect(html).not.toContain('数据组合相似度');
    expect(html).not.toContain('AskHistorians');
    expect(html).toContain('相似度仅用于检索排序');
    expect(html).toContain('href="https://example.com/very/long/path?q=1"');
    expect(html).toContain('overflow-wrap:anywhere');
  });
});
