// 前端统一的能力适配层：页面组件只允许调用这里的两个函数。
// local / http / mock 三种模式返回完全相同的数据结构，由 CONFIG.apiMode 切换。
// 真实接口失败时不会静默降级到 Mock。

import { CONFIG } from '../config';
import type {
  ColorResponse,
  LocateRequest,
  LocateResponse,
  RecognizeColorRequest,
  TargetBox,
} from '../shared/types';
import { postImageJson } from './http';
import { mockLocateTarget } from './mockLocate';
import { mockRecognizeColor } from './mockColor';
import {
  getLocalVisionStatus,
  localLocateTarget,
  localRecognizeColor,
  restartLocalBaseline,
} from '../local/localVision';

// 本地模式的状态与控制（仅 local 模式有效，其余模式返回 null / 无操作）。
export { getLocalVisionStatus, restartLocalBaseline };

const TARGET_STATES = ['none', 'single', 'multiple', 'uncertain'];
const QUALITIES = ['ok', 'too_dark', 'blurred', 'glare', 'unknown'];
const FRAMINGS = ['usable', 'too_small', 'cropped', 'unknown'];
const PATTERNS = ['solid', 'striped', 'checked', 'mixed', 'unknown'];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isTargetBox(v: unknown): v is TargetBox {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Record<string, unknown>;
  return (
    isFiniteNumber(b.x) &&
    isFiniteNumber(b.y) &&
    isFiniteNumber(b.width) &&
    isFiniteNumber(b.height) &&
    b.x >= 0 &&
    b.y >= 0 &&
    b.width > 0 &&
    b.height > 0 &&
    b.x + b.width <= 1 &&
    b.y + b.height <= 1
  );
}

function isStringOrNull(v: unknown): v is string | null {
  return typeof v === 'string' || v === null;
}

export function isLocateResponse(data: unknown): data is LocateResponse {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.sessionId === 'string' &&
    isFiniteNumber(d.frameId) &&
    isFiniteNumber(d.capturedAt) &&
    typeof d.targetState === 'string' &&
    TARGET_STATES.includes(d.targetState) &&
    (d.targetBox === null || isTargetBox(d.targetBox)) &&
    isStringOrNull(d.objectName) &&
    typeof d.quality === 'string' &&
    QUALITIES.includes(d.quality) &&
    typeof d.framing === 'string' &&
    FRAMINGS.includes(d.framing) &&
    typeof d.colorReady === 'boolean'
  );
}

export function isColorResponse(data: unknown): data is ColorResponse {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  if (
    typeof d.sessionId !== 'string' ||
    !isFiniteNumber(d.frameId) ||
    !isFiniteNumber(d.capturedAt) ||
    (d.status !== 'ok' && d.status !== 'uncertain') ||
    typeof d.message !== 'string' ||
    !isStringOrNull(d.retryAdvice)
  ) {
    return false;
  }
  if (d.status === 'ok') {
    const r = d.result as Record<string, unknown> | null;
    if (typeof r !== 'object' || r === null) return false;
    return (
      isStringOrNull(r.objectName) &&
      typeof r.primaryColor === 'string' &&
      Array.isArray(r.secondaryColors) &&
      r.secondaryColors.every((c) => typeof c === 'string') &&
      typeof r.pattern === 'string' &&
      PATTERNS.includes(r.pattern)
    );
  }
  return d.result === null;
}

/** 快速定位：判断目标有无、位置、画面质量与是否可进入颜色识别。 */
export async function locateTarget(req: LocateRequest): Promise<LocateResponse> {
  if (CONFIG.apiMode === 'mock') {
    return mockLocateTarget(req);
  }
  if (CONFIG.apiMode === 'local') {
    return localLocateTarget(req);
  }
  return postImageJson<LocateResponse>(
    '/api/vision/locate',
    {
      sessionId: req.sessionId,
      frameId: String(req.frameId),
      capturedAt: String(req.capturedAt),
    },
    req.image,
    req.signal,
    isLocateResponse,
  );
}

/** 颜色识别：仅在目标稳定可识别时触发，入参必须是与 targetBox 对应的同一帧。 */
export async function recognizeColor(req: RecognizeColorRequest): Promise<ColorResponse> {
  if (CONFIG.apiMode === 'mock') {
    return mockRecognizeColor(req);
  }
  if (CONFIG.apiMode === 'local') {
    return localRecognizeColor(req);
  }
  return postImageJson<ColorResponse>(
    '/api/color/analyze',
    {
      sessionId: req.sessionId,
      frameId: String(req.frameId),
      capturedAt: String(req.capturedAt),
      targetBox: JSON.stringify(req.targetBox),
    },
    req.image,
    req.signal,
    isColorResponse,
  );
}
