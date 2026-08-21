import { cjkPunctNormalize } from '../src/court/textUtils';
import { describe, it, expect } from 'vitest';
import {
  mapVerdict,
  EVIDENCE_LEVEL_INFO,
  DISCLAIMER,
  MIN_ADMISSIBLE_EVIDENCE_GROUPS,
  isAdmissibleEvidence,
  looksLikeSharedNewsFact,
  isFormalControversyReport,
} from '../src/court/evidence';
import { locateQuote, locateExact, normalize, similarity, segment, truncateSmart, parseJinaMarkdown } from '../src/court/textUtils';

describe('裁决映射（PRD §4.2 阈值）', () => {
  const base = { e1: true, e2: false, e3: 0, e4: 0, e3DistinctFingerprints: 0, e5: 0 };
  const usable = true;

  it('E4 命中 → 不卫生', () => {
    expect(mapVerdict({ ...base, e4: 1 }, 'none', usable, true).word).toBe('不卫生');
    expect(mapVerdict({ ...base, e4: 3 }, 'partial', usable, true).word).toBe('不卫生');
  });
  it('E2 + ≥3 E3 指纹 → 不卫生（实锤标准）', () => {
    expect(mapVerdict({ ...base, e2: true, e3: 3, e3DistinctFingerprints: 3 }, 'none', usable, true).word).toBe('不卫生');
  });
  it('E2 + 2 E3 → 可能不卫生', () => {
    expect(mapVerdict({ ...base, e2: true, e3: 2, e3DistinctFingerprints: 2 }, 'none', usable, true).word).toBe('可能不卫生');
  });
  it('单 E3 指纹 → 可能不卫生', () => {
    expect(mapVerdict({ ...base, e3: 1, e3DistinctFingerprints: 1 }, 'none', usable, true).word).toBe('可能不卫生');
  });
  it('E1+E2 → 可能不卫生', () => {
    expect(mapVerdict({ ...base, e2: true }, 'none', usable, true).word).toBe('可能不卫生');
  });
  it('E5 ≥2 → 可能不卫生；E5=1 → 不构成', () => {
    expect(mapVerdict({ ...base, e5: 2 }, 'none', usable, true).word).toBe('可能不卫生');
    expect(mapVerdict({ ...base, e5: 1 }, 'none', usable, true).word).toBe('可能卫生');
  });
  it('署名完整不再短路：E4 命中照样不卫生（P0 修正·364案）', () => {
    expect(mapVerdict({ ...base, e4: 1 }, 'complete', usable, true).word).toBe('不卫生');
  });
  it('署名完整且无指纹命中 → 卫生（注记署名）', () => {
    expect(mapVerdict(base, 'complete', usable, true).word).toBe('可能卫生');
  });
  it('内容不可用 → 休庭（优先于一切）', () => {
    expect(mapVerdict({ ...base, e4: 1 }, 'none', false, true).word).toBe('休庭');
  });
  it('无候选源 → 休庭而非卫生', () => {
    expect(mapVerdict(base, 'none', usable, false).word).toBe('休庭');
  });
  it('干净 → 卫生且 rule 说明未发现≠清白', () => {
    const v = mapVerdict(base, 'none', usable, true);
    expect(v.word).toBe('可能卫生');
    expect(v.rule).toContain('不等于');
  });
  it('E3≥3 但无 E2 → 可能不卫生（措辞保持克制）', () => {
    expect(mapVerdict({ ...base, e3: 4, e3DistinctFingerprints: 4 }, 'none', usable, true).word).toBe('可能不卫生');
  });
  it('正式证据不足 3 组时不出具倾向性裁决', () => {
    expect(MIN_ADMISSIBLE_EVIDENCE_GROUPS).toBe(3);
    expect(mapVerdict({ ...base, e3: 2, e3DistinctFingerprints: 2 }, 'none', usable, true, 2).word).toBe('不足立案');
  });
});

