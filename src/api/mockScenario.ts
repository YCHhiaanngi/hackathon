// Mock 场景时钟：定位 Mock 与颜色 Mock 共用，保证脚本一致。
// Mock 不分析摄像头画面，只按时间脚本回放，结构与真实接口一致。

export type MockScenarioId = 'normal' | 'multiple' | 'dark' | 'blurred' | 'slow' | 'lost';

export const MOCK_SCENARIO_LABELS: Record<MockScenarioId, string> = {
  normal: '正常流程（偏移→调整→稳定→识别→换一件）',
  multiple: '多目标',
  dark: '暗光',
  blurred: '模糊',
  slow: '慢响应（触发降级与过期丢弃）',
  lost: '目标频繁丢失',
};

interface ScenarioState {
  sessionId: string;
  scenario: MockScenarioId;
  startedAt: number;
  /** 颜色 Mock 用来区分“换了一件衣服”的轮次。 */
  colorEpoch: number;
}

let state: ScenarioState | null = null;
let currentScenario: MockScenarioId = 'normal';

export function setMockScenario(scenario: MockScenarioId): void {
  currentScenario = scenario;
  state = null; // 下一个请求重置时钟
}

export function getMockScenario(): MockScenarioId {
  return currentScenario;
}

/** 每个 sessionId 第一次看到时建立时钟；换 session 重新计时。 */
export function scenarioClock(sessionId: string): { elapsedMs: number; scenario: MockScenarioId } {
  if (!state || state.sessionId !== sessionId || state.scenario !== currentScenario) {
    state = { sessionId, scenario: currentScenario, startedAt: Date.now(), colorEpoch: 0 };
  }
  return { elapsedMs: Date.now() - state.startedAt, scenario: state.scenario };
}

/** 正常脚本一轮的时长（毫秒）：识别完成后清空→换一件衣服再来。 */
export const NORMAL_CYCLE_MS = 48000;

/** 正常脚本中第二件衣物出现的时间点（毫秒）。 */
export const SECOND_GARMENT_MS = 24500;

export function mockLatencyMs(scenario: MockScenarioId): number {
  if (scenario === 'slow') return 2500; // 故意超过 locateResultMaxAgeMs
  return 200 + Math.floor(Math.random() * 200);
}

export function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('已取消', 'AbortError'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
