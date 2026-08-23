// 设置与档案的 localStorage 存储（Key 只存用户浏览器，见 PRD §9）

import { MIN_ADMISSIBLE_EVIDENCE_GROUPS, isAdmissibleEvidence, normalizeEvidenceForSources } from '../court/evidence';

export interface ProviderSettings {
  kind: 'glm' | 'openai-compat' | 'deepseek' | 'gemini';
  apiKey: string;
  baseUrl: string;
  model: string;
  searchModel: string;
  jinaApiKey: string;
  /** 搜索通道：serper（用户自带 Key）/ provider（GLM/Gemini 内置） */
  searchProvider: 'serper' | 'provider';
  /** 用户自填 Serper Key；静态站点不分发共享密钥。 */
  serperApiKey: string;
  /** 语音转录：groq（免费注册）/ glm（复用GLM Key，需ASR额度） */
  asrKind: 'groq' | 'glm';
  groqApiKey: string;
}

export interface ModelPreset {
  id: string;
  kind: ProviderSettings['kind'];
  model: string;
  baseUrl: string;
  label: string;
  note: string;
  docsUrl: string;
}

/**
 * 主模型快捷方案（按 2026-08 官方模型页核对）。
 * 只提供可编辑预设，不替用户承诺免费额度、速率或账户可用性。
 */
export const MODEL_PRESETS: ModelPreset[] = [
  { id: 'glm-5.2-coding', kind: 'glm', model: 'glm-5.2', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', label: 'GLM-5.2｜Coding 套餐端点·推荐', note: 'GLM Coding Plan 订阅用户选此项（通用端点会报 1113 余额不足）。1M 长文本，适合完整节目和多源材料。', docsUrl: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2' },
  { id: 'glm-5.2', kind: 'glm', model: 'glm-5.2', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', label: 'GLM-5.2｜通用端点·按量付费', note: '旗舰语义理解与长程任务；需通用端点付费余额（Coding Plan 用户请选上面的套餐端点）。', docsUrl: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2' },
  { id: 'glm-4.7-coding', kind: 'glm', model: 'glm-4.7', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', label: 'GLM-4.7｜Coding 套餐端点·稳健 200K', note: 'Coding Plan 订阅用户适用；通用分析与推理较均衡。', docsUrl: 'https://docs.bigmodel.cn/cn/guide/start/model-overview' },
  { id: 'glm-4.7', kind: 'glm', model: 'glm-4.7', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', label: 'GLM-4.7｜通用端点·稳健·200K', note: '通用分析与推理较均衡；需通用端点付费余额。', docsUrl: 'https://docs.bigmodel.cn/cn/guide/start/model-overview' },
  { id: 'glm-4.7-flashx', kind: 'glm', model: 'glm-4.7-flashx', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', label: 'GLM-4.7-FlashX｜轻量·200K', note: '更适合高频试跑，仍需以账户实际权限为准。', docsUrl: 'https://docs.bigmodel.cn/cn/guide/start/model-overview' },
  { id: 'deepseek-v4-flash', kind: 'deepseek', model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', label: 'DeepSeek V4 Flash｜推荐·1M', note: '长上下文与吞吐优先，适合多轮证据整理。', docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing/' },
  { id: 'deepseek-v4-pro', kind: 'deepseek', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com', label: 'DeepSeek V4 Pro｜深度分析·1M', note: '复杂语义与抗辩优先，成本和可用额度以账户为准。', docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing/' },
  { id: 'gemini-3.7-flash', kind: 'gemini', model: 'gemini-3.7-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', label: 'Gemini 3.7 Flash｜推荐·稳定版', note: '长文本、结构化输出和多步骤分析兼顾。', docsUrl: 'https://ai.google.dev/gemini-api/docs/models' },
  { id: 'gemini-3.1-pro-preview', kind: 'gemini', model: 'gemini-3.1-pro-preview', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', label: 'Gemini 3.1 Pro｜高理解·预览版', note: '复杂推理优先；预览模型可能调整或下线。', docsUrl: 'https://ai.google.dev/gemini-api/docs/models' },
  { id: 'gpt-5.1', kind: 'openai-compat', model: 'gpt-5.1', baseUrl: 'https://api.openai.com/v1', label: 'OpenAI GPT-5.1｜高理解', note: '适合复杂判断；需 OpenAI API 权限。', docsUrl: 'https://platform.openai.com/docs/models' },
  { id: 'gpt-5-mini', kind: 'openai-compat', model: 'gpt-5-mini', baseUrl: 'https://api.openai.com/v1', label: 'OpenAI GPT-5 mini｜高频试跑', note: '速度和成本更平衡，也可改成任意兼容端点模型。', docsUrl: 'https://platform.openai.com/docs/models' },
];

export function presetsForProvider(kind: ProviderSettings['kind']): ModelPreset[] {
  return MODEL_PRESETS.filter((preset) => preset.kind === kind);
}

export function defaultPresetForProvider(kind: ProviderSettings['kind']): ModelPreset {
  return presetsForProvider(kind)[0];
}

export const DEFAULT_SETTINGS: ProviderSettings = {
  kind: 'glm',
  apiKey: '',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-5.2',
  searchModel: '',
  jinaApiKey: '',
  searchProvider: 'provider',
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
    const settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as ProviderSettings;
    // 旧版本曾让 Serper 依赖随包发布的共享密钥。对支持内置检索的模型做一次安全迁移；
    // 已填写自有 Key 的选择保持不变，避免改写用户的明确配置。
    if (
      settings.searchProvider === 'serper'
      && !settings.serperApiKey.trim()
      && (settings.kind === 'glm' || settings.kind === 'gemini')
    ) {
      settings.searchProvider = 'provider';
    }
    return settings;
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
      .map((v: any) => {
        const normalizedEvidence = normalizeEvidenceForSources(v?.evidence || [], v?.sources || []);
        const admitted = normalizedEvidence.filter(isAdmissibleEvidence).length;
        const required = v?.admission?.required ?? MIN_ADMISSIBLE_EVIDENCE_GROUPS;
        const originalWord = v?.verdict?.word || v?.verdictWord || '?';
        const insufficient = admitted < required && !['休庭', '不予受理'].includes(originalWord);
        return {
          caseId: v?.caseFile?.caseId || v?.caseId || '?',
          title: v?.caseFile?.target?.title || v?.title || '(无标题)',
          verdictWord: insufficient ? '不足立案' : originalWord,
          rule: insufficient ? `正式证据仅 ${admitted} 组，未达到 ${required} 组立案门槛` : (v?.verdict?.rule || v?.rule || ''),
          generatedAt: v?.generatedAt || '',
          evidenceCount: (v?.evidence || []).length ?? 0,
          e4: v?.verdict?.counts?.E4 ?? 0,
        };
      })
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
