/**
 * Content Script - 翻译扩展的核心前端脚本
 *
 * 注入到用户访问的每个网页中，负责：
 *
 * 1. 悬浮按钮：右下角可拖拽的 Toggle 按钮，控制翻译模式
 * 2. 划词翻译：选中文本后弹出气泡，流式显示翻译结果
 * 3. 双语显示：遍历 DOM 文本节点，翻译后在下方插入译文（Shadow DOM 隔离）
 * 4. SPA 支持：MutationObserver 监听动态内容，自动翻译新节点
 *
 * 技术要点：
 * - 使用 chrome.runtime.connect 长连接实现流式翻译
 * - Shadow DOM 确保译文样式不被网页 CSS 污染
 * - 防抖机制避免频繁 API 调用
 * - 跳过 script/style/textarea 等非内容节点
 */

import type {
  ContentMessage,
  StreamChunkMessage,
  StreamDoneMessage,
  StreamErrorMessage,
} from '../types';
import { TranslationMode } from '../types';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { createLogger } from '../lib/logger';

/** 模块日志器 */
const logger = createLogger('翻译扩展');

export default {
  // 匹配所有 HTTP/HTTPS 页面和本地文件
  matches: ['*://*/*', 'file://*/*'],
  // 只在主框架注入，避免 iframe 里悬浮按钮重复
  allFrames: false,
  // 在页面加载完成后尽早运行
  runAt: 'document_end' as const,

  /**
   * Content Script 主入口
   * WXT 会在页面加载完成后调用此函数
   */
  main(_ctx: ContentScriptContext) {
    // 启动逻辑已移至本函数末尾，确保所有 const/let 声明先于 init() 执行，
    // 避免暂时性死区（TDZ）导致 "Cannot access 'X' before initialization"

// ==================== 常量定义 ====================

/** 翻译模式存储键名 */
const MODE_STORAGE_KEY = 'translate_mode';

/** 不应翻译的 HTML 标签（内容节点） */
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA',
  'CODE', 'PRE', 'KBD', 'VAR', 'SAMP',
  'SVG', 'MATH', 'CANVAS', 'IFRAME',
  'INPUT', 'SELECT', 'OPTION', 'BUTTON',
]);

/** 不应翻译的 CSS 类名关键词 */
const SKIP_CLASS_PATTERNS = [
  'translate-exclude',
  'notranslate',
  'no-translate',
  'code',
  'mono',
];

/** 翻译文本的最小长度（字符数） */
const MIN_TEXT_LENGTH = 2;

/** 翻译文本的最大长度（字符数，超过则分段翻译） */
const MAX_CHUNK_LENGTH = 500;

