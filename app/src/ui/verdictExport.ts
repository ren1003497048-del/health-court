// 判决书导出：自包含单文件 HTML。采用正式文书体例，减少框线并防止长文本/URL 溢出。

import type { VerdictDoc } from '../pipeline';
import { MIN_ADMISSIBLE_EVIDENCE_GROUPS, evidenceExclusionReason, isAdmissibleEvidence, normalizeEvidenceForSources, plainLevelName } from '../court/evidence';
import { stripMarkdownMedia } from '../court/chromeStrip';

function esc(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const clean = (value: unknown) => stripMarkdownMedia(String(value ?? '')).trim();
const safeHref = (value: unknown) => /^https?:\/\//i.test(String(value ?? '').trim()) ? esc(String(value).trim()) : '#';

function linkify(value: unknown): string {
  const text = clean(value).replace(/\bSRC(\d+)\b/gi, '候选源$1');
  const re = /(https?:\/\/[^\s；，。]+)/g;
  let last = 0;
  let html = '';
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    html += esc(text.slice(last, index));
    html += `<a href="${safeHref(match[0])}">打开原文 ↗</a>`;
    last = index + match[0].length;
  }
  return html + esc(text.slice(last));
}

function localTime(value: unknown): string {
  const date = new Date(String(value || ''));
  return Number.isNaN(date.getTime()) ? esc(String(value || '').replace('T', ' ').slice(0, 19)) : esc(date.toLocaleString('zh-CN', { hour12: false }));
}

const roleZh = (role: string) => ({ clerk: '书记员', evidence_officer: '证据官', prosecutor: '公诉人', defender: '辩护人', judge: '法官', court_clerk: '法官助理', orchestrator: '审判长' } as Record<string, string>)[role] || role;

function trialAction(action: string): string {
  const chars = action.match(/共\s*(\d+)\s*字符/)?.[1];
  if (/控方立论.*启动/.test(action)) return `开始整理控方证据${chars ? `（材料 ${chars} 字）` : ''}`;
  if (/控方立论.*完成/.test(action)) return '控方证据整理完成';
  if (/辩方驳斥.*启动/.test(action)) return `开始核对引用并提出抗辩${chars ? `（材料 ${chars} 字）` : ''}`;
  if (/辩方驳斥.*完成/.test(action)) return '辩方抗辩完成';
  if (/法官判词.*启动/.test(action)) return `开始复核控辩材料${chars ? `（材料 ${chars} 字）` : ''}`;
  if (/法官判词.*完成/.test(action)) return '裁决意见整理完成';
  return clean(action).replace(/\b(?:evidenceList|sourcesBrief|prosecutionBrief|citationMap|evidenceTop|citationNote|verdict)\b/gi, '材料').replace(/\b(?:EV|SRC|FP)\S*/g, '证据');
}

