import { describe, it, expect } from 'vitest';
import { mapVerdict, PLAIN_CRITERIA, plainLevelName } from '../src/court/evidence';

describe('v2.2.2 判据重定义与白话呈现', () => {
  it('四判据不含"长距离顺序"，改为"论证链同构"并含 ≥3 环节要求', () => {
    expect(PLAIN_CRITERIA.some((c) => c.name === '论证链同构')).toBe(true);
    expect(PLAIN_CRITERIA.find((c) => c.name === '论证链同构')?.question).toContain('3 个环节');
    expect(PLAIN_CRITERIA.some((c) => c.name.includes('长距离顺序'))).toBe(false);
  });

  it('E2 白话名 = 论证链同构（集中接触痕迹）', () => {
    expect(plainLevelName('E2')).toBe('论证链同构（集中接触痕迹）');
  });

  it('E1 白话名 = 已查证无对应（不再叫"主题相同"）', () => {
    expect(plainLevelName('E1')).toBe('已查证无对应（负面查证）');
  });

  it('裁决规则文案不含 E 代号（白话）', () => {
    const v = mapVerdict({ e4: 1, e3: 0, e3DistinctFingerprints: 0, e2: false, e1: false, e5: 0 } as any, 'complete', true, true);
    expect(v.rule).not.toMatch(/E[1-5]/);
    expect(v.rule).toContain('同一个错误');
  });

  it('E3×1 检定降级后裁决回落（不触发可能不卫生）', () => {
    const v = mapVerdict({ e4: 0, e3: 0, e3DistinctFingerprints: 0, e2: false, e1: true, e5: 0 } as any, 'complete', true, true);
    expect(v.word).toBe('卫生');
  });
});

describe('v2.2.2 引文段落守卫（细比对）', () => {
  // 复刻管线中的守卫逻辑（passageOk）
  const passageOk = (tQuote: string, sQuote: string) => {
    const tSents = (tQuote.match(/[。！？!?.]/g) || []).length;
    const sSents = (sQuote.match(/[.!?。！？]/g) || []).length;
    return tQuote.length >= 80 && tSents >= 3 && sQuote.length >= 80 && sSents >= 2;
  };
  it('孤句（5OODDG案形态：44字单句）不成证', () => {
    expect(passageOk('3K党无法代表美国历史，但是实际上，我们去看一整个3K党的崛起史，它就是充满了美国特色。', 'x'.repeat(90))).toBe(false);
  });
  it('连续段落（≥3句≥80字 + 源≥2句）成证', () => {
    const tp = '第一句论述在这里，我们从这个核心论点出发，展开整个讨论的框架。第二句给出具体的例证支撑，把抽象的论点落到可核查的历史材料上面。第三句完成转折与收束，回到最初提出的问题，并给出这一段的回答。';
    const sp = 'The first sentence opens the argument and frames the whole discussion clearly here. The second sentence supplies the concrete evidence that grounds it. The third turns and concludes, returning to the opening question with an answer given.';
    expect(passageOk(tp, sp)).toBe(true);
  });
  it('三短句但不足80字也不成证', () => {
    expect(passageOk('一句。两句。三句。', 'Long enough source sentence one. Second source sentence here too.')).toBe(false);
  });
});


describe('v2.2.3 引文去重（FDLMYH 案 FP4/FP9 教训）', () => {
  // 复刻管线 discipline 的去重逻辑（normalize 后互相包含判重）
  const normalize = (s: string) => s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)).replace(/[，。、；：？！""''「」『』（）()《》…—\-·,.;:?!"'\s]/g, '').toLowerCase();
  const isDup = (a: string, b: string) => {
    const na = normalize(a); const nb = normalize(b);
    return na === nb || na.includes(nb) || nb.includes(na);
  };
  it('FP4/FP9 同引文（飘/Gone with the wind）互相包含 → 判重', () => {
    const fp4 = '这就是那个电影，飘Gone with the wind，呈现的那个世界。';
    const fp9 = '这就是那个电影，飘Gone with the wind，呈现的那个世界。';
    expect(isDup(fp4, fp9)).toBe(true);
  });
  it('不同引文不误伤', () => {
    expect(isDup('第一代三K党诞生在1866年', '这是一个不断扩权的联邦政府')).toBe(false);
  });
});

describe('v2.2.3 R1b 播客定向触发条件', () => {
  it('contentType=podcast_with_transcript 或链接来自播客平台 → 触发', () => {
    const isPodcast = (ct: string, url: string) => /podcast/.test(ct || '') || /xiaoyuzhoufm|podcasts\.apple/.test(url || '');
    expect(isPodcast('podcast_with_transcript', '')).toBe(true);
    expect(isPodcast('', 'https://podcasts.apple.com/cn/podcast/x/id1')).toBe(true);
    expect(isPodcast('', 'https://www.xiaoyuzhoufm.com/episode/abc')).toBe(true);
    expect(isPodcast('article', 'https://mp.weixin.qq.com/s/abc')).toBe(false);
  });
});
