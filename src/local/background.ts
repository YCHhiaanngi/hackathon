// 固定背景辅助模式的前景提取：基准建模、差分、去噪、连通区域。
// 这是真实图像处理，但不是语义上的衣物识别——候选区域可能包含手、身体或背景变化。

import { CONFIG } from '../config';
import type { Raster } from './imageUtils';
import { downsample } from './imageUtils';

export interface Grid {
  width: number;
  height: number;
}

export interface Baseline {
  grid: Grid;
  /** 每格平均 RGB（采集期间多帧平均），长度 = w*h*3。 */
  mean: Float32Array;
  createdAt: number;
}

/** 在分析网格上累计基准背景。帧间运动大的帧会被拒绝。 */
export class BaselineBuilder {
  private acc: Float32Array | null = null;
  private count = 0;
  private lastDiff: Uint8Array | null = null;
  readonly grid: Grid;

  constructor(readonly gridWidth: number = CONFIG.localVision.gridWidth) {
    this.grid = { width: gridWidth, height: 0 }; // height 在首帧确定
  }

  get progress(): number {
    return Math.min(1, this.count / CONFIG.localVision.baselineFrames);
  }

  get done(): boolean {
    return this.count >= CONFIG.localVision.baselineFrames;
  }

  /** 返回是否采纳了该帧（运动过大的帧不采纳）。 */
  addFrame(raster: Raster): boolean {
    const small = downsample(raster, this.gridWidth);
    const { width, height } = small;
    if (!this.acc) {
      this.grid.height = height;
      this.acc = new Float32Array(width * height * 3);
    }
    const diff = diffFromMean(small, this.acc, this.count);
    if (this.lastDiff && this.count > 0) {
      const motion = ratioOf(diff, this.lastDiff);
      if (motion > CONFIG.localVision.baselineMaxMotion) {
        this.lastDiff = diff;
        return false; // 用户在移动，等待画面稳定
      }
    }
    for (let i = 0; i < width * height; i++) {
      this.acc[i * 3] = (this.acc[i * 3] ?? 0) + (small.data[i * 4] ?? 0);
      this.acc[i * 3 + 1] = (this.acc[i * 3 + 1] ?? 0) + (small.data[i * 4 + 1] ?? 0);
      this.acc[i * 3 + 2] = (this.acc[i * 3 + 2] ?? 0) + (small.data[i * 4 + 2] ?? 0);
    }
    this.count += 1;
    this.lastDiff = diff;
    return true;
  }

  build(): Baseline | null {
    if (!this.acc || !this.done) return null;
    const mean = new Float32Array(this.acc.length);
    for (let i = 0; i < this.acc.length; i++) {
      mean[i] = (this.acc[i] ?? 0) / this.count;
    }
    return { grid: { ...this.grid }, mean, createdAt: Date.now() };
  }
}

function diffFromMean(raster: Raster, acc: Float32Array, count: number): Uint8Array {
  const n = raster.width * raster.height;
  const diff = new Uint8Array(n);
  if (count === 0) return diff;
  for (let i = 0; i < n; i++) {
    const dr = (raster.data[i * 4] ?? 0) - (acc[i * 3] ?? 0) / count;
    const dg = (raster.data[i * 4 + 1] ?? 0) - (acc[i * 3 + 1] ?? 0) / count;
    const db = (raster.data[i * 4 + 2] ?? 0) - (acc[i * 3 + 2] ?? 0) / count;
    if (Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db)) > CONFIG.localVision.diffThreshold) {
      diff[i] = 1;
    }
  }
  return diff;
}

function ratioOf(a: Uint8Array, b: Uint8Array): number {
  let changed = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) changed++;
  }
  return n === 0 ? 0 : changed / n;
}

export interface ForegroundResult {
  grid: Grid;
  /** 去噪后的前景掩膜（0/1），长度 = w*h。 */
  mask: Uint8Array;
  /** 形态学处理前的原始差分掩膜，用于帧间运动估计。 */
  rawMask: Uint8Array;
  /** 差分像素占整幅画面的比例（用于背景失效判断）。 */
  changedRatio: number;
  /** 背景区域（非前景）平均亮度 0~1。 */
  backgroundLuminance: number;
  /** 全帧平均亮度 0~1（整体变暗时前景占比可能极高，此时背景亮度不可用）。 */
  frameLuminance: number;
  /** 全帧高亮像素占比（反光判断）。 */
  glareRatio: number;
}

