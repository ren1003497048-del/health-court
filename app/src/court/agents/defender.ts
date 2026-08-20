// 卫生法庭 · 辩护人智能体（P3：辩方驳斥）★新增角色
// 上下文隔离：读与公诉人相同的材料——天然对抗平衡。
// 职责：逐条攻击证据（巧合概率/公共事实/独立创作可能/方法盲区），整体反驳，可提出补证需求。

import type { EvidenceItem } from '../../court/evidence';
import { agentContext, isolated, type AgentContext } from './base';
import type { Orchestrator } from './orchestrator';
import type { ProsecutionBrief } from './prosecutor';

export interface DefenseRebuttal {
  /** 逐条攻击：evidenceId → 攻击角度与理由 */
  attacks: { evidenceId: string; angle: string; reason: string }[];
  /** 整体反驳（200字内白话） */
  overall: string;
  /** 若要补证需要什么（可为空——审判长据此决定是否加开辩论/补证） */
  whatWouldChange: string;
}

export async function runDefender(
  orch: Orchestrator,
  chat: AgentContext['chat'],
  evidence: EvidenceItem[],
  brief: ProsecutionBrief,
  targetTitle: string,
): Promise<DefenseRebuttal | null> {
  const ctx = agentContext('defender', orch, chat);
  const positive = evidence.filter((e) => e.level === 'E2' || e.level === 'E3' || e.level === 'E4');
  if (!positive.length) {
    orch.note('defender', '无指控需要驳斥');
    return { attacks: [], overall: '本席无异议：控方未提出证据。', whatWouldChange: '' };
  }

  const materials = {
    evidenceList: positive
      .map(
        (e, i) =>
          `证据${i + 1}（${e.id}）｜${e.plainTitle || e.kind}\n${e.description}\n目标引文：${e.targetQuote || '（结构类）'}\n源引文：${(e.sourceQuote || '').slice(0, 300)}`,
      )
      .join('\n\n'),
    prosecutionBrief: brief.argument + '\n' + brief.charges.map((c) => `- ${c.evidenceId}: ${c.charge}`).join('\n'),
  };

  return isolated(ctx, '辩方驳斥', materials, async (c) => {
    const r = await c(
      'You are the DEFENSE attorney in a plagiarism-review court. The prosecutor has built a case. Attack EVERY key evidence item from these angles (pick the strongest per item): coincidence probability (could independent creation produce this?), public-domain material (textbook facts / common tropes anyone could use), method blind spots (search not exhaustive / transcription noise / excerpt out of context), attribution (maybe the target credited the source?). Then write an overall rebuttal (<=200 chars, plain Chinese) and state what additional evidence would change your assessment. Be honest: if some evidence is genuinely strong, concede it rather than making weak objections. Output only JSON: {"attacks":[{"evidenceId":"EV-...","angle":"coincidence|public_domain|method_blindspot|attribution|concede","reason":"一句话中文"}],"overall":"...","whatWouldChange":"..."}',
      `目标：《${targetTitle}》\n\n控方立论：\n${materials.prosecutionBrief}\n\n证据清单：\n${materials.evidenceList}`,
      { maxTokens: 1500 },
    );
    return {
      attacks: (r.attacks || []).map((x: any) => ({ evidenceId: String(x.evidenceId || ''), angle: String(x.angle || ''), reason: String(x.reason || '') })),
      overall: String(r.overall || ''),
      whatWouldChange: String(r.whatWouldChange || ''),
    } as DefenseRebuttal;
  });
}
