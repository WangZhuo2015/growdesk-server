package backend

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestWeatherRequestValidationAndDefault(t *testing.T) {
	for _, tc := range []struct {
		url     string
		wantErr bool
		wantDef bool
	}{
		{"/api/v1/weather", false, true},
		{"/api/v1/weather?city=%E4%B8%8A%E6%B5%B7", false, false},
		{"/api/v1/weather?lat=31.3&lon=120.62", false, false},
		{"/api/v1/weather?unit=fahrenheit", true, false},
		{"/api/v1/weather?lat=31.3", true, false},
		{"/api/v1/weather?lon=120.62", true, false},
		{"/api/v1/weather?city=%E4%B8%8A%E6%B5%B7&lat=31&lon=121", true, false},
		{"/api/v1/weather?lat=90.1&lon=121", true, false},
		{"/api/v1/weather?lat=NaN&lon=121", true, false},
		{"/api/v1/weather?city=%20%20", true, false},
		{"/api/v1/weather?city=%E4%B8%8A%E6%B5%B7&city=%E5%8C%97%E4%BA%AC", true, false},
	} {
		t.Run(tc.url, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, tc.url, nil)
			got, err := parseWeatherRequest(request)
			if (err != nil) != tc.wantErr {
				t.Fatalf("unexpected parse result: got=%+v err=%v", got, err)
			}
			if err == nil && got.Default != tc.wantDef {
				t.Fatalf("default strategy mismatch: %+v", got)
			}
		})
	}
}

func TestWeatherOpenAPIQueryNumberValidation(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		query   string
		wantErr bool
	}{
		{"?lat=31.3&lon=120.62", false},
		{"?lat=-90&lon=-180", false},
		{"?lat=90.01&lon=0", true},
		{"?lat=NaN&lon=0", true},
		{"?lat=Infinity&lon=0", true},
		{"?unit=fahrenheit", true},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/weather"+tc.query, nil)
		err := contract.ByID["getWeather"].Validate(req, nil, nil)
		if (err != nil) != tc.wantErr {
			t.Fatalf("query %s err=%v wantErr=%t", tc.query, err, tc.wantErr)
		}
	}
}

func TestWeatherProviderFailsClosedWithoutLoopbackFixtureInTest(t *testing.T) {
	provider, err := newWeatherProvider(Config{Environment: "test"})
	if err != nil || !provider.disabled {
		t.Fatalf("test provider must be disabled without fixture: provider=%+v err=%v", provider, err)
	}
	for _, origin := range []string{
		"https://api.open-meteo.com",
		"http://example.com:1234",
		"http://127.0.0.1",
		"http://127.0.0.1:8080/path",
		"http://user:pass@127.0.0.1:8080",
		"http://[::1]:8080?x=1",
	} {
		if validWeatherTestOrigin(origin) {
			t.Fatalf("unsafe fixture origin accepted: %q", origin)
		}
	}
	if _, err := newWeatherProvider(Config{Environment: "development", WeatherTestProviderOrigin: "http://127.0.0.1:18001"}); err == nil {
		t.Fatal("non-test configuration accepted the test override")
	}
}