function overviewForExport(value: unknown, sources: number, admitted: number, total: number): string {
  const cleaned = clean(value);
  const statedAdmission = cleaned.match(/正式证据(?:组)?[（(]?\s*(\d+)/)?.[1];
  if (/(?:数据组合|证据)相似度|(?:相似度为?|similarity)\s*\d+\s*%/i.test(cleaned)
    || (statedAdmission !== undefined && Number(statedAdmission) !== admitted)) {
    return `已完成 ${sources} 个候选源核查；${admitted} 组正式查证，${Math.max(0, total - admitted)} 条线索未准入。相似度仅用于检索排序，不代表证据强度。`;
  }
  return cleaned;
}

export function buildVerdictHtml(doc: VerdictDoc | any): string {
  const v = doc.verdict;
  const cf = doc.caseFile;
  const evidence = normalizeEvidenceForSources(doc.evidence || [], doc.sources || []);
  const admitted = evidence.filter((e: any) => isAdmissibleEvidence(e));
  const required = doc.admission?.required ?? MIN_ADMISSIBLE_EVIDENCE_GROUPS;
  const displayWord = admitted.length < required && !['休庭', '不予受理'].includes(v.word) ? '不足立案' : v.word;
  const displayRule = displayWord === '不足立案'
    ? `正式证据仅 ${admitted.length} 组，未达到 ${required} 组立案门槛；现有内容仅作线索展示，不出具倾向性裁决`
    : v.rule;
  const overview = overviewForExport(doc.overview, (doc.sources || []).length, admitted.length, evidence.length);
  const limits = (doc.limits || []).filter((item: string) => !/^\s*【外界指控】/.test(String(item)));
  const color = displayWord === '不卫生' ? '#b0271a' : displayWord === '可能不卫生' ? '#986813' : displayWord === '可能卫生' || displayWord === '卫生' ? '#356b43' : displayWord === '不足立案' ? '#1749ae' : '#57503f';

  const sourceList = (doc.sources || []).map((s: any) => `<li><a href="${safeHref(s.url)}">${esc(clean(s.title) || '未命名来源')} ↗</a><span>${esc(s.subjectRelation === 'direct_source' ? '直接来源候选' : s.subjectRelation === 'same_event' ? '同一公共事件' : s.subjectRelation === 'same_topic' ? '同题材' : '关系待核')} · ${s.transcribed ? '全文转录比对' : s.partial ? '部分取证' : '页面正文比对'}</span></li>`).join('');

  const evidenceList = evidence.map((e: any, index: number) => {
    const accepted = isAdmissibleEvidence(e);
    const contextTarget = clean(e.detail?.contextTarget);
    const contextSource = clean(e.detail?.contextSource);
    const alsoSources = Array.isArray(e.detail?.alsoSources) ? e.detail.alsoSources : [];
    const systematicContributors = Array.isArray(e.detail?.systematicContributors) ? e.detail.systematicContributors : [];
    const systematicQuotes = systematicContributors.length > 0
      ? `<section class="systematic-quotes"><b>系统性对应的 ${systematicContributors.length} 组贡献原句（均已双侧定位）</b><ol>${systematicContributors.map((item: any) => `<li><div class="quote-grid"><blockquote><b>被检内容</b>${esc(clean(item.targetQuote))}</blockquote><blockquote><b>参照源文</b>${esc(clean(item.sourceQuote))}</blockquote></div></li>`).join('')}</ol></section>`
      : '';
    const representativeQuotes = (e.targetQuote || e.sourceQuote)
      ? `<div class="quote-grid">${e.targetQuote ? `<blockquote><b>被检内容</b>${esc(clean(e.targetQuote))}${e.targetQuoteLocated === false ? '<em>未定位</em>' : ''}</blockquote>` : ''}${e.sourceQuote ? `<blockquote><b>参照源文</b>${esc(clean(e.sourceQuote))}${e.sourceQuoteLocated === false ? '<em>未定位</em>' : ''}</blockquote>` : ''}</div>`
      : '';
    return `<article class="evidence ${accepted ? 'admitted' : 'clue'}"><header><span class="ordinal">${accepted ? '正式查证组' : '辅助线索'} ${String(index + 1).padStart(2, '0')}</span><strong>${esc(e.plainTitle || e.kind || plainLevelName(e.level))}</strong><span class="nature">${accepted ? (e.level === 'E1' ? '负面查证' : plainLevelName(e.level)) : esc(evidenceExclusionReason(e) || '线索级')}</span></header><p class="description">${esc(clean(e.description))}</p>${e.examNote ? `<p class="review"><b>检定理由：</b>${esc(clean(e.examNote))}</p>` : ''}${e.sourceTitle ? `<p class="source-ref"><b>主要对比源：</b><a href="${safeHref(e.sourceUrl)}">${esc(clean(e.sourceTitle))} ↗</a>${e.sourceTranscribed ? '（全文转录比对）' : '（页面文本比对）'}</p>` : ''}${alsoSources.length > 1 ? `<div class="also"><b>同一对应的其他来源：</b>${alsoSources.filter((s: any) => s.sourceId !== e.sourceId).map((s: any) => `<a href="${safeHref(s.sourceUrl)}">${esc(clean(s.sourceTitle) || s.sourceId)} ↗</a>`).join('；')}</div>` : ''}${systematicQuotes || representativeQuotes}${(contextTarget || contextSource) ? `<div class="context"><b>核验上下文${e.detail?.contextVerified ? '（机械定位通过）' : ''}</b>${contextTarget ? `<p><span>被检内容</span>${esc(contextTarget)}</p>` : ''}${contextSource ? `<p><span>参照源文</span>${esc(contextSource)}</p>` : ''}</div>` : ''}</article>`;
  }).join('');

  const claims = (doc.externalClaims || []).map((claim: any) => `<li><a href="${safeHref(claim.url)}">${esc(clean(claim.title))} ↗</a>${claim.snippet ? `<p>${esc(clean(claim.snippet))}</p>` : ''}</li>`).join('');
  const appendixItems = ((doc as any).appendix?.items || []) as any[];
  const appendix = appendixItems.length > 0
    ? `<section class="appendix-reading"><header class="appendix-head"><span class="appendix-eyebrow">附录</span><h3 class="appendix-title">延伸阅读</h3><p class="appendix-intro">${esc(clean((doc as any).appendix.intro))}</p></header><ol class="appendix-list">${appendixItems.map((it: any, i: number) => `<li class="appendix-item"><div class="appendix-item-head"><span class="appendix-ordinal">${String(i + 1).padStart(2, '0')}</span><a href="${safeHref(it.url)}">${esc(clean(it.title))} ↗</a><span class="appendix-tier">${esc(it.tier)}</span><span class="appendix-form">${esc(it.form)}</span></div><p class="appendix-note">${esc(clean(it.note))}</p></li>`).join('')}</ol></section>`
    : '';
  const debate = (doc.debateRounds || []).map((round: any) => `<section class="debate-round"><b>第 ${esc(round.round)} 轮</b><p><span>公诉人</span>${esc(clean(round.prosecution))}</p><p><span>辩护人</span>${esc(clean(round.defense))}</p></section>`).join('');
  const trialLog = (cf.trialLog || []).map((entry: any) => `<li><time>${localTime(entry.at)}</time><b>${esc(roleZh(entry.role))}</b><span>${esc(trialAction(String(entry.action || '')))}</span></li>`).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>判决书 ${esc(cf.caseId)} · 卫生法庭</title><style>
:root{--ink:#1b1a18;--soft:#625d54;--line:#d9d3c6;--paper:#fbfaf6;--accent:${color}}*{box-sizing:border-box;min-width:0}html{background:#eeeae1}body{margin:0;color:var(--ink);font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif;line-height:1.82;overflow-wrap:anywhere}a{color:#1749ae;text-decoration-thickness:1px;text-underline-offset:2px;overflow-wrap:anywhere}.doc{width:min(920px,calc(100% - 32px));margin:24px auto;background:#fff;padding:54px 58px 64px;box-shadow:0 14px 42px rgba(30,26,20,.1)}h1,h2,h3,.verdict-word{font-family:'Noto Serif SC','Songti SC',SimSun,serif}.masthead{display:grid;grid-template-columns:1fr auto;gap:20px;align-items:end;padding-bottom:20px;border-bottom:2px solid var(--ink)}.masthead h1{margin:0;font-size:30px;letter-spacing:.16em}.masthead p{margin:7px 0 0;color:var(--soft);font:700 13px/1.7 'Noto Serif SC',serif}.case-id{font-size:12px;color:var(--soft);font-variant-numeric:tabular-nums;text-align:right}.meta{margin:24px 0 0}.meta div{display:grid;grid-template-columns:104px minmax(0,1fr);gap:18px;padding:9px 0;border-bottom:1px solid var(--line)}.meta dt{font-weight:800}.meta dd{margin:0}.verdict{text-align:center;padding:40px 0 32px}.verdict-word{margin:0;color:var(--accent);font-size:56px;font-weight:900;letter-spacing:.12em}.verdict-rule{max-width:680px;margin:12px auto 0;color:var(--soft)}.admission{display:inline-grid;grid-template-columns:auto auto;gap:2px 12px;margin-top:18px;padding:10px 18px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.admission b{color:var(--accent);font-size:18px}.admission small{grid-column:1/-1;color:var(--soft)}h2{margin:34px 0 12px;padding-top:8px;border-top:2px solid var(--ink);font-size:20px;letter-spacing:.06em}.overview{margin:14px 0 20px;padding:12px 15px;background:var(--paper);border-left:4px solid var(--accent)}.source-list{padding-left:22px}.source-list li{margin:8px 0}.source-list span{display:block;color:var(--soft);font-size:12px}.evidence{position:relative;margin:0 0 18px;padding:16px 18px 17px;background:var(--paper);border-left:4px solid var(--accent);break-inside:avoid}.evidence.clue{border-left-color:#9d978b;background:#fcfbf8}.evidence header{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:8px}.ordinal{font-size:11px;font-weight:800;letter-spacing:.08em;color:var(--soft)}.nature{font-size:11px;color:var(--soft)}.description,.review,.source-ref{margin:6px 0}.review,.source-ref,.also{font-size:12.5px;color:var(--soft)}.quote-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px;margin-top:12px}.quote-grid blockquote{margin:0;padding:11px 13px;background:#fff;border:1px solid var(--line);white-space:pre-wrap;font-size:12.5px}.quote-grid b,.context>b{display:block;margin-bottom:5px;font-size:11px;letter-spacing:.1em}.quote-grid em{display:inline-block;margin-left:6px;color:#b0271a;font-style:normal}.systematic-quotes{margin-top:12px;padding-top:10px;border-top:1px solid var(--line)}.systematic-quotes>b{font-size:12px}.systematic-quotes ol{margin:4px 0 0;padding-left:24px}.systematic-quotes li{margin:0 0 10px}.systematic-quotes .quote-grid{margin-top:5px}.context{margin-top:10px;padding-top:9px;border-top:1px solid var(--line);font-size:12px;color:var(--soft)}.context p{margin:6px 0;white-space:pre-wrap}.context span{font-weight:800;margin-right:8px;color:var(--ink)}.claims,.limits{padding-left:22px}.claims li,.limits li{margin:7px 0}.claims p{margin:3px 0;color:var(--soft);font-size:12.5px}.debate-round{padding:12px 14px;margin:8px 0;background:var(--paper);break-inside:avoid}.debate-round p{display:grid;grid-template-columns:66px minmax(0,1fr);gap:8px;margin:7px 0}.debate-round span{font-weight:800}.trial-log{list-style:none;padding:0}.trial-log li{display:grid;grid-template-columns:154px 76px minmax(0,1fr);gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:12px}.trial-log time{font-variant-numeric:tabular-nums;color:var(--soft)}.appendix-reading{margin-top:34px;border:1.5px solid var(--ink);padding:18px 20px 14px;break-inside:avoid}.appendix-head{border-bottom:1px solid var(--ink);padding-bottom:10px}.appendix-eyebrow{display:block;font-size:11px;letter-spacing:.5em;color:var(--soft);margin-bottom:4px}.appendix-title{margin:0;font-weight:900;font-size:19px;letter-spacing:.12em}.appendix-intro{margin:8px 0 0;font-size:12.5px;color:var(--soft);line-height:1.8}.appendix-list{list-style:none;margin:0;padding:0}.appendix-item{padding:14px 0 12px;border-bottom:1px dashed var(--line)}.appendix-item:last-child{border-bottom:none}.appendix-item-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.appendix-ordinal{font-family:'Noto Serif SC',serif;font-weight:900;font-size:15px}.appendix-item-head a{font-weight:700;font-size:15px}.appendix-tier{font-size:11px;border:1px solid var(--ink);padding:1px 8px;border-radius:999px;letter-spacing:.1em;white-space:nowrap}.appendix-form{font-size:11.5px;color:var(--soft);white-space:nowrap}.appendix-note{margin:8px 0 0;font-size:13.5px;line-height:1.9}@media(max-width:640px){.appendix-reading{padding:14px 12px 10px}}.disclaimer{margin-top:34px;padding:14px 16px;background:var(--paper);border-top:1px solid var(--ink);font-size:12px;color:var(--soft)}.footer{margin-top:28px;text-align:center;color:var(--soft);font-size:11px;letter-spacing:.08em}@media(max-width:640px){.doc{width:100%;margin:0;padding:32px 20px 42px;box-shadow:none}.masthead{grid-template-columns:1fr}.case-id{text-align:left}.meta div{grid-template-columns:82px minmax(0,1fr)}.verdict-word{font-size:42px}.quote-grid{grid-template-columns:1fr}.trial-log li{grid-template-columns:82px 58px minmax(0,1fr)}.debate-round p{grid-template-columns:58px minmax(0,1fr)}}@page{margin:18mm}@media print{html{background:#fff}.doc{width:auto;margin:0;padding:0;box-shadow:none}a{color:inherit}.evidence{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
</style></head><body><main class="doc"><header class="masthead"><div><h1>卫生法庭判决书</h1><p>适度创作益脑，沉迷AI伤身。拒绝循环文本，守护精神卫生。</p></div><div class="case-id">案号 ${esc(cf.caseId)}<br>生成 ${localTime(doc.generatedAt)}</div></header><dl class="meta"><div><dt>核查标的</dt><dd>${esc(clean(cf.target.title))}</dd></div><div><dt>来源页</dt><dd>${cf.target.url ? `<a href="${safeHref(cf.target.url)}">打开被检页面 ↗</a>` : '粘贴文本'}</dd></div><div><dt>案情摘要</dt><dd>${esc(clean(cf.profile?.summaryZh) || '—')}</dd></div><div><dt>来源标注</dt><dd>${esc(v.attribution)}</dd></div></dl><section class="verdict"><p class="verdict-word">${esc(displayWord)}</p><p class="verdict-rule">${esc(clean(displayRule))}</p><div class="admission"><span>正式查证</span><b>${admitted.length} / ${required} 组</b><small>${admitted.length >= required ? '达到立案门槛' : '不足立案，仅展示线索'}</small></div></section>${overview ? `<div class="overview"><b>总体对应形态｜</b>${esc(overview)}</div>` : ''}${sourceList ? `<h2>候选来源</h2><ol class="source-list">${sourceList}</ol>` : ''}<h2>证据与线索（${evidence.length}）</h2>${evidenceList || '<p>本案没有可展示的查证记录。</p>'}${claims ? `<h2>外界指控材料</h2><p>仅列与被检主体直接相关且符合报道体例的公开材料；不替代原文比对。</p><ol class="claims">${claims}</ol>` : ''}${debate ? `<h2>控辩记录</h2>${debate}` : ''}<h2>法官意见</h2><p>${esc(clean(doc.opinion))}</p><h2>核查范围与局限</h2><ul class="limits">${limits.map((item: string) => `<li>${linkify(item)}</li>`).join('')}</ul>${trialLog ? `<h2>庭审记录</h2><ol class="trial-log">${trialLog}</ol>` : ''}${appendix}<div class="disclaimer">${esc(clean(doc.disclaimer))}</div><footer class="footer">卫生法庭 · 文本来源核查 · ${esc(cf.caseId)}</footer></main></body></html>`;
}

export function downloadVerdictHtml(doc: VerdictDoc | any) {
  const html = buildVerdictHtml(doc);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `卫生法庭判决书_${doc.caseFile?.caseId || 'case'}.html`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------------------
// v3.7 核查摘要（可转述交付物）：纯函数，从 VerdictDoc 现有字段生成 ~200 字纯文本，
// 可直接粘贴豆瓣/微博/微信。零新增 LLM 调用（overview 复用导出侧同款清洗）。
// 内容规范见协作基点文档「复制核查摘要」节（2026-08-23 定稿）。
// ---------------------------------------------------------------------------

const SHARE_URL = 'https://ren1003497048-del.github.io/health-court/';

/** 中文句读边界截断（。！？；），不切在词中间 */
function clipAtSentence(value: string, max: number): string {
  const t = value.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 10); // 略放宽后回找句末
  const m = cut.match(/^(.*[。！？；])/);
  const seg = m ? m[1] : t.slice(0, max);
  return seg.length > max + 10 ? seg.slice(0, max) + '…' : seg;
}

/** 摘要文本零内部代号（公理2）：FP/SRC/类型码白话化 */
const humanizeForShare = (value: string) => clean(value)
  .replace(/\bFP(\d+)\b/g, '指纹')
  .replace(/\bSRC(\d+)\b/g, '候选来源')
  .replace(/[（(]\s*(data_combo|rare_case|weird_term|analogy|joke|ordering|other)\s*[）)]/g, '')
  .replace(/\b(data_combo|rare_case|weird_term|analogy|ordering)\b/g, '指纹');

function shareTime(value: unknown): string {
  const d = new Date(String(value || ''));
  if (Number.isNaN(d.getTime())) return String(value || '').slice(0, 16).replace('T', ' ');
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function buildShareSummary(doc: VerdictDoc | any): string {
  const v = doc.verdict || {};
  const cf = doc.caseFile || {};
  const evidence = normalizeEvidenceForSources(doc.evidence || [], doc.sources || []);
  const admitted = evidence.filter((e: any) => isAdmissibleEvidence(e) && !(e.level === 'E1' && (e.detail as any)?.negative));
  const admittedAll = evidence.filter((e: any) => isAdmissibleEvidence(e));
  const required = doc.admission?.required ?? MIN_ADMISSIBLE_EVIDENCE_GROUPS;
  const word = String(v.word || '');
  const title = clipAtSentence(String(cf.target?.title || '').replace(/\s*[-–—|]\s*(独树不成林|Apple 播客).*$/, '').replace(/^["「]|["」]$/g, ''), 30);
  const accusatory = admitted.length; // 正面证据组（v3.5.1 口径）
  // overview 口径统一：与证据块同计（正面组数）——口径不一致时用确定性改写，避免摘要内自相矛盾
  const overviewRaw = String(doc.overview || '');
  const statedA = overviewRaw.match(/(\d+)\s*组(?:正式)?证据/)?.[1] ?? overviewRaw.match(/正式证据(?:组)?[（(]?\s*(\d+)/)?.[1];
  const overview = (statedA !== undefined && Number(statedA) !== accusatory)
    ? `已完成 ${(doc.sources || []).length} 个候选源核查；${accusatory} 组正式查证，${Math.max(0, evidence.length - admittedAll.length)} 条线索未准入。`
    : overviewForExport(doc.overview, (doc.sources || []).length, admittedAll.length, evidence.length);
  const time = shareTime(doc.generatedAt);

  // 证据段：按裁决差异化
  let evidenceBlock = '';
  const strongest = evidence.find((e: any) => e.examVerdict === 'expression_copy' && (e.plainTitle || e.description) && (e.targetQuote || e.sourceQuote));
  if (word === '不卫生' || word === '可能不卫生') {
    if (strongest) {
      // description 形如「FP8（data_combo）在 SRC1 命中：正文」——白话化后剥掉前缀只留正文
      const desc = clipAtSentence(humanizeForShare(strongest.description).replace(/^.*?命中[：:]\s*/, ''), 80);
      evidenceBlock = `最强证据（共 ${accusatory} 组正式证据，此处列 1 组）：\n${humanizeForShare(strongest.plainTitle || '具体对应')}\n${desc}\n来源：${clean(strongest.sourceTitle) || '见判决书'}（${String(strongest.sourceUrl || '').trim()}）`;
    } else {
      evidenceBlock = `共 ${accusatory} 组正式证据（详见判决书）。`;
    }
  } else if (word === '可能卫生') {
    const negative = evidence.filter((e: any) => e.level === 'E1' && (e.detail as any)?.negative).length;
    evidenceBlock = `正式证据 0 组；${negative > 0 ? `${(doc.sources || []).length} 个候选源中 ${negative} 个已逐段比对、均无对应` : `${(doc.sources || []).length} 个候选源比对范围内未发现对应`}。`;
  } else if (word === '不足立案') {
    evidenceBlock = `线索 ${evidence.length} 条，正式证据不足 ${required} 组，不出具倾向性裁决。`;
  } else if (word === '休庭') {
    evidenceBlock = '本案未能进入对质（内容不可得或无可比对候选）。';
  } else {
    evidenceBlock = `共 ${accusatory} 组正式证据（详见判决书）。`;
  }

  const border = `边界：检索不穷尽（版权墙/未数字化内容不可达），「${word}」为本次核查范围内的工作性结论，非法律认定。`;
  return [
    `【卫生法庭·核查摘要】${title}`,
    '',
    `裁决：${word}`,
    overview ? clipAtSentence(overview, 90) : '',
    '',
    evidenceBlock,
    '',
    border,
    `核查时间 ${time} · 卫生法庭 health-court（开源）${SHARE_URL}`,
  ].filter((x, i) => x !== '' || [1, 4, 6].includes(i)).join('\n');
}
