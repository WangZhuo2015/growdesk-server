package backend

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

const (
	passportVoiceRecordWindowDays      = 7
	passportVoiceRecordLimit           = 12
	passportVoiceRecordContextMaxBytes = 24 * 1024
)

type passportVoiceRecordContext struct {
	Data              Object
	TimeZone          string
	TotalRecordCount  int64
	RecentRecordCount int64
	Truncated         bool
	HasAnyRecords     bool
}

type passportVoiceRecordSpec struct {
	kind        string
	table       string
	dayExpr     string
	windowField string
	timeBased   bool
	selectJSON  string
	dayValue    string
}

// Every identifier and projected field below is a source-code constant. The
// only dynamic values in the generated SQL are bound parameters.
var passportVoiceRecordSpecs = []passportVoiceRecordSpec{
	{
		kind: "feeding", table: "feeding_records", dayExpr: "(occurred_at AT TIME ZONE $3::text)::date", windowField: "occurred_at", timeBased: true,
		selectJSON: `jsonb_build_object(
			'localDate', (r.occurred_at AT TIME ZONE $3::text)::date::text,
			'occurredAt', r.occurred_at,
			'feedingType', r.feeding_type,
			'amountMl', r.amount_ml::text,
			'leftMinutes', r.left_minutes,
			'rightMinutes', r.right_minutes,
			'spitUp', r.spit_up,
			'notes', left(r.notes, 160))`,
		dayValue: "SUM(amount_ml)::text",
	},
	{
		kind: "sleep", table: "sleep_records", dayExpr: "(started_at AT TIME ZONE $3::text)::date", windowField: "started_at", timeBased: true,
		selectJSON: `jsonb_build_object(
			'localDate', (r.started_at AT TIME ZONE $3::text)::date::text,
			'startedAt', r.started_at,
			'endedAt', r.ended_at,
			'sleepType', r.sleep_type,
			'nightWakingCount', r.night_waking_count,
			'notes', left(r.notes, 160))`,
	},
	{
		kind: "diaper", table: "diaper_records", dayExpr: "(occurred_at AT TIME ZONE $3::text)::date", windowField: "occurred_at", timeBased: true,
		selectJSON: `jsonb_build_object(
			'localDate', (r.occurred_at AT TIME ZONE $3::text)::date::text,
			'occurredAt', r.occurred_at,
			'diaperType', r.diaper_type,
			'poopColor', left(r.poop_color, 40),
			'poopConsistency', left(r.poop_consistency, 40),
			'notes', left(r.notes, 160))`,
	},
	{
		kind: "food", table: "food_records", dayExpr: "record_date", windowField: "record_date",
		selectJSON: `jsonb_build_object(
			'localDate', r.record_date,
			'occurredAt', r.occurred_at,
			'mealType', r.meal_type,
			'foods', coalesce((SELECT jsonb_agg(authorized_food.name ORDER BY authorized_food.name)
				FROM (SELECT left(fi.name, 64) AS name FROM food_library_items fi
					WHERE fi.id = ANY(r.food_item_ids) AND (fi.family_id IS NULL OR fi.family_id = $1)
					ORDER BY fi.name LIMIT 8) authorized_food), '[]'::jsonb),
			'portionDescription', left(r.portion_description, 80),
			'reaction', r.reaction,
			'notes', left(r.notes, 160))`,
	},
	{
		kind: "supplement", table: "supplement_records", dayExpr: "(occurred_at AT TIME ZONE $3::text)::date", windowField: "occurred_at", timeBased: true,
		selectJSON: `jsonb_build_object(
			'localDate', (r.occurred_at AT TIME ZONE $3::text)::date::text,
			'occurredAt', r.occurred_at,
			'supplementName', left(r.supplement_name, 64),
			'amount', left(r.amount, 64),
			'dose', r.dose::text,
			'unitName', left(r.unit_name, 32),
			'notes', left(r.notes, 160))`,
	},
	{
		kind: "growth", table: "growth_measurements", dayExpr: "measurement_date", windowField: "measurement_date",
		selectJSON: `jsonb_build_object(
			'localDate', r.measurement_date::text,
			'weightKg', r.weight_kg::text,
			'heightCm', r.height_cm::text,
			'headCircumferenceCm', r.head_circumference_cm::text,
			'notes', left(r.notes, 160))`,
	},
}

