/**
 * 翻译扩展的类型定义
 * 定义了所有消息通信、存储结构和翻译相关的类型
 */

// ==================== 存储相关 ====================

/** 用户 API 配置 */
export interface Settings {
  provider: string;       // LLM 提供商名称（如 OpenAI、DeepSeek 等）
  apiBaseUrl: string;     // API 基础 URL（兼容 OpenAI 格式）
  apiKey: string;         // API 密钥
  modelName: string;      // 模型名称（如 gpt-4o-mini、deepseek-chat 等）
  targetLang: string;     // 目标语言，默认 "Chinese"
}

/** 默认设置 */
export const DEFAULT_SETTINGS: Settings = {
  provider: 'OpenAI',
  apiBaseUrl: 'https://api.openai.com',
  apiKey: '',
  modelName: 'gpt-4o-mini',
  targetLang: 'Chinese',
};

// ==================== 消息通信协议 ====================

/** 单次翻译请求（Content Script → Background） */
export interface TranslateRequest {
  type: 'translate';
  text: string;
  targetLang: string;
}

/** 流式翻译请求（Content Script → Background） */
export interface TranslateStreamRequest {
  type: 'translate-stream';
  text: string;
  targetLang: string;
  requestId: string;      // 唯一请求 ID，用于匹配流式响应
}

/** 取消流式翻译请求 */
export interface CancelStreamRequest {
  type: 'cancel-stream';
  requestId: string;
}

/** 后台发往 Content Script 的消息类型 */
export type BackgroundMessage =
  | TranslateRequest
  | TranslateStreamRequest
  | CancelStreamRequest;

/** 流式数据块（Background → Content Script，通过 Port） */
export interface StreamChunkMessage {
  type: 'chunk';
  requestId: string;
  content: string;        // 增量翻译文本
}

/** 流式翻译完成（Background → Content Script） */
export interface StreamDoneMessage {
  type: 'done';
  requestId: string;
  fullText: string;       // 完整翻译结果
}

/** 流式翻译错误（Background → Content Script） */
export interface StreamErrorMessage {
  type: 'error';
  requestId: string;
  message: string;
}

/** Content Script 接收的消息类型 */
export type ContentMessage =
  | StreamChunkMessage
  | StreamDoneMessage
  | StreamErrorMessage;

/** 单次翻译响应 */
export interface TranslateResponse {
  translation: string;
  error?: string;
}

// ==================== 翻译气泡相关 ====================

/** 翻译气泡的位置信息 */
export interface BubblePosition {
  x: number;
  y: number;
}

/** 翻译状态枚举 */
export enum TranslationMode {
  OFF = 'off',                    // 关闭
  SELECTION = 'selection',        // 仅划词翻译
  FULL_PAGE = 'fullpage',         // 全文双语显示
  TRANSLATION_ONLY = 'translation-only', // 全文翻译（仅显示译文）
}

// ==================== LLM API 相关 ====================

/** OpenAI 兼容的聊天消息格式 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** OpenAI 兼容的流式 chunk 中的 delta */
export interface StreamDelta {
  content?: string;
  role?: string;
}

/** OpenAI 兼容的流式 choice */
export interface StreamChoice {
  index: number;
  delta: StreamDelta;
  finish_reason: string | null;
}

/** OpenAI 兼容的流式响应 chunk */
export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: StreamChoice[];
}
