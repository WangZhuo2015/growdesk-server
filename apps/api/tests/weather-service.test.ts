import test from "node:test";
import assert from "node:assert/strict";
import { parseEuropeanAqi, parseForecast, weatherResponse } from "../src/services/weather-service.js";

/** Assert the decoded JSON container before accessing fields under Node 24's unknown-returning Response.json(). */
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a JSON object");
  return value as Record<string, unknown>;
}

function forecast() {
  return {
    current: { temperature_2m: 26.4, relative_humidity_2m: 55, weather_code: 0 },
    daily: { uv_index_max: [4.2, 5], precipitation_probability_max: [15, 20] },
    hourly: {
      time: ["2026-09-13T22:00", "2026-09-13T23:00", ...Array.from({ length: 8 }, (_, i) => `2026-09-14T0${i}:00`)],
      temperature_2m: Array.from({ length: 10 }, (_, i) => 20 + i),
      weather_code: Array.from({ length: 10 }, () => 0),
    },
  };
}
const now = () => new Date("2026-09-13T15:30:00Z"); // Shanghai 23:30.
function transport(weather: unknown = forecast(), air: unknown = { current: { european_aqi: 15 } }): typeof fetch {
  return async input => Response.json(String(input).includes("air-quality") ? air : weather);
}

test("validated weather preserves the old UI shape and crosses midnight", async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    urls.push(String(input));
    assert.ok(init?.signal instanceof AbortSignal);
    return transport()(input, init);
  };
  const response = await weatherResponse(new Request("https://test.invalid/api/v1/weather"), { fetchImpl, now });
  assert.equal(response.status, 200);
  const body = object(await response.json());
  assert.equal(body.city, "苏州");
  assert.equal(body.temperature, 26);
  assert.equal(body.airQuality, "优");
  const hourly = body.hourlyForecast;
  assert.ok(Array.isArray(hourly), "Expected hourly forecast array");
  assert.equal(hourly.length, 8);
  assert.equal(object(hourly[0]).time, "23:00");
  assert.equal(object(hourly[1]).time, "00:00");
  assert.equal(object(hourly[1]).temperature, 22);
  assert.ok(urls.some(url => url.includes("forecast_days=2")));
});

test("European AQI is not classified using unrelated 50-point thresholds", async () => {
  for (const [aqi, expected] of [[0, "优"], [20, "优"], [21, "尚可"], [40, "尚可"], [41, "一般"], [60, "一般"], [61, "差"], [80, "差"], [81, "很差"], [100, "很差"], [101, "极差"]] as const) {
    const response = await weatherResponse(new Request("https://test.invalid/weather"), { fetchImpl: transport(forecast(), { current: { european_aqi: aqi } }), now });
    assert.equal(object(await response.json()).airQuality, expected);
  }
});

test("invalid/missing AQI stays unavailable instead of appearing excellent", async () => {
  for (const air of [{}, null, { current: {} }, { current: { european_aqi: null } }, { current: { european_aqi: "15" } }, { current: { european_aqi: -1 } }]) {
    assert.equal(parseEuropeanAqi(air), null);
    const response = await weatherResponse(new Request("https://test.invalid/weather"), { fetchImpl: transport(forecast(), air), now });
    assert.equal(response.status, 200);
    assert.equal(object(await response.json()).airQuality, "暂无数据");
  }
  assert.equal(parseEuropeanAqi({ current: { european_aqi: Infinity } }), null);
});

test("optional AQI HTTP, JSON and network failures do not fabricate a measurement", async () => {
  for (const mode of ["http", "json", "network"] as const) {
    const fetchImpl: typeof fetch = async input => {
      if (!String(input).includes("air-quality")) return Response.json(forecast());
      if (mode === "network") throw new TypeError("test network failure");
      return mode === "http" ? new Response("unavailable", { status: 503 }) : new Response("bad JSON");
    };
    const response = await weatherResponse(new Request("https://test.invalid/weather"), { fetchImpl, now });
    assert.equal(response.status, 200);
    assert.equal(object(await response.json()).airQuality, "暂无数据");
  }
});

test("forecast rejects unknown JSON, missing values and mismatched parallel arrays", () => {
  for (const value of [null, [], {}, { current: {}, daily: {}, hourly: {} }]) assert.throws(() => parseForecast(value));
  const valid = forecast();
  for (const value of [
    { ...valid, current: { ...valid.current, temperature_2m: "26" } },
    { ...valid, current: { ...valid.current, temperature_2m: NaN } },
    { ...valid, current: { ...valid.current, relative_humidity_2m: 101 } },
    { ...valid, current: { ...valid.current, weather_code: 0.5 } },
    { ...valid, daily: { ...valid.daily, uv_index_max: [] } },
    { ...valid, daily: { ...valid.daily, uv_index_max: [null, 1] } },
    { ...valid, daily: { ...valid.daily, precipitation_probability_max: [101, 1] } },
    { ...valid, hourly: { ...valid.hourly, temperature_2m: [1] } },
    { ...valid, hourly: { ...valid.hourly, time: valid.hourly.time.map(() => "2026-02-30T23:00") } },
    { ...valid, hourly: { ...valid.hourly, time: [...valid.hourly.time].reverse() } },
  ]) assert.throws(() => parseForecast(value));
  assert.deepEqual(parseForecast(valid), valid);
});

test("forecast failures return 502, never a cacheable successful response", async () => {
  for (const mode of ["http", "json", "schema", "network", "stale"] as const) {
    const fetchImpl: typeof fetch = async input => {
      if (String(input).includes("air-quality")) return Response.json({});
      if (mode === "network") throw new TypeError("test unavailable");
      if (mode === "http") return new Response("down", { status: 503 });
      if (mode === "json") return new Response("not JSON");
      return Response.json(mode === "schema" ? {} : forecast());
    };
    const response = await weatherResponse(new Request("https://test.invalid/weather"), { fetchImpl, now: mode === "stale" ? () => new Date("2026-09-20T00:00:00Z") : now });
    assert.equal(response.status, 502);
    assert.equal(object(await response.json()).temperature, undefined);
  }
});

test("invalid coordinates are rejected before any paid or external work", async () => {
  const fetchImpl: typeof fetch = async () => { throw new Error("Unexpected external call"); };
  for (const query of ["lat=91", "lon=-181", "lat=31garbage", "lat=", "lon=Infinity", "lat=0x10"]) {
    const response = await weatherResponse(new Request(`https://test.invalid/weather?${query}`), { fetchImpl, now });
    assert.equal(response.status, 400);
  }
});

test("valid custom coordinates and unknown WMO codes remain explicit", async () => {
  const value = forecast();
  value.current.weather_code = 123;
  const fetchImpl: typeof fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("latitude"), "0");
    assert.equal(url.searchParams.get("longitude"), "-180");
    return Response.json(url.hostname.includes("air-quality") ? {} : value);
  };
  const response = await weatherResponse(new Request("https://test.invalid/weather?lat=0&lon=-180&city=test_city"), { fetchImpl, now });
  const body = object(await response.json());
  assert.equal(body.city, "test_city");
  assert.equal(body.condition, "天气未知");
  assert.equal(body.outdoorAdvice, "天气信息不足，请查看当地预报");
});
