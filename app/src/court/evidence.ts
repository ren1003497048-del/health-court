// 卫生法庭 · 内核层 · 证据与裁决
// 设计公理（PRD §1.4）：本文件全部为确定性规则，任何 LLM 输出只作为 EvidenceItem 的输入材料，
// 裁决词由本文件的纯函数计算。娱乐层只读取裁决结果，从不参与计算。

export type EvidenceLevel = 'E1' | 'E2' | 'E3' | 'E4' | 'E5';

export const EVIDENCE_LEVEL_INFO: Record<EvidenceLevel, { name: string; desc: string }> = {
  E1: { name: '主题相同', desc: '仅用于检索召回定位，不单独作为判定依据（话题重合过于常见）' },
  E2: { name: '结构相同', desc: '章节、叙事顺序、详略取舍一致（中）' },
  E3: { name: '细节指纹', desc: '相同的独特细节：冷门案例、数据、类比、口误、例证组合（强）' },
  E4: { name: '错误传播', desc: '原文的事实错误/非常规解读（含机器转录错误）被复制（极强）' },
  E5: { name: '翻译腔/措辞', desc: '中文表述是外文原句的直译腔（中，需多例）' },
};

export type VerdictWord = '不卫生' | '可能不卫生' | '可能卫生' | '卫生' | '休庭' | '不予受理' | '不足立案';

/** 正式出具倾向性裁决所需的最少独立证据组数。 */
export const MIN_ADMISSIBLE_EVIDENCE_GROUPS = 3;

/**
 * 白话判据表（2026-08-19 用户拍板）：
 * 只看「展开方式」层面——同一话题本身不构成任何判定依据（话题重合是检索阶段的召回考量，
 * 不在判决中露出）；判的是：对一个相对同一性的话题，两边怎么展开、怎么组织文本。
 * 常识和单个事实的重合同样不计。
 */
export const PLAIN_CRITERIA: Array<{ name: string; question: string; mapsTo: EvidenceLevel[] }> = [
  {
    name: '论证链同构',
    question: '两边是否在同一集中段落内，以完全或几乎一致的顺序展开同一条论证链（论点→论据→例证→转折→结论，≥3 个环节对应）？这是"集中接触痕迹"——独立写作几乎不可能复现整条链。',
    mapsTo: ['E2'],
  },
  {
    name: '罕见材料',
    question: '展开中是否出现同一个冷门案例、数据组合、怪词或错误（在别处找不到、别处不会碰巧用上的）？',
    mapsTo: ['E3', 'E4'],
  },
  {
    name: '例证组合',
    question: '是否同一组例子（≥2 个）以同样的组合与顺序被组织进论述（而非各讲各的常见例）？',
    mapsTo: ['E3'],
  },
  {
    name: '语气与错误',
    question: '源文特有的语气、玩笑、立场，或源文的错误（含机器转录错误），是否被原样搬入目标？',
    mapsTo: ['E4'],
  },
];

/** 证据等级 → 白话名（判决书用） */
export function plainLevelName(level: EvidenceLevel): string {
  switch (level) {
    case 'E4': return '错误被照搬（几乎排除巧合）';
    case 'E3': return '罕见材料或例证组合对应';
    case 'E2': return '论证链同构（集中接触痕迹）';
    case 'E5': return '句式直译对应';
    default: return '已查证无对应（负面查证）';
  }
}

export interface VerdictResult {
  word: VerdictWord;
  /** 触发该裁决的规则说明（写入判决书，保证可审计） */
  rule: string;
  /** 证据等级汇总 */
  counts: Record<EvidenceLevel, number>;
  /** 署名情况 */
  attribution: 'complete' | 'partial' | 'none' | 'unknown';
}

export interface EvidenceItem {
  id: string;
  level: EvidenceLevel;
  kind: string;
  description: string;
  targetQuote?: string;
  targetQuoteLocated?: boolean;
  sourceQuote?: string;
  sourceQuoteLocated?: boolean;
  sourceId?: string;
  /** 复核意见（双模型时填写） */
  crossCheck?: { coincidenceRisk: '低' | '中' | '高'; note: string };
  /** v2.2.10 证据卡源主体信息（可点击核验） */
  sourceTitle?: string;
  sourceUrl?: string;
  sourceTranscribed?: boolean;
  /** v2.2.11 人话标题（仿 podcastreview：'相同年份差错'式，替代等级+类型黑话） */
  plainTitle?: string;
  /** v2.2.11 第三人称转述对（源方转述 + 目标方转述，原始引文内嵌） */
  sourceParaphrase?: string;
  targetParaphrase?: string;
  /** v2.2.1 证据检定：expression_copy（独特表达复制）/ fact_relay（事实转述）/ generic_overlap（宏观表达重合）/ inconclusive */
  examVerdict?: 'expression_copy' | 'fact_relay' | 'generic_overlap' | 'inconclusive';
  /** v2.2.1 检定理由（白话，进判决书） */
  examNote?: string;
  detail?: Record<string, unknown>;
}

