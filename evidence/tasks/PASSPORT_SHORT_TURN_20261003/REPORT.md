# 短按录音、按钮识别界面与 WebSocket 复查

状态：**IMPLEMENTED_NOT_REVIEWED**。服务端修复已部署；新固件通过完整构建和范围独立复核，并已按本轮“ok”授权仅刷应用区，回读 hash 校验通过。原先第二次按键显示连接失败的传输原因仍未复现，不能把恢复连接当作已查明根因。

## 已确认与未确认

用户反馈：画面仍在识别三颗键时，第二颗键已触发录音；短按后只识别到标点，第二次操作显示 WebSocket 连接失败。

确认的代码缺陷是控制器与 UI 双状态失步：加载/提交有效映射后，控制器立即置 ready；旧 UI 更新函数在 250 ms 内拿不到 LVGL 锁时静默返回，识别 overlay 保留最高显示优先级。此时中间键 PRESS 能录音，画面却继续提示识别。这一序列由代码和锁失败注入回归证明；旧固件没有记录该 UI 超时，因此不能宣称已在用户那次操作中直接抓到超时。

ASR 原先把空白、纯标点或符号的文本继续当转写处理。现在共享、local 和明确隔离 fixture 路径无 Unicode 字母/数字时返回 `ASR_PROVIDER_NO_SPEECH`，在 ASR/AI 边界终止，不发布假转写、不调用 AI、不写语音历史。正常文字和标点原样保留；坏 JSON、缺少 text、无效 local UTF-8、超量输出仍拒绝为坏响应。

WebSocket 原故障原因 **UNDETERMINED**。初查后端 PID 3435230、NRestarts=0，无崩溃记录，匿名接口返回 401且 TLS 校验成功。尝试不主动 reset 的串口捕获仍在打开 USB 时触发一次 `USB_UART_CHIP_RESET`，丢失先前现场。后续 240.17 秒只观察到一次 WSS/READY，没有新的语音回合、后续断连或 panic。未据此修改 TLS、认证或连接配置；仍等待具体 `WS_*` / `TLS_*` 屏幕错误或复现日志。

## 固件修复

`app_ui_set_button_setup` 返回 LVGL 更新确认；控制器在进入、推进、结束识别或恢复有效映射时先关闭普通动作，失败每 250 ms 重试。按下时的 epoch 随 RELEASE/CLICK/LONG 保留，更新完成后再换 epoch 并清旧队列，旧事件不能跨转换变成录音/确认。NVS 成功提交后只重试 UI，不重复写映射；BSP 初始化失败通过 app_event 由控制器处理，避免主线程并发修改 gate。

确认仅指持有 LVGL 锁完成控件更新，不代表 LCD/SPI 像素已完成刷新；实际画面和按键时序仍需真机观察。

完整 `./tools/validate.sh` 退出 0，定向 controller/UI 回归及全部 host 检查通过；211 个记录的源码/检查文件在 gate 期间未变。新应用 4,687,664 字节，factory 8,323,072 字节。验证包：`../growdesk-iot/build/firmware/893574d8533ca51672b9e6493250fbb7f5919be35573265060dbc70114020199/`，ELF `c2cd56ede333759c836ba03f61c33eca0eace024fc84e6ce890f00e596f20cc5`。分区表与现用包字节相同。用户本轮“ok”批准后，只写应用区 `0x10000`，20.38 秒退出 0且设备回读 hash 验证通过；保留 bootloader、分区表、NVS/PHY、Wi-Fi、绑定和三键映射。串口启动 ELF 前缀 `c2cd56ede…` 匹配归档；观察到映射启用，23.46秒 WSS连接、23.86秒 READY。600.10秒观察退出0；一次USB打开造成预期重启，无额外reset/panic/断连/错误，WSS/READY各一次。串口已关闭。窗口没有LISTENING/THINKING/SPEAKING或新实体录音，实际画面、短按及连续语音仍待反馈。

## 实际验证与部署

