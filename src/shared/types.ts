// ts类型约定
// 与 docs/api-contract.md 一一对应。修改字段前先更新契约文档。

export type TargetState = 'none' | 'single' | 'multiple' | 'uncertain';

export type Quality = 'ok' | 'too_dark' | 'blurred' | 'glare' | 'unknown';

export type Framing = 'usable' | 'too_small' | 'cropped' | 'unknown';

/** 归一化目标框：相对于上传图像（未经镜像），原点左上，取值 0~1。 */
export interface TargetBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LocateResponse {
  sessionId: string;
  frameId: number;
  capturedAt: number;
  targetState: TargetState;
  targetBox: TargetBox | null;
  objectName: string | null;
  quality: Quality;
  framing: Framing;
  colorReady: boolean;
}

export type ColorStatus = 'ok' | 'uncertain';

export type Pattern = 'solid' | 'striped' | 'checked' | 'mixed' | 'unknown';

export interface ColorResultData {
  objectName: string | null;
  primaryColor: string;
  secondaryColors: string[];
  pattern: Pattern;
}

export interface ColorResponse {
  sessionId: string;
  frameId: number;
  capturedAt: number;
  status: ColorStatus;
  result: ColorResultData | null;
  message: string;
  retryAdvice: string | null;
}

/** 服务端约定 + 前端自行归类的错误码。 */
export type ApiErrorCode =
  | 'INVALID_IMAGE'
  | 'IMAGE_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'MALFORMED_RESPONSE'
  | 'ABORTED';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly sessionId?: string;
  readonly frameId?: number;

  constructor(code: ApiErrorCode, message: string, ids?: { sessionId?: string; frameId?: number }) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    if (ids?.sessionId !== undefined) this.sessionId = ids.sessionId;
    if (ids?.frameId !== undefined) this.frameId = ids.frameId;
  }
}

/** 适配函数的入参。image 为 JPEG Blob；signal 用于取消。 */
export interface LocateRequest {
  image: Blob;
  sessionId: string;
  frameId: number;
  capturedAt: number;
  signal: AbortSignal;
}

export interface RecognizeColorRequest extends LocateRequest {
  targetBox: TargetBox;
}
