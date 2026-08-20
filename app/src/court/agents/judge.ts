// 卫生法庭 · 法官智能体（P3：宣判）
// 裁决映射保持确定性代码（evidence.ts mapVerdict，不动）；
// LLM 部分只写判词——输入天然是对抗平衡的（控方立论+辩方驳斥+证据清单）。
// 可裁定加开一轮辩论（默认不开；whatWouldChange 指向明确缺口且 canExtendDebate 时才开）。

import type { EvidenceItem } from '../../court/evidence';
import { agentContext, isolated, type AgentContext } from './base';
import type { Orchestrator } from './orchestrator';
import type { ProsecutionBrief } from './prosecutor';
import type { DefenseRebuttal } from './defender';

export interface JudgeOpinion {
  opinion: string; // 判词（白话，引用控辩双方）
  extendDebate: boolean; // 是否建议加开一轮
}

export async function runJudge(
  orch: Orchestrator,
  chat: AgentContext['chat'],
  verdictWord: string,
  verdictRule: string,
  evidence: EvidenceItem[],
  brief: ProsecutionBrief | null,
  rebuttal: DefenseRebuttal | null,
  targetTitle: string,
): Promise<JudgeOpinion | null> {
  const ctx = agentContext('judge', orch, chat);
  const materials = {
    verdict: `${verdictWord}｜${verdictRule}`,
    prosecution: brief ? brief.argument : '（控方未立论）',
    defense: rebuttal ? rebuttal.overall : '（辩方未驳斥）',
    evidenceTop: evidence
      .filter((e) => e.level !== 'E1')
      .slice(0, 5)
      .map((e) => `${e.plainTitle || e.kind}：${e.description.slice(0, 80)}`)
      .join('\n'),
  };
  return isolated(ctx, '法官判词', materials, async (c) => {
    const r = await c(
      `You are the JUDGE writing the closing opinion (法官意见) for a plagiarism-review court. You see: the verdict (determined by fixed rules), the prosecutor's case, the defender's rebuttal, and the evidence summary. Write 120-250 chars in simplified Chinese: 1) acknowledge the strongest point from EACH side honestly; 2) explain what the verdict rests on; 3) state the limits (search coverage, unverified items). No jargon (E3/E4 banned), no internal codes. End naturally with 请依据材料自行判断. Also output extendDebate=true ONLY if the defender identified a concrete, checkable gap that a second round could actually resolve (not a general complaint). Output only JSON: {"opinion":"...","extendDebate":false}`,
      `目标：《${targetTitle}》\n裁决：${materials.verdict}\n\n控方立论：${materials.prosecution}\n\n辩方驳斥：${materials.defense}\n\n证据概要：\n${materials.evidenceTop}`,
      { maxTokens: 800 },
    );
    return { opinion: String(r.opinion || ''), extendDebate: !!r.extendDebate } as JudgeOpinion;
  });
}
