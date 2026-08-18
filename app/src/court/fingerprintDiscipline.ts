// 指纹纪律与源卫生（机制 PRD v2 §3.1/§3.2）——全部确定性规则，LLM 之前
// 338 案回归金标准：
//   保留：willy-nilly tellegram（weird_term 短引文）、威廉二世长段描述
//   淘汰：1914年一战爆发（公共事实+过短）、147-德国为何…（自指单集标题）、
//        2026年5月5日 UTC 03:08（纯时间戳）、Ravel Sonatine（过短非weird）

import type { FingerprintCandidate } from './types';
import { locateQuote, normalize } from './textUtils';

/** 归一化有效长度（去空白标点后） */
function effectiveLen(s: string): number {
  return normalize(s).length;
}

/** 纯日期/时间戳指纹（"2026年5月5日 UTC 03:08"） */
const DATE_ONLY = /^[\s\d年月日时分秒:.\-\/utc上午下午零一二三四五六七八九十]+$/i;

/** 单集编号自指（"147-德国为何没变成…"） */
const EPISODE_NUM = /^\s*\d{1,3}\s*[-—－·.、]/;

/** 节目自指措辞 */
const SELF_REF = /(本期节目|上一期|下一期|第\s*\d+\s*期|欢迎收听|请订阅|相关播客)/;

/** 公共事实停用表（仅对短引文生效，<60字） */
const COMMON_FACTS = [
  /(第一次|第二次)世界?大战/,
  /(一战|二战)(爆发|结束|开始)/,
  /\d{4}\s*年.{0,8}(爆发|结束|开始|成立|灭亡|统一|革命)/,
  /统治时间/,
  /(出生|逝世|即位|退位)\s*于?\s*\d{4}/,
];

export interface DisciplineOptions {
  /** 节目名（用于自指检测；可空） */
  programName?: string;
  /** 本单集标题（用于自指检测；可空） */
  episodeTitle?: string;
}

export interface FingerpintRejection {
  fingerprint: FingerprintCandidate;
  reason: string;
}

/**
 * 指纹纪律主入口。规则（按序）：
 * 1. 长度门槛：weird_term ≥6，其余 ≥30（归一化后）
 * 2. 纯日期/时间戳 → 淘汰
 * 3. 单集编号开头 / 含节目自指措辞 / 含节目名或本集标题 → 淘汰（自指）
 * 4. 短引文（<60）命中公共事实停用表 → 淘汰
 * 5. 引文必须在目标文本中可定位（防 LLM 幻觉引文）→ 淘汰
 */
export function applyFingerprintDiscipline(
  fps: FingerprintCandidate[],
  targetText: string,
  opts: DisciplineOptions = {},
): { kept: FingerprintCandidate[]; rejected: FingerpintRejection[] } {
  const kept: FingerprintCandidate[] = [];
  const rejected: FingerpintRejection[] = [];
  const prog = opts.programName ? normalize(opts.programName) : '';
  const epiTitle = opts.episodeTitle ? normalize(opts.episodeTitle) : '';

  for (const fp of fps) {
    const q = fp.targetQuote;
    const n = effectiveLen(q);
    const reason = rejectReason(fp, n, q, prog, epiTitle, targetText);
    if (reason) rejected.push({ fingerprint: fp, reason });
    else kept.push(fp);
  }
  return { kept, rejected };
}

function rejectReason(
  fp: FingerprintCandidate,
  n: number,
  q: string,
  prog: string,
  epiTitle: string,
  targetText: string,
): string | null {
  // 语义性淘汰优先于长度淘汰（原因标签更准确）：日期/自指/公共事实先判
  if (DATE_ONLY.test(q.trim())) return '纯日期/时间戳';
  if (EPISODE_NUM.test(q.trim())) return '单集编号自指';
  if (SELF_REF.test(q)) return '节目自指措辞';
  const nq = normalize(q);
  if (prog && prog.length >= 4 && nq.includes(prog)) return '含节目名（自指）';
  if (epiTitle && epiTitle.length >= 10 && nq.includes(epiTitle)) return '含本集标题（自指）';
  // 停用表仅对短引文生效（<60字）：长段描述即使提及年份/在位期也可能是特异内容
  if (n < 60 && COMMON_FACTS.some((re) => re.test(q))) return '公共事实（停用表）';
  const minLen = fp.type === 'weird_term' ? 6 : 30;
  if (n < minLen) return `长度不足（${n} < ${minLen}）`;
  if (targetText && !locateQuote(q, targetText)) return '引文无法在目标文本中定位（疑似幻觉）';
  return null;
}

// ---------------------------------------------------------------------------
// 源卫生：自我镜像与通用平台页排除（修 338 案 SRC1「Facebook」）
// ---------------------------------------------------------------------------

/** 通用社交/平台壳页面标题（无实质内容特征） */
const GENERIC_PLATFORM_TITLES =
  /^(facebook|twitter|x \(twitter\)|x|instagram|youtube|微博|哔哩哔哩|bilibili|抖音|小红书|知乎|豆瓣|linkedin|threads|tiktok|pinterest|reddit|quora)$/i;

export interface SourceLike {
  title: string;
  url: string;
  snippet?: string;
}

export interface TargetLike {
  title: string;
  url?: string;
  author?: string;
}

/**
 * 判定候选源是否为目标的自我镜像（作者/节目自身的分发渠道）或通用平台壳页。
 * 镜像源不参与对质（自我匹配污染证据链），转"归属链佐证"。
 */
export function isMirrorOrGenericSource(src: SourceLike, target: TargetLike): {
  mirror: boolean;
  generic: boolean;
  note: string;
} {
  const t = (src.title || '').trim();
  if (GENERIC_PLATFORM_TITLES.test(t)) {
    return { mirror: false, generic: true, note: '通用平台壳页面（无独立内容）' };
  }
  // 同域镜像
  try {
    if (target.url) {
      const d = (u: string) => {
        try {
          return new URL(u).hostname.replace(/^www\./, '');
        } catch {
          return '';
        }
      };
      if (d(src.url) && d(src.url) === d(target.url)) {
        return { mirror: true, generic: false, note: '与目标同域' };
      }
    }
  } catch { /* ignore */ }
  // 节目/作者名出现在源标题或摘要 → 疑似自身分发渠道
  const names: string[] = [];
  if (target.author && target.author.length >= 4) names.push(target.author);
  // 标题模式 "338-xxx - 独树不成林 - Apple 播客" 的中段
  const seg = (target.title || '').split(' - ');
  if (seg.length >= 3) names.push(seg[seg.length - 2]);
  for (const nm of names) {
    if (nm.length >= 4 && ((src.title || '').includes(nm) || (src.snippet || '').slice(0, 500).includes(nm))) {
      return { mirror: true, generic: false, note: `含目标节目/作者名「${nm}」，疑似自身分发渠道` };
    }
  }
  return { mirror: false, generic: false, note: '' };
}
