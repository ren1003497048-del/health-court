// 流水线编排：开庭五阶段（PRD §5）
// 每个阶段是纯函数：输入案卷/来源，输出更新后的案卷/证据。UI 与无头测试共用同一条路径。

import type { CaseFile, SourceDoc, FingerprintCandidate, CommunityLead } from '../court/types';
import type { EvidenceItem } from '../court/evidence';
import { chatJson } from '../providers/types';
import type { ProviderAdapter, Fetcher } from '../providers/types';
import {
  PROFILE_SYSTEM, FINGERPRINT_SYSTEM, LEADS_SYSTEM, ATTRIBUTION_SYSTEM,
  ALIGN_SYSTEM, FPCHECK_SYSTEM, VERDICT_OPINION_SYSTEM, DISCOVERY_QUERY_SYSTEM,
} from '../court/prompts';
import { locateQuote, truncateSmart, parseJinaMarkdown, normalize } from '../court/textUtils';
import { preReview, extractDate } from '../court/preReview';
import { stripPageChrome, chromeRatio } from '../court/chromeStrip';
import { applyFingerprintDiscipline, isMirrorOrGenericSource } from '../court/fingerprintDiscipline';
import { cjkPunctNormalize } from '../court/textUtils';
import { plainLevelName } from '../court/evidence';
import { SOURCE_QUALITY_GATE } from '../court/evidence';

/** 立案门槛（PRD §5.1）：评定对象=相对独立完整的文化内容整体 */
export const MIN_TARGET_CHARS = 100; // 2026-08-20 用户拍板：文学节选/短篇从宽（原 500）
export const MIN_EPISODE_MINUTES = 5;

export interface StageLog {
  stage: string;
  note: string;
  at: string;
}

