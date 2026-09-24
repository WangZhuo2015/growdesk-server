任务：Legacy FoodItem/FoodLogRecord/FamilyFoodStatus 历史投影
状态：IMPLEMENTED_NOT_REVIEWED
基线HEAD：5f00297
完成定位：工作区未提交 diff（等待主 Agent 独立 review 后拆分提交）

依赖门禁与证据：
- 依赖 identity-v1 `legacy_import.import_batches/import_rows` 与既有 PostgreSQL food schema。
- 新增 `202609190020_food_promotion` 为 additive migration；不修改 attachment、medical、supplement、vaccine 或 deploy 文件。
- 静态 `food_*` 参考项按自然 foodId reconciliation；自定义项必须能从 FamilyFoodStatus 或 archive familyId 证明唯一家庭归属。

允许范围 / 实际改动文件：
- `scripts/legacy-import/materialize_food.py`
- `scripts/legacy-import/test_food_materializer.py`
- `scripts/legacy-import/test_food_materializer_integration.py`
- `prisma/migrations/202609190020_food_promotion/migration.sql`
- `prisma/schema.prisma` 的 FoodRecord/FoodLibraryItem/FamilyFoodStatus 审计字段
- `scripts/test-integration.py` 在 `--legacy-care` owned runner 中加入食物切片测试

行为变化：
- 旧 FoodItem 的静态项使用 canonical `food_*` ID；自定义项保留旧 FoodItem primary key，并要求单一家庭归属。
- FoodLogRecord 映射到 FoodRecord，保留日期、Asia/Shanghai wall-clock、mealType 推导、foods、portion、reaction、旧 acceptance/babyState/异常字段、source/actor/clientId 和原始行 metadata，并建立 timeline entry。
- FamilyFoodStatus 映射到家庭状态行，保留 tried/reaction、旧 status/acceptance/firstAddedDate 与原始 metadata。
- 每个 source row 都有 SHA-256、mapping version、target snapshot receipt；同 batch 同 hash 重放为 no-op，冲突或 target 缺失回滚。

契约/schema变化：
- 未改变 HTTP contract；仅向 PostgreSQL food 表增加 provenance/audit 字段与 clientId 唯一索引。

验证命令：
- `python3 scripts/legacy-import/test_food_materializer.py`：退出码 0，6 tests passed。
- `npx prisma validate`：退出码 0。
- `npm run backend:typecheck`：退出码 0。
- `python3 scripts/test-integration.py --legacy-care`：退出码 0；owned PG18/Redis8 runner，含 identity、care、food integration 及全 backend suite。

自动测试证据：
- owned runner 输出包含 `Owned PostgreSQL legacy food materializer PASS: mapping, static reconciliation, replay, metadata, timeline, and atomic rollback`。
- 覆盖静态 reconciliation、自定义食材租户绑定、日志观察字段与时区、source/actor/clientId、receipt replay、source hash tamper 的整批回滚。
- 独立复核后，字符串形式的 `foods` 必须是合法 JSON 数组，拒绝畸形值；静态食材重放会核对并更新完整 legacy metadata；target receipt 使用 SHA-256，不再使用 MD5。

真机/hosted/provider证据：未验证；本任务是隔离 ETL 代码与 owned PostgreSQL 验证。

失败及未解决项：
- API/Web 仍需由主 Agent 决定是否从新增 legacy metadata 投影旧 FoodItem 完整字段；本切片只保证目标库保留完整原始行和 canonical 可读字段。
- FoodItem 无直接 familyId 的旧自定义行若没有唯一 FamilyFoodStatus 归属会硬失败，不能安全猜家庭；需要 quarantine/review 后再处理。
- 本切片不包含 FoodPlan、Supplement、Medical、Vaccine、AI、附件或生产切换。

迁移/回退影响：
- migration 是 additive；promotion 事务失败不留下业务行。回退需删除对应 batch 的 mapping/target rows，并在受控 owned rehearsal 中验证，不能直接在生产执行。

交给reviewer最应检查的3处：
1. `materialize_food.py` 的静态 food item reconciliation 与自定义租户判定。
2. FoodLogRecord notes envelope、foodItemIds 兼容映射和 timeline/receipt replay predicates。
3. 新 migration 与现有 Prisma generated client/API projection 的兼容性，以及生产 legacy archive 中 custom item 的实际归属覆盖率。
