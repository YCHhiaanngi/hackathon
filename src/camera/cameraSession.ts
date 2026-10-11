// 摄像头会话：只申请视频，不录音、不保存整段视频。
// 负责权限/设备错误的归类，以及资源释放。

export type CameraStatus = 'idle' | 'requesting' | 'ready' | 'error';

export type CameraErrorKind = 'denied' | 'not_found' | 'busy' | 'not_ready' | 'unknown';

export class CameraError extends Error {
  readonly kind: CameraErrorKind;
  constructor(kind: CameraErrorKind, message: string) {
    super(message);
    this.name = 'CameraError';
    this.kind = kind;
  }
}

export class CameraSession {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private onEnded: (() => void) | null = null;

  /** 绑定用于预览的 video 元素（由 React 渲染）。 */
  attach(video: HTMLVideoElement): void {
    this.video = video;
    if (this.stream) {
      video.srcObject = this.stream;
    }
  }

  detach(video: HTMLVideoElement): void {
    if (this.video === video) {
      this.video = null;
    }
    if (video.srcObject) {
      video.srcObject = null;
    }
  }

  get active(): boolean {
    return this.stream !== null;
  }

  /** 设备被拔出/系统回收时回调（用于界面提示）。 */
  setOnEnded(cb: (() => void) | null): void {
    this.onEnded = cb;
  }

  async start(): Promise<void> {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError('unknown', '当前浏览器不支持摄像头。');
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      throw classifyGetUserMediaError(err);
    }

    this.stream = stream;
    const track = stream.getVideoTracks()[0];
    if (track) {
      track.addEventListener('ended', () => this.onEnded?.());
    }

    if (this.video) {
      this.video.srcObject = stream;
      try {
        await this.video.play();
      } catch {
        // 自动播放失败不视为致命错误，画面会在用户交互后恢复。
      }
    }
  }

  stop(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
    }
  }
}

function classifyGetUserMediaError(err: unknown): CameraError {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError('denied', '摄像头权限被拒绝。');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraError('not_found', '没有找到可用的摄像头设备。');
    case 'NotReadableError':
    case 'TrackStartError':
      return new CameraError('busy', '摄像头被占用或无法读取。');
    case 'AbortError':
      return new CameraError('not_ready', '摄像头尚未就绪。');
    default:
      return new CameraError('unknown', err instanceof Error ? err.message : '摄像头开启失败。');
  }
}
