// 卫生法庭 · 内核层 · 证据与裁决
// 设计公理（PRD §1.4）：本文件全部为确定性规则，任何 LLM 输出只作为 EvidenceItem 的输入材料，
// 裁决词由本文件的纯函数计算。娱乐层只读取裁决结果，从不参与计算。

export type EvidenceLevel = 'E1' | 'E2' | 'E3' | 'E4' | 'E5';

export const EVIDENCE_LEVEL_INFO: Record<EvidenceLevel, { name: string; desc: string }> = {
  E1: { name: '主题相同', desc: '都讲同一事件/人物（弱，公共素材）' },
  E2: { name: '结构相同', desc: '章节、叙事顺序、详略取舍一致（中）' },
  E3: { name: '细节指纹', desc: '相同的独特细节：冷门案例、数据、类比、口误、例证组合（强）' },
  E4: { name: '错误传播', desc: '原文的事实错误/非常规解读（含机器转录错误）被复制（极强）' },
  E5: { name: '翻译腔/措辞', desc: '中文表述是外文原句的直译腔（中，需多例）' },
};

export type VerdictWord = '不卫生' | '可能不卫生' | '卫生' | '休庭' | '不予受理';

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
  detail?: Record<string, unknown>;
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

  // 2026-08-18 P0 修正（364案教训）：署名不再短路裁决。
  // 署名只说明存在归属声明，不代表内容本体是一手的；E4/E3 命中照样判不卫生。
  // attribution 仅作为判决书注记（见 verdictStage）。

  if (stats.e4 >= 1) {
    return {
      word: '不卫生',
      rule: 'E4 错误传播命中 ×' + stats.e4 + '：原文的错误（含机器转录错误）被复制，几乎排除巧合',
      counts,
      attribution,
    };
  }

  if (stats.e2 && stats.e3DistinctFingerprints >= 3) {
    return {
      word: '不卫生',
      rule: 'E2 结构一致 + E3 细节指纹 ≥3 处独立命中（母项目「实锤」标准）',
      counts,
      attribution,
    };
  }

  if (stats.e3DistinctFingerprints >= 1 || (stats.e1 && stats.e2) || stats.e5 >= 2) {
    return {
      word: '可能不卫生',
      rule:
        stats.e3DistinctFingerprints >= 3
          ? 'E3 指纹 ≥3 但结构对应未确认'
          : stats.e3DistinctFingerprints >= 1
            ? `E3 细节指纹 ${stats.e3DistinctFingerprints} 处命中，或 E1+E2 主题结构相似，现有证据不足以排除巧合`
            : 'E1+E2 主题结构相似 / E5 直译腔多例，现有证据不足以排除巧合',
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

  return {
    word: '卫生',
    rule: '就本案核查范围（见核查范围与局限栏），三维度均未发现来源依赖痕迹；「未发现」不等于「证明清白」',
    counts,
    attribution,
  };
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

/** 判决书底部固定免责声明（措辞红线，不可由 LLM 改写） */
export const DISCLAIMER =
  '本判决为文本证据的自动化分析，非法律结论。「不卫生」等裁决词为游戏化表述，其对应的证据等级与阈值见判决书内说明。本庭不对内容作者作动机推断。请读者依据材料自行判断。';

/** 判决书页眉注脚（卫生法庭命名出处，产品人格的一部分） */
export const NAMING_FOOTNOTE =
  '「卫生法庭」之名源自一次被复制的机器转录错误：2025年8月6日英文播客 Breaking History 中的 "health corps, literacy corps"（卫生服务队、扫盲队）被语音识别误作 "health court"，随后被照单翻译为「卫生法庭、扫盲法庭」——历史上从未存在过的机构。一个错误能被复制，就能被发现。本庭将错就错，以此名警示内容溯源之事。';
