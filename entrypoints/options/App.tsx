/**
 * Options 设置页主组件
 *
 * 提供 LLM API 配置的表单界面，支持：
 * - 选择 LLM 提供商（含预设的 Base URL 和模型列表）
 * - 自定义 API Base URL 和模型名称
 * - 安全输入 API Key（密码框类型）
 * - 保存/加载配置到 chrome.storage.local
 * - 配置验证和错误提示
 */

import React, { useState, useEffect, useCallback } from 'react';
import type { Settings } from '../../types';
import { DEFAULT_SETTINGS } from '../../types';
import { getSettings, saveSettings } from '../../lib/storage';

// ==================== 预设的 LLM 提供商配置 ====================
// 用户可以直接选择预设提供商，也可以手动输入自定义配置
const PROVIDER_PRESETS: Record<string, { baseUrl: string; models: string[] }> = {
  'OpenAI': {
    baseUrl: 'https://api.openai.com',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'],
  },
  'DeepSeek': {
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  '通义千问 (Qwen)': {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    models: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
  },
  '智谱 (GLM)': {
    baseUrl: 'https://open.bigmodel.cn/api/paas',
    models: ['glm-4-flash', 'glm-4', 'glm-4-plus'],
  },
  'Moonshot': {
    baseUrl: 'https://api.moonshot.cn',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  },
  '自定义': {
    baseUrl: '',
    models: [],
  },
};

/** 状态消息类型 */
interface StatusMessage {
  type: 'success' | 'error' | 'info';
  text: string;
}

const Options: React.FC = () => {
  // ==================== 表单状态 ====================
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [selectedProvider, setSelectedProvider] = useState<string>('OpenAI');
  const [isCustomProvider, setIsCustomProvider] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  // ==================== 初始化：从存储加载设置 ====================
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    try {
      const saved = await getSettings();
      setSettings(saved);

      // 判断当前配置匹配哪个预设提供商
      const matched = Object.entries(PROVIDER_PRESETS).find(
        ([, preset]) => preset.baseUrl === saved.apiBaseUrl
      );
      if (matched && matched[0] !== '自定义') {
        setSelectedProvider(matched[0]);
        setIsCustomProvider(false);
      } else {
        setSelectedProvider('自定义');
        setIsCustomProvider(true);
      }
    } catch (error) {
      showStatus('error', '加载设置失败，请刷新页面重试');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ==================== 状态提示工具 ====================
  const showStatus = useCallback((type: StatusMessage['type'], text: string) => {
    setStatus({ type, text });
    // 3 秒后自动清除提示
    setTimeout(() => setStatus(null), 3000);
  }, []);

  // ==================== 提供商选择变更 ====================
  const handleProviderChange = useCallback(
    (provider: string) => {
      setSelectedProvider(provider);

      if (provider === '自定义') {
        setIsCustomProvider(true);
      } else {
        setIsCustomProvider(false);
        const preset = PROVIDER_PRESETS[provider];
        if (preset) {
          setSettings((prev) => ({
            ...prev,
            provider,
            apiBaseUrl: preset.baseUrl,
            modelName: preset.models[0] || prev.modelName,
          }));
        }
      }
    },
    []
  );

  // ==================== 表单字段变更 ====================
  const handleFieldChange = useCallback(
    (field: keyof Settings) =>
      (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        setSettings((prev) => ({ ...prev, [field]: e.target.value }));
      },
    []
  );

  // ==================== 保存设置 ====================
  const handleSave = useCallback(async () => {
    // 表单验证
    if (!settings.apiBaseUrl.trim()) {
      showStatus('error', '请输入 API Base URL');
      return;
    }
    if (!settings.apiKey.trim()) {
      showStatus('error', '请输入 API Key');
      return;
    }
    if (!settings.modelName.trim()) {
      showStatus('error', '请输入模型名称');
      return;
    }

    setIsSaving(true);
    try {
      await saveSettings(settings);
      showStatus('success', '设置已保存成功！');
    } catch (error) {
      showStatus('error', '保存失败，请重试');
    } finally {
      setIsSaving(false);
    }
  }, [settings, showStatus]);

  // ==================== 加载状态 ====================
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex items-center gap-2 text-gray-500">
          <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12" cy="12" r="10"
              stroke="currentColor" strokeWidth="4" fill="none"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
          加载中...
        </div>
      </div>
    );
  }

  // ==================== 主界面 ====================
  return (
    <div className="min-h-screen py-8 px-4">
      <div className="max-w-2xl mx-auto">
        {/* 页面标题 */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-800">
            🌐 翻译助手设置
          </h1>
          <p className="text-gray-500 mt-2">
            配置您的 LLM API 以启用智能翻译
          </p>
        </div>

        {/* 设置表单卡片 */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 space-y-6">
          {/* 1. LLM 提供商选择 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              LLM 提供商
            </label>
            <select
              value={selectedProvider}
              onChange={(e) => handleProviderChange(e.target.value)}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg
                         focus:ring-2 focus:ring-blue-500 focus:border-blue-500
                         text-gray-700 bg-white transition-colors"
            >
              {Object.keys(PROVIDER_PRESETS).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {selectedProvider !== '自定义' && (
              <p className="text-xs text-gray-400 mt-1">
                将自动填充 Base URL 和推荐模型
              </p>
            )}
          </div>

          {/* 2. API Base URL */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              API Base URL
            </label>
            <input
              type="url"
              value={settings.apiBaseUrl}
              onChange={handleFieldChange('apiBaseUrl')}
              placeholder="https://api.openai.com"
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg
                         focus:ring-2 focus:ring-blue-500 focus:border-blue-500
                         text-gray-700 placeholder-gray-400 transition-colors"
            />
            <p className="text-xs text-gray-400 mt-1">
              兼容 OpenAI 格式的 API 端点地址
            </p>
          </div>

          {/* 3. API Key */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              API Key
            </label>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={settings.apiKey}
                onChange={handleFieldChange('apiKey')}
                placeholder="sk-..."
                className="w-full px-4 py-2.5 pr-12 border border-gray-300 rounded-lg
                           focus:ring-2 focus:ring-blue-500 focus:border-blue-500
                           text-gray-700 placeholder-gray-400 transition-colors
                           font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2
                           text-gray-400 hover:text-gray-600 transition-colors"
                title={showApiKey ? '隐藏' : '显示'}
              >
                {showApiKey ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              您的 API Key 仅保存在本地浏览器中，不会上传到任何服务器
            </p>
          </div>

          {/* 4. 模型名称 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              模型名称
            </label>
            {(() => {
              // 提取预设到局部变量，便于 TypeScript 收窄类型
              // 避免重复索引访问导致的 "对象可能为未定义" 错误
              const presetModels =
                !isCustomProvider
                  ? PROVIDER_PRESETS[selectedProvider]?.models ?? []
                  : [];

              return !isCustomProvider && presetModels.length > 0 ? (
                // 预设模型列表
                <div className="space-y-2">
                  <select
                    value={settings.modelName}
                    onChange={handleFieldChange('modelName')}
                    className="w-full px-4 py-2.5 border border-gray-300 rounded-lg
                               focus:ring-2 focus:ring-blue-500 focus:border-blue-500
                               text-gray-700 bg-white transition-colors"
                  >
                    {presetModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                  {/* 允许手动输入其他模型 */}
                  <input
                    type="text"
                    value={settings.modelName}
                    onChange={handleFieldChange('modelName')}
                    placeholder="或输入自定义模型名称..."
                    className="w-full px-4 py-2.5 border border-gray-200 rounded-lg
                               focus:ring-2 focus:ring-blue-500 focus:border-blue-500
                               text-gray-600 placeholder-gray-400 text-sm transition-colors"
                  />
                </div>
              ) : (
                <input
                  type="text"
                  value={settings.modelName}
                  onChange={handleFieldChange('modelName')}
                  placeholder="例如：gpt-4o-mini"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg
                             focus:ring-2 focus:ring-blue-500 focus:border-blue-500
                             text-gray-700 placeholder-gray-400 transition-colors"
                />
              );
            })()}
          </div>

          {/* 5. 目标语言 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              目标语言
            </label>
            <select
              value={settings.targetLang}
              onChange={handleFieldChange('targetLang')}
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg
                         focus:ring-2 focus:ring-blue-500 focus:border-blue-500
                         text-gray-700 bg-white transition-colors"
            >
              <option value="Chinese">中文</option>
              <option value="Japanese">日文</option>
              <option value="Korean">韩文</option>
              <option value="French">法文</option>
              <option value="German">德文</option>
              <option value="Spanish">西班牙文</option>
            </select>
          </div>

          {/* 保存按钮 */}
          <div className="pt-2">
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="w-full py-3 px-6 bg-blue-600 hover:bg-blue-700
                         disabled:bg-blue-400 disabled:cursor-not-allowed
                         text-white font-medium rounded-lg
                         transition-colors focus:outline-none focus:ring-2
                         focus:ring-blue-500 focus:ring-offset-2"
            >
              {isSaving ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle
                      className="opacity-25"
                      cx="12" cy="12" r="10"
                      stroke="currentColor" strokeWidth="4" fill="none"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  保存中...
                </span>
              ) : (
                '💾 保存设置'
              )}
            </button>
          </div>

          {/* 状态提示 */}
          {status && (
            <div
              className={`p-4 rounded-lg text-sm font-medium animate-fade-in ${
                status.type === 'success'
                  ? 'bg-green-50 text-green-700 border border-green-200'
                  : status.type === 'error'
                  ? 'bg-red-50 text-red-700 border border-red-200'
                  : 'bg-blue-50 text-blue-700 border border-blue-200'
              }`}
            >
              {status.type === 'success' && '✅ '}
              {status.type === 'error' && '❌ '}
              {status.type === 'info' && 'ℹ️ '}
              {status.text}
            </div>
          )}
        </div>

        {/* 使用说明 */}
        <div className="mt-6 bg-white rounded-2xl shadow-sm border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-800 mb-3">
            📖 使用说明
          </h2>
          <ul className="space-y-2 text-sm text-gray-600">
            <li className="flex gap-2">
              <span className="text-blue-500">1.</span>
              填写 API Key 和 Base URL 后点击"保存设置"
            </li>
            <li className="flex gap-2">
              <span className="text-blue-500">2.</span>
              打开任意网页，点击右下角悬浮按钮开启翻译
            </li>
            <li className="flex gap-2">
              <span className="text-blue-500">3.</span>
              <strong>划词模式：</strong>
              选中文本后自动弹出翻译气泡
            </li>
            <li className="flex gap-2">
              <span className="text-blue-500">4.</span>
              <strong>全文模式：</strong>
              自动翻译页面所有英文内容，双语对照显示
            </li>
            <li className="flex gap-2">
              <span className="text-blue-500">5.</span>
              PDF 文件会自动使用扩展内置查看器，支持全文翻译
            </li>
          </ul>
        </div>

        {/* PDF 翻译说明 */}
        <div className="mt-6 bg-amber-50 rounded-2xl border border-amber-200 p-6">
          <h2 className="text-lg font-semibold text-amber-800 mb-3">
            📄 PDF 翻译说明
          </h2>
          <p className="text-sm text-amber-700 leading-relaxed">
            本扩展已注册为 PDF 处理程序（Chrome 151+）。直接打开本地 PDF（
            <code className="bg-amber-100 px-1 rounded">file://</code>
            开头，例如双击打开的 PDF）或在线 PDF，会自动进入扩展内置查看器并自动翻译，无需开启「允许访问文件网址」。
          </p>
          <ul className="mt-2 space-y-1 text-sm text-amber-700 list-disc list-inside">
            <li>首次打开 PDF 时若 Chrome 弹出选择方式，请选择「个人专属翻译助手」</li>
            <li>若仍显示 Chrome 内置查看器，请重新加载扩展后再打开 PDF</li>
            <li>Chrome 151 以下版本：需在 <code className="bg-amber-100 px-1 rounded">chrome://extensions</code> 开启「允许访问文件网址」</li>
          </ul>
          <p className="mt-3 text-xs text-amber-600">
            打开 PDF 后若无反应，可右键查看器页面选择「检查」，在 Console 查看日志。
          </p>
        </div>
      </div>
    </div>
  );
};

export default Options;
