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

export interface CaseFile {
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
}

export interface CaseProfile {
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
}
