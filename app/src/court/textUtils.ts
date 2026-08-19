// 卫生法庭 · 内核层 · 文本工具
// 防幻觉引文定位：LLM 给出的每条引文必须能在对应文本中（模糊）定位，
// 定位失败即降级为 quoteLocated=false，判决书中明示「引文未定位」。

const PUNCT = /[，。、；：？！“”‘’「」『』（）()《》〈〉…—\-·,.;:?!"'`\s\u00a0]/g;

/**
 * v2.2 中文标点归一化（确定性兜底，配合提示词约束）：
 * 中文语境中的半角双引号 → 「」，半角逗号/冒号/分号/问号/叹号 → 全角。
 * 判定“中文语境”：该标点的前后任一字符为 CJK。英文引文整段不动的场景由前后字符决定，天然跳过。
 */
export function cjkPunctNormalize(text: string): string {
  const isCJK = (ch: string | undefined) => !!ch && /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch);
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = text[i - 1];
    const next = text[i + 1];
    const ctx = isCJK(prev) || isCJK(next);
    if (!ctx) {
      out += ch;
      continue;
    }
    // 成对半角双引号 → 「」（按出现次序奇偶配对）
    if (ch === '"') {
      out += (text.slice(0, i).split('"').length % 2 === 1) ? '「' : '」';
      continue;
    }
    if (ch === "'") {
      out += (text.slice(0, i).split("'").length % 2 === 1) ? '『' : '』';
      continue;
    }
    const map: Record<string, string> = { ',': '，', ':': '：', ';': '；', '?': '？', '!': '！', '(': '（', ')': '）' };
    out += map[ch] || ch;
  }
  return out;
}

/** 归一化：去标点空白、拉丁转小写、全角字母转半角 */
export function normalize(text: string): string {
  return text
    .replace(/[\uff01-\uff5e]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    .replace(PUNCT, '')
    .toLowerCase();
}

/** 精确（归一化后）子串定位 */
export function locateExact(quote: string, text: string): boolean {
  const q = normalize(quote);
  if (q.length < 4) return false; // 太短无意义
  return normalize(text).includes(q);
}

/** 滑动窗口模糊定位：归一化后按等长窗口找最高相似度 */
export function locateFuzzy(quote: string, text: string, threshold = 0.72): boolean {
  const q = normalize(quote);
  const t = normalize(text);
  if (q.length < 4 || t.length < q.length) return false;
  const window = q.length;
  let best = 0;
  const step = Math.max(1, Math.floor(window * 0.25));
  for (let i = 0; i + window <= t.length; i += step) {
    const r = similarity(q, t.slice(i, i + window));
    if (r > best) best = r;
    if (best >= threshold) return true;
  }
  return best >= threshold;
}

/**
 * 子序列比率：引文归一化后的全部字符按顺序（允许跳字）出现在全文中的比例。
 * 处理 LLM 摘录时省略中间片段（删节）的情况——等长窗口对此无能为力。
 * LCS 动态规划，两行滚动数组；引文短、全文长时复杂度 O(|q|·|t|) 可接受。
 */
export function lcsSubsequenceRatio(quote: string, text: string): number {
  const q = normalize(quote);
  const t = normalize(text);
  if (q.length === 0 || t.length === 0) return 0;
  let prev = new Array<number>(t.length + 1).fill(0);
  let cur = new Array<number>(t.length + 1).fill(0);
  for (let i = 1; i <= q.length; i++) {
    const qc = q.charCodeAt(i - 1);
    for (let j = 1; j <= t.length; j++) {
      cur[j] = t.charCodeAt(j - 1) === qc ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[t.length] / q.length;
}

/**
 * 引文整体定位（ASR 鲁棒）：按句切分引文，逐句在全文中定位。
 * 引文常含句号而句号在 normalize 中被剥离后 bigram 断裂——但更常见的是
 * LLM 摘录引文时跨句拼接或改写标点，整段比对失败而各句仍在文中。
 * 规则：句子总数 ≥2 时，命中句占比 ≥60% 即整体命中；仅 1 句时走模糊窗口。
 */
export function locateBySentence(quote: string, text: string): boolean {
  const sentences = quote
    .split(/(?<=[。！？!?；;.])/)
    .map((s) => s.trim())
    .filter((s) => normalize(s).length >= 4);
  if (sentences.length === 0) return false;
  if (sentences.length === 1) {
    return locateFuzzy(sentences[0], text);
  }
  const hits = sentences.filter(
    (s) => normalize(text).includes(normalize(s)) || locateFuzzy(s, text),
  );
  return hits.length / sentences.length >= 0.6;
}

/** 字符二元组（bigram）Jaccard 相似度——对 ASR 错别字鲁棒 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

/** 引文定位总入口：精确 → 整段模糊 → 子序列(删节) → 分句定位 */
export function locateQuote(quote: string | undefined, text: string | undefined): boolean {
  if (!quote || !text) return false;
  if (locateExact(quote, text)) return true;
  if (locateFuzzy(quote, text)) return true;
  if (normalize(quote).length >= 6 && lcsSubsequenceRatio(quote, text) >= 0.85) return true;
  return locateBySentence(quote, text);
}

/** 按句界切段（中文~600字 / 英文~1200字符量级），供结构对齐用 */
export function segment(text: string, size: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  let buf = '';
  const sentences = clean.split(/(?<=[。！？.!?])\s*/);
  for (const s of sentences) {
    buf += s;
    if (buf.length >= size) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** 保守截断（保留头部+尾部，中间标注省略），控制 LLM 输入长度 */
export function truncateSmart(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = Math.floor(max * 0.3);
  return (
    text.slice(0, head) +
    '\n\n[……中间内容省略……]\n\n' +
    text.slice(text.length - tail)
  );
}

/** 从 Jina Reader 的 Markdown 输出解析标题与正文 */
export function parseJinaMarkdown(md: string): { title: string; body: string } {
  let title = '';
  let body = md;
  const m = md.match(/^Title:\s*(.+)$/m);
  if (m) title = m[1].trim();
  body = body
    .replace(/^Title:\s*.+$/m, '')
    .replace(/^URL Source:\s*.+$/m, '')
    .replace(/^Markdown Content:\s*$/m, '')
    .trim();
  if (!title) {
    const h = body.match(/^#\s+(.+)$/m);
    if (h) title = h[1].trim();
  }
  return { title, body };
}
