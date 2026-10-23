# Passport 语音、确认卡片与现有服务器兼容修复

后续状态：短按/纯标点复查已部署后端 `9ae41d1f…`，本文 `c98deb95…` 部署记录为历史证据。新固件 `893574d8…` 已按本轮“ok”授权仅刷应用区并通过回读 hash 校验，正在真机观察，原第二次按键连接失败原因仍待复现；见 [短语音复查报告](../PASSPORT_SHORT_TURN_20261003/REPORT.md)。

状态：**IMPLEMENTED_NOT_REVIEWED**。后端已于 2026-10-03 11:36:26 UTC 部署，运行文件与选定配置已核对。范围内独立审查、真实 Linux 语音链路与隔离数据库测试已通过；真实麦克风、AI 回复、扬声器及实体记录确认仍待用户操作验证，不能标记整产品验收完成。

## 已查明的原因

旧 Web `baby-panel.service` 使用 `/home/ubuntu/Github/baby_panel_for_cecilia/.env`，IoT Go `growdesk-api.service` 使用 `/home/ubuntu/growdesk/api.env`，是两个进程。旧服务确实配置了本地 SenseVoice 识别和现有 AI；运行中的 Go 未接入这些配置，而且先检查聊天供应商再调用识别。因此真机的 `AI provider not configured` 发生在识别之前，不能归因为语音服务不存在或 WSS 断开。

用户已授权读取并复用现有 ASR/AI/语音配置以及部署、继续真机验证。仅在服务器内复制选定 ASR/AI 字段；没有输出密钥，没有测试旧 Web 3088 或生产数据库。旧后端 `b98fe98f…` 及完整原配置已保存为私有回滚副本，选定配置已激活并与实际运行进程环境逐项私下核对。现有旧 Web 配置未修改。

## 修复范围

