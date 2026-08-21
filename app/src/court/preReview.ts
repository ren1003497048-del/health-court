// 归属预审（P0-1）：立案前验明正身。
// 规则（用户拍板 2026-08-18）：
//  - 无法验明正身 → 弹窗「请自行注意精神卫生」，不予受理
//  - 归属信息尽可能具体到年月日，供后续时间线判定
//  - 评定对象必须是相对独立、自身完整的文化内容（shownotes 等附属信息不算内容本体）

import type { PreReviewResult } from './evidence';

export interface PreReviewInput {
  url?: string;
  text?: string;
  fetched: { title: string; text: string; authorHint?: string; dateHint?: string };
}

/** 粘贴文本的统一受理门槛；立案、预审与界面提示共同引用。 */
export const MIN_TARGET_TEXT_CHARS = 100;

/** 平台已知模式：能从 URL/页面直接确定的归属 */
const PLATFORM_PATTERNS: Array<{ re: RegExp; platform: string; kind: 'podcast' | 'article' | 'video' | 'book' }> = [
  { re: /xiaoyuzhoufm\.com\/(episode|podcast)/, platform: '小宇宙', kind: 'podcast' },
  { re: /podcasts\.apple\.com/, platform: 'Apple Podcasts', kind: 'podcast' },
  { re: /podscript\.site|podscribe\.app|snipd\.com/, platform: '转录站', kind: 'podcast' },
  { re: /youtube\.com|youtu\.be/, platform: 'YouTube', kind: 'video' },
  { re: /bilibili\.com/, platform: 'Bilibili', kind: 'video' },
  { re: /mp\.weixin\.qq\.com/, platform: '微信公众号', kind: 'article' },
  { re: /douban\.com/, platform: '豆瓣', kind: 'article' },
  { re: /substack\.com/, platform: 'Substack', kind: 'article' },
  { re: /book\.douban|douban\.com\/subject/, platform: '豆瓣图书', kind: 'book' },
];

/** 从页面文本提取日期（精确到年月日优先） */
export function extractDate(text: string): { date?: string; precision: 'day' | 'month' | 'year' | 'none' } {
  const head = text.slice(0, 6000);
  // 2026年8月17日 / 2026-08-17 / 2026.8.17 / August 17, 2026
  let m = head.match(/(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*[日]?/);
  if (m) return { date: `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`, precision: 'day' };
  m = head.match(/(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月]?/);
  if (m) return { date: `${m[1]}-${String(m[2]).padStart(2, '0')}`, precision: 'month' };
  m = head.match(/(\d{4})\s*年/);
  if (m) return { date: m[1], precision: 'year' };
  return { precision: 'none' };
}

/** 判断页面文本是否只是"附属信息"而非内容本体（P0 核心：shownotes 不是正文）
 *  播客场景双判据（防"相关单集列表"撑字数，364案教训）：
 *  ① 页面声明的单集时长 × 中文语速(300字/分钟) 的 50% 下限；
 *  ② 绝对下限 4000 字。二者取严。 */
export function isSubstantialBody(
  text: string,
  kind: 'podcast' | 'article' | 'video' | 'book' | 'unknown',
  durationMinutes?: number,
): boolean {
  const clean = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, '');
  if (kind !== 'podcast') return clean.length >= MIN_TARGET_TEXT_CHARS;
  const abs = clean.length >= 4000;
  if (durationMinutes && durationMinutes > 0) {
    const expected = Math.floor(durationMinutes * 300 * 0.5);
    return clean.length >= Math.max(4000, expected);
  }
  return abs;
}

/** 从页面文本解析单集时长（分钟），供时长-字数比判据用 */
export function parseEpisodeMinutes(text: string): number | undefined {
  const head = text.slice(0, 5000);
  const m = head.match(/(\d+)\s*分钟/) || head.match(/(\d+)\s*min/i);
  if (m) return parseInt(m[1]);
  const h = head.match(/(\d+)\s*小时/);
  if (h) return parseInt(h[1]) * 60;
  return undefined;
}

/** 规则式预审（LLM 增强在 pipeline 里做，这里只做确定性判断） */
export function preReview(input: PreReviewInput): PreReviewResult {
  const url = input.url || '';
  const platformHit = PLATFORM_PATTERNS.find((p) => p.re.test(url));
  const { date, precision } = extractDate(input.fetched.text);

  const chain: PreReviewResult['attributionChain'] = {
    platform: platformHit?.platform,
    publishedDate: date,
    datePrecision: precision,
    evidenceNote: platformHit ? `URL 模式识别：${platformHit.platform}（${platformHit.kind}）` : 'URL 未能识别平台',
  };

  // 情形一：播客单集，但页面只有 shownotes —— 内容本体缺失，必须走转录
  if (platformHit?.kind === 'podcast') {
    const dur = parseEpisodeMinutes(input.fetched.text);
    if (!isSubstantialBody(input.fetched.text, 'podcast', dur)) {
    return {
      pass: false,
      attributionChain: chain,
      completeness: { isIndependentWork: true, hasSubstantialBody: false, note: '播客单集页面仅含简介（shownotes），不含内容本体（转录稿）。简介不是独立的、可供检验的知识输出。' },
      failNote: '本案为播客单集，但页面仅含节目简介——简介不是可供对质的内容本体。请让本庭尝试自动转录，或直接粘贴该单集的转录稿。',
      };
    }
  }

  // 情形二：粘贴文本过短
  if (!url && input.text && !isSubstantialBody(input.text, 'unknown')) {
    return {
      pass: false,
      attributionChain: chain,
      completeness: { isIndependentWork: false, hasSubstantialBody: false, note: '文本长度不足' },
      failNote: `提交的文本不构成相对独立、自身完整的文化内容（不少于 ${MIN_TARGET_TEXT_CHARS} 字）。片段、摘要、单条评论不足以构成评定对象。`,
    };
  }

  return {
    pass: true,
    attributionChain: chain,
    completeness: { isIndependentWork: true, hasSubstantialBody: true, note: '通过规则式预审（平台识别+内容量）' },
  };
}
