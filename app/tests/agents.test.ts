import { describe, it, expect } from 'vitest';
import { Orchestrator } from '../src/court/agents/orchestrator';
import { runProsecutor } from '../src/court/agents/prosecutor';
import { runDefender } from '../src/court/agents/defender';

describe('v3 审判长（确定性状态机）', () => {
  it('消息路由：登记+留痕+自增 id', () => {
    const o = new Orchestrator('HC-TEST');
    const m = o.route({ from: 'clerk', to: 'orchestrator', type: 'REGISTRY_READY', payload: { sources: 12 } });
    expect(m.id).toBe('M1');
    expect(o.session.messages).toHaveLength(1);
    expect(o.session.agentLog.some((l) => l.action.includes('REGISTRY_READY'))).toBe(true);
    o.route({ from: 'evidence_officer', to: 'clerk', type: 'REQUEST_COLLECT', payload: {} });
    expect(o.session.messages[1].id).toBe('M2');
  });
  it('补证上限 2 轮', () => {
    const o = new Orchestrator('X');
    expect(o.canRecollect()).toBe(true);
    o.session.recollectRounds = 2;
    expect(o.canRecollect()).toBe(false);
  });
  it('辩论默认 1 轮，最多加 1 轮（canExtendDebate）', () => {
    const o = new Orchestrator('X');
    o.session.round = 1;
    expect(o.canExtendDebate()).toBe(true);
    o.session.round = 2;
    expect(o.canExtendDebate()).toBe(false);
  });
});

describe('v3 公诉人/辩护人（上下文隔离）', () => {
  const mkEv = (id: string, level: string) =>
    ({ id, level, kind: '细节比对', description: '测试证据', targetQuote: '目标引文一句。第二句。', sourceQuote: 'Source quote one. Second.', sourceTitle: '测试源' } as any);

  it('公诉人：无正面证据时提交空立论书（不调 LLM）', async () => {
    const o = new Orchestrator('X');
    let called = 0;
    const chat = async () => { called++; return {}; };
    const brief = await runProsecutor(o, chat as any, [mkEv('EV-NEG-1', 'E1')], [], '测试目标');
    expect(called).toBe(0); // 零证据不出手
    expect(brief?.argument).toContain('未能提出指控');
    expect(o.session.agentLog.some((l) => l.action.includes('空立论书'))).toBe(true);
  });

  it('辩护人：LLM 失败时降级返回 null（不阻塞流程）', async () => {
    const o = new Orchestrator('X');
    const chat = async () => { throw new Error('LLM down'); };
    const r = await runDefender(o, chat as any, [mkEv('EV-1', 'E3')], { rankedEvidenceIds: ['EV-1'], argument: 'x', charges: [] }, '测试目标');
    expect(r).toBeNull();
    expect(o.session.agentLog.some((l) => l.action.includes('降级跳过'))).toBe(true);
  });

  it('公诉人材料只含证据清单（不含目标/源全文——隔离验证）', async () => {
    const o = new Orchestrator('X');
    let seenUser = '';
    const chat = async (_s: string, user: string) => {
      seenUser = user;
      return { rankedEvidenceIds: [], argument: 'a', charges: [] };
    };
    await runProsecutor(o, chat as any, [mkEv('EV-1', 'E3')], [{ id: 'SRC1', title: '源A', similarity: 90 } as any], '目标标题');
    expect(seenUser).toContain('证据清单');
    expect(seenUser).not.toContain('fullText'); // 全文不进公诉人上下文
  });
});
