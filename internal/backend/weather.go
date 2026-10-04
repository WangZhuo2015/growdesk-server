package backend

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	weatherDefaultCity       = "苏州"
	weatherDefaultLatitude   = 31.30
	weatherDefaultLongitude  = 120.62
	weatherMaxResponseBytes  = 512 << 10
	weatherStaleRetention    = 24 * time.Hour
	weatherProviderTimeout   = 3 * time.Second
	weatherDefaultCacheFresh = 10 * time.Minute
)

type weatherProvider struct {
	HTTP       *http.Client
	testOrigin string
	disabled   bool
}

type weatherLocation struct {
	City      string
	Latitude  float64
	Longitude float64
	Timezone  string
	Source    string
}

type weatherRequest struct {
	City      string
	Latitude  float64
	Longitude float64
	HasCoords bool
	Default   bool
}

type weatherCacheEntry struct {
	FetchedAt string `json:"fetchedAt"`
	Data      Object `json:"data"`
}

func newWeatherProvider(c Config) (*weatherProvider, error) {
	if c.WeatherTestProviderOrigin != "" {
		if c.Environment != "test" || !validWeatherTestOrigin(c.WeatherTestProviderOrigin) {
			return nil, errors.New("WEATHER_TEST_PROVIDER_ORIGIN rejected: test-only loopback origin required")
		}
	}
	if c.Environment == "test" && c.WeatherTestProviderOrigin == "" {
		return &weatherProvider{disabled: true}, nil
	}
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: weatherProviderTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   weatherProviderTimeout,
		ResponseHeaderTimeout: weatherProviderTimeout,
		MaxIdleConns:          8,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       30 * time.Second,
	}
	return &weatherProvider{
		HTTP: &http.Client{
			Transport: transport,
			Timeout:   weatherProviderTimeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		testOrigin: strings.TrimRight(c.WeatherTestProviderOrigin, "/"),
	}, nil
}

func validWeatherTestOrigin(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return false
	}
	host := u.Hostname()
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() || u.Port() == "" {
		return false
	}
	port, err := strconv.Atoi(u.Port())
	return err == nil && port > 0 && port <= 65535
}

func (s *Server) registerWeather() {
	s.registerDeclared(http.MethodGet, "/api/v1/weather", s.getWeather)
}

func parseWeatherRequest(r *http.Request) (weatherRequest, error) {
	q := r.URL.Query()
	for name := range q {
		if name != "lat" && name != "lon" && name != "city" {
			return weatherRequest{}, invalid("Weather query contains an unsupported parameter")
		}
	}
	for _, name := range []string{"lat", "lon", "city"} {
		if len(q[name]) > 1 {
			return weatherRequest{}, invalid("Weather query parameters must not be repeated")
		}
	}
	latRaw, latPresent := q["lat"]
	lonRaw, lonPresent := q["lon"]
	cityRaw, cityPresent := q["city"]
	latPresent = latPresent && len(latRaw) > 0
	lonPresent = lonPresent && len(lonRaw) > 0
	cityPresent = cityPresent && len(cityRaw) > 0
	if latPresent != lonPresent || (cityPresent && (latPresent || lonPresent)) {
		return weatherRequest{}, invalid("Provide either city or both lat and lon")
	}
	if cityPresent {
		city := strings.TrimSpace(cityRaw[0])
		if len([]rune(city)) < 2 || len([]rune(city)) > 100 {
			return weatherRequest{}, invalid("city must contain 2 to 100 characters")
		}
		return weatherRequest{City: city}, nil
	}
	if latPresent {
		lat, errLat := strconv.ParseFloat(latRaw[0], 64)
		lon, errLon := strconv.ParseFloat(lonRaw[0], 64)
		if errLat != nil || errLon != nil || math.IsNaN(lat) || math.IsNaN(lon) || math.IsInf(lat, 0) || math.IsInf(lon, 0) || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
			return weatherRequest{}, invalid("lat or lon is outside its valid range")
		}
		return weatherRequest{Latitude: lat, Longitude: lon, HasCoords: true}, nil
	}
	if cityPresent || latPresent || lonPresent {
		return weatherRequest{}, invalid("Weather query is invalid")
	}
	return weatherRequest{City: weatherDefaultCity, Latitude: weatherDefaultLatitude, Longitude: weatherDefaultLongitude, HasCoords: true, Default: true}, nil
}

