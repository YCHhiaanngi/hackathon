// 本地视觉会话管理：固定背景辅助模式的定位与颜色实现。
// 核心函数操作 Raster，可在 Node 中用合成图直接测试；
// 浏览器包装函数负责 Blob 解码。掩膜与颜色分析始终使用同一帧。

import { CONFIG } from '../config';
import type {
  ColorResponse,
  Framing,
  LocateRequest,
  LocateResponse,
  Quality,
  RecognizeColorRequest,
  TargetBox,
} from '../shared/types';
import type { Raster } from './imageUtils';
import { decodeBlob } from './imageUtils';
import { BaselineBuilder, extractForeground, findCandidates } from './background';
import type { Baseline, ForegroundResult, Grid } from './background';
import { analyzeColor } from './colorLocal';

export interface LocalVisionStatus {
  baselineReady: boolean;
  /** 0~1，基准背景采集进度。 */
  baselineProgress: number;
  /** 背景明显变化（摄像头移动/光照剧变），需要重新校准。 */
  baselineInvalid: boolean;
}

export interface LocalSession {
  sessionId: string;
  builder: BaselineBuilder;
  baseline: Baseline | null;
  invalidStreak: number;
  baselineInvalid: boolean;
  prevRawMask: Uint8Array | null;
  prevGrid: Grid | null;
  /** 上一帧的目标框；运动估计只在目标连续存在时进行。 */
  prevBox: TargetBox | null;
  /** 按 frameId 缓存最近几帧的前景结果，供颜色识别取同一帧的掩膜。 */
  frameCache: Map<number, ForegroundResult>;
}

const FRAME_CACHE_CAP = 4;

let current: LocalSession | null = null;

export function createLocalSession(sessionId: string): LocalSession {
  return {
    sessionId,
    builder: new BaselineBuilder(),
    baseline: null,
    invalidStreak: 0,
    baselineInvalid: false,
    prevRawMask: null,
    prevGrid: null,
    prevBox: null,
    frameCache: new Map(),
  };
}

function getSession(sessionId: string): LocalSession {
  if (!current || current.sessionId !== sessionId) {
    current = createLocalSession(sessionId); // 新会话：旧基准与缓存全部作废
  }
  return current;
}

/** 引擎查询本地模式状态；非本地模式或无会话时返回 null。 */
export function getLocalVisionStatus(sessionId: string | null): LocalVisionStatus | null {
  if (!sessionId || !current || current.sessionId !== sessionId) return null;
  return {
    baselineReady: current.baseline !== null && !current.baselineInvalid,
    baselineProgress: current.baseline ? 1 : current.builder.progress,
    baselineInvalid: current.baselineInvalid,
  };
}

/** 重新开始采集基准背景（背景失效或手动重校准时调用）。 */
export function restartLocalBaseline(sessionId: string): void {
  if (current && current.sessionId === sessionId) {
    current.builder = new BaselineBuilder();
    current.baseline = null;
    current.baselineInvalid = false;
    current.invalidStreak = 0;
    current.prevRawMask = null;
    current.prevBox = null;
    current.frameCache.clear();
  }
}

interface Ids {
  sessionId: string;
  frameId: number;
  capturedAt: number;
}

function baseResponse(ids: Ids) {
  return { sessionId: ids.sessionId, frameId: ids.frameId, capturedAt: ids.capturedAt };
}

function noTarget(ids: Ids, quality: Quality = 'unknown'): LocateResponse {
  return {
    ...baseResponse(ids),
    targetState: 'none',
    targetBox: null,
    objectName: null,
    quality,
    framing: 'unknown',
    colorReady: false,
  };
}

/** 网格候选框 → 归一化目标框（保证在 0~1 内）。 */
function gridBoxToTargetBox(
  c: { x: number; y: number; width: number; height: number },
  grid: Grid,
): TargetBox {
  const x = Math.min(Math.max(c.x / grid.width, 0), 1);
  const y = Math.min(Math.max(c.y / grid.height, 0), 1);
  return {
    x,
    y,
    width: Math.min(c.width / grid.width, 1 - x),
    height: Math.min(c.height / grid.height, 1 - y),
  };
}

/** 目标区域内的帧间运动：当前框内原始差分掩膜与上一帧不一致的比例。 */
function motionWithinBox(session: LocalSession, fg: ForegroundResult, box: TargetBox): number {
  if (!session.prevRawMask || !session.prevGrid || !session.prevBox) return 0;
  const { width: gw, height: gh } = fg.grid;
  if (session.prevGrid.width !== gw || session.prevGrid.height !== gh) return 0;
  // 目标刚出现或发生了跳变：不做运动判断（新出现不等于模糊）。
  const prev = session.prevBox;
  const prevCx = prev.x + prev.width / 2;
  const prevCy = prev.y + prev.height / 2;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  if (Math.hypot(prevCx - cx, prevCy - cy) > 0.15) return 0;
  const gx0 = Math.max(0, Math.floor(box.x * gw));
  const gy0 = Math.max(0, Math.floor(box.y * gh));
  const gx1 = Math.min(gw, Math.ceil((box.x + box.width) * gw));
  const gy1 = Math.min(gh, Math.ceil((box.y + box.height) * gh));
  let changed = 0;
  let total = 0;
  for (let y = gy0; y < gy1; y++) {
    for (let x = gx0; x < gx1; x++) {
      const i = y * gw + x;
      total++;
      if ((fg.rawMask[i] ?? 0) !== (session.prevRawMask[i] ?? 0)) changed++;
    }
  }
  return total === 0 ? 0 : changed / total;
}

