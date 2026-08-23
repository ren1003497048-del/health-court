// 流水线编排：开庭五阶段（PRD §5）
// 每个阶段是纯函数：输入案卷/来源，输出更新后的案卷/证据。UI 与无头测试共用同一条路径。

import type { CaseFile, SourceDoc, FingerprintCandidate, CommunityLead, DeclaredCitation } from '../court/types';
import type { EvidenceItem } from '../court/evidence';
import { chatJson } from '../providers/types';
import type { ProviderAdapter, Fetcher } from '../providers/types';
import {
  PROFILE_SYSTEM, FINGERPRINT_SYSTEM, LEADS_SYSTEM, ATTRIBUTION_SYSTEM,
  ALIGN_SYSTEM, FPCHECK_SYSTEM, VERDICT_OPINION_SYSTEM, DISCOVERY_QUERY_SYSTEM,
} from '../court/prompts';
import { locateQuote, truncateSmart, parseJinaMarkdown, normalize } from '../court/textUtils';
import { preReview, extractDate, MIN_TARGET_TEXT_CHARS } from '../court/preReview';
import { stripPageChrome, stripMarkdownMedia, chromeRatio } from '../court/chromeStrip';
import { applyFingerprintDiscipline, isMirrorOrGenericSource } from '../court/fingerprintDiscipline';
import { cjkPunctNormalize } from '../court/textUtils';
import {
  plainLevelName,
  SOURCE_QUALITY_GATE,
  MIN_ADMISSIBLE_EVIDENCE_GROUPS,
  countAdmissibleEvidenceGroups,
  countAccusatoryEvidenceGroups,
  buildSystematicOverlapEvidence,
  isAdmissibleEvidence,
  isFormalControversyReport,
  looksLikeSharedNewsFact,
} from '../court/evidence';

/** 立案门槛（PRD §5.1）：评定对象=相对独立完整的文化内容整体 */
export const MIN_TARGET_CHARS = MIN_TARGET_TEXT_CHARS; // 2026-08-20 用户拍板：文学节选/短篇从宽（原 500）
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
  /** UI 运行期五阶段日志，最终并入庭审记录。 */
  processLog?: StageLog[];
  /** 经主体与报道体例双重过滤的外界指控。 */
  controversyNotes?: { title: string; url: string; snippet?: string }[];
  /** 检索轮次审计；写入判决书，避免“多轮”只有日志没有结构化记录。 */
  searchAudit?: { rounds: number; queries: number; supplementalQueries: number; supplementalSources: number };
  /** v3.5 波次对质登记簿：已过堂源 id（跨波共享，第 3 波增量判定依据） */
  waveExaminedIds?: Set<string>;
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

// v3.3 引用结构提取（书记员职责·立案登记）：确定性脚注解析 + LLM 粒度分类。
// 盲提取原则的另一半：此结果只进 declaredCitations，指纹提取提示词不读它。
export async function extractCitations(cf: CaseFile, rt: CourtRuntime): Promise<DeclaredCitation[]> {
  const text = cf.target.text;
  if (!text || text.length < 60) return []; // 短文本也可能有脚注（v3.3 测试发现 200 过严）
  const out: DeclaredCitation[] = [];
  let n = 0;
  // ① 确定性解析：脚注形态（页脚引用行）——「《书名》，第N页」「同上」「译者注」「参见」
  const fnoteRe = /[《«][^》»]{2,30}[》»][，,]?\s*(?:第\s*[\d–-]+\s*页)?/g;
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li].trim();
    if (l.length < 8 || l.length > 160) continue;
    // 脚注行特征：短行 + 引用词
    if (!/(?:第[\d–-]+页|同上|译者注|参见|译自|改编自|转引自)/.test(l)) continue;
    const m = l.match(fnoteRe);
    if (m) {
      out.push({ id: `CIT${++n}`, source: m[0].slice(0, 60), location: `行${li + 1}`, granularity: 'specific', quote: l.slice(0, 120) });
    }
  }
  // ② 文末泛化承认句：LLM 识别（一次调用，容错跳过）
  try {
    const r = await chatJson<any>(
      rt.provider.chat,
      'Find ACKNOWLEDGMENT-of-reference sentences in the text: sentences that admit consulting/borrowing from other works but WITHOUT specific per-claim footnotes (e.g. 「……均为译者提供了参考」「本文参考了……」「受……启发」). Return each as {"source":"被承认的来源","quote":"整句","location":"大致位置"}. Only sentences that acknowledge EXTERNAL works/persons as sources of ideas or text. Output only JSON: {"general":[{"source":"","quote":"","location":""}]}',
      text.slice(-6000),
      { maxTokens: 600 },
    );
    for (const g of (r.general || []).slice(0, 6)) {
      if (!g?.quote || !g?.source) continue;
      out.push({ id: `CIT${++n}`, source: String(g.source).slice(0, 60), location: String(g.location || '文末').slice(0, 30), granularity: 'general', quote: String(g.quote).slice(0, 160) });
    }
  } catch { /* LLM 失败只保留确定性解析结果 */ }
  rt.log('立案', `引用结构提取：${out.filter((c) => c.granularity === 'specific').length} 条具体标注 + ${out.filter((c) => c.granularity === 'general').length} 条泛化承认`);
  return out;
}