func (s *Server) getWeather(ctx context.Context, r *Request) (Result, error) {
	query, err := parseWeatherRequest(r.HTTP)
	if err != nil {
		return Result{}, err
	}
	if s.Weather == nil || s.Weather.disabled {
		return Result{}, apiError(503, "WEATHER_PROVIDER_DISABLED", "Weather provider is not configured for this environment")
	}
	cacheKey := weatherCacheKey(query)
	redisKey := "growdesk:weather:v1:" + cacheKey
	freshTTL := s.Config.WeatherCacheFreshTTL
	if freshTTL <= 0 {
		freshTTL = weatherDefaultCacheFresh
	}
	var stale *weatherCacheEntry
	cacheUnavailable := s.Redis == nil
	if s.Redis != nil {
		raw, getErr := s.Redis.Get(ctx, redisKey).Bytes()
		if getErr == nil {
			var entry weatherCacheEntry
			if decodeJSON(raw, &entry) == nil && entry.Data != nil {
				if fetched, parseErr := time.Parse(time.RFC3339Nano, entry.FetchedAt); parseErr == nil {
					age := time.Since(fetched)
					if age < 0 {
						age = 0
					}
					if age <= freshTTL {
						return weatherCachedResult(entry, "hit", false, nil, freshTTL), nil
					}
					if age <= weatherStaleRetention {
						stale = &entry
					}
				}
			} else {
				_ = s.Redis.Del(ctx, redisKey).Err()
			}
		} else if !errors.Is(getErr, redis.Nil) {
			cacheUnavailable = true
		}
	}

	location, forecast, air, airErr, fetchErr := s.fetchWeather(ctx, query)
	if fetchErr != nil {
		var apiErr *APIError
		if errors.As(fetchErr, &apiErr) && apiErr.Status < 500 {
			return Result{}, fetchErr
		}
		if stale != nil {
			age := weatherEntryAge(*stale)
			if time.Duration(age)*time.Second <= weatherStaleRetention {
				return weatherCachedResult(*stale, "stale", true, &age, freshTTL), nil
			}
		}
		return Result{}, apiError(502, "WEATHER_PROVIDER_UNAVAILABLE", "Weather data is temporarily unavailable")
	}
	_ = airErr // Air quality is explicitly optional; missing values remain null.

	fetchedAt := time.Now().UTC().Format(time.RFC3339Nano)
	data := buildWeatherResponse(location, forecast, air, fetchedAt)
	entry := weatherCacheEntry{FetchedAt: fetchedAt, Data: data}
	cacheState := "miss"
	if s.Redis != nil {
		serialized, marshalErr := json.Marshal(entry)
		if marshalErr != nil || s.Redis.Set(ctx, redisKey, serialized, weatherStaleRetention).Err() != nil {
			cacheUnavailable = true
		}
	} else {
		cacheUnavailable = true
	}
	if cacheUnavailable {
		cacheState = "unavailable"
	}
	data["cacheState"] = cacheState
	data["isStale"] = false
	data["staleAgeSeconds"] = nil
	data["cacheMaxAgeSeconds"] = int(freshTTL.Seconds())
	return ok(data)
}

func weatherCacheKey(q weatherRequest) string {
	var material string
	switch {
	case q.Default:
		material = "default-suzhou-v1"
	case q.HasCoords:
		material = fmt.Sprintf("coords:%.6f:%.6f", q.Latitude, q.Longitude)
	default:
		material = "city:" + strings.ToLower(strings.Join(strings.Fields(q.City), " "))
	}
	digest := sha256.Sum256([]byte(material))
	return hex.EncodeToString(digest[:])
}

func weatherCachedResult(entry weatherCacheEntry, state string, stale bool, staleAge *int64, freshTTL time.Duration) Result {
	data := cloneWeatherObject(entry.Data)
	data["cacheState"] = state
	data["isStale"] = stale
	data["staleAgeSeconds"] = staleAge
	data["cacheMaxAgeSeconds"] = int(freshTTL.Seconds())
	return Result{Status: 200, Body: envelope(data)}
}

