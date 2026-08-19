import { describe, it, expect } from 'vitest';
import { parseAppleIds, matchEpisodeFromRss, itunesLookupViaJina, locateEpisodeAudio } from '../src/providers/episodeLocate';

describe('parseAppleIds', () => {
  it('提取 podcast id 与 ?i= 单集 id', () => {
    expect(parseAppleIds('https://podcasts.apple.com/cn/podcast/%E5%BF%BD%E5%B7%A6%E5%BF%BD%E5%8F%B3/id1493503146?i=1000583911111')).toEqual({
      podcastId: '1493503146',
      episodeId: '1000583911111',
    });
  });
  it('无 ?i= 时 episodeId 为空', () => {
    expect(parseAppleIds('https://podcasts.apple.com/us/podcast/the-daily/id1192761536')).toEqual({
      podcastId: '1192761536',
      episodeId: '',
    });
  });
  it('非 Apple 形态返回 null', () => {
    expect(parseAppleIds('https://example.com/foo')).toBeNull();
  });
});

describe('matchEpisodeFromRss', () => {
  const rss = `<?xml version="1.0"?>
<rss><channel>
<item><title>493 追忆历史学家亚当·麦基翁</title><enclosure url="https://dts-api.xiaoyuzhoufm.com/track/aaa/bbb" type="audio/mpeg"/><pubDate>Tue, 18 Aug 2026 08:42:01 GMT</pubDate><itunes:duration>5400</itunes:duration></item>
<item><title><![CDATA[492 关于移民的另一章]]></title><enclosure url="https://media.xyzcdn.net/xxx.m4a" type="audio/x-m4a"/><pubDate>Tue, 11 Aug 2026 08:42:01 GMT</pubDate><itunes:duration>1:02:03</itunes:duration></item>
<item><title>无音频条目</title><pubDate>Tue, 4 Aug 2026 08:42:01 GMT</pubDate></item>
</channel></rss>`;

  it('标题完全命中 → 取 enclosure', () => {
    const hit = matchEpisodeFromRss(rss, { episodeTitle: '493 追忆历史学家亚当·麦基翁' });
    expect(hit).not.toBeNull();
    expect(hit!.audioUrl).toBe('https://dts-api.xiaoyuzhoufm.com/track/aaa/bbb');
    expect(hit!.duration).toBe(5400);
  });

  it('CDATA 标题与包含式匹配', () => {
    const hit = matchEpisodeFromRss(rss, { episodeTitle: '492 关于移民的另一章' });
    expect(hit).not.toBeNull();
    expect(hit!.audioUrl).toBe('https://media.xyzcdn.net/xxx.m4a');
    expect(hit!.duration).toBe(3723); // 1:02:03
  });

  it('日期加分：标题弱匹配 + 同日发布 → 命中', () => {
    const hit = matchEpisodeFromRss(rss, { episodeTitle: '追忆 历史学家 麦基翁', date: '2026-08-18' });
    expect(hit).not.toBeNull();
    expect(hit!.audioUrl).toContain('dts-api');
  });

  it('完全无关标题 → 不命中（阈值拦截误配）', () => {
    expect(matchEpisodeFromRss(rss, { episodeTitle: '星际穿越影评' })).toBeNull();
  });
});

describe('itunesLookupViaJina', () => {
  it('解析 Jina Markdown 包裹的 JSON', async () => {
    const fake = (async (url: string) => ({
      ok: true,
      text: async () =>
        'Title: \n\nURL Source: https://itunes.apple.com/lookup?...\n\nMarkdown Content:\n\n{"resultCount":2,"results":[{"wrapperType":"track","kind":"podcast","collectionName":"忽左忽右","feedUrl":"https://feed.xyzfm.space/x"},{"wrapperType":"podcastEpisode","episodeUrl":"https://cdn.example/e1.mp3","trackName":"第1期"}]}',
    })) as any;
    const r = await itunesLookupViaJina('123', '', undefined, fake);
    expect(r).not.toBeNull();
    expect(r!.feedUrl).toBe('https://feed.xyzfm.space/x');
    expect(r!.episodes.length).toBe(1);
    expect(r!.podcastName).toBe('忽左忽右');
  });

  it('resultCount=0（代理 IP 被限流形态）→ null', async () => {
    const fake = (async () => ({
      ok: true,
      text: async () => 'Title: \nURL Source: x\nMarkdown Content:\n{"resultCount":0,"results":[]}',
    })) as any;
    expect(await itunesLookupViaJina('123', '', undefined, fake)).toBeNull();
  });
});

