// 供应商适配：DeepSeek（OpenAI 兼容）与 Gemini（原生 REST）
// DeepSeek：chat ✓ / search ✗（无联网，检索自动降级）
// Gemini：chat ✓ / search ✓（google_search 原生工具）/ asr ✓（inlineData 音频直传）

import type { ChatMessage, ChatOptions, ChatResult, ProviderAdapter, SearchDoc } from './types';

// ---------------------------------------------------------------------------
// DeepSeek
// ---------------------------------------------------------------------------

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl?: string; // 默认 https://api.deepseek.com/v1
  model?: string; // 默认 deepseek-chat
}

export function createDeepSeekProvider(cfg: DeepSeekConfig): ProviderAdapter {
  const base = (cfg.baseUrl || 'https://api.deepseek.com/v1').replace(/\/$/, '');
  const model = cfg.model || 'deepseek-chat';
  return {
    name: 'deepseek',
    async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature ?? 0.3,
          max_tokens: opts.maxTokens ?? 4096,
        }),
      });
      if (!res.ok) throw new Error(`deepseek ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data: any = await res.json();
      return {
        content: data.choices?.[0]?.message?.content ?? '',
        model: data.model,
        usage: data.usage ? { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens } : undefined,
      };
    },
    async search(): Promise<{ answer: string; docs: SearchDoc[] }> {
      throw new Error('DeepSeek 无联网检索能力：请在设置中把「检索」指向 GLM 或 Gemini，或补充候选源');
    },
  };
}

// ---------------------------------------------------------------------------
// Gemini（原生 REST，CORS 开放）
// ---------------------------------------------------------------------------

export interface GeminiConfig {
  apiKey: string;
  model?: string; // 默认 gemini-2.0-flash
}

interface GeminiPart { text?: string }
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
}

export function createGeminiProvider(cfg: GeminiConfig): ProviderAdapter {
  const model = cfg.model || 'gemini-2.0-flash';
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${model}`;

  async function generate(body: Record<string, unknown>): Promise<GeminiResponse> {
    const res = await fetch(`${base}:generateContent?key=${cfg.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as GeminiResponse;
  }

  const toMessages = (messages: ChatMessage[]) => {
    // Gemini 无 system role：并入首条 user
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = messages.filter((m) => m.role !== 'system');
    const contents = rest.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    if (sys && contents.length) (contents[0].parts as GeminiPart[])[0].text = sys + '\n\n---\n\n' + contents[0].parts[0].text;
    return contents;
  };

  return {
    name: 'gemini',
    async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
      const body: Record<string, unknown> = {
        contents: toMessages(messages),
        generationConfig: {
          temperature: opts.temperature ?? 0.3,
          maxOutputTokens: opts.maxTokens ?? 4096,
        },
      };
      if (opts.webSearch) {
        body.tools = [{ google_search: {} }];
      }
      const data = await generate(body);
      const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      return {
        content: text,
        model,
        usage: data.usageMetadata
          ? { prompt: data.usageMetadata.promptTokenCount, completion: data.usageMetadata.candidatesTokenCount }
          : undefined,
      };
    },
    async search(query: string): Promise<{ answer: string; docs: SearchDoc[] }> {
      const system =
        '联网搜索后回答。输出严格 JSON：{"answer":"综合答案(中文,简洁)","docs":[{"title":"标题","url":"完整URL","snippet":"摘要","date":"YYYY-MM-DD或空"}]}，docs 给 3-8 条实际参考网页，URL 必须真实。';
      const data = await generate({
        contents: [{ role: 'user', parts: [{ text: `${system}\n\n搜索并回答：${query}` }] }],
        tools: [{ google_search: {} }],
      });
      const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      let docs: SearchDoc[] = [];
      let answer = text;
      try {
        const s = text.indexOf('{');
        const e = text.lastIndexOf('}');
        const parsed = JSON.parse(text.slice(s, e + 1));
        answer = parsed.answer || answer;
        if (Array.isArray(parsed.docs)) {
          docs = parsed.docs
            .filter((d: any) => d && /^https?:\/\//.test(String(d.url)))
            .map((d: any) => ({ title: String(d.title || ''), url: String(d.url), snippet: String(d.snippet || ''), date: d.date ? String(d.date) : undefined }));
        }
      } catch { /* answer 原文 */ }
      return { answer, docs };
    },
  };
}

// ---------------------------------------------------------------------------
// ASR：Groq（whisper-large-v3）与 GLM（glm-asr）
// ---------------------------------------------------------------------------

export interface AsrConfig {
  kind: 'groq' | 'glm';
  /** groq: Groq API key；glm: 复用 GLM key */
  apiKey: string;
  model?: string;
}

export interface AsrSegment {
  text: string;
  start: number;
  end: number;
}

/** 转录一个音频 Blob（WAV，16kHz 单声道）。返回带相对时间戳的分段。 */
export async function transcribeAudio(blob: Blob, cfg: AsrConfig): Promise<AsrSegment[]> {
  const model = cfg.model || (cfg.kind === 'groq' ? 'whisper-large-v3' : 'glm-asr');
  const url =
    cfg.kind === 'groq'
      ? 'https://api.groq.com/openai/v1/audio/transcriptions'
      : 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions';
  const form = new FormData();
  form.append('model', model);
  form.append('file', blob, 'chunk.wav');
  form.append('response_format', 'verbose_json');
  const res = await fetch(url, {
    method: 'POST',
    headers: cfg.kind === 'groq' ? { Authorization: `Bearer ${cfg.apiKey}` } : { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`asr(${cfg.kind}) ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  if (Array.isArray(data.segments)) {
    return data.segments.map((s: any) => ({ text: String(s.text || ''), start: Number(s.start || 0), end: Number(s.end || 0) }));
  }
  return [{ text: String(data.text || ''), start: 0, end: 0 }];
}

// ---------------------------------------------------------------------------
// iTunes lookup：Apple 单集页 → enclosure 音频 URL（CORS 全开，实测）
// ---------------------------------------------------------------------------

export async function itunesLookupEpisode(appleUrl: string): Promise<{
  podcastName: string;
  episodeTitle: string;
  enclosureUrl: string;
  durationMs: number;
  releaseDate: string;
} | null> {
  const m = appleUrl.match(/id(\d+)(?:\?i=(\d+))?/);
  if (!m) return null;
  const [, podcastId, episodeId] = m;
  const apiUrl = `https://itunes.apple.com/lookup?id=${episodeId ? episodeId : podcastId}&entity=podcastEpisode&country=CN&limit=200`;
  const res = await fetch(apiUrl);
  if (!res.ok) return null;
  const data: any = await res.json();
  const eps = (data.results || []).filter((r: any) => r.kind === 'podcast-episode' || r.episodeUrl);
  const feed = (data.results || []).find((r: any) => r.kind === 'podcast' || r.collectionName);
  let ep: any = null;
  if (episodeId) ep = eps.find((r: any) => String(r.trackId) === episodeId);
  if (!ep && eps.length) {
    // 无 i 参数时按标题匹配或取第一集
    ep = eps[0];
  }
  if (!ep || !ep.episodeUrl) return null;
  return {
    podcastName: ep.collectionName || feed?.collectionName || '',
    episodeTitle: ep.trackName || '',
    enclosureUrl: ep.episodeUrl,
    durationMs: ep.trackTimeMillis || 0,
    releaseDate: ep.releaseDate || '',
  };
}