func cloneWeatherObject(source Object) Object {
	copy := make(Object, len(source))
	for key, value := range source {
		copy[key] = value
	}
	return copy
}

func weatherEntryAge(entry weatherCacheEntry) int64 {
	fetched, err := time.Parse(time.RFC3339Nano, entry.FetchedAt)
	if err != nil {
		return 0
	}
	age := time.Since(fetched).Seconds()
	if age < 0 {
		return 0
	}
	return int64(age)
}

func (s *Server) fetchWeather(ctx context.Context, query weatherRequest) (weatherLocation, Object, Object, error, error) {
	location := weatherLocation{City: query.City, Latitude: query.Latitude, Longitude: query.Longitude}
	if !query.HasCoords {
		found, err := s.Weather.getJSON(ctx, "geocoding", url.Values{
			"name":     []string{query.City},
			"count":    []string{"1"},
			"language": []string{"zh"},
			"format":   []string{"json"},
		})
		if err != nil {
			return weatherLocation{}, nil, nil, nil, err
		}
		results := arrayAt(found, "results")
		if len(results) == 0 {
			return weatherLocation{}, nil, nil, nil, apiError(404, "WEATHER_CITY_NOT_FOUND", "No matching city was found")
		}
		geo := object(results[0])
		lat, okLat := numberAt(geo, "latitude")
		lon, okLon := numberAt(geo, "longitude")
		name, okName := stringAt(geo, "name")
		tz, okTZ := stringAt(geo, "timezone")
		if !okLat || !okLon || !okName || !okTZ || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
			return weatherLocation{}, nil, nil, nil, errors.New("invalid geocoding response")
		}
		if _, err := time.LoadLocation(tz); err != nil {
			return weatherLocation{}, nil, nil, nil, errors.New("invalid geocoding timezone")
		}
		location = weatherLocation{City: weatherCityLabel(name, geo), Latitude: lat, Longitude: lon, Timezone: tz, Source: "open_meteo_geocoding"}
	} else if query.Default {
		location.Source = "legacy_default_suzhou"
	} else {
		location.City = "当前位置"
		location.Source = "coordinates"
	}
	forecast, err := s.Weather.getJSON(ctx, "forecast", url.Values{
		"latitude":  []string{strconv.FormatFloat(location.Latitude, 'f', 6, 64)},
		"longitude": []string{strconv.FormatFloat(location.Longitude, 'f', 6, 64)},
		"current":   []string{"temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m"},
		"hourly":    []string{"temperature_2m,precipitation_probability,weather_code,uv_index"},
		"daily":     []string{"uv_index_max,precipitation_probability_max"},
		// Two days are needed to fill the next-eight-hours contract near local
		// midnight while keeping all display times in the forecast timezone.
		"forecast_days":      []string{"2"},
		"timezone":           []string{"auto"},
		"temperature_unit":   []string{"celsius"},
		"wind_speed_unit":    []string{"kmh"},
		"precipitation_unit": []string{"mm"},
	})
	if err != nil {
		return weatherLocation{}, nil, nil, nil, err
	}
	tz, ok := stringAt(forecast, "timezone")
	if !ok {
		return weatherLocation{}, nil, nil, nil, errors.New("forecast response missing timezone")
	}
	if _, err := time.LoadLocation(tz); err != nil {
		return weatherLocation{}, nil, nil, nil, errors.New("forecast response has invalid timezone")
	}
	location.Timezone = tz
	if location.Source == "" {
		location.Source = "open_meteo_geocoding"
	}
	air, airErr := s.Weather.getJSON(ctx, "air", url.Values{
		"latitude":       []string{strconv.FormatFloat(location.Latitude, 'f', 6, 64)},
		"longitude":      []string{strconv.FormatFloat(location.Longitude, 'f', 6, 64)},
		"current":        []string{"european_aqi,uv_index"},
		"hourly":         []string{"european_aqi,uv_index"},
		"timezone":       []string{"auto"},
		"forecast_hours": []string{"8"},
	})
	if airErr != nil {
		air = nil
	}
	return location, forecast, air, airErr, nil
}

