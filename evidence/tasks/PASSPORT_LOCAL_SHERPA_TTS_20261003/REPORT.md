# Passport local Sherpa TTS

状态：`IMPLEMENTED_NOT_REVIEWED`。显式 local Sherpa TTS adapter 已完成真实 Linux 模型链路验证，并随主后端于 2026-10-03 11:36:26 UTC 部署；设备麦克风、AI 回复和扬声器试听仍待用户操作，不能标记整产品验收完成。

## 行为与边界

- 只有显式设置 `GROWDESK_TTS_PROVIDER=local-sherpa` 才选择固定的离线 Sherpa 路径。只接受空 voice 或 `zh`，拒绝 endpoint、API key、model 及不匹配 voice；不回退到 fixture、共享 provider 或网络服务。既有 `local` 别名仍选择 eSpeak。
- Python launcher 固定为 `/srv/growdesk-tts/venv/bin/python`，保留 launcher 路径执行并核验 root 所有的解析后可执行文件；launcher 及解析路径的祖先目录均需 root 所有、无 group/world 写权限且不是 symlink（launcher 本身允许正常 venv symlink）。`/srv/growdesk-tts/venv/pyvenv.cfg` 必须是 root 所有的可读普通文件，固定 Python 3.12 `site-packages` 目录及祖先需 root 所有、无 group/world 写权限且不是 symlink。参数固定为 `-I /srv/growdesk-tts/synthesize.py`。固定脚本需为 root 所有的普通可读文件，不可为 symlink 或 group/world writable；脚本所有祖先目录均需 root 所有、不可为 symlink 或 group/world writable。
- 请求时验证 Python venv 的 launcher、`pyvenv.cfg` 与 site-packages 边界，不递归扫描依赖树；安装/preflight 负责核对完整复制的依赖树均为 root 所有且受保护，并确保 symlink 目标位于克隆目录或 root-owned 系统路径。原有 `/srv/asr/venv` 与 ASR 运行配置保持不变。
- 文本通过 stdin 传给 Python，local-sherpa 限制为 8192 UTF-8 字节，并在占用并发槽、创建临时文件或启动子进程前校验。远端 TTS 与既有 eSpeak 输入上限仍为 256 KiB。
- 脚本输出 WAV 到私有临时文件；固定 `/usr/bin/ffmpeg` 以单线程解码，转换为 24 kHz、单声道、S16LE PCM。WAV 上限 12 MiB，PCM 上限 8 MiB，stderr 上限 16 KiB。临时目录为 `0700`，音频文件为 `0600`，退出路径清理文件。
- 子进程继承固定的最小环境，不继承服务/provider 密钥，不使用 shell、用户命令或下载路径。Linux 子进程受固定 `prlimit` 约束：CPU 110 秒、地址空间 4 GiB；整条处理受最多 110 秒 timeout、单实例并发槽和进程组取消管理。非 Linux 平台 fail closed。

## 变更文件

- `internal/backend/passport_tts.go`：新增显式 local-sherpa provider 选择与本地 adapter 分流。
- `internal/backend/passport_tts_local*.go`：固定路径验证、Linux 受限进程执行、WAV/PCM 预算、输入边界、取消与临时文件管理。
- `internal/backend/passport_tts_local*_test.go`：selector/config、远端设置冲突、子进程环境秘密隔离、8192 字节输入上限；Linux 实际 Sherpa 测试覆盖 PCM、取消、进程组和临时文件清理。所有启动已安装本地引擎的 Linux 测试要求显式设置 `GROWDESK_LOCAL_VOICE_ACCEPTANCE=1`；设置后缺少固定工具或脚本会失败，不跳过。

## 验证

当前主机为 Darwin/arm64。已运行：

```sh
go test ./internal/backend -run '^(TestPassportTTS|TestPassportTTSLocal|TestLocalPassportTTS|TestSynthesizeLocalPassportTTS)' -count=1
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go test -c -o /tmp/growdesk-local-sherpa.test ./internal/backend
git diff --check
```

以上均通过。Linux 编译检查不执行 Linux 子进程测试；Darwin 测试不执行 Linux 引擎。

主任务随后在实际 Linux/arm64 环境显式启用 `GROWDESK_LOCAL_VOICE_ACCEPTANCE=1`，完整 suite 通过且没有跳过。实际链路为 Sherpa/MeloTTS → WAV → 24 kHz 设备 PCM → WAV → 现有 SenseVoice。两次完整运行均逐字识别“这是语音测试。”，数量句均保留 140 毫升；最新一次将句首“宝宝”识别成“我饱”，并未宣称数量句逐字通过。实际 Sherpa 生成、取消、进程组/slot/临时文件清理及限额检查通过；eSpeak 超时测试改为 150 ms，以在实际快速生成器的 12 MiB 输出限额前触发 timeout，严格清理断言未减弱，连续 10 次及完整重跑均通过。

最终完整 Go race 退出 0（backend 50.854s），生产源码与最终 API 构建匹配。完整模型测试与日志在相邻 `PASSPORT_ASR_COMPAT_20261003/linux-local-sherpa-voice.retested.log`、`linux-local-voice-gate.json`、`go-test-race.private-tts-final.log`；保留历史失败日志。

最终固定脚本 SHA-256 为 `2d9431ff06a61ebf85eb4d85ab9cf3a44b656341895a22fe6cf307e6c7fa62a5`，模型为 `bf30582eb1b012250a35b1a4a80e7dfbcf8485e7bb9de0d95efbbeef0e4ad86d`。独立 TTS venv 的 2,265 个普通文件及 4 个受约束 symlink 已安装检查并由独立代理只读复核；原有 ASR venv 未改动。Go runner、Python 脚本及依赖元数据最终独立审查无开放发现。

运行中 API SHA-256 为 `c98deb95c8060f871256b1520be3a95e8b318b8645740df81e52eba955f6f921`，选定 local-sherpa/zh 配置已与实际运行进程核对。600.13 秒真机捕获只有预期 USB 重启及后端切换断连，4.82 秒恢复 READY，无额外重启或断连；未观察到新实体录音回合。语音自然度、音量、麦克风识别和设备播放体验仍需用户实际验证。