describe('locateEpisodeAudio 集成（mock fetch）', () => {
  it('Apple 链接：直连被限流 → Jina 中继成功', async () => {
    let call = 0;
    const fake = (async (url: string) => {
      call++;
      if (url.startsWith('https://itunes.apple.com')) {
        return { ok: true, json: async () => ({ resultCount: 0, results: [] }) }; // 直连：静默空
      }
      // Jina 中继
      return {
        ok: true,
        text: async () =>
          '{"resultCount":2,"results":[{"kind":"podcast","collectionName":"忽左忽右","feedUrl":"https://feed.xyzfm.space/x"},{"kind":"podcastEpisode","episodeUrl":"https://dts.example/e.mp3","trackName":"第1期","releaseDate":"2026-08-18T08:00:00Z","trackTimeMillis":3600000}]}',
      };
    }) as any;
    const logs: string[] = [];
    const r = await locateEpisodeAudio('https://podcasts.apple.com/cn/podcast/id1493503146', {
      log: (m) => logs.push(m),
    fetchImpl: fake,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.audio.audioUrl).toBe('https://dts.example/e.mp3');
      expect(r.audio.source).toContain('Jina');
      expect(r.audio.durationMs).toBe(3600000);
    }
    expect(logs.some((l) => l.includes('Jina'))).toBe(true);
  });

  it('Apple 单集链接（?i=）：RSS 匹配兜底', async () => {
    const fake = (async (url: string) => {
      if (url.startsWith('https://itunes.apple.com')) {
        return { ok: true, json: async () => ({ resultCount: 0, results: [] }) };
      }
      if (url.includes('r.jina.ai/https://itunes.apple.com')) {
        // Jina 也查不到单集 enclosure，但给了 feedUrl
        return {
          ok: true,
          text: async () =>
            '{"resultCount":1,"results":[{"kind":"podcast","collectionName":"节目","feedUrl":"https://feed.example/rss"}]}',
        };
      }
      // RSS 经 Jina
      return {
        ok: true,
        text: async () =>
          '<rss><channel><item><title>目标单集</title><enclosure url="https://cdn.example/target.mp3"/></item></channel></rss>',
      };
    }) as any;
    const r = await locateEpisodeAudio('https://podcasts.apple.com/cn/podcast/%E7%9B%AE%E6%A0%87%E5%8D%95%E9%9B%86/id123?i=456', {
      fetchImpl: fake,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.audio.audioUrl).toBe('https://cdn.example/target.mp3');
      expect(r.audio.source).toContain('RSS');
    }
  });

  it('小宇宙链接：经 Jina 提取 track 地址', async () => {
    const fake = (async () => ({
      ok: true,
      text: async () => 'Title: 第1期 | 忽左忽右\n\nhttps://dts-api.xiaoyuzhoufm.com/track/xyz/abc 音频链接',
    })) as any;
    const r = await locateEpisodeAudio('https://www.xiaoyuzhoufm.com/episode/abc123', { fetchImpl: fake });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.audio.audioUrl).toBe('https://dts-api.xiaoyuzhoufm.com/track/xyz/abc');
  });

  it('全链路失败 → 带原因的失败结果', async () => {
    const fake = (async () => ({ ok: true, json: async () => ({ resultCount: 0, results: [] }), text: async () => 'garbage' })) as any;
    const r = await locateEpisodeAudio('https://podcasts.apple.com/cn/podcast/id123', { fetchImpl: fake });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(5);
  });
});
