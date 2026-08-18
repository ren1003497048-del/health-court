// Serper 搜索适配（P0-2b）
// 默认共享 Key：本项目自有额度，混淆存放降低被脚本扫描盗用的概率；
// 配合前端节流（每会话限次）使用。额度受限（429/403）时 UI 引导用户注册自填（serper.dev 免费档 2500 次）。
// 用户自填 Key 时优先使用用户 Key。CORS 实测全开（2026-08-18）。

import type { SearchDoc } from './types';

const SHARED_KEY_B64 = 'NjNmNWQzM2RkNDVmMDJjYjA0MjM3ZDExMThhZDFkYjk0YTY0OGQ5OQ==§Y2x1ZS1zZXJwZXItZGVjb3I=';

function decodeSharedKey(): string {
  try {
    // § 前为真实 base64，§ 后为装饰段
    const clean = SHARED_KEY_B64.split('\u00a7')[0];
    return atob(clean);
  } catch {
    return '';
  }
}

const SESSION_LIMIT = 36; // 案件级预算（2026-08-19 用户拍板：MVP 不过分节约，R0-R4 五轮放开）
let sessionUsed = 0;

export function sharedSearchRemaining(): number {
  return Math.max(0, SESSION_LIMIT - sessionUsed);
}

export interface SerperConfig {
  /** 用户自填 Key（可选）。空则用共享 Key */
  userApiKey?: string;
}

export function createSerperSearch(cfg: SerperConfig = {}) {
  const key = () => cfg.userApiKey?.trim() || decodeSharedKey();
  return {
    async search(query: string): Promise<{ answer: string; docs: SearchDoc[] }> {
      const k = key();
      const isShared = !cfg.userApiKey?.trim();
      if (isShared && sessionUsed >= SESSION_LIMIT) {
        throw new Error('SHARED_QUOTA_EXCEEDED');
      }
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': k, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 8 }),
      });
      if (res.status === 403 || res.status === 429) {
        if (isShared) throw new Error('SHARED_QUOTA_EXCEEDED');
        throw new Error(`serper ${res.status}：请检查你的 Serper Key`);
      }
      if (!res.ok) throw new Error(`serper ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (isShared) sessionUsed++;
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
