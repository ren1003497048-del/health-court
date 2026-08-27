// Serper 搜索适配（BYOK）。
// 这是纯前端静态应用：任何随包发布的共享密钥都会被访客读取，因此只接受用户自填 Key。
//
// v3.9.2 通道精细化修复（DBEE2E/LUV3FV 两案 79% 空结果根因治理）：
// 1. 引号清洗：实测 Serper 对长引号精确查询（"月到10月仅仅 两个月期间就发生了 142起暴力事件…"）
//    常返回空 organic——中文长引号串 + 多空格在 Google 侧几乎无命中。策略：引号段超 24 字符
//    自动截取其中最特异的 16-20 字符子串再加引号；无法截取则去引号降级为普通查询。
// 2. 429/403 带退避重试一次（免费档短时并发易触发）。
// 3. 失败分类： throw 带 SERPER_DEGRADED 前缀时上层（App.tsx）自动回落主模型内置检索。

import type { SearchDoc } from './types';

export interface SerperConfig {
  /** 用户自填 Key；不会随项目分发，也不会上传到项目方服务器。 */
  userApiKey?: string;
}

/** 引号查询清洗：过长引号段截特异子串，保引号语义但提高命中面 */
export function sanitizeSerperQuery(q: string): string {
  return q.replace(/"([^"]+)"/g, (full, seg: string) => {
    const s = String(seg).trim();
    if (s.length <= 24) return full; // 短引号段原样保留
    // 取中段 16-20 字符（中段最特异，首尾易被改写——与 R2c 的中段策略一致）
    const mid = s.replace(/\s+/g, ' ').slice(Math.floor(s.length / 2) - 9, Math.floor(s.length / 2) + 9).trim();
    return mid.length >= 12 ? `"${mid}"` : s.replace(/\s+/g, ' '); // 子串太短则去引号降级
  });
}

export function createSerperSearch(cfg: SerperConfig = {}) {
  const key = () => cfg.userApiKey?.trim() || '';
  // v3.9.2 连续空结果监测（LUV3FV 形态：200 但 organic 持续为空，无异常抛出）：
  // 连续 6 次空结果 → 抛 SERPER_DEGRADED 让上层回落。命中过结果即清零。
  let zeroStreak = 0;
  const request = async (query: string): Promise<Response> => {
    const attempt = () => fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': key(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 8 }),
    });
    const res = await attempt();
    if (res.status === 429 || res.status === 403) {
      // 退避 1.5s 重试一次（免费档限流多为短时窗口）
      await new Promise((r) => setTimeout(r, 1500));
      return attempt();
    }
    return res;
  };
  return {
    async search(query: string): Promise<{ answer: string; docs: SearchDoc[] }> {
      const k = key();
      if (!k) throw new Error('SERPER_KEY_REQUIRED：请到「设置 → 搜索取证」填写你自己的 Serper API Key，或改用主模型内置检索。');
      const cleaned = sanitizeSerperQuery(query);
      const res = await request(cleaned);
      if (res.status === 403) throw new Error('SERPER_DEGRADED 403：Key 被拒（无效或被封），已回落主模型内置检索');
      if (res.status === 429) throw new Error('SERPER_DEGRADED 429：配额耗尽/限流，已回落主模型内置检索');
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
      if (docs.length > 0) {
        zeroStreak = 0;
      } else {
        zeroStreak += 1;
        if (zeroStreak >= 6) throw new Error('SERPER_DEGRADED 空结果：连续 6 次搜索无任何返回（通道疑似被静默限流），已回落主模型内置检索');
      }
      return { answer: '', docs };
    },
  };
}
