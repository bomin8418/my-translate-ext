# Repository Guidelines

This repository is a browser extension for LLM-powered web translation (English to Chinese, with other target languages supported). It uses WXT, TypeScript, React, and Tailwind CSS, and builds to a Chrome Manifest V3 extension (Firefox is also supported).

## Project Structure & Module Organization

- `entrypoints/` — WXT entry points: `background.ts` (service worker), `content.ts` (page script), `options/` (settings UI), and `pdf-viewer/` (built-in PDF viewer).
- `lib/` — Shared logic for storage, LLM calls, SSE parsing, and logging.
- `types/` — Shared TypeScript interfaces and message types.
- `public/` and `assets/` — Static extension icons and shared CSS.
- `test-translate*.html` — Manual browser test pages.
- `.output/` and `.wxt/` — Generated build artifacts; do not edit these directly.

## Build, Test, and Development Commands

- `npm install` — Install dependencies; the postinstall hook runs `wxt prepare`.
- `npm run dev` — Start a development build with hot reload for Chrome.
- `npm run dev:firefox` — Start a development build for Firefox.
- `npm run build` — Produce the Chrome extension in `.output/chrome-mv3`.
- `npm run build:firefox` — Produce the Firefox extension.
- `npm run zip` — Package the Chrome build into a zip archive.
- `npm run compile` — Run TypeScript type checking without emitting output.

## Coding Style & Naming Conventions

- Use 2-space indentation, semicolons, single quotes, and `const`/`let`.
- Name functions and variables in camelCase, React components and interfaces in PascalCase, and constants in UPPER_SNAKE_CASE.
- Keep shared message shapes in `types/index.ts` instead of duplicating them.
- React pages use Tailwind classes. Styles injected by `content.ts` are kept in Shadow DOM templates.
- No linter or formatter is configured yet; keep `npm run compile` clean before committing.

## Testing Guidelines

There is no automated test runner in this project. Verify changes with `npm run compile` and `npm run build`, then load the extension manually and exercise the affected flow. The HTML files `test-translate.html` and `test-translate-advanced.html` are useful for manual content-script checks.

## Commit & Pull Request Guidelines

Follow the Conventional Commits pattern already present in the Git history, with an optional scope and a concise Chinese summary:

- `feat: 新增PDF翻译支持`
- `fix(content): 修复翻译气泡无法正确获取内部元素的问题`
- `refactor(translator): 优化翻译单元合并逻辑`

Use scopes such as `content`, `background`, `translator`, or `pdf-viewer`. In pull requests, describe the problem, the change, and how it was verified. Include screenshots for UI or browser-behavior changes, and confirm both `npm run compile` and `npm run build` pass.

## Security & Configuration Tips

- Store API credentials only in `chrome.storage.local`; never commit API keys or hard-code secrets.
- Keep extension permissions minimal and declare them in `wxt.config.ts`.
- Do not commit generated content from `.output/` or `.wxt/`.
