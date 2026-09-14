// Weather adapter ported from baby_panel_for_cecilia 143f4a9; no tenant database access.

// Default coordinates (Suzhou)
const DEFAULT_LAT = 31.30;
const DEFAULT_LON = 120.62;
const DEFAULT_CITY = "苏州";

const WMO_CODE_MAP: Record<number, { condition: string; icon: string }> = {
  0: { condition: "晴", icon: "☀️" },
  1: { condition: "少云", icon: "🌤️" },
  2: { condition: "多云", icon: "⛅" },
  3: { condition: "阴", icon: "☁️" },
  45: { condition: "雾", icon: "🌫️" },
  48: { condition: "雾", icon: "🌫️" },
  51: { condition: "小毛毛雨", icon: "🌦️" },
  53: { condition: "毛毛雨", icon: "🌦️" },
  55: { condition: "密毛毛雨", icon: "🌧️" },
  61: { condition: "小雨", icon: "🌧️" },
  63: { condition: "中雨", icon: "🌧️" },
  65: { condition: "大雨", icon: "🌧️" },
  71: { condition: "小雪", icon: "🌨️" },
  73: { condition: "中雪", icon: "🌨️" },
  75: { condition: "大雪", icon: "❄️" },
  77: { condition: "雪粒", icon: "❄️" },
  80: { condition: "小阵雨", icon: "🌦️" },
  81: { condition: "中阵雨", icon: "🌦️" },
  82: { condition: "大阵雨", icon: "⛈️" },
  95: { condition: "雷暴", icon: "⛈️" },
  96: { condition: "雷暴+冰雹", icon: "⛈️" },
  99: { condition: "强雷暴+冰雹", icon: "⛈️" },
};

function getOutdoorAdvice(weatherCode: number, temp: number, uv: number, rainProb: number): string {
  if (rainProb > 60) return "建议室内活动";
  if (weatherCode >= 95) return "雷暴天气，请勿外出";
  if (temp > 35) return "高温天气，注意防暑";
  if (temp < 5) return "天气寒冷，注意保暖";
  if (uv >= 8) return "紫外线强，做好防晒";
  if (rainProb > 30) return "可能降雨，带伞出行";
  if (temp >= 15 && temp <= 28 && uv <= 5) return "适合外出活动";
  return "适合户外活动";
}

/** Open-Meteo european_aqi uses 20-point European bands, not US/China AQI bands. */
function getAirQualityLevel(aqi: number | null): string {
  if (aqi === null) return "暂无数据";
  if (aqi <= 20) return "优";
  if (aqi <= 40) return "尚可";
  if (aqi <= 60) return "一般";
  if (aqi <= 80) return "差";
  if (aqi <= 100) return "很差";
  return "极差";
}

interface ForecastData {
  current: { temperature_2m: number; relative_humidity_2m: number; weather_code: number };
  daily: { uv_index_max: number[]; precipitation_probability_max: number[] };
  hourly: { time: string[]; temperature_2m: number[]; weather_code: number[] };
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function percent(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 100;
}
function weatherCode(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value >= 0;
}
function numbers(value: unknown, valid: (item: unknown) => item is number = finite): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(valid);
}
function localHour(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):00$/.test(value)) return false;
  const instant = new Date(`${value}:00Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 16) === value;
}

/** Validate external JSON before any numeric operations; no unchecked casting. */
export function parseForecast(value: unknown): ForecastData {
  if (!object(value) || !object(value.current) || !object(value.daily) || !object(value.hourly)) {
    throw new Error("Invalid forecast structure");
  }
  const { current, daily, hourly } = value;
  if (!finite(current.temperature_2m) || !percent(current.relative_humidity_2m) || !weatherCode(current.weather_code)
    || !numbers(daily.uv_index_max, (item): item is number => finite(item) && item >= 0)
    || !numbers(daily.precipitation_probability_max, percent)
    || daily.uv_index_max.length !== daily.precipitation_probability_max.length
    || !Array.isArray(hourly.time) || !hourly.time.length || !hourly.time.every(localHour)
    || !numbers(hourly.temperature_2m) || !numbers(hourly.weather_code, weatherCode)
    || hourly.time.length !== hourly.temperature_2m.length || hourly.time.length !== hourly.weather_code.length) {
    throw new Error("Invalid forecast values");
  }
  const times = hourly.time;
  if (times.some((time, index) => index > 0 && time <= times[index - 1]!)) {
    throw new Error("Forecast hours are not strictly ordered");
  }
  return {
    current: { temperature_2m: current.temperature_2m, relative_humidity_2m: current.relative_humidity_2m, weather_code: current.weather_code },
    daily: { uv_index_max: daily.uv_index_max, precipitation_probability_max: daily.precipitation_probability_max },
    hourly: { time: times, temperature_2m: hourly.temperature_2m, weather_code: hourly.weather_code },
  };
}

export function parseEuropeanAqi(value: unknown): number | null {
  if (!object(value) || !object(value.current)) return null;
  const aqi = value.current.european_aqi;
  return finite(aqi) && aqi >= 0 ? aqi : null;
}

interface WeatherDependencies {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function coordinate(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) throw new Error("Invalid coordinate");
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error("Invalid coordinate");
  return value;
}

function shanghaiHour(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:00`;
}

