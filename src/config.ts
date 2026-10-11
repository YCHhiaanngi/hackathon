// 统一配置：所有可调参数集中在这里，组件与引擎不得散落硬编码。

export type ApiMode = 'mock' | 'local' | 'http';

// 兼容浏览器（Vite 注入 import.meta.env）与 Node 测试环境。
const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> };
const env: Record<string, string | undefined> = meta.env ?? {};

export const CONFIG = {
  /** 'local'（默认）= 浏览器本地真实图像处理；'mock' = 演示模式（不分析真实画面）；'http' = 调用远程服务 */
  apiMode: (env.VITE_API_MODE ?? 'local') as ApiMode,
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

  /**
   * 本地视觉（固定背景辅助模式）参数。阈值集中在此，实测后统一调整。
   * 注意：这是真实图像处理，但不是语义上的衣物识别。
   */
  localVision: {
    /** 差分分析网格宽度（像素），高度按比例。 */
    gridWidth: 160,
    /** 前景判定：像素与背景的通道最大差超过该值视为变化。 */
    diffThreshold: 34,
    /** 基准背景采集：需要的低运动连续帧数。 */
    baselineFrames: 6,
    /** 基准采集时允许的最大帧间变化比例。 */
    baselineMaxMotion: 0.02,
    /** 候选区域最小面积占比（相对整幅图像）。 */
    minAreaRatio: 0.015,
    /** 低于该面积占比 → framing = too_small。 */
    tooSmallRatio: 0.03,
    /** 第二候选面积超过最大候选的该比例 → multiple。 */
    multipleAreaFactor: 0.4,
    /** 目标框触边判定余量（归一化）。 */
    croppedMargin: 0.01,
    /** 目标区域内帧间变化超过该比例 → 明显移动（blurred）。 */
    motionRatio: 0.25,
    /** 背景区域平均亮度低于该值（0~1）→ too_dark。 */
    darkLuminance: 0.18,
    /** 全帧高亮像素占比超过该值 → glare。 */
    glareRatio: 0.25,
    /** 颜色识别可用的最小面积占比。 */
    colorMinAreaRatio: 0.02,
    /** 颜色分类：饱和度低于该值进入黑/白/灰判定。 */
    colorSaturationLow: 0.16,
    /** 黑/白亮度边界（0~1）。 */
    blackLuminance: 0.16,
    whiteLuminance: 0.85,
    /** 主色占比低于该值 → uncertain（颜色边界不明确）。 */
    primaryMinShare: 0.3,
    /** 次要颜色入选占比。 */
    secondaryMinShare: 0.15,
  },
} as const;
