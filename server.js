/**
 * API中间件服务器
 * 用于隐藏真实API路径，转发API请求到后端
 */
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { config } = require('./config');
const apiRoutes = require('./routes');
const fs = require('fs');
const crypto = require('crypto');

// 创建Express应用
const app = express();

// 处理多域名 CORS 允许列表（逗号分隔）
const corsOriginRaw = config.CORS_ORIGIN && config.CORS_ORIGIN !== '' ? config.CORS_ORIGIN : '*';

let corsOrigin;

if (corsOriginRaw === '*' ) {
  corsOrigin = '*';
} else {
  // 生成白名单数组
  const corsWhitelist = corsOriginRaw.split(',').map(o => o.trim()).filter(Boolean);
  // 按请求 Origin 动态返回单一值，避免浏览器报多值冲突
  corsOrigin = function(origin, callback) {
    // 无 Origin（如 curl/Postman）或白名单为空直接放行
    if (!origin || corsWhitelist.length === 0) {
      return callback(null, true);
    }
    // * 通配直接放行
    if (corsWhitelist.includes('*')) {
      return callback(null, true);
    }
    // 精确匹配放行
    if (corsWhitelist.includes(origin)) {
      return callback(null, true);
    }
    // 不在白名单，拒绝
    return callback(new Error('Not allowed by CORS'));
  };
}

// console.log(`CORS源配置: ${corsOrigin}`);

// 添加预检请求处理
app.options('*', cors()); // 启用对所有路由的OPTIONS请求处理

// 禁用ETag生成，防止304缓存问题
app.set('etag', false);
app.disable('etag');

// CORS配置
app.use(cors({
  origin: corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
}));

// 启用请求日志
if (config.ENABLE_LOGGING) {
  app.use(morgan('dev'));
}

// 解析JSON请求体
app.use(express.json({ limit: '10mb' }));

// 解析URL编码的请求体
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 提供静态文件
app.use(express.static(path.join(__dirname), {
  index: false,
  maxAge: '24h', // 服务端缓存时间为24小时
  immutable: true,
  etag: true
}));

// APP 配置接口 - 支持缓存 config.APP_CACHE_SECONDS 秒，可通过 ?nocache=1 强制刷新

// 组合最终路由路径，确保不会出现双斜杠
const appConfigRoute = `${config.API_PREFIX.replace(/\/$/, '')}${config.APP_ENDPOINT.startsWith('/') ? '' : '/'}${config.APP_ENDPOINT}`;

app.get(appConfigRoute, (req, res) => {
  const { nocache } = req.query;
  
  try {
    const filePath = config.APP_CONFIG_FILE;
    const fileContent = fs.readFileSync(filePath, 'utf8');
    // Base64 编码
    const encodedContent = Buffer.from(fileContent, 'utf8').toString('base64');

    // 若请求带 nocache=1，则关闭缓存并返回最新数据
    if (nocache === '1') {
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      return res.json({ data: encodedContent, encoding: 'base64' });
    }

    // 计算 ETag
    const etag = crypto.createHash('md5').update(encodedContent).digest('hex');

    // 如果客户端已有最新版本，返回 304
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    // 设置缓存头，缓存 config.APP_CACHE_SECONDS 秒
    res.set({
      'ETag': etag,
      'Cache-Control': `public, max-age=${config.APP_CACHE_SECONDS}`
    });

    return res.json({ data: encodedContent, encoding: 'base64' });
  } catch (err) {
    console.error('读取 APP 配置文件出错:', err);
    return res.status(500).json({ error: true, message: '服务器读取配置错误' });
  }
});

// 根路径显示伪站点
// 根路径显示伪站点
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 设置API路由 - 放在静态文件和根路径之后
app.use(config.API_PREFIX, apiRoutes);

// 健康检查路由
app.get('/ping', (_req, res) => {
  res.status(200).json({
    status: 'UP',
    message: 'pong',
    timestamp: new Date().toISOString()
  });
});

// 404处理
app.use((req, res) => {
  // 检查请求路径是否以API前缀开头
  if (req.path.startsWith(config.API_PREFIX)) {
    // API请求返回JSON 404
    res.status(404).json({
      error: true,
      message: '404 Not Found'
    });
  } else {
    // 非API请求重定向到伪站点
    res.redirect('/');
  }
});

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  
  // 记录更详细的错误信息
  console.error(`URL: ${req.method} ${req.url}`);
  console.error(`请求头: ${JSON.stringify(req.headers)}`);
  
  // 返回统一的错误格式
  res.status(500).json({
    error: true,
    message: 'Server Error',
    detail: err.message
  });
});

// 启动服务器
const PORT = config.PORT;
app.listen(PORT, () => {
  console.log(`API中间件服务器已启动，监听端口: ${PORT}`);
  console.log(`中间件API前缀: ${config.API_PREFIX}`);
  console.log(`后端API地址: ${config.BACKEND_API_URL}`);
  console.log(`CORS源: ${corsOrigin}`);
  console.log(`允许的源地址: ${config.ALLOWED_ORIGINS}`);
  console.log(`允许的支付回调路径: ${config.ALLOWED_PAYMENT_NOTIFY_PATHS} (默认为空)`);
});

// 处理未捕获的异常
process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
});

// 处理未处理的Promise拒绝
process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的Promise拒绝:', reason);
}); 