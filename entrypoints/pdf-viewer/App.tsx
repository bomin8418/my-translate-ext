/**
 * PDF 查看器 - 使用 pdf.js 渲染 PDF 并支持双语翻译
 *
 * 功能：
 * 1. 优先通过 chrome.mimeHandler 读取流，不支持时回退到 ?url= 参数模式
 * 2. 使用 pdf.js 渲染 PDF 页面到 Canvas
 * 3. 提取 PDF 文本内容
 * 4. 支持双语翻译显示（提取英文文本 → 翻译为中文）
 * 5. 页面导航和缩放控制
 *
 * 技术要点：
 * - pdf.js 4.x API：getDocument + getPage + render + getTextContent
 * - 流式翻译：通过 chrome.runtime.connect 与 Background Worker 通信
 * - 分页加载：按需渲染页面，避免一次性渲染所有页面
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { ContentMessage } from '../../types';
import { getSettings } from '../../lib/storage';
import { createLogger } from '../../lib/logger';

/** 模块日志器 */
const logger = createLogger('PDF 查看器');

// ==================== pdf.js Worker 初始化 ====================
// 设置 pdf.js 的 Web Worker，用于在后台线程解析 PDF
// 使用 Vite 的 URL import 来获取 worker 的正确路径
try {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString();
} catch (err) {
  // 如果 URL import 失败，尝试使用相对路径
  logger.warn('Worker 路径设置失败，将使用默认设置', err);
}

/** pdf.js 加载 PDF 的公共配置 */
const PDF_COMMON_OPTIONS = {
  // 仅部分特殊编码字体需要 cmap，普通英文 PDF 不会触发下载
  cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/cmaps/',
  cMapPacked: true,
};

// ==================== 类型定义 ====================

/** PDF 文本项（从 pdf.js 提取） */
interface PdfTextItem {
  text: string;
  pageNum: number;
  y: number; // 垂直位置（用于排序）
}

/** 翻译结果 */
interface TranslationResult {
  original: string;
  translated: string;
  loading: boolean;
  error?: string;
}

/**
 * 将文本项按段落分组
 * 根据垂直位置间距判断段落边界（纯函数，不依赖组件状态）
 */
const groupIntoParagraphs = (items: PdfTextItem[]): PdfTextItem[][] => {
  if (items.length === 0) return [];

  const paragraphs: PdfTextItem[][] = [];
  // noUncheckedIndexedAccess 下索引访问类型为 PdfTextItem | undefined；
  // 此处已校验 length > 0，items[0] 必然存在，使用非空断言
  let currentParagraph: PdfTextItem[] = [items[0]!];

  for (let i = 1; i < items.length; i++) {
    // 循环边界保证 i 与 i-1 均在数组范围内，使用非空断言
    const prev = items[i - 1]!;
    const curr = items[i]!;
    const gap = Math.abs(curr.y - prev.y);

    // 如果垂直间距过大（超过 20 个单位），视为新段落
    if (gap > 20) {
      paragraphs.push(currentParagraph);
      currentParagraph = [curr];
    } else {
      currentParagraph.push(curr);
    }
  }

  if (currentParagraph.length > 0) {
    paragraphs.push(currentParagraph);
  }

  return paragraphs;
};

// ==================== 组件 ====================

