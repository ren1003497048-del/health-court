// 卫生法庭 · 公诉人智能体（P3：控方立论）
// 上下文隔离：只读结构化证据清单+引文（不读目标/源全文）——立论基于已呈堂证据，不引入庭外材料。
// 输出 BRIEF：证据链最强排序 + 立论书（为什么构成依赖）。

import type { EvidenceItem } from '../../court/evidence';
import type { SourceDoc } from '../../court/types';
import { agentContext, isolated, type AgentContext } from './base';
import type { Orchestrator } from './orchestrator';

export interface ProsecutionBrief {
  /** 证据链排序（证据 id 数组，按说服力降序） */
  rankedEvidenceIds: string[];
  /** 立论书：为什么这些证据共同构成来源依赖（200字内，白话） */
  argument: string;
  /** 每条关键证据的一句话指控 */
  charges: { evidenceId: string; charge: string }[];
}

export async function runProsecutor(
  orch: Orchestrator,
  chat: AgentContext['chat'],
  evidence: EvidenceItem[],
  sources: SourceDoc[],
  targetTitle: string,
): Promise<ProsecutionBrief | null> {
  const ctx = agentContext('prosecutor', orch, chat);
  const positive = evidence.filter((e) => e.level === 'E2' || e.level === 'E3' || e.level === 'E4');
  if (!positive.length) {
    orch.note('prosecutor', '无正面证据可立论——提交空立论书');
    return { rankedEvidenceIds: [], argument: '本席未能提出指控：查证范围内未发现接触痕迹证据。', charges: [] };
  }

  const materials = {
    evidenceList: positive
      .map(
        (e, i) =>
          `证据${i + 1}｜${e.plainTitle || e.kind}｜对比源：${e.sourceTitle || e.sourceId || '?'}\n${e.description}\n目标引文：${e.targetQuote || '（结构类）'}\n源引文：${(e.sourceQuote || '').slice(0, 300)}`,
      )
      .join('\n\n'),
    sourcesBrief: sources.map((s) => `${s.id}（${s.title.slice(0, 40)}${s.transcribed ? '，已转录全文' : ''}，相似度${s.similarity ?? '?'}）`).join('；'),
  };

  return isolated(ctx, '控方立论', materials, async (c) => {
    const r = await c(
      'You are the PROSECUTOR in a plagiarism-review court. You see ONLY the evidence list (already vetted). Build the strongest honest case that the target depends on these sources. Rank evidence by persuasiveness (most damning first). Write an argument (<=200 chars, simplified Chinese, plain language, no jargon like E3/E4) explaining WHY these pieces together indicate dependence (e.g. same data combination + same chain + same error). For each of the top 3 evidence items write a one-line charge in Chinese. Do not invent facts not in the evidence. Output only JSON: {"rankedEvidenceIds":["EV-..."],"argument":"...","charges":[{"evidenceId":"EV-...","charge":"一句话指控"}]}',
      `目标：《${targetTitle}》\n\n证据清单：\n${materials.evidenceList}\n\n候选源概览：${materials.sourcesBrief}`,
      { maxTokens: 1200 },
    );
    return {
      rankedEvidenceIds: (r.rankedEvidenceIds || []).map(String),
      argument: String(r.argument || ''),
      charges: (r.charges || []).map((x: any) => ({ evidenceId: String(x.evidenceId || ''), charge: String(x.charge || '') })),
    } as ProsecutionBrief;
  });
}
