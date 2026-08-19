import { describe, it, expect } from 'vitest';
import { parseAppleIds, matchEpisodeFromRss, locateEpisodeAudio, unwrapDtsUrl } from '../src/providers/episodeLocate';

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

describe('locateEpisodeAudio Apple 降级链（统一 lookup）', () => {
  it('单集链接（?i=）：查本体列表内匹配 trackId（旧"查单集ID"形态已废弃）', async () => {
    const fake = (async (url: string) => {
      // 现在统一查 podcast 本体
      if (url.startsWith('https://itunes.apple.com/lookup?id=1711052890')) {
        return {
          ok: true,
          text: async () =>
            '{"resultCount":2,"results":[{"kind":"podcast","collectionName":"节目","feedUrl":"https://feed.example/rss"},{"kind":"podcastEpisode","trackId":1000758498673,"episodeUrl":"https://dts.example/e324.mp3","trackName":"324","trackTimeMillis":3000000,"releaseDate":"2026-03-31T19:31:08Z"}]}',
        };
      }
      // 若实现误查单集 ID（旧bug形态）→ 静默空（Apple 实测行为）
      if (url.startsWith('https://itunes.apple.com/lookup?id=1000758498673')) {
        return { ok: true, text: async () => '{"resultCount":0,"results":[]}' };
      }
      return { ok: true, text: async () => 'unreachable' };
    }) as any;
    const r = await locateEpisodeAudio(
      'https://podcasts.apple.com/cn/podcast/324/id1711052890?i=1000758498673',
      { fetchImpl: fake },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.audio.audioUrl).toBe('https://dts.example/e324.mp3');
      expect(r.audio.episodeTitle).toBe('324');
      expect(r.audio.durationMs).toBe(3000000);
    }
  });

  it('直连被限流 → Jina 中继成功（Markdown 包裹 JSON）', async () => {
    const fake = (async (url: string) => {
      if (url.startsWith('https://itunes.apple.com')) {
        return { ok: true, text: async () => '{"resultCount":0,"results":[]}' }; // 直连静默空
      }
      if (url.startsWith('https://r.jina.ai/')) {
        return {
          ok: true,
          text: async () =>
            'Title: \nURL Source: x\nMarkdown Content:\n{"resultCount":2,"results":[{"kind":"podcast","collectionName":"节目","feedUrl":"https://feed.example/rss"},{"kind":"podcastEpisode","episodeUrl":"https://cdn.example/e1.mp3","trackName":"第1期"}]}',
        };
      }
      return { ok: true, text: async () => '{"resultCount":0,"results":[]}' };
    }) as any;
    const r = await locateEpisodeAudio('https://podcasts.apple.com/cn/podcast/id1493503146', { fetchImpl: fake });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.audio.audioUrl).toBe('https://cdn.example/e1.mp3');
      expect(r.audio.source).toContain('iTunes');
    }
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

  it('小宇宙链接：直连页面含音频地址 → 直连命中（v2.2.5 三级降级）', async () => {
    const fake = (async (url: string) => {
      if (url.startsWith('https://www.xiaoyuzhoufm.com')) {
        return {
          ok: true,
          text: async () =>
            '<html><head><title>第1期 | 播客名 | 小宇宙</title></head><body>script: {"enclosure":"https://media.xyzcdn.net/abc/def.m4a"}</body></html>',
        };
      }
      return { ok: true, text: async () => 'should not reach jina' };
    }) as any;
    const logs: string[] = [];
    const r = await locateEpisodeAudio('https://www.xiaoyuzhoufm.com/episode/abc123', { fetchImpl: fake, log: (m) => logs.push(m) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.audio.audioUrl).toBe('https://media.xyzcdn.net/abc/def.m4a');
      expect(r.audio.source).toContain('直连');
    }
    expect(logs.some((l) => l.includes('直连取页成功'))).toBe(true);
  });

  it('小宇宙链接：直连无音频（渲染缺失形态）→ 降级 Jina 命中', async () => {
    const fake = (async (url: string) => {
      if (url.startsWith('https://www.xiaoyuzhoufm.com')) {
        return { ok: true, text: async () => '<html>shell without audio</html>' };
      }
      if (url.startsWith('https://r.jina.ai/')) {
        return {
          ok: true,
          text: async () => 'Title: 第1期\n\nhttps://dts-api.xiaoyuzhoufm.com/track/xyz/abc 音频链接',
        };
      }
      return { ok: true, text: async () => '' };
    }) as any;
    const r = await locateEpisodeAudio('https://www.xiaoyuzhoufm.com/episode/abc123', { fetchImpl: fake });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.audio.audioUrl).toBe('https://dts-api.xiaoyuzhoufm.com/track/xyz/abc');
      expect(r.audio.source).toContain('Jina');
    }
  });

  it('全链路失败 → 带原因的失败结果', async () => {
    const fake = (async () => ({ ok: true, json: async () => ({ resultCount: 0, results: [] }), text: async () => 'garbage' })) as any;
    const r = await locateEpisodeAudio('https://podcasts.apple.com/cn/podcast/id123', { fetchImpl: fake });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(5);
  });
});


describe('unwrapDtsUrl（dts-api 302 无 ACAO → xyzcdn 直链变换）', () => {
  it('dts-api 路径内嵌 xyzcdn 终点 → 直接重拼直链', () => {
    expect(
      unwrapDtsUrl(
        'https://dts-api.xiaoyuzhoufm.com/track/64acd33c7a3d479103fbd32d/69cc1a0ce2c8be31550c581f/media.xyzcdn.net/64acd33c7a3d479103fbd32d/lhn7Gabj6_JkSzE2YveCtd3BTgsG.m4a',
      ),
    ).toBe('https://media.xyzcdn.net/64acd33c7a3d479103fbd32d/lhn7Gabj6_JkSzE2YveCtd3BTgsG.m4a');
  });
  it('已经是 xyzcdn/其他直链 → 原样返回', () => {
    expect(unwrapDtsUrl('https://media.xyzcdn.net/a/b.m4a')).toBe('https://media.xyzcdn.net/a/b.m4a');
    expect(unwrapDtsUrl('https://cdn.example.com/e.mp3')).toBe('https://cdn.example.com/e.mp3');
  });
});
