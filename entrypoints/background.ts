/**
 * Background Service Worker
 *
 * 翻译扩展的后台核心，负责：
 * 1. 监听 Content Script 的翻译请求（单次 + 流式）
 * 2. 从 chrome.storage.local 读取 API 配置
 * 3. 调用 LLM API 进行翻译（支持流式输出）
 * 4. 通过 chrome.runtime.connect 长连接推送流式数据
 * 5. PDF 接管：Chrome 151+ 通过 mime_types_handler 注册为 PDF 处理程序，
 *    由浏览器直接交给内置查看器；webNavigation 拦截仅作为旧版 Chrome 的降级方案
 *
 * 架构说明：
 * - 单次翻译：使用 chrome.runtime.sendMessage 请求/响应模式
 * - 流式翻译：Content Script 创建 Port 长连接，Worker 通过 Port 逐步推送翻译结果
 * - 取消机制：Content Script 发送取消消息，Worker 使用 AbortController 中止 fetch
 */

import type {
  BackgroundMessage,
  Settings,
  StreamChunkMessage,
  StreamDoneMessage,
  StreamErrorMessage,
} from '../types';
import { getSettings } from '../lib/storage';
import { translateText, translateTextStream } from '../lib/translator';
import { createLogger } from '../lib/logger';

/** 模块日志器 */
const logger = createLogger('后台服务');