/**
 * 正式证据准入理由。返回 null 表示可以计入立案门槛；否则只作为线索展示。
 * 主题相同、新闻公共事实、未定位引文和已降级检定均不得撑高证据组数。
 */
export function evidenceExclusionReason(e: EvidenceItem): string | null {
  if (e.level === 'E1') {
    return e.sourceId && (e.detail as any)?.negative ? null : '仅属主题线索，未完成针对具体来源的负面查证';
  }
  if ((e.detail as any)?.demoted) return '复核后已降为线索级';
  const groupedSourceCount = Array.isArray((e.detail as any)?.alsoSources)
    ? (e.detail as any).alsoSources.length
    : Number((e.detail as any)?.independentSourceCount || 0);
  if (looksLikeSharedNewsFact(e, groupedSourceCount)) return '属于多家媒体共有的近期新闻基本事实';
  const relation = (e.detail as any)?.subjectRelation;
  if (relation === 'same_topic' || relation === 'unrelated') return '候选源与被检主体仅同题或无直接关系';
  if ((e.level === 'E3' || e.level === 'E4') && (!e.targetQuote || !e.sourceQuote)) return '缺少可复核的双侧原文引文';
  if (e.targetQuoteLocated === false || e.sourceQuoteLocated === false) return '原文引文未通过定位校验';
  if ((e.level === 'E2' || e.level === 'E3') && e.examVerdict && e.examVerdict !== 'expression_copy') {
    return e.examVerdict === 'fact_relay' ? '属于公共事实转述' : '未确认独特表达对应';
  }
  return null;
}

export function isAdmissibleEvidence(e: EvidenceItem): boolean {
  return evidenceExclusionReason(e) === null;
}

export function countAdmissibleEvidenceGroups(evidence: EvidenceItem[]): number {
  return evidence.filter(isAdmissibleEvidence).length;
}

/** 多家媒体同步报道同一近期事件时，日期、人名、事件名和官方文件名属于公共新闻事实。 */
export function looksLikeSharedNewsFact(e: EvidenceItem, independentSourceCount: number): boolean {
  if (independentSourceCount < 3 || e.level !== 'E3') return false;
  const type = String((e.detail as any)?.fingerprintType || (e.detail as any)?.overlapType || '');
  if (!/data_combo|rare_case/.test(type) || (e.detail as any)?.transcriptionError) return false;
  const q = `${e.targetQuote || ''} ${e.description || ''}`;
  const hasDate = /(?:20\d{2}[年\-/]\d{1,2}(?:[月\-/]\d{1,2})?|\d{1,2}月\d{1,2}日)/.test(q);
  const hasEvent = /发布|发表|宣布|通谕|声明|法案|选举|就职|记者会|峰会|官方|报告/.test(q);
  return hasDate && hasEvent;
}

