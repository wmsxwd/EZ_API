/**
 * API路由处理
 */
const express = require('express');
const axios = require('axios');
const { config, mapPath } = require('./config');
const { LRUCache } = require('lru-cache');
const querystring = require('querystring');

// 创建一个日志工具，会根据配置决定是否输出
const logger = {
  // 调试日志 - 受DEBUG_MODE控制
  log: (...args) => {
    if (config.DEBUG_MODE) {
      console.log(...args);
    }
  },
  warn: (...args) => {
    if (config.DEBUG_MODE) {
      console.warn(...args);
    }
  },
  error: (...args) => {
    // 错误总是输出，除非明确关闭
    if (config.DEBUG_MODE) {
      console.error(...args);
    }
  },
  info: (...args) => {
    if (config.DEBUG_MODE) {
      console.info(...args);
    }
  },
  // 请求日志 - 受ENABLE_LOGGING控制
  request: (...args) => {
    if (config.ENABLE_LOGGING) {
      console.log(...args);
    }
  }
};

// 创建全局axios实例，启用keepAlive提高连接复用效率
const api = axios.create({
  timeout: config.REQUEST_TIMEOUT,
  httpAgent: new require('http').Agent({ keepAlive: true, maxSockets: 100 }),
  httpsAgent: new require('https').Agent({ keepAlive: true, maxSockets: 100 }),
  maxRedirects: 5
});

// 缓存系统，使用LRU算法
const apiCache = new LRUCache({
  max: 500, // 最多缓存500个响应
  ttl: 0, // 禁用缓存，设置为0 (原本是5分钟)
  updateAgeOnGet: true, // 访问时更新缓存时间
});

// 请求合并系统 - 追踪进行中的请求以合并相同请求
const pendingRequests = new Map();

const router = express.Router();

/**
 * 检查请求来源是否被允许
 * @param {string} origin - 请求来源
 * @returns {boolean} - 是否允许该来源
 */
function isOriginAllowed(origin) {
  // 如果未配置来源限制或允许所有来源，返回true
  if (!origin || !config.ALLOWED_ORIGINS) {
    return true;
  }

  // 如果ALLOWED_ORIGINS为'*'，允许所有来源
  if (config.ALLOWED_ORIGINS === '*') {
    return true;
  }

  // 检查来源是否在允许列表中
  return config.ALLOWED_ORIGINS.some(allowedOrigin => {
    // 支持通配符匹配，如 *.example.com
    if (allowedOrigin.includes('*')) {
      const pattern = new RegExp('^' + allowedOrigin.replace(/\*/g, '.*') + '$');
      return pattern.test(origin);
    }
    return origin === allowedOrigin;
  });
}

/**
 * 检查是否是xiao面板或xboard面板
 * @param {Object} headers - 请求头
 * @returns {boolean} - 是否是xiao/xboard面板
 */
function isXiaoOrXboardPanel(headers) {
  // 根据请求头特征判断是否为xiao/xboard面板
  const contentType = headers['content-type'] || '';
  
  // 检查内容类型是否为表单
  const isFormEncoded = contentType.includes('application/x-www-form-urlencoded');
  
  // 检查是否有特定的头部标识
  const hasXboardSignature = headers['x-requested-with'] === 'XMLHttpRequest' && isFormEncoded;
  
  // 也可以根据API路径特征判断
  return isFormEncoded || hasXboardSignature;
}

/**
 * 检查是否是直接访问API（没有来自合法前端的Referer）
 * @param {Object} req - Express请求对象
 * @returns {boolean} - 是否是直接访问
 */
