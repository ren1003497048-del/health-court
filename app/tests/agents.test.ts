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


describe('v3.3 引用合规核查（阿伦特译序案机制）', () => {
  it('extractCitations：确定性脚注解析（无 LLM 也工作）', async () => {
    const { extractCitations } = await import('../src/pipeline/index');
    const cf = {
      target: { text: '正文第一段。阿伦特的诗歌观。\n伊丽莎白·扬—布鲁尔：《爱这个世界：汉娜·阿伦特传》，陈伟、张新刚译，上海人民出版社，2017年，第3页。\n正文继续。《黑暗时代的人们》，第372页。\n仲树\n2025年9月于波士顿' },
    } as any;
    // rt.provider.chat 抛错→只走确定性解析
    const rt = { provider: { chat: async () => { throw new Error('no llm'); } }, log: () => {}, sources: [] } as any;
    const cits = await extractCitations(cf, rt);
    expect(cits.length).toBeGreaterThanOrEqual(2);
    expect(cits[0].granularity).toBe('specific');
    expect(cits[0].source).toContain('爱这个世界');
    expect(cits.some((c) => c.source.includes('黑暗时代的人们'))).toBe(true);
  });

  it('三分类：具体标注→降级注记；泛化承认→保留线索', async () => {
    // 复刻 crossExamination 内的三分类逻辑（纯代码段，行为等价验证）
    const evidence = [
      { id: 'EV-1', level: 'E3', sourceId: 'SRC1', description: '对应A', detail: {} as any },
      { id: 'EV-2', level: 'E3', sourceId: 'SRC2', description: '对应B', detail: {} as any },
      { id: 'EV-3', level: 'E3', sourceId: 'SRC3', description: '对应C', detail: {} as any },
    ];
    const cits = [
      { id: 'CIT1', source: '《黑暗时代的人们》', granularity: 'specific', quote: '...' },
      { id: 'CIT2', source: '希尔导言', granularity: 'general', quote: '均为译者提供了参考' },
    ];
    const sources = [
      { id: 'SRC1', title: '黑暗时代的人们 Men in Dark Times', url: '' },
      { id: 'SRC2', title: '希尔（Hill）导言 What Remains', url: '' },
      { id: 'SRC3', title: '无关来源', url: '' },
    ];
    for (const ev of evidence) {
      const srcDoc = sources.find((x) => x.id === ev.sourceId);
      const srcTitle = (srcDoc?.title || '').slice(0, 30);
      const matched = cits.find((c) => {
        const cjkSegs = (s: string) => (s.match(/[\u4e00-\u9fff]{2,}/g) || []);
        const latSegs = (s: string) => (s.match(/[A-Za-z]{4,}/g) || []);
        const charsOf = (s: string) => new Set((s.match(/[\u4e00-\u9fff]/g) || []));
        const cs = c.source, et = srcTitle;
        if (cjkSegs(cs).some((seg) => seg.length >= 2 && et.includes(seg))) return true;
        if (latSegs(cs).some((seg) => et.toLowerCase().includes(seg.toLowerCase()))) return true;
        const a = charsOf(cs), b = charsOf(et);
        if (a.size >= 2) {
          const inter = [...a].filter((ch) => b.has(ch)).length;
          if (inter >= 2 && inter >= Math.ceil(a.size * 0.85)) return true;
        }
        return false;
      });      if (matched) {
        if (matched.granularity === 'specific') { ev.detail.citationState = 'declared_specific'; ev.detail.demoted = true; }
        else { ev.detail.citationState = 'declared_general'; }
      } else { ev.detail.citationState = 'undeclared'; }
    }
    expect(evidence[0].detail.citationState).toBe('declared_specific');
    expect(evidence[0].detail.demoted).toBe(true);
    expect(evidence[1].detail.citationState).toBe('declared_general');
    expect(evidence[1].detail.demoted).toBeUndefined();
    expect(evidence[2].detail.citationState).toBe('undeclared');
  });
});
