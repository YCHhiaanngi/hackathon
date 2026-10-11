// 颜色 Mock：结构与 /api/color/analyze 一致，不分析真实画面。

import type { ColorResponse, RecognizeColorRequest } from '../shared/types';
import { NORMAL_CYCLE_MS, SECOND_GARMENT_MS, delayWithSignal, mockLatencyMs, scenarioClock } from './mockScenario';

export async function mockRecognizeColor(req: RecognizeColorRequest): Promise<ColorResponse> {
  const { elapsedMs, scenario } = scenarioClock(req.sessionId);
  await delayWithSignal(mockLatencyMs(scenario) + 150, req.signal);

  const base = {
    sessionId: req.sessionId,
    frameId: req.frameId,
    capturedAt: req.capturedAt,
  };

  // 暗光/模糊场景下颜色能力给出 uncertain（正常流程不会触发到这里）。
  if (scenario === 'dark' || scenario === 'blurred') {
    return {
      ...base,
      status: 'uncertain',
      result: null,
      message: '画面不够清晰，暂时无法确定颜色。',
      retryAdvice: scenario === 'dark' ? '请打开附近的灯后再试。' : '请保持衣物不动后再试。',
    };
  }

  // 正常脚本：第二件衣物出现前是第一件（蓝色上衣），之后是第二件（红色条纹 T 恤）。
  const second = scenario === 'normal' && elapsedMs % NORMAL_CYCLE_MS >= SECOND_GARMENT_MS;
  const result = second
    ? {
        objectName: 'T 恤',
        primaryColor: '红色',
        secondaryColors: ['黑色'],
        pattern: 'striped' as const,
      }
    : {
        objectName: '上衣',
        primaryColor: '蓝色',
        secondaryColors: ['白色'],
        pattern: 'solid' as const,
      };

  return {
    ...base,
    status: 'ok',
    result,
    message: `这是一件${result.primaryColor}的${result.objectName ?? '衣物'}。`,
    retryAdvice: null,
  };
}
