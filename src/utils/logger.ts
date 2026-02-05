import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { format } from 'date-fns';
import { config } from '../config/index.js';

// 获取项目根目录
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const logDir = path.join(projectRoot, 'logs');

// 确保日志目录存在
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// 生成带日期的日志文件名: app-2026-02-05.log
const today = format(new Date(), 'yyyy-MM-dd');
const logFile = path.join(logDir, `app-${today}.log`);

export const logger = pino({
  level: config.logLevel,
  transport: {
    targets: [
      // stderr 输出（避免干扰 stdio 模式的 JSON-RPC）
      {
        target: 'pino/file',
        options: { destination: 2 },
        level: config.logLevel,
      },
      // 日志文件（按日期命名）
      {
        target: 'pino/file',
        options: { destination: logFile },
        level: config.logLevel,
      },
    ],
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: 'pingcode-mcp',
  },
  // Redact sensitive fields
  redact: ['token', 'authorization', 'PINGCODE_TOKEN'],
});

export type Logger = typeof logger;
