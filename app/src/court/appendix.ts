// v3.9 附录·延伸阅读（2026-08-25 用户拍板）：
// 把庭审检索入卷的高价值材料整理成末尾荐读清单——「检验维度」之外的「推荐维度」落地。
// 设计公理：
// 1. 与裁决解耦：选源不读裁决词，荐读语禁提抄袭/卫生/裁决——纯书目式
// 2. 零幻觉：卡片 URL/标题全部来自 rt.sources 真实抓取，LLM 只写简介
// 3. 失败不阻塞：LLM 单点失败时该源降级用已有 AI 摘要，附录照常生成
// 4. 荐读矿藏在预筛淘汰名单：通史/百科/学术源是证据噪音，恰是荐读金矿

import type { SourceDoc } from './types';

export type AppendixTier = '一手材料' | '系统梳理' | '媒体特稿' | '背景参考';

export interface AppendixItem {
  sourceId: string;
  title: string;
  url: string;
  tier: AppendixTier;
  /** 形态标注：如「英文 · 播客系列」「中文 · 学术文章」 */
  form: string;
  /** 100-500 字荐读语（书目式口吻） */
  note: string;
}

export const APPENDIX_MAX = 5;
export const APPENDIX_MIN = 3;

/** 层级判定（确定性）：域名/来源类型 → 质量分层（用户已拍板：一手>梳理>媒体>背景） */
export function tierOf(src: SourceDoc): AppendixTier {
  const url = String(src.url || '');
  const title = String(src.title || '');
  const origin = String((src as any).origin || '');
  // 一手材料：创作者官方域/同系列扩展（R5 带出的原作系列单集）/已转录的播客单集本身
  if (origin === 'series' || /podcasts\.apple\.com|open\.spotify\.com|music\.163\.com|xiaoyuzhoufm\.com/i.test(url)) return '一手材料';
  if (/([\w-]+\.)?(substack\.com|medium\.com|wordpress\.com|ghost\.io|blogspot\.com)/i.test(url)) return '一手材料';
  if (/作者|author|personal/i.test(title)) return '一手材料';
  // 系统梳理：学术/百科全书/长篇通史
  if (/wikipedia|britannica|\.edu\/|scholar|journal|university|history\.com|smithsonian|\.gov\//i.test(url)) return '系统梳理';
  // 媒体特稿：知名媒体域
  if (/nytimes|newyorker|atlantic|guardian|bbc|cnn|reuters|apnews|smithsonianmag|historyextra|\.edu\.cn|thepaper|lifeweek|bjnews/i.test(url)) return '媒体特稿';
  return '背景参考';
}

/** 形态标注（确定性，帮读者建立阅读预期） */
export function formOf(src: SourceDoc): string {
  const parts: string[] = [];
  const t = String(src.title || '');
  const url = String(src.url || '');
  const isEn = /^[\x00-\x7F\s]{8,}/.test(t) || /podcasts\.apple\.com\/us\//.test(url);
  parts.push(isEn ? '英文' : '中文');
  if ((src as any).transcribed || /podcast/i.test(url + t)) parts.push(/part\s*\d|ep\.?\s*\d|第.*期|系列/i.test(t) ? '播客系列' : '播客单集');
  else if (/wikipedia|britannica|\.edu\/|journal|scholar/i.test(url)) parts.push('百科/学术条目');
  else parts.push('文章');
  return parts.join(' · ');
}

/** 硬排除：被检目标本身 / 壳页 / 镜像 / 聚合页 / 无可用链接 */
function excluded(src: SourceDoc, targetUrl?: string): boolean {
  const url = String(src.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return true;
  if (targetUrl && url.replace(/\/+$/, '') === targetUrl.replace(/\/+$/, '')) return true;
  const fullText = String(src.fullText || '');
  const title = String(src.title || '');
  // 壳页：链接密度畸高（链接行占比 > 40%）
  const lines = fullText.split('\n').filter((l) => l.trim());
  if (lines.length > 8) {
    const linky = lines.filter((l) => /(https?:\/\/|\[|\]{1,2}\()/i.test(l)).length;
    if (linky / lines.length > 0.4) return true;
  }
  // 聚合页/搜索残渣
  if (/^(相关|更多|搜索结果|latest|home|index|list of|category)/i.test(title.trim())) return true;
  if ((src as any).mirrorOf) return true;
  return false;
}

/**
 * 选源（纯函数）：分层配额 + 质量排序 + 指纹相关性加成。
 * 与裁决无关——不读 evidence，只读 sources。
 */
export function selectAppendixSources(
  sources: SourceDoc[],
  targetUrl?: string,
  opts?: { max?: number },
): SourceDoc[] {
  const max = opts?.max ?? APPENDIX_MAX;
  const tierOrder: Record<AppendixTier, number> = { 一手材料: 0, 系统梳理: 1, 媒体特稿: 2, 背景参考: 3 };
  const seenUrl = new Set<string>();
  const pool = sources
    .filter((s) => !excluded(s, targetUrl))
    .filter((s) => {
      const u = String(s.url).replace(/\/+$/, '').toLowerCase();
      if (seenUrl.has(u)) return false;
      seenUrl.add(u);
      return true;
    });
  // 排序：层级优先 → 材料量（全文长度=信息密度代理）→ 相似度
  const ranked = [...pool].sort((a, b) => {
    const ta = tierOrder[tierOf(a)];
    const tb = tierOrder[tierOf(b)];
    if (ta !== tb) return ta - tb;
    const la = String(a.fullText || '').length;
    const lb = String(b.fullText || '').length;
    if (Math.abs(la - lb) > 2000) return lb - la;
    return (b.similarity ?? 0) - (a.similarity ?? 0);
  });
  // 配额：保证层级多样性（至少两类），单层不超过 2 张；候选层级单一时放开上限凑满
  const perTier = new Map<AppendixTier, number>();
  const picked: SourceDoc[] = [];
  const tierSet = new Set(pool.map(tierOf));
  const singleTierOnly = tierSet.size < 2;
  const perTierCap = singleTierOnly ? max : 2;
  for (const s of ranked) {
    if (picked.length >= max) break;
    const tier = tierOf(s);
    const n = perTier.get(tier) || 0;
    if (n >= perTierCap) continue;
    perTier.set(tier, n + 1);
    picked.push(s);
  }
  return picked;
}

/** 荐读语 LLM 提示词（书目式，禁裁决词）——正文在管线层组装调用 */
export const APPENDIX_NOTE_SYSTEM = `你是判决书附录「延伸阅读」的编者，为一个案子同场写多份材料的荐读卡。
每份材料 100-500 字，白话荐读，像书店店员给读者递书。
硬规则：
- 绝不提及：抄袭、洗稿、卫生、裁决、本案被告、与被检内容的关系——附录与裁决无关
- 只描述给定材料的真实内容，不得虚构章节/数据/人名；零内部代号；中文全角标点
去雷同规则（同一场内多张卡片严禁一个模子）：
- 开场三选一且同卷不得重复同一招：①以材料里一个具体可感的细节开场（某年某事件/某人物/某数字），禁用「这是XX关于XX的条目/节目」句式；②以作者/创作者是谁、为何可信开场；③以这份材料适合在什么情境下打开开场
- 中段侧重三选一且同卷错开：叙事结构梳理 / 史观与立场 / 讲述风格与听读体验
- 结尾句式同卷至少两种不同写法；「适合想XX的读者」这类套话全卷至多出现一次，其余用行动指令收尾（如「先读第X节」「从这期听起」）
- 每张卡至少点出一个只属于该材料的独有细节（其他百科也有的通史框架不算）
输出严格 JSON：{"note":"荐读语"}`;

/** 荐读语清洗：去首尾引号/空白，截 500 字 */
export function normalizeAppendixNote(raw: unknown): string {
  let t = String((raw as any)?.note ?? raw ?? '').trim();
  t = t.replace(/^["「『]+|["」』]+$/g, '');
  if (t.length > 500) t = t.slice(0, 500) + '…';
  return t;
}
