// 方向映射：集中管理“图像坐标 ↔ 用户动作方向”的换算与校准。
// 组件不得自行判断左右。
//
// 约定：
// - 后端坐标基于未经镜像的上传图像（原点在左上，x 向右、y 向下）。
// - 预览镜像只是 CSS 显示设置，不改变任何分析坐标。
// - 语音中的左右以用户身体为参照。用户面对固定摄像头时，
//   用户右手一侧通常对应原始图像左侧（horizontal = 'inverted'），
//   但不同设备/驱动可能不同，必须通过校准确认，未确认前不输出左右指令。

import { CONFIG } from '../config';
import type { TargetBox } from '../shared/types';

export type AxisMapping = 'same' | 'inverted';

export interface DirectionMapping {
  /** null = 未确认 */
  horizontal: AxisMapping | null;
  vertical: AxisMapping | null;
}

export type UserDirection = 'left' | 'right' | 'up' | 'down';

export const EMPTY_MAPPING: DirectionMapping = { horizontal: null, vertical: null };

export function isCalibrated(m: DirectionMapping): boolean {
  return m.horizontal !== null && m.vertical !== null;
}

export function boxCenter(box: TargetBox): { cx: number; cy: number } {
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2 };
}

/**
 * 把“目标框需要发生的图像位移”翻译为用户的移动方向。
 * dxImage > 0 表示目标框需要向原始图像右侧移动。
 * 未校准的轴返回 null，调用方应改用不含方向的提示。
 */
export function imageDeltaToUserDirections(
  dxImage: number,
  dyImage: number,
  mapping: DirectionMapping,
): { horizontal: 'left' | 'right' | null; vertical: 'up' | 'down' | null } {
  let horizontal: 'left' | 'right' | null = null;
  if (dxImage !== 0 && mapping.horizontal !== null) {
    // 图像右移 ↔ 用户向哪只手移动，取决于该设备实测的映射。
    const imageRightMeansUserRight = mapping.horizontal === 'same';
    const needImageRight = dxImage > 0;
    horizontal = needImageRight === imageRightMeansUserRight ? 'right' : 'left';
  }
  let vertical: 'up' | 'down' | null = null;
  if (dyImage !== 0 && mapping.vertical !== null) {
    // 图像 y 向下；dyImage > 0 表示目标框需要向图像下方移动。
    const imageDownMeansUserDown = mapping.vertical === 'same';
    const needImageDown = dyImage > 0;
    vertical = needImageDown === imageDownMeansUserDown ? 'down' : 'up';
  }
  return { horizontal, vertical };
}

export type CalibrationStep = 'idle' | 'right' | 'up';

export type CalibrationEvent =
  | { type: 'step-started'; step: 'right' | 'up' }
  | { type: 'completed'; mapping: DirectionMapping }
  | { type: 'failed'; reason: 'timeout' | 'lost' | 'unclear' };

/**
 * 简短方向校准：
 * 1. 请用户把衣物向自己的右手方向轻移一点，观察图像中目标中心变化确认水平映射；
 * 2. 请用户把衣物向上移动一点，确认垂直映射。
 * 变化不明显、目标丢失或方向不确定时返回 failed，调用方不得宣布校准成功。
 */
export class DirectionCalibrator {
  private step: CalibrationStep = 'idle';
  private lastSample: { cx: number; cy: number } | null = null;
  private stepStartedAt = 0;
  private mapping: DirectionMapping = { ...EMPTY_MAPPING };

  get currentStep(): CalibrationStep {
    return this.step;
  }

  get running(): boolean {
    return this.step === 'right' || this.step === 'up';
  }

  begin(startBox: TargetBox): CalibrationEvent {
    this.mapping = { ...EMPTY_MAPPING };
    this.lastSample = boxCenter(startBox);
    this.step = 'right';
    this.stepStartedAt = Date.now();
    return { type: 'step-started', step: 'right' };
  }

  /** 目标丢失时调用。 */
  notifyLost(): CalibrationEvent | null {
    if (!this.running) return null;
    this.reset();
    return { type: 'failed', reason: 'lost' };
  }
  /**
   * 逐帧观察目标中心。使用相邻两次采样的位移而非相对基线的累计位移：
   * 用户的水平移动可能延续到下一步开始之后，累计位移会污染垂直步的方向判定。
   * 位移不明显或方向不占优时继续等待；超过 calibrationTimeoutMs 仍未确认才失败。
   */
  observe(box: TargetBox): CalibrationEvent | null {
    if (!this.running || !this.lastSample) return null;

    if (Date.now() - this.stepStartedAt > CONFIG.direction.calibrationTimeoutMs) {
      this.reset();
      return { type: 'failed', reason: 'timeout' };
    }

    const { cx, cy } = boxCenter(box);
    const dx = cx - this.lastSample.cx;
    const dy = cy - this.lastSample.cy;
    this.lastSample = { cx, cy };
    // 单次采样间最小位移：低于该值视为还没动，继续等。
    const minStep = CONFIG.direction.calibrationMinDelta / 2;

    if (this.step === 'right') {
      if (Math.abs(dx) < minStep) return null;
      if (Math.abs(dx) < Math.abs(dy) * 2) return null; // 这帧以垂直移动为主，继续等
      // 用户向自己的右手移动：图像中向右 = same，向左 = inverted。
      this.mapping.horizontal = dx > 0 ? 'same' : 'inverted';
      this.step = 'up';
      this.stepStartedAt = Date.now();
      return { type: 'step-started', step: 'up' };
    }

    // step === 'up'
    if (Math.abs(dy) < minStep) return null;
    if (Math.abs(dy) < Math.abs(dx) * 2) return null; // 这帧以水平移动为主，继续等
    // 用户向上移动：图像中向上（dy<0）= same，向下 = inverted。
    this.mapping.vertical = dy < 0 ? 'same' : 'inverted';
    const mapping: DirectionMapping = { ...this.mapping };
    this.reset();
    return { type: 'completed', mapping };
  }

  private reset(): void {
    this.step = 'idle';
    this.lastSample = null;
  }
}
