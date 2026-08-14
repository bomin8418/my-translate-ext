/**
 * 轻量级日志工具
 *
 * 提供带统一前缀和级别控制的日志输出，替代散落各处的 console.* 调用。
 *
 * 用法：
 *   import { createLogger } from '@/lib/logger';
 *   const logger = createLogger('翻译扩展');
 *   logger.info('Content Script 已初始化');
 *   logger.error('加载失败:', err);
 *
 * 级别控制：
 *   开发模式默认级别为 'info'；生产/发布构建默认级别为 'silent'。
 *   可在控制台或代码中通过 setLogLevel 动态调整，
 *   例如排查问题时设置为 'debug' 以输出更详细的信息：
 *   import { setLogLevel } from '@/lib/logger';
 *   setLogLevel('debug');
 */

/** 日志级别 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** 各级别的优先级（数值越小越详细） */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** 当前全局日志级别 */
let currentLevel: LogLevel = import.meta.env.PROD ? 'silent' : 'info';

/**
 * 设置全局日志级别
 * @param level 目标级别
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** 获取当前日志级别 */
export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Logger 实例接口 */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * 创建带统一前缀的 Logger 实例
 * @param tag 模块标签，会以 [tag] 形式作为日志前缀
 */
export function createLogger(tag: string): Logger {
  const prefix = `[${tag}]`;

  return {
    debug(...args: unknown[]): void {
      if (LEVEL_PRIORITY[currentLevel] <= LEVEL_PRIORITY.debug) {
        // eslint-disable-next-line no-console
        console.debug(prefix, ...args);
      }
    },
    info(...args: unknown[]): void {
      if (LEVEL_PRIORITY[currentLevel] <= LEVEL_PRIORITY.info) {
        // eslint-disable-next-line no-console
        console.log(prefix, ...args);
      }
    },
    warn(...args: unknown[]): void {
      if (LEVEL_PRIORITY[currentLevel] <= LEVEL_PRIORITY.warn) {
        // eslint-disable-next-line no-console
        console.warn(prefix, ...args);
      }
    },
    error(...args: unknown[]): void {
      if (LEVEL_PRIORITY[currentLevel] <= LEVEL_PRIORITY.error) {
        // eslint-disable-next-line no-console
        console.error(prefix, ...args);
      }
    },
  };
}
