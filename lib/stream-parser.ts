/**
 * SSE (Server-Sent Events) 流式数据解析器
 *
 * 解析 OpenAI 兼容的流式 API 响应。
 * 数据格式为 SSE 标准格式：
 *   data: {"id":"...","choices":[{"delta":{"content":"Hello"}}]}
 *   data: {"id":"...","choices":[{"delta":{"content":" World"}}]}
 *   data: [DONE]
 *
 * 每行以 "data: " 开头，空行表示事件结束。
 * 当收到 "data: [DONE]" 时表示流结束。
 */

import type { StreamChunk } from '../types';
import { createLogger } from './logger';

const logger = createLogger('SSE 解析器');

/**
 * 解析一行 SSE 数据
 * @param line SSE 格式的一行文本（如 `data: {"id":"..."}`）
 * @returns 解析后的 StreamChunk 或 null（空行、注释行、[DONE] 标记）
 */
export function parseSSELine(line: string): StreamChunk | '[DONE]' | null {
  // 跳过空行和注释行
  if (!line || line.startsWith(':')) {
    return null;
  }

  // SSE 事件行格式为 "data: <json>"
  if (line.startsWith('data: ')) {
    const data = line.slice(6).trim();

    // 流结束标记
    if (data === '[DONE]') {
      return '[DONE]';
    }

    // 尝试解析 JSON
    try {
      return JSON.parse(data) as StreamChunk;
    } catch {
      // JSON 解析失败，跳过此行
      logger.warn('SSE 数据解析失败:', data.slice(0, 100));
      return null;
    }
  }

  return null;
}

/**
 * 从 ReadableStream 中读取并解析 SSE 事件流
 * 这是一个异步生成器，逐个产出翻译文本增量
 *
 * @param stream fetch 响应体的 ReadableStream
 * @param abortSignal 用于取消读取的中止信号
 * @returns 异步生成器，每次产出翻译文本增量
 *
 * 使用示例：
 *   for await (const chunk of parseSSEStream(response.body, signal)) {
 *     console.log(chunk); // "Hello", " World", ...
 *   }
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array> | null,
  abortSignal?: AbortSignal
): AsyncGenerator<string, void, undefined> {
  if (!stream) {
    throw new Error('响应体为空，无法读取流式数据');
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  // 缓冲区：处理跨 chunk 的不完整 SSE 行
  let buffer = '';

  try {
    while (true) {
      // 检查是否被取消
      if (abortSignal?.aborted) {
        reader.cancel();
        return;
      }

      const { done, value } = await reader.read();
      if (done) break;

      // 将二进制数据解码为文本，追加到缓冲区
      buffer += decoder.decode(value, { stream: true });

      // 按行分割处理
      const lines = buffer.split('\n');
      // 最后一行可能不完整，保留在缓冲区中
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmedLine = line.trimEnd();

        // 解析 SSE 行
        const result = parseSSELine(trimmedLine);

        if (result === '[DONE]') {
          // 流结束
          return;
        }

        if (result && result.choices) {
          // 从 choices[0].delta.content 中提取翻译文本增量
          for (const choice of result.choices) {
            const content = choice.delta?.content;
            if (content) {
              yield content;
            }
          }
        }
      }
    }

    // 处理缓冲区中剩余的数据
    if (buffer.trim()) {
      const result = parseSSELine(buffer.trimEnd());
      if (result && result !== '[DONE]' && result.choices) {
        for (const choice of result.choices) {
          const content = choice.delta?.content;
          if (content) {
            yield content;
          }
        }
      }
    }
  } finally {
    // 确保 reader 被释放
    reader.releaseLock();
  }
}
