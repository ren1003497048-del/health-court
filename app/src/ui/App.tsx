import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { CaseFile, SourceDoc } from '../court/types';
import type { EvidenceItem, VerdictResult } from '../court/evidence';
import type { VerdictDoc } from '../pipeline';
import { EVIDENCE_LEVEL_INFO, NAMING_FOOTNOTE, PLAIN_CRITERIA, plainLevelName } from '../court/evidence';
import { DEFAULT_SETTINGS } from '../store/local';

export type Tab = 'court' | 'archive' | 'settings' | 'about';

const STAGES = ['立案', '侦查', '检索', '对质', '宣判'] as const;

export interface RunningState {
  stageIndex: number;
  logs: { stage: string; note: string; at: string }[];
  evidence: EvidenceItem[];
  fingerprints: number;
  sources: SourceDoc[];
  objection: string | null;
  shake: boolean;
}

export function App(): React.ReactElement {
  const [tab, setTabState] = useState<Tab>(() => {
    const h = (typeof location !== 'undefined' ? location.hash.replace('#', '') : '') as Tab;
    return ['court', 'archive', 'settings', 'about'].includes(h) ? h : 'court';
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    if (typeof history !== 'undefined') history.replaceState(null, '', '#' + t);
  };
  const [input, setInput] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [running, setRunning] = useState<RunningState | null>(null);
  const [verdictDoc, setVerdictDoc] = useState<VerdictDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mentalHygiene, setMentalHygiene] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  /** 播客单集自动转录：Apple→iTunes enclosure / 小宇宙→shownotes 内无音频则提示 */
  const logSinkRef = useRef<(stage: string, note: string) => void>(() => {});
  const tryTranscribe = async (cf: CaseFile, rt: any, s: any): Promise<boolean> => {
    try {
      const { itunesLookupEpisode, transcribeAudio } = await import('../providers/multi');
      const { transcribeAudioUrl } = await import('../pipeline/transcribe');
      let audioUrl = '';
      let meta: any = null;
      if (/podcasts\.apple\.com/.test(cf.input.url || '')) {
        meta = await itunesLookupEpisode(cf.input.url!);
        audioUrl = meta?.enclosureUrl || '';
        if (meta?.podcastName) cf.target.author = cf.target.author || meta.podcastName;
        if (meta?.releaseDate) cf.target.date = cf.target.date || meta.releaseDate.slice(0, 10);
      }
      if (!audioUrl) {
        logSinkRef.current('立案', '未能定位音频地址（该平台未提供可自动转录的音频通道）');
        return false;
      }
      logSinkRef.current('立案', `定位音频成功（${Math.round((meta?.durationMs || 0) / 60000)} 分钟），开始浏览器内转录…`);
      const asrKind: 'groq' | 'glm' = s.asrKind === 'glm' ? 'glm' : 'groq';
      const asrKey = asrKind === 'glm' ? s.apiKey : s.groqApiKey;
      if (!asrKey) {
        logSinkRef.current('立案', '未配置 ASR Key（设置 → 语音转录）：无法自动转录');
        return false;
      }
      const { segments, fullText, durationSec } = await transcribeAudioUrl(
        audioUrl,
        { kind: asrKind, apiKey: asrKey },
        (p) => logSinkRef.current('立案', `转录进度 ${p.doneChunks}/${p.totalChunks} 块（${p.currentMinutes}）`),
      );
      cf.target.text = fullText;
      cf.target.contentType = 'podcast_with_transcript';
      cf.target.degraded = false;
      cf.transcriptMeta = { audioUrl, durationSec, asrModel: asrKind === 'groq' ? 'whisper-large-v3' : 'glm-asr', transcribedAt: new Date().toISOString() };
      logSinkRef.current('立案', `转录完成：${fullText.length} 字符，${segments.length} 段`);
      return true;
    } catch (e: any) {
      logSinkRef.current('立案', `自动转录失败：${String(e.message).slice(0, 120)}`);
      return false;
    }
  };

  const scrollLog = useCallback(() => {
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  }, []);

  const run = useCallback(async () => {
    setError(null);
    setVerdictDoc(null);
    setRunning({ stageIndex: 0, logs: [], evidence: [], fingerprints: 0, sources: [], objection: null, shake: false });
    try {
      const { loadSettings } = await import('../store/local');
      const s = loadSettings();
      if (!s.apiKey) throw new Error('尚未配置 API Key。请到「设置」页填写（默认 GLM / glm-4-flash）。');
      const { createGlmProvider } = await import('../providers/glm');
      const { createOpenAiCompatProvider, createJinaFetcher } = await import('../providers/openai-compat');
      const { createDeepSeekProvider, createGeminiProvider } = await import('../providers/multi');
      const { createSerperSearch } = await import('../providers/serper');
      let provider;
      if (s.kind === 'glm') {
        provider = createGlmProvider({ apiKey: s.apiKey, baseUrl: s.baseUrl, model: s.model, searchModel: s.searchModel || undefined });
      } else if (s.kind === 'deepseek') {
        provider = createDeepSeekProvider({ apiKey: s.apiKey, model: s.model || 'deepseek-chat' });
      } else if (s.kind === 'gemini') {
        provider = createGeminiProvider({ apiKey: s.apiKey, model: s.model || 'gemini-2.0-flash' });
      } else {
        provider = createOpenAiCompatProvider({ apiKey: s.apiKey, baseUrl: s.baseUrl, model: s.model });
      }
      const fetcher = createJinaFetcher({ apiKey: s.jinaApiKey || undefined });
      // 搜索通道：serper（共享/自填 Key）；额度尽或选择 provider 时回落主模型内置搜索
      const serper = createSerperSearch({ userApiKey: s.serperApiKey || undefined });
      const originalSearch = provider.search.bind(provider);
      provider.search = async (query: string) => {
        if (s.searchProvider === 'serper') {
          try {
            return await serper.search(query);
          } catch (e: any) {
            if (String(e.message).includes('SHARED_QUOTA_EXCEEDED')) {
              pushLog('检索', '本庭共享搜索额度已用尽（每案 24 次）。可在设置中填入自己的 Serper Key（serper.dev 免费注册），或切换为主模型内置检索。');
            }
            throw e;
          }
        }
        return originalSearch(query);
      };

      const logs: RunningState['logs'] = [];
      let objTimer: number | undefined;
      const pushLog = (stage: string, note: string) => {
        logSinkRef.current = pushLog;
        logs.push({ stage, note, at: new Date().toISOString() });
        const stageIdx = STAGES.indexOf(stage as any);
        setRunning((r) =>
          r
            ? {
                ...r,
                logs: [...logs],
                stageIndex: stageIdx >= 0 ? stageIdx : r.stageIndex,
                // E3/E4 命中或指纹命中时演出「异议！」
                objection: /E[34] 指纹命中|E4/.test(note) ? (note.includes('E4') ? '異議あり！！' : '異議あり！') : r.objection,
                shake: /E4/.test(note) ? true : r.shake,
              }
            : r,
        );
        scrollLog();
        if (/E[34] 指纹命中/.test(note)) {
          objTimer = window.setTimeout(() => setRunning((r) => (r ? { ...r, objection: null } : r)), 1400);
        }
      };

      const rt = { provider, fetcher, log: pushLog, evidence: [] as EvidenceItem[], sources: [] as SourceDoc[] };
      const pipeline = await import('../pipeline');

      const inputObj = input.trim() ? { url: input.trim(), text: bodyText.trim() || undefined } : { text: bodyText };
      let cf: CaseFile;
      try {
        cf = await pipeline.filing(inputObj, rt);
      } catch (e: any) {
        if (e && e.preReviewFail) {
          setMentalHygiene(e.failNote || '');
          throw new Error('__MENTAL_HYGIENE__');
        }
        throw e;
      }
      // 预审弹窗（不通过且可转录时走转录；完全不可用时精神卫生提示）
      if (cf.preReview && !cf.preReview.pass) {
        const fail = cf.preReview;
        // 播客单集无内容本体 → 尝试自动转录
        if (!fail.completeness.hasSubstantialBody && fail.attributionChain.platform) {
          setRunning((r) => (r ? { ...r, stageIndex: 0 } : r));
          pushLog('立案', '页面仅含简介，本庭尝试自动转录音频以获取内容本体…');
          const transcribed = await tryTranscribe(cf, rt, s);
          if (!transcribed) {
            setMentalHygiene(fail.failNote || '');
            throw new Error('__MENTAL_HYGIENE__');
          }
          // 重新预审
          const review2 = await import('../court/preReview').then((m) =>
            m.preReview({ url: cf.input.url, text: cf.target.text, fetched: { title: cf.target.title, text: cf.target.text } }),
          );
          if (!review2.pass) {
            setMentalHygiene(review2.failNote || '');
            throw new Error('__MENTAL_HYGIENE__');
          }
          cf.preReview = review2;
        } else {
          setMentalHygiene(fail.failNote || '');
          throw new Error('__MENTAL_HYGIENE__');
        }
      }
      setRunning((r) => (r ? { ...r, stageIndex: 1 } : r));
      await pipeline.investigation(cf, rt);
      setRunning((r) => (r ? { ...r, stageIndex: 2, fingerprints: cf.fingerprints.length } : r));
      await pipeline.discovery(cf, rt);
      setRunning((r) => (r ? { ...r, stageIndex: 3, sources: rt.sources } : r));
      const evidence = await pipeline.crossExamination(cf, rt);
      setRunning((r) => (r ? { ...r, stageIndex: 4, evidence } : r));
      const doc = await pipeline.verdictStage(cf, rt, evidence);
      setVerdictDoc(doc);
      const { saveToArchive } = await import('../store/local');
      saveToArchive(doc);
    } catch (e: any) {
      if (String(e?.message) === '__MENTAL_HYGIENE__') {
        setRunning(null);
        return; // 弹窗已由 setMentalHygiene 触发
      }
      setError(String(e?.message || e));
      setRunning(null);
    }
  }, [input, bodyText, scrollLog]);

  return (
    <>
      <header className="court-header">
        <div className="court-header-inner">
          <div className="logo-block">
            <span className="logo-cn">
              卫生<span className="typo-mark">法庭</span>
            </span>
            <span className="logo-en">HEALTH COURT*</span>
          </div>
          <nav className="nav-tabs">
            {(['court', 'archive', 'settings', 'about'] as Tab[]).map((t) => (
              <button
                key={t}
                className={'nav-tab' + (tab === t ? ' active' : '')}
                onClick={() => setTab(t)}
              >
                {t === 'court' ? '开庭' : t === 'archive' ? '判例集' : t === 'settings' ? '设置' : '关于'}
              </button>
            ))}
          </nav>
        </div>
        <p className="naming-footnote-mini">
          <span className="typo-mark">*「法庭」应作「服务队」</span>——本庭之名源自一次被复制的机器转录错误（health corps → health court）。一个错误能被复制，就能被发现。
        </p>
      </header>

            {mentalHygiene && (
        <div className="objection-overlay" style={{ pointerEvents: 'auto', background: 'rgba(250,246,238,0.96)' }} onClick={() => setMentalHygiene(null)}>
          <div style={{ background: '#fff', border: 'var(--border)', boxShadow: 'var(--shadow)', padding: '34px 38px', maxWidth: 640, margin: '0 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🧠⚖️</div>
            <div style={{ fontFamily: 'var(--serif)', fontWeight: 900, fontSize: 26, marginBottom: 12 }}>请自行注意精神卫生</div>
            <p style={{ fontSize: 14.5, lineHeight: 1.9, margin: '0 0 16px', textAlign: 'left' }}>{mentalHygiene}</p>
            <div className="footnote-box" style={{ marginBottom: 18 }}>我们生活在需要格外注意精神卫生的时代。</div>
            <button className="btn" onClick={() => setMentalHygiene(null)}>我知道了</button>
          </div>
        </div>
      )}

      <main>
        {tab === 'court' && (
          <Courtroom
            input={input}
            setInput={setInput}
            bodyText={bodyText}
            setBodyText={setBodyText}
            running={running}
            verdictDoc={verdictDoc}
            error={error}
            run={run}
            logRef={logRef}
          />
        )}
        {tab === 'archive' && <Archive />}
        {tab === 'settings' && <Settings />}
        {tab === 'about' && <About />}
      </main>

      <footer className="footer">
        <div>卫生法庭 HEALTH COURT* · 机制严谨 × 呈现漫画 · 只从你的浏览器发出请求</div>
        <div>{NAMING_FOOTNOTE.slice(0, 80)}…（全文见「关于」页）</div>
      </footer>
    </>
  );
}

// ---------------------------------------------------------------------------
// 法庭主舞台
// ---------------------------------------------------------------------------

function Courtroom(props: {
  input: string;
  setInput: (s: string) => void;
  bodyText: string;
  setBodyText: (s: string) => void;
  running: RunningState | null;
  verdictDoc: VerdictDoc | null;
  error: string | null;
  run: () => void;
  logRef: React.RefObject<HTMLDivElement>;
}): React.ReactElement {
  const { input, setInput, bodyText, setBodyText, running, verdictDoc, error, run, logRef } = props;
  const [exporting, setExporting] = useState(false);

  const exportHtml = useCallback(async () => {
    if (!verdictDoc) return;
    setExporting(true);
    try {
      const mod = await import('./verdictExport');
      mod.downloadVerdictHtml(verdictDoc);
    } finally {
      setExporting(false);
    }
  }, [verdictDoc]);

  const exportJson = useCallback(() => {
    if (!verdictDoc) return;
    const blob = new Blob([JSON.stringify(verdictDoc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${verdictDoc.caseFile.caseId}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [verdictDoc]);

  return (
    <>
      {running?.objection && (
        <div className="objection-overlay">
          <div className="objection-text">{running.objection}</div>
        </div>
      )}

      <section className={'panel' + (running?.shake ? ' shake' : '')}>
        <h2 className="panel-title">提交案件</h2>
        <div className="input-row">
          <input
            className="input-main"
            placeholder="链接：播客单集 / 文章 / 有转录稿的节目页（首选，本庭自动取证与转录）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!!running}
          />
        </div>
        <div className="input-row" style={{ marginTop: 10 }}>
          <textarea
            className="input-main"
            placeholder="（可选）粘贴正文或转录稿——若你手头有现成文稿可跳过本庭的自动转录；粘贴文本时建议附上作者与发表信息（含年月日）"
            value={bodyText}
            onChange={(e) => setBodyText(e.target.value)}
            disabled={!!running}
          />
        </div>
        <div className="input-row" style={{ marginTop: 10 }}>
          <button className="btn btn-red" onClick={run} disabled={!!running || (!input.trim() && !bodyText.trim())}>
            {running ? '开庭中…' : '开 庭'}
          </button>
        </div>
        <p className="hint">
          评定对象须为相对独立、自身完整的文化内容整体：文字不少于 500 字，或音频不少于 5 分钟。
          播客单集若无现成转录稿，本庭将尝试自动转录（需在设置中配置 ASR）。
          检索面覆盖境外源时，建议在可访问国际网络的环境下使用，结果更全面。
        </p>
        {error && (
          <div className="key-warn" style={{ borderColor: 'var(--vermillion)', background: '#fbe3df' }}>
            {error}
          </div>
        )}
      </section>

      {running && (
        <section className="panel">
          <h2 className="panel-title">庭审进行中</h2>
          <div className="stage-bar">
            {STAGES.map((s, i) => (
              <div
                key={s}
                className={
                  'stage-chip' + (i < running.stageIndex ? ' done' : i === running.stageIndex ? ' current' : '')
                }
              >
                {s}
              </div>
            ))}
          </div>
          <div className="court-log" ref={logRef}>
            {running.logs.map((l, i) => (
              <div className="log-line" key={i}>
                <span className="stage-tag">[{l.stage}]</span>
                {l.note}
              </div>
            ))}
          </div>
        </section>
      )}

      {verdictDoc && (
        <VerdictView
          doc={verdictDoc}
          onExportHtml={exportHtml}
          onExportJson={exportJson}
          exporting={exporting}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 判决书
// ---------------------------------------------------------------------------

function VerdictView(props: {
  doc: VerdictDoc;
  onExportHtml: () => void;
  onExportJson: () => void;
  exporting: boolean;
}): React.ReactElement {
  const { doc, onExportHtml, onExportJson, exporting } = props;
  const v = doc.verdict;
  return (
    <>
      <section className="panel verdict-stage-panel focus-lines">
        <span className="gavel">🔨</span>
        <div className={'verdict-word ' + v.word}>{v.word}</div>
        <div className="stamp">卫生法庭 · 宣判</div>
        <p className="verdict-rule">{v.rule}</p>
        <p className="verdict-rule" style={{ fontSize: 13 }}>
          E1×{v.counts.E1} · E2×{v.counts.E2} · E3×{v.counts.E3} · E4×{v.counts.E4} · E5×{v.counts.E5} ｜ 来源标注：
          {v.attribution === 'complete' ? '完整' : v.attribution === 'partial' ? '部分' : v.attribution === 'none' ? '无' : '不明'}
        </p>
      </section>

      <section className="panel">
        <h2 className="panel-title">判决书 · {doc.caseFile.caseId}</h2>
        <table className="table" style={{ marginBottom: 14 }}>
          <tbody>
            <tr>
              <th style={{ width: 110 }}>标的</th>
              <td>{doc.caseFile.target.title}</td>
            </tr>
            <tr>
              <th>案情摘要</th>
              <td>{doc.caseFile.profile?.summaryZh || '—'}</td>
            </tr>
            <tr>
              <th>候选源</th>
              <td>
                {doc.sources.length === 0
                  ? '（无）'
                  : doc.sources.map((s) => (
                      <div key={s.id} style={{ marginBottom: 4 }}>
                        {s.id} 《{s.title}》 {s.partial ? '（部分取证）' : ''}{' '}
                        <a href={s.url} target="_blank" rel="noreferrer">
                          ↗
                        </a>
                      </div>
                    ))}
              </td>
            </tr>
          </tbody>
        </table>

        <h3 style={{ fontFamily: 'var(--serif)', fontWeight: 900, margin: '16px 0 8px' }}>证据清单（{doc.evidence.length}）</h3>
        {doc.evidence.length === 0 && <p className="hint">本案无命中证据。</p>}
        {doc.evidence.map((e) => (
          <div className="evidence-card" key={e.id}>
            <div className="evidence-head">
              <span className={'evidence-level ' + e.level}>{e.level} {plainLevelName(e.level)}</span>
              <span className="evidence-id">{e.id} · {e.kind}</span>
            </div>
            <div style={{ fontSize: 13.5 }}>{e.description}</div>
            {(e.targetQuote || e.sourceQuote) && (
              <div className="quote-pair">
                {e.targetQuote && (
                  <div className="quote-box target">
                    <span className="quote-label">目标引文</span>
                    {e.targetQuote}
                    {e.targetQuoteLocated === false && <span className="unlocated">未定位</span>}
                  </div>
                )}
                {e.sourceQuote && (
                  <div className="quote-box source">
                    <span className="quote-label">源引文</span>
                    {e.sourceQuote}
                    {e.sourceQuoteLocated === false && <span className="unlocated">未定位</span>}
                  </div>
                )}
              </div>
            )}
            {(() => {
              const cc = doc.crossChecks.find((c) => c.evidenceId === e.id);
              return cc ? (
                <div className="hint" style={{ marginTop: 6 }}>
                  独立复核：巧合风险「{cc.risk}」——{cc.note}
                </div>
              ) : null;
            })()}
          </div>
        ))}

        {doc.caseFile.leads.length > 0 && (
          <>
            <h3 style={{ fontFamily: 'var(--serif)', fontWeight: 900, margin: '16px 0 8px' }}>群众线报（{doc.caseFile.leads.length}）</h3>
            {doc.caseFile.leads.map((l) => (
              <div className="quote-box" style={{ marginBottom: 8 }} key={l.id}>
                <span className="quote-label" style={{ color: 'var(--ink-soft)' }}>
                  {l.id} · {l.kind === 'explicit_source_doubt' ? '来源怀疑' : l.kind === 'weird_term_confusion' ? '陌生说法困惑' : '其他可疑'}
                </span>
                {l.quote}
                <div className="hint">{l.note}（线报只作检索线索，不参与判级）</div>
              </div>
            ))}
          </>
        )}

        <h3 style={{ fontFamily: 'var(--serif)', fontWeight: 900, margin: '16px 0 8px' }}>法官意见</h3>
        <p style={{ margin: 0, lineHeight: 1.9 }}>{doc.opinion}</p>

        <h3 style={{ fontFamily: 'var(--serif)', fontWeight: 900, margin: '16px 0 8px' }}>核查范围与局限</h3>
        <ul style={{ margin: 0, paddingLeft: 22, lineHeight: 1.9 }}>
          {doc.limits.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>

        <div className="input-row" style={{ marginTop: 18 }}>
          <button className="btn" onClick={onExportHtml} disabled={exporting}>
            导出判决书 HTML
          </button>
          <button className="btn btn-ghost" onClick={onExportJson}>
            导出 JSON
          </button>
        </div>

        <div className="footnote-box" style={{ marginTop: 16 }}>
          {doc.disclaimer}
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// 判例集
// ---------------------------------------------------------------------------

function Archive(): React.ReactElement {
  const [metas, setMetas] = useState<ReturnType<typeof import('../store/local').loadArchiveMetas>>([]);
  const [doc, setDoc] = useState<any>(null);
  React.useEffect(() => {
    import('../store/local').then((m) => setMetas(m.loadArchiveMetas()));
  }, []);
  return (
    <>
      <section className="panel">
        <h2 className="panel-title">判例集</h2>
        {metas.length === 0 ? (
          <p className="hint">暂无判例。开庭后的判决会自动存入本浏览器（localStorage），可导出 JSON 备份。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>案号</th>
                <th>标的</th>
                <th>裁决</th>
                <th>E4</th>
                <th>时间</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {metas.map((m) => (
                <tr key={m.caseId}>
                  <td>{m.caseId}</td>
                  <td>{m.title.slice(0, 40)}</td>
                  <td>
                    <span className={'badge v-' + m.verdictWord}>{m.verdictWord}</span>
                  </td>
                  <td>{m.e4}</td>
                  <td>{m.generatedAt.slice(0, 16).replace('T', ' ')}</td>
                  <td>
                    <button
                      className="btn btn-ghost"
                      onClick={async () => {
                        const mod = await import('../store/local');
                        const d = mod.loadArchiveDoc(m.caseId);
                        if (d) {
                          const exportMod = await import('./verdictExport');
                          exportMod.downloadVerdictHtml(d);
                        }
                      }}
                    >
                      导出
                    </button>
                    <button
                      className="btn btn-ghost"
                      style={{ marginLeft: 6 }}
                      onClick={async () => {
                        const mod = await import('../store/local');
                        mod.deleteFromArchive(m.caseId);
                        setMetas(mod.loadArchiveMetas());
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------

function Settings(): React.ReactElement {
  const [s, setS] = useState(() => {
    try {
      const raw = localStorage.getItem('health-court.settings.v1');
      return raw ? ({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as typeof DEFAULT_SETTINGS) : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS } as typeof DEFAULT_SETTINGS | null;
    }
  });
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  React.useEffect(() => {
    if (s === null) import('../store/local').then((m) => setS(m.loadSettings()));
  }, [s]);
  if (s === null) return <section className="panel">读取设置…</section>;

  const save = async () => {
    const m = await import('../store/local');
    m.saveSettings(s);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { createGlmProvider } = await import('../providers/glm');
      const { createOpenAiCompatProvider } = await import('../providers/openai-compat');
      const p =
        s.kind === 'glm'
          ? createGlmProvider({ apiKey: s.apiKey, baseUrl: s.baseUrl, model: s.model })
          : createOpenAiCompatProvider({ apiKey: s.apiKey, baseUrl: s.baseUrl, model: s.model });
      const r = await p.chat([{ role: 'user', content: '连通性自检：请回答"就绪"。' }], { maxTokens: 20 });
      setTestResult(`✅ ${r.model} 连通正常`);
    } catch (e: any) {
      setTestResult(`❌ ${String(e.message).slice(0, 200)}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="panel">
      <h2 className="panel-title">设置 · 模型接入（BYOK）</h2>
      <div className="key-warn">
        你的 API Key 只保存在你的浏览器（localStorage），所有请求从你的浏览器直接发往你所配置的服务商，本站无服务器、无埋点。
      </div>
      <div className="field">
        <label>供应商</label>
        <select
          value={s.kind}
          onChange={(e) => setS({ ...s, kind: e.target.value as any })}
        >
          <option value="glm">GLM（智谱 bigmodel，默认）</option>
          <option value="deepseek">DeepSeek</option>
          <option value="gemini">Google Gemini（推荐）</option>
          <option value="openai-compat">OpenAI 兼容端点（Moonshot / OpenRouter / 自建）</option>
        </select>
        <div className="desc">
          GLM 默认端点 https://open.bigmodel.cn/api/paas/v4 · 模型 glm-4-flash（免费档）。DeepSeek：api.deepseek.com（deepseek-chat，无内置检索）。Gemini：generativelanguage.googleapis.com（gemini-2.0-flash，原生 google_search，推荐）。
        </div>
      </div>
      <div className="field">
        <label>API Key</label>
        <input type="password" value={s.apiKey} onChange={(e) => setS({ ...s, apiKey: e.target.value })} placeholder="sk-..." />
      </div>
      <div className="field">
        <label>Base URL</label>
        <input value={s.baseUrl} onChange={(e) => setS({ ...s, baseUrl: e.target.value })} />
      </div>
      <div className="field">
        <label>模型</label>
        <input value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} />
      </div>
      {s.kind === 'glm' && (
        <div className="field">
          <label>检索专用模型（可选，默认同上）</label>
          <input value={s.searchModel} onChange={(e) => setS({ ...s, searchModel: e.target.value })} placeholder="留空 = 同主模型" />
        </div>
      )}
      <div className="field">
        <label>Jina Key（可选，提高抓取配额）</label>
        <input type="password" value={s.jinaApiKey} onChange={(e) => setS({ ...s, jinaApiKey: e.target.value })} placeholder="留空 = 免费档" />
      </div>
      <div className="field">
        <label>搜索通道</label>
        <select value={s.searchProvider} onChange={(e) => setS({ ...s, searchProvider: e.target.value as any })}>
          <option value="serper">Serper（默认·本庭共享额度，每案 24 次）</option>
          <option value="provider">主模型内置检索（GLM web_search / Gemini google_search）</option>
        </select>
        <div className="desc">共享额度用尽或需更多次数：serper.dev 免费注册（2500 次），Key 填在下面。主模型为 DeepSeek / OpenAI 兼容时请选择 Serper。</div>
        <input style={{ marginTop: 8 }} type="password" value={s.serperApiKey} onChange={(e) => setS({ ...s, serperApiKey: e.target.value })} placeholder="自己的 Serper Key（可选）" />
      </div>
      <div className="field">
        <label>语音转录（播客单集自动转录）</label>
        <select value={s.asrKind} onChange={(e) => setS({ ...s, asrKind: e.target.value as any })}>
          <option value="groq">Groq · whisper-large-v3（推荐，console.groq.com 免费注册）</option>
          <option value="glm">GLM ASR（复用上方 GLM Key，需 ASR 额度）</option>
        </select>
        {s.asrKind === 'groq' && (
          <input style={{ marginTop: 8 }} type="password" value={s.groqApiKey} onChange={(e) => setS({ ...s, groqApiKey: e.target.value })} placeholder="Groq API Key" />
        )}
        <div className="desc">提交播客单集链接时，本庭自动定位音频并转录为内容本体。音频经你的浏览器直连所选转录服务。</div>
      </div>
      <div className="input-row">
        <button className="btn" onClick={save} disabled={!s.apiKey}>
          保存
        </button>
        <button className="btn btn-ghost" onClick={test} disabled={testing || !s.apiKey}>
          {testing ? '检测中…' : '连通性自检'}
        </button>
        {saved && <span className="hint" style={{ alignSelf: 'center' }}>已保存 ✓</span>}
      </div>
      {testResult && (
        <div className="key-warn" style={{ marginTop: 14 }}>
          {testResult}
        </div>
      )}
      <p className="hint" style={{ marginTop: 14 }}>
        每案消耗参考：约 10–20 次 LLM 调用 + 3–6 次搜索 + 2–6 次网页抓取。glm-4-flash 免费档下通常无感。
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 关于
// ---------------------------------------------------------------------------

function About(): React.ReactElement {
  return (
    <section className="panel about-body">
      <h2 className="panel-title">关于卫生法庭</h2>
      <p>
        卫生法庭是一个半娱乐半严肃的内容核查法庭：你对一段文化内容起疑，本庭依照司法级证据规程完成取证、侦查、检索、对质与宣判，最后给出「卫生 / 可能不卫生 / 不卫生」的裁决与一份可复核的判决书。
      </p>
      <h3>设计公理：机制严谨 × 呈现漫画</h3>
      <p>
        证据分级、指纹验证、结构对齐与裁决阈值全部由确定性规则驱动；引文必须通过子串定位校验。动画、音效、漫画元素只读取裁决结果用于演出，从不参与计算。把所有动画关掉，每份判决与之相比一字不差。
      </p>
      <h3>本庭看什么（四条判据）</h3>
      <p style={{ margin: '0 0 10px', fontSize: 14 }}>
        话题本身的重合不构成判定依据——本庭只看同一话题下的展开方式与文本组织；常识和单个事实的重合同样不计：
      </p>
      <table className="table">
        <thead>
          <tr><th>判据</th><th>问题</th></tr>
        </thead>
        <tbody>
          {PLAIN_CRITERIA.map((c) => (
            <tr key={c.name}>
              <td><b>{c.name}</b></td>
              <td>{c.question}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>证据分级（E1–E5，内部技术分级）</h3>
      <table className="table">
        <thead>
          <tr>
            <th>级别</th>
            <th>名称</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {(Object.keys(EVIDENCE_LEVEL_INFO) as Array<keyof typeof EVIDENCE_LEVEL_INFO>).map((k) => (
            <tr key={k}>
              <td>
                <b>{k}</b>
              </td>
              <td>{EVIDENCE_LEVEL_INFO[k].name}</td>
              <td>{EVIDENCE_LEVEL_INFO[k].desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>裁决阈值</h3>
      <ul style={{ lineHeight: 1.9 }}>
        <li>不卫生：发现「同一个错误」（错误被照搬），或长距离顺序 + 至少 3 处罕见材料对应</li>
        <li>可能不卫生：出现罕见材料或例子组合的对应，但数量或连贯性不足</li>
        <li>卫生：完成对质而未发现上述四种痕迹（未发现 ≠ 清白）</li>
        <li>休庭：内容不可得 / 无候选源 / 证据不足</li>
      </ul>
      <h3>命名出处</h3>
      <div className="footnote-box">{NAMING_FOOTNOTE}</div>
      <h3>隐私</h3>
      <p>
        本站为纯静态页面（GitHub Pages），无服务器、无埋点。案件档案与 API Key 只存于你的浏览器 localStorage，可随时在判例集删除或清空浏览器数据。
      </p>
      <div className="footnote-box">
        本产品输出为文本证据的自动化分析，非法律结论；「不卫生」等裁决词为游戏化表述。本庭不对内容作者作动机推断，请读者依据材料自行判断。
      </div>
    </section>
  );
}
