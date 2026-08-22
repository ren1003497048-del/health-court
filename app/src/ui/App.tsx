import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { CaseFile, SourceDoc } from '../court/types';
import type { EvidenceItem, VerdictResult } from '../court/evidence';
import type { VerdictDoc } from '../pipeline';
import {
  DISCLAIMER,
  EVIDENCE_LEVEL_INFO,
  PLAIN_CRITERIA,
  MIN_ADMISSIBLE_EVIDENCE_GROUPS,
  evidenceExclusionReason,
  isAdmissibleEvidence,
  normalizeEvidenceForSources,
  plainLevelName,
} from '../court/evidence';
import { DEFAULT_SETTINGS, defaultPresetForProvider, presetsForProvider } from '../store/local';
import { stripMarkdownMedia } from '../court/chromeStrip';

const gavelSwingUrl = new URL('../assets/gavel-swing-v2.png', import.meta.url).href;
const gavelImpactUrl = new URL('../assets/gavel-impact-v2.png', import.meta.url).href;

export type Tab = 'court' | 'archive' | 'settings' | 'about';

const STAGES = ['立案', '侦查', '检索', '对质', '宣判'] as const;

interface ObjectionCue {
  title: '异议！';
  level: 'E3' | 'E4';
  detail: string;
  targetQuote?: string;
  sourceQuote?: string;
  index: number;
  total: number;
}

export interface RunningState {
  stageIndex: number;
  logs: { stage: string; note: string; at: string }[];
  evidence: EvidenceItem[];
  fingerprints: number;
  sources: SourceDoc[];
  objection: ObjectionCue | null;
  shake: boolean;
}

const playGavelImpact = () => {
  if (typeof window === 'undefined') return;
  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextCtor) return;

  const context = new AudioContextCtor();
  const now = context.currentTime;
  const master = context.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.18, now + 0.004);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
  master.connect(context.destination);

  // 清脆木质瞬态：高通噪声 + 两个快速下坠的短音。
  const buffer = context.createBuffer(1, Math.floor(context.sampleRate * 0.055), context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 3);
  const noise = context.createBufferSource();
  const highpass = context.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 850;
  noise.buffer = buffer;
  noise.connect(highpass);
  highpass.connect(master);
  noise.start(now);

  [1480, 720].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = index === 0 ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.56, now + 0.09);
    gain.gain.setValueAtTime(index === 0 ? 0.16 : 0.09, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(now);
    oscillator.stop(now + 0.12);
  });

  window.setTimeout(() => void context.close(), 500);
};

function CourtGavel(): React.ReactElement {
  const [hit, setHit] = useState(0);
  return (
    <button
      className="gavel-button"
      type="button"
      onClick={() => {
        setHit((value) => value + 1);
        playGavelImpact();
      }}
      aria-label="重放法槌敲击"
      title="点击重放法槌敲击"
    >
      <span className="gavel-stage" aria-hidden="true">
        <img key={`swing-${hit}`} className="gavel-art gavel-art-swing" src={gavelSwingUrl} alt="" draggable={false} decoding="async" />
        <img key={`impact-${hit}`} className="gavel-art gavel-art-impact" src={gavelImpactUrl} alt="" draggable={false} decoding="async" />
        <span className="gavel-ground" />
      </span>
      <span className="gavel-caption">落槌 · 点击重放</span>
    </button>
  );
}

/** v3.1 引文高亮：在扩展引文中对命中短语标红 */
const HighlightQuote = ({ text, phrase }: { text: string; phrase?: string }) => {
  if (!phrase || phrase.length < 6 || !text.includes(phrase)) {
    return <>{text}</>;
  }
  const i = text.indexOf(phrase);
  return (
    <>
      {text.slice(0, i)}
      <mark style={{ background: 'rgba(176,122,30,0.28)', color: 'inherit', padding: '0 1px', borderRadius: 2 }}>{phrase}</mark>
      {text.slice(i + phrase.length)}
    </>
  );
};

/** v3 角色中文名 */
const roleZh = (r: string) =>
  ({ clerk: '书记员', evidence_officer: '证据官', prosecutor: '公诉人', defender: '辩护人', judge: '法官', court_clerk: '法官助理', orchestrator: '审判长' } as Record<string, string>)[r] || r;

const formatLocalTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso).slice(11, 19) : date.toLocaleTimeString('zh-CN', { hour12: false });
};

const formatTrialAction = (role: string, action: string) => {
  const chars = action.match(/共\s*(\d+)\s*字符/)?.[1];
  if (/控方立论.*启动/.test(action)) return `开始整理控方证据${chars ? `（材料 ${chars} 字）` : ''}`;
  if (/控方立论.*完成/.test(action)) return '控方证据整理完成';
  if (/辩方驳斥.*启动/.test(action)) return `开始核对引用并提出抗辩${chars ? `（材料 ${chars} 字）` : ''}`;
  if (/辩方驳斥.*完成/.test(action)) return '辩方抗辩完成';
  if (/法官判词.*启动/.test(action)) return `开始复核控辩材料${chars ? `（材料 ${chars} 字）` : ''}`;
  if (/法官判词.*完成/.test(action)) return '裁决意见整理完成';
  if (/→.*BRIEF/.test(action)) return '提交控方意见';
  if (/→.*REBUTTAL/.test(action)) return '提交辩方意见';
  if (/→.*VERDICT/.test(action)) return '提交裁决草案';
  const cleaned = action
    .replace(/\b(?:evidenceList|sourcesBrief|prosecutionBrief|citationMap|evidenceTop|citationNote|verdict)\b/gi, '材料')
    .replace(/\b(?:EV|SRC|FP)\S*/g, '证据')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || `${roleZh(role)}完成本阶段工作`;
};

const LinkifiedText = ({ text }: { text: string }) => {
  const normalizedText = String(text || '').replace(/\bSRC(\d+)\b/gi, '候选源$1');
  const parts = normalizedText.split(/(https?:\/\/[^\s；，。]+)/g);
  return <>{parts.map((part, index) => /^https?:\/\//.test(part)
    ? <a key={index} href={part} target="_blank" rel="noreferrer">打开原文 ↗</a>
    : <React.Fragment key={index}>{part}</React.Fragment>)}</>;
};

