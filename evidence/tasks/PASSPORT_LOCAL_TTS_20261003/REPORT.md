# Passport local eSpeak TTS

状态：`IMPLEMENTED_NOT_REVIEWED`。本报告记录显式 local eSpeak TTS 分支的实现与隔离验证；不代表已接受、部署或完成音质验收。

## 行为与资源边界

- 只有显式设置 `GROWDESK_TTS_PROVIDER=local-espeak` 或别名 `local` 才会选择本机语音合成。该分支固定使用 `cmn` 普通话 voice；远端 endpoint、API key、model 或非 `cmn` voice 与本地选择冲突时返回脱敏 typed TTS 配置错误，不会回退到 fixture 或网络 provider。
- Linux 固定程序为 `/usr/bin/espeak-ng`、`/usr/bin/ffmpeg` 和既有固定路径 `prlimit`。启动前解析并验证程序路径、常规可执行文件与权限；没有受限运行能力时 fail closed。其他操作系统不启动 local TTS。
- eSpeak 使用 `--stdin --stdout -v cmn`，文本从 stdin 传入；中间 WAV 写入 `0700` 私有临时目录下的 `0600` 文件。ffmpeg 读取此 WAV，以单线程解码和过滤，输出 24 kHz、单声道、signed 16-bit little-endian 原始 PCM。没有 shell 拼接、用户可配置命令、下载、联网或静默 fixture fallback。
- 子进程只获得固定 PATH、临时 HOME/TMPDIR 和 locale，不继承服务环境或 provider 密钥。eSpeak 与 ffmpeg 均由进程组执行，并施加 CPU 与 4 GiB 地址空间上限；整条合成链有 110 秒硬上限，单实例并发为 1。
- 文本最多 256 KiB，中间 WAV 最多 12 MiB，最终 PCM 最多 8 MiB，stderr 超过 16 KiB 时终止且绝不回显内容。取消会终止进程组并静默返回；成功和所有失败路径均删除私有目录与中间 WAV。
- 完整生成并验证 PCM 后，继续使用既有 `tts.start`、paced binary chunks 和 `tts.end` wire format；播放分块仍按 24 kHz 单声道 PCM 的实际时长节流。

## 变更文件

- `internal/backend/passport_tts.go`：新增 `local-espeak` / `local` 选择与本地合成分支。
- `internal/backend/passport_tts_local*.go`：本地配置、边界控制、Linux 固定程序执行，以及其他平台的 fail-closed 实现。
- `internal/backend/passport_tts_local*_test.go`：选择器/配置、秘密环境隔离、PCM 和字节预算测试；Linux 上用真实固定 eSpeak NG 和 ffmpeg 覆盖语音生成、私有临时文件、取消、超时和并发门闩。

## 验证

在 Darwin/arm64 当前主机已运行：

```sh
go test ./internal/backend -run 'Test(PassportTTSLocalEspeak|LocalPassportTTS|SynthesizeLocalPassportTTS|PassportTTS)' -count=1
go test ./internal/backend -run '^$' -count=1
git diff --check
```

结果：通过。Darwin 按构建标签不执行 Linux 系统二进制行为测试，并验证显式本地模式 fail closed。

Linux helper 与真实本地语音 acceptance 命令（无需 `-race`；安装的本地引擎测试带 `linux && !race` build tag，并要求显式设置 `GROWDESK_LOCAL_VOICE_ACCEPTANCE=1`。默认 `go test` 不要求安装这些系统语音包；显式验收时缺少固定依赖会失败）：

```sh
GROWDESK_LOCAL_VOICE_ACCEPTANCE=1 go test ./internal/backend -run '^(TestPassportTTS|TestLocalPassportTTS|TestSynthesizeLocalPassportTTS|TestPassportExistingLocalVoiceAcceptance)' -count=1 -v
```

Linux `prlimit`、真实 eSpeak/ffmpeg PCM 和本地 ASR 对生成中文句子的 acceptance 结果由主任务补充；在该结果返回前不标记为已通过。

首次真实 Linux 验收中，eSpeak PCM 生成与取消清理测试通过；超时用例的 500 ms deadline 晚于 eSpeak 在约 420 ms 触发的 12 MiB WAV 上限，因此用例正确返回了输出超限错误，严格的 `TTS_PROVIDER_TIMEOUT` 断言失败。原始证据保留在 `evidence/tasks/PASSPORT_ASR_COMPAT_20261003/linux-local-sherpa-voice.final.log` 第 31–33 行。只将该测试 deadline 缩短到 150 ms，让超时条件先于已观测到的 WAV 上限发生；断言仍要求精确的 `TTS_PROVIDER_TIMEOUT`，并继续检查进程组、并发槽与临时文件清理。此调整后的 Linux 定向重跑结果待主任务确认。

本机 eSpeak 输出格式和执行边界可由测试核对，但音质、普通话自然度、设备音量及真实听感仍需用户实际试听评价。未部署、刷机、访问串口、真实 AI provider、数据库或生产数据。
