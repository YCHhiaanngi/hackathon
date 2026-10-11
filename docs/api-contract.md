# 接口契约（v0.2）

> 本文件是前端与能力侧的共享契约。任何一方修改字段前需要先在这里更新并通知对方。
> 仓库中另有占位文件 `src/api/API.md`，仅指向本文件。

## 运行位置（v0.2 更新）

同一契约有三种实现，由前端 `VITE_API_MODE` 切换，**数据结构完全一致**：

| 模式 | 运行位置 | 说明 |
| --- | --- | --- |
| `local`（默认） | 浏览器本地 | 固定背景辅助模式：差分+连通区域定位、掩膜内颜色分类。无网络、无密钥。`objectName` 恒为 null，`pattern` 恒为 `unknown` |
| `http` | 远程 HTTPS 服务 | 按本契约第 1/2 节实现 |
| `mock` | 浏览器本地脚本 | 演示模式，回放脚本，不分析真实画面 |

本地模式的附加约定：
- 会话开始需要约 3 秒基准背景采集（用户先把衣物移出画面）。
- 基准背景在会话内冻结，运行中不做失效重校准；摄像头移动或光照剧变后识别异常时，用户停止后重新开始即重新采集。
- `colorReady` 为 true 仅当：单一候选、面积足够、未贴边、无明显运动、光照正常。

## 0. 总则

- 前端统一通过两个适配函数调用能力，页面组件不直接发起网络请求：
  - `locateTarget({ image, sessionId, frameId, capturedAt, signal })`
  - `recognizeColor({ image, sessionId, frameId, capturedAt, targetBox, signal })`
- `sessionId`：每次“开始识别”生成的会话标识，UUID。切换摄像头或重新开始时更换。
- `frameId`：会话内从 1 开始递增的整数。
- `capturedAt`：帧采集时刻的客户端时间戳（毫秒，Unix epoch）。服务端必须原样返回，前端用它计算结果年龄。
- `image`：JPEG，长边不超过 640 像素（前端默认配置）。坐标均基于**未经前端镜像**的上传图像。
- 两个接口均支持通过 `AbortSignal` 取消；取消不算错误。

## 1. 快速定位 POST /api/vision/locate

请求类型 `multipart/form-data`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| image | file | 当前帧（JPEG） |
| sessionId | string | 会话标识 |
| frameId | string | 会话内递增整数（表单字段按字符串传输，服务端按整数解析） |
| capturedAt | string | 采集时刻时间戳（毫秒），原样返回 |

成功响应（200，JSON）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| sessionId | string | 原样返回 |
| frameId | number | 原样返回 |
| capturedAt | number | 原样返回 |
| targetState | `"none" \| "single" \| "multiple" \| "uncertain"` | 目标状态 |
| targetBox | object \| null | 目标框，无可靠目标时为 null |
| objectName | string \| null | 已判断出的物品名称 |
| quality | `"ok" \| "too_dark" \| "blurred" \| "glare" \| "unknown"` | 画面质量 |
| framing | `"usable" \| "too_small" \| "cropped" \| "unknown"` | 取景状态 |
| colorReady | boolean | 目标区域是否足以进入颜色识别 |

`targetBox`：

- `x`、`y`、`width`、`height` 均为 0～1 的归一化数值。
- 坐标相对于实际提交的图像，原点在左上角，x 向右、y 向下。
- 范围必须有效：`0 ≤ x < 1`，`0 ≤ y < 1`，`x + width ≤ 1`，`y + height ≤ 1`，`width > 0`，`height > 0`。
- 无可靠目标时返回 `null`。

约束：

- 后端必须识别“哪一件是目标衣物”，**不允许用整幅画面的平均颜色推断位置**。
- 无法判断哪件是目标时返回 `multiple` 或 `uncertain`，不得编造用户意图。
- 如果现有后端只能返回颜色名称，则它**不足以支持真实对准引导**，需要补定位能力。

## 2. 颜色识别 POST /api/color/analyze

请求类型 `multipart/form-data`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| image | file | 与 targetBox 对应的**同一张**原始采样帧 |
| sessionId / frameId / capturedAt | string | 同上，原样返回 |
| targetBox | string | JSON 字符串，归一化坐标，如 `{"x":0.3,"y":0.2,"width":0.4,"height":0.5}` |

约束：不得用上一帧的 targetBox 裁剪一张已经变化的新图像。

成功响应（200，JSON）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| sessionId / frameId / capturedAt | — | 原样返回 |
| status | `"ok" \| "uncertain"` | 识别状态 |
| result | object \| null | 成功时为结果对象；不确定时为 null |
| message | string | 简短中文结果说明，可直接播报 |
| retryAdvice | string \| null | 重试建议 |

`result`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| objectName | string \| null | 物品名称 |
| primaryColor | string | 中文主要颜色名称 |
| secondaryColors | string[] | 其他主要颜色 |
| pattern | `"solid" \| "striped" \| "checked" \| "mixed" \| "unknown"` | 图案 |

不返回未经验证的准确率百分比。

## 3. 统一错误结构

两个接口的错误响应均为：

```json
{ "error": { "code": "RATE_LIMITED", "message": "请求过于频繁", "sessionId": "…", "frameId": 12 } }
```

- `error.code`、(`error.message`) 必填；`sessionId`、`frameId` 能取得就带上。
- 约定的 `error.code`：

| HTTP | code |
| --- | --- |
| 400 | `INVALID_IMAGE` |
| 413 | `IMAGE_TOO_LARGE` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` |
| 502 | `UPSTREAM_ERROR` |
| 504 | `UPSTREAM_TIMEOUT` |

- 前端另外自行归类：`NETWORK_ERROR`（断网/跨域失败）、`MALFORMED_RESPONSE`（非 JSON 或字段缺失）、`ABORTED`（本地主动取消）。这些不是服务端返回的。
- 前端必须处理网络中断、跨域失败、非 JSON 响应、字段缺失和超时，页面不得崩溃。

## 4. 前端使用时序约束（供后端理解）

- 定位采样间隔初始 500ms，可配置；同时最多一个定位请求，不堆积。
- 颜色识别同时最多一个请求，仅在目标可识别且稳定后触发，不逐帧调用。
- 定位结果年龄（`Date.now() - capturedAt`）超过 1500ms（默认值，集中配置）不用于方向播报。
- 持续过慢时前端进入“停稳后分析”降级流程。
- 颜色结果必须属于当前 session、未被取消、未超时且期间目标未丢失/切换，否则丢弃。

## 5. 部署约定

- GitHub Pages 只承载静态前端。
- 后端由尹提供独立 HTTPS 地址并配置 CORS（允许前端域名的 `POST` 与 `multipart/form-data`）。
- 前端通过 `VITE_API_BASE_URL` 配置后端地址；任何模型密钥不得进入前端代码或浏览器配置。