func (s *Server) loadPassportVoiceRecordContextForKinds(ctx context.Context, principal *PassportPrincipal, reference time.Time, kinds []string) (passportVoiceRecordContext, error) {
	var result passportVoiceRecordContext
	if s.DB == nil {
		return result, errors.New("passport record database unavailable")
	}
	specs := selectPassportVoiceRecordSpecs(kinds)
	if len(specs) == 0 {
		return result, errors.New("no Passport record types selected")
	}
	if principal == nil || !time.Now().Before(principal.ExpiresAt) {
		return result, apiError(401, "INVALID_PASSPORT_TOKEN", "Passport token is expired")
	}
	if reference.IsZero() {
		reference = time.Now().UTC()
	}

	_, err := s.readSnapshot(ctx, func(q Querier) (Result, error) {
		var active bool
		if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM passport_devices
			WHERE id=$1 AND owner_user_id=$2 AND family_id=$3 AND baby_id=$4 AND revoked_at IS NULL)`,
			principal.DeviceID, principal.OwnerUserID, principal.FamilyID, principal.BabyID).Scan(&active); err != nil {
			return Result{}, err
		}
		if !active {
			return Result{}, apiError(403, "DEVICE_ACCESS_REVOKED", "Device access has been revoked or its scope has changed")
		}
		scope, err := babyScope(ctx, q, principal.OwnerUserID, principal.BabyID, false)
		if err != nil {
			return Result{}, err
		}
		if scope.FamilyID != principal.FamilyID {
			return Result{}, apiError(403, "BABY_SCOPE_MISMATCH", "Device baby scope has changed")
		}
		var timezone string
		if err := q.QueryRow(ctx, `SELECT timezone FROM families WHERE id=$1 AND deleted_at IS NULL`, scope.FamilyID).Scan(&timezone); err != nil {
			return Result{}, err
		}
		location, err := time.LoadLocation(timezone)
		if err != nil {
			return Result{}, fmt.Errorf("invalid family timezone: %w", err)
		}

		windowStartLocal := reference.In(location)
		windowStartLocal = time.Date(windowStartLocal.Year(), windowStartLocal.Month(), windowStartLocal.Day(), 0, 0, 0, 0, location).AddDate(0, 0, -(passportVoiceRecordWindowDays - 1))
		windowEndLocal := windowStartLocal.AddDate(0, 0, passportVoiceRecordWindowDays)
		windowStartDate := windowStartLocal.Format("2006-01-02")
		windowEndDate := windowEndLocal.Format("2006-01-02")
		window := passportVoiceRecordWindow{
			familyID: scope.FamilyID, babyID: scope.BabyID, timezone: timezone,
			startAt: windowStartLocal.UTC(), endAt: windowEndLocal.UTC(),
			startDate: windowStartDate, endDate: windowEndDate, startLocal: windowStartLocal,
		}
		data := Object{
			"timeZone": timezone,
			"recentWindow": Object{
				"startDate": windowStartDate,
				"endDate":   windowEndLocal.AddDate(0, 0, -1).Format("2006-01-02"),
				"dayCount":  passportVoiceRecordWindowDays,
			},
			"recordTypes": Object{},
		}
		byKind := obj(data["recordTypes"])
		selectedKinds := make([]string, 0, len(specs))
		for _, spec := range specs {
			kindData, err := loadPassportVoiceRecordKind(ctx, q, spec, window)
			if err != nil {
				return Result{}, fmt.Errorf("load Passport %s context: %w", spec.kind, err)
			}
			byKind[spec.kind] = kindData.data
			result.TotalRecordCount += kindData.allTimeCount
			result.RecentRecordCount += kindData.recentCount
			result.Truncated = result.Truncated || kindData.truncated
			selectedKinds = append(selectedKinds, spec.kind)
		}
		data["includedRecordTypes"] = selectedKinds
		contextTruncated, err := boundPassportVoiceRecordContext(data)
		if err != nil {
			return Result{}, err
		}
		result.Truncated = result.Truncated || contextTruncated
		result.Data = data
		result.TimeZone = timezone
		result.HasAnyRecords = result.TotalRecordCount > 0
		return ok(Object{})
	})
	if err != nil {
		return passportVoiceRecordContext{}, err
	}
	return result, nil
}

// loadPassportVoiceTimeZone reads only the authorized family's timezone for
// non-data turns. It deliberately does not load any historical baby records.
func (s *Server) loadPassportVoiceTimeZone(ctx context.Context, principal *PassportPrincipal) (string, error) {
	if s.DB == nil {
		return "", errors.New("passport timezone database unavailable")
	}
	if principal == nil || !time.Now().Before(principal.ExpiresAt) {
		return "", apiError(401, "INVALID_PASSPORT_TOKEN", "Passport token is expired")
	}
	var timezone string
	_, err := s.readSnapshot(ctx, func(q Querier) (Result, error) {
		var active bool
		if err := q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM passport_devices
			WHERE id=$1 AND owner_user_id=$2 AND family_id=$3 AND baby_id=$4 AND revoked_at IS NULL)`,
			principal.DeviceID, principal.OwnerUserID, principal.FamilyID, principal.BabyID).Scan(&active); err != nil {
			return Result{}, err
		}
		if !active {
			return Result{}, apiError(403, "DEVICE_ACCESS_REVOKED", "Device access has been revoked or its scope has changed")
		}
		scope, err := babyScope(ctx, q, principal.OwnerUserID, principal.BabyID, false)
		if err != nil {
			return Result{}, err
		}
		if scope.FamilyID != principal.FamilyID {
			return Result{}, apiError(403, "BABY_SCOPE_MISMATCH", "Device baby scope has changed")
		}
		if err := q.QueryRow(ctx, `SELECT timezone FROM families WHERE id=$1 AND deleted_at IS NULL`, scope.FamilyID).Scan(&timezone); err != nil {
			return Result{}, err
		}
		if _, err := time.LoadLocation(timezone); err != nil {
			return Result{}, fmt.Errorf("invalid family timezone: %w", err)
		}
		return ok(Object{})
	})
	if err != nil {
		return "", err
	}
	return timezone, nil
}