/** 应强制使用块级译文的 HTML 标签（强调元素及标题，避免行内译文与后续正文混排） */
const EMPHASIS_TAGS = new Set([
  'STRONG', 'EM', 'B', 'I', 'U',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

/** 防抖延迟（毫秒） */
const DEBOUNCE_DELAY = 300;

/** MutationObserver 的防抖延迟 */
const MUTATION_DEBOUNCE = 1000;

// ==================== 全局状态 ====================

/** 当前翻译模式 */
let currentMode: TranslationMode = TranslationMode.OFF;

/** 与 Background Worker 的 Port 连接 */
let streamPort: chrome.runtime.Port | null = null;

/** 当前活跃的流式请求 ID */
let activeRequestId: string | null = null;

/** 翻译气泡的 DOM 元素 */
let bubbleElement: HTMLDivElement | null = null;

/** 悬浮按钮的 DOM 元素 */
let toggleButton: HTMLDivElement | null = null;

/** 已翻译的文本节点集合（用于避免重复翻译） */
let translatedNodes = new WeakSet<Node>();

/** 全文翻译是否正在进行中 */
let isFullPageTranslating = false;

/**
 * 翻译单元：将 DOM 中相邻的短文本节点合并为一个翻译单元，
 * 避免将逗号分隔的人名列表等拆散成多条独立翻译。
 */
interface TranslationUnit {
  /** 该单元包含的文本节点列表 */
  nodes: Text[];
  /** 合并后的完整文本（空格分隔，发送给 LLM） */
  combinedText: string;
  /** 文本节点的公共父元素（取第一个节点的父元素） */
  parentElement: HTMLElement;
  /** 父元素的 display 类型 */
  display: 'inline' | 'block';
  /** 合并后的总字符数（含分隔空格） */
  charCount: number;
}

/** 短文本阈值（字符数）：低于此值的文本节点优先与相邻节点合并 */
const SHORT_TEXT_THRESHOLD = 30;

/** 待翻译的翻译单元队列 */
let pendingTextNodes: TranslationUnit[] = [];

/** 全文翻译的防抖定时器 */
let fullPageDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// ==================== 初始化 ====================

/**
 * Content Script 入口
 * 页面加载完成后初始化所有功能
 */
async function init(): Promise<void> {
  // 检查是否为 PDF 页面（PDF 页面由专门的 PDF 查看器处理）
  if (isPdfPage()) {
    logger.info('当前为 PDF 页面，跳过 Content Script 初始化');
    return;
  }

  // 从存储中恢复之前的翻译模式（必须 await，确保模式就绪后再创建按钮）
  await restoreMode();

  // 创建悬浮按钮
  createToggleButton();
  // 恢复后同步按钮外观
  updateToggleButtonAppearance();

  // 设置划词翻译事件监听
  setupSelectionListener();

  // 设置 MutationObserver 监听 SPA 动态内容
  setupMutationObserver();

  logger.info('Content Script 已初始化', { mode: currentMode });
}

/**
 * 判断当前页面是否为 PDF 页面
 * 原生 PDF 查看器页面由我们的 PDF 查看器处理，这里跳过
 */
function isPdfPage(): boolean {
  return (
    document.contentType === 'application/pdf' ||
    document.querySelector('embed[type="application/pdf"]') !== null
  );
}

// ==================== Port 连接管理 ====================

/**
 * 确保与 Background Worker 的 Port 连接已建立
 * 如果连接断开则自动重连
 */
function ensurePort(): chrome.runtime.Port {
  if (!streamPort) {
    streamPort = chrome.runtime.connect({ name: 'translate-stream' });
    logger.info('已建立与 Background 的 Port 连接');

    // 监听来自 Background 的消息
    streamPort.onMessage.addListener(handleStreamMessage);

    // 监听断开事件
    streamPort.onDisconnect.addListener(() => {
      logger.warn('Port 连接断开，将自动重连');
      streamPort = null;
      activeRequestId = null;
    });
  }
  return streamPort;
}

/**
 * 处理来自 Background Worker 的流式消息
 * 根据消息类型分发给不同的处理函数
 */
function handleStreamMessage(message: ContentMessage): void {
  switch (message.type) {
    case 'chunk':
      // chunk 为高频消息，仅在 debug 级别输出
      logger.debug('收到流式数据块', { requestId: message.requestId });
      handleStreamChunk(message);
      break;
    case 'done':
      logger.info('收到翻译完成消息', { requestId: message.requestId });
      handleStreamDone(message);
      break;
    case 'error':
      logger.warn('收到翻译错误消息', { requestId: message.requestId });
      handleStreamError(message);
      break;
  }
}

/**
 * 处理流式数据块：将增量文本追加到翻译气泡
 */
function handleStreamChunk(message: StreamChunkMessage): void {
  if (message.requestId !== activeRequestId) return;

  // 更新翻译气泡的内容
  if (bubbleElement?.shadowRoot) {
    const contentEl = bubbleElement.shadowRoot.querySelector('.trans-bubble-content');
    if (contentEl) {
      // 追加增量文本
      contentEl.textContent = (contentEl.textContent || '') + message.content;
      // 自动滚动到底部
      contentEl.scrollTop = contentEl.scrollHeight;
    }
  }
}

/**
 * 处理翻译完成：更新气泡最终状态
 */
function handleStreamDone(message: StreamDoneMessage): void {
  if (message.requestId !== activeRequestId) {
    logger.debug('忽略不匹配的 done 消息', { requestId: message.requestId, activeRequestId });
    return;
  }

  activeRequestId = null;
  logger.info('划词翻译完成', { length: message.fullText.length });

  // 更新气泡显示完整翻译
  if (bubbleElement?.shadowRoot) {
    const contentEl = bubbleElement.shadowRoot.querySelector('.trans-bubble-content');
    if (contentEl) {
      contentEl.textContent = message.fullText;
    }
    // 移除加载动画
    const loadingEl = bubbleElement.shadowRoot.querySelector('.trans-bubble-loading');
    if (loadingEl) {
      loadingEl.remove();
    }
  }
}

/**
 * 处理翻译错误：在气泡中显示错误信息
 */
function handleStreamError(message: StreamErrorMessage): void {
  if (message.requestId !== activeRequestId) {
    logger.debug('忽略不匹配的 error 消息', { requestId: message.requestId, activeRequestId });
    return;
  }

  activeRequestId = null;
  logger.error('划词翻译失败', { message: message.message });

  if (bubbleElement?.shadowRoot) {
    const contentEl = bubbleElement.shadowRoot.querySelector('.trans-bubble-content');
    if (contentEl) {
      contentEl.textContent = `❌ ${message.message}`;
      contentEl.classList.add('trans-error');
    }
    const loadingEl = bubbleElement.shadowRoot.querySelector('.trans-bubble-loading');
    if (loadingEl) {
      loadingEl.remove();
    }
  }
}

// ==================== 悬浮按钮 ====================

/**
 * 创建右下角悬浮 Toggle 按钮
 * 支持拖拽移动位置
 */
function createToggleButton(): void {
  // 创建按钮容器
  toggleButton = document.createElement('div');
  toggleButton.id = 'trans-ext-toggle-btn';
  toggleButton.innerHTML = getToggleButtonHTML();
  toggleButton.title = '翻译助手 - 点击切换模式';

  // 应用 Shadow DOM 样式隔离
  const shadow = toggleButton.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>${getToggleButtonStyles()}</style>
    ${getToggleButtonHTML()}
  `;

  // 事件委托（在 Shadow DOM 内）
  const btn = shadow.querySelector('.trans-toggle-btn');
  btn?.addEventListener('click', (e) => {
    e.stopPropagation();
    cycleMode();
  });

  // 拖拽功能
  setupDrag(toggleButton, shadow.querySelector('.trans-toggle-btn')!);

  document.body.appendChild(toggleButton);
  updateToggleButtonAppearance();
}

/**
 * 为悬浮按钮添加拖拽功能
 */
function setupDrag(container: HTMLElement, handle: Element): void {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  const onMouseDown = (e: Event) => {
    const mouseEvent = e as MouseEvent;
    // 右键不拖拽
    if (mouseEvent.button !== 0) return;
    isDragging = true;
    startX = mouseEvent.clientX;
    startY = mouseEvent.clientY;
    const rect = container.getBoundingClientRect();
    startLeft = rect.left;
    startTop = rect.top;

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    // 限制在视口范围内
    const maxX = window.innerWidth - container.offsetWidth;
    const maxY = window.innerHeight - container.offsetHeight;
    const newLeft = Math.max(0, Math.min(startLeft + dx, maxX));
    const newTop = Math.max(0, Math.min(startTop + dy, maxY));

    container.style.left = `${newLeft}px`;
    container.style.top = `${newTop}px`;
    container.style.right = 'auto';
    container.style.bottom = 'auto';
  };

  const onMouseUp = () => {
    isDragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };

  handle.addEventListener('mousedown', onMouseDown);
}

/**
 * 循环切换翻译模式：OFF → SELECTION → FULL_PAGE → OFF
 */
function cycleMode(): void {
  const prevMode = currentMode;
  switch (currentMode) {
    case TranslationMode.OFF:
      currentMode = TranslationMode.SELECTION;
      break;
    case TranslationMode.SELECTION:
      currentMode = TranslationMode.FULL_PAGE;
      // 开启全文翻译
      startFullPageTranslation();
      break;
    case TranslationMode.FULL_PAGE:
      currentMode = TranslationMode.OFF;
      // 关闭全文翻译，移除译文
      removeAllTranslations();
      break;
  }

  logger.info('切换翻译模式', { from: prevMode, to: currentMode });

  // 持久化当前模式
  chrome.storage.local.set({ [MODE_STORAGE_KEY]: currentMode });
  updateToggleButtonAppearance();
}

/**
 * 从存储中恢复之前的翻译模式
 */
async function restoreMode(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(MODE_STORAGE_KEY);
    if (result[MODE_STORAGE_KEY]) {
      // 读取值为 unknown（@types/chrome 的 StorageArea.get 返回 { [key: string]: unknown }），
      // 经真值判断收窄为 {}；写入时存入的是 TranslationMode 枚举值，此处断言回原类型
      currentMode = result[MODE_STORAGE_KEY] as TranslationMode;
      logger.info('恢复翻译模式', { mode: currentMode });
      // 如果之前是全文模式，重新开始翻译
      if (currentMode === TranslationMode.FULL_PAGE) {
        logger.info('之前为全文模式，等待页面加载完成后重新开始翻译');
        scheduleAutoFullPageTranslation();
      }
    } else {
      logger.info('未读到已保存的翻译模式，使用默认值', { mode: currentMode });
    }
  } catch (error) {
    // 读取失败，使用默认模式
    logger.error('恢复翻译模式失败', error);
  }
}

/**
 * 延迟启动自动全文翻译
 *
 * 内容脚本在 document_end 注入时，React 等 SSR 应用可能尚未完成水合（hydration）。
 * 此时若直接改写 DOM（插入译文容器/改动文本节点），会触发页面的
 * "Hydration failed"（React 错误 #418），导致整棵树被客户端重新渲染、译文丢失。
 * 因此等待页面 load 事件（水合通常已完成）后再启动，并设置兜底超时，
 * 避免部分站点 load 事件过慢导致功能迟迟不生效。
 */
function scheduleAutoFullPageTranslation(): void {
  let started = false;

  const start = (): void => {
    if (started) return;
    started = true;

    // 无论由 load 事件还是兜底超时触发，都移除 load 监听器，避免其残留
    window.removeEventListener('load', start);

    // 让出主线程，给页面脚本（水合）让路后再启动翻译
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => startFullPageTranslation(), { timeout: 1500 });
    } else {
      setTimeout(() => startFullPageTranslation(), 200);
    }
  };

  if (document.readyState === 'complete') {
    start();
    return;
  }

  // 主路径：等待 load 事件
  window.addEventListener('load', start, { once: true });

  // 兜底：load 事件过慢或被阻塞时，最迟 3.5 秒后启动
  setTimeout(start, 3500);
}

/**
 * 更新悬浮按钮的外观以反映当前模式
 */
function updateToggleButtonAppearance(): void {
  if (!toggleButton?.shadowRoot) return;

  const btn = toggleButton.shadowRoot.querySelector('.trans-toggle-btn');
  const indicator = toggleButton.shadowRoot.querySelector('.trans-mode-indicator');
  if (!btn || !indicator) return;

  // 更新按钮样式
  btn.classList.remove('mode-off', 'mode-selection', 'mode-fullpage');
  switch (currentMode) {
    case TranslationMode.OFF:
      btn.classList.add('mode-off');
      (indicator as HTMLElement).innerHTML = '🌐';
      btn.setAttribute('aria-label', '翻译已关闭');
      break;
    case TranslationMode.SELECTION:
      btn.classList.add('mode-selection');
      (indicator as HTMLElement).innerHTML = '🔤';
      btn.setAttribute('aria-label', '划词翻译模式');
      break;
    case TranslationMode.FULL_PAGE:
      btn.classList.add('mode-fullpage');
      (indicator as HTMLElement).innerHTML = '📖';
      btn.setAttribute('aria-label', '全文双语模式');
      break;
  }
}

/** 悬浮按钮的 HTML 结构 */
function getToggleButtonHTML(): string {
  return `
    <div class="trans-toggle-btn mode-off" role="button" tabindex="0">
      <span class="trans-mode-indicator">🌐</span>
    </div>
  `;
}

/** 悬浮按钮的 Shadow DOM 样式 */
function getToggleButtonStyles(): string {
  return `
    .trans-toggle-btn {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      transition: all 0.3s ease;
      z-index: 2147483646;
      user-select: none;
      border: 2px solid rgba(255,255,255,0.3);
    }
    .trans-toggle-btn:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 20px rgba(0,0,0,0.25);
    }
    .trans-toggle-btn:active {
      transform: scale(0.95);
    }

    /* 模式颜色 */
    .mode-off {
      background: #9ca3af;
    }
    .mode-selection {
      background: #3b82f6;
    }
    .mode-fullpage {
      background: #10b981;
    }

    .trans-mode-indicator {
      font-size: 22px;
      line-height: 1;
      pointer-events: none;
    }
  `;
}

// ==================== 划词翻译 ====================

/**
 * 设置划词翻译的事件监听
 * 监听 mouseup 事件，检测用户是否选中了文本
 */
function setupSelectionListener(): void {
  document.addEventListener('mouseup', handleTextSelection);
}

/**
 * 处理文本选中事件
 * 当用户在非输入区域选中文本时，弹出翻译气泡
 */
function handleTextSelection(e: MouseEvent): void {
  // 仅在划词模式下处理
  if (currentMode !== TranslationMode.SELECTION) return;

  // 忽略在悬浮按钮或气泡上的点击
  if (isClickOnExtensionElement(e.target as HTMLElement)) return;

  // 延迟获取选中内容，确保 selection 已更新
  setTimeout(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      // 没有选中文本，隐藏气泡
      hideBubble();
      return;
    }

    const selectedText = selection.toString().trim();
    if (!selectedText || selectedText.length < MIN_TEXT_LENGTH) {
      hideBubble();
      return;
    }

    // 获取选中区域的位置
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    // 显示气泡并开始翻译
    showBubble(selectedText, rect);
  }, 10);
}

/**
 * 判断点击目标是否为扩展自有的元素
 */
function isClickOnExtensionElement(target: HTMLElement | null): boolean {
  while (target) {
    if (
      target.id === 'trans-ext-toggle-btn' ||
      target.id === 'trans-ext-bubble' ||
      target.closest?.('#trans-ext-toggle-btn') ||
      target.closest?.('#trans-ext-bubble')
    ) {
      return true;
    }
    target = target.parentElement;
  }
  return false;
}

/**
 * 显示翻译气泡
 * 在选中文本附近显示气泡，通过 Port 发送流式翻译请求
 *
 * @param text 选中的文本
 * @param selectionRect 选中区域的边界矩形
 */
function showBubble(text: string, selectionRect: DOMRect): void {
  // 取消之前的翻译请求
  if (activeRequestId) {
    ensurePort().postMessage({
      type: 'cancel-stream',
      requestId: activeRequestId,
    });
  }

  // 移除旧气泡
  hideBubble();

  // 创建新气泡
  bubbleElement = document.createElement('div');
  bubbleElement.id = 'trans-ext-bubble';

  // 应用 Shadow DOM 样式隔离
  const shadow = bubbleElement.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>${getBubbleStyles()}</style>
    <div class="trans-bubble">
      <div class="trans-bubble-header">
        <span class="trans-bubble-title">翻译</span>
        <button class="trans-bubble-close" title="关闭">×</button>
      </div>
      <div class="trans-bubble-content">
        <div class="trans-bubble-loading">
          <span class="trans-dot">●</span>
          <span class="trans-dot">●</span>
          <span class="trans-dot">●</span>
        </div>
      </div>
    </div>
  `;

  // 关闭按钮事件
  shadow.querySelector('.trans-bubble-close')?.addEventListener('click', () => {
    hideBubble();
    // 取消翻译请求
    if (activeRequestId) {
      ensurePort().postMessage({
        type: 'cancel-stream',
        requestId: activeRequestId,
      });
      activeRequestId = null;
    }
  });

  document.body.appendChild(bubbleElement);

  // 计算气泡位置
  positionBubble(bubbleElement, selectionRect);

  // 发起流式翻译请求
  const requestId = generateRequestId();
  activeRequestId = requestId;

  logger.info('发起划词翻译请求', { requestId, textLength: text.length });

  ensurePort().postMessage({
    type: 'translate-stream',
    text,
    targetLang: 'Chinese',
    requestId,
  });
}

/**
 * 计算气泡的最佳位置
 * 优先显示在选中文本下方，如果空间不足则显示在上方
 */
function positionBubble(bubble: HTMLElement, selectionRect: DOMRect): void {
  const bubbleWidth = 320;
  const bubbleHeight = 200;
  const gap = 8;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let left = selectionRect.left + selectionRect.width / 2 - bubbleWidth / 2;
  let top = selectionRect.bottom + gap + window.scrollY;

  // 水平方向边界检查
  if (left < 10) left = 10;
  if (left + bubbleWidth > viewportWidth - 10) {
    left = viewportWidth - bubbleWidth - 10;
  }

  // 垂直方向边界检查：如果下方空间不足，显示在上方
  if (top + bubbleHeight > viewportHeight + window.scrollY - 10) {
    top = selectionRect.top - bubbleHeight - gap + window.scrollY;
    // 如果上方也不够，贴近顶部
    if (top < window.scrollY + 10) {
      top = window.scrollY + 10;
    }
  }

  bubble.style.position = 'absolute';
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
  bubble.style.zIndex = '2147483647';
}

/**
 * 隐藏翻译气泡
 */
function hideBubble(): void {
  if (bubbleElement) {
    bubbleElement.remove();
    bubbleElement = null;
  }
}

/** 翻译气泡的 Shadow DOM 样式 */
function getBubbleStyles(): string {
  return `
    :host {
      /* Light theme (default) */
      --bubble-bg: #ffffff;
      --bubble-text: #374151;
      --bubble-header-bg: #f9fafb;
      --bubble-border: #e5e7eb;
      --bubble-title: #6b7280;
      --bubble-close: #9ca3af;
      --bubble-close-hover-bg: #e5e7eb;
      --bubble-close-hover-text: #374151;
      --bubble-dot: #9ca3af;
      --bubble-shadow: 0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08);
    }

    @media (prefers-color-scheme: dark) {
      :host {
        --bubble-bg: #1e1e1e;
        --bubble-text: #d4d4d4;
        --bubble-header-bg: #2d2d2d;
        --bubble-border: #404040;
        --bubble-title: #9ca3af;
        --bubble-close: #6b7280;
        --bubble-close-hover-bg: #404040;
        --bubble-close-hover-text: #e5e7eb;
        --bubble-dot: #6b7280;
        --bubble-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.3);
      }
    }

    .trans-bubble {
      width: 320px;
      max-height: 200px;
      background: var(--bubble-bg);
      border-radius: 12px;
      box-shadow: var(--bubble-shadow);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      overflow: hidden;
      border: 1px solid var(--bubble-border);
      animation: transFadeIn 0.2s ease-out;
    }

    @keyframes transFadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .trans-bubble-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      background: var(--bubble-header-bg);
      border-bottom: 1px solid var(--bubble-border);
    }

    .trans-bubble-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--bubble-title);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .trans-bubble-close {
      background: none;
      border: none;
      font-size: 18px;
      color: var(--bubble-close);
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
      border-radius: 4px;
      transition: all 0.15s;
    }

    .trans-bubble-close:hover {
      color: var(--bubble-close-hover-text);
      background: var(--bubble-close-hover-bg);
    }

    .trans-bubble-content {
      padding: 12px;
      max-height: 150px;
      overflow-y: auto;
      color: var(--bubble-text);
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .trans-bubble-content.trans-error {
      color: #ef4444;
    }

    .trans-bubble-loading {
      display: flex;
      gap: 4px;
      justify-content: center;
      padding: 8px;
    }

    .trans-dot {
      font-size: 8px;
      color: var(--bubble-dot);
      animation: transPulseDot 1.4s infinite;
    }

    .trans-dot:nth-child(2) { animation-delay: 0.2s; }
    .trans-dot:nth-child(3) { animation-delay: 0.4s; }

    @keyframes transPulseDot {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
  `;
}

// ==================== 全文双语显示 ====================

/**
 * 开始全文翻译
 * 遍历 DOM 树中的文本节点，发送翻译请求
 */
function startFullPageTranslation(): void {
  if (isFullPageTranslating) {
    logger.debug('全文翻译已在进行中，跳过');
    return;
  }
  isFullPageTranslating = true;

  // 收集所有需要翻译的文本节点，合并为翻译单元
  const textNodes = collectTranslatableTextNodes(document.body);
  pendingTextNodes = textNodes;

  logger.info('开始全文翻译', { unitCount: textNodes.length });

  // 分批处理翻译
  processNextBatch();
}

/**
 * 遍历 DOM 树，收集所有需要翻译的文本节点并合并为翻译单元。
 *
 * 合并规则：
 * - 同一父元素下的相邻短文本节点会合并为一个翻译单元
 * - 父元素是连续兄弟（如 &lt;a&gt;Alice&lt;/a&gt;, &lt;a&gt;Bob&lt;/a&gt;）也会合并
 * - 长文本节点（如段落正文）独立成一个单元
 * - 从 inline 切到 block 父元素时强制切分单元
 *
 * @param root 遍历的根节点
 * @returns 翻译单元列表
 */
function collectTranslatableTextNodes(root: Node): TranslationUnit[] {
  // ====== 阶段 1：收集所有符合条件的文本节点（与旧版相同） ======
  const acceptedEntries: { node: Text; text: string }[] = [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const textNode = node as Text;
      const text = textNode.textContent?.trim();

      if (!text || text.length < MIN_TEXT_LENGTH) return NodeFilter.FILTER_REJECT;
      if (translatedNodes.has(textNode)) return NodeFilter.FILTER_REJECT;

      const parent = textNode.parentElement;
      if (parent) {
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;

        const className = parent.className?.toString?.() || '';
        for (const pattern of SKIP_CLASS_PATTERNS) {
          if (className.includes(pattern)) return NodeFilter.FILTER_REJECT;
        }

        if (
          parent.closest?.('#trans-ext-toggle-btn') ||
          parent.closest?.('#trans-ext-bubble') ||
          parent.closest?.('[data-trans-ext]')
        ) {
          return NodeFilter.FILTER_REJECT;
        }
      }

      if (!/[a-zA-Z]/.test(text)) return NodeFilter.FILTER_REJECT;

      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const textNode = node as Text;
    const text = textNode.textContent?.trim() || '';
    acceptedEntries.push({ node: textNode, text });
  }

  if (acceptedEntries.length === 0) return [];

  // ====== 阶段 2：将相邻短文本节点合并为翻译单元 ======
  const units: TranslationUnit[] = [];

  // 创建初始单元
  const firstEntry = acceptedEntries[0]!;
  let currentUnit = buildUnit(firstEntry.node, firstEntry.text);

  for (let i = 1; i < acceptedEntries.length; i++) {
    const entry = acceptedEntries[i]!;
    const nodeParent = entry.node.parentElement;

    if (canMergeIntoUnit(currentUnit, entry.node, nodeParent, entry.text)) {
      // 合并到当前单元：提取原 DOM 中两节点间的分隔符文本（逗号、空格等）
      const lastNode = currentUnit.nodes[currentUnit.nodes.length - 1]!;
      const sep = collectSeparator(lastNode, entry.node);
      currentUnit.nodes.push(entry.node);
      currentUnit.combinedText += sep + entry.text;
      currentUnit.charCount += sep.length + entry.text.length;
    } else {
      // 无法合并，结束当前单元，开始新单元
      units.push(currentUnit);
      currentUnit = buildUnit(entry.node, entry.text);
    }
  }

  // 推入最后一个单元
  units.push(currentUnit);

  logger.info('收集翻译单元完成', {
    rawNodeCount: acceptedEntries.length,
    unitCount: units.length,
  });

  return units;
}

/**
 * 构建一个初始翻译单元（只含一个文本节点）
 */
function buildUnit(node: Text, text: string): TranslationUnit {
  const parent = node.parentElement!;
  return {
    nodes: [node],
    combinedText: text,
    parentElement: parent,
    display: getDisplayType(parent),
    charCount: text.length,
  };
}

/**
 * 判断是否可以将新文本节点合并到当前翻译单元
 */
function canMergeIntoUnit(
  unit: TranslationUnit,
  newNode: Text,
  newParent: HTMLElement | null,
  newText: string,
): boolean {
  // 超出最大单元长度 → 不合并
  if (unit.charCount + newText.length > MAX_CHUNK_LENGTH) return false;
  // 新节点无父元素 → 不合并
  if (!newParent) return false;

  // 条件 1：同一父元素 → 直接合并
  if (newParent === unit.parentElement) return true;

  // 条件 2：新节点的父元素与当前单元最后一个节点的父元素是兄弟 → 合并
  const lastNode = unit.nodes[unit.nodes.length - 1]!;
  const lastParent = lastNode.parentElement;
  if (!lastParent) return false;

  // 兄弟关系：共用祖父，且新父紧跟最后一个父
  if (lastParent.parentElement === newParent.parentElement) {
    // 从 display: block 切换到 display: inline 兄弟时也合并
    for (
      let sib: Node | null = lastParent.nextSibling;
      sib;
      sib = sib.nextSibling
    ) {
      if (sib === newParent) return true;
      // 遇到块级元素就中断（说明跨度太大）
      if (sib instanceof HTMLElement && getDisplayType(sib) === 'block') return false;
    }
  }

  return false;
}

/**
 * 获取元素的 display 类型
 */
function getDisplayType(el: HTMLElement): 'inline' | 'block' {
  const display = getComputedStyle(el).display;
  // inline, inline-block, inline-flex 等都视为 inline
  return display.startsWith('inline') ? 'inline' : 'block';
}

/**
 * 提取 DOM 中两个文本节点之间的原始分隔文本（逗号、空格等）
 *
 * 使用 Range API 截取两节点间的字符串，保留原文的分隔符。
 * 这样翻译时 LLM 看到的仍是 "Alice, Bob, Carol" 而非 "Alice Bob Carol"。
 */
function collectSeparator(lastNode: Text, nextNode: Text): string {
  const lastEl = lastNode.parentElement;
  const nextEl = nextNode.parentElement;

  try {
    if (lastEl === nextEl && lastEl) {
      // 同一父元素：取两节点间的文本
      const range = document.createRange();
      range.setStartAfter(lastNode);
      range.setEndBefore(nextNode);
      return range.toString();
    }

    if (lastEl && nextEl && lastEl.parentElement === nextEl.parentElement) {
      // 兄弟父元素：取 lastEl 之后到 nextEl 之前的文本
      const grandParent = lastEl.parentElement!;
      const range = document.createRange();
      range.setStartAfter(lastEl);
      range.setEndBefore(nextEl);
      return range.toString();
    }
  } catch {
    // Range 操作失败（节点已脱离 DOM 等），fallback 到空格
  }

  return ' ';
}

/**
 * 分批处理翻译队列
 * 每次处理一批文本节点，避免同时发起过多请求
 */
let batchIndex = 0;
const BATCH_SIZE = 3;

async function processNextBatch(): Promise<void> {
  if (!isFullPageTranslating) return;

  const batch = pendingTextNodes.slice(
    batchIndex,
    batchIndex + BATCH_SIZE
  );
  batchIndex += BATCH_SIZE;

  if (batch.length === 0) {
    // 全部处理完成
    isFullPageTranslating = false;
    batchIndex = 0;
    pendingTextNodes = [];
    logger.info('全文翻译完成');
    return;
  }

  // 并行处理当前批次
  await Promise.allSettled(
    batch.map((unit) => translateAndInsert(unit))
  );

  // 继续处理下一批
  processNextBatch();
}

/**
 * 翻译一个翻译单元并插入译文
 *
 * 使用 Shadow DOM 隔离译文样式，防止被网页 CSS 污染。
 * 译文以单元中最后一个文本节点为锚点，插入为其兄弟元素。
 *
 * @param unit 翻译单元
 */
async function translateAndInsert(unit: TranslationUnit): Promise<void> {
  // 标记单元内所有节点为已处理，避免重复翻译
  for (const node of unit.nodes) {
    translatedNodes.add(node);
  }

  // 以最后一个节点为 DOM 锚点（用于确定插入位置）
  const anchorNode = unit.nodes[unit.nodes.length - 1]!;
  if (!anchorNode.parentNode) return;

  const text = unit.combinedText;
  const requestId = generateRequestId();

  try {
    // 锚点的直接父元素（用于判断是否为强调元素内的文本）
    const anchorParent = anchorNode.parentElement;
    const anchorTag = anchorParent?.tagName ?? '';

    // 短文本（< 60 字符）使用行内翻译，长文本使用块级翻译
    // 但强调元素（strong/em/h1-h6 等）内的文本强制块级，避免译文与后续正文同行混杂
    const INLINE_THRESHOLD = 60;
    const isInline = text.length < INLINE_THRESHOLD && !EMPHASIS_TAGS.has(anchorTag);

    // 截断过长文本
    const truncatedText = text.length > MAX_CHUNK_LENGTH
      ? text.slice(0, MAX_CHUNK_LENGTH) + '...'
      : text;

    const port = ensurePort();

    // 读取单元父元素计算颜色，传入 Shadow DOM 使译文与页面颜色一致
    const parentElement = unit.parentElement;
    const parentStyle = parentElement ? getComputedStyle(parentElement) : null;
    const parentColor = parentStyle?.color;
    const parentBgColor = parentStyle?.backgroundColor;

    // 读取锚点父元素的字体样式，传入行内译文 Shadow DOM 以继承粗体/斜体/下划线
    const anchorStyle = anchorParent ? getComputedStyle(anchorParent) : null;

    // 根据文本长度选择容器类型：短文本用行内 <span>，长文本用块级 <div>
    const translationContainer = isInline
      ? createInlineTranslationContainer({
          color: parentColor,
          fontWeight: anchorStyle?.fontWeight === '400' ? undefined : anchorStyle?.fontWeight,
          fontStyle: anchorStyle?.fontStyle === 'normal' ? undefined : anchorStyle?.fontStyle,
          textDecoration: anchorStyle?.textDecoration === 'none' ? undefined : anchorStyle?.textDecoration,
        })
      : createTranslationContainer(
          parentColor,
          parentBgColor === 'rgba(0, 0, 0, 0)' || parentBgColor === 'transparent'
            ? undefined
            : parentBgColor,
        );
    const translationShadow = translationContainer.shadowRoot!;
    const contentEl = isInline
      ? translationShadow.querySelector('.trans-inline-content')!
      : translationShadow.querySelector('.trans-content')!;

    // 插入译文容器
    // - 行内模式：容器插入到锚点文本节点之后（原有逻辑）
    // - 块级模式且锚点位于 inline 元素内（如 <strong>）：将容器插入到该父元素之后，
    //   避免 <div> 嵌在 <strong> 内部造成非法嵌套
    const parent = anchorNode.parentNode!;
    if (!isInline && anchorParent && getDisplayType(anchorParent) === 'inline') {
      // 块级模式 + inline 父元素 → 上移到父元素之后
      const grandParent = anchorParent.parentNode;
      if (grandParent) {
        if (anchorParent.nextSibling) {
          grandParent.insertBefore(translationContainer, anchorParent.nextSibling);
        } else {
          grandParent.appendChild(translationContainer);
        }
      } else if (anchorNode.nextSibling) {
        parent.insertBefore(translationContainer, anchorNode.nextSibling);
      } else {
        parent.appendChild(translationContainer);
      }
    } else if (anchorNode.nextSibling) {
      parent.insertBefore(translationContainer, anchorNode.nextSibling);
    } else {
      parent.appendChild(translationContainer);
    }

    // 发送流式翻译请求
    let fullTranslation = '';

    // 行内模式需强制单行：模型的 prompt 已要求单行，此处兜底替换
    const sanitizeDisplay = (t: string): string =>
      isInline ? t.replace(/\n+/g, ' ') : t;

    // 监听翻译响应
    const messageHandler = (message: ContentMessage) => {
      if (message.type === 'chunk' && message.requestId === requestId) {
        fullTranslation += message.content;
        contentEl.textContent = sanitizeDisplay(fullTranslation);
      } else if (message.type === 'done' && message.requestId === requestId) {
        contentEl.textContent = sanitizeDisplay(message.fullText);
        // 仅块级模式有加载动画需要移除
        if (!isInline) {
          const loadingEl = translationShadow.querySelector('.trans-loading');
          loadingEl?.remove();
        }
        port.onMessage.removeListener(messageHandler);
        logger.debug('节点翻译完成', { requestId, length: message.fullText.length, isInline });
      } else if (message.type === 'error' && message.requestId === requestId) {
        contentEl.textContent = `⚠️ 翻译失败`;
        contentEl.classList.add('trans-error');
        port.onMessage.removeListener(messageHandler);
        logger.error('节点翻译失败', { requestId, isInline });
      }
    };

    port.onMessage.addListener(messageHandler);

    // 发送翻译请求
    port.postMessage({
      type: 'translate-stream',
      text: truncatedText,
      targetLang: 'Chinese',
      requestId,
    });
  } catch (err) {
    // 翻译失败，记录日志便于排查
    logger.error('节点翻译异常', {
      requestId,
      textLength: text.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 创建译文容器元素
 * 使用 Shadow DOM 确保样式隔离
 *
 * 结构：
 * <div data-trans-ext="translation">
 *   #shadow-root
 *     <style>...</style>
 *     <div class="trans-container">
 *       <div class="trans-loading">● ● ●</div>
 *       <div class="trans-content"></div>
 *     </div>
 * </div>
 */
function createTranslationContainer(
  parentColor?: string,
  parentBgColor?: string,
): HTMLElement {
  const container = document.createElement('div');
  container.setAttribute('data-trans-ext', 'translation');

  // 将父元素的计算颜色传入 Shadow DOM，使译文颜色与原页面一致
  if (parentColor) {
    container.style.setProperty('--trans-parent-color', parentColor);
  }
  if (parentBgColor) {
    container.style.setProperty('--trans-parent-bg', parentBgColor);
  }

  const shadow = container.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>${getTranslationStyles()}</style>
    <div class="trans-container">
      <div class="trans-loading">
        <span class="trans-dot">●</span>
        <span class="trans-dot">●</span>
        <span class="trans-dot">●</span>
      </div>
      <div class="trans-content"></div>
    </div>
  `;

  return container;
}

/** 块级译文的 Shadow DOM 样式 */
function getTranslationStyles(): string {
  return `
    .trans-container {
      display: block;
      margin-top: 4px;
      opacity: 0.85;
      font-family: inherit;
      font-size: inherit;
      line-height: inherit;
      color: var(--trans-parent-color, #374151);
    }

    .trans-content {
      white-space: pre-wrap;
      word-break: break-word;
    }

    .trans-content.trans-error {
      color: #ef4444;
      font-size: 12px;
    }

    .trans-loading {
      display: flex;
      gap: 3px;
      padding: 4px 0;
    }

    .trans-dot {
      font-size: 6px;
      color: #9ca3af;
      animation: transPulse 1.4s infinite;
    }

    .trans-dot:nth-child(2) { animation-delay: 0.2s; }
    .trans-dot:nth-child(3) { animation-delay: 0.4s; }

    @keyframes transPulse {
      0%, 100% { opacity: 0.3; }
      50% { opacity: 1; }
    }
  `;
}

/** 行内译文容器字体样式选项 */
interface InlineStyleOptions {
  color?: string;
  fontWeight?: string;
  fontStyle?: string;
  textDecoration?: string;
}

/**
 * 创建行内译文容器（用于短文本如标题、导航项、人名列表）
 *
 * 结构：
 * <span data-trans-ext="translation" class="trans-ext-inline">
 *   #shadow-root
 *     <style>...</style>
 *     <span class="trans-inline-content"></span>
 * </span>
 */
function createInlineTranslationContainer(options: InlineStyleOptions = {}): HTMLElement {
  const container = document.createElement('span');
  container.setAttribute('data-trans-ext', 'translation');
  container.classList.add('trans-ext-inline');

  if (options.color) {
    container.style.setProperty('--trans-parent-color', options.color);
  }
  if (options.fontWeight) {
    container.style.setProperty('--trans-parent-font-weight', options.fontWeight);
  }
  if (options.fontStyle) {
    container.style.setProperty('--trans-parent-font-style', options.fontStyle);
  }
  if (options.textDecoration) {
    container.style.setProperty('--trans-parent-text-decoration', options.textDecoration);
  }

  const shadow = container.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>${getInlineTranslationStyles()}</style>
    <span class="trans-inline-content"></span>
  `;

  return container;
}

/** 行内译文容器的 Shadow DOM 样式 */
function getInlineTranslationStyles(): string {
  return `
    .trans-inline-content {
      display: inline;
      color: var(--trans-parent-color, inherit);
      font-size: inherit;
      font-family: inherit;
      font-weight: var(--trans-parent-font-weight, inherit);
      font-style: var(--trans-parent-font-style, inherit);
      text-decoration: var(--trans-parent-text-decoration, inherit);
      line-height: inherit;
      white-space: normal;
    }

    .trans-inline-content::before {
      content: '\\FF5C';  /* 全角竖线 ｜ 作为视觉分隔符 */
      margin-right: 2px;
      opacity: 0.4;
      font-weight: normal;
    }

    .trans-inline-content.trans-error {
      color: #ef4444;
      font-size: 0.85em;
    }
  `;
}

/**
 * 移除所有译文
 * 当用户关闭全文模式时调用
 */
function removeAllTranslations(): void {
  isFullPageTranslating = false;
  batchIndex = 0;
  pendingTextNodes = [];
  // 替换为新 WeakSet，清空已翻译节点记录
  translatedNodes = new WeakSet<Node>();

  // 移除所有译文容器
  const containers = document.querySelectorAll('[data-trans-ext="translation"]');
  containers.forEach((el) => el.remove());

  logger.info('已移除所有译文', { count: containers.length });
}

// ==================== MutationObserver（SPA 支持） ====================

/**
 * 设置 MutationObserver 监听 DOM 变化
 * 当页面动态加载新内容时（如 SPA 路由切换），自动翻译新出现的文本节点
 */
function setupMutationObserver(): void {
  const observer = new MutationObserver((mutations) => {
    // 仅在全文模式下处理
    if (currentMode !== TranslationMode.FULL_PAGE) return;
    if (!isFullPageTranslating) return;

    // 收集所有新增的文本节点
    const newNodes: Node[] = [];
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        // 排除扩展自身的元素
        if (
          node instanceof HTMLElement &&
          (node.hasAttribute?.('data-trans-ext') ||
            node.closest?.('[data-trans-ext]'))
        ) {
          continue;
        }
        newNodes.push(node);
      }
    }

    if (newNodes.length === 0) return;

    // 防抖：等待页面稳定后再翻译
    if (fullPageDebounceTimer) {
      clearTimeout(fullPageDebounceTimer);
    }

    fullPageDebounceTimer = setTimeout(() => {
      // 从每个新增节点中收集可翻译的文本节点
      for (const node of newNodes) {
        const textNodes = collectTranslatableTextNodes(node);
        pendingTextNodes.push(...textNodes);
      }

      // 如果当前没有在处理，开始处理
      if (!isFullPageTranslating) {
        isFullPageTranslating = true;
        processNextBatch();
      }
    }, MUTATION_DEBOUNCE);
  });

  // 开始观察 DOM 变化
  observer.observe(document.body, {
    childList: true,    // 监听子节点增删
    subtree: true,      // 监听所有后代节点
  });
}

// ==================== 工具函数 ====================

/**
 * 生成唯一的请求 ID
 */
function generateRequestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ==================== 启动 ====================

// 仅在浏览器环境中执行初始化（Node.js 构建时 MutationObserver 不可用）。
// 必须放在所有 const/let/function 声明之后，否则 init() 引用的变量尚处于 TDZ。
if (typeof MutationObserver !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
  },
};