- 完整 `go test -race -count=1 ./...` 退出 0（backend 58.009s）；Linux/arm64 API/helper 构建均通过。152 个记录源码文件冻结，见 `source-before.json` / `source-after.json`。
- 独立临时 PostgreSQL 的真实认证与 WebSocket 回归 `TestPassportShortTurnWebSocketIntegration` 实际 RUN/PASS（1.57s），无跳过。50 ms 非零 PCM 经明确 ASR fixture 返回标点，收到带 turnId 的 NO_SPEECH，语音历史为零；同一 socket 响应 ping/hello READY及第二个静音回合。没有 mock 权限、没有外部 AI 调用。owned loopback `test_` database/role guard 通过，清理统计 `0|0|0|0`，集群已停止删除。
- 实际服务器 Linux suite 35 项顶层测试通过、零跳过，含空 local 输出、ASR 限额/超时/取消/清理、TTS 等；真实 MeloTTS→24kHz 设备 PCM→现有 SenseVoice 链路通过，规范句完整匹配，140 毫升数量保留。不能代表麦克风、扬声器或长期 ASR 准确度。
- 三名子代理分别实现按钮/ASR修复及独立只读复核；最终范围复核无开放阻断项。独立 reviewer 没有执行测试/设备操作，测试由实现代理和根代理分层执行。

API SHA-256 `9ae41d1fdddf3a605a95bed61d4a7249eb3e2c47bed388d96ba9d95a4065f7d9` 于 2026-10-03 12:47:29 UTC 完成部署核对。安装文件和实际 PID 3678614 的 executable 均匹配；active/running、NRestarts=0、匿名 WS=401。`api.env` 未变，未修改 Nginx、未运行数据库迁移。回滚目录 `/home/ubuntu/growdesk/releases/passport-short-turn-20261003.HpwUp7VM` 保存原 `c98deb95…` 二进制和私有配置。

## 保留的失败与证据限制

完整 Go 首次总体失败，是 `_baseline` 改名前证据副本被 Go 发现为不完整 package；真实 backend 包已 PASS。已改证据目录名以排除非应用副本，随后完整 uncached gate通过，没有过滤业务测试。固件首次门禁因英文文档残留中文授权引用失败，修正英文后完整重跑通过。原日志分别保留。

Linux helper 实际 exit 0/PASS，但首次事后元数据断言写了一个不存在的测试名而失败；原完整日志保留，随后核对全部35项 RUN/PASS及真实失败/清理测试，无改变或重跑测试来掩盖失败。

第一次部署的即时检查失败并自动回滚；原脚本未标失败阶段，回滚期间启动日志出现通用 database-unavailable。不能从该日志认定生产数据库异常。第二次脚本逐阶段记录并等待 executable/public listener，接口第二次 probe 后就绪；所有部署门禁通过。失败日志与 `deploy.sh`、`deployment.log` 都保留。

剩余：屏幕实际退出校准与重启映射保留、中间键真实语音/AI/扬声器、原连接失败错误码与复现、真实业务确认/取消。未向真实家庭写合成记录，未提交或推送 Git。

## 重连诊断后续

只读复核确认 `CONNECT_TIMEOUT` 可覆盖尚未 READY 清除的 `TLS_`/`WS_` 诊断；component 自动重连与 coordinator 同时启用，后者可能 stop/destroy 正在自重连的旧 handle。这些是可修复代码问题，尚无现场证据证明是原第二次按键断连的原因。补充修复已完成，完整门禁、定向回归及ASan/UBSan通过，独立范围复核无开放项；本报告验证包 `893574d8…` 已刷入，补充包 `e8c60643…` 已获准应用区刷写并通过回读 hash 校验；用户已授权今后同一设备保留设置的常规应用修复与测试无需反复询问。匹配ELF启动、15.93秒WSS、16.94秒READY，正在600秒有界观察；完整SHA、实际应用/ELF、独立测试和真机状态见[补充重连报告](../../../../growdesk-iot/docs/development/reviews/growdesk-reconnect-20261003.zh_CN.md)。

## Latest physical PTT transport failure

The e8c60643 application-only replacement flashed with verified readback. Its completed 600.04-second real-device capture entered LISTENING then failed its 250 ms transport writable poll and disconnected. READY recovered after 28.54 seconds. Counts: expected USB reset 1, panic 0, connections 2, disconnects 1, READY 2, error lines 3. Real-device PTT transport acceptance is FAIL; ASR/AI/playback remain unverified. Two server stream-interruption warnings correlate in time, but the current logger discards the actual error. No production test records or server settings were changed during this observation. Next work prioritizes connection repair and safe diagnostics, before another operator voice prompt.
