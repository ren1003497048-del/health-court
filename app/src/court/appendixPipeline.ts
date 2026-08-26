// v3.9 附录生成管线：选源（纯函数）+ 荐读语（LLM，失败降级 AI 摘要）
import type { CaseFile } from './types';
import type { CourtRuntime } from '../pipeline';
import type { SourceDoc } from './types';
import { chatJson } from '../providers/types';
import {
  APPENDIX_NOTE_SYSTEM,
  APPENDIX_MIN,
  AppendixItem,
  formOf,
  normalizeAppendixNote,
  selectAppendixSources,
  tierOf,
} from './appendix';

export interface AppendixSection {
  kind: 'appendix_reading';
  intro: string;
  items: AppendixItem[];
}

const INTRO = '本附录由庭审检索过程中入卷的材料整理而成，与本案裁决无关，仅供读者按图索骥。';

/** 降级荐读语：LLM 失败时用已有 AI 摘要节选拼装（书目式、无裁决词） */
function fallbackNote(src: SourceDoc): string {
  const ai = String((src as any).aiSummary || '').trim();
  const head = String(src.fullText || '').replace(/\s+/g, ' ').slice(0, 180);
  const body = ai.length > 60 ? ai : head;
  return `这是一份与本案主题相关的公开材料。${body.slice(0, 200)}${body.length > 200 ? '…' : ''}（编者注：荐读语为材料摘要节选。）`;
}

export async function buildAppendix(
  cf: CaseFile,
  rt: CourtRuntime,
): Promise<AppendixSection> {
  const sources: SourceDoc[] = rt.sources || [];
  const targetUrl = String(cf.target?.url || '') || undefined;
  const picked = selectAppendixSources(sources, targetUrl);
  if (picked.length < APPENDIX_MIN) return { kind: 'appendix_reading', intro: INTRO, items: [] };

  const topic = String(cf.profile?.summaryZh || cf.target?.title || '').slice(0, 120);
  const items: AppendixItem[] = [];
  // v3.9.1 去雷同：把已写卡片的首句与结尾句注入后续调用，LLM 据此真正错开写法
  const writtenOpenings: string[] = [];
  const writtenEndings: string[] = [];
  for (const src of picked) {
    const base = {
      sourceId: String(src.id),
      title: String(src.title || '').trim() || '未命名材料',
      url: String(src.url || ''),
      tier: tierOf(src),
      form: formOf(src),
    };
    let note = '';
    try {
      const excerpt = String(src.fullText || '').replace(/\s+/g, ' ').slice(0, 3000);
      const ai = String((src as any).aiSummary || '').slice(0, 500);
      const priorCtx = writtenOpenings.length
        ? `\n\n【同卷其他卡片已用的开场（你的开场必须与之明显不同）】\n${writtenOpenings.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n【同卷其他卡片已用的结尾（你的结尾句式必须与之不同）】\n${writtenEndings.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
        : '';
      const out = await chatJson<any>(
        rt.provider.chat,
        APPENDIX_NOTE_SYSTEM,
        `案件主题：${topic}\n\n材料标题：${base.title}\n材料链接：${base.url}\n已有摘要：${ai || '（无）'}\n材料正文节选：\n${excerpt || '（正文未取得——只依据标题与已有摘要写，不确定的内容不要写）'}${priorCtx}`,
        { maxTokens: 1200 },
      );
      note = normalizeAppendixNote(out);
      if (note) {
        const sents = note.split(/[。！？]/).filter(Boolean);
        writtenOpenings.push(sents[0]?.slice(0, 40) || '');
        writtenEndings.push(sents[sents.length - 1]?.slice(0, 40) || '');
      }
    } catch {
      note = '';
    }
    if (!note || note.length < 40) note = fallbackNote(src);
    items.push({ ...base, note });
  }
  return { kind: 'appendix_reading', intro: INTRO, items };
}
