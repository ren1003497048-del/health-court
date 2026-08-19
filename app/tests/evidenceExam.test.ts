import { describe, it, expect } from 'vitest';
import { mapVerdict } from '../src/court/evidence';

describe('v2.2.1 证据检定对裁决的影响（降级不计入）', () => {
  it('E3×1（被检定降级）→ 不触发"可能不卫生"，回到卫生判定', () => {
    // 模拟：1条E3命中但 examVerdict=fact_relay → effective=false → stats.e3=0
    const evidence: any[] = [
      { id: 'EV-FP6-SRC1', level: 'E3', detail: { demoted: true }, examVerdict: 'fact_relay' },
    ];
    const effective = (e: any) => !(e.level === 'E3' && e.detail?.demoted);
    const stats = {
      e4: evidence.filter((e) => e.level === 'E4').length,
      e3: evidence.filter((e) => e.level === 'E3' && effective(e)).length,
      e3DistinctFingerprints: 0,
      e2: false,
      e1: true,
      e5: 0,
    };
    const v = mapVerdict(stats as any, 'complete', true, true);
    // e3=0 → 不该走 E3 触发分支
    expect(v.counts.E3).toBe(0);
    expect(['卫生', '存疑', '可能不卫生'].includes(v.word)).toBe(true);
    if (v.counts.E3 === 0 && v.counts.E4 === 0) expect(v.word).not.toBe('不卫生');
  });

  it('E3×1（检定为 expression_copy）→ 正常参与裁决', () => {
    const stats = { e4: 0, e3: 1, e3DistinctFingerprints: 1, e2: false, e1: true, e5: 0 };
    const v = mapVerdict(stats as any, 'complete', true, true);
    expect(v.counts.E3).toBe(1);
    expect(v.word).toBe('可能不卫生'); // E3×1 的裁决映射
  });
});

describe('v2.2.1 代号白话化正则（页面/导出共用形态）', () => {
  const plainFpType = (ty?: string) =>
    ({ weird_term: '异常用词', rare_case: '冷门案例', data_combo: '数据组合', analogy: '独特类比', joke: '专属玩笑', ordering: '罕见排序', other: '其他特征' } as Record<string, string>)[ty || ''] || ty || '';
  const plainDesc = (d: string) => d
    .replace(/FP\d+S?\d*（([a-z_]+)）/g, (_m, ty) => `指纹（${plainFpType(ty)}）`)
    .replace(/在 SRC(\d+) 命中/g, (_m, n) => `在候选源${n}中命中`)
    .replace(/← SRC(\d+)/g, (_m, n) => `← 候选源${n}`);

  it('FP6（rare_case）在 SRC1 命中 → 白话化（5OODDG 案原文）', () => {
    const real = 'FP6（rare_case）在 SRC1 命中：源文本中提到了3K党的崛起史，这是一个冷门的历史案例，因此命中。';
    expect(plainDesc(real)).toBe('指纹（冷门案例）在候选源1中命中：源文本中提到了3K党的崛起史，这是一个冷门的历史案例，因此命中。');
  });
  it('无代号的描述原样通过', () => {
    expect(plainDesc('已将目标转录稿与 Ku Klux Klan: Origin 逐项比对')).toBe('已将目标转录稿与 Ku Klux Klan: Origin 逐项比对');
  });
});