func weatherCityLabel(name string, item Object) string {
	parts := []string{name}
	if admin, ok := stringAt(item, "admin1"); ok && admin != name {
		parts = append(parts, admin)
	}
	if country, ok := stringAt(item, "country"); ok && country != name {
		parts = append(parts, country)
	}
	label := strings.Join(parts, ", ")
	if len([]rune(label)) > 200 {
		return name
	}
	return label
}

func (p *weatherProvider) getJSON(ctx context.Context, service string, query url.Values) (Object, error) {
	if p == nil || p.disabled {
		return nil, errors.New("weather provider disabled")
	}
	var endpoint string
	if p.testOrigin != "" {
		paths := map[string]string{"geocoding": "/v1/search", "forecast": "/v1/forecast", "air": "/v1/air-quality"}
		path, ok := paths[service]
		if !ok {
			return nil, errors.New("unknown weather provider service")
		}
		endpoint = p.testOrigin + path
	} else {
		hosts := map[string]string{
			"geocoding": "https://geocoding-api.open-meteo.com/v1/search",
			"forecast":  "https://api.open-meteo.com/v1/forecast",
			"air":       "https://air-quality-api.open-meteo.com/v1/air-quality",
		}
		var ok bool
		endpoint, ok = hosts[service]
		if !ok {
			return nil, errors.New("unknown weather provider service")
		}
	}
	return p.getJSONURL(ctx, endpoint, query)
}

// requestJSONPath exists to exercise response handling against the configured
// test-only loopback provider. Production code can only use the fixed service map.
func (p *weatherProvider) requestJSONPath(ctx context.Context, path string) (Object, error) {
	if p == nil || p.disabled || p.testOrigin == "" || !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return nil, errors.New("test weather path is unavailable")
	}
	return p.getJSONURL(ctx, p.testOrigin+path, nil)
}

func (p *weatherProvider) getJSONURL(ctx context.Context, endpoint string, query url.Values) (Object, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, errors.New("invalid weather provider endpoint")
	}
	u.RawQuery = query.Encode()
	requestCtx, cancel := context.WithTimeout(ctx, weatherProviderTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, errors.New("weather provider request could not be created")
	}
	req.Header.Set("Accept", "application/json")
	response, err := p.HTTP.Do(req)
	if err != nil {
		return nil, errors.New("weather provider request failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("weather provider returned HTTP %d", response.StatusCode)
	}
	mediaType, _, mediaErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaErr != nil || mediaType != "application/json" {
		return nil, errors.New("weather provider response was not JSON")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, weatherMaxResponseBytes+1))
	if err != nil || len(raw) > weatherMaxResponseBytes {
		return nil, errors.New("weather provider response exceeded the size limit")
	}
	var result Object
	if err := decodeJSON(raw, &result); err != nil || result == nil {
		return nil, errors.New("weather provider returned invalid JSON")
	}
	return result, nil
}

