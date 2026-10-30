package backend

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestNativeDailySummaryProviderConfiguration(t *testing.T) {
	t.Setenv("GROWDESK_ENV", "production")
	t.Setenv("GROWDESK_DAILY_SUMMARY_API_KEY", "test_virtual_amd_key")
	t.Setenv("GROWDESK_DAILY_SUMMARY_BASE_URL", "")
	t.Setenv("GROWDESK_DAILY_SUMMARY_TIMEOUT_MS", "")
	t.Setenv("GROWDESK_AI_API_KEY", "test_unrelated_openai_key")
	t.Setenv("OPENAI_API_KEY", "test_unrelated_openai_fallback")

	config, err := nativeDailySummaryProviderConfiguration()
	if err != nil {
		t.Fatal(err)
	}
	if config.Mode != "openai-compatible" || config.Model != "DeepSeek-V4.1-Flash" || config.Endpoint != nativeDailySummaryEndpoint || config.Timeout != 60*time.Second || config.APIKey != "test_virtual_amd_key" {
		t.Fatalf("unexpected scheduled provider config: mode=%q model=%q endpoint=%q timeout=%s", config.Mode, config.Model, config.Endpoint, config.Timeout)
	}

	t.Setenv("GROWDESK_DAILY_SUMMARY_API_KEY", "")
	if _, err = nativeDailySummaryProviderConfiguration(); err == nil || normalizedError(err).Code != "AI_PROVIDER_NOT_CONFIGURED" {
		t.Fatalf("missing dedicated AMD key should not fall back to another provider: %v", err)
	}
	t.Setenv("GROWDESK_DAILY_SUMMARY_API_KEY", "test_virtual_amd_key")
	t.Setenv("GROWDESK_DAILY_SUMMARY_TIMEOUT_MS", "99")
	if _, err = nativeDailySummaryProviderConfiguration(); err == nil || normalizedError(err).Code != "AI_PROVIDER_CONFIG_INVALID" {
		t.Fatalf("out of range timeout accepted: %v", err)
	}
}

func TestNativeDailySummaryEndpointAllowlist(t *testing.T) {
	got, err := nativeDailySummaryEndpointFor("https://developer.amd.com.cn/radeon/api/v1", false)
	if err != nil || got != nativeDailySummaryEndpoint {
		t.Fatalf("official API root should normalize to the completion endpoint: %q %v", got, err)
	}
	for _, raw := range []string{
		"http://developer.amd.com.cn/radeon/api/v1",
		"https://developer.amd.com.cn.evil.test/radeon/api/v1/chat/completions",
		"https://developer.amd.com.cn:443/radeon/api/v1/chat/completions",
		"https://developer.amd.com.cn/radeon/api/v1/chat/completions?",
		"https://developer.amd.com.cn/radeon/api/v1/chat/completions#",
		"https://developer.amd.com.cn/other",
	} {
		if _, err := nativeDailySummaryEndpointFor(raw, false); err == nil {
			t.Errorf("unsafe official endpoint accepted: %q", raw)
		}
	}
	got, err = nativeDailySummaryEndpointFor("http://127.0.0.1:43123/mock", true)
	if err != nil || got != "http://127.0.0.1:43123/mock/chat/completions" {
		t.Fatalf("owned loopback test endpoint should normalize: %q %v", got, err)
	}
	for _, raw := range []string{"http://localhost:43123", "https://example.test:443/mock", "http://127.0.0.1:43123/mock?"} {
		if _, err := nativeDailySummaryEndpointFor(raw, true); err == nil {
			t.Errorf("non-loopback or ambiguous test endpoint accepted: %q", raw)
		}
	}
}

func TestDailySummaryRetryPolicy(t *testing.T) {
	for attempt, bounds := range map[int64][2]time.Duration{
		1:    {1600 * time.Millisecond, 2400 * time.Millisecond},
		2:    {3200 * time.Millisecond, 4800 * time.Millisecond},
		9:    {409600 * time.Millisecond, 614400 * time.Millisecond},
		10:   {8 * time.Minute, 10 * time.Minute},
		1000: {8 * time.Minute, 10 * time.Minute},
	} {
		if got := dailySummaryRetryDelay(attempt); got < bounds[0] || got > bounds[1] {
			t.Errorf("attempt %d delay=%s want range=%s..%s", attempt, got, bounds[0], bounds[1])
		}
	}
	if !scheduledDailyFailureShouldRetry(providerFailure("AI_PROVIDER_HTTP_ERROR", "provider unavailable", true)) {
		t.Fatal("retryable scheduled provider failures should persistently retry")
	}
	authFailure := providerFailure("AI_PROVIDER_AUTH_FAILED", "invalid credentials", false)
	authDelay := scheduledDailyConfigurationRetryDelay(1, authFailure)
	if !scheduledDailyFailureShouldRetry(authFailure) || authDelay < 10*time.Minute || authDelay > 11*time.Minute {
		t.Fatalf("scheduled provider authorization failures need a 10 to 11 minute retry delay: %s", authDelay)
	}
	for _, configFailure := range []error{
		apiError(503, "AI_PROVIDER_NOT_CONFIGURED", "provider key missing"),
		apiError(500, "AI_PROVIDER_CONFIG_INVALID", "provider config invalid"),
	} {
		delay := scheduledDailyConfigurationRetryDelay(2, configFailure)
		if !scheduledDailyFailureShouldRetry(configFailure) || delay < 10*time.Minute || delay > 11*time.Minute {
			t.Fatalf("scheduled provider configuration failure needs a 10 to 11 minute retry delay: %v delay=%s", configFailure, delay)
		}
	}
	if scheduledDailyFailureShouldRetry(providerFailure("AI_PROVIDER_HTTP_ERROR", "bad request", false)) {
		t.Fatal("permanent provider request errors should not retry")
	}
	if scheduledDailyFailureShouldRetry(apiError(403, "BABY_ACCESS_DENIED", "revoked")) {
		t.Fatal("revoked baby scope must stop scheduled retries")
	}
	if scheduledDailyFailureShouldRetry(apiError(413, "SUMMARY_TOO_LARGE", "too much data")) {
		t.Fatal("deterministically oversized summaries must not retry forever")
	}
	if got := parseProviderRetryAfter("240", time.Now()); got != 4*time.Minute {
		t.Fatalf("numeric Retry-After=%s want 4m", got)
	}
	if got := parseProviderRetryAfter("999999999", time.Now()); got != nativeDailyRetryAfterCap {
		t.Fatalf("Retry-After should be bounded: %s", got)
	}
}