func TestWeatherProviderEnforcesRedirectAndResponseByteLimit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/redirect":
			http.Redirect(w, r, "/json", http.StatusTemporaryRedirect)
		case "/large":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"value":"`+strings.Repeat("x", weatherMaxResponseBytes)+`"}`)
		default:
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"ok":true}`)
		}
	}))
	defer server.Close()
	provider, err := newWeatherProvider(Config{Environment: "test", WeatherTestProviderOrigin: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.getJSON(context.Background(), "fixture", nil); err == nil {
		t.Fatal("unknown provider operation accepted")
	}
	// Redirects to a provider path cannot cause an unreviewed second request.
	provider.testOrigin = server.URL
	provider.HTTP = &http.Client{
		Transport: http.DefaultTransport,
		Timeout:   weatherProviderTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	if _, err := provider.requestJSONPath(context.Background(), "/redirect"); err == nil {
		t.Fatal("redirect was followed or treated as success")
	}
	if _, err := provider.requestJSONPath(context.Background(), "/large"); err == nil {
		t.Fatal("oversized provider response was accepted")
	}
}

func TestWeatherProviderRequestJSONPathHelper(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()
	provider, err := newWeatherProvider(Config{Environment: "test", WeatherTestProviderOrigin: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	provider.testOrigin = server.URL
	if _, err := provider.requestJSONPath(context.Background(), "/json"); err != nil {
		t.Fatal(err)
	}
}

func TestBuildWeatherResponsePreservesNullAndLocalHourlyDates(t *testing.T) {
	forecast := Object{
		"timezone": "Asia/Shanghai",
		"current": Object{
			"time": "2026-10-03T22:00", "temperature_2m": json.Number("19.5"),
			"relative_humidity_2m": json.Number("71"), "precipitation": json.Number("0"),
			"weather_code": json.Number("2"), "wind_speed_10m": json.Number("6"),
		},
		"daily": Object{"uv_index_max": []any{json.Number("3.5")}, "precipitation_probability_max": []any{json.Number("40")}},
		"hourly": Object{
			"time":                      []any{"2026-10-03T23:00", "2026-10-04T00:00"},
			"temperature_2m":            []any{json.Number("18"), json.Number("17")},
			"precipitation_probability": []any{json.Number("20"), json.Number("25")},
			"weather_code":              []any{json.Number("2"), json.Number("3")},
		},
	}
	location := weatherLocation{City: "test city", Timezone: "Asia/Shanghai", Source: "coordinates"}
	result := buildWeatherResponse(location, forecast, nil, "2026-10-03T14:00:00Z")
	if result["uvCurrent"] != nil || result["airQualityIndex"] != nil || result["airQualityCategory"] != nil || result["airQuality"] != nil {
		t.Fatalf("missing air values were not null: %#v", result)
	}
	if result["uv"] != 3.5 || result["temperature"] != 19.5 || result["condition"] != "局部多云" {
		t.Fatalf("weather values lost or remapped: %#v", result)
	}
	rows, ok := result["hourlyForecast"].([]Object)
	if !ok || len(rows) != 2 || rows[0]["time"] != "23:00" || rows[1]["time"] != "00:00" || rows[1]["dateTime"] != "2026-10-04T00:00:00+08:00" {
		t.Fatalf("local hourly boundary was not preserved: %#v", result["hourlyForecast"])
	}
	if result["outdoorAdvice"] == "" {
		t.Fatal("outdoor advice missing")
	}
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	wireBytes, err := jsonBytes(envelope(result))
	if err != nil {
		t.Fatal(err)
	}
	var wire any
	if err := json.Unmarshal(wireBytes, &wire); err != nil {
		t.Fatal(err)
	}
	if err := contract.ByID["getWeather"].ValidateResponse(context.Background(), http.StatusOK, wire); err != nil {
		t.Fatalf("weather response does not satisfy the generated OpenAPI schema: %v", err)
	}
}

func TestWeatherHourlyStartsAtCurrentLocalHourAndMatchesAirByTimestamp(t *testing.T) {
	forecast := Object{
		"timezone": "Asia/Shanghai",
		"current": Object{
			"time": "2026-10-03T22:00", "temperature_2m": json.Number("19"),
			"relative_humidity_2m": json.Number("70"), "precipitation": json.Number("0"),
			"weather_code": json.Number("2"),
		},
		"daily": Object{"uv_index_max": []any{json.Number("8")}, "precipitation_probability_max": []any{json.Number("35")}},
		"hourly": Object{
			"time":                      []any{"2026-10-03T00:00", "2026-10-03T22:00", "2026-10-03T23:00", "2026-10-04T00:00"},
			"temperature_2m":            []any{json.Number("13"), json.Number("19"), json.Number("18"), json.Number("17")},
			"precipitation_probability": []any{json.Number("1"), json.Number("22"), json.Number("23"), json.Number("24")},
			"weather_code":              []any{json.Number("0"), json.Number("2"), json.Number("3"), json.Number("61")},
			"uv_index":                  []any{json.Number("1"), json.Number("2"), json.Number("3"), json.Number("4")},
		},
	}
	air := Object{"hourly": Object{
		"time":     []any{"2026-10-03T22:00", "2026-10-03T23:00", "2026-10-04T00:00"},
		"uv_index": []any{json.Number("9"), json.Number("8"), json.Number("7")},
	}}
	result := buildWeatherResponse(weatherLocation{City: "测试城市", Timezone: "Asia/Shanghai", Source: "coordinates"}, forecast, air, "2026-10-03T14:00:00Z")
	if result["currentPrecipitationProbability"] != float64(22) || result["uvCurrent"] != float64(9) {
		t.Fatalf("current metrics were not matched to current local hour: probability=%#v uv=%#v", result["currentPrecipitationProbability"], result["uvCurrent"])
	}
	rows, ok := result["hourlyForecast"].([]Object)
	if !ok || len(rows) != 3 || rows[0]["time"] != "22:00" || rows[1]["time"] != "23:00" || rows[2]["time"] != "00:00" {
		t.Fatalf("hourly forecast did not start at current hour and cross local midnight: %#v", result["hourlyForecast"])
	}
	if rows[0]["uv"] != float64(9) || rows[1]["uv"] != float64(8) || rows[2]["uv"] != float64(7) || rows[2]["dateTime"] != "2026-10-04T00:00:00+08:00" {
		t.Fatalf("hourly air readings were not joined by timestamp: %#v", rows)
	}
}

func TestEuropeanAQICategoryKeepsScaleDistinct(t *testing.T) {
	for _, tc := range []struct {
		value    float64
		category string
	}{
		{0, "good"}, {20.1, "fair"}, {40.1, "moderate"}, {60.1, "poor"}, {80.1, "very_poor"}, {100.1, "extremely_poor"},
	} {
		category, _ := europeanAQICategory(tc.value)
		if category != tc.category {
			t.Fatalf("AQI %.1f category = %s, want %s", tc.value, category, tc.category)
		}
	}
}
