/**
 * API中间件配置
 */
require('dotenv').config();
const path = require('path');

// 解析允许的来源字符串为数组
function parseAllowedOrigins(originsStr) {
  if (!originsStr || originsStr === '*') {
    return '*'; // 通配符表示允许所有来源
  }
  
  // 分割并去除空格
  return originsStr.split(',')
    .map(origin => origin.trim())
    .filter(origin => origin.length > 0);
}

// 从环境变量中读取配置或使用默认值
const config = {
  // 服务器配置
  PORT: process.env.PORT || 3000,
  
  // 真正的后端API地址
  BACKEND_API_URL: process.env.BACKEND_API_URL,
  
  // API前缀
  API_PREFIX: process.env.API_PREFIX || '/api/v1',
  
  // CORS配置
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  
  // 允许访问的前端地址列表（用于请求拦截）
  // 使用 * 表示允许所有来源
  ALLOWED_ORIGINS: parseAllowedOrigins(process.env.ALLOWED_ORIGINS || '*'),
  
  // 请求超时时间（毫秒）
  REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT || '30000'),
  
  // 是否启用请求日志
  ENABLE_LOGGING: process.env.ENABLE_LOGGING !== 'false', // 默认开启，只有明确设置为false才禁用
  
  // 是否启用控制台调试信息(server.js中的日志不受影响)
  DEBUG_MODE: process.env.DEBUG_MODE !== 'false', // 默认开启，只有明确设置为false才禁用
  
  // APP 自定义接口路径（以 / 开头），最终访问路径 = API_PREFIX + APP_ENDPOINT
  // 例如 APP_ENDPOINT=/ezapp, API_PREFIX=/api/v1 则完整接口为 /api/v1/ezapp
  APP_ENDPOINT: process.env.APP_ENDPOINT || '/ezapp',
  
  // APP 接口缓存时长（秒），默认 86400 = 1 天
  APP_CACHE_SECONDS: parseInt(process.env.APP_CACHE_SECONDS || '86400', 10),
  
  // APP 配置文件路径（默认为项目根目录下 app_config.json）
  APP_CONFIG_FILE: process.env.APP_CONFIG_FILE || path.join(__dirname, 'app_config.json'),
  
  // 无需 Referer/Origin 的支付回调路径（用逗号分隔）
  // 必须填写完整路径，包含前缀
  // 如：/api/v1/guest/payment/notify/EPay/ABC123
  ALLOWED_PAYMENT_NOTIFY_PATHS: (process.env.ALLOWED_PAYMENT_NOTIFY_PATHS || '').split(',').map(path => path.trim()).filter(path => path)
};

// 确保后端API URL没有尾部斜杠，以避免路径连接问题
if (config.BACKEND_API_URL && config.BACKEND_API_URL.endsWith('/')) {
  config.BACKEND_API_URL = config.BACKEND_API_URL.slice(0, -1);
  if (config.DEBUG_MODE) {
    console.log(`已修正后端API URL: ${config.BACKEND_API_URL}`);
  }
}

// 路径映射配置 - 与前端pathMapper.js保持一致
const pathMappings = {
  // 通用接口
  '/g/conf': '/guest/comm/config',
  '/c/conf': '/user/comm/config',

  // 认证相关
  '/auth/login': '/passport/auth/login',
  '/auth/reg': '/passport/auth/register',
  '/auth/forget': '/passport/auth/forget',
  '/auth/token2Login': '/passport/auth/token2Login',
  '/mail/verify': '/passport/comm/sendEmailVerify',
  '/auth/check': '/user/checkLogin',

  // 用户信息
  '/u/info': '/user/info',
  '/u/pwd': '/user/changePassword',
  '/u/reset': '/user/resetSecurity',
  '/u/update': '/user/update',
  '/u/gift': '/user/redeemgiftcard',
  '/u/session': '/user/getActiveSession',

  // 订阅相关
  '/sub/get': '/user/getSubscribe',
  '/stat/get': '/user/getStat',
  '/traffic/log': '/user/stat/getTrafficLog',

  // 商店相关
  '/plan/list': '/user/plan/fetch',
  '/coup/check': '/user/coupon/check',
  '/order/new': '/user/order/save',
  '/order/list': '/user/order/fetch',
  '/order/detail': '/user/order/detail',
  '/order/cancel': '/user/order/cancel',
  '/order/pay': '/user/order/checkout',
  '/order/check': '/user/order/check',
  '/pay/methods': '/user/order/getPaymentMethod',

  // 服务器节点
  '/node/list': '/user/server/fetch',

  // 工单系统
  '/ticket/list': '/user/ticket/fetch',
  '/ticket/new': '/user/ticket/save',
  '/ticket/reply': '/user/ticket/reply',
  '/ticket/close': '/user/ticket/close',
  '/withdraw': '/user/ticket/withdraw',

  // 邀请系统
  '/inv/info': '/user/invite/fetch',
  '/inv/new': '/user/invite/save',
  '/inv/detail': '/user/invite/details',
  '/comm/transfer': '/user/transfer',

  // 公告系统
  '/notice/list': '/user/notice/fetch',
  
  // 知识库
  '/knowledge/list': '/user/knowledge/fetch',

  // 支付系统
  '/explain/auth/check': '/explain/auth/check',
  '/explain/order/check': '/explain/order/check',
  '/explain/guest/payment/notify': '/explain/guest/payment/notify'
};

/**
 * 路径映射函数 - 将简化路径转换为实际后端路径
 * @param {string} simplePath - 简化路径
 * @returns {string} - 实际后端路径
 */
const mapPath = (simplePath) => {
  try {
    // 确保路径以斜杠开头
    let path = simplePath;
    if (!path.startsWith('/')) {
      path = '/' + path;
    }
    
    // 处理带查询参数的路径
    const [pathPart, query] = path.split('?');
    
    // 特殊处理/explain开头的路径 - 直接保留完整路径
    if (pathPart.startsWith('/explain/')) {
      return query ? `${pathPart}?${query}` : pathPart;
    }
    
    // 检查是否有精确匹配
    if (pathMappings[pathPart]) {
      const mappedPath = pathMappings[pathPart];
      return query ? `${mappedPath}?${query}` : mappedPath;
    }
    
    // 尝试查找最佳前缀匹配
    let bestMatch = '';
    let mappedPath = '';
    
    Object.keys(pathMappings).forEach(prefix => {
      if (pathPart.startsWith(prefix) && prefix.length > bestMatch.length) {
        bestMatch = prefix;
        mappedPath = pathMappings[prefix];
      }
    });
    
    if (bestMatch) {
      // 替换前缀，保留路径其余部分
      const remainingPath = pathPart.substring(bestMatch.length);
      const newPath = mappedPath + remainingPath;
      return query ? `${newPath}?${query}` : newPath;
    }
    
    // 如果没有匹配，返回原始路径
    return path;
  } catch (error) {
    console.error('路径映射错误:', error);
    return simplePath; // 出错时返回原始路径
  }
};

module.exports = {
  config,
  pathMappings,
  mapPath
}; 