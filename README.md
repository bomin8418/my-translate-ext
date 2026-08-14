# 个人专属网页翻译浏览器扩展（英译中）

基于 LLM API 的网页翻译扩展，支持划词翻译、全文双语显示、仅译文全文翻译和 PDF 全文翻译。

## 功能

- 划词翻译：选中文本后自动弹出翻译气泡
- 全文双语显示：自动翻译页面英文内容，译文插入原文下方（Shadow DOM 隔离样式）
- 全文仅译文显示：自动翻译页面英文内容，直接替换原文，只保留译文
- PDF 翻译：拦截 PDF 导航并使用内置查看器渲染，自动提取文本并翻译
- 支持 OpenAI 格式的任意 LLM API（OpenAI / DeepSeek / 通义千问 / 智谱 / Moonshot / 自定义）

## 开发与构建

```bash
npm install          # 安装依赖
npm run dev          # 开发模式（热更新）
npm run build        # 构建生产包，输出到 .output/chrome-mv3
npm run compile      # TypeScript 类型检查
```

构建完成后，在 Chrome 打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择 `.output/chrome-mv3` 目录。

## 使用

1. 点击工具栏图标打开设置页，填写 API Key / Base URL / 模型并保存。
2. 打开任意英文网页，点击右下角悬浮按钮切换模式：
   - 蓝色：划词翻译
   - 绿色：全文双语显示
   - 紫色：全文仅译文显示
3. 打开 PDF 链接或本地 PDF 文件，会自动进入扩展内置查看器并自动翻译。

## PDF 翻译说明

扩展通过清单 `mime_types_handler` 注册为 PDF 处理程序（Chrome 151+）：

- 直接打开本地 PDF（`file://` 开头，例如双击打开）或在线 PDF，浏览器会自动交给扩展内置查看器并自动翻译；
- 本地文件**无需**开启「允许访问文件网址」；
- 首次打开 PDF 时若 Chrome 弹出选择方式，请选择「个人专属翻译助手」；
- 若仍显示 Chrome 内置查看器，请在 `chrome://extensions` 点击扩展的刷新按钮重新加载后再打开 PDF；
- Chrome 151 以下版本：扩展会退回 webNavigation 拦截方案，此时翻译本地 PDF 需要手动开启「允许访问文件网址」（`chrome://extensions` → 详细信息），在线 PDF 不受影响。

若打开 PDF 后页面没有变化，请检查扩展查看器页面的控制台日志（右键 → 检查 → Console）。

## 项目结构

- `entrypoints/background.ts`：后台 Service Worker（翻译请求、PDF 处理程序注册/降级拦截）
- `entrypoints/content.ts`：网页内容脚本（划词翻译、全文双语）
- `entrypoints/pdf-viewer/`：PDF 内置查看器（pdf.js 渲染 + 流式翻译）
- `entrypoints/options/`：设置页
- `lib/`：存储、翻译 API、SSE 流解析等公共逻辑
