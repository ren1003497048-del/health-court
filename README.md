# 卫生法庭 HEALTH COURT*

> 对文化内容进行来源核查的漫画法庭。**机制严谨 × 呈现漫画。**
>
> 「卫生法庭」之名源自一次被复制的机器转录错误：2025-08-06 英文播客 Breaking History 中的
> "health **corps**, literacy **corps**"（卫生服务队、扫盲队）被语音识别误作 "health court"，
> 随后被照单翻译为「卫生法庭、扫盲法庭」——历史上从未存在过的机构。
> 一个错误能被复制，就能被发现。

## 这是什么

用户提交一段文化内容（链接或 ≥500 字正文），法庭依照司法级证据规程完成五阶段流程：
**立案（取证）→ 侦查（画像/指纹/群众线报）→ 检索（多轮搜索）→ 对质（结构对齐/指纹验证）→ 宣判**，
给出「卫生 / 可能不卫生 / 不卫生 / 休庭 / 不予受理」裁决与可导出的判决书。

- 证据分级 E1–E5（继承母项目「播客抄袭鉴定」方法论：主题/结构/细节指纹/错误传播/直译腔）
- 判决由确定性规则计算（`src/court/evidence.ts`），LLM 只提供证据材料；引文强制子串定位防幻觉
- 漫画演出（异议！/判决锤/印章）只读取裁决结果，从不参与计算——把动画全关掉，每份判决一字不差

## 目录

```
PRD.md            产品需求文档（含方法论、实测记录、移植映射）
app/              应用（React + Vite + TS，纯静态 BYOK）
  src/court/      内核层：证据分级、裁决映射、文本工具、提示词（可在 Node 无头运行）
  src/pipeline/   五阶段流水线（UI 与无头测试共用）
  src/providers/  供应商适配：GLM（web_search）/ OpenAI 兼容 / Jina 抓取
  src/ui/         法庭界面 + 判决书导出
  tests/          单元测试（vitest）
  scripts/        无头 E2E（310 期复现 E4）
```

## 使用

1. GitHub Pages：`https://ren1003497048-del.github.io/health-court/`
2. 「设置」填入 API Key（默认 GLM / glm-4-flash 免费档；支持任意 OpenAI 兼容端点）
3. 「开庭」粘贴链接或正文 → 等待五阶段走完 → 导出判决书 HTML/JSON

Key 只存你的浏览器 localStorage；本站纯静态、无服务器、无埋点。

## 开发

```bash
cd app
npm install
npm run dev        # 本地开发
npm test           # 单元测试
npm run e2e        # 无头 E2E（需 GLM_API_KEY；SOURCE_MODE=seed 用本地种子源）
npm run build      # 构建到 app/dist（base=/health-court/）
```

## 声明

本产品输出为文本证据的自动化分析，**非法律结论**；「不卫生」等裁决词为游戏化表述。本庭不对内容作者作动机推断，请读者依据材料自行判断。

## 致谢

方法论来自母项目 [dushu-content-review](https://github.com/ren1003497048-del/dushu-content-review)（播客抄袭鉴定）与社区核查者的公开工作。
