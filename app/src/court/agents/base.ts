// 卫生法庭 · 智能体角色基座
// 每个角色的 LLM 调用通过 isolated() 获得"只看本角色材料"的上下文：
// 调用方显式声明本子任务需要的材料片段，一次一评，评完即弃——
// 防跨阶段污染与超长上下文导致的注意力稀释。

import type { Orchestrator } from './orchestrator';

export interface AgentContext {
  role: string;
  orchestrator: Orchestrator;
  /** 角色可用的聊天通道（复用现有 ProviderAdapter.chat） */
  chat: (system: string, user: string, opts?: { maxTokens?: number }) => Promise<any>;
}

/** 角色构造器：绑定编排器与通道 */
export function agentContext(role: string, orch: Orchestrator, chat: AgentContext['chat']): AgentContext {
  return { role, orchestrator: orch, chat };
}

/**
 * 隔离执行：一次子任务 = 一次 LLM 调用 + 明确的材料清单 + 庭审留痕。
 * 失败自动降级（返回 null 并留痕），不阻塞流程——审判长原则 1。
 */
export async function isolated<T>(
  ctx: AgentContext,
  taskName: string,
  materials: Record<string, string>, // 本子任务可见材料（显式声明）
  run: (chat: AgentContext['chat']) => Promise<T>,
): Promise<T | null> {
  const totalChars = Object.values(materials).reduce((a, b) => a + b.length, 0);
  ctx.orchestrator.note(ctx.role as any, `子任务「${taskName}」启动（材料 ${Object.keys(materials).join('+')}，共 ${totalChars} 字符）`);
  try {
    const r = await run(ctx.chat);
    ctx.orchestrator.note(ctx.role as any, `子任务「${taskName}」完成`);
    return r;
  } catch (e: any) {
    ctx.orchestrator.note(ctx.role as any, `子任务「${taskName}」失败（${String(e?.message || e).slice(0, 80)}）——降级跳过`);
    return null;
  }
}
