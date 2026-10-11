// 统一配置：所有可调参数集中在这里，组件与引擎不得散落硬编码。

export type ApiMode = 'mock' | 'http';

const env = import.meta.env;

export const CONFIG = {
  /** 'mock' = 演示模式（不分析真实画面）；'http' = 调用尹提供的真实服务 */
  apiMode: (env.VITE_API_MODE ?? 'mock') as ApiMode,
  /** 真实服务的 HTTPS 地址，由尹提供并配置 CORS。密钥不得出现在这里。 */
  apiBaseUrl: (env.VITE_API_BASE_URL ?? '') as string,

  /** 定位采样间隔（毫秒）。实际速度以定位实现为准。 */
  locateIntervalMs: 500,
  /** 定位结果超过该年龄（毫秒）则不用于方向播报。原型初始参数，需实测调整。 */
  locateResultMaxAgeMs: 1500,
  /** 颜色结果从采样到现在的最大允许年龄（毫秒）。 */
  colorResultMaxAgeMs: 6000,
  /** 请求超时（毫秒）。 */
  requestTimeoutMs: 8000,

  /** 抽帧图像规格：长边与 JPEG 质量。 */
  capture: {
    maxEdge: 640,
    jpegQuality: 0.8,
  },

  /** 语音调度：同一句提示的最小间隔（毫秒）。 */
  speechMinIntervalMs: 4000,

  /** 取景参考区域与居中容差/滞回（归一化坐标）。 */
  guide: {
    centerX: 0.5,
    centerY: 0.5,
    centerTolerance: 0.08,
    hysteresis: 0.03,
  },

  /** 方向映射与校准。 */
  direction: {
    /** 方向建议需连续一致的次数才播报，避免左右跳变。 */
    confirmCount: 2,
    /** 校准判定为有效移动的最小位移（归一化）。 */
    calibrationMinDelta: 0.04,
    /** 每一步校准等待用户移动的最长时间（毫秒）。 */
    calibrationTimeoutMs: 6000,
    /** 校准失败后的重试冷却（毫秒）。 */
    calibrationCooldownMs: 8000,
  },

  /** 稳定性判断：窗口大小、最少稳定样本数、中心点位移容差。 */
  stability: {
    windowSize: 6,
    minStableSamples: 3,
    positionEpsilon: 0.03,
  },

  /** 降级（停稳后分析）判断：统计最近 N 次定位年龄的窗口与过期比例阈值。 */
  degraded: {
    windowSize: 8,
    staleRatioEnter: 0.75,
    staleRatioExit: 0.25,
    minSamples: 5,
  },

  /** 结果失效判断：连续目标丢失帧数、中心点显著位移。 */
  invalidation: {
    lostFrames: 3,
    significantMove: 0.15,
  },
} as const;