func passportAllPassportVoiceRecordKinds() []string {
	kinds := make([]string, 0, len(passportVoiceRecordSpecs))
	for _, spec := range passportVoiceRecordSpecs {
		kinds = append(kinds, spec.kind)
	}
	return kinds
}

func selectPassportVoiceRecordSpecs(kinds []string) []passportVoiceRecordSpec {
	requested := make(map[string]struct{}, len(kinds))
	for _, kind := range kinds {
		requested[kind] = struct{}{}
	}
	selected := make([]passportVoiceRecordSpec, 0, len(requested))
	for _, spec := range passportVoiceRecordSpecs {
		if _, ok := requested[spec.kind]; ok {
			selected = append(selected, spec)
		}
	}
	return selected
}

func boundPassportVoiceRecordContext(data Object) (bool, error) {
	serialized, err := jsonText(data)
	if err != nil {
		return false, err
	}
	if len(serialized) <= passportVoiceRecordContextMaxBytes {
		return false, nil
	}
	recordTypes := obj(data["recordTypes"])
	kinds, _ := data["includedRecordTypes"].([]string)
	for _, kind := range kinds {
		recent := obj(obj(recordTypes[kind])["recentWindow"])
		samples, _ := recent["samples"].([]Object)
		for _, sample := range samples {
			delete(sample, "notes")
		}
	}
	serialized, err = jsonText(data)
	if err != nil {
		return false, err
	}
	for len(serialized) > passportVoiceRecordContextMaxBytes {
		removedAny := false
		for _, kind := range kinds {
			recent := obj(obj(recordTypes[kind])["recentWindow"])
			samples, _ := recent["samples"].([]Object)
			if len(samples) == 0 {
				continue
			}
			samples = samples[:len(samples)-1]
			recentCount := int64(0)
			if value, ok := recent["recordCount"].(int64); ok {
				recentCount = value
			}
			recent["samples"] = samples
			recent["includedRecordCount"] = len(samples)
			recent["truncated"] = recentCount > int64(len(samples))
			removedAny = true
		}
		if !removedAny {
			return false, errors.New("passport record metadata exceeds its context budget")
		}
		serialized, err = jsonText(data)
		if err != nil {
			return false, err
		}
	}
	return true, nil
}

