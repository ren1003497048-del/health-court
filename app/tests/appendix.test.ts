import { describe, expect, it } from 'vitest';
import { APPENDIX_NOTE_SYSTEM, normalizeAppendixNote, selectAppendixSources, tierOf, formOf } from '../src/court/appendix';

// v3.9 附录·延伸阅读：选源纯函数 + 与裁决解耦的确定性规则

const mk = (id: string, over: Record<string, unknown> = {}): any => ({
  id,
  title: `Source ${id}`,
  url: `https://example.com/${id}`,
  fullText: '这是一段足够长的正文'.repeat(80),
  similarity: 60,
  origin: 'search',
  ...over,
});

describe('tierOf 分层', () => {
  it('播客平台/系列扩展 → 一手材料', () => {
    expect(tierOf(mk('A', { url: 'https://podcasts.apple.com/us/podcast/x' }))).toBe('一手材料');
    expect(tierOf(mk('B', { origin: 'series' }))).toBe('一手材料');
  });
  it('百科/学术 → 系统梳理', () => {
    expect(tierOf(mk('C', { url: 'https://en.wikipedia.org/wiki/KKK' }))).toBe('系统梳理');
    expect(tierOf(mk('D', { url: 'https://some.edu/paper' }))).toBe('系统梳理');
  });
  it('知名媒体 → 媒体特稿；其余 → 背景参考', () => {
    expect(tierOf(mk('E', { url: 'https://www.bbc.com/news/x' }))).toBe('媒体特稿');
    expect(tierOf(mk('F', { url: 'https://blog.example.com/x' }))).toBe('背景参考');
  });
});

describe('selectAppendixSources 选源', () => {
  it('硬排除：无链接/被检目标本身/壳页（链接密度畸高）', () => {
    const target = 'https://target.example.com/ep';
    const shell = mk('SHELL', { fullText: Array.from({ length: 20 }, () => '[link](https://x.com/a)').join('\n') });
    const picked = selectAppendixSources([
      mk('NOURL', { url: '' }),
      mk('SELF', { url: target }),
      shell,
      mk('OK1'), mk('OK2'), mk('OK3'),
    ], target);
    expect(picked.map((s) => s.id)).not.toContain('NOURL');
    expect(picked.map((s) => s.id)).not.toContain('SELF');
    expect(picked.map((s) => s.id)).not.toContain('SHELL');
    expect(picked.length).toBeGreaterThanOrEqual(3);
  });
  it('单层级至多 2 张，层级优先一手', () => {
    const srcs = [
      mk('P1', { url: 'https://podcasts.apple.com/us/a' }),
      mk('P2', { url: 'https://podcasts.apple.com/us/b' }),
      mk('P3', { url: 'https://podcasts.apple.com/us/c' }),
      mk('W1', { url: 'https://en.wikipedia.org/x' }),
      mk('W2', { url: 'https://en.wikipedia.org/y' }),
      mk('W3', { url: 'https://en.wikipedia.org/z' }),
    ];
    const picked = selectAppendixSources(srcs);
    const t = picked.map(tierOf);
    expect(t.filter((x) => x === '一手材料').length).toBeLessThanOrEqual(2);
    expect(t.filter((x) => x === '系统梳理').length).toBeLessThanOrEqual(2);
    expect(t[0]).toBe('一手材料');
  });
  it('URL 去重', () => {
    const picked = selectAppendixSources([mk('A', { url: 'https://x.com/p/' }), mk('B', { url: 'https://x.com/p' }), mk('C'), mk('D')]);
    expect(picked.filter((s) => String(s.url).replace(/\/+$/, '') === 'https://x.com/p').length).toBe(1);
  });
  it('候选不足 3 时全部不选（附录整区不出现）', () => {
    expect(selectAppendixSources([mk('A'), mk('B')], undefined, { max: 5 }).length).toBe(2); // 池照选，buildAppendix 层再判 MIN
  });
});

describe('荐读语纪律', () => {
  it('提示词禁裁决词（抄袭/洗稿/卫生/裁决）', () => {
    expect(APPENDIX_NOTE_SYSTEM).toContain('绝不提及');
    for (const w of ['抄袭', '洗稿', '卫生', '裁决']) expect(APPENDIX_NOTE_SYSTEM).toContain(w); // 规则里点名禁止
  });
  it('normalizeAppendixNote：去引号截500', () => {
    expect(normalizeAppendixNote({ note: '"荐读语"' })).toBe('荐读语');
    expect(normalizeAppendixNote('「带引号」')).toBe('带引号');
    expect(normalizeAppendixNote({ note: 'x'.repeat(600) }).length).toBe(501);
  });
  it('formOf：英文播客单集/中文百科标注', () => {
    expect(formOf(mk('A', { title: 'The Ku Klux Klan Part 1', url: 'https://podcasts.apple.com/us/p/x' }))).toContain('英文');
    expect(formOf(mk('A', { title: 'The Ku Klux Klan Part 1', url: 'https://podcasts.apple.com/us/p/x' }))).toContain('播客');
    expect(formOf(mk('W', { title: '三K党', url: 'https://zh.wikipedia.org/x' }))).toContain('中文');
  });
});
