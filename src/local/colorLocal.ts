// 本地颜色分析：对目标区域（优先在前景掩膜内）的真实像素做可解释的分类计数。
// 不做整图平均、不做 RGB 混色；黑/白/灰低饱和颜色单独保留。
// 未实现图案识别 → pattern 恒为 unknown；未实现语义识别 → objectName 恒为 null。

import { CONFIG } from '../config';
import type { ColorResultData, TargetBox } from '../shared/types';
import type { Raster } from './imageUtils';
import { rgbToHsl } from './imageUtils';
import type { ForegroundResult } from './background';

export type ColorCategory =
  | '黑' | '白' | '灰'
  | '红' | '橙' | '黄' | '绿' | '青' | '蓝' | '紫'
  | '粉' | '棕';

/** 单个像素的颜色归类。阈值集中在 CONFIG.localVision。 */
export function categorizePixel(r: number, g: number, b: number): ColorCategory {
  const { h, s, l } = rgbToHsl(r, g, b);
  const cfg = CONFIG.localVision;

  // 低饱和度：黑 / 白 / 灰，不进入色相分类。
  if (s < cfg.colorSaturationLow) {
    if (l < cfg.blackLuminance) return '黑';
    if (l > cfg.whiteLuminance) return '白';
    return '灰';
  }
  // 低亮度的红橙色归为棕（深色衣物的常见情况）。
  if (l < 0.28 && (h < 45 || h >= 345)) return '棕';
  // 高亮度、中低饱和的红色系归为粉。
  if (s < 0.45 && l > 0.6 && (h >= 330 || h < 15)) return '粉';

  if (h < 15 || h >= 345) return '红';
  if (h < 45) return '橙';
  if (h < 75) return '黄';
  if (h < 165) return '绿';
  if (h < 195) return '青';
  if (h < 255) return '蓝';
  return '紫';
}

export interface ColorAnalysis {
  status: 'ok' | 'uncertain';
  result: ColorResultData | null;
  message: string;
  retryAdvice: string | null;
}

/**
 * 分析 targetBox 内的颜色。
 * mask 为降采样网格上的前景掩膜（与本帧差分得到）；传入时只在掩膜内取样，
 * 并先做一次边界腐蚀，减少背景与阴影边缘污染。
 */
export function analyzeColor(
  raster: Raster,
  box: TargetBox,
  foreground: ForegroundResult | null,
): ColorAnalysis {
  const cfg = CONFIG.localVision;

  // 归一化框 → 像素范围（裁剪到图像内）。
  const px0 = Math.max(0, Math.floor(box.x * raster.width));
  const py0 = Math.max(0, Math.floor(box.y * raster.height));
  const px1 = Math.min(raster.width, Math.ceil((box.x + box.width) * raster.width));
  const py1 = Math.min(raster.height, Math.ceil((box.y + box.height) * raster.height));

  // 颜色取样用掩膜：边界腐蚀一次，避免边缘混入背景。
  let sampleMask: Uint8Array | null = null;
  let gw = 0;
  let gh = 0;
  if (foreground) {
    gw = foreground.grid.width;
    gh = foreground.grid.height;
    sampleMask = erodeOnce(foreground.mask, gw, gh);
  }

  const counts = new Map<ColorCategory, number>();
  let sampled = 0;
  const framePixels = raster.width * raster.height;

  for (let y = py0; y < py1; y++) {
    for (let x = px0; x < px1; x++) {
      if (sampleMask) {
        const gx = Math.min(gw - 1, Math.floor((x / raster.width) * gw));
        const gy = Math.min(gh - 1, Math.floor((y / raster.height) * gh));
        if (!sampleMask[gy * gw + gx]) continue; // 背景像素，跳过
      }
      const i = (y * raster.width + x) * 4;
      const cat = categorizePixel(raster.data[i] ?? 0, raster.data[i + 1] ?? 0, raster.data[i + 2] ?? 0);
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
      sampled++;
    }
  }

  // 有效目标区域不足 → 不确定（不硬猜）。
  if (sampled < cfg.colorMinAreaRatio * framePixels) {
    return {
      status: 'uncertain',
      result: null,
      message: '目标区域太小，颜色不够明确。',
      retryAdvice: '请把衣物靠近摄像头一点，保持不动后再试。',
    };
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted[0];
  if (!top) {
    return {
      status: 'uncertain',
      result: null,
      message: '没有取到有效的颜色。',
      retryAdvice: '请调整衣物位置后再试。',
    };
  }

  const primaryShare = top[1] / sampled;
  if (primaryShare < cfg.primaryMinShare) {
    return {
      status: 'uncertain',
      result: null,
      message: '颜色分布比较分散，无法确定主要颜色。',
      retryAdvice: '请把衣物颜色最多的部分对准摄像头，保持不动。',
    };
  }

  const secondary = sorted
    .slice(1)
    .filter(([, count]) => count / sampled >= cfg.secondaryMinShare)
    .map(([cat]) => cat);

  const result: ColorResultData = {
    objectName: null, // 本地模式不做语义识别
    primaryColor: top[0],
    secondaryColors: secondary,
    pattern: 'unknown', // 未实现图案识别，不伪造条纹/格纹
  };

  const message =
    secondary.length > 0
      ? `目标区域的主要颜色是${result.primaryColor}，还带有${secondary.join('、')}。`
      : `目标区域的主要颜色是${result.primaryColor}。`;

  return { status: 'ok', result, message, retryAdvice: null };
}

function erodeOnce(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let dy = -1; dy <= 1 && v; dy++) {
        for (let dx = -1; dx <= 1 && v; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h || !mask[ny * w + nx]) v = 0;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}
