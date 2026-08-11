import { defineConfig } from 'wxt';

// 翻译扩展的 WXT 配置文件
// 详见: https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],

  // Manifest 权限声明
  manifest: {
    name: '个人专属翻译助手',
    description: '基于 LLM 的个人网页翻译扩展（英译中），支持划词翻译和全文双语显示',
    version: '1.0.0',

    // 必需的权限
    permissions: [
      'storage',          // 用于保存 API 配置
      'activeTab',        // 访问当前活跃标签页
      'scripting',        // 动态注入脚本
      'webNavigation',    // 监听页面导航（用于 PDF 拦截）
    ],

    // 主机权限：允许在所有网页上运行
    host_permissions: ['<all_urls>'],

    // Web 可访问资源：PDF 查看器页面
    web_accessible_resources: [
      {
        resources: ['pdf-viewer.html'],
        matches: ['<all_urls>'],
      },
    ],

    // 工具栏图标：点击直接打开完整设置页（新标签页）
    action: {
      default_title: '个人专属翻译助手 - 设置',
      default_icon: {
        '16': 'icon/16.png',
        '32': 'icon/32.png',
        '48': 'icon/48.png',
        '96': 'icon/96.png',
        '128': 'icon/128.png',
      },
    },

    // 设置页在完整浏览器标签页中打开（而非受限宽度的嵌入式选项页）
    options_ui: {
      open_in_tab: true,
    },
  },
});