export async function weatherResponse(request: Request, deps: WeatherDependencies = {}): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  let lat: number;
  let lon: number;
  let city: string;
  try {
    const { searchParams } = new URL(request.url);
    lat = coordinate(searchParams.get("lat"), DEFAULT_LAT, -90, 90);
    lon = coordinate(searchParams.get("lon"), DEFAULT_LON, -180, 180);
    city = searchParams.get("city")?.trim() || (lat === DEFAULT_LAT && lon === DEFAULT_LON ? DEFAULT_CITY : "当前位置");
    if (city.length > 100) throw new Error("Invalid city");
  } catch {
    return Response.json({ error: "天气查询参数无效" }, { status: 400 });
  }

  try {
    // Two days keep the next-eight-hours display meaningful near midnight.
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code&hourly=temperature_2m,weather_code&daily=uv_index_max,precipitation_probability_max&timezone=Asia%2FShanghai&forecast_days=2`;
    const airUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=european_aqi&timezone=Asia%2FShanghai`;
    const [weatherRes, airQuality] = await Promise.all([
      fetchImpl(weatherUrl, { signal: AbortSignal.timeout(10000) }),
      // Air quality is optional, but absent data must never be reported as AQI 0.
      (async (): Promise<number | null> => {
        try {
          const response = await fetchImpl(airUrl, { signal: AbortSignal.timeout(10000) });
          return response.ok ? parseEuropeanAqi(await response.json()) : null;
        } catch { return null; }
      })(),
    ]);
    if (!weatherRes.ok) throw new Error("Forecast provider unavailable");
    const { current, daily, hourly } = parseForecast(await weatherRes.json());
    const unknownWeather = { condition: "天气未知", icon: "❔" };
    const weatherInfo = WMO_CODE_MAP[current.weather_code] ?? unknownWeather;
    const uv = Math.round(daily.uv_index_max[0]!);
    const rainProb = daily.precipitation_probability_max[0]!;
    const currentHour = shanghaiHour(now());
    const hourlyForecast = hourly.time
      .map((time, index) => ({ time, index }))
      .filter(item => item.time >= currentHour)
      .slice(0, 8)
      .map(({ time, index }) => ({
        time: time.slice(11, 16),
        temperature: Math.round(hourly.temperature_2m[index]!),
        condition: (WMO_CODE_MAP[hourly.weather_code[index]!] ?? unknownWeather).icon,
      }));
    if (!hourlyForecast.length) throw new Error("Forecast does not cover the current hour");
    return Response.json({
      city,
      temperature: Math.round(current.temperature_2m),
      condition: weatherInfo.condition,
      uv,
      rainProbability: rainProb,
      humidity: current.relative_humidity_2m,
      airQuality: getAirQualityLevel(airQuality),
      outdoorAdvice: WMO_CODE_MAP[current.weather_code]
        ? getOutdoorAdvice(current.weather_code, current.temperature_2m, uv, rainProb)
        : "天气信息不足，请查看当地预报",
      hourlyForecast,
    });
  } catch {
    // Keep malformed/failed upstream responses out of the route's success cache.
    return Response.json({ error: "获取天气数据失败" }, { status: 502 });
  }
}
