// 卫生法庭 · 多智能体架构 v3（P1）
// 设计原则（2026-08-20 用户拍板）：
// 1. 审判长 = 确定性状态机（代码），不读全文、不做 LLM 编排——LLM 单点失败不得阻塞流程
// 2. 角色智能体各自隔离上下文：每次 LLM 调用只看本角色所需材料（防上下文污染/超限）
// 3. 智能体间只传结构化消息（AgentMessage，JSON schema 约束），全程留痕（agentLog）
// 4. 辩论默认 1 轮（公诉立论→辩护驳斥），法官可裁定加 1 轮
// 5. 转录分级：首块闸门 + 章节指纹跳跃（P4）

/** 智能体角色 */
export type AgentRole =
  | 'clerk' // 书记员：登记+资料搜集+源卫生+排序
  | 'evidence_officer' // 证据官：指纹提取/验证/比对/检定/转述（子任务各自隔离上下文）
  | 'prosecutor' // 公诉人：控方立论
  | 'defender' // 辩护人：辩方驳斥
  | 'judge' // 法官：裁决（映射确定性）+判词（LLM 读控辩双方）
  | 'court_clerk' // 法官助理：判决书整理
  | 'orchestrator'; // 审判长（状态机，非 LLM）

/** 智能体间消息（结构化，全留痕） */
export interface AgentMessage {
  id: string;
  from: AgentRole;
  to: AgentRole;
  /** 消息类型：见 MessageType */
  type: string;
  /** 结构化载荷（各类型自定义 schema） */
  payload: Record<string, unknown>;
  at: string; // ISO
  /** 轮次（辩论轮次等） */
  round?: number;
}

export type MessageType =
  | 'REGISTRY_READY' // 书记员→审判长：证据登记册就绪
  | 'EVIDENCE_READY' // 证据官→审判长：证据清单就绪
  | 'REQUEST_COLLECT' // 证据官→书记员（经审判长路由）：补充取证
  | 'COLLECT_RESULT' // 书记员→证据官：补证结果
  | 'BRIEF' // 公诉人→法官：立论书
  | 'REBUTTAL' // 辩护人→法官：驳斥书
  | 'VERDICT_DRAFT' // 法官→法官助理：裁决+判词
  | 'COURT_NOTE' // 任意→审判长：注记（不改变流程）

/** 庭审记录（判决书附录：谁在何时说了什么） */
export interface AgentLogEntry {
  at: string;
  role: AgentRole;
  action: string; // 人话描述，如「书记员完成登记：12 个候选源」
  detail?: string;
}

/** 审判长持有的会话状态 */
export interface TrialSession {
  caseId: string;
  /** 流程阶段 */
  stage:
    | 'filing'
    | 'registry' // 书记员
    | 'evidence' // 证据官
    | 'recollect' // 补证循环（≤2轮）
    | 'debate' // 控辩
    | 'verdict' // 法官
    | 'assembly' // 法官助理
    | 'closed';
  round: number; // 辩论轮次
  recollectRounds: number; // 已用补证轮次
  messages: AgentMessage[];
  agentLog: AgentLogEntry[];
  /** 预算（P4 转录闸门用） */
  budget: { transcriptionSources: number; searchCalls: number };
}

/** 审判长工具：记录与路由 */
export class Orchestrator {
  session: TrialSession;

  constructor(caseId: string) {
    this.session = {
      caseId,
      stage: 'filing',
      round: 0,
      recollectRounds: 0,
      messages: [],
      agentLog: [],
      budget: { transcriptionSources: 3, searchCalls: 0 },
    };
  }

  /** 留痕一条庭审记录 */
  note(role: AgentRole, action: string, detail?: string) {
    this.session.agentLog.push({ at: new Date().toISOString(), role, action, detail });
  }

  /** 智能体间消息（登记+留痕） */
  route(msg: Omit<AgentMessage, 'id' | 'at'>) {
    const full: AgentMessage = { ...msg, id: `M${this.session.messages.length + 1}`, at: new Date().toISOString() };
    this.session.messages.push(full);
    this.note(msg.from, `→ ${msg.to}：${msg.type}`);
    return full;
  }

  /** 补证请求是否还允许（≤2 轮） */
  canRecollect(): boolean {
    return this.session.recollectRounds < 2;
  }

  /** 辩论是否还允许加一轮（默认1轮，法官裁定最多加1轮） */
  canExtendDebate(): boolean {
    return this.session.round < 2;
  }
}
