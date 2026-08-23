import { rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptDir, '..');
const outputDir = resolve(appDir, 'dist');

// 删除目标必须固定为 app/dist；路径解析结果不符时宁可中止构建。
if (relative(appDir, outputDir) !== 'dist') {
  throw new Error(`Refusing to clean unexpected build output: ${outputDir}`);
}

await rm(outputDir, { recursive: true, force: true });
