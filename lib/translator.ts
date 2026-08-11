/**
 * LLM 翻译 API 调用封装
 *
 * 负责构建 OpenAI 兼容的 API 请求并处理流式/非流式响应。
 * 支持自定义 Base URL 和 API Key，兼容各种 LLM 提供商
 * （OpenAI、DeepSeek、通义千问、智谱等）。
 */

import type { ChatMessage, Settings } from '../types';
import { parseSSEStream } from './stream-parser';

/**
 * 构建翻译专用的 System Prompt
 * 确保 LLM 只返回翻译结果，不添加额外解释
 */
function buildSystemPrompt(targetLang: string): string {
  return `You are a professional translator. Translate the following text to ${targetLang}.
Rules:
1. Only output the translated text, nothing else.
2. Preserve the original formatting, line breaks, and punctuation style.
3. If the text is already in ${targetLang}, output it unchanged.
4. For code snippets, technical terms, or proper nouns, keep them as-is.
5. Do NOT add any explanations, notes, or prefixes like "Translation:"`;
}

/**
 * 非流式翻译：发送完整请求，一次性返回翻译结果
 * 适用于翻译短文本（如划词翻译的标题）
 */
export async function translateText(
  text: string,
  settings: Settings,
  targetLang: string = 'Chinese'
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(targetLang) },
    { role: 'user', content: text },
  ];

  const response = await fetch(`${settings.apiBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.modelName,
      messages,
      stream: false,
      temperature: 0.3,     // 低温度以获得更一致的翻译
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const translation = data.choices?.[0]?.message?.content?.trim();

  if (!translation) {
    throw new Error('API 返回的翻译结果为空');
  }

  return translation;
}

/**
 * 流式翻译：通过回调函数逐步返回翻译结果
 *
 * @param text 待翻译文本
 * @param settings API 配置
 * @param targetLang 目标语言
 * @param onChunk 每次收到增量文本时调用
 * @param signal 用于取消请求的 AbortSignal
 * @returns 完整翻译文本
 */
export async function translateTextStream(
  text: string,
  settings: Settings,
  targetLang: string,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(targetLang) },
    { role: 'user', content: text },
  ];

  const response = await fetch(`${settings.apiBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.modelName,
      messages,
      stream: true,          // 启用流式输出
      temperature: 0.3,
      max_tokens: 4096,
    }),
    signal,                  // 支持取消请求
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`API 请求失败 (${response.status}): ${errorText}`);
  }

  // 使用 SSE 解析器逐块读取翻译结果
  let fullTranslation = '';

  for await (const chunk of parseSSEStream(response.body, signal)) {
    fullTranslation += chunk;
    onChunk(chunk);
  }

  return fullTranslation.trim();
}