/** 核心定位：真实差分 + 连通区域。可在 Node 中用合成图直接测试。 */
export function locateRaster(session: LocalSession, raster: Raster, ids: Ids): LocateResponse {
  const cfg = CONFIG.localVision;

  if (session.baselineInvalid) {
    return { ...noTarget(ids), targetState: 'uncertain' };
  }

  // 基准背景采集中：不算定位失败，只报告“还没有目标”。
  if (!session.baseline) {
    session.builder.addFrame(raster);
    if (session.builder.done) {
      session.baseline = session.builder.build();
    }
    return noTarget(ids);
  }
  const baseline = session.baseline;

  const fg = extractForeground(raster, baseline);

  // 背景明显变化（摄像头移动/光照剧变）：连续多帧大面积差分 → 基准失效。
  if (fg.changedRatio > cfg.backgroundInvalidRatio) {
    session.invalidStreak++;
    if (session.invalidStreak >= cfg.backgroundInvalidFrames) {
      session.baselineInvalid = true;
    }
  } else {
    session.invalidStreak = 0;
  }
  if (session.baselineInvalid) {
    return { ...noTarget(ids), targetState: 'uncertain' };
  }

  // 全局质量（与目标有无无关）：整体变暗时用全帧亮度
  //（此时前景占比可能极高，背景亮度不可用）；局部深色衣物不会拉低全帧均值到阈值。
  let globalQuality: Quality = 'ok';
  if (fg.frameLuminance < cfg.darkLuminance) globalQuality = 'too_dark';
  else if (fg.glareRatio > cfg.glareRatio) globalQuality = 'glare';

  const n = fg.grid.width * fg.grid.height;
  const candidates = findCandidates(fg.mask, fg.grid.width, fg.grid.height).filter(
    (c) => c.area >= cfg.minAreaRatio * n,
  );

  if (candidates.length === 0) {
    session.prevRawMask = fg.rawMask;
    session.prevGrid = fg.grid;
    session.prevBox = null;
    return noTarget(ids, globalQuality);
  }

  const first = candidates[0];
  const second = candidates[1];
  if (!first) return noTarget(ids, globalQuality);

  // 多个无法区分的候选：不自行猜测哪件是目标。
  if (second && second.area >= first.area * cfg.multipleAreaFactor) {
    session.prevRawMask = fg.rawMask;
    session.prevGrid = fg.grid;
    session.prevBox = null;
    return {
      ...baseResponse(ids),
      targetState: 'multiple',
      targetBox: null,
      objectName: null,
      quality: globalQuality,
      framing: 'unknown',
      colorReady: false,
    };
  }

  const box = gridBoxToTargetBox(first, fg.grid);
  const areaRatio = first.area / n;

  let framing: Framing = 'usable';
  if (areaRatio < cfg.tooSmallRatio) {
    framing = 'too_small';
  } else if (
    box.x <= cfg.croppedMargin ||
    box.y <= cfg.croppedMargin ||
    box.x + box.width >= 1 - cfg.croppedMargin ||
    box.y + box.height >= 1 - cfg.croppedMargin
  ) {
    framing = 'cropped';
  }

  // 明显移动 → blurred（“请保持衣物不动”）；纯色低纹理衣物不因此误判。
  // 注意：必须先算运动再更新 prevRawMask，否则永远与自己比较。
  const motion = motionWithinBox(session, fg, box);
  session.prevRawMask = fg.rawMask;
  session.prevGrid = fg.grid;
  session.prevBox = box;
  let quality: Quality = globalQuality;
  if (quality === 'ok' && motion > cfg.motionRatio) {
    quality = 'blurred';
  }

  const colorReady =
    framing === 'usable' && quality === 'ok' && areaRatio >= cfg.colorMinAreaRatio;

  // 缓存本帧前景，供颜色识别取同一帧的掩膜。
  session.frameCache.set(ids.frameId, fg);
  if (session.frameCache.size > FRAME_CACHE_CAP) {
    const oldest = session.frameCache.keys().next().value;
    if (oldest !== undefined) session.frameCache.delete(oldest);
  }

  return {
    ...baseResponse(ids),
    targetState: 'single',
    targetBox: box,
    objectName: null, // 本地模式不做语义识别
    quality,
    framing,
    colorReady,
  };
}

/** 核心颜色分析：优先使用同帧缓存的掩膜；缺失时对同一帧重新差分。 */
export function recognizeRaster(
  session: LocalSession,
  raster: Raster,
  ids: Ids,
  targetBox: TargetBox,
): ColorResponse {
  const base = baseResponse(ids);

  if (!session.baseline || session.baselineInvalid) {
    return {
      ...base,
      status: 'uncertain',
      result: null,
      message: '背景基准不可用，暂时无法分析颜色。',
      retryAdvice: '请把衣物移出画面，等待重新采集背景。',
    };
  }

  // 掩膜必须属于同一采样帧：优先取该帧缓存，否则用同一帧重新差分。
  const fg = session.frameCache.get(ids.frameId) ?? extractForeground(raster, session.baseline);
  const analysis = analyzeColor(raster, targetBox, fg);
  return { ...base, ...analysis };
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('已取消', 'AbortError');
  }
}

/** 浏览器入口：解码 Blob 后走核心逻辑。本地处理，同步完成，不真的“异步等待”。 */
export async function localLocateTarget(req: LocateRequest): Promise<LocateResponse> {
  assertNotAborted(req.signal);
  const raster = await decodeBlob(req.image);
  assertNotAborted(req.signal);
  return locateRaster(getSession(req.sessionId), raster, req);
}

export async function localRecognizeColor(req: RecognizeColorRequest): Promise<ColorResponse> {
  assertNotAborted(req.signal);
  const raster = await decodeBlob(req.image);
  assertNotAborted(req.signal);
  return recognizeRaster(getSession(req.sessionId), raster, req, req.targetBox);
}
