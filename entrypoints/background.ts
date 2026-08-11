/**
 * Background Service Worker
 *
 * 翻译扩展的后台核心，负责：
 * 1. 监听 Content Script 的翻译请求（单次 + 流式）
 * 2. 从 chrome.storage.local 读取 API 配置
 * 3. 调用 LLM API 进行翻译（支持流式输出）
 * 4. 通过 chrome.runtime.connect 长连接推送流式数据
 * 5. 拦截 PDF 导航，重定向到内置 PDF 查看器
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

    chrome.webNavigation.onBeforeNavigate.addListener((details) => {
      // 仅拦截主框架导航，忽略 iframe
      if (details.frameId !== 0) return;

      const url = details.url.toLowerCase();
      const isPdf =
        url.endsWith('.pdf') ||
        url.includes('.pdf?') ||
        url.includes('.pdf#');

      if (isPdf) {
        logger.info('拦截 PDF 导航，重定向到内置查看器', {
          tabId: details.tabId,
          url: details.url,
        });
        const viewerUrl = chrome.runtime.getURL(
          `pdf-viewer.html?url=${encodeURIComponent(details.url)}`
        );
        chrome.tabs.update(details.tabId, { url: viewerUrl });
      }
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