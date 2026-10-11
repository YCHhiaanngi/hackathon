// 抽帧：从 video 元素抓取当前帧，缩放到长边 640，输出 JPEG Blob。
// 不录制、不保存整段视频；帧只在请求生命周期内存在。

import { CONFIG } from '../config';

export interface CapturedFrame {
  blob: Blob;
  width: number;
  height: number;
  /** 采集时刻（毫秒时间戳），随请求发送并由服务端原样返回。 */
  capturedAt: number;
}

const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');

/** 视频未就绪（无数据/尺寸为 0）时返回 null，由调用方跳过本次采样。 */
export async function captureFrame(video: HTMLVideoElement): Promise<CapturedFrame | null> {
  if (!ctx) return null;
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  if (srcW === 0 || srcH === 0) return null;

  const scale = Math.min(1, CONFIG.capture.maxEdge / Math.max(srcW, srcH));
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));
  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(video, 0, 0, width, height);

  // capturedAt 取绘制完成时刻，尽量贴近“分析所用的画面”。
  const capturedAt = Date.now();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', CONFIG.capture.jpegQuality),
  );
  if (!blob) return null;
  return { blob, width, height, capturedAt };
}
