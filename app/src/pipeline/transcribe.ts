// 浏览器端音频转录管线（P0-3）：
// 音频 URL（enclosure/CDN，CORS 已实测开放）→ fetch → AudioContext 解码 →
// 重采样 16kHz 单声道 → 按 10 分钟切块（绕开 ASR 单文件 25MB 限制）→ WAV 编码 → ASR → 合并时间戳
// 母项目等价物：transcribe.py（ffmpeg 切片 + glm-asr-2512），此处为浏览器版。

import { transcribeAudio, type AsrConfig, type AsrSegment } from '../providers/multi';

const TARGET_SR = 16000;
const CHUNK_MINUTES = 10;

/** 获取音频并解码为 AudioBuffer */
async function fetchDecode(url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`音频获取失败 ${res.status}`);
  const buf = await res.arrayBuffer();
  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  try {
    return await ctx.decodeAudioData(buf);
  } finally {
    ctx.close();
  }
}

/** AudioBuffer → 16kHz 单声道 Float32 */
function resampleMono(audio: AudioBuffer): Float32Array {
  const chs = audio.numberOfChannels;
  const len = audio.length;
  const mix = new Float32Array(len);
  for (let c = 0; c < chs; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < len; i++) mix[i] += data[i] / chs;
  }
  if (audio.sampleRate === TARGET_SR) return mix;
  // 线性重采样（语音场景足够，ASR 对采样精度不敏感）
  const ratio = audio.sampleRate / TARGET_SR;
  const outLen = Math.floor(len / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const i1 = Math.min(i0 + 1, len - 1);
    out[i] = mix[i0] * (1 - frac) + mix[i1] * frac;
  }
  return out;
}

/** Float32 PCM → 16bit WAV Blob */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export interface TranscribeProgress {
  totalChunks: number;
  doneChunks: number;
  currentMinutes: string;
}

/** 主入口：转录整个音频 URL，返回合并的带时间戳分段与全文 */
export async function transcribeAudioUrl(
  audioUrl: string,
  cfg: AsrConfig,
  onProgress?: (p: TranscribeProgress) => void,
  opts?: { maxChunks?: number },
): Promise<{ segments: AsrSegment[]; fullText: string; durationSec: number }> {
  const audio = await fetchDecode(audioUrl);
  const mono = resampleMono(audio);
  const durationSec = mono.length / TARGET_SR;
  const chunkSec = CHUNK_MINUTES * 60;
  const totalChunks = Math.max(1, Math.ceil(durationSec / chunkSec));
  const chunksToDo = Math.min(totalChunks, opts?.maxChunks ?? totalChunks); // 首块闸门截断
  const all: AsrSegment[] = [];

  for (let ci = 0; ci < chunksToDo; ci++) {
    const startIdx = ci * chunkSec * TARGET_SR;
    const endIdx = Math.min(mono.length, startIdx + chunkSec * TARGET_SR);
    const slice = mono.subarray(startIdx, endIdx);
    const wav = encodeWav(slice, TARGET_SR);
    onProgress?.({
      totalChunks,
      doneChunks: ci,
      currentMinutes: `${Math.floor(startIdx / TARGET_SR / 60)}–${Math.floor(endIdx / TARGET_SR / 60)} 分钟`,
    });
    const segs = await transcribeAudio(wav, cfg);
    const offset = ci * chunkSec;
    for (const s of segs) all.push({ text: s.text, start: s.start + offset, end: s.end + offset });
  }

  // 合并为整段文本（带相对时间戳，供判决书引用定位）
  const fullText = all
    .map((s) => `[${fmt(s.start)}] ${s.text.trim()}`)
    .join('\n')
    .replace(/\n+/g, '\n');
  return { segments: all, fullText, durationSec };
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
