// 判决书导出：自包含单文件 HTML（纸质文书风：纯白底、衬线、可截图传播；样式内联）
// CJK 排版规则：全角标点、无中文斜体、Noto SC 字体栈、line-height ≥ 1.7

import type { VerdictDoc } from '../pipeline';
import { EVIDENCE_LEVEL_INFO, plainLevelName } from '../court/evidence';

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildVerdictHtml(doc: VerdictDoc | any): string {
  const v = doc.verdict;
  const cf = doc.caseFile;
  const color =
    v.word === '不卫生' ? '#b0271a' : v.word === '可能不卫生' ? '#9a6b12' : v.word === '卫生' ? '#2f6b40' : '#57503f';

  // v2.2.1 代号白话化（与页面一致）
  const plainFpTypeX = (ty?: string) =>
    ({ weird_term: '异常用词', rare_case: '冷门案例', data_combo: '数据组合', analogy: '独特类比', joke: '专属玩笑', ordering: '罕见排序', other: '其他特征' } as Record<string, string>)[ty || ''] || ty || '';
  const plainExamX = (v?: string) =>
    ({ expression_copy: '独特表达复制', fact_relay: '事实转述（不构成定案依据）', generic_overlap: '宏观表达重合（不构成定案依据）', inconclusive: '无法判定' } as Record<string, string>)[v || ''] || '';
  const plainDesc = (d: string) => d
    .replace(/FP\d+S?\d*（([a-z_]+)）/g, (_m, ty) => `指纹（${plainFpTypeX(ty)}）`)
    .replace(/在 SRC(\d+) 命中/g, (_m, n) => `在候选源${n}中命中`)
    .replace(/← SRC(\d+)/g, (_m, n) => `← 候选源${n}`);

  const evidenceRows = (doc.evidence || []).filter((e: any) => e.level !== 'E1')
    .map(
      (e: any) => `
      <div class="ev">
        <div class="ev-head"><span class="lv ${e.level}">${esc(plainLevelName(e.level))}</span><span class="ev-id">${esc(e.kind)}</span>${e.examVerdict ? `<span class="ev-id">${e.examVerdict === 'expression_copy' ? '' : '（线索级）'}检定：${esc(plainExamX(e.examVerdict))}</span>` : ''}</div>
        <div class="ev-desc">${esc(plainDesc(e.description))}</div>
        ${e.examNote ? `<div class="cc">检定理由：${esc(e.examNote)}</div>` : ''}
        ${e.detail?.macro && Array.isArray(e.detail.mappings) && e.detail.mappings.length ? `<div class="cc" style="padding-left:10px;border-left:2px solid #ccc"><b>大纲逐项对应（${e.detail.mappings.length} 项）：</b>${e.detail.mappings.map((m: any) => `<div>· 第${m.item ?? ''}项：${esc(m.note || '')}${m.sourceExcerpt ? `——源摘录：${esc(String(m.sourceExcerpt).slice(0, 100))}…` : ''}</div>`).join('')}</div>` : ''}
        ${e.targetQuote ? `<div class="q"><span class="ql">目标引文</span>${esc(e.targetQuote)}${e.targetQuoteLocated === false ? '<span class="un">未定位</span>' : ''}</div>` : ''}
        ${e.sourceQuote ? `<div class="q"><span class="ql">源引文</span>${esc(e.sourceQuote)}${e.sourceQuoteLocated === false ? '<span class="un">未定位</span>' : ''}</div>` : ''}
        ${(() => {
          const cc = (doc.crossChecks || []).find((c: any) => c.evidenceId === e.id);
          return cc ? `<div class="cc">独立复核：巧合风险「${esc(cc.risk)}」——${esc(cc.note)}</div>` : '';
        })()}
      </div>`,
    )
    .join('\n');

  const sourcesRows = (doc.sources || [])
    .map(
      (s: any) =>
        `<tr><td>${esc(s.id)}</td><td>${esc(s.title)}${s.partial ? '（部分取证）' : ''}</td><td><a href="${esc(s.url)}">${esc(s.url.length > 60 ? s.url.slice(0, 57) + '…' : s.url)}</a></td><td>${esc(s.date || '—')}</td></tr>`,
    )
    .join('\n');

  const leadsRows = (cf.leads || [])
    .map(
      (l: any) =>
        `<div class="q"><span class="ql">${esc(l.id)} · ${l.kind === 'explicit_source_doubt' ? '来源怀疑' : l.kind === 'weird_term_confusion' ? '陌生说法困惑' : '其他可疑'}</span>${esc(l.quote)}<div class="cc">${esc(l.note)}（线报只作检索线索，不参与判级）</div></div>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>判决书 ${esc(cf.caseId)} · 卫生法庭</title>
<style>
  :root { --ink:#1c1a17; --soft:#57503f; --line:#d8d2c2; }
  * { box-sizing: border-box; }
  body { margin:0; background:#fff; color:var(--ink); font-family:'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif; line-height:1.8; }
  .doc { max-width: 860px; margin: 0 auto; padding: 48px 40px 60px; }
  h1,h2,h3 { font-family:'Noto Serif SC','Songti SC','SimSun',serif; }
  .head { text-align:center; border-bottom:3px double var(--ink); padding-bottom:18px; margin-bottom:26px; }
  .head h1 { font-size:26px; margin:0 0 6px; letter-spacing:.2em; }
  .head .sub { font-size:13px; color:var(--soft); }
  .head .fn { font-size:12px; color:var(--soft); margin-top:10px; }
  .verdict-hero { text-align:center; margin: 30px 0 26px; }
  .verdict-word { font-size:54px; font-weight:900; color:${color}; letter-spacing:.18em; font-family:'Noto Serif SC',serif; margin:0; }
  .verdict-rule { font-size:14px; color:var(--soft); max-width:620px; margin:8px auto 0; }
  .stamp { display:inline-block; border:4px double ${color}; color:${color}; padding:4px 18px; font-size:16px; letter-spacing:.3em; transform:rotate(-6deg); margin-top:12px; font-weight:900; font-family:'Noto Serif SC',serif; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; margin:12px 0 20px; }
  th,td { border:1.5px solid var(--ink); padding:7px 9px; text-align:left; vertical-align:top; }
  th { background:#f5f1e6; letter-spacing:.06em; }
  h2.sec { font-size:19px; margin:30px 0 10px; border-left:6px solid ${color}; padding-left:10px; }
  .ev { border:1.5px solid var(--ink); padding:12px 14px; margin-bottom:12px; page-break-inside:avoid; }
  .ev-head { display:flex; gap:8px; align-items:center; margin-bottom:6px; flex-wrap:wrap; }
  .lv { font-weight:900; font-size:12px; border:2px solid var(--ink); padding:1px 8px; letter-spacing:.08em; }
  .lv.E4 { background:#d93a2b; color:#fff; } .lv.E3 { background:#e8b93e; } .lv.E2 { background:#cfe3d4; } .lv.E1,.lv.E5 { background:#e8e4d8; }
  .ev-id { font-size:12px; color:var(--soft); font-weight:700; }
  .ev-desc { font-size:13.5px; margin-bottom:6px; }
  .q { background:#f8f5ec; border:1.5px solid var(--line); padding:8px 11px; font-size:13px; margin-top:6px; }
  .ql { display:block; font-size:11.5px; font-weight:900; letter-spacing:.2em; color:var(--soft); margin-bottom:2px; }
  .un { display:inline-block; font-size:11px; font-weight:700; color:#b0271a; border:1.5px solid #b0271a; padding:0 5px; margin-left:6px; }
  .cc { font-size:12.5px; color:var(--soft); margin-top:5px; }
  .limits li { margin-bottom:3px; font-size:13.5px; }
  .disclaimer { border:2px dashed var(--soft); background:#f8f5ec; padding:12px 16px; font-size:12.5px; color:var(--soft); margin-top:28px; line-height:1.85; }
  a { color:#2b5cad; word-break:break-all; }
  .foot { text-align:center; font-size:12px; color:var(--soft); margin-top:34px; border-top:1.5px solid var(--line); padding-top:12px; }
</style>
</head>
<body>
<div class="doc">
  <div class="head">
    <h1>卫生法庭判决书</h1>
    <div class="sub">案号 ${esc(cf.caseId)} · 宣判于 ${esc(String(doc.generatedAt).replace('T', ' ').slice(0, 19))}</div>
    <div class="fn">*「卫生法庭」应作「卫生服务队」（health corps）——本庭之名源自一次被复制的机器转录错误。</div>
  </div>

  <table>
    <tr><th style="width:96px">标的</th><td>${esc(cf.target.title)}</td></tr>
    <tr><th>来源页</th><td>${cf.target.url ? `<a href="${esc(cf.target.url)}">${esc(cf.target.url)}</a>` : '（粘贴文本）'}</td></tr>
    <tr><th>取证时间</th><td>${esc(String(cf.target.fetchedAt || '').replace('T',' ').slice(0,19)) || '—'}</td></tr>
    <tr><th>案情摘要</th><td>${esc(cf.profile?.summaryZh || '—')}</td></tr>
    <tr><th>来源标注</th><td>${esc(v.attribution)}${cf.attributionNote ? '：' + esc(cf.attributionNote) : ''}</td></tr>
    <tr><th>证据构成</th><td>错误照搬×${v.counts.E4} · 罕见材料×${v.counts.E3} · 论证链同构${v.counts.E2 ? '√' : '—'} · 句式直译×${v.counts.E5}</td></tr>
  </table>

  <div class="verdict-hero">
    <p class="verdict-word">${esc(v.word)}</p>
    <div class="stamp">卫生法庭 · 宣判</div>
    <p class="verdict-rule">${esc(v.rule)}</p>
  </div>

  ${doc.sources?.length ? `<h2 class="sec">候选源清单</h2>
  <table>
    <tr><th>ID</th><th>标题</th><th>URL</th><th>日期</th></tr>
    ${sourcesRows}
  </table>` : ''}

  <h2 class="sec">证据清单（${(doc.evidence || []).filter((e: any) => e.level !== 'E1').length}）</h2>
  ${(doc.evidence || []).filter((e: any) => e.level !== 'E1').length ? evidenceRows : '<p>本案无命中证据——见下方已查证清单。</p>'}
  ${(doc.evidence || []).filter((e: any) => e.level === 'E1').length ? `<h2 class="sec">已查证清单（${(doc.evidence || []).filter((e: any) => e.level === 'E1').length}）——查过但未发现对应</h2>${(doc.evidence || []).filter((e: any) => e.level === 'E1').map((e: any) => `<div class="ev" style="opacity:.75"><div class="ev-desc">${esc(e.description)}</div></div>`).join('\n')}` : ''}

  ${leadsRows ? `<h2 class="sec">群众线报（${cf.leads.length}）</h2>${leadsRows}` : ''}

  <h2 class="sec">法官意见</h2>
  <p style="font-size:14px">${esc(doc.opinion)}</p>

  <h2 class="sec">核查范围与局限</h2>
  <ul class="limits">
    ${(doc.limits || []).map((l: string) => `<li>${esc(l)}</li>`).join('\n')}
  </ul>

  <div class="disclaimer">${esc(doc.disclaimer)}</div>

  <div class="foot">
    卫生法庭 HEALTH COURT* · 机制严谨 × 呈现漫画 · 由用户浏览器本地生成 · ${esc(cf.caseId)}
  </div>
</div>
</body>
</html>`;
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
