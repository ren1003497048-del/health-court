// 跨平台单集定位（P0-4）：
// Apple 链接不再单点依赖 iTunes lookup API——该 API 对代理/数据中心 IP 会静默回空（HTTP 200 + resultCount 0），
// 用户侧 FlClash 等代理环境下"查不到"是常态而非例外。
// 策略：先提取单集身份（节目名+单集标题+日期），再跨平台定位音频——
//   ① iTunes lookup 直连（家宽 IP 正常）
//   ② lookup 空时用 Jina 中继同一 API（Jina 出口 IP 不在限流名单，实测通）
//   ③ 仍拿不到 enclosure → 读 feedUrl 的 RSS，按标题/日期匹配同一期，取 enclosure（跨平台托管源）
// RSS 本体无 CORS 头，浏览器直 fetch 会被拦 → RSS 一律经 Jina 读取。

export interface EpisodeIdentity {
  podcastName: string;
  episodeTitle: string;
  date?: string;
  episodeId?: string;
  podcastId?: string;
  feedUrl?: string;
}

export interface LocatedAudio {
  audioUrl: string;
  source: string;
  durationMs?: number;
  releaseDate?: string;
  podcastName?: string;
  episodeTitle?: string;
}

export type LocateResult = { ok: true; audio: LocatedAudio } | { ok: false; reason: string };

/** dts-api 短链 → xyzcdn 直链：302 第一跳无 ACAO，浏览器 CORS 重定向链必断；路径内嵌终点，直接重拼绕开 */
export function unwrapDtsUrl(url: string): string {
  const m = url.match(/^https:\/\/dts-api\.xiaoyuzhoufm\.com\/track\/[^/]+\/[^/]+\/(.+)$/);
  if (!m) return url;
  const rest = m[1];
  // 形态: media.xyzcdn.net/<pid>/<file>.m4a 或其他裸主机/路径
  if (!/^https?:\/\//.test(rest) && rest.includes('/')) return `https://${rest}`;
  return url;
}

/** 从 Apple URL 提取 podcast/episode 数字 ID */
export function parseAppleIds(url: string): { podcastId: string; episodeId: string } | null {
  const m = url.match(/id(\d+)(?:\?i=(\d+))?/);
  if (!m) return null;
  return { podcastId: m[1], episodeId: m[2] || '' };
}

interface LookupShape {
  feedUrl: string;
  episodes: any[];
  podcastName: string;
  via: string;
}

/** iTunes lookup——统一查 podcast 本体+单集列表（查单集 trackId 时 lookup 会静默回空，为 API 已知怪癖） */
async function itunesLookup(
  podcastId: string,
  episodeId: string,
  jinaKey: string | undefined,
  fetchImpl: typeof fetch,
): Promise<LookupShape | null> {
  const apiUrl = `https://itunes.apple.com/lookup?id=${podcastId}&entity=podcastEpisode&country=CN&limit=200`;
  const parse = (text: string): LookupShape | null => {
    const start = text.indexOf('{');
    if (start < 0) return null;
    let payload = text.slice(start).trim();
    let data: any;
    try {
      data = JSON.parse(payload);
    } catch {
      return null;
    }
    if (!data.resultCount) return null;
    return extractLookup(data);
  };
  // ① 浏览器直连（家宽/正常 IP 下工作）
  try {
    const res = await fetchImpl(apiUrl);
    if (res.ok) {
      const r = parse(await res.text());
      if (r) return { ...r, via: 'iTunes 目录（直连）' };
    }
  } catch {
    /* 网络层失败 → Jina 中继 */
  }
  // ② Jina 中继（代理/数据中心 IP 被 Apple 静默限流时的兜底）
  try {
    const headers: Record<string, string> = { Accept: 'text/plain' };
    if (jinaKey) headers.Authorization = `Bearer ${jinaKey}`;
    const res = await fetchImpl(`https://r.jina.ai/${apiUrl}`, { headers });
    if (res.ok) {
      const r = parse(await res.text());
      if (r) return { ...r, via: 'iTunes 目录（Jina 中继）' };
    }
  } catch {
    /* 双通道尽 */
  }
  return null;
}

function extractLookup(data: any): LookupShape {
  const eps = (data.results || []).filter((r: any) => r.episodeUrl);
  const feed = (data.results || []).find((r: any) => r.feedUrl);
  return { feedUrl: feed?.feedUrl || '', episodes: eps, podcastName: feed?.collectionName || '', via: '' };
}

/** 从 RSS 文本解析目标单集（标题相似度 + 日期加权），返回 enclosure URL */
export function matchEpisodeFromRss(
  rssText: string,
  ident: Partial<EpisodeIdentity>,
): { audioUrl: string; title: string; pubDate?: string; duration?: number } | null {
  const items = rssText.split(/<item[\s>]/).slice(1);
  if (!items.length) return null;
  const norm = (s: string) =>
    s
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  const wanted = norm(ident.episodeTitle || '');
  const wantedDate = ident.date ? ident.date.replace(/-/g, '').slice(0, 8) : '';
  let best: { score: number; audioUrl: string; title: string; pubDate?: string; duration?: number } | null = null;
  for (const it of items) {
    const tm = it.match(/<title>([\s\S]*?)<\/title>/);
    if (!tm) continue;
    const title = norm(tm[1]);
    if (!title) continue;
    const em = it.match(/enclosure[^>]*url="([^"]+)"/);
    if (!em) continue;
    const dm = it.match(/<pubDate>([^<]+)<\/pubDate>/);
    const durM = it.match(/itunes:duration[^>]*>([^<]+)</);
    let score = 0;
    if (wanted && title === wanted) score += 100;
    else if (wanted && (title.includes(wanted) || wanted.includes(title))) score += 70;
    else if (wanted) {
      // 词级重合度（中英文都适用）
      const tw = new Set(title.split(/[\s，。！？、：·|—\-()（）【】]+/).filter((w) => w.length >= 2));
      const ww = new Set(wanted.split(/[\s，。！？、：·|—\-()（）【】]+/).filter((w) => w.length >= 2));
      let hit = 0;
      for (const w of ww) if (tw.has(w)) hit++;
      if (ww.size) score += Math.round((hit / ww.size) * 50);
    }
    if (wantedDate && dm) {
      const d = new Date(dm[1]);
      if (!isNaN(d.getTime())) {
        const ds = d.toISOString().slice(0, 10).replace(/-/g, '');
        const diff = Math.abs(+ds - +wantedDate);
        if (diff === 0) score += 30;
        else if (diff <= 1) score += 20;
        else if (diff <= 3) score += 8;
      }
    }
    if (!best || score > best.score) {
      best = { score, audioUrl: em[1], title, pubDate: dm?.[1], duration: parseItunesDuration(durM?.[1]) };
    }
  }
  return best && best.score >= 40 ? best : null;
}

function parseItunesDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return +s;
  const p = s.split(':').map(Number);
  if (p.some(isNaN)) return undefined;
  return p.reduce((a, b) => a * 60 + b, 0);
}

/** 主入口：跨平台定位单集音频。返回定位结果或带阶段标记的失败原因。 */
export async function locateEpisodeAudio(
  url: string,
  opts: { jinaKey?: string; log?: (s: string) => void; fetchImpl?: typeof fetch },
): Promise<LocateResult> {
  const fetchImpl = opts.fetchImpl || fetch;
  const log = opts.log || (() => {});
  const isApple = /podcasts\.apple\.com/.test(url);
  const isXyzfm = /xiaoyuzhoufm\.com\/(episode|podcast)/.test(url);

  // —— 小宇宙：单集页经 Jina 读取，提取 track 地址与节目名 ——
  if (isXyzfm) {
    const headers: Record<string, string> = { Accept: 'text/plain' };
    if (opts.jinaKey) headers.Authorization = `Bearer ${opts.jinaKey}`;
    try {
      const res = await fetchImpl(`https://r.jina.ai/${url}`, { headers });
      const text = await res.text();
      const m = text.match(/https:\/\/(?:media\.xyzcdn\.net|dts-api\.xiaoyuzhoufm\.com\/track)\/[^"'\s\\]+/);
      if (m) {
        const pm = text.match(/来自播客《([^》]{2,40})》/) || text.match(/^Title:\s*(.+)$/m);
        return {
          ok: true,
          audio: {
            audioUrl: m[0],
            source: '小宇宙（经 Jina 中继）',
            podcastName: pm ? pm[1].trim() : undefined,
          },
        };
      }
      return { ok: false, reason: '小宇宙页面（经 Jina 读取）中未找到音频地址' };
    } catch (e: any) {
      return { ok: false, reason: `[读取小宇宙页面(经Jina)] ${String(e?.message || e).slice(0, 120)}` };
    }
  }

  // —— 通用播客单集页（v2.2.4）：Spotify/getpodcast/musixmatch/官方站等——经 Jina 读页面找音频 CDN 直链 ——
  // 注：Apple 链接走下方专用通道（lookup API+RSS 更强），此处只接其他平台的播客单集页
  const genericPodcastPage = /open\.spotify\.com\/episode|getpodcast\.com|musixmatch\.com\/podcast|deezer\.com\/episode|podtail\.com|podcast-addict\.com|podcastrex\.com/.test(url);
  if (genericPodcastPage) {
    const headers: Record<string, string> = { Accept: 'text/plain' };
    if (opts.jinaKey) headers.Authorization = `Bearer ${opts.jinaKey}`;
    try {
      const res = await fetchImpl(`https://r.jina.ai/${url}`, { headers });
      const text = await res.text();
      // 音频 CDN 直链形态：megaphone/pdst.fm（TRIH 系）、xyzcdn（小宇宙系）、audio empire 等
      const m = text.match(/https:\/\/(?:traffic\.megaphone\.fm|pdst\.fm|dts\.megaphone\.fm|pdst\.fm\/e)[^\s\"'\\)\]]+/);
      if (m) {
        return {
          ok: true,
          audio: { audioUrl: m[0], source: '播客页内嵌音频直链（经 Jina）' },
        };
      }
      return { ok: false, reason: '播客页面（经 Jina 读取）未找到音频直链（可能是纯壳页或需要 JS 渲染）' };
    } catch (e: any) {
      return { ok: false, reason: `[读取播客页(经Jina)] ${String(e?.message || e).slice(0, 100)}` };
    }
  }

  // —— Apple：身份提取 → lookup 直连 → lookup Jina 中继 → RSS 匹配 ——
  if (isApple) {
    const ids = parseAppleIds(url);
    if (!ids) return { ok: false, reason: 'Apple 链接中未找到数字 ID（形如 id123456?i=789）' };
    const epTitle = decodeURIComponent((url.match(/\/podcast\/([^/]+)\/id/) || [])[1] || '').replace(/-/g, ' ');
    const ident: EpisodeIdentity = {
      podcastName: '',
      podcastId: ids.podcastId,
      episodeId: ids.episodeId,
      episodeTitle: epTitle,
    };
    log('从 Apple 链接提取单集身份…');
    // 统一 lookup：查 podcast 本体+单集列表，直连失败/被限流时 Jina 中继
    const lookup = await itunesLookup(ids.podcastId, ids.episodeId, opts.jinaKey, fetchImpl);
    const via = lookup?.via || '';
    if (via.includes('Jina')) log('iTunes 直连无结果（多为代理 IP 被限流），已经 Jina 中继取到目录…');
    if (lookup) {
      ident.podcastName = lookup.podcastName || ident.podcastName;
      ident.feedUrl = lookup.feedUrl || ident.feedUrl;
      if (ids.episodeId) {
        const ep = lookup.episodes.find((r: any) => String(r.trackId) === ids.episodeId);
        if (ep?.episodeUrl) {
          return {
            ok: true,
            audio: {
              audioUrl: unwrapDtsUrl(ep.episodeUrl),
              source: via,
              durationMs: ep.trackTimeMillis,
              releaseDate: ep.releaseDate,
              podcastName: lookup.podcastName,
              episodeTitle: ep.trackName,
            },
          };
        }
      } else if (lookup.episodes.length) {
        // 无 ?i= 参数：取最新一集
        const ep = lookup.episodes[0];
        return {
          ok: true,
          audio: {
            audioUrl: unwrapDtsUrl(ep.episodeUrl),
            source: via,
            durationMs: ep.trackTimeMillis,
            releaseDate: ep.releaseDate,
            podcastName: lookup.podcastName,
            episodeTitle: ep.trackName,
          },
        };
      }
    }
    // ③ RSS 匹配（跨平台托管源）
    if (ident.feedUrl) {
      log('查目录未取到音频，读节目 RSS 匹配同一期（feed 可能托管在第三方）…');
      const headers: Record<string, string> = { Accept: 'text/plain' };
      if (opts.jinaKey) headers.Authorization = `Bearer ${opts.jinaKey}`;
      try {
        const res = await fetchImpl(`https://r.jina.ai/${ident.feedUrl}`, { headers });
        const rss = await res.text();
        const hit = matchEpisodeFromRss(rss, ident);
        if (hit) {
          return {
            ok: true,
            audio: {
              audioUrl: unwrapDtsUrl(hit.audioUrl),
              source: 'RSS feed（跨平台托管）',
              durationMs: hit.duration ? hit.duration * 1000 : undefined,
              episodeTitle: hit.title,
            },
          };
        }
        return { ok: false, reason: 'RSS 中未匹配到该单集（标题或日期对不上，或单集未入 feed）' };
      } catch (e: any) {
        return { ok: false, reason: `[读取RSS] ${String(e?.message || e).slice(0, 120)}` };
      }
    }
    return { ok: false, reason: '未能定位音频：目录查询无结果且无 RSS feed 可用' };
  }

  return { ok: false, reason: '未能定位音频地址（当前支持 Apple Podcasts 与小宇宙单集链接）' };
}
