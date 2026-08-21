import { describe, it, expect } from 'vitest';
import { stripMarkdownMedia, stripPageChrome, chromeRatio } from '../src/court/chromeStrip';
import { preReview, parseEpisodeMinutes } from '../src/court/preReview';

// T76WDM 案页面壳实录片段（Apple 页面：导航+倍速+国家列表）
const APPLE_CHROME = `
[](https://podcasts.apple.com/cn/new)

*   [搜索](https://podcasts.apple.com/cn/search)
*   [主页](https://podcasts.apple.com/cn/home)
*   [新发现](https://podcasts.apple.com/cn/new)
*   [排行榜](https://podcasts.apple.com/cn/charts)

登录

1 倍

1x

*   0.8x
*   1x
*   1.3x

较快

较慢

向后跳 播放 播放 播放 向前跳

静音

![Image 1: 独树不成林](https://podcasts.apple.com/assets/artwork/1x1.gif)

8月17日

# 364-莎士比亚如何理解卓越与平等之间的冲突？《科利奥兰纳斯》1

独树不成林

39 分钟

本期播客重读莎士比亚的罗马悲剧《科利奥兰纳斯》。这部戏最核心的是两组关系：英雄与群众的关系，以及英雄与其他精英的关系。

*   [Argentina](https://podcasts.apple.com/ar/new)
*   [Australia](https://podcasts.apple.com/au/new)
*   [Suriname](https://podcasts.apple.com/sr/new)
*   [Trinidad and Tobago](https://podcasts.apple.com/tt/new)
*   [Turks and Caicos](https://podcasts.apple.com/tc/new)
*   [Uruguay (English)](https://podcasts.apple.com/uy/new)
*   [Venezuela (Español)](https://podcasts.apple.com/ve/new)
`;

describe('页面壳剥离（T76WDM 案根因1）', () => {
  it('S60HBY 回归：清除 Jina 图片占位、评论数和新闻头图，保留普通正文链接', () => {
    const dirty = `[Image 9: 评论数](https://cdn.example.com/comment.svg)154\n![Politico 头图](https://static.politico.com/photo.jpg)\nPhoto: AP\n正文说明 [官方通谕](https://example.com/document) 已发布。`;
    const out = stripMarkdownMedia(dirty);
    expect(out).not.toContain('Image 9');
    expect(out).not.toContain('154');
    expect(out).not.toContain('politico.com');
    expect(out).not.toContain('Photo: AP');
    expect(out).toContain('[官方通谕](https://example.com/document)');
  });

  it('剔除导航/倍速/国家列表，保留标题与简介正文', () => {
    const out = stripPageChrome(APPLE_CHROME);
    expect(out).toContain('本期播客重读莎士比亚的罗马悲剧');
    expect(out).toContain('364-莎士比亚如何理解卓越与平等之间的冲突');
    expect(out).not.toContain('Trinidad and Tobago');
    expect(out).not.toContain('Suriname');
    expect(out).not.toContain('较快');
    expect(out).not.toContain('0.8x');
  });

  it('chrome 占比诊断：Apple 壳页 > 40%', () => {
    const out = stripPageChrome(APPLE_CHROME);
    const r = chromeRatio(APPLE_CHROME, out);
    expect(r).toBeGreaterThan(0.4);
  });

  it('正常文章正文不受影响', () => {
    const article = '这是一篇正常文章的第一段，包含完整的论述内容。'.repeat(20) + '\n\n' + '第二段继续论述，这里有具体的论据和分析。'.repeat(20);
    const out = stripPageChrome(article);
    expect(out.length).toBeGreaterThan(article.length * 0.9);
  });

  it('T76WDM 回归：剥离后 Apple 壳页无法再撑过预审（简介不足以对质）', () => {
    const stripped = stripPageChrome(APPLE_CHROME);
    // 剥离后只剩 shownotes 级内容 → 播客预审应拦截（39分钟 × 50% 语速 ≈ 5850字门槛）
    const dur = parseEpisodeMinutes(stripped);
    const r = preReview({ url: 'https://podcasts.apple.com/cn/podcast/x/id1711052890?i=1000783733334', text: '', fetched: { title: '364', text: stripped } });
    expect(r.pass).toBe(false);
  });
});