func buildWeatherResponse(location weatherLocation, forecast, air Object, fetchedAt string) Object {
	loc, locErr := time.LoadLocation(location.Timezone)
	if locErr != nil {
		loc = time.UTC
	}
	current := object(forecast["current"])
	currentWeatherCode, haveCode := integerAt(current, "weather_code")
	condition, icon := weatherCondition(currentWeatherCode, haveCode)
	temperature, hasTemperature := numberAt(current, "temperature_2m")
	var temperatureValue any
	if hasTemperature && temperature >= -100 && temperature <= 100 {
		temperatureValue = temperature
	}
	humidity, hasHumidity := numberAt(current, "relative_humidity_2m")
	var humidityValue any
	if hasHumidity && humidity >= 0 && humidity <= 100 {
		humidityValue = humidity
	}
	precipitation, hasPrecipitation := numberAt(current, "precipitation")
	var precipitationValue any
	if hasPrecipitation && precipitation >= 0 {
		precipitationValue = precipitation
	}
	windSpeed, hasWind := numberAt(current, "wind_speed_10m")
	var windValue any
	if hasWind && windSpeed >= 0 {
		windValue = windSpeed
	}
	observedAt := weatherDateTime(stringValue(current["time"]), loc)
	var codeValue any
	if haveCode && currentWeatherCode >= 0 && currentWeatherCode <= 999 {
		codeValue = currentWeatherCode
	}
	daily := firstObjectAt(forecast, "daily")
	dailyUV, hasDailyUV := numberAt(daily, "uv_index_max")
	dailyRain, hasDailyRain := numberAt(daily, "precipitation_probability_max")
	if !hasDailyUV || dailyUV < 0 || dailyUV > 30 {
		dailyUV = 0
		hasDailyUV = false
	}
	if !hasDailyRain || dailyRain < 0 || dailyRain > 100 {
		dailyRain = 0
		hasDailyRain = false
	}
	var uvDailyValue, rainDailyValue any
	if hasDailyUV {
		uvDailyValue = dailyUV
	}
	if hasDailyRain {
		rainDailyValue = dailyRain
	}
	airCurrent := object(air["current"])
	uvCurrent, hasUVCurrent := numberAt(airCurrent, "uv_index")
	if !hasUVCurrent || uvCurrent < 0 || uvCurrent > 30 {
		uvCurrent, hasUVCurrent = weatherHourlyNumberAt(air, "uv_index", stringValue(current["time"]), loc)
		if !hasUVCurrent {
			uvCurrent, hasUVCurrent = weatherHourlyNumberAt(forecast, "uv_index", stringValue(current["time"]), loc)
		}
		if !hasUVCurrent || uvCurrent < 0 || uvCurrent > 30 {
			uvCurrent = 0
			hasUVCurrent = false
		}
	}
	var uvCurrentValue any
	if hasUVCurrent {
		uvCurrentValue = uvCurrent
	}
	aqi, hasAQI := numberAt(airCurrent, "european_aqi")
	if !hasAQI || aqi < 0 || aqi > 1000 {
		aqi = 0
		hasAQI = false
	}
	var aqiValue, aqiCategoryValue, airQualityLabel any
	if hasAQI {
		aqiValue = aqi
		category, label := europeanAQICategory(aqi)
		aqiCategoryValue = category
		airQualityLabel = fmt.Sprintf("欧洲AQI %.0f · %s", aqi, label)
	}

	precipitationProbability, hasPrecipProbability := weatherHourlyNumberAt(forecast, "precipitation_probability", stringValue(current["time"]), loc)
	if !hasPrecipProbability || precipitationProbability < 0 || precipitationProbability > 100 {
		precipitationProbability = 0
		hasPrecipProbability = false
	}
	var currentPrecipProbabilityValue any
	if hasPrecipProbability {
		currentPrecipProbabilityValue = precipitationProbability
	}
	hourly := weatherHourlyForecast(forecast, air, loc)
	var adviceSignals Object
	adviceSignals = Object{"temperature": temperatureValue, "precipProbability": currentPrecipProbabilityValue,
		"uv": uvCurrentValue, "aqi": aqiValue, "weatherCode": codeValue}
	advice := weatherOutdoorAdvice(adviceSignals)
	airSource := "open_meteo_air_quality_cams_european_aqi"
	if !hasAQI {
		airSource = "unavailable"
	}
	return Object{
		"city": location.City, "temperature": temperatureValue, "condition": condition, "conditionIcon": icon,
		"weatherCode": codeValue, "observedAt": observedAt, "uv": uvDailyValue, "uvCurrent": uvCurrentValue,
		"rainProbability": rainDailyValue, "currentPrecipitationProbability": currentPrecipProbabilityValue,
		"humidity": humidityValue, "precipitation": precipitationValue, "windSpeed": windValue,
		"airQuality": airQualityLabel, "airQualityIndex": aqiValue, "airQualityScale": "european_aqi",
		"airQualityCategory": aqiCategoryValue, "outdoorAdvice": advice, "hourlyForecast": hourly,
		"timezone": location.Timezone,
		"units": Object{"temperature": "°C", "uv": "index", "rainProbability": "%", "humidity": "%",
			"precipitation": "mm", "windSpeed": "km/h", "airQuality": "European AQI points"},
		"sources": Object{"location": location.Source, "weather": "open_meteo_forecast",
			"airQuality": airSource, "outdoorAdvice": "growdesk_weather_rules_v1",
			"attribution": "Weather data © Open-Meteo.com; air quality © CAMS via Open-Meteo; geocoding © GeoNames via Open-Meteo."},
		"fetchedAt": fetchedAt, "isStale": false, "cacheState": "miss", "staleAgeSeconds": nil,
		"cacheMaxAgeSeconds": int(weatherDefaultCacheFresh.Seconds()),
	}
}