export interface CourtRuntime {
  provider: ProviderAdapter;
  fetcher: Fetcher;
  log: (stage: string, note: string) => void;
  /** 跨阶段证据累加 */
  evidence: EvidenceItem[];
  sources: SourceDoc[];
  /** 镜像源注记（归属链佐证，不参与对质） */
  mirrorNotes?: string[];
  /** v2.2 检索淘汰记录（透明可复核：标题+原因） */
  rejectedSources?: { title: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// 阶段一：立案（取证）
// ---------------------------------------------------------------------------

export async function filing(input: { url?: string; text?: string }, rt: CourtRuntime): Promise<CaseFile> {
  const caseId = 'HC-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' +
    Math.random().toString(36).slice(2, 8).toUpperCase();
  rt.log('立案', `案号 ${caseId} 建立，开始取证`);

  let target: CaseFile['target'] | null = null;

  if (input.url) {
    try {
      const doc = await rt.fetcher.fetchDoc(input.url);
      const title = doc.title;
      let body = doc.text;
      // 页面壳剥离（T76WDM 案根因1）：导航/国家列表/播放器控件不构成内容本体
      const stripped = stripPageChrome(body);
      const ratio = chromeRatio(body, stripped);
      if (ratio > 0.15) {
        rt.log('立案', `剥离页面壳 ${Math.round(ratio * 100)}%（${body.length} → ${stripped.length} 字符）`);
        body = stripped;
      }
      rt.log('立案', `取证成功：${title || '(无标题)'}，${body.length} 字符（壳后）`);
      target = {
        title: title || '(无标题)',
        text: body,
        url: input.url,
        fetchedAt: new Date().toISOString(),
        contentType: guessContentType(input.url, body),
        comments: extractComments(body),
        degraded: false,
      };
    } catch (e: any) {
      rt.log('立案', `URL 取证失败（${e.message}），需人工粘贴正文`);
      throw new Error(`取证失败：${e.message}。请在输入框直接粘贴正文后重试。`);
    }
  } else if (input.text && input.text.trim().length >= MIN_TARGET_CHARS) {
    target = {
      title: input.text.trim().split(/\n/)[0].slice(0, 60) || '(粘贴文本)',
      text: input.text.trim(),
      contentType: 'unknown',
      degraded: false,
    };
    rt.log('立案', `收到粘贴文本 ${target.text.length} 字符`);
  } else {
    const n = input.text ? input.text.trim().length : 0;
    throw new Error(
      `不予受理：本庭的评定对象是相对独立、自身完整的文化内容整体，文字内容不少于 ${MIN_TARGET_CHARS} 字（当前 ${n} 字）。片段、摘要、单条评论不足以构成评定对象；评论区线索只能作为已有案件的补充证据。`,
    );
  }

  // 完整性审查：播客单集时长不少于 5 分钟（页面可解析出时长时）
  if (target.contentType === 'podcast_episode' && target.text) {
    const minutes = parseDurationMinutes(target.text);
    if (minutes !== null && minutes < MIN_EPISODE_MINUTES) {
      throw new Error(
        `不予受理：播客单集时长约 ${minutes} 分钟，少于 ${MIN_EPISODE_MINUTES} 分钟。过短的片段不足以构成独立的评定对象。`,
      );
    }
    if (minutes !== null) rt.log('立案', `单集时长约 ${minutes} 分钟，通过完整性审查`);
  }

  // 归属预审（P0-1）：验明正身再立案
  const { date, precision } = extractDate(target.text);
  if (target.contentType === 'podcast_episode' || target.contentType === 'podcast_with_transcript') {
    if (!target.date && date) target.date = date;
  } else if (date && precision === 'day') {
    target.date = target.date || date;
  }
  const review = preReview({ url: input.url, text: input.text, fetched: { title: target.title, text: target.text } });
  const prError: Error | null = review.pass
    ? null
    : Object.assign(new Error('预审未通过：' + (review.failNote || '')), { preReview: review });

  return {
    caseId,
    createdAt: new Date().toISOString(),
    input,
    target,
    fingerprints: [],
    leads: [],
    attribution: 'unknown',
    preReview: review,
    ...(prError ? {} : {}),
  };
}

/** 从页面文本解析"36分钟 / 1小时02分"式时长；解析不出返回 null */
export function parseDurationMinutes(text: string): number | null {
  const head = text.slice(0, 4000);
  const h = head.match(/(\d+)\s*小时/);
  const m = head.match(/(\d+)\s*分钟/);
  if (m) return (h ? parseInt(h[1]) * 60 : 0) + parseInt(m[1]);
  if (h) return parseInt(h[1]) * 60;
  return null;
}

function guessContentType(url: string, body: string): CaseFile['target']['contentType'] {
  if (/xiaoyuzhoufm\.com\/(episode|podcast)/.test(url)) return 'podcast_episode';
  // T76WDM 修正：Apple 页面通常无公开转录稿（自动转录仅部分节目且渲染不出）——按无转录处理
  if (/podscript|podscribe/.test(url)) return 'podcast_with_transcript';
  if (/podcasts\.apple\.com/.test(url)) return 'podcast_episode';
  if (/youtube\.com|bilibili\.com|douyin/.test(url)) return 'video';
  if (/douban\.com\/doubanapp|book\.douban/.test(url)) return 'book_excerpt';
  if (/shownotes|本期节目|主播/.test(body.slice(0, 3000))) return 'podcast_episode';
  return 'article';
}

function extractComments(body: string): string | undefined {
  // Jina 渲染小宇宙页时，评论区以 "--\n日期\n[点赞数]\n评论内容" 形式混排
  const m = body.match(/--\s*\n(?:\d{4}\.\d{2}\.\d{2})\s*\n[\s\S]{0,6000}?(?=\n--\s*\n|\[共 \d+ 条回复\])/);
  if (!m) return undefined;
  const chunk = m[0];
  if (chunk.length < 50) return undefined;
  return chunk;
}

// ---------------------------------------------------------------------------
// 阶段二：侦查（画像 + 指纹 + 群众线报 + 署名）
// ---------------------------------------------------------------------------

export interface InvestigateOptions {
  /** 种子指纹：来自社区线报/母项目判例的已验证指纹，直接注入候选（targetQuote 为目标文本引文） */
  seedFingerprints?: { targetQuote: string; type?: FingerprintCandidate['type']; note?: string; searchKeywordsEn?: string[] }[];
}

export async function investigation(cf: CaseFile, rt: CourtRuntime, opts?: InvestigateOptions): Promise<CaseFile> {
  const text = truncateSmart(cf.target.text, 14000);

  rt.log('侦查', '书记员整理案情画像…');
  const profile = await chatJson<any>(rt.provider.chat, PROFILE_SYSTEM, `目标文本：\n${text}`);
  cf.profile = {
    topicDomain: String(profile.topicDomain || ''),
    mediaType: (['podcast', 'fiction', 'article', 'unknown'].includes(profile.mediaType) ? profile.mediaType : 'unknown') as any,
    coreClaims: (profile.coreClaims || []).map(String).slice(0, 10),
    outline: (profile.outline || []).map(String).slice(0, 15),
    entities: (profile.entities || []).map(String).slice(0, 25),
    toneSignals: (profile.toneSignals || []).map(String).slice(0, 10),
    summaryZh: String(profile.summaryZh || ''),
  };
  rt.log('侦查', `画像完成：${cf.profile.topicDomain}；指纹鉴定官提取指纹候选…`);

  // v2.2.7 指纹提取分段全覆盖：长转录稿（如 22803 字符的 324 期）只看前 14000 会漏掉
  // 后半段的最强指纹（142/31/43/55 佐治亚数据段在第 15547 字符处——AA3F00 案教训）
  const full = cf.target.text;
  const CHUNK = 12000;
  const nChunks = Math.max(1, Math.ceil(full.length / CHUNK));
  const fpParts: any[] = [];
  for (let ci = 0; ci < Math.min(nChunks, 3); ci++) {
    const segText = full.slice(ci * CHUNK, (ci + 1) * CHUNK);
    try {
      const fp = await chatJson<any>(
        rt.provider.chat,
        FINGERPRINT_SYSTEM,
        `目标文本（第 ${ci + 1}/${Math.min(nChunks, 3)} 段）：\n${segText}`,
      );
      fpParts.push(...((fp.fingerprints || []) as any[]));
    } catch (e: any) {
      rt.log('侦查', `第 ${ci + 1} 段指纹提取失败（${e.message.slice(0, 50)}），跳过该段`);
    }
  }
  const fp = { fingerprints: fpParts };
  cf.fingerprints = ((fp.fingerprints || []) as any[])
    .slice(0, 14)
    .map((f, i) => ({
      id: 'FP' + (i + 1),
      type: (['weird_term', 'rare_case', 'data_combo', 'analogy', 'joke', 'ordering', 'other'].includes(f.type) ? f.type : 'other') as FingerprintCandidate['type'],
      priority: f.priority === 'E4_suspect' || f.priority === 'high' ? f.priority : 'normal',
      targetQuote: String(f.targetQuote || ''),
      note: f.note ? String(f.note) : undefined,
      searchKeywordsZh: (f.searchKeywordsZh || []).map(String).slice(0, 4),
      searchKeywordsEn: (f.searchKeywordsEn || []).map(String).slice(0, 4),
    }))
    .filter((f) => f.targetQuote.length >= 6);
  // 指纹纪律（机制PRD v2 §3.1）：确定性过滤，LLM 之后、种子注入之前
  {
    const { kept, rejected } = applyFingerprintDiscipline(cf.fingerprints, cf.target.text, {
      programName: inferProgramName(cf),
      episodeTitle: cf.target.title,
    });
    cf.fingerprints = kept;
    for (const rj of rejected.slice(0, 10)) {
      rt.log('侦查', `指纹纪律淘汰 ${rj.fingerprint.id}：${rj.reason}`);
    }
    rt.log('侦查', `指纹纪律：保留 ${kept.length} / 淘汰 ${rejected.length}`);
  }

  // 种子指纹注入（社区线报/母项目判例的已验证指纹，置顶）
  if (opts?.seedFingerprints?.length) {
    const seeds: FingerprintCandidate[] = opts.seedFingerprints.map((s, i) => ({
      id: 'FPS' + (i + 1),
      type: s.type || 'weird_term',
      priority: 'E4_suspect' as const,
      targetQuote: s.targetQuote,
      note: (s.note || '社区已验证指纹') + '（种子指纹，来源：群众线报/判例）',
      searchKeywordsZh: [],
      searchKeywordsEn: s.searchKeywordsEn || [],
    }));
    cf.fingerprints = [...seeds, ...cf.fingerprints];
    rt.log('侦查', `注入种子指纹 ${seeds.length} 个（已置顶）`);
  }

  // 群众线报（有评论区才做）
  if (cf.target.comments && cf.target.comments.length > 80) {
    rt.log('侦查', '群众线报官查阅评论区…');
    try {
      const ld = await chatJson<any>(rt.provider.chat, LEADS_SYSTEM, `评论区内容：\n${truncateSmart(cf.target.comments, 6000)}`);
      cf.leads = ((ld.leads || []) as any[]).slice(0, 8).map((l, i) => ({
        id: 'LD' + (i + 1),
        quote: String(l.quote || ''),
        kind: ['explicit_source_doubt', 'weird_term_confusion', 'other_suspicion'].includes(l.kind) ? l.kind : 'other_suspicion',
        note: String(l.note || ''),
        searchKeywordsZh: (l.searchKeywordsZh || []).map(String).slice(0, 3),
        searchKeywordsEn: (l.searchKeywordsEn || []).map(String).slice(0, 3),
      })).filter((l) => l.quote.length >= 4);
      rt.log('侦查', `收到群众线报 ${cf.leads.length} 条`);
    } catch (e: any) {
      rt.log('侦查', `线报提取失败（${e.message}），跳过`);
    }
  }

  // 署名判断
  try {
    const at = await chatJson<any>(rt.provider.chat, ATTRIBUTION_SYSTEM, `目标文本（含 shownotes 若有）：\n${truncateSmart(text, 8000)}`);
    cf.attribution = ['complete', 'partial', 'none', 'unknown'].includes(at.attribution) ? at.attribution : 'unknown';
    cf.attributionNote = at.note ? String(at.note) : undefined;
    rt.log('侦查', `来源标注：${cf.attribution}`);
  } catch {
    rt.log('侦查', '署名判断失败，按 unknown 处理');
  }

  return cf;
}

/** 标题→R0 检索式（v2.2）：LLM 把中文标题翻成英文检索式——避免中文检索式只找回中文圈镜像/同节目内容 */
export async function buildTitleQueryEn(cf: CaseFile, rt: CourtRuntime): Promise<string> {
  let t = (cf.target.title || '').replace(/\s*-\s*[^-]+-\s*(Apple\s*)?播客\s*$/, '').trim();
  t = t.replace(/^\d{1,4}\s*[-—－]\s*/, ''); // 期号
  if (!t || t.length < 3) return '';
  try {
    const r = await chatJson<any>(
      rt.provider.chat,
      cf.profile?.mediaType === 'fiction'
        ? 'You craft ONE precise web-search query to find PUBLICATIONS and DISCUSSIONS of a Chinese literary work (novella/novel/story): reviews, literary journals, reprint/serialization pages, author interviews. Combine the work title (translated if known) + author name + one of: review / 小说 / 作品. Do NOT search for imagery or plot elements (peach garden etc) - search for THE WORK ITSELF. Output only JSON: {"query":"query"}.'
        : 'You translate a Chinese podcast episode title into ONE precise English web-search query that would find ORIGINAL English-language sources (books, podcasts, essays) discussing the same subject. Output only JSON: {"query":"english query"}. Keep proper nouns. Add none or one of: podcast / book / essay - only if it helps find original sources, not Chinese reposts.',
      `标题：${t}\n主题域：${cf.profile?.topicDomain || ''}\n画像实体：${(cf.profile?.entities || []).slice(0, 10).join('；')}`,
    );
    const q = String(r.query || '').trim();
    if (q.length >= 8 && /[A-Za-z]{4,}/.test(q)) return q;
  } catch { /* LLM 失败 → 回退启发式 */ }
  // 确定性回退：画像英文实体 + 意图词
  const entities = (cf.profile?.entities || [])
    .filter((e) => /[A-Za-z]{3,}/.test(e))
    .filter((e) => !/kkk|ku klux/i.test(e))
    .slice(0, 2);
  return [t, ...entities, 'podcast episode analysis'].filter(Boolean).join(' ').slice(0, 120);
}

/** 从目标标题推断节目名（"338-xxx - 独树不成林 - Apple 播客" 的倒数第二段） */
function inferProgramName(cf: CaseFile): string | undefined {
  const seg = (cf.target.title || '').split(' - ');
  if (seg.length >= 3) return seg[seg.length - 2].trim();
  return undefined;
}

// ---------------------------------------------------------------------------
// 阶段三：检索
// ---------------------------------------------------------------------------

export async function discovery(cf: CaseFile, rt: CourtRuntime, opts?: { maxSources?: number }): Promise<CaseFile> {
  // v2.2：三轮足量检索（R0标题英文化 + R1主题 + R2指纹精确 + R3线报），目标 ≥8 候选源
  const maxSources = opts?.maxSources ?? 10;
  const q = await chatJson<any>(
    rt.provider.chat,
    DISCOVERY_QUERY_SYSTEM,
    `案情画像：${JSON.stringify({
      topicDomain: cf.profile?.topicDomain,
      coreClaims: cf.profile?.coreClaims,
      entities: cf.profile?.entities,
      outline: cf.profile?.outline,
    }, null, 0)}\n\n指纹候选（id/类型/英文检索词）：${cf.fingerprints.map((f) => `${f.id} ${f.type} [${f.searchKeywordsEn.join('; ')}]`).join('\n')}\n\n群众线报：${cf.leads.map((l) => `${l.id} ${l.searchKeywordsEn.join('; ')}`).join('\n') || '无'}`,
  );

  const queries: { tag: string; q: string }[] = [];
  (q.queries?.topic || []).slice(0, 3).forEach((qq: string) => queries.push({ tag: 'R1 主题', q: String(qq) }));
  (q.queries?.fingerprint || []).slice(0, 10).forEach((f: any) => {
    if (f && f.query) queries.push({ tag: `R2 指纹 ${f.fingerprintId || ''}`.trim(), q: String(f.query) });
  });
  (q.queries?.leads || []).slice(0, 3).forEach((l: any) => {
    if (l && l.query) queries.push({ tag: 'R3 线报', q: String(l.query) });
  });
  // R0 标题直检（v2.2）：LLM 生成英文检索式，找境外原文/原播客而非中文圈镜像
  const titleQuery = await buildTitleQueryEn(cf, rt);
  if (titleQuery) {
    queries.unshift({ tag: 'R0 标题', q: titleQuery });
    rt.log('检索', `R0 标题检索式（英文）：${titleQuery}`);
  }
  // R1b 播客定向轮（v2.2.3，FDLMYH 案根因修复）：目标内容是播客时，源大概率也是播客。
  // 用画像里最独特的叙事细节（不是通史词）+ podcast 意图词构造检索式——通史式查询永远搜不到播客单集。
  const isPodcast =
    (/podcast/.test(cf.target.contentType || '') || /xiaoyuzhoufm|podcasts\.apple/.test(cf.input.url || '')) &&
    cf.profile?.mediaType !== 'fiction'; // v2.2.8 文学不加 podcast 意图词（H6RNXM 案：小说检索成桃园结义播客）
  if (isPodcast && cf.profile) {
    try {
      const pq = await chatJson<any>(
        rt.provider.chat,
        'You craft search queries to find ENGLISH-LANGUAGE PODCAST EPISODES that a Chinese podcast episode may have drawn from. RULES: (1) Queries MUST be in ENGLISH only - translate every concept; a Chinese query finds Chinese reposts, never the original English podcast. (2) Each query combines the single most DISTINCTIVE narrative specifics of this episode (a named event, work, person, or a distinctive framing like "three iterations of X") + the word podcast. (3) DO NOT output generic encyclopedic queries ("history of X") - they never find podcast episodes. Good example: \"three iterations\" Ku Klux Klan 1866 1915 podcast. Bad example: 3K党 podcast (Chinese, generic). Output only JSON: {"queries":["english query 1","english query 2"]}',
        `单集画像：主题域=${cf.profile.topicDomain}\n核心论点：${cf.profile.coreClaims.join('；')}\n实体：${cf.profile.entities.join('；')}\n大纲：${cf.profile.outline.join('；')}\n目标标题：${cf.target.title}`,
        { maxTokens: 500 },
      );
      // v2.2.4 确定性守卫：查询必须以英文为主（中文字符<30%），且含 podcast 意图词——不信 LLM 的自觉
      const pqs = ((pq.queries || []) as string[])
        .map(String)
        .filter((s) => s.length > 10)
        .filter((s) => {
          const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
          const enWords = (s.match(/[A-Za-z]{4,}/g) || []).length;
          // 含中文的查询必须是"英文实质为主"（≥3 个英文长词），否则拒——"3K党 podcast"这种会搜回中文源
          return /podcast/i.test(s) && (cjk === 0 || enWords >= 3);
        })
        .slice(0, 3);
      if (pqs.length) {
        pqs.forEach((s, i) => queries.splice(1 + i, 0, { tag: `R1b 播客定向`, q: s }));
        rt.log('检索', `R1b 播客定向检索式 ×${pqs.length}：${pqs.join(' ｜ ').slice(0, 120)}`);
      } else {
        // 兜底：画像实体中的英文专名 + 框架词 + podcast
        const enEnts = (cf.profile?.entities || []).filter((e) => /[A-Za-z]{4,}/.test(e)).slice(0, 3).join(' ');
        if (enEnts) {
          queries.splice(1, 0, { tag: 'R1b 播客定向', q: `${enEnts} podcast` });
          rt.log('检索', `R1b 兜底检索式（LLM 输出不合规，用画像英文实体）：${enEnts} podcast`);
        }
      }
    } catch (e: any) {
      rt.log('检索', `R1b 播客定向构造失败（${e.message.slice(0, 60)}），跳过`);
    }
  }
  // R2c 原文精确检索（v2.2.8，fiction 专用）：指纹中最具辨识度的连续引文逐字检索——
  // 找转载/抄袭/洗稿原文（转载页往往只保留原文，标题不含作品名）
  if (cf.profile?.mediaType === 'fiction') {
    const quoteFps = cf.fingerprints
      .filter((f) => f.targetQuote.replace(/\s/g, '').length >= 20)
      .slice(0, 3);
    for (const f of quoteFps) {
      // 中文引文直接检索（中文原文转载在中文站）；截取中段最特异片段（开头结尾易被改写）
      const raw = f.targetQuote.replace(/\s+/g, '');
      const mid = raw.slice(Math.max(0, Math.floor(raw.length * 0.2)), Math.floor(raw.length * 0.2) + 24);
      if (mid.length >= 16) queries.push({ tag: `R2c 原文 ${f.id}`, q: `"${mid}"` });
    }
    if (quoteFps.length) rt.log('检索', `R2c 原文精确检索式 ×${quoteFps.length}（指纹引文逐字，找转载/抄袭页）`);
  }
  rt.log('检索', `构造检索式 ${queries.length} 条，开始多轮搜索（目标候选 ≥8）…`);

  const seen = new Set<string>();
  // v2.2.7 跨店面同单集去重键（AA3F00 案：TRIH Part1 的 us/cm 两店同 episode id 重复入卷占两席）
  const seenEpId = new Set<string>();
  const candidates: { doc: { title: string; url: string; snippet: string; date?: string }; via: string }[] = [];
  const mirrorNotes: string[] = [];
  const rejected: { title: string; reason: string }[] = [];
  for (const { tag, q: query } of queries) {
    try {
      const { docs } = await rt.provider.search(query);
      for (const d of docs) {
        if (!seen.has(d.url)) {
          // ?i= 相同（无论哪个店面/域名）→ 同一单集，只留首个
          const epId = (d.url.match(/[?&]i=(\d+)/) || [])[1];
          if (epId) {
            if (seenEpId.has(epId)) continue;
            seenEpId.add(epId);
          }
          seen.add(d.url);
          candidates.push({ doc: d, via: `${tag}：${query}` });
        }
      }
      rt.log('检索', `[${tag}] "${query.slice(0, 50)}" → ${docs.length} 条`);
    } catch (e: any) {
      rt.log('检索', `[${tag}] 失败：${e.message.slice(0, 80)}`);
    }
  }
  rt.log('检索', `共获不重复候选 ${candidates.length} 个，进入过滤与评分…`);

  // —— 源卫生 + 质量闸门（确定性过滤，全部记录淘汰原因）——
  const targetDate = cf.target.date ? Date.parse(cf.target.date) : NaN;
  const filtered: { doc: { title: string; url: string; snippet: string; date?: string }; via: string }[] = [];
  for (const c of candidates) {
    const hyg = isMirrorOrGenericSource(
      { title: c.doc.title, url: c.doc.url, snippet: c.doc.snippet },
      { title: cf.target.title, url: cf.input.url, author: cf.target.author },
    );
    if (hyg.generic) {
      rejected.push({ title: c.doc.title, reason: '通用平台壳页' });
      continue;
    }
    if (hyg.mirror) {
      mirrorNotes.push(`${c.doc.title.slice(0, 50)}（${hyg.note}）`);
      rejected.push({ title: c.doc.title, reason: `自我镜像：${hyg.note}` });
      continue;
    }
    // v2.2 补充：源标题与目标标题高度相似（同节目其他单集/同内容转发）→ 疑似镜像
    // v2.2.4：目标作者名（节目名）在源标题或摘要中出现 → 跨平台自镜像（71CO8V案：目标Spotify镜像入卷）
    const tgtTitle = (cf.target.title || '').replace(/^\d{1,4}\s*[-—－]\s*/, '');
    const srcTitle = (c.doc.title || '').replace(/^\d{1,4}\s*[-—－]\s*/, '');
    const tKey = tgtTitle.slice(0, 18);
    const selfNameHit = (() => {
      const names = [cf.target.author, (cf.target.title || '').split(' - ').filter((s) => s.trim().length >= 4)[1]].filter(Boolean) as string[];
      return names.some((nm) => nm && nm.length >= 4 && (srcTitle.includes(nm) || (c.doc.snippet || '').slice(0, 300).includes(nm)));
    })();
    if ((tKey.length >= 8 && srcTitle.includes(tKey)) || selfNameHit) {
      mirrorNotes.push(`${c.doc.title.slice(0, 50)}（标题/作者与目标同源）`);
      rejected.push({ title: c.doc.title, reason: selfNameHit ? `含目标节目名「${cf.target.author}」——目标自身的分发镜像` : '标题与目标高度相似（同节目单集/转发）' });
      continue;
    }
    filtered.push(c);
  }
  rt.log('检索', `卫生过滤：${candidates.length} → ${filtered.length}（镜像/壳页 ${rejected.length} 个转归属链）`);

  // —— v2.2 LLM 相似度排序（批量评分）：目标画像 vs 候选标题+摘要 ——
  const pool = filtered.slice(0, 24);
  const scored: typeof filtered & { sim?: number; why?: string }[] = filtered.slice(0, 0);
  let rankList: { idx: number; sim: number; why: string }[] = [];
  if (pool.length) {
    rt.log('检索', '书记员对候选源做主题相似度评分与排序…');
    try {
      const rk = await chatJson<any>(
        rt.provider.chat,
        'You rank candidate sources by semantic similarity to a target podcast episode profile. Similarity 0-100: 90+ = same specific subject AND likely same specific claims/examples; 70-89 = same specific subject; 40-69 = same broad domain; <40 = unrelated. Output only JSON: {"ranked":[{"idx":0,"sim":85,"why":"short reason"}]}. idx is the 0-based index in the candidate list. Rank ALL candidates.',
        `目标画像：主题域=${cf.profile?.topicDomain || ''}\n核心论点：${(cf.profile?.coreClaims || []).slice(0, 5).join('；')}\n实体：${(cf.profile?.entities || []).slice(0, 12).join('；')}\n摘要：${cf.profile?.summaryZh || ''}\n\n候选源列表：\n${pool.map((c, i) => `${i}. ${c.doc.title} | ${String(c.doc.snippet || '').slice(0, 160).replace(/\n/g, ' ')}`).join('\n')}`,
        { maxTokens: 3000 },
      );
      rankList = ((rk.ranked || []) as any[]).map((r) => ({ idx: +r.idx, sim: Math.max(0, Math.min(100, +r.sim || 0)), why: String(r.why || '') })).filter((r) => r.idx >= 0 && r.idx < pool.length);
      rt.log('检索', `评分完成：${rankList.length}/${pool.length} 个候选获分`);
    } catch (e: any) {
      rt.log('检索', `相似度评分失败（${e.message.slice(0, 60)}），按检索顺序入卷`);
    }
  }
  // 按相似度降序（无分者排后，保持原序）
  const simMap = new Map(rankList.map((r) => [r.idx, r]));
  const ordered = pool.map((c, i) => ({ c, r: simMap.get(i) })).sort((a, b) => (b.r?.sim ?? -1) - (a.r?.sim ?? -1));

  // —— 取全文（前 maxSources+4），记录 partial ——
  rt.sources = [];
  const fetched: SourceDoc[] = [];
  rt.mirrorNotes = mirrorNotes;
  for (const { c, r } of ordered.slice(0, maxSources + 4)) {
    if (fetched.length >= maxSources) break;
    let fullText = '';
    let partial = true;
    let title = c.doc.title;
    try {
      const fd = await rt.fetcher.fetchDoc(c.doc.url);
      fullText = fd.text;
      title = fd.title || title;
      partial = fullText.length < 800;
    } catch {
      rt.log('检索', `候选源全文获取失败：${c.doc.url.slice(0, 60)}，以摘要对质`);
    }
    const parkHit = SOURCE_QUALITY_GATE.parkDomainWords.some((w) => (fullText + title).toLowerCase().includes(w.toLowerCase()));
    // v2.2.6 搜索错误页/空结果页（K5B292 教训：'Try searching for it instead' 4088字符过闸占了相似度90席位）
    const junkTitle = /try searching|no results|page not found|not found|404|search results for|nothing matched/i.test(title);
    if (junkTitle) {
      rejected.push({ title, reason: '搜索错误/空结果页' });
      rt.log('检索', `候选源被质量闸门拦截（搜索错误页）：${title.slice(0, 40)}`);
      continue;
    }
    if (fullText.length > 0 && fullText.length < SOURCE_QUALITY_GATE.minTextChars) {
      rejected.push({ title, reason: `正文仅 ${fullText.length} 字符` });
      rt.log('检索', `候选源被质量闸门拦截（正文仅 ${fullText.length} 字符）：${title.slice(0, 40)}`);
      continue;
    }
    if (parkHit) {
      rejected.push({ title, reason: '域名待售页' });
      continue;
    }
    const srcDate = c.doc.date ? Date.parse(c.doc.date) : NaN;
    fetched.push({
      id: 'SRC' + (fetched.length + 1),
      title,
      url: c.doc.url,
      date: c.doc.date,
      snippet: c.doc.snippet,
      fullText,
      fetchedAt: new Date().toISOString(),
      partial,
      reversed: !Number.isNaN(targetDate) && !Number.isNaN(srcDate) && srcDate > targetDate,
      origin: 'search',
      viaQuery: c.via,
      similarity: r?.sim,
      aiSummary: r?.why,
    });
    rt.log('检索', `候选源入卷 ${fetched.length}/${maxSources}（相似度 ${r?.sim ?? '?'}）：${title.slice(0, 44)}${partial ? '（部分取证）' : ''}`);
  }
  if (fetched.length < 8) {
    rt.log('检索', `⚠ 候选源不足 8 个（${fetched.length}），检索广度受限——已在 ${queries.length} 条检索式内尽力`);
  }
  // v2.2.7 系列扩展（AA3F00 案教训：TRIH 四部曲只入卷 Part1，佐治亚数据在 Part2）：
  // 入卷源标题含 "Part N" 且来自播客平台 → 检索同系列其他单集，补入 ≤2 个
  try {
    const seriesSrc = fetched.find(
      (s) => /part\s*[0-9iv]+/i.test(s.title) && /podcasts\.apple|open\.spotify|musixmatch|getpodcast/.test(s.url),
    );
    if (seriesSrc) {
      const seriesBase = seriesSrc.title.replace(/part\s*[0-9iv]+/i, '').replace(/\s{2,}/g, ' ').trim();
      const curPart = (seriesSrc.title.match(/part\s*([0-9iv]+)/i) || [])[1];
      if (seriesBase.length > 10) {
        rt.log('检索', `检测到系列单集（Part ${curPart}）：${seriesBase.slice(0, 40)}——检索同系列其他单集…`);
        const { docs: sdocs } = await rt.provider.search(`${seriesBase} podcast episode`);
        for (const sd of (sdocs || []).slice(0, 8)) {
          if (fetched.length >= 12) break;
          if (!sd || !sd.url) continue;
          const isSeries = new RegExp(seriesBase.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(sd.title || '');
          const isOtherPart = /part\s*[0-9iv]+/i.test(sd.title || '') && !new RegExp(`part\\s*${curPart}\\b`, 'i').test(sd.title || '');
          if (!isSeries || !isOtherPart) continue;
          const epId = (sd.url.match(/[?&]i=(\d+)/) || [])[1];
          if (epId && seenEpId.has(epId)) continue;
          if (seen.has(sd.url)) continue;
          if (epId) seenEpId.add(epId);
          seen.add(sd.url);
          fetched.push({
            id: 'SRC' + (fetched.length + 1),
            title: String(sd.title || ''),
            url: String(sd.url),
            date: sd.date,
            snippet: sd.snippet,
            fullText: '',
            fetchedAt: new Date().toISOString(),
            partial: true,
            reversed: false,
            origin: 'search',
            viaQuery: `R5 系列扩展：${seriesBase.slice(0, 40)}`,
          });
          rt.log('检索', `系列扩展入卷：${String(sd.title || '').slice(0, 44)}`);
        }
      }
    }
  } catch { /* 系列扩展失败不阻塞 */ }
  rt.sources = fetched;
  rt.rejectedSources = rejected;
  return cf;
}

// ---------------------------------------------------------------------------
// 阶段四：对质
// ---------------------------------------------------------------------------

export async function crossExamination(cf: CaseFile, rt: CourtRuntime): Promise<EvidenceItem[]> {
  const evidence: EvidenceItem[] = [];
  if (rt.sources.length === 0) {
    rt.log('对质', '无候选源可对质');
    return evidence;
  }

  // 4.1 结构对齐（v2.2：对 top 4 源做——相似度排序后的前四）
  const targetSeg = truncateSmart(cf.target.text, 12000);
  for (const src of rt.sources.slice(0, 4)) {
    if (!src.fullText || src.fullText.length < 500) continue;
    rt.log('对质', `结构鉴定官比对 ${src.id}（${src.title.slice(0, 36)}）…`);
    try {
      const al = await chatJson<any>(
        rt.provider.chat,
        ALIGN_SYSTEM,
        `目标文本（中文）：\n${targetSeg}\n\n候选源文本：\n${truncateSmart(src.fullText, 20000)}`,
        { maxTokens: 4096 },
      );
      const chainSteps = (al.chainSteps || (al.alignments || []).length) as number;
      if (al.structureMatched && chainSteps >= 3) {
        const located = (al.alignments || []).some((a: any) =>
          locateQuote(a.targetExcerpt, cf.target.text) || locateQuote(a.sourceExcerpt, src.fullText),
        );
        evidence.push({
          id: `EV-${src.id}-E2`,
          level: 'E2',
          kind: '论证链同构',
          description: `与 ${src.title.slice(0, 50)} 的论证链有 ${chainSteps} 个环节同序对应（置信 ${al.confidence}）：${al.orderConsistency || ''}`,
          sourceId: src.id,
          targetQuoteLocated: located,
          detail: { chainSteps, alignments: (al.alignments || []).slice(0, 8), publicDomainNote: al.publicDomainNote },
        });
        rt.log('对质', `论证链同构：${src.id} ${chainSteps} 环节对应`);
      } else if (al.structureMatched && chainSteps < 3) {
        rt.log('对质', `${src.id} 结构相似但仅 ${chainSteps} 环节（<3），不构成论证链同构，忽略`);
      }
    } catch (e: any) {
      rt.log('对质', `结构对齐失败（${e.message.slice(0, 80)}）`);
    }
  }

  // 4.1b v2.2 候选源 AI 摘要（对全部入卷源）：语言、内容类型、主题、与目标的重合点
  for (const src of rt.sources) {
    if (src.aiSummary && src.aiSummary.length > 30) continue; // 排序阶段已有 why 的不重做
    try {
      const su = await chatJson<any>(
        rt.provider.chat,
        "Summarize a candidate source for a plagiarism-check court. Output only JSON: {\"lang\":\"en|zh|other\",\"type\":\"podcast|article|book|wiki|other\",\"topic\":\"one line\",\"overlap\":\"what specifically overlaps with the target episode subject/claims/examples\"}",
        `目标画像：主题域=${cf.profile?.topicDomain || ''}；摘要=${cf.profile?.summaryZh || ''}\n\n候选源：${src.title}\n${truncateSmart(src.fullText || src.snippet || '', 3000)}`,
        { maxTokens: 400 },
      );
      src.aiSummary = `[${su.lang || '?'}·${su.type || '?'}] ${su.topic || ''}｜重合：${su.overlap || '无'}`;
    } catch { /* 摘要失败不阻塞对质 */ }
  }

  // 4.1c v2.2.6 宏观结构对比（用户决策：不能只抽点做事实对比，必须先看宏观/结构层）：
  // 目标画像 outline 逐项在源全文中找对应段——输出映射覆盖率。≥60% 环节有实质对应 → E2 候选。
  // 这是母项目维度B（主干-细节）的操作化：论证骨架对应，不依赖零散指纹。
  const isFiction = cf.profile?.mediaType === 'fiction';
  const MACRO_SYSTEM = isFiction
    ? 'You map the NARRATIVE structure of a Chinese literary work (story opening / setting / characters / key scenes / ending as outlined) against ONE candidate source. For EACH outline item, determine whether the source contains a SUBSTANTIAL corresponding narrative section (a scene retelling, excerpt, or detailed synopsis - not a passing mention of a similar image): output {"item": 1, "found": true, "sourceExcerpt": "verbatim quote from source (>=15 chars)", "note": "one-line Chinese note"} or found=false. Coverage = found/total. Output only JSON: {"mappings":[{"item":1,"found":true,"sourceExcerpt":"...","note":"..."}],"coverage":0.0,"verdictNote":"Chinese one-liner"}'
    : 'You map the argument structure of a Chinese podcast episode outline against ONE candidate source. For EACH outline item (usually 4-8), determine whether the source contains a SUBSTANTIAL corresponding section (not a passing mention): output {"item": 1, "found": true, "sourceExcerpt": "verbatim quote from source (>=15 words)", "note": "one-line Chinese note"} or found=false. Then output overall coverage = found items / total. Found means the source dedicates real discussion to that part of the argument, not just mentions the topic word. Output only JSON: {"mappings":[{"item":1,"found":true,"sourceExcerpt":"...","note":"..."}],"coverage":0.0,"verdictNote":"Chinese one-liner"}';
  const outlineItems = (cf.profile?.outline || []).slice(0, 8);
  if (outlineItems.length >= 3) {
    // v2.2.7：已转录源优先（AA3F00 案教训：4条E2全指向通史百科——主题级映射人人满足，
    // 转录稿源排在slice(0,4)之外根本轮不到）
    const macroPool = [...rt.sources]
      .sort((a, b) => (b.transcribed ? 1 : 0) - (a.transcribed ? 1 : 0))
      .slice(0, 6);
    for (const src of macroPool) {
      if (!src.fullText || src.fullText.length < 800) continue;
      if (evidence.some((e) => e.sourceId === src.id && e.level === 'E2')) continue;
      rt.log('对质', `宏观结构官比对 ${src.id}（${src.title.slice(0, 30)}）：目标大纲 ${outlineItems.length} 项映射…`);
      try {
        const mc = await chatJson<any>(
          rt.provider.chat,
          MACRO_SYSTEM,
          `目标大纲（中文播客单集）：\n${outlineItems.map((o, i) => `${i + 1}. ${o}`).join('\n')}\n\n候选源 ${src.id} 全文：\n${truncateSmart(src.fullText, 16000)}`,
          { maxTokens: 1500 },
        );
        const cov = Math.max(0, Math.min(1, +mc.coverage || 0));
        const foundItems = ((mc.mappings || []) as any[]).filter((m) => m.found && m.sourceExcerpt);
        if (cov >= 0.6 && foundItems.length >= 3) {
          evidence.push({
            id: `EV-MACRO-${src.id}`,
            level: 'E2',
            kind: '宏观结构对应',
            description: `目标大纲 ${outlineItems.length} 项中 ${foundItems.length} 项（${Math.round(cov * 100)}%）在该源有实质对应段落——论证主干同构：${String(mc.verdictNote || '')}`,
            sourceId: src.id,
            targetQuoteLocated: true,
            detail: { macro: true, coverage: cov, mappings: foundItems.slice(0, 8) },
          });
          rt.log('对质', `宏观结构：${src.id} 覆盖率 ${Math.round(cov * 100)}%（${foundItems.length}/${outlineItems.length} 项对应）→ E2`);
        } else {
          rt.log('对质', `宏观结构：${src.id} 覆盖率 ${Math.round(cov * 100)}%（<60%），不构成主干同构`);
        }
      } catch (e: any) {
        rt.log('对质', `宏观结构比对 ${src.id} 失败（${e.message.slice(0, 60)}）`);
      }
    }
  }

  // 4.2 指纹验证（对全部源）
  const sourcesCtx = rt.sources
    .map((s) => `【${s.id}】${s.title}\nURL: ${s.url}\n${s.fullText ? truncateSmart(s.fullText, 12000) : '(无全文，仅有摘要：' + (s.snippet || '') + ')'}`)
    .join('\n\n========\n\n');
  const fpsCtx = cf.fingerprints
    .map((f) => `【${f.id}】type=${f.type} priority=${f.priority}\n引文：${f.targetQuote}\n说明：${f.note || ''}`)
    .join('\n');

  rt.log('对质', `指纹验证官开始验证 ${cf.fingerprints.length} 个指纹 × ${rt.sources.length} 个源…`);
  const fpRes = await chatJson<any>(
    rt.provider.chat,
    FPCHECK_SYSTEM,
    `指纹候选：\n${fpsCtx}\n\n候选源文本：\n${sourcesCtx}`,
    { maxTokens: 4096 },
  );

  const srcMap = new Map(rt.sources.map((s) => [s.id, s]));
  for (const r of (fpRes.results || []) as any[]) {
    const fp = cf.fingerprints.find((f) => f.id === r.fingerprintId);
    if (!fp || !r.hit) continue;
    const src = srcMap.get(String(r.sourceId || '')) || rt.sources[0];
    const sQuote = String(r.sourceQuote || '');
    const located = locateQuote(sQuote, src?.fullText || src?.snippet || '');
    evidence.push({
      id: `EV-${fp.id}-${src?.id || 'S?'}`,
      level: r.transcription_error ? 'E4' : 'E3',
      kind: r.transcription_error ? '错误传播' : '细节指纹',
      description: `${fp.id}（${fp.type}）在 ${src?.id} 命中：${r.note || ''}`,
      targetQuote: fp.targetQuote,
      targetQuoteLocated: locateQuote(fp.targetQuote, cf.target.text),
      sourceQuote: sQuote,
      sourceQuoteLocated: located,
      sourceId: src?.id,
      detail: { fingerprintType: fp.type, confidence: r.confidence, transcriptionError: !!r.transcription_error },
    });
    rt.log('对质', `${r.transcription_error ? 'E4' : 'E3'} 指纹命中：${fp.id} ← ${src?.id}${located ? '' : '（源引文未定位，降级展示）'}`);
  }
  // v2.2.1 定向细比对（用户要求证据清单不少于 3 条）：对 top3 源逐个找"最具体的重合点"，
  // 命中→产出 E3 候选（走后续检定）；未命中→产出 E1 级负面证据（已查证该源与目标无具体对应），
  // 让判决书的证据栏总是呈现"查了什么、查到什么、没查到什么"。
  const PROBE_SYSTEM =
    'You are a detail comparison officer. Compare a Chinese podcast transcript excerpt against ONE candidate source text. Find the MOST SPECIFIC overlap between them (shared rare case, data combination, idiosyncratic phrasing, argument-chain ordering, or error). QUOTES MUST BE CONTINUOUS PASSAGES, not isolated sentences: targetQuote = a coherent Chinese passage of at least 3 consecutive sentences (>=80 characters) from the transcript; sourceQuote = the corresponding continuous passage from the source (>=2 consecutive sentences). If the strongest overlap is only a single common sentence, a public fact, or mere topic-level similarity, output found=false. Output only JSON: {"found":true|false,"targetQuote":"...","sourceQuote":"...","what":"what specifically overlaps (Chinese, one sentence)","type":"rare_case|data_combo|phrasing|ordering|error|none"}';
  for (const src of rt.sources.slice(0, 3)) {
    if (!src.fullText || src.fullText.length < 400) continue;
    // 已有该源的 E3/E4 证据则跳过（不重复产证）
    if (evidence.some((e) => e.sourceId === src.id && (e.level === 'E3' || e.level === 'E4'))) continue;
    rt.log('对质', `细比对官比对 ${src.id}（${src.title.slice(0, 32)}）…`);
    try {
      const pr = await chatJson<any>(
        rt.provider.chat,
        PROBE_SYSTEM,
        `目标转录稿（节选）：\n${targetSeg}\n\n候选源 ${src.id} 全文：\n${truncateSmart(src.fullText, 16000)}`,
        { maxTokens: 700 },
      );
      const tQuote = String(pr.targetQuote || '');
      const sQuote = String(pr.sourceQuote || '');
      // v2.2.2 引文段落守卫：目标 ≥3 句连续（按句号计）且 ≥80 字，源 ≥2 句——孤句不成证
      const tSents = (tQuote.match(/[。！？!?.]/g) || []).length;
      const sSents = (sQuote.match(/[.!?。！？]/g) || []).length;
      const passageOk = tQuote.length >= 80 && tSents >= 3 && sQuote.length >= 80 && sSents >= 2;
      if (pr.found && tQuote && sQuote && passageOk) {
        const tLoc = locateQuote(tQuote, cf.target.text);
        const sLoc = locateQuote(sQuote, src.fullText);
        evidence.push({
          id: `EV-PROBE-${src.id}`,
          level: 'E3',
          kind: '细节比对',
          description: `细比对发现与 ${src.title.slice(0, 40)} 的具体重合点：${String(pr.what || '')}`,
          targetQuote: tQuote,
          targetQuoteLocated: tLoc,
          sourceQuote: sQuote,
          sourceQuoteLocated: sLoc,
          sourceId: src.id,
          detail: { probe: true, overlapType: pr.type, confidence: 0.8 },
        });
        rt.log('对质', `细比对命中：${src.id}（${pr.type}）→ 交付检定`);
      } else {
        const why = pr.found && !passageOk ? '最接近的重合仅为孤立单句或公共事实，未构成连续段落级对应' : '两者仅在主题层面重合，或重合内容均属公共事实';
        evidence.push({
          id: `EV-NEG-${src.id}`,
          level: 'E1',
          kind: '已查证无对应',
          description: `已将目标转录稿与 ${src.title.slice(0, 44)}（相似度 ${src.similarity ?? '?'}）逐段比对：${why}。`,
          sourceId: src.id,
          detail: { negative: true },
        });
        rt.log('对质', `细比对 ${src.id}：无段落级对应（负面证据入卷）`);
      }
    } catch (e: any) {
      rt.log('对质', `细比对 ${src.id} 失败（${e.message.slice(0, 60)}）`);
    }
  }

  // v2.2.1 证据检定（用户决策：必须区分"独特表达复制"与"事实转述/宏观表达"）：
  // 每条 E3/E2 证据由 LLM 独立检定四分类；非 expression_copy 的 E3 降级为"线索级"不计入定案统计。
  const EXAM_SYSTEM =
    cf.profile?.mediaType === 'fiction'
      ? 'You are an evidence examiner for LITERARY texts distinguishing genuine copying from innocent overlap. Given a target quote (Chinese fiction) and a source quote, classify: expression_copy = the two share SPECIFIC literary formulation unique to the source (same idiosyncratic image, same unusual name/place, same sentence-level phrasing, same narrative detail sequence) - something an independent writer would NOT coincidentally produce; fact_relay = both reference the same public fact/work/allusion in their own words; generic_overlap = both use a common literary trope or theme (reunion, nostalgia, a peach garden as beauty) without specific shared details; inconclusive = cannot tell. Output only JSON: {"verdict":"expression_copy|fact_relay|generic_overlap|inconclusive","note":"one-sentence reason in simplified Chinese"}'
      : 'You are an evidence examiner distinguishing genuine expression copying from innocent overlap. Given a target quote (Chinese podcast transcript) and a source quote, classify: expression_copy = the two share SPECIFIC formulation unique to the source (same rare case detail, same data combination, same idiosyncratic phrasing, same error) - something a person writing independently about the topic would NOT produce; fact_relay = both state the same historical/public fact in their own words (dates, events, textbook knowledge); generic_overlap = both discuss the same theme at a macro level without specific shared details; inconclusive = cannot tell (e.g. source quote too generic or truncated). Output only JSON: {"verdict":"expression_copy|fact_relay|generic_overlap|inconclusive","note":"one-sentence reason in simplified Chinese"}';
  const srcOf = (sid?: string) => rt.sources.find((s) => s.id === sid);
  for (const ev of evidence) {
    if (ev.level !== 'E3' && ev.level !== 'E2') continue; // E4（错误传播）本身就是 expression_copy 铁证，免检
    // v2.2.6：结构类 E2（宏观结构/论证链同构）走定位校验而非引文检定——其可靠性来自
    // 覆盖率阈值（60%）+源摘录逐条定位；引文式检定不适用于结构证据
    if (ev.level === 'E2' && (ev.detail as any)?.macro) {
      const maps = ((ev.detail as any).mappings || []) as any[];
      const src = srcOf(ev.sourceId);
      const locatedN = maps.filter((m) => src && locateQuote(String(m.sourceExcerpt || ''), src.fullText || '')).length;
      if (maps.length && locatedN / maps.length >= 0.5) {
        ev.examVerdict = 'expression_copy';
        ev.examNote = `结构映射 ${maps.length} 项中 ${locatedN} 项源摘录定位通过——主干对应经机械校验`;
      } else {
        ev.detail = { ...(ev.detail as any), demoted: true, demotedFrom: 'E2' };
        ev.examVerdict = 'inconclusive';
        ev.examNote = '结构映射的源摘录定位不足半数，降为线索级';
      }
      continue;
    }
    try {
      const ex = await chatJson<any>(
        rt.provider.chat,
        EXAM_SYSTEM,
        `目标引文（中文转录稿）：\n${ev.targetQuote || '（无）'}\n\n源引文：\n${ev.sourceQuote || '（无）'}\n\n源上下文（节选）：\n${truncateSmart(srcOf(ev.sourceId)?.fullText || '', 2000)}`,
        { maxTokens: 300 },
      );
      const v4 = ['expression_copy', 'fact_relay', 'generic_overlap', 'inconclusive'].includes(ex.verdict) ? ex.verdict : 'inconclusive';
      ev.examVerdict = v4 as any;
      ev.examNote = String(ex.note || '');
      if (ev.level === 'E3' && v4 !== 'expression_copy') {
        ev.detail = { ...(ev.detail || {}), demoted: true, demotedFrom: 'E3' };
        rt.log('对质', `证据检定：${ev.id} 属「${v4 === 'fact_relay' ? '事实转述' : v4 === 'generic_overlap' ? '宏观表达重合' : '无法判定'}」，降为线索级——${ev.examNote.slice(0, 60)}`);
      } else {
        rt.log('对质', `证据检定：${ev.id} 属「${v4 === 'expression_copy' ? '独特表达复制' : v4 === 'fact_relay' ? '事实转述' : v4 === 'generic_overlap' ? '宏观表达重合' : '无法判定'}」——${ev.examNote.slice(0, 60)}`);
      }
    } catch (e: any) {
      ev.examVerdict = 'inconclusive';
      rt.log('对质', `证据检定失败（${e.message.slice(0, 60)}），按无法判定处理`);
    }
  }

  // v2.2 证据按置信度排序：E4 > E3 > E2；同级按源相似度降序
  const simOf = (sid?: string) => rt.sources.find((s) => s.id === sid)?.similarity ?? 0;
  evidence.sort((a, b) => {
    const lv = { E4: 3, E3: 2, E2: 1, E1: 0, E5: 0 } as Record<string, number>;
    const d = (lv[b.level] ?? 0) - (lv[a.level] ?? 0);
    return d !== 0 ? d : simOf(b.sourceId) - simOf(a.sourceId);
  });
  rt.evidence = evidence;
  return evidence;
}

// ---------------------------------------------------------------------------
// 阶段五：宣判
// ---------------------------------------------------------------------------

export async function verdictStage(
  cf: CaseFile,
  rt: CourtRuntime,
  evidence: EvidenceItem[],
  extra?: { secondOpinion?: { provider: ProviderAdapter } },
): Promise<VerdictDoc> {
  // 汇总统计（v2.2.1：检定非 expression_copy 的 E3 不计入定案计数——它们仍展示，但不构成定案依据）
  const effective = (e: EvidenceItem) => e.level === 'E3' && e.detail?.demoted ? false : true;
  const fpHits = evidence.filter((e) => (e.level === 'E3' || e.level === 'E4') && effective(e));
  const distinctFps = new Set(fpHits.map((e) => e.id.split('-')[1])).size;
  const stats = {
    e4: evidence.filter((e) => e.level === 'E4').length,
    e3: evidence.filter((e) => e.level === 'E3' && effective(e)).length,
    e3DistinctFingerprints: distinctFps,
    e2: evidence.some((e) => e.level === 'E2' && effective(e)),
    e1: !!cf.profile && (cf.profile.entities.length > 0 || cf.profile.outline.length > 0),
    e5: evidence.filter((e) => e.level === 'E5').length,
  };
  const v = mapVerdictPublic(stats, cf.attribution, !cf.target.degraded, rt.sources.length > 0);

  rt.log('宣判', `裁决计算完成：${v.word}（${v.rule}）`);

  // 法官意见
  let opinion = '';
  try {
    const op = await chatJson<any>(
      rt.provider.chat,
      VERDICT_OPINION_SYSTEM,
      `裁决词：${v.word}\n触发规则：${v.rule}\n案卷标题：${cf.target.title}\n案情摘要：${cf.profile?.summaryZh || ''}\n证据清单（按说服力排序，写意见时请引用证据序号与内容，不要只说"证据不足"）：\n${evidence.map((e, i) => `证据${i + 1}｜${plainLevelName(e.level)}｜${e.kind}${e.examVerdict ? `｜检定：${({ expression_copy: '独特表达复制', fact_relay: '事实转述（不构成定案依据）', generic_overlap: '宏观表达重合（不构成定案依据）', inconclusive: '无法判定' } as any)[e.examVerdict] || e.examVerdict}` : ''}\n${e.description}\n  目标引文：${e.targetQuote || '（结构类证据，无单条引文）'}\n  源引文：${e.sourceQuote || '（见证据描述）'}${e.sourceQuoteLocated === false ? '（源引文未在源文本中定位，已降级）' : ''}`).join('\n')}\n候选源：${rt.sources.map((s) => `${s.id.replace('SRC', '候选源')} ${s.title}${s.transcribed ? '（已转录全文）' : s.partial ? '(部分取证)' : ''}`).join('；')}\n指纹候选总数：${cf.fingerprints.length}，命中：${distinctFps}\n写意见要求：先概括证据链整体形态（哪些源、什么类型的对应、强度如何），再指出最关键的 1-2 条证据及其引文内容，最后说明证据局限。不要出现 EV-、SRC、FP 等内部代号。`,
      { maxTokens: 1200 },
    );
    opinion = cjkPunctNormalize(String(op.opinion || ''));
  } catch (e: any) {
    opinion = `（法官意见生成失败：${e.message.slice(0, 60)}）`;
  }

  // 复核（可选双模型）
  const crossChecks: { evidenceId: string; risk: string; note: string }[] = [];
  if (extra?.secondOpinion) {
    rt.log('宣判', '第二陪审员交叉复核指纹命中项…');
    for (const ev of fpHits.slice(0, 6)) {
      try {
        const r = await chatJson<any>(
          extra.secondOpinion.provider.chat,
          `你是独立复核员，不参与判级。评估以下指纹证据是巧合的风险（低/中/高），并用一句话说明。只输出 JSON：{"risk":"低|中|高","note":"..."}`,
          `目标引文：${ev.targetQuote}\n源引文：${ev.sourceQuote}\n指纹说明：${ev.description}`,
          { maxTokens: 300 },
        );
        crossChecks.push({ evidenceId: ev.id, risk: String(r.risk || '中'), note: String(r.note || '') });
      } catch {
        /* 复核失败不阻塞判决 */
      }
    }
  }

  return buildVerdictDoc(cf, rt, evidence, v, opinion, crossChecks);
}

// mapVerdict 的公开包装（避免内核层反向依赖流水线）
import { mapVerdict, DISCLAIMER, NAMING_FOOTNOTE, type VerdictResult } from '../court/evidence';
function mapVerdictPublic(
  stats: Parameters<typeof mapVerdict>[0],
  attribution: Parameters<typeof mapVerdict>[1],
  usable: boolean,
  hadCandidates: boolean,
): VerdictResult {
  return mapVerdict(stats, attribution, usable, hadCandidates);
}

export interface VerdictDoc {
  caseFile: CaseFile;
  sources: SourceDoc[];
  evidence: EvidenceItem[];
  verdict: VerdictResult;
  opinion: string;
  crossChecks: { evidenceId: string; risk: string; note: string }[];
  disclaimer: string;
  namingFootnote: string;
  generatedAt: string;
  limits: string[];
}

export function buildVerdictDoc(
  cf: CaseFile,
  rt: CourtRuntime,
  evidence: EvidenceItem[],
  v: VerdictResult,
  opinion: string,
  crossChecks: { evidenceId: string; risk: string; note: string }[],
): VerdictDoc {
  const limits: string[] = [];
  if (cf.target.degraded) limits.push('目标内容取证降级：' + (cf.target.degradeReason || '部分取证'));
  const partialSources = rt.sources.filter((s) => s.partial);
  if (partialSources.length) limits.push(`${partialSources.length} 个候选源仅部分取证（付费墙或抓取失败），比对范围受限`);
  if (partialSources.length === rt.sources.length && rt.sources.length > 0) limits.push('全部候选源均为部分取证，指纹验证强度受限');
  const unlocated = evidence.filter((e) => e.sourceQuote && e.sourceQuoteLocated === false);
  if (unlocated.length) limits.push(`${unlocated.length} 条证据的源引文未能在源文本中定位（防幻觉校验未通过），已降级展示`);
  if (!cf.target.comments) limits.push('未获取到评论区数据，群众线报通道未启用');
  // v2.2.8 检索穷尽性声明（文学/出版物场景尤其重要：受版权保护的内容不在开放网络上）
  if (cf.profile?.mediaType === 'fiction' || cf.profile?.mediaType === 'article') {
    limits.push('检索穷尽性局限：受版权保护的作品正文（纸刊/付费墙/出版社平台）不在开放网络检索范围内——「未发现」仅指公开网络检索范围内未发现，不覆盖未数字化的出版物与需授权访问的内容');
  }
  // v2.2.9 归属链性质声明（用户指出：已发表≠原创——正式发表渠道只做编辑筛选不做原创核查）
  if (cf.attribution === 'complete' && rt.mirrorNotes?.length) {
    limits.push('归属链说明：上方归属信息只证明该内容的发布渠道与署名情况，不构成原创性证明——正式发表渠道（期刊/出版社/作协网站）不做原创性核查，本庭的「卫生」与否只取决于证据本身');
  }
  limits.push(`指纹候选 ${cf.fingerprints.length} 个，检索候选源 ${rt.sources.length} 个（相似度排序，满分 100）；「未发现」不等于「证明清白」`);
  if (rt.rejectedSources?.length) {
    limits.push(`检索淘汰 ${rt.rejectedSources.length} 个候选：${rt.rejectedSources.slice(0, 6).map((r) => `${r.title.slice(0, 24)}（${r.reason}）`).join('；')}${rt.rejectedSources.length > 6 ? ' 等' : ''}`);
  }
  const topSim = rt.sources.filter((s) => typeof s.similarity === 'number').slice(0, 3).map((s) => `${s.id}=${s.similarity}`);
  if (topSim.length) limits.push(`相似度前三：${topSim.join('，')}`);

  // v2.2 出口标点纪律：中文区半角标点归一化为全角（确定性兜底，防 LLM 漏守约束）
  const evidenceN = evidence.map((e) => ({ ...e, description: cjkPunctNormalize(e.description) }));
  const limitsN = limits.map(cjkPunctNormalize);

  return {
    caseFile: cf,
    sources: rt.sources,
    evidence: evidenceN,
    verdict: v,
    opinion: cjkPunctNormalize(opinion),
    crossChecks,
    disclaimer: DISCLAIMER,
    namingFootnote: NAMING_FOOTNOTE,
    generatedAt: new Date().toISOString(),
    limits: limitsN,
  };
}