func passportVoiceRecordQueryKinds(transcript string) []string {
	text := strings.ToLower(strings.TrimSpace(transcript))
	if text == "" {
		return nil
	}
	for _, prefix := range []string{"记录", "请记录", "请帮我记录", "帮我记录", "帮我记", "记一下", "记下", "新增", "添加", "保存", "录入", "登记", "补记", "补录", "我刚喂", "我刚才喂", "我刚喝", "我刚才喝"} {
		if strings.HasPrefix(text, prefix) {
			return nil
		}
	}
	for _, action := range []string{"记录一下", "记一下", "记下", "记下来", "记录下来", "补记", "补录", "新增", "添加", "保存", "录入", "登记"} {
		if strings.Contains(text, action) {
			return nil
		}
	}
	for _, request := range []string{
		"想记录", "想记", "要记录", "要记", "需要记录", "需要记", "准备记录", "准备记",
		"想新增", "要新增", "需要新增", "请新增", "帮我新增", "想添加", "要添加", "需要添加", "请添加", "帮我添加",
		"想保存", "要保存", "需要保存", "请保存", "帮我保存", "想补记", "要补记", "需要补记", "请补记", "帮我补记",
		"请帮我记录", "帮我记录", "请记录", "帮忙记录", "麻烦记录", "我记录", "我补记", "我新增", "我添加", "我保存",
	} {
		if strings.Contains(text, request) {
			return nil
		}
	}
	for _, phrase := range []string{"怎么操作", "怎样操作", "如何操作", "怎么使用", "如何使用", "设备怎么用", "介绍一下设备", "怎么记录", "怎样记录", "如何记录", "教我记录", "介绍如何记录", "介绍怎样记录", "记录失败", "为什么", "应该喝多少奶", "需要喝多少奶", "建议喝多少奶", "正常喝多少奶", "怎么清洗", "如何清洗", "清洗奶瓶", "怎么冲奶", "如何冲奶", "怎么泡奶", "应该", "需要", "建议", "合适", "适合", "推荐", "能不能", "可不可以", "怎样才能", "怎么才能", "如何才能", "多睡吗"} {
		if strings.Contains(text, phrase) {
			return nil
		}
	}
	queryIntent := false
	for _, marker := range []string{"多少", "几次", "几天", "几觉", "几顿", "几餐", "多久", "多长时间", "什么时候", "哪一天", "最近一次", "上一次", "最后一次", "有没有", "统计", "列出", "总结", "回顾", "查询", "查一下", "查查", "查看", "看看", "看一下", "数据", "情况", "怎么样", "历史", "发生过", "吃了什么", "喝了多少奶"} {
		if strings.Contains(text, marker) {
			queryIntent = true
			break
		}
	}
	if !queryIntent {
		return nil
	}

	typeTerms := map[string][]string{
		"feeding":    {"喂养", "喂奶", "喝奶", "吃奶", "奶量", "喝了多少奶", "feeding", "milk"},
		"sleep":      {"睡眠", "睡觉", "睡了多久", "睡了多长", "入睡", "sleep", "nap"},
		"diaper":     {"尿布", "尿尿", "大便", "排便", "便便", "diaper", "pee", "poop"},
		"food":       {"辅食", "吃了什么", "吃了啥", "食物", "food", "solid"},
		"supplement": {"补充剂", "维生素", "维d", "补剂", "supplement", "vitamin"},
		"growth":     {"成长", "生长", "身高", "体重", "头围", "growth", "weight", "height"},
	}
	selected := make([]string, 0, len(typeTerms))
	for _, spec := range passportVoiceRecordSpecs {
		for _, term := range typeTerms[spec.kind] {
			if strings.Contains(text, term) {
				selected = append(selected, spec.kind)
				break
			}
		}
	}
	if len(selected) > 0 {
		if queryIntent {
			return selected
		}
		return nil
	}
	if queryIntent {
		for _, marker := range []string{"数据", "情况", "历史", "记录"} {
			if strings.Contains(text, marker) {
				return passportAllPassportVoiceRecordKinds()
			}
		}
	}
	if queryIntent {
		for _, marker := range []string{"总结", "回顾"} {
			if strings.Contains(text, marker) {
				return passportAllPassportVoiceRecordKinds()
			}
		}
	}
	return nil
}

