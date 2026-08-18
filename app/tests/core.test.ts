import { describe, it, expect } from 'vitest';
import { mapVerdict, EVIDENCE_LEVEL_INFO, DISCLAIMER } from '../src/court/evidence';
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
    expect(mapVerdict({ ...base, e5: 1 }, 'none', usable, true).word).toBe('卫生');
  });
  it('署名完整 → 卫生（优先于指纹）', () => {
    expect(mapVerdict({ ...base, e4: 1 }, 'complete', usable, true).word).toBe('卫生');
  });
  it('内容不可用 → 休庭（优先于一切）', () => {
    expect(mapVerdict({ ...base, e4: 1 }, 'none', false, true).word).toBe('休庭');
  });
  it('无候选源 → 休庭而非卫生', () => {
    expect(mapVerdict(base, 'none', usable, false).word).toBe('休庭');
  });
  it('干净 → 卫生且 rule 说明未发现≠清白', () => {
    const v = mapVerdict(base, 'none', usable, true);
    expect(v.word).toBe('卫生');
    expect(v.rule).toContain('不等于');
  });
  it('E3≥3 但无 E2 → 可能不卫生（措辞保持克制）', () => {
    expect(mapVerdict({ ...base, e3: 4, e3DistinctFingerprints: 4 }, 'none', usable, true).word).toBe('可能不卫生');
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
  it('免责声明包含非法律结论与不做动机推断', () => {
    expect(DISCLAIMER).toContain('非法律结论');
    expect(DISCLAIMER).toContain('动机');
  });
  it('E1-E5 分级齐备', () => {
    for (const k of ['E1', 'E2', 'E3', 'E4', 'E5'] as const) {
      expect(EVIDENCE_LEVEL_INFO[k].name).toBeTruthy();
    }
  });
});
