/**
 * chrome.storage.local 读写工具
 * 封装了对扩展本地存储的异步操作，提供类型安全的读写接口
 */

import type { Settings } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { createLogger } from './logger';

const logger = createLogger('存储');

const STORAGE_KEY = 'translate_settings';

/**
 * 从 chrome.storage.local 读取用户设置
 * 如果没有保存过设置，则返回默认值
 */
export async function getSettings(): Promise<Settings> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    if (result[STORAGE_KEY]) {
      // 合并默认值，确保新字段有默认值
      const settings = { ...DEFAULT_SETTINGS, ...result[STORAGE_KEY] } as Settings;
      logger.info('读取设置成功', {
        provider: settings.provider,
        apiBaseUrl: settings.apiBaseUrl,
        modelName: settings.modelName,
      });
      return settings;
    }
    logger.info('未读到已保存设置，返回默认值');
    return { ...DEFAULT_SETTINGS };
  } catch (error) {
    logger.error('读取设置失败:', error);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 保存用户设置到 chrome.storage.local
 */
export async function saveSettings(settings: Settings): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
    logger.info('保存设置成功', {
      provider: settings.provider,
      apiBaseUrl: settings.apiBaseUrl,
      modelName: settings.modelName,
    });
  } catch (error) {
    logger.error('保存设置失败:', error);
    throw error;
  }
}

/**
 * 监听存储变化（用于设置页实时同步）
 * @param callback 当设置发生变化时调用的回调函数
 */
export function onSettingsChanged(
  callback: (settings: Settings) => void
): () => void {
  const listener = (
    changes: { [key: string]: chrome.storage.StorageChange },
    areaName: string
  ) => {
    if (areaName === 'local' && changes[STORAGE_KEY]) {
      // newValue 类型为 unknown（@types/chrome 的 StorageChange 定义），
      // 写入时存入的是 Settings，断言为 Partial<Settings> 以便与默认值合并
      const newValue = changes[STORAGE_KEY].newValue as Partial<Settings> | undefined;
      const newSettings: Settings = {
        ...DEFAULT_SETTINGS,
        ...newValue,
      };
      logger.info('存储变更已同步', {
        provider: newSettings.provider,
        apiBaseUrl: newSettings.apiBaseUrl,
        modelName: newSettings.modelName,
      });
      callback(newSettings);
    } else {
      logger.debug('忽略存储变更', {
        areaName,
        hasKey: Boolean(changes[STORAGE_KEY]),
      });
    }
  };

  chrome.storage.onChanged.addListener(listener);

  // 返回取消监听的函数
  return () => {
    chrome.storage.onChanged.removeListener(listener);
  };
}