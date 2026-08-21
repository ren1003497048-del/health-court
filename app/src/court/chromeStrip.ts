// 页面壳剥离（chrome stripping）：确定性剔除 Apple/平台页面的导航、国家列表、
// 播放器控件等页面 chrome，只留真实内容。
// T76WDM 案教训：21772 字的 Apple 页面壳（含 200+ 国家/地区切换列表）撑过预审字数门槛。

/** Apple 页面国家/地区列表段（"Suriname", "Trinidad and Tobago"…）：以链接行形式出现 */
const APPLE_LOCALE_LINK = /^[-*\s]*\[?(?:[A-Za-z .'()]+)\]?\(?[^)\n]*\)?$/;

/** 已知页面 chrome 行（Apple 导航/播放器/页脚） */
const CHROME_LINES = [
  '搜索', '主页', '新发现', '排行榜', '登录', '较快', '较慢', '向后跳', '向前跳', '静音',
  '播放', '单集网页', '信息', '节目', '频率', '相关单集', ' listeners', ' ratings',
];

/** 播放器倍速行（"1 倍 1x 0.8x 1x 1.3x…"） */
const SPEED_LINE = /^[\s\d.,x倍]+$/i;

/** 纯链接行（markdown 链接且锚文本是路径/导航词） */
const NAV_ANCHOR = /\[(?:搜索|主页|新发现|排行榜|新|new|home|charts|search)\]/i;

/** 国家名单特征（一批连续的 "[Title](url)" 行且 URL 含两字母 locale） */
const LOCALE_URL = /\/[a-z]{2}\/(new|search|home|charts)/i;

/**
 * 剥离 Jina/Markdown 抓页中不属于正文的媒体装饰。
 *
 * S60HBY 案中「[Image 9: 评论数](...svg)154」和 Politico 头图被扩进
 * 证据引文。这里仅删除图片、图标、媒体署名和孤立 CDN 地址，普通正文链接保留。
 */
export function stripMarkdownMedia(text: string): string {
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => line
      // 标准 Markdown 图片：![alt](url)
      .replace(/!\[[^\]]*\]\(https?:\/\/[^)]+\)/gi, '')
      // Jina 图片占位：[Image 9: 评论数](url)154 / [图片 1: ...](url)
      .replace(/\[(?:Image|图片)\s*\d*\s*:[^\]]*\]\(https?:\/\/[^)]+\)\s*\d*/gi, '')
      .trimEnd())
    .filter((line) => {
      const s = line.trim();
      if (!s) return true;
      if (/^https?:\/\/\S+\.(?:avif|gif|jpe?g|png|svg|webp)(?:\?\S*)?$/i.test(s)) return false;
      if (/^(?:image|photo|illustration)(?:\s+(?:by|credit|credits?)\b|\s*[：:])/i.test(s)) return false;
      if (/^（?(?:图片|插图|摄影)[：:]?\s*[^。]{0,80}）?$/i.test(s)) return false;
      return true;
    })
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 剥离页面壳。策略：
 * 1. 逐行过滤：chrome 词行 / 倍速行 / 导航锚点行 / locale 链接行
 * 2. 连续链接块折叠：连续 ≥5 行都是 markdown 链接 → 视为目录/列表 chrome，整块删除
 */
export function stripPageChrome(text: string): string {
  const lines = stripMarkdownMedia(text).split('\n');
  const out: string[] = [];
  let linkRun = 0;
  let linkRunStart = -1;

  const flushLinkRun = (endExclusive: number) => {
    if (linkRun > 0 && linkRunStart >= 0) {
      if (linkRun < 5) {
        // 短链接组（<5行）：视为正文引用，回填 [linkRunStart, endExclusive)
        for (let i = linkRunStart; i < endExclusive; i++) {
          // 但仍剔除 locale 导航链接（国家列表单行也可能混在短组里）
          if (LOCALE_URL.test(lines[i].trim())) continue;
          out.push(lines[i]);
        }
      }
      // ≥5 行的连续链接块 = 目录/国家列表 chrome，整块丢弃
    }
    linkRun = 0;
    linkRunStart = -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const s = raw.trim();
    if (!s) {
      flushLinkRun(i);
      out.push(raw);
      continue;
    }
    const isLink = /^(?:[-*+]|\d+\.)?\s*\[[^\]]*\]\([^)]*\)\s*$/.test(s);
    if (isLink) {
      if (linkRun === 0) linkRunStart = i;
      linkRun++;
      continue;
    }
    flushLinkRun(i);
    // chrome 词行
    if (CHROME_LINES.some((c) => s === c || s === `* ${c}` || s === `- ${c}`)) continue;
    // 倍速行（含列表前缀形式 "* 0.8x"）
    if (SPEED_LINE.test(s) || /^(?:[-*+]|\d+\.)?\s*[\d.]+x\s*$/i.test(s)) continue;
    // 导航锚点行
    if (NAV_ANCHOR.test(s)) continue;
    // 播放器控件行（向后跳/向前跳/播放组合）
    if (/^(向后跳|向前跳)(\s*播放)*\s*$/.test(s)) continue;
    // locale 链接行（残留）
    if (LOCALE_URL.test(s)) continue;
    out.push(raw);
  }
  flushLinkRun(lines.length);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 页面壳占比诊断：原文本 vs 剥离后长度（预审日志用） */
export function chromeRatio(original: string, stripped: string): number {
  if (!original.length) return 0;
  return 1 - stripped.length / original.length;
}
