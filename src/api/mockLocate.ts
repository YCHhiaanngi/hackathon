// 定位 Mock：按时间脚本回放，结构与 /api/vision/locate 一致。
// 注意：不分析当前摄像头画面，仅用于演示与前端联调，UI 必须明确标注。

import type { LocateRequest, LocateResponse, TargetBox } from '../shared/types';
import { NORMAL_CYCLE_MS, SECOND_GARMENT_MS, delayWithSignal, mockLatencyMs, scenarioClock } from './mockScenario';

interface PathPoint {
  cx: number;
  cy: number;
}

const BOX_W = 0.3;
const BOX_H = 0.42;

function boxAt(p: PathPoint): TargetBox {
  return {
    x: Math.min(Math.max(p.cx - BOX_W / 2, 0), 1 - BOX_W),
    y: Math.min(Math.max(p.cy - BOX_H / 2, 0), 1 - BOX_H),
    width: BOX_W,
    height: BOX_H,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(Math.max(t, 0), 1);
}

/**
 * 正常脚本（一个循环 48s）：
 * 无目标 → 目标偏右下 → 用户向右校准移动（图像中向左）→ 垂直调整 →
 * 稳定可识别 → 拿走（4.5s，足够触发失效）→ 换一件从左侧进入 → 稳定可识别。
 */
function normalPath(t: number): { point: PathPoint; colorReady: boolean } | null {
  const CENTER = 0.5;
  if (t < 2500) return null;
  if (t < 6500) return { point: { cx: 0.72, cy: 0.6 }, colorReady: false };
  if (t < 9500) {
    const k = (t - 6500) / 3000;
    return { point: { cx: lerp(0.72, CENTER, k), cy: 0.6 }, colorReady: false };
  }
  if (t < 12000) {
    const k = (t - 9500) / 2500;
    return { point: { cx: CENTER, cy: lerp(0.6, CENTER, k) }, colorReady: false };
  }
  if (t < 20000) return { point: { cx: CENTER, cy: CENTER }, colorReady: true };
  if (t < SECOND_GARMENT_MS) return null; // 拿走了（4.5s）
  if (t < 27500) {
    const k = (t - SECOND_GARMENT_MS) / 3000;
    return { point: { cx: lerp(0.35, CENTER, k), cy: 0.42 }, colorReady: false };
  }
  if (t < 29500) {
    const k = (t - 27500) / 2000;
    return { point: { cx: CENTER, cy: lerp(0.42, CENTER, k) }, colorReady: false };
  }
  return { point: { cx: CENTER, cy: CENTER }, colorReady: true };
}

export async function mockLocateTarget(req: LocateRequest): Promise<LocateResponse> {
  const { elapsedMs, scenario } = scenarioClock(req.sessionId);
  await delayWithSignal(mockLatencyMs(scenario), req.signal);

  const base = {
    sessionId: req.sessionId,
    frameId: req.frameId,
    capturedAt: req.capturedAt,
  };

  if (scenario === 'multiple') {
    if (elapsedMs < 2000) {
      return { ...base, targetState: 'none', targetBox: null, objectName: null, quality: 'ok', framing: 'unknown', colorReady: false };
    }
    return { ...base, targetState: 'multiple', targetBox: null, objectName: null, quality: 'ok', framing: 'unknown', colorReady: false };
  }

  if (scenario === 'dark' || scenario === 'blurred') {
    if (elapsedMs < 2000) {
      return { ...base, targetState: 'none', targetBox: null, objectName: null, quality: 'ok', framing: 'unknown', colorReady: false };
    }
    return {
      ...base,
      targetState: 'single',
      targetBox: boxAt({ cx: 0.5, cy: 0.5 }),
      objectName: null,
      quality: scenario === 'dark' ? 'too_dark' : 'blurred',
      framing: 'usable',
      colorReady: false,
    };
  }

  if (scenario === 'lost') {
    const phase = elapsedMs % 6500;
    if (elapsedMs < 2000 || phase >= 4000) {
      return { ...base, targetState: 'none', targetBox: null, objectName: null, quality: 'ok', framing: 'unknown', colorReady: false };
    }
    return {
      ...base,
      targetState: 'single',
      targetBox: boxAt({ cx: 0.5, cy: 0.5 }),
      objectName: '上衣',
      quality: 'ok',
      framing: 'usable',
      colorReady: true,
    };
  }

  // normal / slow 共用时间脚本
  const t = elapsedMs % NORMAL_CYCLE_MS;
  const hit = normalPath(t);
  if (!hit) {
    return { ...base, targetState: 'none', targetBox: null, objectName: null, quality: 'ok', framing: 'unknown', colorReady: false };
  }
  return {
    ...base,
    targetState: 'single',
    targetBox: boxAt(hit.point),
    objectName: hit.colorReady ? (t < SECOND_GARMENT_MS ? '上衣' : 'T 恤') : null,
    quality: 'ok',
    framing: 'usable',
    colorReady: hit.colorReady,
  };
}
