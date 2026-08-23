// v3.6 庭审中断快照（2026-08-23 高优待办落地）：
// 对质/检索阶段产出阶段化快照写入 localStorage——网络中断或误刷新后，
// 从最后完成的阶段续跑，不再「54 分钟案跑到宣判前全丢」。
//
// 设计约束：
// 1. 绝不写入 Key/provider 对象（快照只含案卷与材料，续跑时从当前设置重建 provider）
// 2. quota 安全：localStorage ~5MB，转录稿+源全文可能超限——三级降级
//    （全文 → 源全文截断 40K → 丢弃源全文仅留摘要与证据引文），写入失败不阻塞庭审
// 3. 快照在阶段边界写入（立案/侦查/检索/波次/补充后），不是每个日志——写放大不可控

import type { CaseFile, SourceDoc } from '../court/types';
import type { EvidenceItem } from '../court/evidence';

const SNAPSHOT_KEY = 'health-court.trialSnapshot.v1';

/** 快照记录的最后完成阶段（续跑入口判定） */
export type SnapshotStage =
  | 'filed'        // 立案完成（含预审通过/自动转录）
  | 'investigated' // 侦查完成（画像/指纹已提取）
  | 'discovered'   // 检索完成（候选源已入卷，波次未开始）
  | 'waves'        // 第 1-2 波完成（有已对质源登记）
  | 'supplemented' // 第 3 波/补源后对质完成（证据齐备，可直接宣判）
;

export interface TrialSnapshot {
  version: 1;
  savedAt: string;
  stage: SnapshotStage;
  cf: CaseFile;
  sources: SourceDoc[];
  evidence: EvidenceItem[];
  waveExaminedIds?: string[];
  logs: { stage: string; note: string; at: string }[];
}

const SIZE_OK = 4.5 * 1024 * 1024; // 预留余量（settings/archive 同库共存）

function tryWrite(snap: TrialSnapshot): boolean {
  try {
    const raw = JSON.stringify(snap);
    if (raw.length > SIZE_OK) return false;
    localStorage.setItem(SNAPSHOT_KEY, raw);
    return true;
  } catch {
    return false;
  }
}

/** 保存快照（quota 三级降级；全部失败返回 false，不阻塞庭审主流程） */
export function saveTrialSnapshot(snap: TrialSnapshot): boolean {
  // 第一级：原样
  if (tryWrite(snap)) return true;
  // 第二级：源全文截断到 40K（已对质源的证据引文不受影响——引文在 evidence 里）
  const truncated: TrialSnapshot = {
    ...snap,
    sources: snap.sources.map((s) => ({
      ...s,
      fullText: s.fullText && s.fullText.length > 40000 ? s.fullText.slice(0, 40000) + '…[快照截断]' : s.fullText,
    })),
  };
  if (tryWrite(truncated)) return true;
  // 第三级：丢弃全部源全文（摘要+证据引文仍在，续跑对质深度降级但不废案）
  const lean: TrialSnapshot = {
    ...snap,
    sources: snap.sources.map((s) => ({ ...s, fullText: undefined })),
  };
  return tryWrite(lean);
}

export function loadTrialSnapshot(): TrialSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as TrialSnapshot;
    if (!snap || snap.version !== 1 || !snap.cf || !Array.isArray(snap.sources)) return null;
    return snap;
  } catch {
    return null;
  }
}

export function clearTrialSnapshot(): void {
  try {
    localStorage.removeItem(SNAPSHOT_KEY);
  } catch { /* 清理失败无害 */ }
}

/** 续跑起点说明（用户可见） */
export function stageLabelZh(stage: SnapshotStage): string {
  return ({
    filed: '立案完成',
    investigated: '侦查完成',
    discovered: '检索完成',
    waves: '对质进行中',
    supplemented: '对质完成（可宣判）',
  } as Record<SnapshotStage, string>)[stage] || stage;
}
