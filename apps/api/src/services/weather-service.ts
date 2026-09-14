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

function getAirQualityLevel(aqi: number): string {
  if (aqi <= 50) return "优";
  if (aqi <= 100) return "良";
  if (aqi <= 150) return "轻度污染";
  if (aqi <= 200) return "中度污染";
  return "重度污染";
}

export async function weatherResponse(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const latParam = parseFloat(searchParams.get("lat") ?? "");
    const lonParam = parseFloat(searchParams.get("lon") ?? "");
    const cityParam = searchParams.get("city");

    const lat = Number.isFinite(latParam) ? latParam : DEFAULT_LAT;
    const lon = Number.isFinite(lonParam) ? lonParam : DEFAULT_LON;
    const city = cityParam || (lat === DEFAULT_LAT && lon === DEFAULT_LON ? DEFAULT_CITY : "当前位置");

    // Fetch weather from Open-Meteo
    const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code&hourly=temperature_2m,weather_code&daily=uv_index_max,precipitation_probability_max&timezone=Asia%2FShanghai&forecast_days=1`;
    const airUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=european_aqi&timezone=Asia%2FShanghai`;

    const [weatherRes, airRes] = await Promise.all([
      fetch(weatherUrl, { signal: AbortSignal.timeout(10000) }), // cache 10 min
      fetch(airUrl, { signal: AbortSignal.timeout(10000) }),
    ]);

    if (!weatherRes.ok) {
      throw new Error(`Open-Meteo weather responded with ${weatherRes.status}`);
    }

    const weatherData = await weatherRes.json();
    const airData = airRes.ok ? await airRes.json() : {};
    if (!weatherData.current || !weatherData.daily || !weatherData.hourly) {
      throw new Error("Open-Meteo response is missing current/daily/hourly data");
    }

    const current = weatherData.current;
    const daily = weatherData.daily;
    const hourly = weatherData.hourly;
    const airQuality = airData.current?.european_aqi ?? 0;

    const weatherInfo = WMO_CODE_MAP[current.weather_code] ?? { condition: "多云", icon: "⛅" };
    const uv = Math.round(daily.uv_index_max?.[0] ?? 0);
    const rainProb = daily.precipitation_probability_max?.[0] ?? 0;

    // Build hourly forecast for next 8 hours (Asia/Shanghai local hour)
    const hourPart = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date()).find((p) => p.type === "hour")?.value;
    let currentHour = hourPart ? parseInt(hourPart, 10) : 0;
    if (currentHour === 24) currentHour = 0;

    const hourlyForecast = [];
    for (let i = 0; i < 8; i++) {
      const idx = currentHour + i;
      if (idx < hourly.time?.length) {
        const hourCode = hourly.weather_code[idx];
        const hourInfo = WMO_CODE_MAP[hourCode] ?? { condition: "多云", icon: "⛅" };
        hourlyForecast.push({
          time: `${String(idx % 24).padStart(2, "0")}:00`,
          temperature: Math.round(hourly.temperature_2m[idx]),
          condition: hourInfo.icon,
        });
      }
    }

    return Response.json({
      city,
      temperature: Math.round(current.temperature_2m),
      condition: weatherInfo.condition,
      uv,
      rainProbability: rainProb,
      humidity: current.relative_humidity_2m,
      airQuality: getAirQualityLevel(airQuality),
      outdoorAdvice: getOutdoorAdvice(current.weather_code, current.temperature_2m, uv, rainProb),
      hourlyForecast,
    });
  } catch (error) {
    console.error("GET /api/weather error:", error);
    return Response.json(
      { error: "获取天气数据失败" },
      { status: 500 }
    );
  }
}