function isDirectApiAccess(req) {
  // 静态资源文件请求允许直接访问
  const resourceExtensions = ['.js', '.css', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot'];
  const path = req.path.toLowerCase();
  
  // 检查是否是静态资源文件请求
  if (resourceExtensions.some(ext => path.endsWith(ext))) {
    return false; // 允许直接访问静态资源
  }
  
  // 支付回调接口路径检查 - 只有支付通知接口可无需referer/origin
  if (path.includes('/explain/guest/payment/notify') || 
      path.includes('/guest/payment/notify')) {
    logger.log(`支付回调接口访问已放行: ${path}`);
    return false; // 支付通知API无需referer校验
  }
  
  // 检查是否是配置的支付回调接口，使用精确匹配
  if (config.ALLOWED_PAYMENT_NOTIFY_PATHS && config.ALLOWED_PAYMENT_NOTIFY_PATHS.length > 0) {
    // 检查请求路径是否在允许的支付回调路径列表中（不区分大小写）
    const pathLowerCase = path.toLowerCase();
    for (const allowedPath of config.ALLOWED_PAYMENT_NOTIFY_PATHS) {
      if (pathLowerCase === allowedPath.toLowerCase()) {
        logger.log(`支付回调接口访问已放行: ${path}`);
        return false; // 是允许的支付回调路径，放行
      }
    }
  }
  
  const referer = req.headers.referer;
  const origin = req.headers.origin;
  
  // OPTIONS预检请求允许直接访问
  if (req.method === 'OPTIONS') {
    return false;
  }
  
  // 如果没有referer和origin，可能是直接访问或使用工具访问
  if (!referer && !origin) {
    return true;
  }
  
  // 检查referer或origin是否来自允许的前端
  const allowedFrontends = Array.isArray(config.ALLOWED_ORIGINS) 
    ? config.ALLOWED_ORIGINS 
    : (config.ALLOWED_ORIGINS === '*' ? [] : [config.ALLOWED_ORIGINS]);
  
  // 如果配置为允许所有来源，则检查是否有referer或origin
  if (config.ALLOWED_ORIGINS === '*') {
    return false; // 有referer或origin就允许
  }
  
  // 检查referer是否匹配允许的前端
  if (referer) {
    const refererUrl = new URL(referer);
    const refererOrigin = refererUrl.origin;
    
    return !allowedFrontends.some(frontend => {
      if (frontend.includes('*')) {
        const pattern = new RegExp('^' + frontend.replace(/\*/g, '.*') + '$');
        return pattern.test(refererOrigin);
      }
      return refererOrigin === frontend;
    });
  }
  
  // 如果没有referer，使用origin检查
  return !isOriginAllowed(origin);
}

/**
 * 获取缓存键
 * @param {string} method - 请求方法
 * @param {string} url - 请求URL
 * @param {object} data - 请求数据
 * @param {object} headers - 请求头，用于区分不同用户
 * @returns {string} - 缓存键
 */
function getCacheKey(method, url, data, headers) {
  // 提取用户标识符，如Authorization令牌
  let userIdentifier = '';
  if (headers && headers.authorization) {
    userIdentifier = headers.authorization;
  }
  
  // 将用户标识符添加到缓存键中，确保不同用户不共享缓存
  const dataString = data ? JSON.stringify(data) : '';
  return `${method}:${url}:${dataString}:${userIdentifier}`;
}

/**
 * 判断请求是否可以缓存
 * @param {string} method - 请求方法
 * @param {string} path - 请求路径
 * @returns {boolean} - 是否可以缓存
 */
function isCacheable(method, path) {
  // 禁用所有API缓存
  return false;
}

/**
 * 中间件：检查请求来源是否被允许
 */
router.use((req, res, next) => {
  const origin = req.headers.origin;
  const path = req.path.toLowerCase();
  
  // 支付回调接口路径检查 - 只有支付通知接口可无需referer/origin
  if (path.includes('/explain/guest/payment/notify') || 
      path.includes('/guest/payment/notify')) {
    logger.log(`支付回调接口访问已放行 (中间件): ${path}`);
    return next(); // 支付通知API无需来源校验
  }
  
  // 检查是否是配置的支付回调接口，使用精确匹配
  if (config.ALLOWED_PAYMENT_NOTIFY_PATHS && config.ALLOWED_PAYMENT_NOTIFY_PATHS.length > 0) {
    // 检查请求路径是否在允许的支付回调路径列表中（不区分大小写）
    const pathLowerCase = path.toLowerCase();
    for (const allowedPath of config.ALLOWED_PAYMENT_NOTIFY_PATHS) {
      if (pathLowerCase === allowedPath.toLowerCase()) {
        logger.log(`支付回调接口访问已放行 (中间件): ${path}`);
        return next(); // 是允许的支付回调路径，放行
      }
    }
  }
  
  // 检查请求来源是否被允许
  if (!isOriginAllowed(origin)) {
    logger.warn(`拒绝来自未授权来源的请求: ${origin}`);
    
    // 设置CORS头，但仍然会拒绝非法来源
    setCorsHeaders(res);
    
    // 返回403禁止访问错误
    return res.status(403).json({
      error: true,
      message: '未授权的访问来源',
      detail: '当前来源未被授权访问此API服务'
    });
  }
  
  // 检查是否是直接访问API（无合法Referer/Origin）
  if (isDirectApiAccess(req)) {
    logger.warn(`拒绝直接访问API: ${req.method} ${req.path} - Referer: ${req.headers.referer}, Origin: ${origin}`);
    
    // 设置CORS头
    setCorsHeaders(res);
    
    // 返回403禁止访问错误
    return res.status(403).json({
      error: true,
      message: '禁止访问',
      detail: '非法请求禁止访问'
    });
  }
  
  // 来源验证通过，继续下一步处理
  next();
});

/**
 * 通用API代理处理函数
 * 接收所有请求，将路径映射到真实API，并转发请求
 */
router.all('*', async (req, res) => {
  // 记录请求信息和开始时间
  const startTime = Date.now();
  
  // 请求日志 - 由ENABLE_LOGGING控制
  logger.request(`收到请求: ${req.method} ${req.path}`);
  
  try {
    // 获取原始请求路径和方法
    const originalPath = req.path;
    const method = req.method.toLowerCase();
    
    // 映射路径到真实后端路径 - 调试信息由DEBUG_MODE控制
    const mappedPath = mapPath(originalPath);
    logger.log(`映射路径: ${originalPath} -> ${mappedPath}`);
    
    // 构建完整的后端URL
    const backendUrl = `${config.BACKEND_API_URL}${mappedPath}`;
    
    // 过滤请求头，移除可能导致问题的头
    const headers = { ...req.headers };
    
    // 删除一些特定的请求头，避免转发时冲突
    const headersToRemove = [
      'host', 'connection', 'content-length', 
      'accept-encoding', 'if-none-match', 'if-modified-since'
    ];
    
    headersToRemove.forEach(header => {
      delete headers[header];
    });
    
    // 保存并传递前端A的referer到后端C
    if (req.headers.referer) {
      headers['referer'] = req.headers.referer;
      // headers['x-forwarded-referer'] = req.headers.referer;
      // logger.log(`传递前端referer: ${req.headers.referer}`);
    }
    
    // 获取请求数据
    const reqData = method !== 'get' && method !== 'head' ? req.body : undefined;
    const reqParams = method === 'get' || method === 'head' ? req.query : undefined;
    
    // 检查Content-Type是否为表单URL编码
    const isFormEncoded = headers['content-type'] && 
                          headers['content-type'].includes('application/x-www-form-urlencoded');
    
    // 检查是否是xiao/xboard面板的请求
    const isXiaoOrXboard = isXiaoOrXboardPanel(headers);
    
    // 缓存键，用于检查是否已缓存或合并相同请求，包含用户信息以避免混用
    const cacheKey = getCacheKey(method, backendUrl, reqData || reqParams, headers);
    
    // 检查是否有可用缓存且请求允许缓存
    if (isCacheable(method, mappedPath) && apiCache.has(cacheKey)) {
      logger.log(`缓存命中: ${cacheKey}`);
      const cachedData = apiCache.get(cacheKey);
      
      // 设置必要的响应头
      setCorsHeaders(res);
      
      // 设置缓存控制头，防止304缓存问题
      setNoCacheHeaders(res);
      
      // 从缓存返回，总是使用200状态码
      res.status(200); // 强制返回200，避免304
      
      // 设置响应头，但移除可能导致304缓存的头部
      Object.keys(cachedData.headers).forEach(header => {
        if (!['content-length', 'connection', 'keep-alive', 'transfer-encoding', 'etag', 'last-modified'].includes(header.toLowerCase())) {
          res.set(header, cachedData.headers[header]);
        }
      });
      
      // 发送响应
      res.json(cachedData.data);
      
      // 请求日志 - 由ENABLE_LOGGING控制
      logger.request(`请求完成: ${method.toUpperCase()} ${req.path} ${Date.now() - startTime}ms [缓存]`);
      return;
    }
    
    // 检查是否有相同请求正在处理中
    if (pendingRequests.has(cacheKey)) {
      logger.log(`合并相同请求: ${cacheKey}`);
      try {
        // 等待已经在处理中的相同请求完成
        const pendingResponse = await pendingRequests.get(cacheKey);
        
        // 设置必要的响应头
        setCorsHeaders(res);
        
        // 设置缓存控制头，防止304缓存问题
        setNoCacheHeaders(res);
        
        // 使用第一个请求的结果但强制状态码为200
        res.status(200); // 强制返回200，避免304
        
        // 设置响应头
        Object.keys(pendingResponse.headers).forEach(header => {
          if (!['content-length', 'connection', 'keep-alive', 'transfer-encoding', 'etag', 'last-modified'].includes(header.toLowerCase())) {
            res.set(header, pendingResponse.headers[header]);
          }
        });
        
        res.json(pendingResponse.data);
        
        // 请求日志 - 由ENABLE_LOGGING控制
        logger.request(`请求完成: ${method.toUpperCase()} ${req.path} ${Date.now() - startTime}ms [合并]`);
        return;
      } catch (error) {
        // 如果合并的请求出错，继续执行新请求
        logger.log(`合并的请求出错，创建新请求: ${error.message}`);
      }
    }
    
    // 创建一个Promise来跟踪这个请求，供合并使用
    const responsePromise = (async () => {
      // 设置请求参数
      const axiosConfig = {
        method: method,
        url: backendUrl,
        headers: headers,
        params: reqParams,
        // 启用gzip, deflate压缩
        decompress: true,
        // 不自动转换JSON
        transformResponse: [(data) => data]
      };
      
      // 处理请求数据 - 针对表单URL编码和xiao/xboard面板做特殊处理
      if (reqData) {
        if (isFormEncoded || isXiaoOrXboard) {
          // 如果是表单URL编码或xiao/xboard面板请求，确保数据格式正确
          logger.log('检测到表单URL编码请求或xiao/xboard面板请求');
          
          // 确保Content-Type正确设置为表单格式
          axiosConfig.headers['Content-Type'] = 'application/x-www-form-urlencoded';
          
          // 转换数据格式 - 如果已经是URLSearchParams或字符串则保持不变
          if (reqData instanceof URLSearchParams) {
            axiosConfig.data = reqData;
          } else if (typeof reqData === 'string') {
            axiosConfig.data = reqData;
          } else if (typeof reqData === 'object') {
            // 将对象转换为表单数据
            axiosConfig.data = querystring.stringify(reqData);
          }
        } else {
          // 常规JSON请求
          axiosConfig.data = reqData;
        }
      }
      
      // 发送请求到后端
      const response = await api(axiosConfig);
      
      // 处理响应数据
      const result = {
        status: response.status,
        headers: response.headers,
        data: null
      };
      
      // 解析响应数据
      const contentType = response.headers['content-type'] || '';
      if (contentType.includes('application/json')) {
        try {
          // 将数据转换为字符串
          let jsonData;
          if (Buffer.isBuffer(response.data)) {
            jsonData = response.data.toString('utf8');
          } else if (typeof response.data === 'string') {
            jsonData = response.data;
          } else {
            jsonData = JSON.stringify(response.data);
          }
          
          // 解析JSON
          result.data = JSON.parse(jsonData);
        } catch (error) {
          logger.error('JSON解析错误:', error);
          // JSON解析失败，使用原始数据
          result.data = response.data;
        }
      } else {
        // 非JSON响应
        result.data = response.data;
      }
      
      // 如果请求可缓存，保存到缓存
      if (isCacheable(method, mappedPath)) {
        apiCache.set(cacheKey, result);
      }
      
      return result;
    })();
    
    // 保存到进行中的请求映射
    pendingRequests.set(cacheKey, responsePromise);
    
    try {
      // 等待响应
      const result = await responsePromise;
      
      // 设置CORS和响应头
      setCorsHeaders(res);
      
      // 设置缓存控制头，防止304缓存问题
      setNoCacheHeaders(res);
      
      // 设置响应状态码
      res.status(result.status);
      
      // 设置响应头，但移除可能导致304缓存的头部
      Object.keys(result.headers).forEach(header => {
        if (!['content-length', 'connection', 'keep-alive', 'transfer-encoding', 'etag', 'last-modified'].includes(header.toLowerCase())) {
          res.set(header, result.headers[header]);
        }
      });
      
      // 发送响应
      res.json(result.data);
      
      // 请求日志 - 由ENABLE_LOGGING控制
      logger.request(`请求完成: ${method.toUpperCase()} ${req.path} ${Date.now() - startTime}ms`);
    } finally {
      // 清理进行中的请求映射
      pendingRequests.delete(cacheKey);
    }
  } catch (error) {
    logger.error('API代理错误:', error);
    
    // 打印更详细的错误信息
    if (error.response) {
      logger.error(`响应错误状态: ${error.response.status}`);
      logger.error('响应头:', error.response.headers);
      
      // 尝试打印响应体
      try {
        if (Buffer.isBuffer(error.response.data)) {
          logger.error('响应体(Buffer):', error.response.data.toString('utf8'));
        } else if (typeof error.response.data === 'string') {
          logger.error('响应体(String):', error.response.data);
        } else {
          logger.error('响应体(其他):', error.response.data);
        }
      } catch (e) {
        logger.error('无法打印响应体:', e.message);
      }
    } else if (error.request) {
      logger.error('请求已发送但未收到响应');
    } else {
      logger.error('请求配置错误:', error.message);
    }
    
    // 设置CORS头
    setCorsHeaders(res);
    
    // 设置缓存控制头，防止304缓存问题
    setNoCacheHeaders(res);
    
    // 如果有响应错误，保持和原始API一样的错误格式
    if (error.response) {
      try {
        // 设置响应头
        Object.keys(error.response.headers).forEach(header => {
          if (!['content-length', 'connection', 'keep-alive', 'transfer-encoding', 'etag', 'last-modified'].includes(header.toLowerCase())) {
            res.set(header, error.response.headers[header]);
          }
        });
        
        // 设置状态码
        res.status(error.response.status);
        
        // 尝试处理响应数据
        if (Buffer.isBuffer(error.response.data)) {
          const dataStr = error.response.data.toString('utf8');
          try {
            // 尝试解析为JSON
            const json = JSON.parse(dataStr);
            res.json(json);
          } catch (e) {
            // 不是有效的JSON，直接发送
            res.send(dataStr);
          }
        } else {
          // 直接发送响应数据
          res.send(error.response.data);
        }
      } catch (e) {
        logger.error('处理错误响应时出错:', e);
        res.status(500).json({
          error: true,
          message: '处理响应错误时发生异常',
          detail: e.message
        });
      }
    } else {
      // 网络错误或其他错误
      res.status(500).json({
        error: true,
        message: '服务器内部错误',
        detail: error.message,
        path: req.path
      });
    }
    
    // 请求日志 - 由ENABLE_LOGGING控制
    logger.request(`请求错误: ${req.method} ${req.path} ${Date.now() - startTime}ms - ${error.message}`);
  }
});

/**
 * 设置CORS响应头
 * @param {object} res - Express响应对象
 */
function setCorsHeaders(res) {
  const corsOrigin = config.CORS_ORIGIN && config.CORS_ORIGIN !== '' ? config.CORS_ORIGIN : '*';
  res.set('Access-Control-Allow-Origin', corsOrigin);
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.set('Access-Control-Allow-Credentials', 'true');
}

/**
 * 设置禁止缓存的响应头，防止304缓存问题
 * @param {object} res - Express响应对象
 */
function setNoCacheHeaders(res) {
  // 强制禁用所有缓存
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  
  // 移除可能导致304缓存的头信息
  res.removeHeader('ETag');
  res.removeHeader('Last-Modified');
  
  // 添加随机值确保每次响应都不同
  res.set('X-Response-Time', Date.now());
  res.set('X-No-Cache', Math.random().toString(36).substring(2));
}

// 在API实例中也禁用ETag
api.defaults.headers.common['Cache-Control'] = 'no-store, no-cache, must-revalidate, private, max-age=0';
api.defaults.headers.common['Pragma'] = 'no-cache';
api.defaults.headers.common['Expires'] = '0';
api.defaults.headers.common['Surrogate-Control'] = 'no-store';

module.exports = router; 