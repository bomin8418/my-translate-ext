# 个人专属网页翻译浏览器扩展（英译中）

基于 LLM API 的网页翻译扩展，支持划词翻译、全文双语显示、仅译文全文翻译和 PDF 全文翻译。

## 下载与安装

当前发布版本：[v1.0.1](https://github.com/bomin8418/my-translate-ext/releases/tag/v1.0.1)

Chrome 用户可以直接下载已打包的扩展：

[下载 my-translate-ext-1.0.1-chrome.zip](https://github.com/bomin8418/my-translate-ext/releases/download/v1.0.1/my-translate-ext-1.0.1-chrome.zip)

安装步骤：

1. 下载并解压 zip。
2. 打开 Chrome，在地址栏输入 `chrome://extensions`。
3. 开启右上角的「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择解压后的文件夹。
5. 点击工具栏中的扩展图标，填写 API Key / Base URL / 模型并保存。

> 当前 Release 只提供 Chrome Manifest V3 包；Firefox 包可参考下方“开发与构建”使用 `npm run zip:firefox` 生成。

## 功能

- 划词翻译：选中文本后自动弹出翻译气泡
- 全文双语显示：自动翻译页面英文内容，译文插入原文下方（Shadow DOM 隔离样式）
- 全文仅译文显示：自动翻译页面英文内容，直接替换原文，只保留译文
- PDF 翻译：拦截 PDF 导航并使用内置查看器渲染，加载后需点击按钮才会提取文本并翻译
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
3. 打开 PDF 链接或本地 PDF 文件时，默认在浏览器原生查看器中打开；如需使用扩展 PDF 翻译，请先在设置页开启「使用扩展内置 PDF 查看器」。

## PDF 翻译说明

默认情况下，PDF 文件会直接在浏览器主界面中由原生查看器打开，不进入插件模式。设置页提供「使用扩展内置 PDF 查看器」开关：

- 关闭（默认）：PDF 在浏览器原生查看器中打开，保留页面导航、缩放、搜索等浏览器原生能力；
- 开启：扩展通过 `webNavigation` 拦截 PDF 并跳转到内置查看器；进入查看器后仍需点击「开始翻译 PDF」才会执行翻译；
- 开启拦截模式后，翻译本地 PDF 需要在 `chrome://extensions` 中为该扩展开启「允许访问文件网址」，在线 PDF 不受影响。
- 也可以在任意网页右键点击，选择「开启PDF翻译模式」或「关闭PDF翻译模式」快速切换。
- 在 PDF 页面切换该选项后，扩展会自动刷新页面以应用新设置；若刷新失败会显示系统通知。

若开启拦截模式后 PDF 页面没有变化，请检查扩展查看器页面的控制台日志（右键 → 检查 → Console）。

## 项目结构

- `entrypoints/background.ts`：后台 Service Worker（翻译请求、PDF 拦截开关判断）
- `entrypoints/content.ts`：网页内容脚本（划词翻译、全文双语）
- `entrypoints/pdf-viewer/`：PDF 内置查看器（pdf.js 渲染 + 流式翻译）
- `entrypoints/options/`：设置页
- `lib/`：存储、翻译 API、SSE 流解析等公共逻辑