/** R6 只接收与目标作品/作者直接相关的正式指控报道，评论、问答和同题碎片不入栏。 */
export function isFormalControversyReport(
  candidate: { title?: string; snippet?: string; url?: string },
  target: { title?: string; author?: string },
): boolean {
  const title = String(candidate.title || '');
  const snippet = String(candidate.snippet || '');
  const haystack = `${title} ${snippet}`;
  if (/reddit\.com|askhistorians|zhihu\.com\/question|quora\.com/i.test(String(candidate.url || ''))) return false;
  if (!/抄袭|洗稿|剽窃|被指|指控|侵权|争议|举报|plagiarism|plagiar|accused|alleged/i.test(haystack)) return false;
  const work = String(target.title || '').replace(/^\s*\d{1,5}\s*[-—－:]\s*/, '').replace(/[《》“”"'「」【】\s]/g, '');
  const author = String(target.author || '').replace(/\s/g, '');
  const anchors = [work, author]
    .filter((x) => x.length >= 4)
    .flatMap((x) => [x, x.slice(0, Math.min(8, x.length))])
    .filter((x) => x.length >= 4);
  return anchors.some((anchor) => haystack.replace(/\s/g, '').includes(anchor));
}

export interface FingerprintHitStats {
  e4: number;
  e3: number;
  e3DistinctFingerprints: number;
  e2: boolean;
  e1: boolean;
  e5: number;
}

/**
 * 裁决映射（PRD §4.2 阈值，一字不差地实现）。
 * 输入是已通过子串校验的证据集合统计。
 */
export function mapVerdict(
  stats: FingerprintHitStats,
  attribution: 'complete' | 'partial' | 'none' | 'unknown',
  contentUsable: boolean,
  hadCandidates: boolean,
  admissibleGroups?: number,
): VerdictResult {
  const counts: Record<EvidenceLevel, number> = {
    E1: stats.e1 ? 1 : 0,
    E2: stats.e2 ? 1 : 0,
    E3: stats.e3,
    E4: stats.e4,
    E5: stats.e5,
  };

  if (!contentUsable) {
    return {
      word: '休庭',
      rule: '内容不可得或不足以完成核查（取证降级链走尽）',
      counts,
      attribution,
    };
  }

  if (!hadCandidates) {
    return {
      word: '休庭',
      rule: '多轮检索后未获得可对质的候选来源；未发现 ≠ 清白，可补充线索后再次开庭',
      counts,
      attribution,
    };
  }

  if (admissibleGroups !== undefined && admissibleGroups < MIN_ADMISSIBLE_EVIDENCE_GROUPS) {
    return {
      word: '不足立案',
      rule: `正式证据仅 ${admissibleGroups} 组，未达到 ${MIN_ADMISSIBLE_EVIDENCE_GROUPS} 组立案门槛；现有内容仅作线索展示，不出具倾向性裁决`,
      counts,
      attribution,
    };
  }

  // 2026-08-18 P0 修正（364案教训）：署名不再短路裁决。
  // 署名只说明存在归属声明，不代表内容本体是一手的；E4/E3 命中照样判不卫生。
  // attribution 仅作为判决书注记（见 verdictStage）。

  if (stats.e4 >= 1) {
    return {
      word: '不卫生',
      rule: '同一个错误被照搬 ×' + stats.e4 + '：源文的错误（含机器转录错误）被复制到目标——独立创作几乎不可能复现同一个错误',
      counts,
      attribution,
    };
  }

  if (stats.e2 && stats.e3DistinctFingerprints >= 3) {
    return {
      word: '不卫生',
      rule: '论证链同构 + 罕见材料 ≥3 处独立对应（集中接触痕迹叠加，母项目「实锤」标准）',
      counts,
      attribution,
    };
  }

  if (stats.e3DistinctFingerprints >= 1 || (stats.e1 && stats.e2) || stats.e5 >= 2) {
    return {
      word: '可能不卫生',
      rule:
        stats.e3DistinctFingerprints >= 3
          ? '罕见材料 ≥3 处对应，但论证链同构未确认'
          : stats.e3DistinctFingerprints >= 1
            ? `罕见材料 ${stats.e3DistinctFingerprints} 处对应${stats.e1 && stats.e2 ? '，且整体结构相似' : ''}——现有证据不足以排除巧合`
            : '主题与结构相似 / 句式直译多例——现有证据不足以排除巧合',
      counts,
      attribution,
    };
  }

  // 2026-08-20 用户拍板：不输出绝对化的「卫生」——检索原理性不穷尽（版权墙/未数字化内容不可达），
  // 清洁结论只能是「可能卫生」，与「可能不卫生」形成对称的存疑结构，由读者自行判断。
  return {
    word: '可能卫生',
    rule: '就本案核查范围（见核查范围与局限栏），各维度均未发现来源依赖痕迹——但检索不覆盖版权墙内与未数字化内容，「未发现」不等于「证明清白」',
    counts,
    attribution,
  };
}

/** 兼容旧档案（localStorage 里的历史判决书 word=卫生）：读取时映射为可能卫生 */
export function normalizeVerdictWord(w: string): VerdictWord {
  return w === '卫生' ? '可能卫生' : (w as VerdictWord);
}

/** 候选源质量闸门（P0-4）：低于此阈值的候选源不得入卷参与对质 */
export const SOURCE_QUALITY_GATE = {
  minTextChars: 800, // 全文长度下限（去除导航/页脚后的实质内容）
  parkDomainWords: ['is for sale', 'buy this domain', 'domain for sale', '待售'],
};

/** 归属预审结论 */
export interface PreReviewResult {
  pass: boolean;
  /** 归属链：作者/节目/发布日期（尽可能精确到年月日） */
  attributionChain: {
    author?: string;
    program?: string;
    platform?: string;
    /** ISO 日期（YYYY-MM-DD 或更粗） */
    publishedDate?: string;
    datePrecision: 'day' | 'month' | 'year' | 'none';
    evidenceNote: string;
  };
  /** 未通过时的说明（弹窗「请自行注意精神卫生」附文） */
  failNote?: string;
  /** 独立完整性判断：是否相对独立、具备完整性的文化内容 */
  completeness: {
    isIndependentWork: boolean;
    hasSubstantialBody: boolean;
    note: string;
  };
}

/** 判决书底部固定免责声明（措辞红线，不可由 LLM 改写；借鉴 podcastreview 工作性分类框架） */
export const DISCLAIMER =
  '本判决为文本证据的自动化分析。「不卫生」等裁决词与「来源依赖」「归因问题」等描述，是用于描述文本关系的工作性分类，不构成任何机构对抄袭、侵权或学术不端的正式认定。涉及动机与工作流程的内容，如无直接证据，均应理解为基于现有材料的推断。材料可能并不完整；如后续取得新的原文或反证，本庭将据此修订。请读者依据材料自行判断。';

/** 判决书页眉注脚（卫生法庭命名出处，产品人格的一部分） */
export const NAMING_FOOTNOTE =
  '「卫生法庭」之名源自一次被复制的机器转录错误：2025年8月6日英文播客 Breaking History 中的 "health corps, literacy corps"（卫生服务队、扫盲队）被语音识别误作 "health court"，随后被照单翻译为「卫生法庭、扫盲法庭」——历史上从未存在过的机构。一个错误能被复制，就能被发现。本庭将错就错，以此名警示内容溯源之事。';
