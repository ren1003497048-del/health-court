import { describe, it, expect } from 'vitest';
import {
  applyFingerprintDiscipline,
  isMirrorOrGenericSource,
} from '../src/court/fingerprintDiscipline';

// 338 案实录指纹（2026-08-18 HC-20260818-03V3KB 的真实抽取结果）
const TARGET = `
大家好，欢迎收听独树不成林。本期我们来聊德皇威廉二世。
德国皇帝威廉二世（统治时间1888年到1918年）口无遮拦、情绪跳跃、自信过度，极其在乎别人对他的批评；他沉迷个人外交，坚信可以用魅力操控他国领袖，却屡屡制造外交事故。
他与表兄沙皇尼古拉二世之间的通信被称为 willy-nicky tellegram，这些电报里的称呼亲昵得令人尴尬。
从每日电讯报事件到对各国君主的失礼举动，这些故事不仅好笑，更揭示了一个关键问题。
本节目提到的音乐是拉威尔的 Ravel Sonatine 小奏鸣曲。
`;

const FPS = [
  { id: 'FP1', type: 'weird_term' as const, priority: 'E4_suspect' as const, targetQuote: 'willy-nicky tellegram', searchKeywordsZh: [], searchKeywordsEn: [] },
  { id: 'FP2', type: 'rare_case' as const, priority: 'high' as const, targetQuote: '德国皇帝威廉二世（统治时间1888年到1918年）口无遮拦、情绪跳跃、自信过度，极其在乎别人对他的批评；他沉迷个人外交，坚信可以用魅力操控他国领袖，却屡屡制造外交事故', searchKeywordsZh: [], searchKeywordsEn: [] },
  { id: 'FP3', type: 'data_combo' as const, priority: 'normal' as const, targetQuote: '1914年一战爆发', searchKeywordsZh: [], searchKeywordsEn: [] },
  { id: 'FP6', type: 'rare_case' as const, priority: 'high' as const, targetQuote: '147-德国为何没变成一个马克思主义国家', searchKeywordsZh: [], searchKeywordsEn: [] },
  { id: 'FP7', type: 'data_combo' as const, priority: 'normal' as const, targetQuote: '2026年5月5日 UTC 03:08', searchKeywordsZh: [], searchKeywordsEn: [] },
  { id: 'FP8', type: 'rare_case' as const, priority: 'high' as const, targetQuote: 'Ravel Sonatine小奏鸣曲', searchKeywordsZh: [], searchKeywordsEn: [] },
  { id: 'FPX', type: 'rare_case' as const, priority: 'normal' as const, targetQuote: '这段引文根本不在目标文本里存在纯属幻觉编造出来的引文用于测试定位淘汰机制是否生效', searchKeywordsZh: [], searchKeywordsEn: [] },
];

describe('指纹纪律（机制PRD v2 §3.1 / 338案回归）', () => {
  it('保留合格指纹：weird_term 短而特异 + 长段 rare_case', () => {
    const { kept } = applyFingerprintDiscipline(FPS, TARGET, { programName: '独树不成林', episodeTitle: '338-当反复无常的自恋狂掌握世界强权会发生什么' });
    const ids = kept.map((f) => f.id);
    expect(ids).toContain('FP1');  // willy-nilly tellegram（唯一高价值指纹）
    expect(ids).toContain('FP2');  // 长段人物描述
  });

  it('淘汰公共事实（1914年一战爆发）', () => {
    const { rejected } = applyFingerprintDiscipline(FPS, TARGET);
    expect(rejected.find((r) => r.fingerprint.id === 'FP3')?.reason).toContain('公共事实');
  });

  it('淘汰自指：单集标题（147-…）与纯时间戳', () => {
    const { rejected } = applyFingerprintDiscipline(FPS, TARGET);
    expect(rejected.find((r) => r.fingerprint.id === 'FP6')?.reason).toContain('自指');
    expect(rejected.find((r) => r.fingerprint.id === 'FP7')?.reason).toContain('日期');
  });

  it('淘汰过短非weird指纹（Ravel Sonatine小奏鸣曲 13字 < 30）', () => {
    const { rejected } = applyFingerprintDiscipline(FPS, TARGET);
    expect(rejected.find((r) => r.fingerprint.id === 'FP8')?.reason).toContain('长度不足');
  });

  it('淘汰无法定位的幻觉引文', () => {
    const { rejected } = applyFingerprintDiscipline(FPS, TARGET);
    expect(rejected.find((r) => r.fingerprint.id === 'FPX')?.reason).toContain('定位');
  });

  it('含节目名的指纹被淘汰（自指）', () => {
    const fps2 = [
      { id: 'FPZ', type: 'rare_case' as const, priority: 'normal' as const, targetQuote: '大家好欢迎收听独树不成林今天我们聊聊德皇威廉二世的个人性格与外交风格的故事', searchKeywordsZh: [], searchKeywordsEn: [] },
    ];
    const { rejected } = applyFingerprintDiscipline(fps2, TARGET, { programName: '独树不成林' });
    expect(rejected[0]?.reason).toContain('自指');
  });
});

describe('源卫生（机制PRD v2 §3.2 / Facebook镜像源）', () => {
  const target = { title: '338-当反复无常的自恋狂掌握世界强权会发生什么？（德皇威廉二世… - 独树不成林 - Apple 播客', url: 'https://podcasts.apple.com/x', author: '仲树' };

  it('通用平台壳页（Facebook）被排除', () => {
    const r = isMirrorOrGenericSource({ title: 'Facebook', url: 'https://facebook.com/x' }, target);
    expect(r.generic).toBe(true);
  });

  it('含目标节目名的源被标记镜像', () => {
    const r = isMirrorOrGenericSource({ title: '独树不成林 Kaiser Wilhelm 劇情解析', url: 'https://someblog.com/a' }, target);
    expect(r.mirror).toBe(true);
  });

  it('正常第三方源不受影响', () => {
    const r = isMirrorOrGenericSource({ title: 'Failures of diplomacy: Kaiser Wilhelm II', url: 'https://history.com/kaiser' }, target);
    expect(r.mirror).toBe(false);
    expect(r.generic).toBe(false);
  });
});
