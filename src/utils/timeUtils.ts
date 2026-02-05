import {
  startOfDay,
  endOfDay,
  startOfWeek,
  startOfMonth,
  addDays,
  addWeeks,
  addMonths,
  parse,
  isValid,
  getUnixTime,
} from 'date-fns';
import { toZonedTime, formatInTimeZone } from 'date-fns-tz';
import { config } from '../config/index.js';

const THREE_MONTHS_SECONDS = 90 * 24 * 60 * 60;

type TimeAlias = 'today' | 'yesterday' | 'last_week' | 'this_week' | 'last_month' | 'this_month';

const TIME_ALIASES: Record<TimeAlias, () => [Date, Date]> = {
  today: () => {
    const now = getNow();
    return [startOfDay(now), now];
  },
  yesterday: () => {
    const now = getNow();
    return [startOfDay(addDays(now, -1)), startOfDay(now)];
  },
  last_week: () => {
    const now = getNow();
    return [startOfWeek(addWeeks(now, -1), { weekStartsOn: 1 }), startOfWeek(now, { weekStartsOn: 1 })];
  },
  this_week: () => {
    const now = getNow();
    return [startOfWeek(now, { weekStartsOn: 1 }), now];
  },
  last_month: () => {
    const now = getNow();
    return [startOfMonth(addMonths(now, -1)), startOfMonth(now)];
  },
  this_month: () => {
    const now = getNow();
    return [startOfMonth(now), now];
  },
};

// 中文别名映射到英文别名
const CHINESE_ALIASES: Record<string, TimeAlias> = {
  '今天': 'today',
  '今日': 'today',
  '昨天': 'yesterday',
  '昨日': 'yesterday',
  '上周': 'last_week',
  '上一周': 'last_week',
  '本周': 'this_week',
  '这周': 'this_week',
  '上月': 'last_month',
  '上个月': 'last_month',
  '本月': 'this_month',
  '这个月': 'this_month',
};

function getNow(): Date {
  return toZonedTime(new Date(), config.timezone);
}

export function parseTimeInput(input: string): Date {
  // Check if it's a Chinese alias first
  const trimmedInput = input.trim();
  if (trimmedInput in CHINESE_ALIASES) {
    const englishAlias = CHINESE_ALIASES[trimmedInput];
    const [start] = TIME_ALIASES[englishAlias]();
    return start;
  }

  // Check if it's an English time alias
  const alias = trimmedInput.toLowerCase().replace(/\s+/g, '_') as TimeAlias;
  if (alias in TIME_ALIASES) {
    const [start] = TIME_ALIASES[alias]();
    return start;
  }

  // Try to parse as date string
  const formats = ['yyyy-MM-dd', 'yyyy/MM/dd', 'yyyyMMdd'];
  for (const format of formats) {
    const parsed = parse(trimmedInput, format, new Date());
    if (isValid(parsed)) {
      return toZonedTime(parsed, config.timezone);
    }
  }

  throw new Error(`Invalid time input: ${input}`);
}

export interface TimeRange {
  start: number;  // Unix timestamp (seconds)
  end: number;    // Unix timestamp (seconds)
}

/**
 * 将输入转换为标准英文别名
 */
function normalizeAlias(input: string): TimeAlias | null {
  const trimmed = input.trim();

  // 检查中文别名
  if (trimmed in CHINESE_ALIASES) {
    return CHINESE_ALIASES[trimmed];
  }

  // 检查英文别名
  const englishAlias = trimmed.toLowerCase().replace(/\s+/g, '_') as TimeAlias;
  if (englishAlias in TIME_ALIASES) {
    return englishAlias;
  }

  return null;
}

export function parseTimeRange(start: string, end: string): TimeRange {
  // 尝试将输入转换为标准别名
  const startAlias = normalizeAlias(start);
  const endAlias = normalizeAlias(end);

  if (startAlias && startAlias === endAlias) {
    // Same alias for start and end - use the full range
    const [startDate, endDate] = TIME_ALIASES[startAlias]();
    return {
      start: getUnixTime(startDate),
      end: getUnixTime(endDate),
    };
  }

  // Parse individually
  let startDate: Date;
  let endDate: Date;

  if (startAlias) {
    [startDate] = TIME_ALIASES[startAlias]();
  } else {
    startDate = parseTimeInput(start);
  }

  if (endAlias) {
    [, endDate] = TIME_ALIASES[endAlias]();
  } else {
    endDate = parseTimeInput(end);
    // If end is just a date, use end of that day
    endDate = endOfDay(endDate);
  }

  // Validate: start must be before end
  if (startDate >= endDate) {
    throw new Error('Start time must be before end time');
  }

  return {
    start: getUnixTime(startDate),
    end: getUnixTime(endDate),
  };
}

export function splitTimeRange(start: number, end: number): Array<[number, number]> {
  const chunks: Array<[number, number]> = [];

  let current = start;
  while (current < end) {
    const chunkEnd = Math.min(current + THREE_MONTHS_SECONDS, end);
    chunks.push([current, chunkEnd]);
    current = chunkEnd;
  }

  return chunks;
}

export function formatTimestamp(timestamp: number): string {
  // 使用配置的时区格式化日期，避免 UTC 导致日期偏移
  return formatInTimeZone(new Date(timestamp * 1000), config.timezone, 'yyyy-MM-dd');
}

export function isTimeRangeExceedsThreeMonths(start: number, end: number): boolean {
  return (end - start) > THREE_MONTHS_SECONDS;
}
