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

/** 立案门槛（PRD §5.1）：评定对象=相对独立完整的文化内容整体 */
export const MIN_TARGET_CHARS = 500;
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
      const body = doc.text;
      rt.log('立案', `取证成功：${title || '(无标题)'}，${body.length} 字符`);
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

  return {
    caseId,
    createdAt: new Date().toISOString(),
    input,
    target,
    fingerprints: [],
    leads: [],
    attribution: 'unknown',
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
  if (/podscript|podcasts\.apple\.com/.test(url)) return 'podcast_with_transcript';
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
    coreClaims: (profile.coreClaims || []).map(String).slice(0, 10),
    outline: (profile.outline || []).map(String).slice(0, 15),
    entities: (profile.entities || []).map(String).slice(0, 25),
    toneSignals: (profile.toneSignals || []).map(String).slice(0, 10),
    summaryZh: String(profile.summaryZh || ''),
  };
  rt.log('侦查', `画像完成：${cf.profile.topicDomain}；指纹鉴定官提取指纹候选…`);

  const fp = await chatJson<any>(rt.provider.chat, FINGERPRINT_SYSTEM, `目标文本：\n${text}`);
  cf.fingerprints = ((fp.fingerprints || []) as any[])
    .slice(0, 12)
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
  rt.log('侦查', `提取到 ${cf.fingerprints.length} 个指纹候选`);

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

// ---------------------------------------------------------------------------
// 阶段三：检索
// ---------------------------------------------------------------------------

export async function discovery(cf: CaseFile, rt: CourtRuntime, opts?: { maxSources?: number }): Promise<CaseFile> {
  const maxSources = opts?.maxSources ?? 5;
  const q = await chatJson<any>(
    rt.provider.chat,
    DISCOVERY_QUERY_SYSTEM,
    `案情画像：${JSON.stringify({
      topicDomain: cf.profile?.topicDomain,
      coreClaims: cf.profile?.coreClaims,
      entities: cf.profile?.entities,
      outline: cf.profile?.outline,
    }, null, 0)}\n\n指纹候选（id/类型/检索词）：${cf.fingerprints.map((f) => `${f.id} ${f.type} [${f.searchKeywordsEn.join('; ')}]`).join('\n')}\n\n群众线报：${cf.leads.map((l) => `${l.id} ${l.searchKeywordsEn.join('; ')}`).join('\n') || '无'}`,
  );

  const queries: { tag: string; q: string }[] = [];
  (q.queries?.topic || []).slice(0, 3).forEach((qq: string) => queries.push({ tag: 'R1 主题', q: String(qq) }));
  (q.queries?.fingerprint || []).slice(0, 10).forEach((f: any) => {
    if (f && f.query) queries.push({ tag: `R2 指纹 ${f.fingerprintId || ''}`.trim(), q: String(f.query) });
  });
  (q.queries?.leads || []).slice(0, 5).forEach((l: any) => {
    if (l && l.query) queries.push({ tag: 'R3 线报', q: String(l.query) });
  });
  rt.log('检索', `构造检索式 ${queries.length} 条，开始多轮搜索…`);

  const seen = new Set<string>();
  const candidates: { doc: { title: string; url: string; snippet: string; date?: string }; via: string }[] = [];
  for (const { tag, q: query } of queries) {
    try {
      const { docs } = await rt.provider.search(query);
      for (const d of docs) {
        if (!seen.has(d.url)) {
          seen.add(d.url);
          candidates.push({ doc: d, via: `${tag}：${query}` });
        }
      }
      rt.log('检索', `[${tag}] "${query.slice(0, 50)}" → ${docs.length} 条`);
    } catch (e: any) {
      rt.log('检索', `[${tag}] 失败：${e.message.slice(0, 80)}`);
    }
  }

  // 时间方向过滤：候选晚于目标 → 标记 reversed（保留但降权）
  const targetDate = cf.target.date ? Date.parse(cf.target.date) : NaN;
  rt.sources = [];
  const fetched: SourceDoc[] = [];
  for (const c of candidates.slice(0, maxSources + 4)) {
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
    });
    rt.log('检索', `候选源入卷 ${fetched.length}/${maxSources}：${title.slice(0, 40)}${partial ? '（部分取证）' : ''}`);
  }
  rt.sources = fetched;
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

  // 4.1 结构对齐（对 top 2 源做）
  const targetSeg = truncateSmart(cf.target.text, 12000);
  for (const src of rt.sources.slice(0, 2)) {
    if (!src.fullText || src.fullText.length < 500) continue;
    rt.log('对质', `结构鉴定官比对 ${src.id}（${src.title.slice(0, 36)}）…`);
    try {
      const al = await chatJson<any>(
        rt.provider.chat,
        ALIGN_SYSTEM,
        `目标文本（中文）：\n${targetSeg}\n\n候选源文本：\n${truncateSmart(src.fullText, 20000)}`,
        { maxTokens: 4096 },
      );
      if (al.structureMatched) {
        const located = (al.alignments || []).some((a: any) =>
          locateQuote(a.targetExcerpt, cf.target.text) || locateQuote(a.sourceExcerpt, src.fullText),
        );
        evidence.push({
          id: `EV-${src.id}-E2`,
          level: 'E2',
          kind: '结构对齐',
          description: `与 ${src.title.slice(0, 50)} 章节结构与叙事顺序一致（置信 ${al.confidence}）。${al.orderConsistency || ''}`,
          sourceId: src.id,
          targetQuoteLocated: located,
          detail: { alignments: (al.alignments || []).slice(0, 8), publicDomainNote: al.publicDomainNote },
        });
        rt.log('对质', `E2 结构信号：${src.id} structureMatched=${al.structureMatched}`);
      }
    } catch (e: any) {
      rt.log('对质', `结构对齐失败（${e.message.slice(0, 80)}）`);
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
  // 汇总统计
  const fpHits = evidence.filter((e) => e.level === 'E3' || e.level === 'E4');
  const distinctFps = new Set(fpHits.map((e) => e.id.split('-')[1])).size;
  const stats = {
    e4: evidence.filter((e) => e.level === 'E4').length,
    e3: evidence.filter((e) => e.level === 'E3').length,
    e3DistinctFingerprints: distinctFps,
    e2: evidence.some((e) => e.level === 'E2'),
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
      `裁决词：${v.word}\n触发规则：${v.rule}\n案卷标题：${cf.target.title}\n案情摘要：${cf.profile?.summaryZh || ''}\n证据清单：\n${evidence.map((e) => `${e.id} [${e.level}] ${e.description}\n  目标引文：${e.targetQuote || '无'}\n  源引文：${e.sourceQuote || '无'}${e.sourceQuoteLocated === false ? '（源引文未在源文本中定位）' : ''}`).join('\n')}\n候选源：${rt.sources.map((s) => `${s.id} ${s.title} ${s.partial ? '(部分取证)' : ''}`).join('；')}\n指纹候选总数：${cf.fingerprints.length}，命中：${distinctFps}`,
      { maxTokens: 1200 },
    );
    opinion = String(op.opinion || '');
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
  limits.push(`指纹候选 ${cf.fingerprints.length} 个，检索候选源 ${rt.sources.length} 个；「未发现」不等于「证明清白」`);

  return {
    caseFile: cf,
    sources: rt.sources,
    evidence,
    verdict: v,
    opinion,
    crossChecks,
    disclaimer: DISCLAIMER,
    namingFootnote: NAMING_FOOTNOTE,
    generatedAt: new Date().toISOString(),
    limits,
  };
}
