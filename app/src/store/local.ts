// 设置与档案的 localStorage 存储（Key 只存用户浏览器，见 PRD §9）

export interface ProviderSettings {
  kind: 'glm' | 'openai-compat' | 'deepseek' | 'gemini';
  apiKey: string;
  baseUrl: string;
  model: string;
  searchModel: string;
  jinaApiKey: string;
  /** 搜索通道：serper（默认共享Key）/ provider（GLM/Gemini 内置） */
  searchProvider: 'serper' | 'provider';
  /** 用户自填 Serper Key（可选，覆盖共享 Key） */
  serperApiKey: string;
  /** 语音转录：groq（免费注册）/ glm（复用GLM Key，需ASR额度） */
  asrKind: 'groq' | 'glm';
  groqApiKey: string;
}

export const DEFAULT_SETTINGS: ProviderSettings = {
  kind: 'glm',
  apiKey: '',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-4-flash',
  searchModel: '',
  jinaApiKey: '',
  searchProvider: 'serper',
  serperApiKey: '',
  asrKind: 'groq',
  groqApiKey: '',
};

const SETTINGS_KEY = 'health-court.settings.v1';
const ARCHIVE_KEY = 'health-court.archive.v1';

export function loadSettings(): ProviderSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: ProviderSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export interface ArchiveEntryMeta {
  caseId: string;
  title: string;
  verdictWord: string;
  rule: string;
  generatedAt: string;
  evidenceCount: number;
  e4: number;
}

export function loadArchiveMetas(): ArchiveEntryMeta[] {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    if (!raw) return [];
    const obj = JSON.parse(raw) as Record<string, any>;
    return Object.values(obj)
      .map((v: any) => ({
        caseId: v?.caseFile?.caseId || v?.caseId || '?',
        title: v?.caseFile?.target?.title || v?.title || '(无标题)',
        verdictWord: v?.verdict?.word || v?.verdictWord || '?',
        rule: v?.verdict?.rule || v?.rule || '',
        generatedAt: v?.generatedAt || '',
        evidenceCount: (v?.evidence || []).length ?? 0,
        e4: v?.verdict?.counts?.E4 ?? 0,
      }))
      .sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1));
  } catch {
    return [];
  }
}

export function loadArchiveDoc(caseId: string): any | null {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj[caseId] || null;
  } catch {
    return null;
  }
}

export function saveToArchive(doc: any) {
  const raw = localStorage.getItem(ARCHIVE_KEY);
  const obj = raw ? JSON.parse(raw) : {};
  // 案卷正文可能大，仅保留判决必需字段（目标全文截断到 20000 字符）
  const slim = {
    ...doc,
    caseFile: {
      ...doc.caseFile,
      target: { ...doc.caseFile.target, text: String(doc.caseFile.target.text || '').slice(0, 20000), comments: undefined },
    },
    sources: (doc.sources || []).map((s: any) => ({ ...s, fullText: undefined })),
  };
  obj[doc.caseFile.caseId] = slim;
  localStorage.setItem(ARCHIVE_KEY, JSON.stringify(obj));
}

export function deleteFromArchive(caseId: string) {
  const raw = localStorage.getItem(ARCHIVE_KEY);
  if (!raw) return;
  const obj = JSON.parse(raw);
  delete obj[caseId];
  localStorage.setItem(ARCHIVE_KEY, JSON.stringify(obj));
}