describe('S60HBY 证据可信度回归', () => {
  it('针对明确候选源的负面查证计一组，同题线索不计', () => {
    expect(isAdmissibleEvidence({ id: 'NEG1', level: 'E1', kind: 'negative', description: '已查证无对应', sourceId: 'SRC2', detail: { negative: true } })).toBe(true);
    expect(isAdmissibleEvidence({ id: 'TOPIC1', level: 'E1', kind: 'topic', description: '仅主题相同' })).toBe(false);
  });
  it('多家媒体共有的日期+官方事件要素识别为新闻公共事实', () => {
    const newsItem = { id: 'FP1', level: 'E3' as const, kind: 'data_combo', description: '2026年5月25日教皇发布人工智能通谕', targetQuote: '2026年5月25日发布名为《》的通谕', sourceQuote: '教皇于2026年5月25日发布通谕', targetQuoteLocated: true, sourceQuoteLocated: true, detail: { fingerprintType: 'data_combo', alsoSources: [{}, {}, {}, {}, {}, {}] } };
    expect(looksLikeSharedNewsFact(newsItem, 6)).toBe(true);
    expect(isAdmissibleEvidence(newsItem)).toBe(false);
  });
  it('R6 拒绝 Reddit 问答和同题碎片，只接收与作品直接相关的指控报道', () => {
    const target = { title: '355-教皇如何因人工智能撕裂美国右翼？', author: '独树不成林' };
    expect(isFormalControversyReport({ title: '为什么新教皇抄用旧名字？', url: 'https://www.reddit.com/r/AskHistorians/x' }, target)).toBe(false);
    expect(isFormalControversyReport({ title: '教皇新通谕的建筑限额', url: 'https://example.com/quota' }, target)).toBe(false);
    expect(isFormalControversyReport({ title: '《教皇如何因人工智能撕裂美国右翼》被指洗稿', url: 'https://news.example.com/report' }, target)).toBe(true);
  });
});

describe('防幻觉引文定位', () => {
  const text = '伊朗国王设立了完整的法庭包括卫生法庭和扫盲法庭，把扫盲法庭从首都德黑兰派到农村。';
  it('精确命中（含标点差异）', () => {
    expect(locateExact('卫生法庭和扫盲法庭', text)).toBe(true);
  });
  it('ASR 错别字下模糊命中', () => {
    expect(locateQuote('卫生法庭和扫盲法庭，把扫盲法庭派到农村', text)).toBe(true);
  });
  it('完全无关引文不命中', () => {
    expect(locateQuote('拿破仑在滑铁卢战役中失败了这个说法广为流传', text)).toBe(false);
  });
  it('过短引文拒绝定位', () => {
    expect(locateExact('法庭', text)).toBe(false);
  });
  it('相似度对同源文本高、对无关文本低', () => {
    expect(similarity(normalize('卫生法庭和扫盲法庭'), normalize('卫生法庭、扫盲法庭'))).toBeGreaterThan(0.6);
    expect(similarity(normalize('卫生法庭和扫盲法庭'), normalize('滑铁卢战役失败'))).toBeLessThan(0.2);
  });
});

describe('立案门槛（评定对象=完整文化内容整体）', () => {
  it('parseDurationMinutes 解析分钟与小时组合', async () => {
    const { parseDurationMinutes } = await import('../src/pipeline/index');
    expect(parseDurationMinutes('第310期 36分钟 · 3天前 播放数 5555')).toBe(36);
    expect(parseDurationMinutes('本期 1小时02分')).toBe(60); // 无'分钟'字样时小时兜底
    expect(parseDurationMinutes('1小时05分钟')).toBe(65);
    expect(parseDurationMinutes('无时长信息')).toBe(null);
  });
});