type passportVoiceRecordKindResult struct {
	data         Object
	allTimeCount int64
	recentCount  int64
	truncated    bool
}

type passportVoiceRecordWindow struct {
	familyID, babyID, timezone string
	startAt, endAt             time.Time
	startDate, endDate         string
	startLocal                 time.Time
}

func loadPassportVoiceRecordKind(ctx context.Context, q Querier, spec passportVoiceRecordSpec, window passportVoiceRecordWindow) (passportVoiceRecordKindResult, error) {
	var result passportVoiceRecordKindResult
	where := `family_id=$1 AND baby_id=$2 AND deleted_at IS NULL`
	aggregateQuery := fmt.Sprintf(`SELECT COUNT(*)::bigint, MIN(%s)::text, MAX(%s)::text FROM %s WHERE %s`, spec.dayExpr, spec.dayExpr, spec.table, where)
	var earliest, latest *string
	aggregateArgs := []any{window.familyID, window.babyID}
	if spec.timeBased {
		aggregateArgs = append(aggregateArgs, window.timezone)
	}
	if err := q.QueryRow(ctx, aggregateQuery, aggregateArgs...).Scan(&result.allTimeCount, &earliest, &latest); err != nil {
		return result, err
	}

	recentWhere := where + " AND " + passportVoiceRecordWindowExpression(spec, 3, 4)
	recentArgs := passportVoiceRecordWindowArgs(spec, window, false)
	if err := q.QueryRow(ctx, fmt.Sprintf(`SELECT COUNT(*)::bigint FROM %s WHERE %s`, spec.table, recentWhere), recentArgs...).Scan(&result.recentCount); err != nil {
		return result, err
	}

	dailyStartParameter := 3
	if spec.timeBased {
		dailyStartParameter = 4
	}
	dailyWhere := where + " AND " + passportVoiceRecordWindowExpression(spec, dailyStartParameter, dailyStartParameter+1)
	dailyArgs := passportVoiceRecordWindowArgs(spec, window, spec.timeBased)
	dailyQuery := fmt.Sprintf(`SELECT jsonb_build_object('date', (%s)::text, 'recordCount', COUNT(*)::bigint, 'valueTotal', %s)
		FROM %s WHERE %s GROUP BY %s ORDER BY %s`, spec.dayExpr, dailyValueExpression(spec), spec.table, dailyWhere, spec.dayExpr, spec.dayExpr)
	dailyRows, err := many(ctx, q, dailyQuery, dailyArgs...)
	if err != nil {
		return result, err
	}
	dailyByDate := make(map[string]Object, len(dailyRows))
	for _, row := range dailyRows {
		dailyByDate[text(row["date"])] = row
	}

	sampleArgs := passportVoiceRecordWindowArgs(spec, window, spec.timeBased)
	sampleStartParameter := 3
	if spec.timeBased {
		sampleStartParameter = 4
	}
	sampleQuery := fmt.Sprintf(`SELECT %s FROM %s r WHERE r.family_id=$1 AND r.baby_id=$2 AND r.deleted_at IS NULL AND %s
		ORDER BY %s DESC, r.id DESC LIMIT %d`, spec.selectJSON, spec.table, qualifiedPassportVoiceRecordWindowExpression(spec, sampleStartParameter, sampleStartParameter+1), qualifiedDayExpression(spec), passportVoiceRecordLimit)
	samples, err := many(ctx, q, sampleQuery, sampleArgs...)
	if err != nil {
		return result, err
	}
	result.truncated = result.recentCount > int64(len(samples))

	dailyTotals := make([]Object, 0, passportVoiceRecordWindowDays)
	for day := 0; day < passportVoiceRecordWindowDays; day++ {
		date := window.startLocal.AddDate(0, 0, day).Format("2006-01-02")
		if entry, exists := dailyByDate[date]; exists {
			value := Object{"date": date, "recordCount": entry["recordCount"]}
			if entry["valueTotal"] != nil {
				if spec.kind == "feeding" {
					value["amountMl"] = entry["valueTotal"]
				}
			}
			dailyTotals = append(dailyTotals, value)
		} else {
			dailyTotals = append(dailyTotals, Object{"date": date, "recordCount": int64(0)})
		}
	}

	allTime := Object{"count": result.allTimeCount, "earliestDate": nil, "latestDate": nil}
	if earliest != nil {
		allTime["earliestDate"] = *earliest
	}
	if latest != nil {
		allTime["latestDate"] = *latest
	}
	recent := Object{
		"recordCount":         result.recentCount,
		"includedRecordCount": len(samples),
		"truncated":           result.truncated,
		"samples":             samples,
		"dailyTotals":         dailyTotals,
	}
	result.data = Object{"allTime": allTime, "recentWindow": recent}
	return result, nil
}

