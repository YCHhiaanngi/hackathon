// 左侧实时视频预览：镜像显示 + 目标框/取景辅助叠加。
// 叠加元素仅供演示观众与低视力用户参考，完成任务不依赖它们（aria-hidden）。

import { useEffect, useRef } from 'react';
import type { TargetBox } from '../shared/types';
import { CONFIG } from '../config';

interface Props {
  attachVideo: (el: HTMLVideoElement | null) => void;
  /** 原始图像坐标下的目标框；显示时做水平镜像换算。 */
  box: TargetBox | null;
  cameraStatus: 'idle' | 'requesting' | 'ready' | 'error';
  isMock: boolean;
  degraded: boolean;
}

export function VideoPreview({ attachVideo, box, cameraStatus, isMock, degraded }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    attachVideo(videoRef.current);
    return () => attachVideo(null);
  }, [attachVideo]);

  // 预览是镜像显示：原始图像坐标 x 需要换算为显示坐标。
  const displayBox = box ? { ...box, x: 1 - box.x - box.width } : null;
  const tol = CONFIG.guide.centerTolerance;

  return (
    <section className="preview" aria-label="摄像头预览区">
      <div className="preview-frame">
        <video
          ref={videoRef}
          className="preview-video"
          autoPlay
          playsInline
          muted
          aria-hidden="true"
        />
        <div className="preview-overlay" aria-hidden="true">
          {/* 取景辅助区域 */}
          <div
            className="guide-zone"
            style={{
              left: `${(CONFIG.guide.centerX - tol) * 100}%`,
              top: `${(CONFIG.guide.centerY - tol) * 100}%`,
              width: `${tol * 2 * 100}%`,
              height: `${tol * 2 * 100}%`,
            }}
          />
          {/* 目标框（镜像后的显示坐标） */}
          {displayBox && (
            <div
              className="target-box"
              style={{
                left: `${displayBox.x * 100}%`,
                top: `${displayBox.y * 100}%`,
                width: `${displayBox.width * 100}%`,
                height: `${displayBox.height * 100}%`,
              }}
            />
          )}
        </div>
        {isMock && (
          <div className="mock-banner" role="note">
            演示模式：模拟引导，不分析当前摄像头画面
          </div>
        )}
        {degraded && (
          <div className="degraded-banner" role="note">
            响应较慢：已切换为停稳后分析
          </div>
        )}
        {cameraStatus === 'idle' && <div className="preview-placeholder">摄像头未开启</div>}
        {cameraStatus === 'requesting' && (
          <div className="preview-placeholder">等待摄像头授权…</div>
        )}
        {cameraStatus === 'error' && <div className="preview-placeholder">摄像头不可用</div>}
      </div>
    </section>
  );
}
