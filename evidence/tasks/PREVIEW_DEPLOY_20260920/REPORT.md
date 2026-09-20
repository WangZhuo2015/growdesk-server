# GrowDesk preview deployment evidence

日期：2026-09-20

范围仅为 `161.33.201.230` 上的隔离 preview；生产 Web 与生产 API 未切换。

部署前发现旧 `growdesk-preview-api.service` 因宿主机依赖缺失持续重启，3181 未监听。
镜像 canary 暴露出 `fastify-plugin` 仅由开发依赖间接提供的问题；提交 `0ae0cbf`
把它声明为 API 运行时依赖，并在 Docker build 的 production prune 后显式 import 验证。

部署结果：

- API 镜像 revision：`0ae0cbf6301bd46057f7f7536a8bdfcfaf7031f6`
- Web 镜像 revision：`103ba311529146d9398700b118af180126024fcb`
- Web build ID：`rtVjhcxYWstqj-X165U9P`
- Web artifact SHA-256：`22967590c50c47fb982d3ab2f2e7a0e3f56ca25dec4ad0855fd75dec74b2c781`
- Web provenance：`sourceDirty=false`
- preview PostgreSQL 成功应用 `202609190015` 至 `202609190020` 六个 migration。
- API 先在 3182 canary 通过，再接管 3181；Web 先在 3090 canary 通过，再接管 3089。
- 两个容器均使用只读根文件系统、临时 `/tmp`、drop all capabilities、
  `no-new-privileges` 和 Docker healthcheck/restart policy。

真实 preview API full smoke 通过：注册、登录、refresh、me、双租户 family/baby、
跨租户拒绝、feeding CRUD、sleep/diaper/food/supplement/growth/medical/vaccine CRUD、
真实 S3 attachment PUT/complete/delete。测试只创建 `test_public_api_*` 数据，最后删除
4 个测试家庭和 2 个测试用户，cleanup 状态为 passed。

最终只读复核：

```text
previewWeb=200 previewApi=200 publicApi=200
productionApi=200 productionWeb=200
apiContainer=healthy webContainer=healthy
```

生产切换仍受业务历史 ETL、附件业务引用、最终 shadow/fence/checkpoint 与金标准门禁约束；
本报告不表示生产已上线。