- ASR 接入已审计的固定 `/srv/asr/run.sh {input}`，不执行可配置 shell。子进程不继承应用数据库/供应商密钥；使用私有音频暂存、单进程并发、输入/输出/stderr 限额、Linux CPU/地址空间限制、超时与取消进程组清理。
- 聊天兼容现有 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`，专用 ASR/TTS 地址不能自动获得其他服务的密钥。Passport 先识别并发布真实转写，再校验聊天配置。缺失配置、HTTP 失败、超时及无语音都有明确错误。
- 删除缺少 fixture 时默认生成 140 mL 喂奶转写/提案的隐式假数据；线上不启用 fixture。完全为零的规范 16 kHz PCM 在模型调用前拒绝；这不构成普通环境噪声的 VAD 验收。
- 六类确认卡片使用真实创建 schema：喂奶、尿布、睡眠、辅食、补剂、成长。规范化后再计算确认 body/hash，保留十进制精度，删除模型提供的用户/家庭/宝宝、产品与附件关联字段，不补假数值。食品目录仅含授权家庭和全局条目，确认事务重新验证食品引用；成功确认的重放返回原结果。
- 模型只提出一次创建动作；缺字段需澄清，读取回答不产生确认卡。服务端生成动作 UUID，中间实体键确认前不写业务记录。明确设备三颗实体键，不使用虚构的触摸或上下键。
- 55 秒识别+聊天预算、回合 gate、播音 token 和有界 WS replay 窗口防止旧回合覆盖新录音；错误包含原 turnId。PCM 以 24 kHz mono S16LE 按实际采样节奏播放，空/错格式音频不能发出假开始/完成。

## 实际语音引擎验证

真实 Linux 测试发现 eSpeak NG 1.51 `cmn` 的中文不够准确：默认及显式 UTF-8、150/160 WPM 都无法正确识别“这是语音测试”。保留失败证据 `linux-local-voice.log`，没有减弱验收断言。取消测试把 eSpeak 的辅助目录误当多余音频，早期 fatal 导致后续 busy；测试现在识别具体私有 WAV，任何断言路径都 cancel+join 并验证进程组、并发 slot 和临时目录清理。

播音改用明确选择的 `local-sherpa`，固定 Python `-I` 脚本与官方 MIT MeloTTS 中文/英文模型；无运行时下载、网络供应商或用户可选命令。模型和脚本安装为 root 拥有的受保护文件；固定资产/祖先拒绝 symlink、非 root 或 group/world writable。8 KiB 文本、12 MiB WAV、8 MiB 设备 PCM，生成 callback 超限拒绝部分结果，同时保留 Go 进程资源限制。eSpeak 兼容模式仍需明确选择。

官方来源：[Sherpa 模型说明](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/vits.html)、[模型发布文件](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2)、[MeloTTS MIT license](https://github.com/myshell-ai/MeloTTS/blob/main/LICENSE)。下载来自官方 HTTPS 发布地址；发布 API 的 digest 为空，本地 SHA-256 用于上传/安装一致性核对，不宣称签名验证。模型 SHA-256 `bf30582e…`；最终固定脚本 SHA-256 `2d9431ff…`。

最终实际 Linux adapter 已执行完整链路：MeloTTS → 44.1 kHz WAV → 固定 ffmpeg → 24 kHz mono S16LE 设备 PCM → WAV → 现有 ASR wrapper → SenseVoice。两次完整运行均逐字识别“这是语音测试。”，均保留 140 毫升数量。最新一次数量句首将“宝宝”识别成“我饱”，记录为真实模型误识别，不能宣称整句完全准确。规范句 PCM 为 62,416 字节（1.30 秒），数量句为 99,754 字节（2.08 秒）；实际断言为规范句逐字匹配及数量保留。这些证据不能替代麦克风环境和真机听感。

TTS 使用独立 root-owned `/srv/growdesk-tts/venv`，原有 `/srv/asr/venv` 未改动。安装和独立只读复核检查 2,265 个普通文件及 4 个受约束 symlink，无非 root 或 group/world 可写条目；运行时 Python prefix、Sherpa 1.13.6 与 NumPy 2.5.2 均指向独立环境。具体安装与最终检查见 `tts-private-environment-install.log`、`local-tts-final-install.log`。

## 隔离测试

- 最终完整 `go test -race ./...` 退出 0（backend 50.854s），见 `go-test-race.private-tts-final.log`。构建及 race 期间 148 个相关源码文件无变化。之后仅把 Linux eSpeak 超时测试刺激从 500 ms 改为 150 ms，因实际引擎在 0.42 秒先触发 12 MiB 输出预算；生产源码 96 个文件与最终 API 构建逐项一致，见 `private-tts-api-production.match.json`。超时错误、进程组、slot、临时文件断言保持严格。
- 独立 PostgreSQL 集群真实运行 `TestPassportConfirmedRecordsIntegration`、`TestPassportFoodCatalogContextIntegration`、`TestPassportConfirmationRevocationIntegration`，三项均通过、无跳过。六类真实 SQL 创建/重复确认、跨家庭食品拒绝、删除后重放、设备/宝宝授权撤销和锁竞态均验证。测试租户清理后统计 `0|0|0|0`，临时集群已停止删除；见 `pg-acceptance.log/json`。
- 真实 Linux suite 已通过、无跳过；额外实际引擎超时测试连续 10 次通过。覆盖 ASR、Sherpa/eSpeak 生成、WAV/PCM 转换、取消/进程组/slot/临时文件清理、资源限额、供应商密钥隔离及播放节奏，见 `linux-local-sherpa-voice.retested.log`、`linux-local-voice-gate.json`。最终 helper 为 `f365003e…`，suite 期间 148 个相关文件无变化。保留历史失败日志，不使用其作为最终通过证据。
- Canonical OpenAPI 112 paths/159 operations、Passport card 契约均通过且未跳过；服务端与固件 `git diff --check` 通过。
- 卡片、规范化确认、食品授权与数字精度的独立 Spec 复核无开放发现。最终固定 Python 脚本、Go Sherpa runner、回合/播放/供应商边界及实际只读依赖元数据复核均无开放发现，见 `independent-review.json`。审查者未执行真实模型测试，实际 Linux 测试由主代理执行。

## 真机已有证据与剩余验收

已刷入用户批准固件 `7afb3376…`，匹配 ELF `a76a57601…`。600.15 秒观察 WSS/READY 各一次，无异常重启、panic 或断连；识别实际顶部/中间/底部三键，提交 raw ID `0,1,2`。用户确认三键识别正常，中间键录音已进入发送。另一次主动重启后 120.02 秒连接正常；是否直接恢复已识别键位仍缺用户屏幕反馈。

实际部署仅原子替换后端及配置，重启 `growdesk-api.service`，失败自动恢复二者；未触发回滚。未运行数据库迁移、未改 Nginx、未再次刷固件。最终 API SHA-256 为 `c98deb95c8060f871256b1520be3a95e8b318b8645740df81e52eba955f6f921`；安装文件及实际 PID 3435230 的 `/proc/PID/exe` 均匹配。服务为 active/running、NRestarts=0，匿名 Passport WSS 返回 401；实际环境与选定配置一致，识别为 local、聊天为已有批准供应商、播音为 local-sherpa/zh，AI/TTS 超时分别 35/20 秒。见 `deployment.log` 与 `deployed-runtime-verification.log`。私有回滚目录 `/home/ubuntu/growdesk/releases/passport-voice-20261003.53x7uqn0` 保存原二进制及配置。

新增真机 `build/device-tests/passport-20261003-existing-voice/` 捕获 600.13 秒。一次 USB 打开造成预期 `USB_UART_CHIP_RESET`；后端切换造成一次预期断连及四条对应传输错误，4.82 秒后恢复 READY。总计 WSS/READY 各两次，无额外 reset、panic 或断连；串口观察已结束并释放。窗口内没有新实体录音回合，不能把在线状态当作 ASR/AI/扬声器通过。

已请用户面对屏幕、挂绳端朝上，按住实际中间侧键说正常问题，松开后核对转写、回复、扬声器和可见错误，并确认重启后是否直接进入主界面而未再次识别三键。这些反馈及真实记录的实体确认仍待完成。自动测试未调用实际计费 AI，也未向真实家庭写演示或合成记录。当前尚不能声称全部真机业务路径通过。

历史 `a52ae514…` 构建及对应 manifest 单独保留，不能作为新增语音/卡片修复的部署证据。没有 Git 提交或推送。