func weatherHourlyForecast(forecast, air Object, loc *time.Location) []Object {
	hourly := object(forecast["hourly"])
	times := stringArrayAt(hourly, "time")
	current := object(forecast["current"])
	firstHour := time.Now().In(loc).Truncate(time.Hour)
	if observedAt := weatherDateTime(stringValue(current["time"]), loc); observedAt != nil {
		if parsed, err := time.Parse(time.RFC3339, *observedAt); err == nil {
			firstHour = parsed.In(loc).Truncate(time.Hour)
		}
	}
	result := make([]Object, 0, 8)
	for index, sourceTime := range times {
		dateTime := weatherDateTime(sourceTime, loc)
		if dateTime == nil {
			continue
		}
		parsedTime, err := time.Parse(time.RFC3339, *dateTime)
		if err != nil || parsedTime.In(loc).Before(firstHour) {
			continue
		}
		temperature, hasTemperature := numberArrayAt(hourly, "temperature_2m", index)
		code, hasCode := integerArrayAt(hourly, "weather_code", index)
		probability, hasProbability := numberArrayAt(hourly, "precipitation_probability", index)
		uv, hasUV := weatherHourlyNumberAt(air, "uv_index", sourceTime, loc)
		if !hasUV {
			uv, hasUV = weatherHourlyNumberAt(forecast, "uv_index", sourceTime, loc)
		}
		condition, icon := weatherCondition(code, hasCode)
		var temperatureValue, codeValue, probabilityValue, uvValue any
		if hasTemperature && temperature >= -100 && temperature <= 100 {
			temperatureValue = temperature
		}
		if hasCode && code >= 0 && code <= 999 {
			codeValue = code
		}
		if hasProbability && probability >= 0 && probability <= 100 {
			probabilityValue = probability
		}
		if hasUV && uv >= 0 && uv <= 30 {
			uvValue = uv
		}
		localTime, _ := time.Parse(time.RFC3339, *dateTime)
		result = append(result, Object{"time": localTime.In(loc).Format("15:04"), "dateTime": *dateTime,
			"temperature": temperatureValue, "weatherCode": codeValue, "condition": condition,
			"conditionIcon": icon, "precipitationProbability": probabilityValue, "uv": uvValue})
		if len(result) == 8 {
			break
		}
	}
	return result
}

func weatherHourlyNumberAt(root Object, metric, targetTime string, loc *time.Location) (float64, bool) {
	target := weatherDateTime(targetTime, loc)
	if target == nil {
		return 0, false
	}
	hourly := object(root["hourly"])
	for index, rawTime := range stringArrayAt(hourly, "time") {
		candidate := weatherDateTime(rawTime, loc)
		if candidate != nil && *candidate == *target {
			return numberArrayAt(hourly, metric, index)
		}
	}
	return 0, false
}

func weatherDateTime(raw string, loc *time.Location) *string {
	if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
		value := parsed.Format(time.RFC3339)
		return &value
	}
	for _, layout := range []string{"2006-01-02T15:04", "2006-01-02T15:04:05"} {
		if parsed, err := time.ParseInLocation(layout, raw, loc); err == nil {
			value := parsed.Format(time.RFC3339)
			return &value
		}
	}
	return nil
}