func passportVoiceRecordWindowExpression(spec passportVoiceRecordSpec, startParameter, endParameter int) string {
	if spec.timeBased {
		return fmt.Sprintf("%s >= $%d::timestamptz AND %s < $%d::timestamptz", spec.windowField, startParameter, spec.windowField, endParameter)
	}
	if spec.kind == "food" {
		return fmt.Sprintf("%s >= $%d::text AND %s < $%d::text", spec.windowField, startParameter, spec.windowField, endParameter)
	}
	return fmt.Sprintf("%s >= $%d::date AND %s < $%d::date", spec.windowField, startParameter, spec.windowField, endParameter)
}

func passportVoiceRecordWindowArgs(spec passportVoiceRecordSpec, window passportVoiceRecordWindow, includeTimeZone bool) []any {
	args := []any{window.familyID, window.babyID}
	if includeTimeZone {
		args = append(args, window.timezone)
	}
	if spec.timeBased {
		args = append(args, window.startAt, window.endAt)
	} else {
		args = append(args, window.startDate, window.endDate)
	}
	return args
}

func dailyValueExpression(spec passportVoiceRecordSpec) string {
	if spec.dayValue == "" {
		return "NULL::text"
	}
	return spec.dayValue
}

func qualifiedWindowExpression(spec passportVoiceRecordSpec) string {
	return qualifiedPassportVoiceRecordWindowExpression(spec, 4, 5)
}

func qualifiedPassportVoiceRecordWindowExpression(spec passportVoiceRecordSpec, startParameter, endParameter int) string {
	window := passportVoiceRecordWindowExpression(spec, startParameter, endParameter)
	for _, column := range []string{"occurred_at", "started_at", "record_date", "measurement_date"} {
		window = replaceSQLIdentifier(window, column, "r."+column)
	}
	return window
}

func qualifiedDayExpression(spec passportVoiceRecordSpec) string {
	expression := spec.dayExpr
	for _, column := range []string{"occurred_at", "started_at", "record_date", "measurement_date"} {
		expression = replaceSQLIdentifier(expression, column, "r."+column)
	}
	return expression
}

func replaceSQLIdentifier(query, old, replacement string) string {
	return strings.ReplaceAll(query, old, replacement)
}

func (s *Server) logPassportVoiceRecordContext(result string, loaded passportVoiceRecordContext) {
	if s.Log == nil {
		return
	}
	s.Log.Info("passport record context",
		slog.String("result", result),
		slog.Int("windowDays", passportVoiceRecordWindowDays),
		slog.Int64("totalRecordCount", loaded.TotalRecordCount),
		slog.Int64("recentRecordCount", loaded.RecentRecordCount),
		slog.Bool("truncated", loaded.Truncated))
}
