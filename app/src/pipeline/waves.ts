// v3.5 波次检索编排（2026-08-23 用户定稿：挑选 1-3 个最可能源优先转录对比，
// 证据不足再扩张，硬上限 14 源——治 21 源/54 分钟恶性循环：源越多→对质越慢→
// 证据越不足→再补源。）
//
// 三波设计（wave-search-design.md）：
//   第1波（核心 3 源）全流程：转录（首块闸门）+ 指纹验证 + 细比对
//   第2波（扩至 8 源）仅当第1波证据不足：次优 5 源轻对质（不转录、只页面全文）
//   第3波（并入补检索，硬上限 14）：未对质源（含原 9-14 名与补充取证新增）按分选满
//
// 排序信号（无需转录，廉价）：简介相似度（discovery 已算）+ 源形态加权（播客单集
// 同媒介 > 文章 > 百科/通史）+ 平台权威度（一手创作者页 > 期刊/媒体 > 聚合页）+
// 标题/简介含目标指纹英文检索词。
//
// 提前终止：admissibleGroups ≥ MIN_ADMISSIBLE_EVIDENCE_GROUPS → 停止扩张直接宣判
//（与 v3.4 EV-SYS 同源系统性规则乘法：第 1 波内 3 源命中同源即成组，实锤案应在第 1 波终结）

import type { CaseFile, SourceDoc } from '../court/types';
import type { EvidenceItem } from '../court/evidence';
import { MIN_ADMISSIBLE_EVIDENCE_GROUPS, countAdmissibleEvidenceGroups } from '../court/evidence';
import type { CourtRuntime } from './index';

export const WAVE1_SIZE = 3;
export const WAVE2_SIZE = 8;
export const WAVE_HARD_CAP = 14;

export interface WaveOptions {
  /** 第1波源数（默认 3） */
  wave1?: number;
  /** 第2波累计源数（默认 8） */
  wave2?: number;
  /** 总对质源硬上限（默认 14） */
  hardCap?: number;
  /** 候选源转录回调（App 层注入，含首块闸门逻辑）；返回 true=该源已转录 */
  transcribe?: (src: SourceDoc) => Promise<boolean>;
}

type CrossExaminationFn = (
  cf: CaseFile,
  rt: CourtRuntime,
  opts?: { sourceFilter?: (src: SourceDoc) => boolean },
) => Promise<EvidenceItem[]>;

/** 源形态加权：播客单集（同媒介）> 文章 > 百科/通史 > 聚合页 */
function formWeight(src: SourceDoc): number {
  const url = src.url || '';
  const title = (src.title || '').toLowerCase();
  if (/xiaoyuzhoufm\.com\/episode|podcasts\.apple\.com.*\?i=|open\.spotify\.com\/episode|getpodcast\.com|musixmatch\.com\/podcast|deezer\.com\/episode|podtail\.com|podcast-addict\.com|podcastrex\.com/.test(url)) {
    return 30; // 播客单集——同媒介，最可能源
  }
  if (/wikipedia\.org|baike\.baidu\.com|\bwiki\b/.test(url) || /百科|wikipedia/i.test(title)) {
    return -15; // 百科/通史——常识源，抄袭概率低
  }
  if (/substack|medium\.com|mp\.weixin\.qq\.com|notion\.site|blog/.test(url)) {
    return 15; // 一手创作者页
  }
  return 0; // 普通文章/聚合页
}

