// Serper 搜索适配（BYOK）。
// 这是纯前端静态应用：任何随包发布的共享密钥都会被访客读取，因此只接受用户自填 Key。

import type { SearchDoc } from './types';

export interface SerperConfig {
  /** 用户自填 Key；不会随项目分发，也不会上传到项目方服务器。 */
  userApiKey?: string;
}

export function createSerperSearch(cfg: SerperConfig = {}) {
  const key = () => cfg.userApiKey?.trim() || '';
  return {
    async search(query: string): Promise<{ answer: string; docs: SearchDoc[] }> {
      const k = key();
      if (!k) throw new Error('SERPER_KEY_REQUIRED：请到「设置 → 搜索取证」填写你自己的 Serper API Key，或改用主模型内置检索。');
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': k, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 8 }),
      });
      if (res.status === 403 || res.status === 429) {
        throw new Error(`serper ${res.status}：请检查你的 Serper Key`);
      }
      if (!res.ok) throw new Error(`serper ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data: any = await res.json();
      const docs: SearchDoc[] = [
        ...(data.organic || []),
        ...(data.news || []),
      ]
        .filter((r: any) => r && r.link)
        .map((r: any) => ({
          title: String(r.title || ''),
          url: String(r.link),
          snippet: String(r.snippet || r.description || ''),
          date: r.date ? String(r.date) : undefined,
        }));
      return { answer: '', docs };
    },
  };
}
