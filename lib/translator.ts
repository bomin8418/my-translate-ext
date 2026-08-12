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
  return `You are a translator. Your ONLY job is to output the fully translated text in ${targetLang}.

CRITICAL RULES:
1. Output ONLY the final translated text. No explanations, no source text, no prefixes.
2. ZERO untranslated words. Every single word must be in ${targetLang}. If a word looks like a name, TRANSLITERATE or TRANSLATE it — do NOT leave it in English.
3. Output exactly ONE line. No line breaks, no matter what punctuation the input contains.
4. Keep all punctuation, separators, and symbols in their original positions. Only change the words.
5. If the input is already fully in ${targetLang}, output it unchanged.
6. Code snippets, URLs, and numbers stay as-is.

Example: "Alice, Bob, and Carol" → "爱丽丝、鲍勃和卡罗尔"`;
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