func TestDailySummarySlotAndLocalDates(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"2026-10-30T03:59:00Z", "20261029T1605Z"},
		{"2026-10-30T04:00:00Z", "20261030T0400Z"},
		{"2026-10-30T15:59:00Z", "20261030T0400Z"},
		{"2026-10-30T16:05:00Z", "20261030T1605Z"},
	}
	for _, tc := range cases {
		input, err := time.Parse(time.RFC3339, tc.input)
		if err != nil {
			t.Fatal(err)
		}
		if got := dailySummarySlot(input).Format("20060102T1504Z"); got != tc.want {
			t.Errorf("slot(%s)=%s want=%s", tc.input, got, tc.want)
		}
	}
	input, _ := time.Parse(time.RFC3339, "2026-10-30T16:05:00Z")
	dates, err := dailySummaryTargetDates(input, "Asia/Tokyo")
	if err != nil || strings.Join(dates, ",") != "2026-10-30" {
		t.Fatalf("local target dates=%v err=%v", dates, err)
	}
	if _, err := dailySummaryTargetDates(input, "invalid/test-zone"); err == nil {
		t.Fatal("invalid timezone was accepted")
	}
}

func TestBuildScheduledDailySummaryContent(t *testing.T) {
	input := nativeTaskInput{TargetDate: "2026-10-29", BabyID: "test_baby_uuid"}
	raw := `{"overallScore":"作息规律","overallRating":4.5,"statusLevel":"good","headline":"今天记录平稳。","highlights":["喂养有记录","睡眠有记录"],"sections":{"feeding":"依据已记录的喂养信息。","sleep":"依据已记录的睡眠信息。","diaper":"暂无异常记录。","growthAndCare":"仅总结现有护理信息。","tomorrowTips":"按宝宝状态继续观察。"},"suggestedQuestions":["需要补充哪些记录？","如何观察睡眠？","喂养节奏怎样调整？"],"disclaimer":"仅供日常照护参考，不构成诊断。"}`
	generatedAt := time.Date(2026, 10, 30, 16, 5, 0, 0, time.FixedZone("test", 8*60*60))
	content, err := buildScheduledDailySummaryContent(raw, input, generatedAt)
	if err != nil {
		t.Fatal(err)
	}
	if os.Getenv("GROWDESK_TEST_WRITE_SCHEDULED_REPORT_FIXTURE") == "1" {
		if err := os.WriteFile("/tmp/growdesk-scheduled-report-wire.json", []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	var value Object
	if err = decodeJSON([]byte(content), &value); err != nil {
		t.Fatal(err)
	}
	if value["schemaVersion"] != json.Number("1") || value["kind"] != "scheduled_daily_summary" || value["date"] != input.TargetDate || value["babyId"] != input.BabyID || value["generatedAt"] != "2026-10-30T08:05:00.000Z" || text(value["overallRating"]) != "4.5" || value["rating"] != nil || value["metrics"] != nil {
		t.Fatalf("unexpected canonical report metadata: %#v", value)
	}
	llm := obj(value["llm"])
	if text(llm["source"]) != "api" || text(llm["provider"]) != "developer.amd.com.cn" || text(llm["model"]) != nativeDailySummaryModel {
		t.Fatalf("unexpected server-owned report provenance: %#v", llm)
	}
	for _, invalid := range []string{
		`{"headline":"only text"}`,
		`{"overallScore":"x","overallRating":9,"statusLevel":"good","headline":"x","highlights":["a","b"],"sections":{},"suggestedQuestions":["a","b","c"],"disclaimer":"x"}`,
		"```json\n{\"headline\":\"partial\"}",
	} {
		if _, err := buildScheduledDailySummaryContent(invalid, input, generatedAt); err == nil {
			t.Errorf("invalid structured report accepted: %q", invalid)
		}
	}
}