const normalizeOverviewForDisplay = (text: string, sources: number, admitted: number, total: number) => {
  const cleaned = stripMarkdownMedia(text || '').trim();
  const statedAdmission = cleaned.match(/正式证据(?:组)?[（(]?\s*(\d+)/)?.[1];
  if (/(?:数据组合|证据)相似度|(?:相似度为?|similarity)\s*\d+\s*%/i.test(cleaned)
    || (statedAdmission !== undefined && Number(statedAdmission) !== admitted)) {
    return `已完成 ${sources} 个候选源核查；${admitted} 组正式查证，${Math.max(0, total - admitted)} 条线索未准入。相似度仅用于检索排序，不代表证据强度。`;
  }
  return cleaned;
};

/** v2.2.1 代号白话化：把后端标识（FP6/rare_case/SRC1）翻译成用户可读语言 */
const plainFpType = (ty?: string) =>
  ({ weird_term: '异常用词', rare_case: '冷门案例', data_combo: '数据组合', analogy: '独特类比', joke: '专属玩笑', ordering: '罕见排序', other: '其他特征' } as Record<string, string>)[ty || ''] || ty || '';
const plainExam = (v?: string) =>
  ({ expression_copy: '独特表达复制', fact_relay: '事实转述（不构成定案依据）', generic_overlap: '宏观表达重合（不构成定案依据）', inconclusive: '无法判定' } as Record<string, string>)[v || ''] || '';
const humanizeEvidenceDescription = (value: string) => stripMarkdownMedia(value)
  .replace(/FP\d+S?\d*（([a-z_]+)）/g, (_match: string, type: string) => `指纹（${plainFpType(type)}）`)
  .replace(/在 SRC(\d+) 命中/g, (_match: string, number: string) => `在候选源${number}中命中`)
  .replace(/← SRC(\d+)/g, (_match: string, number: string) => `← 候选源${number}`);

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
  const lastTranscribeErrorRef = useRef<string | null>(null);
  const tryTranscribe = async (cf: CaseFile, rt: any, s: any): Promise<boolean> => {
    /** 网络步骤打点：任何一层失败都能定位到具体环节 */
    const netErr = (step: string, e: any): string => {
      const raw = String(e?.message || e || '网络请求失败');
      const isTimeout = /timeout|abort/i.test(raw);
      const isCors = /cors|failed to fetch|networkerror|load failed/i.test(raw);
      const hint = isTimeout
        ? '（连接超时——当前网络可能无法直连该服务，尝试更换网络或开启代理后重试）'
        : isCors
          ? '（连接被拒——多半是网络拦截，尝试更换网络或开启代理后重试）'
          : '';
      return `[${step}] ${raw.slice(0, 120)}${hint}`;
    };
    try {
      const { transcribeAudio } = await import('../providers/multi');
      const { transcribeAudioUrl } = await import('../pipeline/transcribe');
      const { locateEpisodeAudio } = await import('../providers/episodeLocate');
      let audioUrl = '';
      let meta: any = null;
      if (/podcasts\.apple\.com|xiaoyuzhoufm\.com\/(episode|podcast)/.test(cf.input.url || '')) {
        logSinkRef.current('立案', '跨平台定位单集音频（目录查询 → Jina 中继 → RSS 匹配）…');
        const located = await locateEpisodeAudio(cf.input.url!, {
          jinaKey: s.jinaApiKey || undefined,
          log: (m) => logSinkRef.current('立案', m),
        });
        if (!located.ok) {
          lastTranscribeErrorRef.current = located.reason;
          logSinkRef.current('立案', `音频定位失败：${located.reason}`);
          return false;
        }
        audioUrl = located.audio.audioUrl;
        meta = {
          podcastName: located.audio.podcastName,
          durationMs: located.audio.durationMs || 0,
          releaseDate: located.audio.releaseDate,
          source: located.audio.source,
        };
        logSinkRef.current('立案', `定位音频成功（来源：${located.audio.source}）`);
        if (meta?.podcastName) cf.target.author = cf.target.author || meta.podcastName;
        if (meta?.releaseDate) cf.target.date = cf.target.date || String(meta.releaseDate).slice(0, 10);
      }
      if (!audioUrl) {
        lastTranscribeErrorRef.current = '未能定位音频地址（当前支持 Apple Podcasts 与小宇宙单集链接）';
        logSinkRef.current('立案', '未能定位音频地址（该平台未提供可自动转录的音频通道）');
        return false;
      }
      logSinkRef.current('立案', `定位音频成功（${Math.round((meta?.durationMs || 0) / 60000)} 分钟），开始浏览器内转录…`);
      const asrKind: 'groq' | 'glm' = s.asrKind === 'glm' ? 'glm' : 'groq';
      const asrKey = asrKind === 'glm' ? s.apiKey : s.groqApiKey;
      if (!asrKey) {
        lastTranscribeErrorRef.current = asrKind === 'groq' ? '尚未配置 Groq Key——请到「设置 → 语音转录」填入并点击「保存」' : '尚未配置 GLM Key';
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
      const raw = String(e?.message || e);
      // 阶段归因：transcribeAudioUrl 内部的 fetch失败=音频下载；ASR 上传失败含 asr()
      const step = /asr\(/i.test(raw) ? '上传转录服务' : /fetch|failed/i.test(raw) && raw.includes('audio') ? '下载音频' : '浏览器转录';
      lastTranscribeErrorRef.current = netErr(step, e);
      logSinkRef.current('立案', `自动转录失败：${lastTranscribeErrorRef.current}`);
      return false;
    }
  };

  /** v2.2 候选源转录：高相似候选本身是播客单集时，取转录稿替代浅层 shownotes 对质 */
  const transcribeCandidates = async (cf: CaseFile, rt: any, s: any, maxCount = 3) => {
    const asrKind: 'groq' | 'glm' = s.asrKind === 'glm' ? 'glm' : 'groq';
    const asrKey = asrKind === 'glm' ? s.apiKey : s.groqApiKey;
    if (!asrKey) {
      logSinkRef.current('检索', '未配置 ASR Key：候选播客源不转录，以页面文本对质（比对深度受限）');
      return;
    }
    const { locateEpisodeAudio } = await import('../providers/episodeLocate');
    const { transcribeAudioUrl } = await import('../pipeline/transcribe');
    const pool = (rt.sources as any[])
      .filter((src) => /xiaoyuzhoufm\.com\/episode|podcasts\.apple\.com.*\?i=|open\.spotify\.com\/episode|getpodcast\.com|musixmatch\.com\/podcast|deezer\.com\/episode|podtail\.com|podcast-addict\.com|podcastrex\.com/.test(src.url || ''))
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, maxCount);
    for (const src of pool) {
      if (src.transcribed) continue; // 已转录过
      // v2.2.6 修正：fullText 长度不能代表内容深度——Apple/Spotify 壳页 20KB+ 全是导航+shownotes。
      // 壳页特征：导航链接密度极高（](https:// 短链接串）且无对话转录特征（无时间戳/无长句段）
      const isShellPage = (() => {
        const ft = src.fullText || '';
        if (ft.length < 3000) return false; // 短页面按原逻辑（浅文本，值得转录）
        const navLinks = (ft.match(/\]\(https?:\/\//g) || []).length;
        const words = ft.split(/\s+/).length;
        // 每 100 词超 8 个 markdown 链接 → 壳页（导航/目录页），shownotes 深度不足，仍需转录
        return navLinks / Math.max(1, words / 100) > 8;
      })();
      if (src.fullText && src.fullText.length > 5000 && !isShellPage) continue; // 真有足量正文（如 musixmatch 转录稿页）
      try {
        logSinkRef.current('检索', `候选源 ${src.id} 为播客单集（相似度 ${src.similarity ?? '?'}），启动转录取全文…`);
        const located = await locateEpisodeAudio(src.url, { jinaKey: s.jinaApiKey || undefined });
        if (!located.ok) {
          logSinkRef.current('检索', `候选源 ${src.id} 音频定位失败：${located.reason.slice(0, 80)}`);
          continue;
        }
        const { segments, fullText } = await transcribeAudioUrl(
          located.audio.audioUrl,
          { kind: asrKind, apiKey: asrKey },
          (pr) => logSinkRef.current('检索', `候选源 ${src.id} 转录进度 ${pr.doneChunks}/${pr.totalChunks}`),
        );
        if (fullText.length > 2000) {
          src.fullText = fullText;
          src.partial = false;
          src.transcribed = true;
          logSinkRef.current('检索', `候选源 ${src.id} 转录完成：${fullText.length} 字符，${segments.length} 段——以转录稿对质`);
        }
      } catch (e: any) {
        logSinkRef.current('检索', `候选源 ${src.id} 转录失败（${String(e?.message || e).slice(0, 80)}），保留页面文本`);
      }
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
    const humanizeLlmError = (e: unknown): Error => {
      const raw = String((e as any)?.message || e);
      let savedBase = '';
      try {
        savedBase = String(JSON.parse(localStorage.getItem('health-court.settings.v1') || '{}').baseUrl || '');
      } catch { /* 读不到就只按报错判断 */ }
      if (/1113|余额不足/.test(raw) && !/coding/.test(savedBase)) {
        return new Error('GLM 报 1113 余额不足：当前 Key 是 Coding Plan 套餐，但 Base URL 指向通用端点。请到「设置 → 主模型」选择带「Coding 套餐端点」字样的预设（open.bigmodel.cn/api/coding/paas/v4）后重试。');
      }
      return e as Error;
    };
    try {
      const { loadSettings } = await import('../store/local');
      const s = loadSettings();
      if (!s.apiKey) throw new Error('尚未配置 API Key。请到「设置」页填写（默认 GLM / glm-5.2）。');
      const { createGlmProvider } = await import('../providers/glm');
      const { createOpenAiCompatProvider, createJinaFetcher } = await import('../providers/openai-compat');
      const { createDeepSeekProvider, createGeminiProvider } = await import('../providers/multi');
      const { createSerperSearch, beginSearchCase } = await import('../providers/serper');
      let provider;
      if (s.kind === 'glm') {
        provider = createGlmProvider({ apiKey: s.apiKey, baseUrl: s.baseUrl, model: s.model, searchModel: s.searchModel || undefined });
      } else if (s.kind === 'deepseek') {
        provider = createDeepSeekProvider({ apiKey: s.apiKey, model: s.model || 'deepseek-v4-flash' });
      } else if (s.kind === 'gemini') {
        provider = createGeminiProvider({ apiKey: s.apiKey, model: s.model || 'gemini-3.7-flash' });
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
              pushLog('检索', '本案共享搜索额度已用尽（60 次）。可在设置中填入自己的 Serper Key（应用不再限次），或切换为主模型内置检索。');
            }
            throw e;
          }
        }
        return originalSearch(query);
      };

      const logs: RunningState['logs'] = [];
      const pushLog = (stage: string, note: string) => {
        logSinkRef.current = pushLog;
        logs.push({ stage, note, at: new Date().toISOString() });
        const stageIdx = STAGES.indexOf(stage as any);
        // E4 命中只在对质阶段增加轻微震动；异议演出由已生成的结构化证据驱动。
        const hitMatch = note.match(/(E4|E3) 指纹命中/);
        setRunning((r) => {
          if (!r) return r;
          return {
            ...r,
            logs: [...logs],
            stageIndex: stageIdx >= 0 ? stageIdx : r.stageIndex,
            shake: hitMatch?.[1] === 'E4' ? true : r.shake,
          };
        });
        scrollLog();
      };

      const rt = { provider, fetcher, log: pushLog, evidence: [] as EvidenceItem[], sources: [] as SourceDoc[], processLog: logs };
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
        const raw = String(e?.message || e);
        if (/fetch|network|timeout|abort|cors/i.test(raw)) {
          setError(`取证失败：无法访问该链接（${raw.slice(0, 100)}）。当前网络可能无法直达该站点，可尝试更换网络、开启代理，或改用「粘贴正文」方式提交。`);
          setRunning(null);
          return;
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
          lastTranscribeErrorRef.current = null;
          // 前置守卫：ASR 配置检查（提前暴露"没保存"问题，不浪费抓音频的时间）
          const preAsrKind = s.asrKind === 'glm' ? 'glm' : 'groq';
          const preAsrKey = preAsrKind === 'glm' ? s.apiKey : s.groqApiKey;
          if (!preAsrKey) {
            setMentalHygiene(
              `自动转录需要${preAsrKind === 'groq' ? ' Groq Key' : ' GLM Key'}，但当前尚未配置。\n\n请前往「设置 → 语音转录」填入 Key 并点击「保存」，再重新提交。（console.groq.com/keys 可免费注册）`,
            );
            throw new Error('__MENTAL_HYGIENE__');
          }
          const transcribed = await tryTranscribe(cf, rt, s);
          if (!transcribed) {
            const why = lastTranscribeErrorRef.current;
            setMentalHygiene(
              (why ? `自动转录未成功：${why}\n\n` : '') + (fail.failNote || ''),
            );
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
      beginSearchCase(cf.caseId);
      setRunning((r) => (r ? { ...r, stageIndex: 1 } : r));
      await pipeline.investigation(cf, rt);
      setRunning((r) => (r ? { ...r, stageIndex: 2, fingerprints: cf.fingerprints.length } : r));
      await pipeline.discovery(cf, rt);
      setRunning((r) => (r ? { ...r, stageIndex: 3, sources: rt.sources } : r));
      await transcribeCandidates(cf, rt, s);
      let evidence = await pipeline.crossExamination(cf, rt);
      if (pipeline.shouldSupplementEvidence(evidence, rt.sources)) {
        const added = await pipeline.supplementalDiscovery(cf, rt, evidence);
        if (added > 0) {
          setRunning((r) => (r ? { ...r, stageIndex: 2, sources: [...rt.sources] } : r));
          await transcribeCandidates(cf, rt, s);
          setRunning((r) => (r ? { ...r, stageIndex: 3 } : r));
          evidence = await pipeline.crossExamination(cf, rt);
        }
      }
      // 对质证据先完整落位，再进入异议演出；宣判阶段只在演出结束后点亮。
      setRunning((r) => (r ? { ...r, stageIndex: 3, evidence } : r));

      const clipQuote = (quote?: string) => quote ? stripMarkdownMedia(quote).replace(/\s+/g, ' ').trim().slice(0, 620) || undefined : undefined;
      const objectionEvidence = evidence
        .filter((item): item is EvidenceItem & { level: 'E3' | 'E4' } => (item.level === 'E3' || item.level === 'E4') && isAdmissibleEvidence(item));
      const objectionQueue: ObjectionCue[] = objectionEvidence
        .map((item, index) => ({
          title: '异议！',
          level: item.level,
          detail: stripMarkdownMedia(item.description).slice(0, 420),
          targetQuote: clipQuote(item.targetQuote),
          sourceQuote: clipQuote(item.sourceQuote),
          index: index + 1,
          total: objectionEvidence.length,
        }));

      if (objectionQueue.length > 0) {
        await new Promise<void>((resolve) => {
          let finished = false;
          let current = 0;

          const finish = () => {
            if (finished) return;
            finished = true;
            setRunning((r) => (r ? { ...r, objection: null, shake: false } : r));
            delete (window as any).__hcAdvanceObjection;
            resolve();
          };

          const step = () => {
            if (finished) return;
            if (current >= objectionQueue.length) {
              finish();
              return;
            }
            const cue = objectionQueue[current];
            setRunning((r) => (r ? { ...r, stageIndex: 3, objection: cue, shake: cue.level === 'E4' } : r));
            current += 1;
          };

          (window as any).__hcAdvanceObjection = step;
          step();
        });
      }

      setRunning((r) => (r ? { ...r, stageIndex: 4, objection: null, shake: false } : r));

      const doc = await pipeline.verdictStage(cf, rt, evidence);
      setVerdictDoc(doc);
      const { saveToArchive } = await import('../store/local');
      saveToArchive(doc);
    } catch (e: any) {
      if (String(e?.message) === '__MENTAL_HYGIENE__') {
        setRunning(null);
        return; // 弹窗已由 setMentalHygiene 触发
      }
      setError(String(humanizeLlmError(e)?.message || e));
      setRunning(null);
    }
  }, [input, bodyText, scrollLog]);

  return (
    <>
      <header className="court-header">
        <div className="court-header-inner">
          <div className="brand-lockup">
            <span className="logo-cn">
              卫生<span className="typo-mark">法庭</span>
            </span>
            <span className="brand-slogan">适度创作益脑，沉迷AI伤身。拒绝循环文本，守护精神卫生。</span>
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
      </header>

            {mentalHygiene && (
        <div className="objection-overlay" style={{ pointerEvents: 'auto', background: 'rgba(250,246,238,0.96)' }} onClick={() => setMentalHygiene(null)}>
          <div style={{ background: '#fff', border: 'var(--border)', boxShadow: 'var(--shadow)', padding: '34px 38px', maxWidth: 640, margin: '0 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 44, marginBottom: 10 }}>⚖️</div>
            <div style={{ fontFamily: 'var(--serif)', fontWeight: 900, fontSize: 26, marginBottom: 4 }}>请自行注意精神卫生</div>
            <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 14, letterSpacing: '0.1em' }}>本庭无法受理当前提交的材料</div>
            <p style={{ fontSize: 14.5, lineHeight: 1.9, margin: '0 0 16px', textAlign: 'left' }}>{mentalHygiene}</p>
            <button className="btn" onClick={() => setMentalHygiene(null)}>我知道了</button>
          </div>
        </div>
      )}

      <main>
        <div className="page-view" key={tab}>
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
        {tab === 'archive' && (
          <Archive
            onOpen={(doc) => {
              setVerdictDoc(doc);
              setTab('court');
            }}
          />
        )}
        {tab === 'settings' && <Settings />}
        {tab === 'about' && <About />}
        </div>
      </main>

      <footer className="footer">
        <div>卫生法庭 · 文本来源核查</div>
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
        <div
          className="objection-overlay"
          role="dialog"
          aria-modal="true"
          aria-live="assertive"
        >
          <div className={'objection-dialog ' + (running.objection.level === 'E4' ? 'is-e4' : 'is-e3')}>
            <div className="objection-kicker">当前阶段 · 对质｜正式证据 {running.objection.index}/{running.objection.total}</div>
            <div className="objection-text">{running.objection.title}</div>
            <div className="objection-level">证据准入 · 原文定位通过</div>
            {(running.objection.targetQuote || running.objection.sourceQuote) && (
              <div className="objection-quotes">
                {running.objection.targetQuote && (
                  <blockquote>
                    <span>目标文本</span>
                    {running.objection.targetQuote}
                  </blockquote>
                )}
                {running.objection.sourceQuote && (
                  <blockquote>
                    <span>来源文本</span>
                    {running.objection.sourceQuote}
                  </blockquote>
                )}
              </div>
            )}
            <p className="objection-detail">{running.objection.detail}</p>
            <button className="objection-continue" type="button" onClick={() => { (window as any).__hcAdvanceObjection?.(); }}>
              {running.objection.index < running.objection.total ? '查看下一组证据' : '关闭异议并继续庭审'}
            </button>
          </div>
        </div>
      )}

      <section className={'panel intake-panel' + (running?.shake ? ' shake' : '') + (running ? ' is-running' : '')}>
        <div className="panel-heading-row">
          <h2 className="panel-title">材料提交</h2>
          <span className="status-chip">{running ? '材料已入卷' : '等待立案'}</span>
        </div>
        {running ? (
          <div className="case-summary">
            <span>当前材料</span>
            <strong>{input.trim() || '已粘贴正文材料'}</strong>
          </div>
        ) : (
          <>
            <label className="input-label" htmlFor="case-url">内容链接</label>
            <div className="input-row">
              <input
                id="case-url"
                className="input-main"
                placeholder="粘贴播客单集或文章链接"
                value={input}
                onChange={(e) => setInput(e.target.value)}
              />
            </div>
            <label className="input-label" htmlFor="case-body">正文</label>
            <div className="input-row">
              <textarea
                id="case-body"
                className="input-main"
                placeholder="或直接粘贴正文（不少于 100 字）"
                value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
              />
            </div>
            <div className="submit-row">
              <button className="btn btn-primary" onClick={run} disabled={!input.trim() && !bodyText.trim()}>
                开庭查证
              </button>
              <p className="hint">支持文章、播客、节目转录稿</p>
            </div>
          </>
        )}
        {error && (
          <div className="key-warn" style={{ borderColor: 'var(--vermillion)', background: '#fbe3df' }}>
            {error}
          </div>
        )}
      </section>

      {!running && !verdictDoc && (
        <div className="idle-stage-bar" aria-label="庭审流程：立案、侦查、检索、对质、宣判">
          {STAGES.map((stage) => <span key={stage}>{stage}</span>)}
        </div>
      )}

      {running && (
        <section className="panel process-panel">
          <div className="process-heading">
            <div>
              <span className="process-eyebrow">庭审流程</span>
              <h2>核查进行中 <small>当前 · {STAGES[running.stageIndex]}</small></h2>
            </div>
            <span className="process-status-note">过程自动记录 · 完成后生成判决书</span>
          </div>
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
            {running.logs.length === 0 && <div className="log-empty">书记员正在登记材料…</div>}
            {running.logs.map((l, i) => (
              <div className="log-line" key={i}>
                <span className="stage-tag">[{l.stage}]</span>
                <span className="log-note">{l.note}</span>
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
  const courtEvidence = useMemo(() => normalizeEvidenceForSources(doc.evidence, doc.sources), [doc.evidence, doc.sources]);
  const admittedCount = courtEvidence.filter(isAdmissibleEvidence).length;
  const requiredCount = doc.admission?.required ?? MIN_ADMISSIBLE_EVIDENCE_GROUPS;
  const displayWord = admittedCount < requiredCount && !['休庭', '不予受理'].includes(v.word) ? '不足立案' : v.word;
  const displayRule = displayWord === '不足立案'
    ? `正式证据仅 ${admittedCount} 组，未达到 ${requiredCount} 组立案门槛；现有内容仅作线索展示，不出具倾向性裁决`
    : v.rule;
  const overviewText = normalizeOverviewForDisplay(String((doc as any).overview || ''), doc.sources.length, admittedCount, courtEvidence.length);
  const visibleLimits = doc.limits.filter((item) => !/^\s*【外界指控】/.test(String(item)));
  return (
    <div className="court-flow verdict-flow">
      <section className="panel court-sheet verdict-stage-panel">
        <span className="verdict-kicker">庭审终局 · 本案裁决</span>
        <CourtGavel />
        <div className={'verdict-word ' + displayWord}>{displayWord}</div>
        {displayWord === '可能卫生' && (
          <div className="verdict-note">请持续关注精神卫生。</div>
        )}
        <a className="verdict-jump" href="#evidence-list">查看证据清单 ↓</a>
        <div className="stamp">卫生法庭 · 宣判</div>
        <p className="verdict-rule">{displayRule}</p>
        <p className="verdict-rule verdict-counts">
          错误照搬×{v.counts.E4} · 罕见材料×{v.counts.E3} · 论证链同构{v.counts.E2 ? '√' : '—'} · 句式直译×{v.counts.E5} ｜ 来源标注：
          {v.attribution === 'complete' ? '完整（仅指发布署名，不证明原创）' : v.attribution === 'partial' ? '部分' : v.attribution === 'none' ? '无' : '不明'}
        </p>
        <div className={'admission-meter ' + (admittedCount >= requiredCount ? 'is-sufficient' : 'is-insufficient')}>
          <span>证据准入</span>
          <strong>{admittedCount} / {requiredCount} 组</strong>
          <small>{admittedCount >= requiredCount ? '达到正式立案门槛' : '未达到立案门槛，仅展示线索'}</small>
        </div>
      </section>

      <section className="panel court-sheet verdict-document-panel">
        <div className="panel-heading-row verdict-document-heading">
          <h2 className="panel-title">判决书</h2>
          <span className="case-number">{doc.caseFile.caseId}</span>
        </div>
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
                        {s.id.replace(/^SRC/i, '候选源')} 《{s.title}》 {s.partial ? '（部分取证）' : ''}{' '}
                        <a href={s.url} target="_blank" rel="noreferrer">
                          ↗
                        </a>
                      </div>
                    ))}
              </td>
            </tr>
          </tbody>
        </table>

        {(() => {
          const positive = courtEvidence.filter((e: any) => isAdmissibleEvidence(e));
          const negative = courtEvidence.filter((e: any) => !isAdmissibleEvidence(e));
          return (
            <>
              {overviewText && (
          <div style={{ margin: '14px 0', padding: '10px 14px', background: 'rgba(107,143,113,0.07)', borderLeft: '3px solid var(--green, #6B8F71)', borderRadius: 4, fontSize: 14, lineHeight: 1.9 }}>
            <span style={{ fontWeight: 700 }}>总体对应形态｜</span>{overviewText}
          </div>
        )}
        <h3 id="evidence-list" className="evidence-section-title">正式证据组（{positive.length}）</h3>
              <p className="evidence-standard-note">统计主体关系明确的独立查证组：正面证据须双侧引文定位并通过检定，针对明确来源完成的负面查证也计入；同题材、公共新闻事实与未定位引文不计。</p>
              {positive.length === 0 && <p className="hint">当前没有达到正式准入标准的证据组，下方仍完整列出所有线索与负面查证。</p>}
              {(() => {
                const bySource = new Map<string, any[]>();
                for (const e of positive) {
                  const key = e.sourceId || '未知源';
                  if (!bySource.has(key)) bySource.set(key, []);
                  bySource.get(key)!.push(e);
                }
                const srcInfo = (sid: string) => doc.sources.find((s) => s.id === sid);
                return [...bySource.entries()].map(([sid, evs]) => {
                  const s = srcInfo(sid);
                  return (
                    <div key={`grp-${sid}`} style={{ marginBottom: 18 }}>
                      {s && (
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8, paddingBottom: 6, borderBottom: '2px solid var(--line, #e0d8cc)', flexWrap: 'wrap' }}>
                          <span style={{ fontFamily: 'var(--serif)', fontWeight: 800, fontSize: 14.5 }}>参照源：{s.title.slice(0, 46)}</span>
                          <a href={s.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, textDecoration: 'underline' }}>直达 ↗</a>
                          <span className="hint">相似度 {s.similarity ?? '?'} · {evs.length} 处对应{s.transcribed ? ' · 已转录全文比对' : ''}</span>
                        </div>
                      )}
                      {evs.map((e) => (
          <div className="evidence-card" key={e.id} id={`ev-${e.id}`} style={{ marginBottom: 10 }}>
            <div className="evidence-head">
              <span className="evidence-group-number">证据组 {String(positive.indexOf(e) + 1).padStart(2, '0')}</span>
              <span className={'evidence-level ' + e.level}>{e.plainTitle || plainLevelName(e.level)}</span>
              <span className="evidence-id">{e.level === 'E4' ? '错误被复制' : e.level === 'E3' ? '具体对应' : e.level === 'E2' ? '结构对应' : '查证记录'}</span>
              {(e.detail as any)?.demoted && <span className="hint" style={{ marginLeft: 8 }}>（线索级，不计入定案）</span>}
            </div>
            {(e.detail as any)?.contextTarget || (e.detail as any)?.contextSource ? (
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12.5, opacity: 0.85 }}>展开上下文（前后各约 200 字，{(e.detail as any)?.contextVerified ? '已机械校验逐字真实' : ''}）</summary>
                {(e.detail as any)?.contextTarget && (
                  <div className="quote-box target" style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.9 }}>
                    <span className="quote-label">被检内容·上下文</span>
                    <div className="palette-text" style={{ opacity: 0.92 }}><HighlightQuote text={stripMarkdownMedia((e.detail as any).contextTarget)} phrase={(e.detail as any)?.hitPhraseTarget} /></div>
                  </div>
                )}
                {(e.detail as any)?.contextSource && (
                  <div className="quote-box source" style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.9 }}>
                    <span className="quote-label">参照源文·上下文</span>
                    <div className="palette-text" style={{ opacity: 0.92 }}><HighlightQuote text={stripMarkdownMedia((e.detail as any).contextSource)} phrase={(e.detail as any)?.hitPhraseSource} /></div>
                  </div>
                )}
              </details>
            ) : null}
            {(e.targetParaphrase || e.sourceParaphrase) && (
              <div style={{ marginTop: 6, fontSize: 13.5, lineHeight: 1.9 }}>
                {e.sourceParaphrase && <div>{e.sourceParaphrase}</div>}
                {e.targetParaphrase && <div>{e.targetParaphrase}</div>}
              </div>
            )}
            {e.examVerdict && e.examVerdict !== 'expression_copy' && (
              <div className="hint" style={{ marginTop: 4 }}>本条性质：{plainExam(e.examVerdict)}</div>
            )}
            <div style={{ fontSize: 13.5 }}>{humanizeEvidenceDescription(e.description)}</div>
            {e.examNote && <div className="hint" style={{ marginTop: 4 }}>检定理由：{e.examNote}</div>}
            {(e.detail as any)?.macro && Array.isArray((e.detail as any).mappings) && ((e.detail as any).mappings).length > 0 && (
              <div style={{ marginTop: 6, fontSize: 12.5, lineHeight: 1.8, borderLeft: '2px solid var(--line, #ccc)', paddingLeft: 10 }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>大纲逐项对应（{(e.detail as any).mappings.length} 项）：</div>
                {((e.detail as any).mappings).map((m: any, i: number) => (
                  <div key={i}>· 第{(e.detail as any).mappings[i]?.item ?? i + 1}项：{m.note || ''}{m.sourceExcerpt ? <span style={{ opacity: 0.7 }}>——源摘录：{String(m.sourceExcerpt).slice(0, 100)}…</span> : null}</div>
                ))}
              </div>
            )}
            {e.sourceTitle && (
              <div style={{ marginTop: 6, fontSize: 12.5 }}>
                对比源：<a href={e.sourceUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>{e.sourceTitle}</a>
                {e.sourceUrl ? ' ↗' : ''}
                {e.sourceTranscribed ? '（已转录全文比对）' : '（页面文本比对）'}
                {(e.detail as any)?.seriesPage ? '（系列页，非单集直达）' : ''}
              </div>
            )}
            {Array.isArray((e.detail as any)?.alsoSources) && (e.detail as any).alsoSources.length > 1 && (
              <div className="hint" style={{ marginTop: 4 }}>
                同一对应还见于：{(e.detail as any).alsoSources.filter((s: any) => s.sourceId !== e.sourceId).map((s: any, i: number) => (
                  <span key={i}>{i > 0 ? '；' : ''}<a href={s.sourceUrl} target="_blank" rel="noreferrer">{s.sourceId?.replace('SRC', '源')}《{(s.sourceTitle || '').slice(0, 32)}》↗</a>{s.examVerdict === 'expression_copy' ? '' : '（线索级）'}</span>
                ))}
              </div>
            )}
            {(e.targetQuote || e.sourceQuote) && (
              <div className="palette" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                {e.targetQuote && (
                  <div className="quote-box target" style={{ margin: 0 }}>
                    <span className="quote-label">被检内容</span>
                    <div className="palette-text"><HighlightQuote text={stripMarkdownMedia(e.targetQuote)} phrase={(e.detail as any)?.hitPhraseTarget} /></div>
                    {e.targetQuoteLocated === false && <span className="unlocated">未定位</span>}
                  </div>
                )}
                {e.sourceQuote && (
                  <div className="quote-box source" style={{ margin: 0 }}>
                    <span className="quote-label">参照源文·{e.sourceTitle ? e.sourceTitle.slice(0, 20) : '候选'}</span>
                    <div className="palette-text"><HighlightQuote text={stripMarkdownMedia(e.sourceQuote)} phrase={(e.detail as any)?.hitPhraseSource} /></div>
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
                    </div>
                  );
                });
              })()}
              {negative.length > 0 && (
                <>
                  <h3 className="evidence-section-title">辅助线索与负面查证（{negative.length}）</h3>
                  {negative.map((e: any) => (
                    <div key={e.id} className="clue-card">
                      <div className="clue-card-head">
                        <strong>{e.plainTitle || e.kind}</strong>
                        <span>{evidenceExclusionReason(e)}</span>
                      </div>
                      <p>{humanizeEvidenceDescription(e.description)}</p>
                      {e.examNote && <p className="clue-review">检定理由：{e.examNote}</p>}
                      {e.sourceTitle && <a href={e.sourceUrl} target="_blank" rel="noreferrer">核验《{e.sourceTitle}》↗</a>}
                      {(e.targetQuote || e.sourceQuote) && (
                        <details className="clue-quote-details">
                          <summary>{e.targetQuote && e.sourceQuote ? '查看校正后的双侧原句' : '查看可验证的原句'}</summary>
                          <div className="clue-quote-grid">
                            {e.targetQuote && <blockquote><b>被检内容</b>{stripMarkdownMedia(e.targetQuote)}</blockquote>}
                            {e.sourceQuote && <blockquote><b>参照源文</b>{stripMarkdownMedia(e.sourceQuote)}</blockquote>}
                          </div>
                        </details>
                      )}
                    </div>
                  ))}
                </>
              )}
            </>
          );
        })()}

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

        {Array.isArray(doc.externalClaims) && doc.externalClaims.length > 0 && (
          <section className="external-claims" aria-labelledby="external-claims-title">
            <h3 id="external-claims-title">外界指控材料（{doc.externalClaims.length}）</h3>
            <p className="evidence-standard-note">仅列与被检主体直接相关且符合报道体例的公开材料；不替代原文比对。</p>
            {doc.externalClaims.map((claim, index) => (
              <article key={`${claim.url}-${index}`}>
                <a href={claim.url} target="_blank" rel="noreferrer">{claim.title} ↗</a>
                {claim.snippet && <p>{claim.snippet}</p>}
              </article>
            ))}
          </section>
        )}

        {(doc as any).prosecution && (
          <div className="argument-grid" style={{ marginTop: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="argument-card prosecution" style={{ padding: 10, border: '1px solid rgba(107,143,113,.4)', borderRadius: 6, background: 'rgba(107,143,113,.06)' }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>公诉人立论</div>
              <div style={{ fontSize: 13, lineHeight: 1.8 }}>{(doc as any).prosecution.argument}</div>
              {(doc as any).prosecution.charges?.map((c: any, i: number) => (
                <div key={i} className="hint" style={{ marginTop: 4 }}>· {c.charge}</div>
              ))}
            </div>
            <div className="argument-card defense" style={{ padding: 10, border: '1px solid rgba(176,122,30,.4)', borderRadius: 6, background: 'rgba(176,122,30,.06)' }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>辩护人驳斥</div>
              <div style={{ fontSize: 13, lineHeight: 1.8 }}>{(doc as any).defense?.overall || '（无）'}</div>
              {(doc as any).defense?.attacks?.map((a: any, i: number) => (
                <div key={i} className="hint" style={{ marginTop: 4 }}>· {a.reason}</div>
              ))}
            </div>
          </div>
        )}

        {Array.isArray(doc.debateRounds) && doc.debateRounds.length > 0 && (
          <details className="debate-record">
            <summary>控辩轮次（{doc.debateRounds.length} 轮）</summary>
            {doc.debateRounds.map((round) => (
              <div className="debate-round" key={round.round}>
                <strong>第 {round.round} 轮</strong>
                <p><span>公诉人</span>{round.prosecution}</p>
                <p><span>辩护人</span>{round.defense}</p>
              </div>
            ))}
          </details>
        )}

        <h3 style={{ fontFamily: 'var(--serif)', fontWeight: 900, margin: '16px 0 8px' }}>法官意见</h3>
        <p style={{ margin: 0, lineHeight: 1.9 }}>{doc.opinion}</p>

        <h3 style={{ fontFamily: 'var(--serif)', fontWeight: 900, margin: '16px 0 8px' }}>核查范围与局限</h3>
        <ul style={{ margin: 0, paddingLeft: 22, lineHeight: 1.9 }}>
          {visibleLimits.map((l, i) => (
            <li key={i}><LinkifiedText text={l} /></li>
          ))}
        </ul>

        {doc.caseFile.trialLog && doc.caseFile.trialLog.length > 0 && (
          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: 'pointer', fontFamily: 'var(--serif)', fontWeight: 700 }}>庭审记录（{doc.caseFile.trialLog.length} 条）——各角色动作留痕</summary>
            <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.9, opacity: 0.85, maxHeight: 300, overflowY: 'auto' }}>
              {doc.caseFile.trialLog.map((l: any, i: number) => (
                <div className="trial-log-line" key={i}>
                  <time>{formatLocalTime(l.at)}</time>
                  <strong>{roleZh(l.role)}</strong>
                  <span>{formatTrialAction(l.role, l.action)}</span>
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="verdict-actions">
          <button className="btn btn-primary" onClick={onExportHtml} disabled={exporting}>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// 判例集
// ---------------------------------------------------------------------------

function Archive({ onOpen }: { onOpen: (doc: VerdictDoc) => void }): React.ReactElement {
  const [metas, setMetas] = useState<ReturnType<typeof import('../store/local').loadArchiveMetas>>([]);
  React.useEffect(() => {
    import('../store/local').then((m) => setMetas(m.loadArchiveMetas()));
  }, []);
  return (
      <section className="panel court-sheet archive-panel">
        <div className="panel-heading-row">
          <h2 className="panel-title">判例集</h2>
          <span className="status-chip">本机存档 · {metas.length} 件</span>
        </div>
        <p className="page-intro">每次宣判后，案卷会保存在当前浏览器。你可以查看全卷、导出判决书，或删除不再需要的记录。</p>
        {metas.length === 0 ? (
          <div className="empty-docket">
            <span aria-hidden="true">○</span>
            <strong>卷宗架还是空的</strong>
            <p>完成一次核查后，判决会自动出现在这里。</p>
          </div>
        ) : (
          <div className="table-scroll">
          <table className="table archive-table">
            <thead>
              <tr>
                <th>案号</th>
                <th>标的</th>
                <th>裁决</th>
                <th>错误照搬</th>
                <th>时间</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {metas.map((m) => (
                <tr key={m.caseId}>
                  <td data-label="案号" className="archive-case-id">{m.caseId}</td>
                  <td data-label="标的" className="archive-title">{m.title.slice(0, 40)}</td>
                  <td data-label="裁决">
                    <span className={'badge v-' + m.verdictWord}>{m.verdictWord}</span>
                  </td>
                  <td data-label="错误照搬">{m.e4}</td>
                  <td data-label="时间">{m.generatedAt.slice(0, 16).replace('T', ' ')}</td>
                  <td data-label="操作">
                    <div className="archive-actions">
                    <button
                      className="btn btn-ghost btn-compact"
                      onClick={async () => {
                        const mod = await import('../store/local');
                        const d = mod.loadArchiveDoc(m.caseId);
                        if (d) onOpen(d as VerdictDoc);
                      }}
                    >
                      查看
                    </button>
                    <button
                      className="btn btn-ghost btn-compact"
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
                      className="btn btn-ghost btn-compact btn-danger-quiet"
                      onClick={async () => {
                        if (!window.confirm(`删除案卷 ${m.caseId}？此操作无法撤销。`)) return;
                        const mod = await import('../store/local');
                        mod.deleteFromArchive(m.caseId);
                        setMetas(mod.loadArchiveMetas());
                      }}
                    >
                      删除
                    </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </section>
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
  const [savedSnapshot, setSavedSnapshot] = useState(() => {
    try {
      return localStorage.getItem('health-court.settings.v1') || JSON.stringify(DEFAULT_SETTINGS);
    } catch {
      return '';
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
    setSavedSnapshot(JSON.stringify(s));
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };
  const dirty = JSON.stringify(s) !== savedSnapshot;
  const modelReady = !!(s.apiKey && s.baseUrl && s.model);
  const searchReady = s.searchProvider === 'provider'
    ? s.kind === 'glm' || s.kind === 'gemini'
    : true;
  const audioReady = s.asrKind === 'glm' ? s.kind === 'glm' && !!s.apiKey : !!s.groqApiKey;
  const providerPresets = presetsForProvider(s.kind);
  const selectedPreset = providerPresets.find((preset) => preset.model === s.model && preset.baseUrl === s.baseUrl);
  const applyProvider = (kind: typeof s.kind) => {
    const preset = defaultPresetForProvider(kind);
    setS((previous) => previous ? { ...previous, kind, model: preset.model, baseUrl: preset.baseUrl, searchModel: kind === 'glm' ? previous.searchModel : '' } : previous);
  };
  const applyPreset = (presetId: string) => {
    const preset = providerPresets.find((item) => item.id === presetId);
    if (preset) setS((previous) => previous ? { ...previous, model: preset.model, baseUrl: preset.baseUrl } : previous);
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    const lines: string[] = [];
    try {
      // ① 主模型
      try {
        const { createGlmProvider } = await import('../providers/glm');
        const { createOpenAiCompatProvider } = await import('../providers/openai-compat');
        const { createDeepSeekProvider, createGeminiProvider } = await import('../providers/multi');
        let p;
        if (s.kind === 'glm') p = createGlmProvider({ apiKey: s.apiKey, baseUrl: s.baseUrl, model: s.model });
        else if (s.kind === 'deepseek') p = createDeepSeekProvider({ apiKey: s.apiKey, model: s.model || 'deepseek-v4-flash' });
        else if (s.kind === 'gemini') p = createGeminiProvider({ apiKey: s.apiKey, model: s.model || 'gemini-3.7-flash' });
        else p = createOpenAiCompatProvider({ apiKey: s.apiKey, baseUrl: s.baseUrl, model: s.model });
        const r = await p.chat([{ role: 'user', content: '连通性自检：请回答"就绪"。' }], { maxTokens: 20 });
        lines.push(`① 主模型 ${r.model}：✅ 连通`);
      } catch (e: any) {
        lines.push(`① 主模型：❌ ${String(e.message).slice(0, 90)}`);
      }
      // ② 搜索通道
      try {
        if (s.searchProvider === 'serper') {
          const { createSerperSearch, sharedSearchRemaining } = await import('../providers/serper');
          if (s.serperApiKey) {
            const sp = createSerperSearch({ userApiKey: s.serperApiKey });
            const { docs } = await sp.search('connectivity test');
            lines.push(`② 搜索 Serper（自有 Key）：✅ 返回 ${docs.length} 条`);
          } else {
            const left = sharedSearchRemaining();
            lines.push(`② 搜索 Serper（共享额度）：${left > 0 ? `✅ 本案剩余 ${left} 次` : '⚠️ 共享额度已用尽，建议注册自己的 Key'}`);
          }
        } else {
          if (s.kind === 'deepseek' || s.kind === 'openai-compat') {
            lines.push('② 搜索：⚠️ 当前主模型无内置检索，请切换搜索通道为 Serper');
          } else {
            const { docs } = await (async () => {
              const { createSerperSearch } = await import('../providers/serper');
              void createSerperSearch;
              return { docs: [] };
            })();
            lines.push(`② 搜索 主模型内置（${s.kind === 'glm' ? 'GLM web_search' : 'Gemini google_search'}）：将在开庭时实测`);
          }
        }
      } catch (e: any) {
        lines.push(`② 搜索：❌ ${String(e.message).slice(0, 90)}`);
      }
      // ③ 语音转录
      try {
        if (s.asrKind === 'groq') {
          if (!s.groqApiKey) {
            lines.push('③ 转录 Groq：⚠️ 未填 Key——提交播客单集将无法自动转录（console.groq.com 免费注册）');
          } else {
            lines.push('③ 转录 Groq whisper-large-v3：✅ Key 已配置（首次转录时实测）');
          }
        } else {
          lines.push('③ 转录 GLM ASR：复用主模型 Key（需 bigmodel 账户含 ASR 额度，首次转录时实测）');
        }
      } catch (e: any) {
        lines.push(`③ 转录：❌ ${String(e.message).slice(0, 90)}`);
      }
      setTestResult(lines.join('\n'));
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="panel court-sheet settings-panel">
      <div className="panel-heading-row">
        <h2 className="panel-title">设置</h2>
        <span className="status-chip">BYOK · 本地保存</span>
      </div>
      <p className="page-intro">依次接通主模型、搜索取证与音频转录。未使用的可选项可以留空。</p>
      <div className="key-warn privacy-note">
        API Key 保存在当前浏览器的 localStorage 中；核查请求由浏览器直接发送至所选服务。请勿在公共设备上保存密钥。
      </div>

      <div className="settings-status-grid" aria-label="配置状态">
        <div className={modelReady ? 'is-ready' : 'is-missing'}><b>主模型</b><span>{modelReady ? '已配置' : '必填'}</span></div>
        <div className={searchReady ? 'is-ready' : 'is-missing'}><b>搜索取证</b><span>{searchReady ? '可用' : '需改用 Serper'}</span></div>
        <div className={audioReady ? 'is-ready' : 'is-optional'}><b>音频转录</b><span>{audioReady ? '已配置' : '按需配置'}</span></div>
      </div>

      <div className="settings-group">
        <div className="settings-group-heading">
          <span>01</span>
          <div><h3>主模型</h3><p>负责案情画像、候选分析与判词生成。</p></div>
        </div>
        <div className="settings-grid">
          <div className="field field-wide">
            <label>模型供应商</label>
            <select value={s.kind} onChange={(e) => applyProvider(e.target.value as typeof s.kind)}>
              <option value="glm">GLM（智谱 bigmodel，默认）</option>
              <option value="deepseek">DeepSeek</option>
              <option value="gemini">Google Gemini</option>
              <option value="openai-compat">OpenAI 兼容端点</option>
            </select>
            <div className="desc settings-links">
              获取密钥：<a href="https://open.bigmodel.cn" target="_blank" rel="noreferrer">GLM ↗</a> · <a href="https://platform.deepseek.com" target="_blank" rel="noreferrer">DeepSeek ↗</a> · <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio ↗</a>
            </div>
          </div>
          <div className="field field-wide model-preset-field">
            <label>推荐方案</label>
            <select value={selectedPreset?.id || 'manual'} onChange={(e) => applyPreset(e.target.value)}>
              {providerPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
              <option value="manual">手动配置</option>
            </select>
            <div className="model-preset-note">
              <span>{selectedPreset?.note || '当前为手动配置；模型名称和接口地址均可继续修改。'}</span>
              {selectedPreset && <a href={selectedPreset.docsUrl} target="_blank" rel="noreferrer">官方模型页 ↗</a>}
            </div>
          </div>
          <div className="field">
            <label>API Key</label>
            <input type="password" value={s.apiKey} onChange={(e) => setS({ ...s, apiKey: e.target.value })} placeholder="填入所选供应商的密钥" />
          </div>
          <details className="settings-advanced field-wide">
            <summary>高级连接参数</summary>
            <div className="settings-grid settings-grid-nested">
              <div className="field">
                <label>接口地址（Base URL）</label>
                <input value={s.baseUrl} onChange={(e) => setS({ ...s, baseUrl: e.target.value })} />
              </div>
              <div className="field">
                <label>主模型名称</label>
                <input value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} spellCheck={false} />
              </div>
              {s.kind === 'glm' && (
                <div className="field field-wide">
                  <label>检索模型（选填）</label>
                  <input value={s.searchModel} onChange={(e) => setS({ ...s, searchModel: e.target.value })} placeholder="留空则使用主模型" />
                </div>
              )}
            </div>
          </details>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-heading">
          <span>02</span>
          <div><h3>搜索取证</h3><p>寻找候选来源，并抓取可供对质的页面正文。</p></div>
        </div>
        <div className="settings-grid">
          <div className="field field-wide">
            <label>选择搜索通道</label>
            <div className="settings-choice-grid">
              <button type="button" className={s.searchProvider === 'serper' ? 'is-selected' : ''} onClick={() => setS({ ...s, searchProvider: 'serper' })}>
                <b>Serper</b><span>默认；共享 Key 每案 60 次。填自有 Key 后应用不限制次数。</span>
              </button>
              <button type="button" className={s.searchProvider === 'provider' ? 'is-selected' : ''} onClick={() => setS({ ...s, searchProvider: 'provider' })}>
                <b>主模型内置检索</b><span>仅适合 GLM / Gemini；具体额度由模型账户决定。</span>
              </button>
            </div>
            {!searchReady && <div className="settings-inline-warning">当前供应商没有可用的内置检索，请选择 Serper。</div>}
          </div>
          {s.searchProvider === 'serper' && (
            <div className="field field-wide">
              <label>自有 Serper API Key（选填）</label>
              <input type="password" value={s.serperApiKey} onChange={(e) => setS({ ...s, serperApiKey: e.target.value })} placeholder="留空使用共享 Key；高频核查建议填写" />
              <div className="desc"><a href="https://serper.dev" target="_blank" rel="noreferrer">前往 serper.dev ↗</a> · 自有 Key 仅受服务商账户额度约束。</div>
            </div>
          )}
          <details className="settings-advanced field-wide">
            <summary>页面抓取高级项</summary>
            <div className="field settings-single-field">
              <label>Jina API Key（选填）</label>
              <input type="password" value={s.jinaApiKey} onChange={(e) => setS({ ...s, jinaApiKey: e.target.value })} placeholder="留空使用公开额度" />
            </div>
          </details>
        </div>
      </div>

      <details className="settings-group settings-optional-group">
        <summary className="settings-group-heading">
          <span>03</span>
          <div><h3>音频转录 <em>按需</em></h3><p>仅在播客页面没有正文时启用；点击展开配置。</p></div>
        </summary>
        <div className="settings-grid">
          <div className="field field-wide">
            <label>转录服务</label>
            <select value={s.asrKind} onChange={(e) => setS({ ...s, asrKind: e.target.value as any })}>
              <option value="groq">Groq · whisper-large-v3</option>
              <option value="glm">GLM ASR（复用主模型 Key）</option>
            </select>
          </div>
          {s.asrKind === 'groq' && (
            <div className="field field-wide">
              <label>Groq API Key</label>
              <input type="password" value={s.groqApiKey} onChange={(e) => setS({ ...s, groqApiKey: e.target.value })} placeholder="在 console.groq.com 创建" />
              <div className="desc"><a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">打开 Groq API Keys ↗</a></div>
            </div>
          )}
        </div>
      </details>

      <div className="settings-actions">
        <button className="btn btn-primary" onClick={save} disabled={!s.apiKey || !dirty}>
          {dirty ? '保存设置' : '已保存'}
        </button>
        <button className="btn btn-ghost" onClick={test} disabled={testing || !s.apiKey}>
          {testing ? '检测中…' : '连通性自检'}
        </button>
        {saved && <span className="save-state" role="status">已保存 ✓</span>}
        {!saved && dirty && <span className="save-state is-dirty" role="status">有未保存更改</span>}
      </div>
      {testResult && (
        <div className="connection-result" role="status">
          {testResult}
        </div>
      )}
      <p className="settings-footnote">用量随文本长度和候选源数量变化；连通性自检只检查接口是否可用，不代表一次完整庭审必然成功。</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 关于
// ---------------------------------------------------------------------------

function About(): React.ReactElement {
  return (
    <section className="panel court-sheet about-body">
      <div className="panel-heading-row">
        <h2 className="panel-title">关于卫生法庭</h2>
        <span className="status-chip">文本来源核查</span>
      </div>
      <p className="about-lede">卫生法庭用于核查一段文本与既有来源之间的表达、材料和结构关系。它把复杂的检索过程组织成一场庭审，但不会替你作法律判断。</p>

      <div className="about-stage-line" aria-label="工作流程">
        {STAGES.map((stage, index) => <span key={stage}><b>{String(index + 1).padStart(2, '0')}</b>{stage}</span>)}
      </div>

      <h3>它如何工作</h3>
      <p>模型参与案情画像、检索词生成、候选比对与判词撰写；程序继续检查主体关系、来源质量、引文定位、新闻公共事实降级和裁决阈值。漫画演出只负责呈现，不改变证据。</p>
      <p>正面证据必须有双侧可定位引文并通过检定；针对明确候选源完成的负面查证也计入正式查证组。至少形成 {MIN_ADMISSIBLE_EVIDENCE_GROUPS} 个独立组，才进入倾向性裁决。同题材页面、公共新闻事实和未定位引文只列为线索。</p>
      <p>检索无法穷尽版权墙内、未数字化或尚未被索引的材料，因此「未发现」不等于「证明清白」。判决书会同时列出命中、未命中和核查局限，供你自行复核。</p>

      <h3>本庭核查什么</h3>
      <p className="section-intro">同一话题、常识或单个公共事实不会单独触发裁决；重点是文本如何选材、排列和表达。</p>
      <div className="table-scroll">
      <table className="table criteria-table">
        <thead>
          <tr><th>判据</th><th>问题</th></tr>
        </thead>
        <tbody>
          {PLAIN_CRITERIA.map((c) => (
            <tr key={c.name}>
              <td><b>{c.name}</b></td>
              <td>{c.question.replace(/"([^"]+)"/g, '「$1」')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <details className="about-details">
        <summary>查看内部证据分级（E1—E5）</summary>
        <div className="table-scroll">
      <table className="table evidence-scale-table">
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
        </div>
      </details>

      <h3>裁决怎么读</h3>
      <div className="ruling-grid">
        <div className="ruling-card is-red"><strong>不卫生</strong><p>正式证据达到立案门槛，并发现相同错误传播，或形成结构与多处罕见材料相互支撑的证据链。</p></div>
        <div className="ruling-card is-gold"><strong>可能不卫生</strong><p>正式证据达到立案门槛且出现具体对应，但现有证据仍不足以排除巧合。</p></div>
        <div className="ruling-card is-green"><strong>可能卫生</strong><p>在本次可达来源和对质范围内没有发现达到阈值的来源依赖痕迹。</p></div>
        <div className="ruling-card is-blue"><strong>不足立案</strong><p>存在可展示的线索，但正式证据不足 {MIN_ADMISSIBLE_EVIDENCE_GROUPS} 组，不出具倾向性裁决。</p></div>
        <div className="ruling-card is-gray"><strong>休庭</strong><p>内容不可得，或多轮检索后仍没有可供对质的候选来源。</p></div>
      </div>

      <h3>数据与边界</h3>
      <p>本站前端部署在 GitHub Pages，没有项目自建的业务服务器。API Key 与判例保存在当前浏览器；文本、来源页面或音频会按你的配置直接发送至模型、搜索、抓取或转录服务。使用前请确认相应服务的隐私政策，并避免提交敏感内容。</p>
      <div className="footnote-box">{DISCLAIMER}</div>
    </section>
  );
}
