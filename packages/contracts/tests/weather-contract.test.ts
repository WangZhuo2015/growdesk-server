import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  WeatherQuerySchema,
  WeatherResponseEnvelopeSchema,
} from "../src/weather.js";

const response = {
  data: {
    city: "苏州",
    temperature: 22.5,
    condition: "局部多云",
    conditionIcon: "⛅",
    weatherCode: 2,
    observedAt: "2026-10-03T17:00:00+08:00",
    uv: null,
    uvCurrent: null,
    rainProbability: 30,
    currentPrecipitationProbability: null,
    humidity: 68,
    precipitation: 0,
    windSpeed: 8,
    airQuality: null,
    airQualityIndex: null,
    airQualityScale: "european_aqi",
    airQualityCategory: null,
    outdoorAdvice: "天气信息不完整，建议查看最新预报后再安排户外活动。",
    hourlyForecast: [
      {
        time: "23:00",
        dateTime: "2026-10-03T23:00:00+08:00",
        temperature: 20,
        weatherCode: 2,
        condition: "局部多云",
        conditionIcon: "⛅",
        precipitationProbability: null,
        uv: null,
      },
    ],
    timezone: "Asia/Shanghai",
    units: {
      temperature: "°C",
      uv: "index",
      rainProbability: "%",
      humidity: "%",
      precipitation: "mm",
      windSpeed: "km/h",
      airQuality: "European AQI points",
    },
    sources: {
      location: "legacy_default_suzhou",
      weather: "open_meteo_forecast",
      airQuality: "unavailable",
      outdoorAdvice: "growdesk_weather_rules_v1",
      attribution: "Weather data © Open-Meteo.com; air quality © CAMS via Open-Meteo; geocoding © GeoNames via Open-Meteo.",
    },
    fetchedAt: "2026-10-03T09:00:00.000Z",
    isStale: false,
    cacheState: "miss",
    staleAgeSeconds: null,
    cacheMaxAgeSeconds: 600,
  },
};

test("weather query supports explicit city, coordinates, and omitted default", () => {
  assert.equal(Value.Check(WeatherQuerySchema, {}), true);
  assert.equal(Value.Check(WeatherQuerySchema, { city: "上海" }), true);
  assert.equal(Value.Check(WeatherQuerySchema, { lat: 31.3, lon: 120.62 }), true);
  assert.equal(Value.Check(WeatherQuerySchema, { lat: 91, lon: 120 }), false);
  assert.equal(Value.Check(WeatherQuerySchema, { lat: 31 }), true); // Pair validation is an operation semantic checked before dispatch.
  assert.equal(Value.Check(WeatherQuerySchema, { city: "a" }), false);
});

test("weather response preserves unavailable values as null and labels AQI scale", () => {
  assert.equal(Value.Check(WeatherResponseEnvelopeSchema, response), true);
  assert.equal(Value.Check(WeatherResponseEnvelopeSchema, {
    ...response,
    data: { ...response.data, airQualityScale: "china_aqi" },
  }), false);
  assert.equal(Value.Check(WeatherResponseEnvelopeSchema, {
    ...response,
    data: { ...response.data, uvCurrent: 0, airQualityIndex: 0, airQualityCategory: "good", airQuality: "良好" },
  }), true);
});