const PdfViewer: React.FC = () => {
  // ==================== 状态 ====================

  /** PDF 文件 URL */
  const [pdfUrl, setPdfUrl] = useState<string>('');
  /** PDF 文档对象 */
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  /** 总页数 */
  const [totalPages, setTotalPages] = useState(0);
  /** 当前页码 */
  const [currentPage, setCurrentPage] = useState(1);
  /** 缩放比例 */
  const [scale, setScale] = useState(1.5);
  /** 是否正在加载 */
  const [isLoading, setIsLoading] = useState(true);
  /** 是否启用翻译 */
  const [translationEnabled, setTranslationEnabled] = useState(false);
  /** 错误信息 */
  const [error, setError] = useState<string | null>(null);
  /** 提取的文本项 */
  const [textItems, setTextItems] = useState<PdfTextItem[]>([]);
  /** 翻译结果映射 */
  const [translations, setTranslations] = useState<Map<string, TranslationResult>>(new Map());
  /** 是否正在翻译 */
  const [isTranslating, setIsTranslating] = useState(false);

  // Canvas 引用
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Port 连接引用
  const portRef = useRef<chrome.runtime.Port | null>(null);
  // 翻译请求代号：每次翻页/关闭翻译时自增，用于丢弃过期的异步翻译结果
  const translationGenRef = useRef(0);
  // 当前 PDF 的加载来源（MIME 流或 URL 参数），失败重试时按来源重新加载
  const sourceRef = useRef<
    | { kind: 'stream'; streamUrl: string; displayUrl: string }
    | { kind: 'url'; url: string }
    | null
  >(null);

  // ==================== PDF 加载 ====================

  /**
   * 加载 PDF 文件
   * 使用 pdf.js 的 getDocument API
   */
  const loadPdf = useCallback(async (url: string) => {
    setIsLoading(true);
    setError(null);

    try {
      // 本地文件（file://）先用 fetch 读取字节，再交给 pdf.js，
      // 避免 pdf.js 内部 fetch 流对 file 协议的限制，同时获得更明确的错误信息
      let loadingTask: ReturnType<typeof pdfjsLib.getDocument>;
      if (url.startsWith('file:')) {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`读取本地文件失败（HTTP ${response.status}）`);
        }
        const data = await response.arrayBuffer();
        loadingTask = pdfjsLib.getDocument({ ...PDF_COMMON_OPTIONS, data });
      } else {
        // 在线 PDF 直接交给 pdf.js 加载（扩展具有 <all_urls> 主机权限，可跨域读取）
        loadingTask = pdfjsLib.getDocument({ ...PDF_COMMON_OPTIONS, url });
      }

      const doc = await loadingTask.promise;
      setPdfDoc(doc);
      setTotalPages(doc.numPages);
      setCurrentPage(1);
      // 加载成功后不自动触发插件功能，等待用户点击“开始翻译”按钮
      setTranslationEnabled(false);
      logger.info('PDF 加载成功', { pages: doc.numPages, url });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'PDF 加载失败';
      logger.error('PDF 加载失败', { url, error: errorMsg });

      // 本地文件读取失败时，优先排查扩展的“允许访问文件网址”权限
      if (url.startsWith('file:')) {
        const applyFileError = (allowed: boolean) => {
          if (allowed) {
            setError(`PDF 加载失败: ${errorMsg}`);
          } else {
            setError(
              '无法读取本地 PDF 文件：扩展尚未获得访问本地文件的权限。' +
                '请在扩展详情页（chrome://extensions）开启「允许访问文件网址」，然后点击下方“重试”。'
            );
          }
        };
        if (typeof chrome.extension?.isAllowedFileSchemeAccess === 'function') {
          chrome.extension.isAllowedFileSchemeAccess(applyFileError);
        } else {
          setError(`PDF 加载失败: ${errorMsg}`);
        }
      } else {
        setError(`PDF 加载失败: ${errorMsg}`);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * 通过 MIME 处理程序的 streamUrl 加载 PDF（Chrome 151+）
   */
  const loadPdfFromStream = useCallback(
    async (streamUrl: string, displayUrl: string) => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(streamUrl);
        if (!response.ok) {
          throw new Error(`读取 PDF 流失败（HTTP ${response.status}）`);
        }
        const data = await response.arrayBuffer();
        const doc = await pdfjsLib
          .getDocument({ ...PDF_COMMON_OPTIONS, data })
          .promise;
        setPdfDoc(doc);
        setTotalPages(doc.numPages);
        setCurrentPage(1);
        // 加载成功后不自动触发插件功能，等待用户点击“开始翻译”按钮
        setTranslationEnabled(false);
        logger.info('PDF 通过 MIME 流加载成功', {
          pages: doc.numPages,
          displayUrl,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'PDF 加载失败';
        logger.error('PDF 流加载失败', {
          displayUrl,
          streamUrl,
          error: errorMsg,
        });
        setError(`PDF 加载失败: ${errorMsg}`);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  /**
   * 失败后重新加载当前 PDF（根据加载来源选择对应方式）
   */
  const retryLoad = useCallback(() => {
    const src = sourceRef.current;
    if (!src) return;
    if (src.kind === 'stream') {
      loadPdfFromStream(src.streamUrl, src.displayUrl);
    } else {
      loadPdf(src.url);
    }
  }, [loadPdf, loadPdfFromStream]);

  // ==================== 初始化 ====================

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      // 1) MIME 处理程序模式（Chrome 151+）：
      //    浏览器打开 PDF 时直接把本查看器页作为处理程序，通过 getStreamInfo()
      //    获取流信息。本地 file:// 文件在此模式下无需开启「允许访问文件网址」。
      const hasMimeHandler =
        typeof chrome.mimeHandler !== 'undefined' &&
        typeof chrome.mimeHandler?.getStreamInfo === 'function';

      if (hasMimeHandler) {
        try {
          const info = await chrome.mimeHandler.getStreamInfo();
          if (cancelled) return;
          logger.info('已通过 MIME 处理程序接管 PDF', {
            originalUrl: info.originalUrl,
            embedded: info.embedded,
          });
          sourceRef.current = {
            kind: 'stream',
            streamUrl: info.streamUrl,
            displayUrl: info.originalUrl,
          };
          setPdfUrl(info.originalUrl);
          await loadPdfFromStream(info.streamUrl, info.originalUrl);
          return;
        } catch (err) {
          logger.warn('获取 MIME 流信息失败，回退到 URL 参数模式', { error: err });
        }
      }

      // 2) URL 参数模式（旧版 Chrome 的 webNavigation 拦截降级路径）
      const params = new URLSearchParams(window.location.search);
      const url = params.get('url');

      if (!url) {
        logger.warn('未找到 PDF 文件 URL 参数');
        setError('未找到 PDF 文件 URL，请在 URL 参数中提供 ?url=<pdf-url>');
        setIsLoading(false);
        return;
      }

      logger.info('检测到 PDF URL，开始加载', { url });
      sourceRef.current = { kind: 'url', url };
      setPdfUrl(url);
      await loadPdf(url);
    };

    init();

    return () => {
      cancelled = true;
    };
  }, [loadPdf, loadPdfFromStream]);

  // ==================== 页面渲染 ====================

  /**
   * 渲染当前 PDF 页面到 Canvas
   */
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;

    const renderPage = async () => {
      try {
        logger.info('开始渲染页面', { page: currentPage, scale });
        const page = await pdfDoc.getPage(currentPage);
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current!;
        const context = canvas.getContext('2d')!;

        // 设置 Canvas 尺寸
        canvas.width = viewport.width;
        canvas.height = viewport.height;

        // 渲染页面
        await page.render({
          canvasContext: context,
          viewport: viewport,
        }).promise;

        logger.info('页面渲染完成', {
          page: currentPage,
          scale,
          width: viewport.width,
          height: viewport.height,
        });
      } catch (err) {
        logger.error('页面渲染失败', { page: currentPage, error: err });
      }
    };

    renderPage();
  }, [pdfDoc, currentPage, scale]);

  // ==================== 文本提取和翻译 ====================

  /**
   * 提取 PDF 页面的文本内容
   * 使用 pdf.js 的 getTextContent API
   */
  const extractPageText = useCallback(async (
    doc: PDFDocumentProxy,
    pageNum: number
  ): Promise<PdfTextItem[]> => {
    logger.info('开始提取页面文本', { page: pageNum });
    const page = await doc.getPage(pageNum);
    const textContent = await page.getTextContent();
    logger.info('getTextContent 完成', { page: pageNum, rawCount: textContent.items.length });

    // 提取文本项，按垂直位置排序（模拟阅读顺序）
    // textContent.items 类型为 Array<TextItem | TextMarkedContent>，
    // 仅 TextItem 含 str 与 transform 字段；pdfjs-dist 主入口未导出 TextItem，
    // 故用 'str' in item 进行类型收窄，避免在联合类型上访问 transform
    const items: PdfTextItem[] = [];
    for (const item of textContent.items) {
      if (!('str' in item)) continue;
      items.push({
        text: item.str.trim(),
        pageNum,
        // transform 为 pdf.js 的 6 元素变换矩阵，索引 5 为 y 坐标；
        // noUncheckedIndexedAccess 下索引访问可能为 undefined，使用 ?? 兜底
        y: item.transform[5] ?? 0,
      });
    }

    // 过滤空文本项并按垂直位置排序（从上到下）
    const result = items.filter((item) => item.text.length > 0);
    result.sort((a, b) => b.y - a.y);

    logger.info('页面文本提取完成', {
      page: pageNum,
      rawCount: textContent.items.length,
      validCount: result.length,
    });
    return result;
  }, []);

  /**
   * 翻译文本项列表
   * 使用流式翻译，通过 Port 与 Background Worker 通信
   */
  const translateTextItems = useCallback(async (
    items: PdfTextItem[],
    gen: number
  ): Promise<void> => {
    // 若已有进行中的翻译连接，先断开（Background 会自动中止对应流式请求）
    if (portRef.current) {
      try {
        portRef.current.disconnect();
      } catch {
        // 忽略已断开的连接
      }
    }

    // 建立 Port 连接
    const port = chrome.runtime.connect({ name: 'translate-stream' });
    portRef.current = port;
    logger.info('已建立 Port 连接，准备流式翻译');

    // 按段落分组文本（相邻的文本项合并为一个段落）
    const paragraphs = groupIntoParagraphs(items);
    logger.info('段落分组完成', {
      totalItems: items.length,
      paragraphCount: paragraphs.length,
    });

    for (let i = 0; i < paragraphs.length; i++) {
      // 请求已过期（翻页或关闭翻译），停止后续段落
      if (gen !== translationGenRef.current) {
        logger.debug('翻译请求已过期，停止后续段落', {
          index: i,
          gen,
          currentGen: translationGenRef.current,
        });
        try {
          port.disconnect();
        } catch {
          // 忽略
        }
        return;
      }

      const paragraph = paragraphs[i]!;
      const originalText = paragraph.map((item) => item.text).join(' ');

      if (originalText.length < 2) {
        logger.debug('跳过过短段落', { index: i, length: originalText.length });
        continue;
      }

      // 创建翻译结果条目
      // paragraph 由 groupIntoParagraphs 产出，必为非空数组，使用非空断言
      const firstItem = paragraph[0]!;
      const key = `p-${firstItem.pageNum}-${firstItem.y}`;
      setTranslations((prev) => {
        const next = new Map(prev);
        next.set(key, { original: originalText, translated: '', loading: true });
        return next;
      });

      // 发送流式翻译请求
      const requestId = `pdf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      logger.info('发送流式翻译请求', {
        index: i,
        requestId,
        key,
        length: originalText.length,
        preview: originalText.slice(0, 60),
      });

      await new Promise<void>((resolve) => {
        let fullTranslation = '';

        const listener = (message: ContentMessage) => {
          // 请求已过期：移除监听并结束当前段落等待，避免旧结果写入界面
          if (gen !== translationGenRef.current) {
            port.onMessage.removeListener(listener);
            resolve();
            return;
          }

          if (message.type === 'chunk' && message.requestId === requestId) {
            fullTranslation += message.content;
            // chunk 为高频消息，仅在 debug 级别输出
            logger.debug('收到流式数据块', {
              requestId,
              chunkLength: message.content.length,
              totalLength: fullTranslation.length,
            });
            setTranslations((prev) => {
              const next = new Map(prev);
              next.set(key, {
                original: originalText,
                translated: fullTranslation,
                loading: true,
              });
              return next;
            });
          } else if (message.type === 'done' && message.requestId === requestId) {
            logger.info('段落翻译完成', {
              requestId,
              key,
              length: message.fullText.length,
            });
            setTranslations((prev) => {
              const next = new Map(prev);
              next.set(key, {
                original: originalText,
                translated: message.fullText,
                loading: false,
              });
              return next;
            });
            port.onMessage.removeListener(listener);
            resolve();
          } else if (message.type === 'error' && message.requestId === requestId) {
            logger.error('段落翻译失败', { requestId, key, message: message.message });
            setTranslations((prev) => {
              const next = new Map(prev);
              next.set(key, {
                original: originalText,
                translated: '',
                loading: false,
                error: message.message,
              });
              return next;
            });
            port.onMessage.removeListener(listener);
            resolve();
          }
        };

        port.onMessage.addListener(listener);

        port.postMessage({
          type: 'translate-stream',
          text: originalText,
          targetLang: 'Chinese',
          requestId,
        });
      });
    }
    logger.info('所有段落翻译完成', { paragraphCount: paragraphs.length });
  }, []);

  /**
   * 翻译指定页面：提取文本并流式翻译
   * 通过代号（generation）确保翻页/关闭后旧请求的结果不会写入界面
   */
  const translateCurrentPage = useCallback(
    async (pageNum: number) => {
      if (!pdfDoc) return;

      const gen = ++translationGenRef.current;
      setIsTranslating(true);
      setTranslations(new Map());

      try {
        // 提取当前页面的文本
        const items = await extractPageText(pdfDoc, pageNum);
        if (gen !== translationGenRef.current) return;

        setTextItems(items);
        logger.info('文本提取完成', { page: pageNum, count: items.length });

        // 翻译提取的文本
        await translateTextItems(items, gen);
      } catch (err) {
        if (gen !== translationGenRef.current) return;
        logger.error('翻译失败', { page: pageNum, error: err });
      } finally {
        if (gen === translationGenRef.current) {
          setIsTranslating(false);
        }
      }
    },
    [pdfDoc, extractPageText, translateTextItems]
  );

  // ==================== 自动翻译 ====================

  // 开启翻译时，渲染当前页并自动翻译；翻页时也会重新翻译新页面
  useEffect(() => {
    if (!pdfDoc || !translationEnabled) return;
    translateCurrentPage(currentPage);
  }, [pdfDoc, translationEnabled, currentPage, translateCurrentPage]);

  /**
   * 开启/关闭翻译
   */
  const toggleTranslation = useCallback(() => {
    if (translationEnabled) {
      // 关闭翻译：使进行中的请求失效并断开连接
      logger.info('关闭翻译', { page: currentPage });
      translationGenRef.current += 1;
      setTranslationEnabled(false);
      setTranslations(new Map());
      setIsTranslating(false);
      if (portRef.current) {
        try {
          portRef.current.disconnect();
        } catch {
          // 忽略已断开的连接
        }
        portRef.current = null;
      }
    } else {
      logger.info('开启翻译', { page: currentPage });
      setTranslationEnabled(true);
    }
  }, [translationEnabled, currentPage]);

  // ==================== 页面导航 ====================

  /** 跳转到上一页 */
  const goToPrevPage = useCallback(() => {
    setCurrentPage((prev) => Math.max(1, prev - 1));
  }, []);

  /** 跳转到下一页 */
  const goToNextPage = useCallback(() => {
    setCurrentPage((prev) => Math.min(totalPages, prev + 1));
  }, [totalPages]);

  /** 缩放控制 */
  const zoomIn = useCallback(() => {
    setScale((prev) => Math.min(3, prev + 0.25));
  }, []);

  const zoomOut = useCallback(() => {
    setScale((prev) => Math.max(0.5, prev - 0.25));
  }, []);

  // ==================== 渲染 ====================

  // 加载中状态
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <svg className="animate-spin h-10 w-10 text-blue-500 mx-auto mb-4" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <p className="text-gray-500">正在加载 PDF 文件...</p>
        </div>
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="bg-white rounded-2xl shadow-lg p-8 max-w-lg text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <h1 className="text-xl font-bold text-gray-800 mb-2">PDF 加载失败</h1>
          <p className="text-gray-500 mb-4">{error}</p>
          <p className="text-sm text-gray-400 mb-4">
            原始 PDF 链接: <a href={pdfUrl} className="text-blue-500 underline" target="_blank">{pdfUrl}</a>
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={retryLoad}
              className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              重试
            </button>
            {error.includes('允许访问文件网址') && (
              <button
                onClick={() => chrome.tabs.create({ url: 'chrome://extensions/' })}
                className="px-6 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors"
              >
                打开扩展详情页
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* ==================== 顶部工具栏 ==================== */}
      <header className="bg-white shadow-sm border-b border-gray-200 px-4 py-3 flex items-center gap-4 flex-wrap">
        {/* PDF 标题 */}
        <h1 className="text-lg font-semibold text-gray-800 truncate max-w-md">
          📄 PDF 查看器
        </h1>

        {/* 页面导航 */}
        <div className="flex items-center gap-2">
          <button
            onClick={goToPrevPage}
            disabled={currentPage <= 1}
            className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg
                       disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            ← 上一页
          </button>
          <span className="text-sm text-gray-600 min-w-[80px] text-center">
            {currentPage} / {totalPages}
          </span>
          <button
            onClick={goToNextPage}
            disabled={currentPage >= totalPages}
            className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg
                       disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            下一页 →
          </button>
        </div>

        {/* 缩放控制 */}
        <div className="flex items-center gap-2">
          <button
            onClick={zoomOut}
            className="px-2 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            title="缩小"
          >
            🔍−
          </button>
          <span className="text-sm text-gray-600 w-14 text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={zoomIn}
            className="px-2 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            title="放大"
          >
            🔍+
          </button>
        </div>

        {/* 翻译开关 */}
        <button
          onClick={toggleTranslation}
          disabled={isTranslating}
          className={`px-4 py-1.5 text-sm rounded-lg font-medium transition-colors ${
            translationEnabled
              ? 'bg-green-600 text-white hover:bg-green-700'
              : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
          } disabled:opacity-60 disabled:cursor-wait`}
        >
          {isTranslating ? '⏳ 翻译中...' : translationEnabled ? '✅ 双语显示' : '🌐 开启翻译'}
        </button>

        {/* 原始 PDF 链接 */}
        <a
          href={pdfUrl}
          target="_blank"
          className="text-sm text-blue-500 hover:text-blue-700 underline ml-auto"
        >
          打开原始 PDF
        </a>
      </header>

      {/* ==================== 主内容区 ==================== */}
      <main className="flex-1 overflow-auto p-4">
        <div className="max-w-5xl mx-auto space-y-6">
          {/* PDF 页面渲染 */}
          <div className="bg-white rounded-xl shadow-lg overflow-hidden">
            <div className="overflow-auto">
              <canvas
                ref={canvasRef}
                className="block mx-auto"
                style={{ maxWidth: '100%', height: 'auto' }}
              />
            </div>
          </div>

          {/* 用户明确触发翻译的醒目按钮 */}
          {!translationEnabled && !isTranslating && (
            <div className="bg-white rounded-xl shadow-lg border border-blue-100 p-6 flex flex-col items-center text-center gap-4">
              <div className="w-12 h-12 rounded-full bg-blue-50 flex items-center justify-center text-2xl">
                🌐
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-800">
                  PDF 已加载，需要翻译内容吗？
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  点击下方按钮后，将提取当前页文本并显示双语翻译。
                </p>
              </div>
              <button
                type="button"
                onClick={toggleTranslation}
                className="px-6 py-3 bg-blue-600 hover:bg-blue-700 active:bg-blue-800
                           text-white font-semibold rounded-lg shadow-sm
                           focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
                           transition-colors"
              >
                🚀 开始翻译 PDF
              </button>
            </div>
          )}

          {/* 翻译结果区域 */}
          {translationEnabled && (
            <div className="bg-white rounded-xl shadow-lg p-6">
              <h2 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
                <span>📝</span> 双语对照翻译
                {isTranslating && (
                  <span className="text-sm font-normal text-gray-400 flex items-center gap-1">
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    翻译中...
                  </span>
                )}
              </h2>

              {translations.size === 0 && !isTranslating && (
                <p className="text-gray-400 text-center py-8">
                  当前页面没有可翻译的文本内容
                </p>
              )}

              <div className="space-y-4">
                {Array.from(translations.entries()).map(([key, result]) => (
                  <div
                    key={key}
                    className="border border-gray-100 rounded-lg p-4 hover:border-blue-200 transition-colors"
                  >
                    {/* 原文 */}
                    <p className="text-sm text-gray-600 mb-2 leading-relaxed">
                      {result.original}
                    </p>
                    {/* 译文 */}
                    <div className="pl-3 border-l-2 border-green-400">
                      {result.loading && !result.translated ? (
                        <div className="flex gap-1 py-1">
                          <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-pulse-dot" />
                          <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-pulse-dot" style={{ animationDelay: '0.2s' }} />
                          <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-pulse-dot" style={{ animationDelay: '0.4s' }} />
                        </div>
                      ) : result.error ? (
                        <p className="text-sm text-red-500">⚠️ {result.error}</p>
                      ) : (
                        <p className="text-sm text-gray-800 leading-relaxed">
                          {result.translated}
                          {result.loading && (
                            <span className="inline-block w-2 h-4 bg-gray-400 ml-0.5 animate-pulse rounded-sm" />
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default PdfViewer;
