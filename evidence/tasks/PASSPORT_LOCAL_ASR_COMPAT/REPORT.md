# Passport local ASR command adapter

状态：`IMPLEMENTED_NOT_REVIEWED`。本报告记录本地 ASR 命令适配器实现与已运行的隔离验证；不代表已接受、部署或完成语音设备验收。

## 行为与边界

- `GROWDESK_ASR_PROVIDER=local`（兼容 `command`）显式启用本地 ASR；历史管理员配置 `ASR_COMMAND` 也可启用。`openai`、`openai-compatible`、`compat`、`shared` 选择器不启用本地命令；任何非本地选择器与 `ASR_COMMAND` 同时存在都会作为配置冲突拒绝。未知选择器和未配置的显式 local 模式均返回脱敏配置错误。
- `ASR_COMMAND` 只解析为固定 argv，不经 shell、变量、通配符、重定向或管道展开；必须恰好包含一个 `{input}` 参数标记，程序名不允许标记。拒绝 shell 与已识别的 `env`、`busybox`、`toybox` 等命令分派方式。程序路径先解析和校验，子进程仅收到白名单环境变量，不继承服务密钥或任意环境变量。
- 输入限制为 25 MiB，识别超时最多 110 秒，同时最多运行一个本地进程。音频暂存目录为 `0700`、输入文件为 `0600`，覆盖和失败路径均清理临时文件。MIME 仅接受代码中列明的音频类型。
- 输出限制为 256 KiB；stderr 仅排空且不保留，超过 16 KiB 时终止识别。执行失败和配置错误不会回显子进程诊断或凭据。空白/无效 transcript 会拒绝。
- Linux 必须使用固定位置的 `prlimit`，并对识别进程施加 CPU 与地址空间上限；缺少或不匹配资源限制器时 fail closed。当前非 Linux 实现 fail closed，不启动未受限制的模型命令。
- 测试子进程只使用 Go 测试二进制、虚拟音频和测试专用环境变量；不调用真实识别模型、外部 AI provider、数据库、Redis、对象存储或服务端。

## 本次变更

- 新增 `internal/backend/asr_local*.go`：选择器/命令解析、配置校验、私有音频暂存、进程执行、Linux `prlimit`、超时与进程组取消。
- 新增 `internal/backend/asr_local*_test.go`：命令与选择器验证；Linux 受限 helper 的成功、文件权限与清理、环境隔离、输入/output/stderr 限制、失败、超时、取消、后代进程清理和并发拒绝用例。
- 与 Passport ASR/WebSocket 调用点的集成由主任务负责；本报告只覆盖上述 adapter 文件。

## 验证

在当前 Darwin/arm64 主机运行：

```sh
go test ./internal/backend -run 'Test(ParseLocalASR|ResolveLocalASR|LocalASRConfiguration)' -count=1
go test ./internal/backend -run '^$' -count=1
```

结果：两条命令通过。第一条执行了命令解析、选择器、路径解析及平台 fail-closed 定向测试；第二条完成 `internal/backend` 包编译检查。Darwin 会按构建标签排除 Linux `prlimit` 受限进程行为测试。

Linux 主机上的受限 helper 验证命令：

```sh
go test ./internal/backend -run '^(TestLocalASRHelperProcess|TestTranscribeLocalASR.*)$' -count=1 -v
```

该 Linux-only 行为套件在无 `-race` 模式交叉编译为 Linux/arm64 测试二进制后，由主任务在 Linux 主机执行，实际生产 `prlimit` 路径全部通过。使用受控 helper 和虚拟音频，覆盖成功、资源/输出边界、超时、取消及后代进程清理、并发拒绝；未调用真实识别模型或读取生产配置。远程测试目录已删除，源码对应性已核对。完整日志见 [linux-prlimit.log](../PASSPORT_ASR_COMPAT_20261003/linux-prlimit.log)。

未运行真实 ASR 命令、真实 provider、生产数据或设备测试。真实识别质量、部署运行时配置与设备端语音体验仍需独立 review 和验收。
