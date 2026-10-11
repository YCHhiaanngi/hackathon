// HTTP 传输层：multipart 上传、超时、统一错误归类。
// 页面组件不得直接调用本模块，统一走 client.ts 的适配函数。

import { CONFIG } from '../config';
import { ApiError } from '../shared/types';
import type { ApiErrorCode } from '../shared/types';

const STATUS_TO_CODE: Record<number, ApiErrorCode> = {
  400: 'INVALID_IMAGE',
  413: 'IMAGE_TOO_LARGE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  502: 'UPSTREAM_ERROR',
  504: 'UPSTREAM_TIMEOUT',
};

interface ErrorBody {
  error?: { code?: string; message?: string; sessionId?: string; frameId?: number };
}

function isErrorCode(value: string): value is ApiErrorCode {
  return [
    'INVALID_IMAGE',
    'IMAGE_TOO_LARGE',
    'RATE_LIMITED',
    'INTERNAL_ERROR',
    'UPSTREAM_ERROR',
    'UPSTREAM_TIMEOUT',
  ].includes(value);
}

/**
 * 以 multipart/form-data 提交一帧图像与表单字段，返回解析后的 JSON。
 * 网络中断、跨域失败、非 JSON、字段缺失、超时都会被归类为 ApiError。
 */
export async function postImageJson<T>(
  path: string,
  fields: Record<string, string>,
  image: Blob,
  signal: AbortSignal,
  validate: (data: unknown) => data is T,
): Promise<T> {
  if (!CONFIG.apiBaseUrl) {
    throw new ApiError('INTERNAL_ERROR', '未配置 VITE_API_BASE_URL，无法调用真实服务。');
  }

  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  form.append('image', image, 'frame.jpg');

  // 用户取消与超时共用一路信号；超时也归类为 UPSTREAM_TIMEOUT。
  const timeoutSignal = AbortSignal.timeout(CONFIG.requestTimeoutMs);
  const combined = AbortSignal.any([signal, timeoutSignal]);

  let response: Response;
  try {
    response = await fetch(`${CONFIG.apiBaseUrl}${path}`, {
      method: 'POST',
      body: form,
      signal: combined,
    });
  } catch (err) {
    if (signal.aborted) {
      throw new ApiError('ABORTED', '请求已取消');
    }
    if (timeoutSignal.aborted) {
      throw new ApiError('UPSTREAM_TIMEOUT', '请求超时');
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError('NETWORK_ERROR', `网络请求失败：${reason}`);
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ApiError('MALFORMED_RESPONSE', '服务返回了非 JSON 内容');
  }

  if (!response.ok) {
    const body = data as ErrorBody;
    const rawCode = typeof body?.error?.code === 'string' ? body.error.code : undefined;
    const code: ApiErrorCode =
      rawCode && isErrorCode(rawCode) ? rawCode : (STATUS_TO_CODE[response.status] ?? 'INTERNAL_ERROR');
    const message = typeof body?.error?.message === 'string' ? body.error.message : `服务错误（HTTP ${response.status}）`;
    throw new ApiError(code, message, {
      ...(typeof body?.error?.sessionId === 'string' ? { sessionId: body.error.sessionId } : {}),
      ...(typeof body?.error?.frameId === 'number' ? { frameId: body.error.frameId } : {}),
    });
  }

  if (!validate(data)) {
    throw new ApiError('MALFORMED_RESPONSE', '服务响应缺少必要字段');
  }
  return data;
}