func weatherOutdoorAdvice(signals Object) string {
	if signals["temperature"] == nil && signals["precipProbability"] == nil && signals["uv"] == nil && signals["aqi"] == nil && signals["weatherCode"] == nil {
		return "天气信息不完整，建议查看最新预报后再安排户外活动。"
	}
	if aqi, ok := signals["aqi"].(float64); ok && aqi > 100 {
		return "欧洲空气质量指数偏高，户外活动前请关注当地提示。"
	}
	if uv, ok := signals["uv"].(float64); ok && uv >= 8 {
		return "紫外线较强，安排户外活动时可留意遮阳。"
	}
	if probability, ok := signals["precipProbability"].(float64); ok && probability >= 60 {
		return "降雨概率较高，外出可准备雨具。"
	}
	if code, ok := signals["weatherCode"].(int); ok && (code >= 95 || (code >= 80 && code <= 82)) {
		return "天气可能有强对流或阵雨，安排户外活动前请查看更新。"
	}
	return "天气条件可参考当前预报，出行前留意本地变化。"
}

func weatherCondition(code int, present bool) (string, string) {
	if !present {
		return "天气未知", "❔"
	}
	switch code {
	case 0:
		return "晴朗", "☀️"
	case 1:
		return "大致晴朗", "🌤️"
	case 2:
		return "局部多云", "⛅"
	case 3:
		return "阴天", "☁️"
	case 45, 48:
		return "有雾", "🌫️"
	case 51, 53, 55, 56, 57:
		return "毛毛雨", "🌦️"
	case 61, 63, 65, 66, 67:
		return "有雨", "🌧️"
	case 71, 73, 75, 77:
		return "有雪", "🌨️"
	case 80, 81, 82:
		return "阵雨", "🌦️"
	case 85, 86:
		return "阵雪", "🌨️"
	case 95, 96, 99:
		return "雷暴", "⛈️"
	default:
		return "天气未知", "❔"
	}
}

func europeanAQICategory(value float64) (string, string) {
	switch {
	case value <= 20:
		return "good", "好"
	case value <= 40:
		return "fair", "尚可"
	case value <= 60:
		return "moderate", "中等"
	case value <= 80:
		return "poor", "较差"
	case value <= 100:
		return "very_poor", "很差"
	default:
		return "extremely_poor", "极差"
	}
}

func object(value any) Object {
	if result, ok := value.(map[string]any); ok {
		return Object(result)
	}
	if result, ok := value.(Object); ok {
		return result
	}
	return Object{}
}

func arrayAt(value Object, key string) []any {
	result, _ := value[key].([]any)
	return result
}

func firstObjectAt(value Object, key string) Object {
	item := object(value[key])
	for name, candidate := range item {
		if values, ok := candidate.([]any); ok && len(values) > 0 {
			item[name] = values[0]
		}
	}
	return item
}

func stringAt(value Object, key string) (string, bool) {
	result, ok := value[key].(string)
	return result, ok && result != ""
}

func stringValue(value any) string {
	result, _ := value.(string)
	return result
}

func numberValue(value any) (float64, bool) {
	switch number := value.(type) {
	case json.Number:
		parsed, err := number.Float64()
		return parsed, err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0)
	case float64:
		return number, !math.IsNaN(number) && !math.IsInf(number, 0)
	case float32:
		return float64(number), !math.IsNaN(float64(number)) && !math.IsInf(float64(number), 0)
	case int:
		return float64(number), true
	case int64:
		return float64(number), true
	default:
		return 0, false
	}
}

func numberAt(value Object, key string) (float64, bool) {
	result, ok := numberValue(value[key])
	return result, ok
}

func integerAt(value Object, key string) (int, bool) {
	number, ok := numberAt(value, key)
	if !ok || math.Trunc(number) != number || number < -1<<31 || number > 1<<31-1 {
		return 0, false
	}
	return int(number), true
}

func stringArrayAt(value Object, key string) []string {
	raw := arrayAt(value, key)
	result := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func numberArrayAt(value Object, key string, index int) (float64, bool) {
	items := arrayAt(value, key)
	if index < 0 || index >= len(items) {
		return 0, false
	}
	return numberValue(items[index])
}

func integerArrayAt(value Object, key string, index int) (int, bool) {
	number, ok := numberArrayAt(value, key, index)
	if !ok || math.Trunc(number) != number || number < -1<<31 || number > 1<<31-1 {
		return 0, false
	}
	return int(number), true
}
