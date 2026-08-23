import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages 部署在 /health-court/ 子路径
export default defineConfig({
  plugins: [react()],
  base: '/health-court/',
  // Pages 会上传整个 dist；每次构建必须先清空旧哈希文件，避免已删除代码或密钥残留在产物中。
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as any);