/** 与冻结的基准背景差分，形态学开运算去噪、闭运算补洞。基准在会话内冻结。 */
export function extractForeground(raster: Raster, baseline: Baseline): ForegroundResult {
  const small = downsample(raster, baseline.grid.width);
  const { width, height } = small;
  const n = width * height;
  const raw = new Uint8Array(n);
  let changed = 0;
  let bgLumSum = 0;
  let bgCount = 0;
  let frameLumSum = 0;
  let glare = 0;

  for (let i = 0; i < n; i++) {
    const r = small.data[i * 4] ?? 0;
    const g = small.data[i * 4 + 1] ?? 0;
    const b = small.data[i * 4 + 2] ?? 0;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    frameLumSum += lum;
    const dr = r - (baseline.mean[i * 3] ?? 0);
    const dg = g - (baseline.mean[i * 3 + 1] ?? 0);
    const db = b - (baseline.mean[i * 3 + 2] ?? 0);
    const isFg = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db)) > CONFIG.localVision.diffThreshold ? 1 : 0;
    raw[i] = isFg;
    if (isFg) {
      changed++;
    } else {
      bgLumSum += lum;
      bgCount++;
    }
    if (r > 242 && g > 242 && b > 242) glare++;
  }

  const opened = morphology(raw, width, height, 'open');
  const mask = morphology(opened, width, height, 'close');

  return {
    grid: { width, height },
    mask,
    rawMask: raw,
    changedRatio: n === 0 ? 0 : changed / n,
    backgroundLuminance: bgCount === 0 ? 1 : bgLumSum / bgCount,
    frameLuminance: n === 0 ? 1 : frameLumSum / n,
    glareRatio: n === 0 ? 0 : glare / n,
  };
}

function morphology(src: Uint8Array, w: number, h: number, mode: 'open' | 'close'): Uint8Array {
  const dilate = (s: Uint8Array): Uint8Array => {
    const out = new Uint8Array(s.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let dy = -1; dy <= 1 && !v; dy++) {
          for (let dx = -1; dx <= 1 && !v; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h && s[ny * w + nx]) v = 1;
          }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  };
  const erode = (s: Uint8Array): Uint8Array => {
    const out = new Uint8Array(s.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = 1;
        for (let dy = -1; dy <= 1 && v; dy++) {
          for (let dx = -1; dx <= 1 && v; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h || !s[ny * w + nx]) v = 0;
          }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  };
  return mode === 'open' ? dilate(erode(src)) : erode(dilate(src));
}

export interface Candidate {
  /** 网格坐标下的包围盒。 */
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
}

/** 连通区域分析（并查集两遍扫描），按面积降序。 */
export function findCandidates(mask: Uint8Array, w: number, h: number): Candidate[] {
  const labels = new Int32Array(mask.length).fill(-1);
  const parent: number[] = [];
  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) r = parent[r] ?? r;
    while (parent[a] !== a) {
      const next = parent[a] ?? a;
      parent[a] = r;
      a = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  let nextLabel = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      const left = x > 0 ? labels[i - 1] ?? -1 : -1;
      const up = y > 0 ? labels[i - w] ?? -1 : -1;
      if (left >= 0 && up >= 0) {
        labels[i] = left;
        union(left, up);
      } else if (left >= 0) {
        labels[i] = left;
      } else if (up >= 0) {
        labels[i] = up;
      } else {
        labels[i] = nextLabel;
        parent[nextLabel] = nextLabel;
        nextLabel++;
      }
    }
  }

  const stats = new Map<number, Candidate>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const label = labels[i] ?? -1;
      if (label < 0) continue;
      const root = find(label);
      let c = stats.get(root);
      if (!c) {
        c = { x, y, width: 1, height: 1, area: 0 };
        stats.set(root, c);
      }
      c.area++;
      if (x < c.x) c.x = x;
      if (y < c.y) c.y = y;
      if (x + 1 - c.x > c.width) c.width = x + 1 - c.x;
      if (y + 1 - c.y > c.height) c.height = y + 1 - c.y;
    }
  }

  return [...stats.values()].sort((a, b) => b.area - a.area);
}
