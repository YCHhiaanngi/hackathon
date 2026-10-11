// 图像工具：与 DOM 解耦的光栅结构与基础换算，便于浏览器与 Node 测试复用。

/** 与 ImageData 同构的最小光栅结构。 */
export interface Raster {
  width: number;
  height: number;
  /** RGBA，长度 = width * height * 4 */
  data: Uint8ClampedArray;
}

/** 生成纯色光栅（测试与占位用）。 */
export function solidRaster(width: number, height: number, rgb: [number, number, number]): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** 在光栅上填充一个矩形区域（测试用）。 */
export function fillRect(
  raster: Raster,
  x: number,
  y: number,
  width: number,
  height: number,
  rgb: [number, number, number],
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(raster.width, Math.ceil(x + width));
  const y1 = Math.min(raster.height, Math.ceil(y + height));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const i = (yy * raster.width + xx) * 4;
      raster.data[i] = rgb[0];
      raster.data[i + 1] = rgb[1];
      raster.data[i + 2] = rgb[2];
    }
  }
}

/** 给光栅叠加确定性伪随机噪声（模拟摄像头噪声，测试用）。 */
export function addNoise(raster: Raster, amplitude: number, seed = 42): void {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
  for (let i = 0; i < raster.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = raster.data[i + c] ?? 0;
      raster.data[i + c] = Math.min(255, Math.max(0, v + rand() * 2 * amplitude));
    }
  }
}

/** 浏览器环境：JPEG/PNG Blob → Raster。测试环境不调用。 */
export async function decodeBlob(blob: Blob): Promise<Raster> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: imageData.width, height: imageData.height, data: imageData.data };
  } finally {
    bitmap.close();
  }
}

/** 最近邻降采样到目标宽度（保持纵横比）。 */
export function downsample(src: Raster, targetWidth: number): Raster {
  if (src.width <= targetWidth) return src;
  const scale = targetWidth / src.width;
  const w = targetWidth;
  const h = Math.max(1, Math.round(src.height * scale));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / scale));
      const si = (sy * src.width + sx) * 4;
      const di = (y * w + x) * 4;
      data[di] = src.data[si] ?? 0;
      data[di + 1] = src.data[si + 1] ?? 0;
      data[di + 2] = src.data[si + 2] ?? 0;
      data[di + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** 相对亮度 0~1。 */
export function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** RGB(0~255) → { h: 0~360, s: 0~1, l: 0~1 } */
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) {
    h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  } else if (max === gn) {
    h = ((bn - rn) / d + 2) * 60;
  } else {
    h = ((rn - gn) / d + 4) * 60;
  }
  return { h, s, l };
}
