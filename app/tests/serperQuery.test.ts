import { describe, expect, it } from 'vitest';
import { sanitizeSerperQuery } from '../src/providers/serper';

// v3.9.2 通道精细化：引号查询清洗（LUV3FV 案 79% 空结果的头号嫌疑：长引号精确查询无命中面）

describe('sanitizeSerperQuery', () => {
  it('短引号段（≤24字符）原样保留', () => {
    expect(sanitizeSerperQuery('"Pulaski Social Club" six young men')).toBe('"Pulaski Social Club" six young men');
  });
  it('超长中文引号段截中段特异子串（仍带引号）', () => {
    const q = '"月到10月仅仅 两个月期间就发生了 142起暴力事件 包括31起谋杀 43起枪击"';
    const out = sanitizeSerperQuery(q);
    expect(out).toMatch(/^".+"$/);
    expect(out.length).toBeLessThan(q.length);
    expect(out).toContain('142'); // 中段截取应保住数据指纹
  });
  it('多个引号段混合时逐段处理', () => {
    const out = sanitizeSerperQuery('"short" + "这是一段特别特别特别长的中文引号查询段超过二十四个字符阈值的时候就要截断了知道吗"');
    expect(out).toContain('"short"');
    expect(out.match(/"/g)?.length).toBeGreaterThanOrEqual(4);
  });
  it('无引号查询不动', () => {
    expect(sanitizeSerperQuery('Ku Klux Klan history podcast')).toBe('Ku Klux Klan history podcast');
  });
});