describe('归属预审（P0-1）', () => {
  it('粘贴文本与立案层共用 100 字门槛', async () => {
    const { preReview, MIN_TARGET_TEXT_CHARS } = await import('../src/court/preReview');
    const { MIN_TARGET_CHARS } = await import('../src/pipeline/index');
    expect(MIN_TARGET_TEXT_CHARS).toBe(100);
    expect(MIN_TARGET_CHARS).toBe(MIN_TARGET_TEXT_CHARS);
    expect(preReview({ text: '文'.repeat(99), fetched: { title: '短片段', text: '文'.repeat(99) } }).pass).toBe(false);
    expect(preReview({ text: '文'.repeat(100), fetched: { title: '完整短篇', text: '文'.repeat(100) } }).pass).toBe(true);
  });
  it('播客单集页面仅含简介 → 不通过，要求转录', async () => {
    const { preReview, isSubstantialBody, parseEpisodeMinutes } = await import('../src/court/preReview');
    expect(isSubstantialBody('这是一段简短的shownotes介绍，大约一百字。', 'podcast')).toBe(false);
    const r = preReview({ url: 'https://www.xiaoyuzhoufm.com/episode/abc', text: '', fetched: { title: '第310期', text: '简短简介'.repeat(10) } });
    expect(r.pass).toBe(false);
    // 364案回归：含"相关单集列表"的长页面（5000+字、39分钟）也必须拦截
    const dur = parseEpisodeMinutes('第364期 39 分钟 · 3天前');
    expect(dur).toBe(39);
    expect(isSubstantialBody('介绍文字'.repeat(1300), 'podcast', 39)).toBe(false); // 5200字 < 5850（39分钟×150）拦截
    expect(isSubstantialBody('介绍文字'.repeat(1000), 'podcast', 39)).toBe(false); // 4000字 < 5850 拦截
    expect(isSubstantialBody('节目转录正文'.repeat(2000), 'podcast', 39)).toBe(true);   // 8000字 ≥ 5850 通过
    expect(r.completeness.hasSubstantialBody).toBe(false);
  });
  it('长转录稿/文章正文 → 通过', async () => {
    const { preReview } = await import('../src/court/preReview');
    const body = '这是完整的节目转录内容。'.repeat(600);
    const r = preReview({ url: 'https://mp.weixin.qq.com/s/xyz', text: '', fetched: { title: '文章', text: body } });
    expect(r.pass).toBe(true);
  });
  it('日期提取精确到年月日', async () => {
    const { extractDate } = await import('../src/court/preReview');
    expect(extractDate('发布时间：2026年8月17日 UTC').date).toBe('2026-08-17');
    expect(extractDate('2025-08-06 something').precision).toBe('day');
    expect(extractDate('2026年5月').precision).toBe('month');
  });
});

describe('源质量闸门（P0-4）', () => {
  it('闸门常量就位', async () => {
    const { SOURCE_QUALITY_GATE } = await import('../src/court/evidence');
    expect(SOURCE_QUALITY_GATE.minTextChars).toBeGreaterThanOrEqual(800);
    expect(SOURCE_QUALITY_GATE.parkDomainWords.length).toBeGreaterThan(0);
  });
});

describe('中文标点归一化（v2.2）', () => {
  it('中文语境半角双引号→「」配对，逗号冒号→全角', () => {
    expect(cjkPunctNormalize('他说"这是抄袭",然后离开: 没问题')).toBe('他说「这是抄袭」，然后离开： 没问题');
  });
  it('英文语境（前后无 CJK）保持半角原样', () => {
    expect(cjkPunctNormalize('He said "copy", and left: fine')).toBe('He said "copy", and left: fine');
  });
  it('混合：紧邻中文的半角引号转「」（配对），中文侧逗号归一化', () => {
    const out = cjkPunctNormalize('他说"health corps"这个短语,被误听');
    // 紧邻 CJK 的成对引号→「」；紧邻 CJK 的逗号→全角
    expect(out).toBe('他说「health corps」这个短语，被误听');
  });
});

describe('文本工具', () => {
  it('segment 按句界切且长度合理', () => {
    const t = '第一句。第二句还是这里。第三句结束在这里！第四句很短。';
    const segs = segment(t, 12);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs.join('')).toContain('第一句');
  });
  it('truncateSmart 保留头尾', () => {
    const t = 'A'.repeat(5000);
    const r = truncateSmart(t, 1000);
    expect(r.length).toBeLessThan(1200);
    expect(r).toContain('省略');
    expect(r.startsWith('AAAA')).toBe(true);
    expect(r.endsWith('AAAA')).toBe(true);
  });
  it('parseJinaMarkdown 解析 Title 与正文', () => {
    const md = 'Title: 独树不成林\nURL Source: https://x.com\nMarkdown Content:\n正文开始';
    const p = parseJinaMarkdown(md);
    expect(p.title).toBe('独树不成林');
    expect(p.body).toBe('正文开始');
  });
});

describe('固定文案完整性（措辞红线不可漂移）', () => {
  it('免责声明含工作性分类边界与不做动机推断（podcastreview 框架）', () => {
    expect(DISCLAIMER).toContain('工作性分类');
    expect(DISCLAIMER).toContain('不构成任何机构');
    expect(DISCLAIMER).toContain('动机');
    expect(DISCLAIMER).toContain('自行判断');
  });
  it('E1-E5 分级齐备', () => {
    for (const k of ['E1', 'E2', 'E3', 'E4', 'E5'] as const) {
      expect(EVIDENCE_LEVEL_INFO[k].name).toBeTruthy();
    }
  });
});
