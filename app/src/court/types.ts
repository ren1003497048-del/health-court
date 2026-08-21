// 卫生法庭 · 内核层 · 案卷类型

export type ContentType = 'article' | 'podcast_episode' | 'podcast_with_transcript' | 'book_excerpt' | 'video' | 'unknown';

export interface CommunityLead {
  id: string;
  quote: string;
  kind: 'explicit_source_doubt' | 'weird_term_confusion' | 'other_suspicion';
  note: string;
  searchKeywordsZh: string[];
  searchKeywordsEn: string[];
}

export interface DeclaredCitation {
  id: string;
  /** 被声明的来源描述（如「《黑暗时代的人们》，第372页」） */
  source: string;
  /** 声明位置（页/段/文末） */
  location: string;
  /** 粒度：specific=论点处具体标注；general=文末泛化承认 */
  granularity: 'specific' | 'general';
  /** 声明原句 */
  quote: string;
}

export interface CaseFile {
  /** v3.3 引用声明结构（书记员立案提取——盲提取原则：指纹官不读此字段） */
  declaredCitations?: DeclaredCitation[];
  /** v3 多智能体庭审记录（判决书附录：每个角色的动作留痕） */
  trialLog?: { at: string; role: string; action: string; detail?: string }[];
  caseId: string;
  createdAt: string;
  input: { url?: string; text?: string };
  target: {
    title: string;
    author?: string;
    date?: string;
    text: string;
    url?: string;
    fetchedAt?: string;
    contentType: ContentType;
    comments?: string;
    degraded: boolean;
    degradeReason?: string;
  };
  profile?: CaseProfile;
  fingerprints: FingerprintCandidate[];
  leads: CommunityLead[];
  attribution: 'complete' | 'partial' | 'none' | 'unknown';
  attributionNote?: string;
  /** 归属预审结论（P0-1） */
  preReview?: import('./evidence').PreReviewResult;
  /** 转录元数据（P0-3，播客单集经浏览器转录时填写） */
  transcriptMeta?: { audioUrl: string; durationSec: number; asrModel: string; transcribedAt: string };
}

export interface CaseProfile {
  /** v2.2.8 媒介类型（决定检索策略与对质方式）：podcast | fiction | article | unknown */
  mediaType?: 'podcast' | 'fiction' | 'article' | 'unknown';
  topicDomain: string;
  coreClaims: string[];
  outline: string[];
  entities: string[];
  toneSignals: string[];
  summaryZh: string;
}

export interface FingerprintCandidate {
  id: string;
  type: 'weird_term' | 'rare_case' | 'data_combo' | 'analogy' | 'joke' | 'ordering' | 'other';
  priority: 'E4_suspect' | 'high' | 'normal';
  targetQuote: string;
  note?: string;
  searchKeywordsZh: string[];
  searchKeywordsEn: string[];
}

export interface SourceDoc {
  id: string;
  title: string;
  url: string;
  date?: string;
  snippet?: string;
  fullText?: string;
  fetchedAt?: string;
  partial: boolean;
  reversed: boolean;
  origin: 'search' | 'user' | 'seed';
  viaQuery?: string;
  /** v2.2 相似度排序：0-100，与目标画像的语义相似度（LLM 评估），降序排列依据 */
  similarity?: number;
  /** v2.2 候选源 AI 摘要（含语言、类型、主题、与目标重合点） */
  aiSummary?: string;
  /** v2.2.6 候选源为播客单集且已自动转录取全文 */
  transcribed?: boolean;
  /** v2.2 淘汰原因（不入卷时记录，透明可复核） */
  rejectedReason?: string;
}
