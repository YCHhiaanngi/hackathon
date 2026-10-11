// 控制区：开始 / 暂停 / 继续 / 停止 / 重听，全部为原生 button，键盘与读屏可操作。

import type { Phase } from '../guidance/engine';

interface Props {
  phase: Phase;
  canRepeat: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onRepeat: () => void;
}

const RUNNING_PHASES: Phase[] = ['preparing', 'searching', 'adjusting', 'hold_steady', 'recognizing', 'announced'];

export function ControlsBar({ phase, canRepeat, onStart, onPause, onResume, onStop, onRepeat }: Props) {
  const running = RUNNING_PHASES.includes(phase);
  const paused = phase === 'paused';
  const active = running || paused || phase === 'awaiting_permission';

  return (
    <div className="controls" role="group" aria-label="识别控制">
      {(phase === 'idle' || phase === 'error') && (
        <button type="button" className="btn btn-primary" onClick={onStart}>
          开始识别
        </button>
      )}
      {running && (
        <button type="button" className="btn" onClick={onPause}>
          暂停
        </button>
      )}
      {paused && (
        <button type="button" className="btn btn-primary" onClick={onResume}>
          继续
        </button>
      )}
      {active && (
        <button type="button" className="btn btn-danger" onClick={onStop}>
          停止
        </button>
      )}
      <button type="button" className="btn" onClick={onRepeat} disabled={!canRepeat}>
        重听
      </button>
      <span className="shortcut-hint">快捷键：空格 = 开始 / 暂停 / 继续</span>
    </div>
  );
}
