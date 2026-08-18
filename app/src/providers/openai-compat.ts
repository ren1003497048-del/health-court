// OpenAI 兼容端点适配器（DeepSeek / Moonshot / OpenRouter / 自建 vLLM / Gemini 兼容层等）
// 无原生 web_search 时，search() 由调用方降级处理（见 pipeline/discover.ts）

import type { ChatMessage, ChatOptions, ChatResult, ProviderAdapter, SearchDoc } from './types';

export interface OpenAiCompatConfig {
  apiKey: string;
  baseUrl: string; // 例 https://api.deepseek.com/v1
  model: string;
}

export function createOpenAiCompatProvider(cfg: OpenAiCompatConfig): ProviderAdapter {
  const base = cfg.baseUrl.replace(/\/$/, '');
  return {
    name: 'openai-compat',
    async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
      const body: Record<string, unknown> = {
        model: cfg.model,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 4096,
      };
      if (opts.webSearch) {
        // 交给端点自定义（OpenRouter 等支持 models 参数），尽力而为
        body.web_search_options = {};
      }
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`openai-compat ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data = (await res.json()) as any;
      return {
        content: data.choices?.[0]?.message?.content ?? '',
        model: data.model,
        usage: data.usage
          ? { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens }
          : undefined,
      };
    },
    async search(query: string): Promise<{ answer: string; docs: SearchDoc[] }> {
      // 通用端点无搜索能力时抛出，由 pipeline 降级
      throw new Error('openai-compat 供应商无搜索能力，请在设置中配置 GLM 或 Jina 搜索');
    },
  };
}

// Jina Reader / s.jina.ai 抓取与搜索（可配 Key 提额，无 Key 有免费档）
export interface JinaConfig {
  apiKey?: string;
}

export function createJinaFetcher(cfg: JinaConfig = {}) {
  return {
    async fetchDoc(url: string): Promise<{ title: string; text: string }> {
      const headers: Record<string, string> = { Accept: 'text/plain' };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      const res = await fetch(`https://r.jina.ai/${url}`, { headers });
      if (!res.ok) throw new Error(`jina reader ${res.status}`);
      const text = await res.text();
      // Title: 行解析
      let title = '';
      const m = text.match(/^Title:\s*(.*)$/m);
      if (m) title = m[1].trim();
      const body = text
        .replace(/^Title:\s*.*$/m, '')
        .replace(/^URL Source:\s*.*$/m, '')
        .replace(/^Markdown Content:\s*$/m, '')
        .trim();
      return { title, text: body };
    },
    async search(query: string): Promise<{ answer: string; docs: SearchDoc[] }> {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      const res = await fetch('https://s.jina.ai/', {
        method: 'POST',
        headers,
        body: JSON.stringify({ q: query }),
      });
      if (!res.ok) throw new Error(`s.jina.ai ${res.status}`);
      const data = (await res.json()) as any;
      const docs: SearchDoc[] = (data.data || [])
        .map((d: any) => ({
          title: String(d.title || ''),
          url: String(d.url || ''),
          snippet: String(d.description || d.content || '').slice(0, 400),
          date: d.publishedAt || undefined,
        }))
        .filter((d: SearchDoc) => /^https?:\/\//.test(d.url));
      return { answer: '', docs };
    },
  };
}
