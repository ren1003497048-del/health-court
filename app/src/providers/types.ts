// 卫生法庭 · 供应商适配层
// 设计公理约束：本层只做“能力接口”，不做任何证据判断。
// Key 仅存用户浏览器 localStorage；Node 测试环境由调用方注入。

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** 启用 GLM web_search 工具（仅 GLM 适配器生效） */
  webSearch?: boolean;
  /** 返回原文（不剥离思考），默认剥离 */
  raw?: boolean;
  /** 禁用思考模式（思考模型 JSON 输出场景：reasoning 烧光 max_tokens 致 content 为空） */
  thinkingDisabled?: boolean;
}

export interface ChatResult {
  content: string;
  model: string;
  usage?: { prompt: number; completion: number };
}

export interface SearchDoc {
  title: string;
  url: string;
  snippet: string;
  date?: string;
}

export interface ProviderAdapter {
  readonly name: string;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  /** 综合搜索：返回带来源 URL 的搜索结果清单（GLM 经 web_search；其他实现可走 s.jina.ai） */
  search(query: string): Promise<{ answer: string; docs: SearchDoc[] }>;
}

export interface Fetcher {
  /** 网页 → 干净文本（默认 r.jina.ai Reader） */
  fetchDoc(url: string): Promise<{ title: string; text: string }>;
}

// ---------------------------------------------------------------------------
// JSON 输出纪律：所有分析调用走这里（PRD §7.3）
// ---------------------------------------------------------------------------

export async function chatJson<T>(
  chat: (messages: ChatMessage[], opts?: ChatOptions) => Promise<ChatResult>,
  system: string,
  user: string,
  opts?: { maxTokens?: number },
): Promise<T> {
  const maxTokens = Math.max(opts?.maxTokens ?? 4096, 4096);
  const attempt = async (strict: boolean, noThink: boolean) => {
    const r = await chat(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: strict ? user + '\n\n再次强调：只输出一个合法 JSON 对象，不要任何其他文字。' : user,
        },
      ],
      { temperature: 0.1, maxTokens, thinkingDisabled: noThink },
    );
    return extractJson(r.content);
  };
  // v3.8 P0-1: 首试即禁思考——JSON 场景思考模式零收益（烧 max_tokens + 超时），
  // 原「先思考再禁」的首试注定失败一次（XIUM8Z 指纹验证 10.3 分钟约 1/3 是注定重试）。
  // 兼容：不识别 thinking 参数的端点忽略该字段，无害。
  try {
    return await attempt(false, true);
  } catch {
    try {
      return await attempt(true, true);
    } catch {
      return await attempt(true, false);
    }
  }
}

export function extractJson(text: string): any {
  let t = text.trim();
  // 剥 ```json 围栏
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // 取第一个 { 到最后一个 } 的范围
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s === -1 || e === -1 || e <= s) throw new Error('no JSON object in LLM output');
  return JSON.parse(t.slice(s, e + 1));
}