export default {
  /**
   * Background Service Worker 主入口
   * 所有 chrome API 监听器在此注册
   */
  main() {
    // ==================== 活跃的流式翻译请求管理 ====================

    /** 存储当前活跃的流式翻译请求（requestId → controller + 所属 portId） */
    const activeStreams = new Map<string, { controller: AbortController; portId: string }>();

    /** 存储与 Content Script 的 Port 连接 */
    const activePorts = new Map<string, chrome.runtime.Port>();

    // ==================== 扩展安装/更新 ====================

    chrome.runtime.onInstalled.addListener(() => {
      logger.info('扩展已安装/更新');
    });

    // ==================== 工具栏图标点击 ====================

    // 点击工具栏图标时，直接在新标签页打开完整的设置页
    chrome.action.onClicked.addListener(() => {
      logger.info('工具栏图标被点击，打开设置页');
      chrome.runtime.openOptionsPage();
    });

    // ==================== 消息监听 ====================

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const msg = message as BackgroundMessage;
      logger.info('收到单次消息', { type: msg.type });

      if (msg.type === 'translate') {
        logger.info('处理单次翻译请求', {
          textLength: msg.text?.length ?? 0,
          targetLang: msg.targetLang,
        });
        handleTranslateMessage(msg.text, msg.targetLang)
          .then((translation) => {
            logger.info('单次翻译成功', { length: translation.length });
            sendResponse({ translation });
          })
          .catch((error) => {
            logger.error('单次翻译失败', { message: error.message });
            sendResponse({ error: error.message });
          });
        return true;
      }

      if (msg.type === 'cancel-stream') {
        logger.info('收到取消流式请求', { requestId: msg.requestId });
        handleCancelStream(msg.requestId);
        sendResponse({ success: true });
        return false;
      }

      logger.warn('未识别的消息类型', { type: msg.type });
      return false;
    });

    // ==================== 长连接监听（流式翻译） ====================

    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== 'translate-stream') {
        logger.warn('收到非 translate-stream 的连接，已忽略', { name: port.name });
        return;
      }

      const portId = `port-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      activePorts.set(portId, port);
      logger.info('新的流式连接已建立', { portId, activePorts: activePorts.size });

      port.onMessage.addListener((message: BackgroundMessage) => {
        if (message.type === 'translate-stream') {
          logger.info('收到流式翻译请求', {
            portId,
            requestId: message.requestId,
            textLength: message.text?.length ?? 0,
            targetLang: message.targetLang,
          });
          handleStreamTranslate(
            port,
            portId,
            message.requestId,
            message.text,
            message.targetLang
          );
        } else if (message.type === 'cancel-stream') {
          logger.info('收到取消流式请求', { portId, requestId: message.requestId });
          handleCancelStream(message.requestId);
        } else {
          logger.warn('Port 收到未识别的消息类型', { portId, type: message.type });
        }
      });

      port.onDisconnect.addListener(() => {
        logger.info('流式连接已断开', {
          portId,
          activeStreamsBefore: activeStreams.size,
        });
        activePorts.delete(portId);
        // 仅中止与当前断开端口相关的流式请求，避免影响其他端口的正常请求
        for (const [requestId, entry] of activeStreams) {
          if (entry.portId !== portId) continue;
          entry.controller.abort();
          activeStreams.delete(requestId);
          logger.info('连接断开已中止请求', { requestId, portId });
        }
      });
    });

    // ==================== PDF 导航拦截 ====================

    /**
     * Chrome 151+ 且清单已声明 mime_types_handler 时，浏览器会直接打开扩展的
     * pdf-viewer.html 作为 PDF 处理程序（本地 file:// 文件无需「允许访问文件网址」）。
     * 此时 webNavigation 拦截仅作为降级：当用户把本扩展从 PDF 处理程序中移除时，
     * 仍可尝试用 URL 参数方式打开查看器。
     */
    const hasMimeHandler =
      typeof chrome.mimeHandler !== 'undefined' &&
      typeof chrome.mimeHandler?.getMimeHandlerOptions === 'function';

    /**
     * 判断 URL 是否指向 PDF 文件
     * 优先解析 pathname（兼容带查询参数/锚点的场景），解析失败时回退字符串匹配
     */
    function isPdfUrl(rawUrl: string): boolean {
      try {
        const url = new URL(rawUrl);
        return url.pathname.toLowerCase().endsWith('.pdf');
      } catch {
        const lower = rawUrl.toLowerCase();
        return (
          lower.endsWith('.pdf') ||
          lower.includes('.pdf?') ||
          lower.includes('.pdf#')
        );
      }
    }

    /**
     * 将当前标签页重定向到内置 PDF 查看器（?url= 参数模式，旧版 Chrome 降级路径）
     */
    function redirectToViewer(details: chrome.webNavigation.WebNavigationBaseCallbackDetails): void {
      logger.info('拦截 PDF 导航，重定向到内置查看器', {
        tabId: details.tabId,
        url: details.url,
      });

      // 本地文件需要“允许访问文件网址”权限，否则查看器也无法读取；
      // 这里仅记录诊断信息，便于用户在控制台排查
      if (details.url.startsWith('file:')) {
        try {
          chrome.extension.isAllowedFileSchemeAccess((allowed) => {
            logger.info('本地 PDF 文件访问权限检查', {
              tabId: details.tabId,
              url: details.url,
              fileAccessAllowed: allowed,
            });
            if (!allowed) {
              logger.warn(
                '扩展未开启「允许访问文件网址」，本地 PDF 将无法加载；请在 chrome://extensions 中开启该权限后重试',
                { url: details.url }
              );
            }
          });
        } catch (err) {
          logger.warn('文件访问权限检查失败', { error: err });
        }
      }

      const viewerUrl = chrome.runtime.getURL(
        `pdf-viewer.html?url=${encodeURIComponent(details.url)}`
      );
      chrome.tabs.update(details.tabId, { url: viewerUrl });
    }

    chrome.webNavigation.onBeforeNavigate.addListener((details) => {
      // 仅拦截主框架导航，忽略 iframe
      if (details.frameId !== 0) return;

      if (!isPdfUrl(details.url)) return;

      if (hasMimeHandler) {
        // MIME 处理程序仍启用时，交给浏览器原生接管，避免与 webNavigation 双重跳转
        chrome.mimeHandler
          .getMimeHandlerOptions('application/pdf')
          .then((options) => {
            if (options.enabled) {
              logger.debug('PDF 已由 MIME 处理程序接管，跳过 webNavigation 拦截', {
                tabId: details.tabId,
                url: details.url,
              });
              return;
            }
            logger.info('PDF MIME 处理程序已被禁用，回退到 webNavigation 拦截', {
              tabId: details.tabId,
              url: details.url,
            });
            redirectToViewer(details);
          })
          .catch((err) => {
            // 状态查询失败时宁可跳过，避免与浏览器原生接管冲突
            logger.warn('查询 PDF MIME 处理程序状态失败，跳过拦截', {
              url: details.url,
              error: err,
            });
          });
        return;
      }

      redirectToViewer(details);
    });

    // ==================== 翻译处理函数 ====================

    async function handleTranslateMessage(
      text: string,
      targetLang: string
    ): Promise<string> {
      if (!text?.trim()) {
        logger.warn('翻译文本为空，已拒绝');
        throw new Error('翻译文本不能为空');
      }

      logger.info('开始处理单次翻译', { textLength: text.length, targetLang });
      const settings = await getSettings();

      if (!settings.apiKey) {
        logger.error('缺少 API Key 配置');
        throw new Error('请先在扩展设置中配置 API Key');
      }
      if (!settings.apiBaseUrl) {
        logger.error('缺少 API Base URL 配置');
        throw new Error('请先在扩展设置中配置 API Base URL');
      }

      logger.info('调用 LLM 进行单次翻译', {
        provider: settings.provider,
        model: settings.modelName,
      });
      const result = await translateText(text, settings, targetLang);
      logger.info('单次翻译完成', { inputLength: text.length, outputLength: result.length });
      return result;
    }

    async function handleStreamTranslate(
      port: chrome.runtime.Port,
      portId: string,
      requestId: string,
      text: string,
      targetLang: string
    ): Promise<void> {
      if (!text?.trim()) {
        logger.warn('流式翻译文本为空，已拒绝', { requestId });
        sendPortMessage<StreamErrorMessage>(port, {
          type: 'error',
          requestId,
          message: '翻译文本不能为空',
        });
        return;
      }

      const controller = new AbortController();
      activeStreams.set(requestId, { controller, portId });
      logger.info('开始流式翻译', {
        requestId,
        textLength: text.length,
        targetLang,
        activeStreams: activeStreams.size,
      });

      try {
        const settings = await getSettings();

        if (!settings.apiKey) {
          logger.error('缺少 API Key 配置', { requestId });
          throw new Error('请先在扩展设置中配置 API Key');
        }
        if (!settings.apiBaseUrl) {
          logger.error('缺少 API Base URL 配置', { requestId });
          throw new Error('请先在扩展设置中配置 API Base URL');
        }

        logger.info('调用 LLM 进行流式翻译', {
          requestId,
          provider: settings.provider,
          model: settings.modelName,
        });

        let chunkCount = 0;
        const fullText = await translateTextStream(
          text,
          settings,
          targetLang,
          (chunk: string) => {
            if (controller.signal.aborted) return;
            chunkCount++;
            // chunk 为高频消息，仅在 debug 级别输出
            logger.debug('推送流式数据块', {
              requestId,
              chunkIndex: chunkCount,
              chunkLength: chunk.length,
            });
            sendPortMessage<StreamChunkMessage>(port, {
              type: 'chunk',
              requestId,
              content: chunk,
            });
          },
          controller.signal
        );

        if (!controller.signal.aborted) {
          logger.info('流式翻译完成', {
            requestId,
            chunkCount,
            totalLength: fullText.length,
          });
          sendPortMessage<StreamDoneMessage>(port, {
            type: 'done',
            requestId,
            fullText,
          });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          logger.info('请求已被取消', { requestId });
        } else {
          const errorMessage =
            error instanceof Error ? error.message : '翻译请求失败';
          logger.error('流式翻译失败', { requestId, message: errorMessage });

          sendPortMessage<StreamErrorMessage>(port, {
            type: 'error',
            requestId,
            message: errorMessage,
          });
        }
      } finally {
        activeStreams.delete(requestId);
        logger.debug('请求清理完成', { requestId, remaining: activeStreams.size });
      }
    }

    function handleCancelStream(requestId: string): void {
      const entry = activeStreams.get(requestId);
      if (entry) {
        logger.info('取消流式请求', { requestId, portId: entry.portId });
        entry.controller.abort();
        activeStreams.delete(requestId);
      } else {
        logger.debug('取消请求未找到对应 controller', { requestId });
      }
    }

    function sendPortMessage<T>(port: chrome.runtime.Port, message: T): void {
      try {
        port.postMessage(message);
      } catch (err) {
        logger.warn('Port 发送消息失败，连接可能已断开', { error: err });
      }
    }
  },
};