/** 平台权威度：一手创作者页 > 期刊/媒体 > 聚合页（与形态加权信号互补） */
function authorityWeight(src: SourceDoc): number {
  const url = src.url || '';
  if (/substack|medium\.com|mp\.weixin\.qq\.com|notion\.site/.test(url)) return 10;
  if (/\.(edu|gov)\//.test(url) || /jstor|cambridge|oxford|nytimes|newyorker|theguardian|bbc\.com/.test(url)) return 8;
  if (/reddit\.com|quora\.com|zhihu\.com\/question|douban\.com\/group/.test(url)) return -5; // 讨论聚合页
  return 0;
}

/** 指纹英文词命中：标题/简介含目标指纹英文检索词（无需转录的廉价同域信号） */
function keywordHitBonus(src: SourceDoc, cf: CaseFile): number {
  const kws = (cf.fingerprints || []).flatMap((f) => f.searchKeywordsEn || []).filter((k) => k.length >= 5);
  if (!kws.length) return 0;
  const hay = `${src.title || ''} ${src.snippet || ''}`.toLowerCase();
  const hits = kws.filter((k) => hay.includes(k.toLowerCase())).length;
  return Math.min(15, hits * 5);
}

function waveScore(src: SourceDoc, cf: CaseFile): number {
  const sim = src.similarity ?? 0;
  return sim + formWeight(src) + authorityWeight(src) + keywordHitBonus(src, cf);
}

/**
 * 波次排序：简介相似度为主信号，形态/权威度/指纹词命中做次级修正。
 * 返回新数组（降序），不改传入数组。
 */
export function rankForWaves(cf: CaseFile, sources: SourceDoc[]): SourceDoc[] {
  return sources.slice().sort((a, b) => waveScore(b, cf) - waveScore(a, cf));
}

/** 已对质源 id 登记簿（挂在 rt 上跨波共享；CourtRuntime 可选字段） */
function examinedIds(rt: CourtRuntime): Set<string> {
  if (!rt.waveExaminedIds) rt.waveExaminedIds = new Set<string>();
  return rt.waveExaminedIds;
}

async function crossExamineSources(
  cf: CaseFile,
  rt: CourtRuntime,
  crossExamination: CrossExaminationFn,
  batch: SourceDoc[],
): Promise<EvidenceItem[]> {
  const ids = new Set(batch.map((s) => s.id));
  const evidence = await crossExamination(cf, rt, { sourceFilter: (src) => ids.has(src.id) });
  rt.evidence = evidence;
  for (const s of batch) examinedIds(rt).add(s.id);
  return evidence;
}

/**
 * 波次主编排（第 1-2 波）：对 rt.sources 排序后分批对质，每波结束检查
 * admissibleGroups ≥ 2 提前终止。第 1 波对 top-3 先调 transcribe 回调（含首块闸门）。
 * 第 3 波（补充取证后的扩张）由 wave3Supplement 承担。
 */
export async function runWaves(
  cf: CaseFile,
  rt: CourtRuntime,
  crossExamination: CrossExaminationFn,
  opts?: WaveOptions,
): Promise<EvidenceItem[]> {
  const wave1 = opts?.wave1 ?? WAVE1_SIZE;
  const wave2 = opts?.wave2 ?? WAVE2_SIZE;
  const hardCap = opts?.hardCap ?? WAVE_HARD_CAP;
  // 波次序替换原序（crossExamination 的 top-N 切片与展示层都吃这个顺序）
  rt.sources = rankForWaves(cf, rt.sources).slice(0, hardCap);

  if (!rt.sources.length) {
    rt.log('对质', '无候选源可对质');
    rt.evidence = [];
    return [];
  }
  const top = rt.sources.slice(0, wave1);
  rt.log('对质', `第 1 波（核心 ${top.length} 源全流程）：${top.map((s) => s.id).join('、')}——按相似度+源形态+指纹词命中排序选取`);

  for (const src of top) {
    if (src.transcribed || !opts?.transcribe) continue;
    try {
      await opts.transcribe(src);
    } catch (e: any) {
      rt.log('检索', `候选源 ${src.id} 转录失败（${String(e?.message || e).slice(0, 60)}），以页面文本对质`);
    }
  }
  let evidence = await crossExamineSources(cf, rt, crossExamination, top);
  let admitted = countAdmissibleEvidenceGroups(evidence);
  if (admitted >= MIN_ADMISSIBLE_EVIDENCE_GROUPS) {
    rt.log('对质', `第 1 波即凑足 ${admitted} 组正式证据（≥${MIN_ADMISSIBLE_EVIDENCE_GROUPS}）——提前终止扩张，直接宣判`);
    return evidence;
  }

  const second = rt.sources.slice(wave1, wave2);
  if (second.length) {
    rt.log('对质', `第 1 波证据不足（${admitted}/${MIN_ADMISSIBLE_EVIDENCE_GROUPS} 组）——第 2 波扩至 ${Math.min(wave2, rt.sources.length)} 源轻对质（不转录）：${second.map((s) => s.id).join('、')}`);
    evidence = await crossExamineSources(cf, rt, crossExamination, second);
    admitted = countAdmissibleEvidenceGroups(evidence);
    if (admitted >= MIN_ADMISSIBLE_EVIDENCE_GROUPS) {
      rt.log('对质', `第 2 波凑足 ${admitted} 组正式证据——提前终止扩张，直接宣判`);
      return evidence;
    }
  }

  rt.log('对质', `第 2 波后证据仍 ${admitted}/${MIN_ADMISSIBLE_EVIDENCE_GROUPS} 组——转入补充取证（第 3 波，对质源上限 ${hardCap}）`);
  return evidence;
}

/**
 * 第 3 波（补充取证后扩张）：在全部「未对质」源（原 9-14 名 + supplemental 新增）
 * 中按波次分重选，直到累计对质源数达 hardCap；对选中者转录（可选）+ 增量对质。
 * 未选中者保留在 rt.sources 中（检索透明），标记 rejectedReason 说明未对质原因。
 */
export async function wave3Supplement(
  cf: CaseFile,
  rt: CourtRuntime,
  crossExamination: CrossExaminationFn,
  opts?: WaveOptions,
): Promise<EvidenceItem[]> {
  const hardCap = opts?.hardCap ?? WAVE_HARD_CAP;
  const done = examinedIds(rt);
  const budget = Math.max(0, hardCap - done.size);
  const freshRanked = rankForWaves(cf, rt.sources.filter((s) => !done.has(s.id)));
  const batch = freshRanked.slice(0, budget);
  for (const s of freshRanked.slice(budget)) {
    s.rejectedReason = `波次上限：对质预算已满（${hardCap} 源），该候选未进入对质——检索记录保留以供人工复核`;
  }
  if (!batch.length) {
    if (freshRanked.length) rt.log('对质', `第 3 波：仍有 ${freshRanked.length} 个未对质候选，但对质预算已满（${hardCap}）——不再扩张`);
    return rt.evidence;
  }
  rt.log('对质', `第 3 波：对未对质候选（原检索余量+补充取证新增）按分选取 ${batch.length} 源增量对质：${batch.map((s) => s.id).join('、')}`);
  for (const src of batch) {
    if (src.transcribed || !opts?.transcribe) continue;
    try {
      await opts.transcribe(src);
    } catch (e: any) {
      rt.log('检索', `候选源 ${src.id} 转录失败（${String(e?.message || e).slice(0, 60)}），以页面文本对质`);
    }
  }
  return crossExamineSources(cf, rt, crossExamination, batch);
}
