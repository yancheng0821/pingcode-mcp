import { logger } from './logger.js';

/**
 * 指标统计模块
 *
 * 提供请求量、失败率、分片次数、平均耗时、缓存命中率等指标统计
 */

interface RequestMetric {
  count: number;
  errors: number;
  totalDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
}

interface CacheMetric {
  hits: number;
  misses: number;
}

interface SliceMetric {
  totalSlices: number;
  slicedRequests: number;
}

class Metrics {
  // 按工具/端点统计请求
  private requests = new Map<string, RequestMetric>();

  // 缓存统计
  private cache: CacheMetric = { hits: 0, misses: 0 };

  // 分片统计
  private slices: SliceMetric = { totalSlices: 0, slicedRequests: 0 };

  // 启动时间
  private readonly startTime = Date.now();

  /**
   * 记录请求开始（返回计时器）
   */
  startRequest(name: string): () => void {
    const startTime = Date.now();
    return () => this.endRequest(name, startTime, false);
  }

  /**
   * 记录请求结束
   */
  endRequest(name: string, startTime: number, isError: boolean): void {
    const duration = Date.now() - startTime;

    let metric = this.requests.get(name);
    if (!metric) {
      metric = {
        count: 0,
        errors: 0,
        totalDurationMs: 0,
        minDurationMs: Infinity,
        maxDurationMs: 0,
      };
      this.requests.set(name, metric);
    }

    metric.count++;
    if (isError) metric.errors++;
    metric.totalDurationMs += duration;
    metric.minDurationMs = Math.min(metric.minDurationMs, duration);
    metric.maxDurationMs = Math.max(metric.maxDurationMs, duration);
  }

  /**
   * 记录请求成功
   */
  recordSuccess(name: string, durationMs: number): void {
    this.endRequest(name, Date.now() - durationMs, false);
  }

  /**
   * 记录请求失败
   */
  recordError(name: string, durationMs: number): void {
    this.endRequest(name, Date.now() - durationMs, true);
  }

  /**
   * 记录缓存命中
   */
  recordCacheHit(): void {
    this.cache.hits++;
  }

  /**
   * 记录缓存未命中
   */
  recordCacheMiss(): void {
    this.cache.misses++;
  }

  /**
   * 记录时间分片
   */
  recordTimeSlice(sliceCount: number): void {
    if (sliceCount > 1) {
      this.slices.slicedRequests++;
      this.slices.totalSlices += sliceCount;
    }
  }

  /**
   * 获取所有指标快照
   */
  getSnapshot(): MetricsSnapshot {
    const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);

    const requestStats: Record<string, RequestStats> = {};
    for (const [name, metric] of this.requests) {
      requestStats[name] = {
        count: metric.count,
        errors: metric.errors,
        errorRate: metric.count > 0 ? metric.errors / metric.count : 0,
        avgDurationMs: metric.count > 0 ? Math.round(metric.totalDurationMs / metric.count) : 0,
        minDurationMs: metric.minDurationMs === Infinity ? 0 : metric.minDurationMs,
        maxDurationMs: metric.maxDurationMs,
      };
    }

    const totalRequests = Array.from(this.requests.values()).reduce((sum, m) => sum + m.count, 0);
    const totalErrors = Array.from(this.requests.values()).reduce((sum, m) => sum + m.errors, 0);
    const totalCacheRequests = this.cache.hits + this.cache.misses;

    return {
      uptime_seconds: uptimeSeconds,
      requests: {
        total: totalRequests,
        errors: totalErrors,
        error_rate: totalRequests > 0 ? totalErrors / totalRequests : 0,
        by_endpoint: requestStats,
      },
      cache: {
        hits: this.cache.hits,
        misses: this.cache.misses,
        hit_rate: totalCacheRequests > 0 ? this.cache.hits / totalCacheRequests : 0,
      },
      time_slicing: {
        sliced_requests: this.slices.slicedRequests,
        total_slices: this.slices.totalSlices,
        avg_slices_per_request: this.slices.slicedRequests > 0
          ? this.slices.totalSlices / this.slices.slicedRequests
          : 0,
      },
    };
  }

  /**
   * 重置所有指标
   */
  reset(): void {
    this.requests.clear();
    this.cache = { hits: 0, misses: 0 };
    this.slices = { totalSlices: 0, slicedRequests: 0 };
    logger.info('Metrics reset');
  }

  /**
   * 输出指标到日志
   */
  logSnapshot(): void {
    const snapshot = this.getSnapshot();
    logger.info({ metrics: snapshot }, 'Metrics snapshot');
  }
}

// 类型定义
export interface RequestStats {
  count: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
}

export interface MetricsSnapshot {
  uptime_seconds: number;
  requests: {
    total: number;
    errors: number;
    error_rate: number;
    by_endpoint: Record<string, RequestStats>;
  };
  cache: {
    hits: number;
    misses: number;
    hit_rate: number;
  };
  time_slicing: {
    sliced_requests: number;
    total_slices: number;
    avg_slices_per_request: number;
  };
}

// Singleton instance
export const metrics = new Metrics();
