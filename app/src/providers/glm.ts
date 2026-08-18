// GLM 适配器（bigmodel，浏览器直连 CORS 已实测全开）
// 端点：通用 https://open.bigmodel.cn/api/paas/v4（glm-4-flash 免费档 + web_search）
//       coding https://open.bigmodel.cn/api/coding/paas/v4（GLM Coding Plan 套餐模型）

import type { ChatMessage, ChatOptions, ChatResult, ProviderAdapter, SearchDoc } from './types';

export interface GlmConfig {
  apiKey: string;
  /** 默认 https://open.bigmodel.cn/api/paas/v4 */
  baseUrl?: string;
  /** 默认 glm-4-flash */
  model?: string;
  /** 搜索专用模型（默认同 model） */
  searchModel?: string;
}

interface BigModelChoice {
  message?: { content?: string; reasoning_content?: string };
  delta?: { content?: string; reasoning_content?: string };
  finish_reason?: string;
}

export function createGlmProvider(cfg: GlmConfig): ProviderAdapter {
  const base = (cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, '');
  const model = cfg.model || 'glm-4-flash';

  async function callChat(
    messages: ChatMessage[],
    opts: ChatOptions,
    useModel: string,
    webSearch: boolean,
  ): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: useModel,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 4096,
    };
    if (webSearch) {
      // 2026-08-18 实测：enable:true 是模型真正联网的关键，缺省则静默不搜并可能编造
      body.tools = [{ type: 'web_search', web_search: { enable: true, search_result: true } }];
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
      throw new Error(`GLM ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      model: string;
      usage?: { prompt_tokens: number; completion_tokens: number };
      choices: BigModelChoice[];
    };
    const ch = data.choices?.[0];
    const msg = ch?.message;
    const rawContent = msg?.content ?? '';
    const reasoning = msg?.reasoning_content ?? '';
    const content = opts.raw ? reasoning + rawContent : rawContent;
    return {
      content,
      model: data.model,
      usage: data.usage
        ? { prompt: data.usage.prompt_tokens, completion: data.usage.completion_tokens }
        : undefined,
    };
  }

  return {
    name: 'glm',
    chat: (messages, opts = {}) => callChat(messages, opts, model, !!opts.webSearch),

    async search(query) {
      // 搜索走 web_search 工具：要求模型给出带 URL 的清单
      const system =
        '你是检索助手。联网搜索后回答。输出严格 JSON：{"answer":"综合答案(中文,简洁)","docs":[{"title":"网页标题","url":"完整URL","snippet":"要点摘要","date":"YYYY-MM-DD或空"}]}。docs 给 3-8 条你实际参考的网页，URL 必须真实来自搜索结果，禁止编造。';
      const r = await callChat(
        [
          { role: 'system', content: system },
          { role: 'user', content: `搜索并回答：${query}` },
        ],
        { temperature: 0.2, maxTokens: 2048 },
        cfg.searchModel || model,
        true,
      );
      let docs: SearchDoc[] = [];
      let answer = r.content;
      try {
        const s = r.content.indexOf('{');
        const e = r.content.lastIndexOf('}');
        const parsed = JSON.parse(r.content.slice(s, e + 1));
        answer = parsed.answer || answer;
        if (Array.isArray(parsed.docs)) {
          docs = parsed.docs
            .filter((d: any) => d && typeof d.url === 'string' && /^https?:\/\//.test(d.url))
            .map((d: any) => ({
              title: String(d.title || ''),
              url: String(d.url),
              snippet: String(d.snippet || ''),
              date: d.date ? String(d.date) : undefined,
            }));
        }
      } catch {
        /* 保持 answer 原文，docs 空 */
      }
      return { answer, docs };
    },
  };
}
