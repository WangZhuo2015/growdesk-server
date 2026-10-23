# Passport TTS adapter

状态：`IMPLEMENTED_NOT_REVIEWED`。本报告记录 TTS adapter 的本地实现与隔离验证，不代表已接受、部署或完成真机验收。

## 行为与边界

- 只有显式设置 `GROWDESK_TTS_PROVIDER=shared` 才复用 common AI provider，且 common provider 必须是 `openai-compatible`。仅配置聊天 provider 不会推断它提供 `/audio/speech`。
- 独立 provider 使用 `GROWDESK_TTS_PROVIDER=openai-compatible`、`GROWDESK_TTS_BASE_URL` 和 `GROWDESK_TTS_API_KEY`；默认模型/音色为 `tts-1` / `alloy`。只有独立 TTS URL 与 common provider 推导出的规范音频 URL 完全相同时，才允许复用 common API key。跨主机或路径必须使用专用 key。`GROWDESK_TTS_TIMEOUT_MS` 可设为 100–180000 毫秒。
- Fixture 仅沿用显式的 common `fixture` 模式；adapter 不会启动外部命令，也不读取用户可控命令或继承 shell 参数。
- 先完整读取并验证受限响应，再发送 `tts.start`：文本最多 256 KiB，PCM 最多 8 MiB，必须非空、16-bit 样本字节对齐，且 media type/声明的采样率、声道、位深和端序不能与 24 kHz 单声道 little-endian PCM 冲突。`audio/L16` 和 WAV 容器会被拒绝。原始 PCM 没有自描述采样头；这些检查不能证明任意字节内容确实是有意义的语音。
- 播放按 1920 字节（40 ms）分块，等待时长按每块实际采样时长扣除发送耗时计算，最后一块也按比例等待。显式取消时静默停止，不再发错误或 `tts.end`，避免旧轮次状态污染当前设备交互。
- 所有 HTTP 响应体与 client idle connection 均在退出路径关闭。HTTP 状态、超时、网络、配置与 PCM 错误只返回脱敏的 TTS 错误事件，不读取或回显 provider 错误体、URL 或 API key。

## 本次变更

- `internal/backend/passport_tts.go`：独立 TTS 配置、受限请求、响应验证及 Passport PCM 输出。
- `internal/backend/passport_tts_test.go`：配置来源/密钥复用、资源关闭、超时与取消、HTTP 错误、PCM 格式/大小/对齐、无失败前置播放事件、24 kHz 输出事件及真实采样时长节流的隔离测试。

Passport WebSocket 调用点由主任务集成；本报告只记录上述 adapter 文件的实现与测试。

## 验证

```sh
go test ./internal/backend -run 'TestPassportTTS' -count=1 -v -timeout 60s
```

结果：通过，所有 Passport TTS 定向测试成功。测试只使用 `httptest` 和虚拟 key；未连接数据库、Redis、对象存储、真实 AI/TTS provider、服务端或推送通道，未使用设备/串口，也未部署或发布。

尚未证明真实 provider 对 PCM media type 的一致性、音质或固件播放/环形缓冲的真机行为；这些仍需独立 review 与设备验收。