export async function investigation(cf: CaseFile, rt: CourtRuntime, opts?: InvestigateOptions): Promise<CaseFile> {
  const text = truncateSmart(cf.target.text, 14000);

  // v3.3 书记员·引用结构登记（立案材料的一部分；指纹官不读此字段——盲提取）
  try {
    cf.declaredCitations = await extractCitations(cf, rt);
  } catch {
    cf.declaredCitations = [];
  }

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
      quote: String(f.targetQuote || ''),
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
      quote: s.targetQuote,
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

/** 只接受完整命中或正文内唯一长片段命中，避免相同句首把引文错移到更早段落。 */
function locateExactOrUniqueAnchor(quote: string, text: string): number {
  if (!quote || !text) return -1;
  const exact = text.indexOf(quote);
  if (exact >= 0) return exact;
  const anchors = quote
    .split(/(?<=[。！？.!?])\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 28)
    .sort((a, b) => b.length - a.length);
  for (const anchor of anchors) {
    const index = text.indexOf(anchor);
    if (index >= 0 && index === text.lastIndexOf(anchor)) return index;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 阶段三：检索
// ---------------------------------------------------------------------------

export async function discovery(cf: CaseFile, rt: CourtRuntime, opts?: { maxSources?: number }): Promise<CaseFile> {
  // v2.2：三轮足量检索（R0标题英文化 + R1主题 + R2指纹精确 + R3线报），目标 ≥8 候选源
  const maxSources = opts?.maxSources ?? 14;
  rt.searchAudit = { rounds: 1, queries: 0, supplementalQueries: 0, supplementalSources: 0 };
  // v2.2.12（ODCX8E 休庭案根因）：检索式生成必须容错——LLM 单点失败不能导致全案零检索。
  // 失败时用确定性回退：画像英文实体 + 指纹英文检索词直查。
  let q: any = { queries: {} };
  try {
    q = await chatJson<any>(
      rt.provider.chat,
      DISCOVERY_QUERY_SYSTEM,
      `案情画像：${JSON.stringify({
        topicDomain: cf.profile?.topicDomain,
        coreClaims: cf.profile?.coreClaims,
        entities: cf.profile?.entities,
        outline: cf.profile?.outline,
      }, null, 0)}\n\n指纹候选（id/类型/英文检索词）：${cf.fingerprints.map((f) => `${f.id} ${f.type} [${f.searchKeywordsEn.join('; ')}]`).join('\n')}\n\n群众线报：${cf.leads.map((l) => `${l.id} ${l.searchKeywordsEn.join('; ')}`).join('\n') || '无'}`,
    );
  } catch (e: any) {
    rt.log('检索', `检索式生成失败（${String(e?.message || e).slice(0, 60)}）——改用确定性回退检索式`);
    const enEnts = (cf.profile?.entities || []).filter((x) => /[A-Za-z]{4,}/.test(x)).slice(0, 3).join(' ');
    const fpEns = cf.fingerprints.flatMap((f) => f.searchKeywordsEn).filter(Boolean).slice(0, 4);
    q = {
      queries: {
        topic: enEnts ? [`${enEnts} podcast`] : [],
        fingerprint: fpEns.map((kw) => ({ fingerprintId: 'AUTO', query: kw })),
        leads: [],
      },
    };
  }

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
  // R6 争议检索轮（v2.2.9，H6RNXM 案教训）：作品名+作者+抄袭/洗稿/争议/举报——
  // 公开舆论中的指控报道往往直接列出被抄原作与对照段落（如 8·4 孙频事件报道列出余秀华原诗）。
  // 线报不再只依赖目标页评论区——评论区的覆盖率远低于公开报道。
  {
    const author = cf.target.author || (cf.profile?.entities || [])[0] || '';
    const workName = (cf.target.title || '').replace(/[《》"「」]/g, '').split(/[-—|]/)[0].trim();
    if (author && workName && workName.length >= 2) {
      const q1 = `${author} ${workName} 抄袭`;
      const q2 = `${workName} 洗稿 OR 争议 OR 举报`;
      queries.push({ tag: 'R6 争议', q: q1 }, { tag: 'R6 争议', q: q2 });
      rt.log('检索', `R6 争议检索式 ×2：${q1} ｜ ${q2}`);
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
  rt.searchAudit.queries = queries.length;

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

  // —— v2.2.9 R6 争议报道单列（不参与对质——报道不是被抄对象，但作为外界指控呈堂）——
  const controversyNotes: { title: string; url: string; snippet?: string }[] = [];
  const controversyCandidates = candidates.filter((c) => c.via.startsWith('R6'));
  for (const c of controversyCandidates) {
    if (isFormalControversyReport(c.doc, { title: cf.target.title, author: cf.target.author })) {
      controversyNotes.push({ title: c.doc.title.slice(0, 120), url: c.doc.url, snippet: (c.doc.snippet || '').slice(0, 220) });
    } else {
      rejected.push({ title: c.doc.title, reason: 'R6 非正式报道或与被检主体无直接关系' });
    }
  }
  if (controversyNotes.length) {
    rt.log('检索', `R6 发现公开抄袭指控报道 ${controversyNotes.length} 篇——转入「外界指控」栏呈堂`);
    rt.controversyNotes = controversyNotes;
  }

  // —— 源卫生 + 质量闸门（确定性过滤，全部记录淘汰原因）——
  const targetDate = cf.target.date ? Date.parse(cf.target.date) : NaN;
  const filtered: { doc: { title: string; url: string; snippet: string; date?: string }; via: string }[] = [];
  for (const c of candidates) {
    if (c.via.startsWith('R6')) continue; // 争议报道不入对质池（单列呈堂）
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
  const pool = filtered.slice(0, 40);
  const scored: typeof filtered & { sim?: number; why?: string }[] = filtered.slice(0, 0);
  let rankList: { idx: number; sim: number; why: string; relation: SourceDoc['subjectRelation'] }[] = [];
  if (pool.length) {
    rt.log('检索', '书记员对候选源做主题相似度评分与排序…');
    try {
      const rk = await chatJson<any>(
        rt.provider.chat,
        'You rank candidate sources for source-dependency examination. Separate SUBJECT IDENTITY from topic similarity. relation must be direct_source (the candidate is plausibly a source for the target\'s concrete claims/examples), same_event (independent coverage of the same recent public event), same_topic (broadly related but not the same work/episode or a concrete source), unrelated, or unknown. Same-topic pages must never receive direct_source merely because names or themes overlap. Similarity 0-100 is retrieval relevance only, never evidence strength. Output only JSON: {"ranked":[{"idx":0,"sim":85,"relation":"direct_source|same_event|same_topic|unrelated|unknown","why":"short reason"}]}. Rank ALL candidates.',
        `被检标题：${cf.target.title}\n被检作者/节目：${cf.target.author || ''}\n目标画像：主题域=${cf.profile?.topicDomain || ''}\n核心论点：${(cf.profile?.coreClaims || []).slice(0, 5).join('；')}\n实体：${(cf.profile?.entities || []).slice(0, 12).join('；')}\n摘要：${cf.profile?.summaryZh || ''}\n\n候选源列表：\n${pool.map((c, i) => `${i}. ${c.doc.title} | ${String(c.doc.snippet || '').slice(0, 160).replace(/\n/g, ' ')}`).join('\n')}`,
        { maxTokens: 3000 },
      );
      rankList = ((rk.ranked || []) as any[]).map((r) => ({
        idx: +r.idx,
        sim: Math.max(0, Math.min(100, +r.sim || 0)),
        why: String(r.why || ''),
        relation: (['direct_source', 'same_event', 'same_topic', 'unrelated', 'unknown'].includes(r.relation) ? r.relation : 'unknown') as SourceDoc['subjectRelation'],
      })).filter((r) => r.idx >= 0 && r.idx < pool.length);
      rt.log('检索', `评分完成：${rankList.length}/${pool.length} 个候选获分`);
    } catch (e: any) {
      rt.log('检索', `相似度评分失败（${e.message.slice(0, 60)}），按检索顺序入卷`);
    }
  }
  // 按相似度降序（无分者排后，保持原序）
  const simMap = new Map(rankList.map((r) => [r.idx, r]));
  const ordered = pool
    .map((c, i) => ({ c, r: simMap.get(i) }))
    .sort((a, b) => (b.r?.sim ?? -1) - (a.r?.sim ?? -1))
    .filter(({ c, r }) => {
      if (r?.relation === 'same_topic' || r?.relation === 'unrelated') {
        rejected.push({ title: c.doc.title, reason: r.relation === 'same_topic' ? '仅同题材，非被检主体或直接来源' : '与被检主体无直接关系' });
        return false;
      }
      return true;
    });

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
      fullText = stripPageChrome(fd.text);
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
      subjectRelation: r?.relation || 'unknown',
      subjectRelationNote: r?.why,
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
  await verifySourceRelations(cf, rt, fetched);
  rt.sources = fetched;
  rt.rejectedSources = rejected;
  return cf;
}

/**
 * 对高相似候选做第二次主体关系核验。检索相关性不是证据强度；晚于目标的页面
 * 直接转为“同一公共事件”，其余候选必须用正文摘要再次判断是否可能是具体来源。
 */
async function verifySourceRelations(cf: CaseFile, rt: CourtRuntime, sources: SourceDoc[]): Promise<void> {
  const targetDate = cf.target.date ? Date.parse(cf.target.date) : NaN;
  for (const source of sources) {
    const sourceDate = source.date ? Date.parse(source.date) : NaN;
    source.reversed = source.reversed || (!Number.isNaN(targetDate) && !Number.isNaN(sourceDate) && sourceDate > targetDate);
    if (source.reversed) {
      source.subjectRelation = 'same_event';
      source.subjectRelationNote = '候选页发布日期晚于被检内容，只能作为同一事件的后续报道。';
    }
  }
  const candidates = sources
    .filter((source) => !source.reversed)
    .filter((source) => (source.similarity ?? 0) >= 70 || !source.subjectRelation || source.subjectRelation === 'unknown' || source.subjectRelation === 'direct_source')
    .slice(0, 14);
  if (!candidates.length) return;
  rt.log('检索', `主体关系二次核验：复查 ${candidates.length} 个高相关候选，区分直接来源、同一事件与同题材料…`);
  try {
    const result = await chatJson<any>(
      rt.provider.chat,
      'You perform a SECOND-PASS source-relationship verification. A high retrieval score is not evidence. Classify each candidate as direct_source only when its dated content predates the target and contains concrete claims, examples, ordering, or wording that the target could plausibly reuse. same_event means independent reporting of the same recent public event; same_topic means only thematic overlap; unrelated means wrong subject; unknown means the available text cannot establish identity. Output every idx as JSON: {"checked":[{"idx":0,"relation":"direct_source|same_event|same_topic|unrelated|unknown","note":"short Chinese reason"}]}.',
      `被检内容：${cf.target.title}\n发布日期：${cf.target.date || '未知'}\n节目/作者：${cf.target.author || '未知'}\n核心论点：${(cf.profile?.coreClaims || []).slice(0, 6).join('；')}\n\n待复核候选：\n${candidates.map((source, index) => `${index}. 标题=${source.title}\n日期=${source.date || '未知'}\n初判=${source.subjectRelation || 'unknown'}；检索分=${source.similarity ?? '无'}\n材料=${truncateSmart(source.fullText || source.snippet || '', 1400)}`).join('\n\n')}`,
      { maxTokens: 2400 },
    );
    const checked = Array.isArray(result.checked) ? result.checked : [];
    const resolved = new Set<number>();
    for (const item of checked) {
      const index = Number(item.idx);
      const source = candidates[index];
      if (!source) continue;
      resolved.add(index);
      const relation = String(item.relation || 'unknown');
      source.subjectRelation = (['direct_source', 'same_event', 'same_topic', 'unrelated', 'unknown'].includes(relation) ? relation : 'unknown') as SourceDoc['subjectRelation'];
      source.subjectRelationNote = `二次核验：${String(item.note || '').slice(0, 180)}`;
    }
    candidates.forEach((source, index) => {
      if (resolved.has(index)) return;
      source.subjectRelation = 'unknown';
      source.subjectRelationNote = '二次核验未返回该候选，保守标为关系待核。';
    });
  } catch (error: any) {
    for (const source of candidates) {
      if (source.subjectRelation === 'direct_source') source.subjectRelation = 'unknown';
      source.subjectRelationNote = `二次核验未完成：${String(error?.message || error).slice(0, 100)}`;
    }
    rt.log('检索', '主体关系二次核验失败：高相关候选保守标为关系待核，不进入正式证据。');
  }
}

/** 当首轮已有具体相似线索但正式证据不足时，至多追加一轮证据导向检索。
 *  v3.5 波次纪律：正面证据已达立案门槛（≥2 组）即不再补源——提前终止优先于扩张。
 *  v3.5.1（UOF5I9 修正）：门槛判定改用正面证据组——负面查证（已查证无对应）不构成
 *  「证据已足」的理由：恰恰相反，查而无对应说明该波白查，更应扩张或补源。 */
export function shouldSupplementEvidence(evidence: EvidenceItem[], sources: SourceDoc[]): boolean {
  if (sources.length >= 22) return false;
  const underThreshold = countAccusatoryEvidenceGroups(evidence) < MIN_ADMISSIBLE_EVIDENCE_GROUPS;
  if (!underThreshold) return false; // 正面证据已凑足立案门槛——尊重波次提前终止，不再扩张
  const hasConcreteClue = evidence.some((item) => item.level === 'E2' || item.level === 'E3' || item.level === 'E4');
  const hasHighSimilarityCandidate = sources.some((source) => (source.similarity ?? 0) >= 75);
  const hasNegativeFindings = evidence.some((item) => item.level === 'E1' && (item.detail as any)?.negative);
  return hasHighSimilarityCandidate || hasConcreteClue || hasNegativeFindings;
}

export async function supplementalDiscovery(
  cf: CaseFile,
  rt: CourtRuntime,
  evidence: EvidenceItem[],
  opts?: { maxQueries?: number; maxSources?: number },
): Promise<number> {
  const maxQueries = opts?.maxQueries ?? 12;
  const maxSources = opts?.maxSources ?? 8;
  const admitted = countAdmissibleEvidenceGroups(evidence);
  rt.log('检索', `首轮正式证据 ${admitted}/${MIN_ADMISSIBLE_EVIDENCE_GROUPS} 组；存在具体相似线索，启动一次补充取证。`);

  const fallbackQueries: string[] = [];
  for (const fingerprint of cf.fingerprints.slice(0, 8)) {
    const exact = fingerprint.targetQuote.replace(/\s+/g, ' ').trim();
    if (exact.length >= 18) fallbackQueries.push(`"${exact.slice(Math.floor(exact.length * 0.15), Math.floor(exact.length * 0.15) + 34)}"`);
    const keywords = [...fingerprint.searchKeywordsEn, ...fingerprint.searchKeywordsZh].filter(Boolean).slice(0, 3).join(' ');
    if (keywords.length >= 8) fallbackQueries.push(`${keywords} transcript source`);
  }
  let generatedQueries: string[] = [];
  try {
    const generated = await chatJson<any>(
      rt.provider.chat,
      'Generate 6-12 EVIDENCE-GUIDED follow-up web searches after an inconclusive source check. Seek an earlier original episode/article/book/transcript, not more generic coverage of the topic. Use distinctive phrases, named example combinations, episode titles, and publication/transcript intent terms. Queries may be Chinese or English as appropriate. Avoid duplicating the listed prior queries. Output JSON only: {"queries":["..."]}.',
      `被检标题：${cf.target.title}\n日期：${cf.target.date || '未知'}\n尚未充分验证的具体线索：\n${evidence.filter((item) => item.level !== 'E1').slice(0, 8).map((item) => `${item.plainTitle || item.kind}：${item.description}\n目标句：${(item.detail as any)?.hitPhraseTarget || item.targetQuote || ''}`).join('\n')}\n\n已有高相关候选：\n${rt.sources.filter((source) => (source.similarity ?? 0) >= 70).slice(0, 8).map((source) => `${source.title}｜${source.date || '日期未知'}｜${source.subjectRelation || 'unknown'}`).join('\n')}\n\n原检索式：${rt.sources.map((source) => source.viaQuery).filter(Boolean).slice(0, 18).join('；')}`,
      { maxTokens: 900 },
    );
    generatedQueries = (Array.isArray(generated.queries) ? generated.queries : []).map(String);
  } catch {
    rt.log('检索', '补充检索式生成失败，改用指纹逐条精确检索。');
  }
  const previousQueries = new Set(rt.sources.map((source) => String(source.viaQuery || '').replace(/^.*?：/, '').trim()).filter(Boolean));
  const queries = [...generatedQueries, ...fallbackQueries]
    .map((query) => query.trim())
    .filter((query) => query.length >= 8 && !previousQueries.has(query))
    .filter((query, index, list) => list.indexOf(query) === index)
    .slice(0, maxQueries);
  if (!queries.length) return 0;
  if (!rt.searchAudit) rt.searchAudit = { rounds: 1, queries: 0, supplementalQueries: 0, supplementalSources: 0 };
  rt.searchAudit.rounds = 2;
  rt.searchAudit.queries += queries.length;
  rt.searchAudit.supplementalQueries = queries.length;

  const knownUrls = new Set(rt.sources.map((source) => source.url));
  const candidates: Array<{ title: string; url: string; snippet: string; date?: string; query: string }> = [];
  for (const query of queries) {
    try {
      const { docs } = await rt.provider.search(query);
      rt.log('检索', `[补充取证] "${query.slice(0, 54)}" → ${docs.length} 条`);
      for (const doc of docs) {
        if (!doc.url || knownUrls.has(doc.url) || candidates.some((item) => item.url === doc.url)) continue;
        const hygiene = isMirrorOrGenericSource(
          { title: doc.title, url: doc.url, snippet: doc.snippet },
          { title: cf.target.title, url: cf.input.url, author: cf.target.author },
        );
        if (hygiene.generic || hygiene.mirror) continue;
        candidates.push({ title: doc.title, url: doc.url, snippet: doc.snippet, date: doc.date, query });
      }
    } catch (error: any) {
      rt.log('检索', `[补充取证] 检索失败：${String(error?.message || error).slice(0, 80)}`);
    }
  }
  if (!candidates.length) {
    rt.log('检索', '补充取证未发现新的可访问候选源。');
    return 0;
  }

  let ranked = candidates.slice(0, 36).map((candidate, index) => ({ candidate, index, sim: 0 }));
  try {
    const result = await chatJson<any>(
      rt.provider.chat,
      'Rank follow-up candidates for concrete source-dependency verification. sim is retrieval relevance only. Prefer candidates with a specific episode/work/transcript identity and concrete examples; penalize generic same-event news. Output JSON only: {"ranked":[{"idx":0,"sim":0-100}]}.',
      `目标：${cf.target.title}\n核心论点：${(cf.profile?.coreClaims || []).slice(0, 5).join('；')}\n候选：\n${ranked.map(({ candidate, index }) => `${index}. ${candidate.title}｜${candidate.date || '日期未知'}｜${candidate.snippet.slice(0, 180)}`).join('\n')}`,
      { maxTokens: 1500 },
    );
    const scores = new Map<number, number>(
      (Array.isArray(result.ranked) ? result.ranked : []).map((item: any): [number, number] => [
        Number(item.idx),
        Math.max(0, Math.min(100, Number(item.sim) || 0)),
      ]),
    );
    ranked = ranked.map((item) => ({ ...item, sim: scores.get(item.index) || 0 })).sort((a, b) => b.sim - a.sim);
  } catch { /* 保持检索顺序 */ }

  const targetDate = cf.target.date ? Date.parse(cf.target.date) : NaN;
  const added: SourceDoc[] = [];
  for (const { candidate, sim } of ranked.slice(0, maxSources + 5)) {
    if (added.length >= maxSources) break;
    let fullText = '';
    let title = candidate.title;
    try {
      const fetched = await rt.fetcher.fetchDoc(candidate.url);
      fullText = stripPageChrome(fetched.text);
      title = fetched.title || title;
    } catch { /* 摘要仍可参与主体复核，但不会产出引文证据 */ }
    if (fullText && fullText.length < SOURCE_QUALITY_GATE.minTextChars) continue;
    if (/try searching|no results|page not found|not found|404/i.test(title)) continue;
    const sourceDate = candidate.date ? Date.parse(candidate.date) : NaN;
    added.push({
      id: `SRC${rt.sources.length + added.length + 1}`,
      title,
      url: candidate.url,
      date: candidate.date,
      snippet: candidate.snippet,
      fullText,
      fetchedAt: new Date().toISOString(),
      partial: fullText.length < 800,
      reversed: !Number.isNaN(targetDate) && !Number.isNaN(sourceDate) && sourceDate > targetDate,
      origin: 'search',
      viaQuery: `R7 补充取证：${candidate.query}`,
      similarity: sim || undefined,
      subjectRelation: 'unknown',
    });
  }
  if (!added.length) return 0;
  await verifySourceRelations(cf, rt, added);
  rt.sources.push(...added);
  rt.searchAudit.supplementalSources = added.length;
  rt.log('检索', `补充取证完成：新增 ${added.length} 个候选源，回到对质阶段复核全部材料。`);
  return added.length;
}

// ---------------------------------------------------------------------------
// 阶段四：对质
// ---------------------------------------------------------------------------

export async function crossExamination(
  cf: CaseFile,
  rt: CourtRuntime,
  opts?: { sourceFilter?: (src: SourceDoc) => boolean },
): Promise<EvidenceItem[]> {
  const priorEvidence = opts?.sourceFilter ? rt.evidence.slice() : [];
  const evidence: EvidenceItem[] = priorEvidence;
  const inScope = (src: SourceDoc) => !opts?.sourceFilter || opts.sourceFilter(src);
  const scopedSources = rt.sources.filter(inScope);
  if (rt.sources.length === 0) {
    rt.log('对质', '无候选源可对质');
    return evidence;
  }

  // 4.1 结构对齐（v2.2：对 top 4 源做——相似度排序后的前四）
  const targetSeg = truncateSmart(cf.target.text, 12000);
  for (const src of rt.sources.slice(0, 4)) {
    if (!inScope(src)) continue; // v3.5 波次：只对新增/指定源重跑结构对齐
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
  for (const src of scopedSources) {
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
    // v2.2.10（89YX6D 案用户拍板）：宏观结构证据只对【已转录源】产出——
    // 通史/百科源覆盖大纲是常识性主题映射（KKK 定义/三次崛起在任何 KKK 百科都"实质对应"），
    // 不构成"集中接触痕迹"的信息量；未转录源只做注记。
    const macroPool = rt.sources.filter((s) => inScope(s) && s.transcribed).slice(0, 4);
    const silentChecked = rt.sources.filter((s) => inScope(s) && !s.transcribed && (s.fullText || '').length >= 800);
    if (silentChecked.length) {
      rt.log('对质', `宏观结构：${silentChecked.length} 个未转录源（通史/百科类）仅注记已比对，不产出结构证据（主题级覆盖不构成接触痕迹）`);
    }
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

  // 4.2 指纹验证（对全部源，v2.2.10 分段化：长源逐段送检，不再截断丢内容）
  const fpsCtx = cf.fingerprints
    .map((f) => `【${f.id}】type=${f.type} priority=${f.priority}\n引文：${f.targetQuote}\n说明：${f.note || ''}`)
    .join('\n');

  // 分段策略：源全文 >24K 时按 12K 分段（滑窗 1K 防边界切断引文），每段独立送检
  const SRC_SEG = 12000;
  const segmentsOf = (s: SourceDoc): { label: string; text: string }[] => {
    const ft = s.fullText || '';
    if (!ft) return [{ label: s.id, text: '(无全文，仅有摘要：' + (s.snippet || '') + ')' }];
    if (ft.length <= SRC_SEG * 2) return [{ label: s.id, text: truncateSmart(ft, 12000) }];
    const segs: { label: string; text: string }[] = [];
    for (let i = 0, si = 1; i < ft.length && si <= 6; i += SRC_SEG - 1000, si++) {
      segs.push({ label: `${s.id}#${si}`, text: ft.slice(i, i + SRC_SEG) });
    }
    return segs;
  };

  rt.log('对质', `指纹验证官开始验证 ${cf.fingerprints.length} 个指纹 × ${scopedSources.length} 个源（长源分段送检）…`);
  // v3.5 优化①（波次同批已批）：指纹验证领域预筛——每源一次廉价调用先问「领域重合度
  // + 是否含数据/案例材料」，通史/百科类低分源跳过逐段指纹验证（78 次盲扫 → 15-20 次）。
  const PRESCREEN_SYSTEM =
    'You pre-screen ONE candidate source for fingerprint verification. Given the target topic and fingerprint keywords, judge: domain = does the source discuss the SAME specific subject/narrative territory as the target (not just the broad era or field); specificity = does it contain concrete data, named cases, or archival material (not encyclopedic overview). Output only JSON: {"domain":"on|adjacent|off","specificity":"concrete|overview","score":0-100,"note":"one short Chinese phrase"}. score combines both: an encyclopedic overview of the right era is low; a concrete piece on the same subject is high.';
  const fpVerifiedSources: SourceDoc[] = [];
  for (const s of scopedSources) {
    const hay = `${s.title || ''}\n${(s.fullText || s.snippet || '').slice(0, 3000)}`;
    const kwLine = (cf.fingerprints || []).flatMap((f) => f.searchKeywordsEn || []).slice(0, 8).join(', ');
    let pass = true;
    let note = '';
    try {
      const pre = await chatJson<any>(
        rt.provider.chat,
        PRESCREEN_SYSTEM,
        `目标主题：${cf.profile?.topicDomain || cf.target.title}\n指纹关键词：${kwLine || '（无）'}\n\n候选源 ${s.id}：${hay.slice(0, 3200)}`,
        { maxTokens: 200 },
      );
      const score = Math.max(0, Math.min(100, +pre.score || 0));
      pass = score >= 40;
      note = String(pre.note || '');
    } catch {
      pass = true; // 预筛失败不拦截（宁多扫不漏扫）
      note = '预筛调用失败，保守放行';
    }
    if (pass) {
      fpVerifiedSources.push(s);
    } else {
      rt.log('对质', `指纹预筛：${s.id}（${s.title.slice(0, 30)}）领域重合度低（${note}），跳过指纹验证——通史/百科类源不含目标的具体材料`);
    }
  }
  const allResults: any[] = [];
  for (const s of fpVerifiedSources) {
    const segs = segmentsOf(s);
    for (const seg of segs) {
      try {
        const fpSeg = await chatJson<any>(
          rt.provider.chat,
          FPCHECK_SYSTEM,
          `指纹候选：\n${fpsCtx}\n\n候选源文本（${seg.label}，可为空段）：\n${seg.text}`,
          { maxTokens: 4096 },
        );
        for (const r of (fpSeg.results || []) as any[]) {
          if (r && r.hit) allResults.push({ ...r, sourceId: seg.label.split('#')[0] });
        }
      } catch { /* 单段失败不阻塞 */ }
    }
  }
  const fpRes = { results: allResults };

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
    if (!inScope(src)) continue; // v3.5 波次：细比对只对新增/指定源
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
      // v2.2.12（用户拍板）：长度不作硬卡点——≥30字且≥2句即可成证（原80字/3句拦掉了
      // 短而致命的对应，如单句数据组合）；证据链完整性交给检定与复核环节综合判断
      const passageOk = tQuote.length >= 30 && tSents >= 2 && sQuote.length >= 40 && sSents >= 2;
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
      : 'You are an evidence examiner distinguishing genuine expression copying from innocent overlap. Given a target quote (Chinese podcast transcript) and a source quote, classify: expression_copy = the two share SPECIFIC formulation unique to the source (same rare case detail, same data combination, same idiosyncratic phrasing, same error) - something a person writing independently about the topic would NOT produce; fact_relay = both state the same historical/public fact in their own words (dates, events, textbook knowledge); generic_overlap = both discuss the same theme at a macro level without specific shared details; inconclusive = cannot tell. NEWS DISCIPLINE: when target and source cover the same recent public event, shared date, person, event/document name, official quote or headline fact MUST be fact_relay unless they also share uncommon prose, a non-public detail combination, or the same error. Multiple independent news reports repeating the elements is evidence of publicness, not expression copying. Output only JSON: {"verdict":"expression_copy|fact_relay|generic_overlap|inconclusive","note":"one-sentence reason in simplified Chinese"} ARCHIVAL DISCIPLINE: archival or niche primary-source details (a specific 1868 newspaper incitement, a named obscure figure\'s anecdote, a specific statistic combination like 142 incidents / 31 killings / 43 shootings tied to a particular time/place) are NOT public textbook facts - relaying the same archival detail combination in the same context IS expression_copy, because an independent writer would not surface the same archival item. Rule of thumb: if the shared material would require reading THIS source (or its chain) to reproduce, classify expression_copy.';
  const srcOf = (sid?: string) => rt.sources.find((s) => s.id === sid);
  for (const ev of evidence) {
    if (ev.level !== 'E3' && ev.level !== 'E2') continue; // E4（错误传播）本身就是 expression_copy 铁证，免检
    if (ev.examVerdict) continue; // v3.5 增量对质：已检定过的旧证据不重复检定
    // v2.2.6：结构类 E2（宏观结构/论证链同构）走定位校验而非引文检定——其可靠性来自
    // 覆盖率阈值（60%）+源摘录逐条定位；引文式检定不适用于结构证据
    // v3.4（UW31GR 案）：论证链同构类 E2（非 macro、链环节≥3、置信≥0.85）同样免引文检定——
    // 结构证据没有 targetQuote 是常态而非缺陷，因"引文为空"判 inconclusive 是锂杀
    // （本案两条六环节 0.93/0.92 置信的链条同构证据即被此误杀）
    if (ev.level === 'E2' && !(ev.detail as any)?.macro) {
      const stepM = String(ev.description || '').match(/(\d+)\s*个环节/);
      const confM = String(ev.description || '').match(/置信\s*([\d.]+)/);
      const chainSteps = (ev.detail as any)?.chainSteps ?? (stepM ? parseInt(stepM[1]) : 0);
      const conf = Number((ev.detail as any)?.confidence ?? (confM ? parseFloat(confM[1]) : 0));
      if (chainSteps >= 3 && conf >= 0.85) {
        ev.examVerdict = 'expression_copy';
        ev.examNote = `论证链 ${chainSteps} 环节同序对应（置信 ${conf}）——结构同构经链级校验，引文式检定不适用`;
      } else {
        ev.detail = { ...(ev.detail as any), demoted: true, demotedFrom: 'E2' };
        ev.examVerdict = 'inconclusive';
        ev.examNote = `论证链环节 ${chainSteps} 或置信 ${conf} 不足，降为线索级`;
      }
      continue;
    }
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

  // v2.2.11 转述生成（仿 podcastreview 社区形态）：每条 E3/E4 证据产人话标题+第三人称转述对。
  // 标题词表：相同差错/相同数字组合/相似冷门案例/相似例证组合/相似句式/相似叙事段/相似结尾/叙述主体变化…
  const PARA_SYSTEM =
    'You rewrite one piece of plagiarism evidence for a general reader, in the style of a community evidence page. Given the target quote and source quote, output: plainTitle = a 4-10 char Chinese noun phrase naming the KIND of correspondence using plain adjectives (相同差错 / 相同数字组合 / 相似冷门案例 / 相似例证组合 / 相似句式 / 相似叙事顺序 / 相似结尾 / 相似第一人称叙述 / 叙述主体变化 / 相似类比 ...), e.g. 相同年份差错; sourceParaphrase = ONE sentence in third person describing what the SOURCE says, embedding short key quotes (e.g. 原播客把…说成…); targetParaphrase = ONE sentence in third person describing what the TARGET says at the corresponding position (e.g. 节目说"…"，随后…). Neutral tone, no E-levels, no jargon. Output only JSON: {"plainTitle":"...","sourceParaphrase":"...","targetParaphrase":"..."}';
  for (const ev of evidence) {
    if (ev.level !== 'E3' && ev.level !== 'E4') continue;
    if (!ev.targetQuote || !ev.sourceQuote) continue;
    if (ev.plainTitle) continue; // v3.5 增量对质：已有转述的旧证据不重复生成
    try {
      const pa = await chatJson<any>(
        rt.provider.chat,
        PARA_SYSTEM,
        `目标引文（被检内容）：\n${ev.targetQuote}\n\n源引文（${ev.sourceTitle || ev.sourceId || '候选源'}）：\n${ev.sourceQuote}\n\n证据类型：${ev.kind}${(ev.detail as any)?.transcriptionError ? '（含错误传播）' : ''}`,
        { maxTokens: 400 },
      );
      if (pa.plainTitle) ev.plainTitle = String(pa.plainTitle).slice(0, 12);
      if (pa.sourceParaphrase) ev.sourceParaphrase = String(pa.sourceParaphrase);
      if (pa.targetParaphrase) ev.targetParaphrase = String(pa.targetParaphrase);
    } catch { /* 转述失败保留原引文呈现 */ }
  }

  // v3.3 证据官·引用状态三分类（明质证阶段——此时才读 declaredCitations）：
  // ①未声明→正常证据 ②具体标注（引文对应处有声明）→转注记不计抄袭证据
  // ③泛化承认未具体标注→保留证据但降格「引用不规范」线索
  {
    const cits = cf.declaredCitations || [];
    if (cits.length) {
      for (const ev of evidence) {
        if (ev.level !== 'E3' && ev.level !== 'E4') continue;
        if ((ev.detail as any)?.citationState) continue; // v3.5 增量：已标注引用状态的旧证据跳过
        const srcDoc = rt.sources.find((x) => x.id === ev.sourceId);
        const srcTitle = (srcDoc?.title || '').slice(0, 30);
        // 匹配：声明来源与证据源标题/URL 的词面交集（中文书名或英文名匹配）
                const matched = cits.find((c) => {
          // v3.3.2 匹配：①CJK连续段命中 ②CJK字符集重叠≥85%（≥2字） ③拉丁词≥4字母命中
          const cjkSegs = (s: string) => (s.match(/[\u4e00-\u9fff]{2,}/g) || []);
          const latSegs = (s: string) => (s.match(/[A-Za-z]{4,}/g) || []);
          const charsOf = (s: string) => new Set((s.match(/[\u4e00-\u9fff]/g) || []));
          const cs = c.source, et = `${srcTitle} ${ev.sourceUrl || ''}`;
          if (cjkSegs(cs).some((seg) => seg.length >= 2 && et.includes(seg))) return true;
          if (latSegs(cs).some((seg) => et.toLowerCase().includes(seg.toLowerCase()))) return true;
          const a = charsOf(cs), b = charsOf(et);
          if (a.size >= 2) {
            const inter = [...a].filter((ch) => b.has(ch)).length;
            if (inter >= 2 && inter >= Math.ceil(a.size * 0.85)) return true;
          }
          return false;
        });        if (matched) {
          if (matched.granularity === 'specific') {
            (ev.detail as any) = { ...(ev.detail || {}), citationState: 'declared_specific', citationRef: matched.id };
            ev.description = `${ev.description}（该对应处已有具体引用标注 ${matched.source}——不计入抄袭证据）`;
            (ev.detail as any).demoted = true;
          } else {
            (ev.detail as any) = { ...(ev.detail || {}), citationState: 'declared_general', citationRef: matched.id };
            ev.description = `${ev.description}（文末泛化承认过参考该来源，但此对应处无具体标注——保留为「引用不规范」线索）`;
          }
        } else {
          (ev.detail as any) = { ...(ev.detail || {}), citationState: 'undeclared' };
        }
      }
      const spec = evidence.filter((e) => (e.detail as any)?.citationState === 'declared_specific').length;
      const gen = evidence.filter((e) => (e.detail as any)?.citationState === 'declared_general').length;
      if (spec + gen) rt.log('对质', `引用状态标注：${spec} 条已具体声明（转注记），${gen} 条仅泛化承认（降格线索）`);
    }
  }

  // S60HBY：证据链进入扩展与披露前先剥除 Jina/Markdown 图片、图标和媒体署名。
  for (const ev of evidence) {
    if (ev.targetQuote) ev.targetQuote = stripMarkdownMedia(ev.targetQuote);
    if (ev.sourceQuote) ev.sourceQuote = stripMarkdownMedia(ev.sourceQuote);
    if (ev.sourceParaphrase) ev.sourceParaphrase = stripMarkdownMedia(ev.sourceParaphrase);
    if (ev.targetParaphrase) ev.targetParaphrase = stripMarkdownMedia(ev.targetParaphrase);
  }

  // v3.2 上下文披露（用户要求：证据区披露被检内容附近的文本，经核查确保完整准确）：
  // 每条 E3/E4 证据存 contextTarget/contextSource——引文前后各~200字，命中句内嵌；
  // 披露内容机械校验：必须是目标文本/源全文的逐字子串（locateQuote 定位失败则不披露）
  {
    const buildContext = (quote: string, text: string): string | undefined => {
      quote = stripMarkdownMedia(quote);
      text = stripMarkdownMedia(text);
      if (!quote || !text) return undefined;
      const i = locateExactOrUniqueAnchor(quote, text);
      if (i < 0) return undefined; // 无法定位→不披露（宁缺毋滥）
      const qEnd = Math.min(text.length, i + quote.length);
      const start = Math.max(0, i - 200);
      const end = Math.min(text.length, qEnd + 200);
      return text.slice(start, end);
    };
    for (const ev of evidence) {
      if (ev.level !== 'E3' && ev.level !== 'E4') continue;
      if ((ev.detail as any)?.contextVerified !== undefined) continue; // v3.5 增量：旧证据不重复披露
      const src = rt.sources.find((x) => x.id === ev.sourceId);
      const ct = ev.targetQuote ? buildContext((ev.detail as any)?.hitPhraseTarget || ev.targetQuote, cf.target.text) : undefined;
      const cs = ev.sourceQuote && src?.fullText ? buildContext((ev.detail as any)?.hitPhraseSource || ev.sourceQuote, src.fullText) : undefined;
      // 机械核查：上下文必须含命中短语原文（保证逐字真实，非拼接幻觉）
      const okT = ct && ((ev.detail as any)?.hitPhraseTarget ? ct.includes((ev.detail as any).hitPhraseTarget) : ct.includes((ev.targetQuote || '').slice(0, 16)));
      const okS = cs && ((ev.detail as any)?.hitPhraseSource ? cs.includes((ev.detail as any).hitPhraseSource) : cs.includes((ev.sourceQuote || '').slice(0, 16)));
      (ev.detail as any) = {
        ...(ev.detail || {}),
        contextTarget: okT ? ct : undefined,
        contextSource: okS ? cs : undefined,
        contextVerified: !!(okT || okS),
      };
    }
    const disclosed = evidence.filter((e) => (e.detail as any)?.contextTarget || (e.detail as any)?.contextSource).length;
    if (disclosed) rt.log('对质', `上下文披露：${disclosed} 条证据附带前后文（已机械校验逐字真实）`);
  }

  // v3.4 引文与上下文分离：扩展段只存入 detail，不覆盖通过定位的核心引文。
  {
    const expand = (q: string, text: string): string => {
      if (!q || !text) return q;
      const i = locateExactOrUniqueAnchor(q, text);
      if (i < 0) return q;
      // 前扩：从 i 往前找句末标点（。！？.!?），最多 120 字
      let start = i;
      for (let j = i - 1; j >= Math.max(0, i - 120) && j >= 0; j--) {
        if (/[。！？!?]/.test(text[j]) || (text[j] === '.' && /\s/.test(text[j + 1] || ''))) { start = j + 1; break; }
      }
      // 后扩：从引文尾往后找句末，最多 160 字
      const end0 = i + q.length;
      let end = end0;
      for (let j = end0; j < Math.min(text.length, end0 + 160); j++) {
        if (/[。！？!?]/.test(text[j]) || (text[j] === '.' && /\s/.test(text[j + 1] || ''))) { end = j + 1; break; }
      }
      const ext = text.slice(start, end).trim();
      return ext.length >= q.length ? ext : q;
    };
    for (const ev of evidence) {
      if (ev.level !== 'E3' && ev.level !== 'E4') continue;
      if ((ev.detail as any)?.expandedTargetQuote !== undefined) continue; // v3.5 增量：旧证据不重复扩展
      const src = rt.sources.find((x) => x.id === ev.sourceId);
      const hitPhraseTarget = (ev.detail as any)?.hitPhraseTarget || ev.targetQuote;
      const hitPhraseSource = (ev.detail as any)?.hitPhraseSource || ev.sourceQuote;
      (ev.detail as any) = {
        ...(ev.detail || {}),
        hitPhraseTarget,
        hitPhraseSource,
        expandedTargetQuote: hitPhraseTarget ? expand(hitPhraseTarget, cf.target.text) : undefined,
        expandedSourceQuote: hitPhraseSource && src?.fullText ? expand(hitPhraseSource, src.fullText) : undefined,
      };
      ev.targetQuote = hitPhraseTarget;
      ev.sourceQuote = hitPhraseSource;
    }
    rt.log('对质', '引文定位校正：核心命中句与扩展上下文分栏保存，不再用短句首回写引文');
  }

  // v3.1（8E9GJP 案）：证据跨源聚合——同一目标引文被多源命中时合并为一条，
  // 独立源列表内嵌（不再重复 N 条卡片）。聚合键：目标引文归一化后互相包含。
  {
    const { normalize } = await import('../court/textUtils');
    const groups: typeof evidence = [];
    for (const ev of evidence) {
      if (ev.level !== 'E3' && ev.level !== 'E4') { groups.push(ev); continue; }
      const nq = normalize(ev.targetQuote || '');
      const g = groups.find((x) => {
        if (x.level !== 'E3' && x.level !== 'E4') return false;
        const nx = normalize(x.targetQuote || '');
        return (nx && nq && (nx.includes(nq) || nq.includes(nx)));
      });
      if (g) {
        // 并入：记多源 + 保留最强检定
        const d = (g.detail || {}) as any;
        const alsoSources = d.alsoSources || [{ sourceId: g.sourceId, sourceTitle: g.sourceTitle, sourceUrl: g.sourceUrl, sourceQuote: g.sourceQuote, examVerdict: g.examVerdict, subjectRelation: rt.sources.find((s) => s.id === g.sourceId)?.subjectRelation }];
        if (!alsoSources.some((s: any) => s.sourceId === ev.sourceId)) {
          alsoSources.push({ sourceId: ev.sourceId, sourceTitle: ev.sourceTitle, sourceUrl: ev.sourceUrl, sourceQuote: ev.sourceQuote, examVerdict: ev.examVerdict, subjectRelation: rt.sources.find((s) => s.id === ev.sourceId)?.subjectRelation });
        }
        g.detail = { ...d, alsoSources };
        const evStrong = ev.examVerdict === 'expression_copy';
        const gWeak = g.examVerdict !== 'expression_copy';
        if (evStrong && gWeak) {
          g.examVerdict = ev.examVerdict; g.examNote = ev.examNote;
          g.sourceQuote = ev.sourceQuote; g.sourceId = ev.sourceId;
          g.sourceTitle = ev.sourceTitle; g.sourceUrl = ev.sourceUrl;
        }
        if ((ev.detail as any)?.demoted && !(g.detail as any).demoted) { /* 保留 g */ }
        else if (!(ev.detail as any)?.demoted && (g.detail as any).demoted) {
          (g.detail as any).demoted = undefined;
        }
      } else {
        groups.push(ev);
      }
    }
    // 聚合条目描述带源数
    for (const g of groups) {
      const d = (g.detail || {}) as any;
      if (d.alsoSources?.length > 1 && !/\（该对应在 \d+ 个独立源中同时命中\）$/.test(g.description)) {
        g.description = `${g.description}（该对应在 ${d.alsoSources.length} 个独立源中同时命中）`;
      }
    }
    if (evidence.length !== groups.length) {
      rt.log('对质', `证据跨源聚合：${evidence.length} → ${groups.length} 条（同一引文多源命中已合并）`);
      evidence.length = 0;
      evidence.push(...groups);
    }
  }

  // v2.2.10 证据卡源主体信息统一注入（可点击核验）
  // v3.1：Apple 链接补 uo=4（保证浏览器打开网页版单集页而非跳 App 主页）；
  // 系列页/节目主页 URL 标注「系列页」提示非单集直达
  for (const ev of evidence) {
    const s = rt.sources.find((x) => x.id === ev.sourceId);
    if (s) {
      ev.sourceTitle = s.title;
      let url = s.url || '';
      if (/podcasts\.apple\.com/.test(url) && !url.includes('uo=')) {
        url += (url.includes('?') ? '&' : '?') + 'uo=4';
      }
      ev.sourceUrl = url;
      ev.sourceTranscribed = !!s.transcribed;
      (ev.detail as any) = {
        ...(ev.detail || {}),
        subjectRelation: s.subjectRelation || 'unknown',
        subjectRelationNote: s.subjectRelationNote,
        sourcePostdatesTarget: !!s.reversed,
      };
      if (Array.isArray((ev.detail as any).alsoSources)) {
        (ev.detail as any).alsoSources = (ev.detail as any).alsoSources.map((item: any) => {
          const source = rt.sources.find((candidate) => candidate.id === item.sourceId);
          return source ? {
            ...item,
            sourceTitle: source.title,
            sourceUrl: source.url,
            subjectRelation: source.subjectRelation || 'unknown',
          } : item;
        });
      }
      if (/\/series\/|\/show\//.test(url)) {
        (ev.detail as any) = { ...(ev.detail || {}), seriesPage: true };
      }
    }
  }

  // S60HBY 纪律：多家媒体同时报道的日期/人名/官方文件名是公共新闻事实，
  // 多源一致反而说明其公共性；没有独特措辞或共同错误时不得作为独特表达定案。
  for (const ev of evidence) {
    const alsoCount = Array.isArray((ev.detail as any)?.alsoSources) ? (ev.detail as any).alsoSources.length : 1;
    const sameEventOnly = (ev.detail as any)?.subjectRelation === 'same_event';
    const wordingLike = (ev.detail as any)?.overlapType === 'phrasing' || (ev.detail as any)?.transcriptionError;
    if (!wordingLike && (sameEventOnly || looksLikeSharedNewsFact(ev, alsoCount))) {
      ev.examVerdict = 'fact_relay';
      ev.examNote = `该对应见于 ${alsoCount} 个独立新闻来源，核心为日期、人名、事件名或官方文件名等公共事实；未发现独特行文或共同错误。`;
      (ev.detail as any) = { ...(ev.detail || {}), demoted: true, demotedFrom: ev.level, sharedNewsFact: true };
      rt.log('对质', `公共新闻事实纪律：${ev.id} 降为线索级（${alsoCount} 个独立来源同步报道）`);
    }
  }

  // 同源系统性对应只能在来源关系、时序、公共事实与具体引用检查全部完成后生成。
  // 三条贡献线索必须双侧定位通过且分别去重；合成组只计一次，原线索继续保持降级。
  for (const source of rt.sources) {
    const id = `EV-SYS-${source.id}`;
    if (evidence.some((item) => item.id === id)) continue;
    const systematic = buildSystematicOverlapEvidence(source.id, source.title, evidence);
    if (!systematic) continue;
    evidence.push(systematic);
    const total = Array.isArray((systematic.detail as any)?.systematicContributors)
      ? (systematic.detail as any).systematicContributors.length
      : 0;
    rt.log('对质', `系统性相似准入：${source.id} 上 ${total} 组不同双侧原句定位通过，合并为 1 个证据组`);
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
  const admittedEvidence = evidence.filter(isAdmissibleEvidence);
  const admissionCount = countAdmissibleEvidenceGroups(evidence);
  const fpHits = admittedEvidence.filter((e) => e.level === 'E3' || e.level === 'E4');
  const distinctFps = new Set(fpHits.map((e) => e.id.split('-')[1])).size;
  const stats = {
    e4: admittedEvidence.filter((e) => e.level === 'E4').length,
    e3: admittedEvidence.filter((e) => e.level === 'E3').length,
    e3DistinctFingerprints: distinctFps,
    e2: admittedEvidence.some((e) => e.level === 'E2'),
    e1: !!cf.profile && (cf.profile.entities.length > 0 || cf.profile.outline.length > 0),
    e5: admittedEvidence.filter((e) => e.level === 'E5').length,
  };
  const v = mapVerdictPublic(stats, cf.attribution, !cf.target.degraded, rt.sources.length > 0, admissionCount);

  rt.log('宣判', `证据准入：正式证据 ${admissionCount} 组 / 立案门槛 ${MIN_ADMISSIBLE_EVIDENCE_GROUPS} 组；${v.word}（${v.rule}）`);

  // v3.1 总括判词（8E9GJP 案用户要求）：先给整体相似性/痕迹形态总述，再进具体清单
  let overview = '';
  try {
    const ov = await chatJson<any>(
      rt.provider.chat,
      'Write ONE overview sentence (<=120 chars, plain Chinese, no jargon) summarizing ONLY the ADMITTED evidence groups and separately mention how many clues were excluded. Retrieval similarity scores are search-ranking metadata and MUST NEVER be described as evidence similarity or data-combination similarity. Public-news fact relays are clues, not unique-expression evidence. Output only JSON: {"overview":"..."}',
      `正式证据组（${admissionCount}）：\n${admittedEvidence.slice(0, 20).map((e) => `${e.plainTitle || e.kind}｜${e.description}`).join('\n') || '无'}\n\n线索或负面查证（${evidence.length - admissionCount}）：\n${evidence.filter((e) => !isAdmissibleEvidence(e)).slice(0, 20).map((e) => `${e.plainTitle || e.kind}｜${e.description}`).join('\n') || '无'}\n\n候选源主体关系：${rt.sources.map((s) => `${s.title.slice(0, 30)}（${s.subjectRelation || 'unknown'}）`).join('；')}`,
      { maxTokens: 300 },
    );
    overview = cjkPunctNormalize(String(ov.overview || ''));
  } catch { /* 总括失败不阻塞 */ }

  // v3 多智能体庭审（P3）：公诉人立论 → 辩护人驳斥 → 法官判词
  // 上下文隔离：控辩双方只读结构化证据清单；判词输入=控辩对抗材料（天然平衡）
  const { Orchestrator } = await import('../court/agents/orchestrator');
  const { runProsecutor } = await import('../court/agents/prosecutor');
  const { runDefender } = await import('../court/agents/defender');
  const { runJudge } = await import('../court/agents/judge');
  const orch = new Orchestrator(cf.caseId);
  const chatFn = (system: string, user: string, opts?: { maxTokens?: number }) =>
    import('../providers/glm').then(() => chatJson<any>(rt.provider.chat, system, user, opts));
  cf.trialLog = orch.session.agentLog;

  let brief: import('../court/agents/prosecutor').ProsecutionBrief | null = null;
  let rebuttal: import('../court/agents/defender').DefenseRebuttal | null = null;
  const debateRounds: { round: number; prosecution: string; defense: string }[] = [];
  const positiveEv = admittedEvidence.filter((e) => e.level !== 'E1');
  if (admissionCount >= MIN_ADMISSIBLE_EVIDENCE_GROUPS && positiveEv.length > 0) {
    rt.log('宣判', '公诉人立论…');
    brief = await runProsecutor(orch, chatFn, evidence, rt.sources, cf.target.title);
    rt.log('宣判', '辩护人驳斥…');
    rebuttal = await runDefender(orch, chatFn, evidence, brief!, cf.target.title, cf.declaredCitations);
    debateRounds.push({ round: 1, prosecution: brief!.argument, defense: rebuttal!.overall });

    // 正式证据达到立案门槛时追加一轮复辩；最多两轮，失败不阻塞裁决。
    if (orch.canExtendDebate()) {
      try {
        orch.session.round = 2;
        orch.note('prosecutor', '第二轮复辩开始：逐项回应辩方质疑');
        const reply = await chatJson<any>(
          rt.provider.chat,
          '你是公诉人。只根据已准入的结构化证据与第一轮辩方意见，用简体中文逐项回应最关键的质疑。不得扩大指控，不得把检索相似度当作证据强度。输出 JSON：{"reply":"不超过260字"}',
          `正式证据：\n${positiveEv.map((e, i) => `${i + 1}. ${e.description}\n目标：${e.targetQuote || '结构证据'}\n来源：${e.sourceQuote || '结构证据'}`).join('\n')}\n\n第一轮辩方意见：${rebuttal!.overall}\n${rebuttal!.attacks.map((a) => `· ${a.reason}`).join('\n')}`,
          { maxTokens: 500 },
        );
        orch.note('defender', '第二轮答辩开始：复核公诉人回应');
        const finalDefense = await chatJson<any>(
          rt.provider.chat,
          '你是辩护人。复核公诉人的第二轮回应，指出仍未排除的巧合、公共事实或方法盲点。简体中文，保持克制。输出 JSON：{"reply":"不超过260字"}',
          `公诉人复辩：${String(reply.reply || '')}\n\n第一轮辩方意见：${rebuttal!.overall}`,
          { maxTokens: 500 },
        );
        const prosecutionReply = cjkPunctNormalize(String(reply.reply || ''));
        const defenseReply = cjkPunctNormalize(String(finalDefense.reply || ''));
        if (prosecutionReply || defenseReply) {
          debateRounds.push({ round: 2, prosecution: prosecutionReply, defense: defenseReply });
          brief!.argument = `${brief!.argument}\n\n第二轮复辩：${prosecutionReply}`;
          rebuttal!.overall = `${rebuttal!.overall}\n\n第二轮答辩：${defenseReply}`;
        }
        orch.note('orchestrator', '第二轮复辩完成，材料移交法官');
      } catch (e: any) {
        orch.note('orchestrator', `第二轮复辩未完成：${String(e?.message || e).slice(0, 60)}`);
      }
    }
  } else {
    orch.note('orchestrator', `正式查证 ${admissionCount} 组，其中正面证据 ${positiveEv.length} 组——无须启动完整控辩`);
  }
  cf.trialLog = [...orch.session.agentLog];

  // 法官判词
  let opinion = '';
  const judgeOp = await runJudge(orch, chatFn, v.word, v.rule, evidence, brief, rebuttal, cf.target.title, cf.declaredCitations);
  if (judgeOp?.opinion) {
    opinion = judgeOp.opinion;
    cf.trialLog = [...orch.session.agentLog];
  } else
  try {
    const op = await chatJson<any>(
      rt.provider.chat,
      VERDICT_OPINION_SYSTEM,
      `裁决词：${v.word}\n触发规则：${v.rule}\n案卷标题：${cf.target.title}\n案情摘要：${cf.profile?.summaryZh || ''}\n证据清单（按说服力排序，写意见时请引用证据序号与内容，不要只说"证据不足"）：\n${evidence.map((e, i) => `证据${i + 1}｜${plainLevelName(e.level)}｜${e.kind}${e.examVerdict ? `｜检定：${({ expression_copy: '独特表达复制', fact_relay: '事实转述（不构成定案依据）', generic_overlap: '宏观表达重合（不构成定案依据）', inconclusive: '无法判定' } as any)[e.examVerdict] || e.examVerdict}` : ''}\n${e.description}\n  目标引文：${e.targetQuote || '（结构类证据，无单条引文）'}\n  源引文：${e.sourceQuote || '（见证据描述）'}${e.sourceQuoteLocated === false ? '（源引文未在源文本中定位，已降级）' : ''}`).join('\n')}\n候选源：${rt.sources.map((s) => `${s.id.replace('SRC', '候选源')} ${s.title}${s.transcribed ? '（已转录全文）' : s.partial ? '(部分取证)' : ''}`).join('；')}\n指纹候选总数：${cf.fingerprints.length}，命中：${distinctFps}\n${((rt as any).controversyNotes as string[] | undefined)?.length ? `\n【外界指控】公开网络已有 ${((rt as any).controversyNotes as string[]).length} 篇针对该作品/作者的抄袭指控报道——写意见时必须提及此事，并说明本庭自动比对结果与外界指控的关系（一致/不一致/不可比），不得回避。` : ''}\n写意见要求：先概括证据链整体形态（哪些源、什么类型的对应、强度如何），再指出最关键的 1-2 条证据及其引文内容，最后说明证据局限。不要出现 EV-、SRC、FP 等内部代号。`,
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

  return buildVerdictDoc(cf, rt, evidence, v, opinion, crossChecks, { brief, rebuttal, overview, admissionCount, debateRounds });
}

// mapVerdict 的公开包装（避免内核层反向依赖流水线）
import { mapVerdict, DISCLAIMER, NAMING_FOOTNOTE, type VerdictResult } from '../court/evidence';
function mapVerdictPublic(
  stats: Parameters<typeof mapVerdict>[0],
  attribution: Parameters<typeof mapVerdict>[1],
  usable: boolean,
  hadCandidates: boolean,
  admissibleGroups?: number,
): VerdictResult {
  return mapVerdict(stats, attribution, usable, hadCandidates, admissibleGroups);
}

export interface VerdictDoc {
  caseFile: CaseFile;
  sources: SourceDoc[];
  evidence: EvidenceItem[];
  verdict: VerdictResult;
  /** v3.1 总括判词：整体相似性与痕迹形态总述（证据清单之前） */
  overview?: string;
  opinion: string;
  /** v3 控辩双方意见 */
  prosecution?: { argument: string; charges: { evidenceId: string; charge: string }[] } | null;
  defense?: { attacks: { evidenceId: string; angle: string; reason: string }[]; overall: string; whatWouldChange: string } | null;
  debateRounds: { round: number; prosecution: string; defense: string }[];
  crossChecks: { evidenceId: string; risk: string; note: string }[];
  admission: { required: number; admitted: number; discovered: number; status: 'sufficient' | 'insufficient' };
  searchAudit?: { rounds: number; queries: number; supplementalQueries: number; supplementalSources: number };
  externalClaims: { title: string; url: string; snippet?: string }[];
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
  trial?: { brief?: import('../court/agents/prosecutor').ProsecutionBrief | null; rebuttal?: import('../court/agents/defender').DefenseRebuttal | null; overview?: string; admissionCount?: number; debateRounds?: { round: number; prosecution: string; defense: string }[] },
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
  // v2.2.9 外界指控呈堂：有公开抄袭指控报道时，判决书必须显式披露（即使本庭未发现接触痕迹）
  const cNotes = rt.controversyNotes;
  if (cNotes?.length) {
    limits.push(`外界指控：发现 ${cNotes.length} 篇与被检主体直接相关且符合报道体例的公开材料；其内容单独列示，不替代本庭的原文比对。`);
  }
  // v2.2.9 归属链性质声明（用户指出：已发表≠原创——正式发表渠道只做编辑筛选不做原创核查）
  if (cf.attribution === 'complete' && rt.mirrorNotes?.length) {
    limits.push('归属链说明：上方归属信息只证明该内容的发布渠道与署名情况，不构成原创性证明——正式发表渠道（期刊/出版社/作协网站）不做原创性核查，本庭的「卫生」与否只取决于证据本身');
  }
  limits.push(`指纹候选 ${cf.fingerprints.length} 个，检索候选源 ${rt.sources.length} 个（相似度排序，满分 100）；「未发现」不等于「证明清白」`);
  if (rt.searchAudit) {
    limits.push(`本案完成 ${rt.searchAudit.rounds} 轮、${rt.searchAudit.queries} 条检索式；补充取证新增 ${rt.searchAudit.supplementalSources} 个候选源。检索相关分只用于排序，不代表证据强度`);
  }
  if (rt.rejectedSources?.length) {
    limits.push(`检索淘汰 ${rt.rejectedSources.length} 个候选：${rt.rejectedSources.slice(0, 6).map((r) => `${r.title.slice(0, 24)}（${r.reason}）`).join('；')}${rt.rejectedSources.length > 6 ? ' 等' : ''}`);
  }
  const topSim = rt.sources.filter((s) => typeof s.similarity === 'number').slice(0, 3).map((s) => `${s.id}=${s.similarity}`);
  if (topSim.length) limits.push(`相似度前三：${topSim.join('，')}`);

  // v2.2 出口标点纪律：中文区半角标点归一化为全角（确定性兜底，防 LLM 漏守约束）
  // v3.1：引文（targetQuote/sourceQuote/转述）不再统一归一化——
  // 英文源引文必须保留英文标点；中文区标点纪律已在提示词层约束 + cjkPunctNormalize 内置英文段保护
  const evidenceN = evidence.map((e) => ({
    ...e,
    description: cjkPunctNormalize(e.description),
    sourceParaphrase: e.sourceParaphrase ? cjkPunctNormalize(e.sourceParaphrase) : undefined,
    targetParaphrase: e.targetParaphrase ? cjkPunctNormalize(e.targetParaphrase) : undefined,
  }));
  const limitsN = limits.map(cjkPunctNormalize);

  cf.fingerprints = cf.fingerprints.map((fingerprint) => ({
    ...fingerprint,
    quote: fingerprint.quote || fingerprint.targetQuote,
  }));

  const processEntries = (rt.processLog || []).map((entry) => ({
    at: entry.at,
    role: (entry.stage === '立案' || entry.stage === '检索' ? 'clerk' : entry.stage === '侦查' || entry.stage === '对质' ? 'evidence_officer' : 'orchestrator'),
    action: entry.note,
  }));
  cf.trialLog = [...processEntries, ...(cf.trialLog || [])];
  const admissionCount = trial?.admissionCount ?? countAdmissibleEvidenceGroups(evidenceN);

  return {
    caseFile: cf,
    sources: rt.sources,
    evidence: evidenceN,
    verdict: v,
    overview: trial?.overview,
    opinion: cjkPunctNormalize(opinion),
    prosecution: trial?.brief
      ? { argument: trial.brief.argument, charges: trial.brief.charges }
      : null,
    defense: trial?.rebuttal
      ? { attacks: trial.rebuttal.attacks, overall: trial.rebuttal.overall, whatWouldChange: trial.rebuttal.whatWouldChange }
      : null,
    debateRounds: trial?.debateRounds || [],
    crossChecks,
    admission: {
      required: MIN_ADMISSIBLE_EVIDENCE_GROUPS,
      admitted: admissionCount,
      discovered: evidenceN.length,
      status: admissionCount >= MIN_ADMISSIBLE_EVIDENCE_GROUPS ? 'sufficient' : 'insufficient',
    },
    searchAudit: rt.searchAudit,
    externalClaims: cNotes || [],
    disclaimer: DISCLAIMER,
    namingFootnote: NAMING_FOOTNOTE,
    generatedAt: new Date().toISOString(),
    limits: limitsN,
  };
}
