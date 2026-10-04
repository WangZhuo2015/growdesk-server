import { Type, type Static } from "@sinclair/typebox";
import { DateTimeString, Nullable, SuccessEnvelope } from "./common.js";

const EuropeanAqiCategorySchema = Type.Union([
  Type.Literal("good"),
  Type.Literal("fair"),
  Type.Literal("moderate"),
  Type.Literal("poor"),
  Type.Literal("very_poor"),
  Type.Literal("extremely_poor"),
]);

export const WeatherQuerySchema = Type.Object(
  {
    lat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
    lon: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
    city: Type.Optional(Type.String({ minLength: 2, maxLength: 100 })),
  },
  {
    $id: "WeatherQuery",
    additionalProperties: false,
    description: "Use city or a complete latitude/longitude pair. Omitting all fields selects the legacy default city Suzhou.",
  }
);

export type WeatherQuery = Static<typeof WeatherQuerySchema>;

export const WeatherHourlyForecastSchema = Type.Object(
  {
    /** Legacy display field in the location's local timezone. */
    time: Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" }),
    /** RFC3339 local time with numeric offset, disambiguated by `timezone`. */
    dateTime: Type.String({ format: "date-time" }),
    temperature: Nullable(Type.Number({ minimum: -100, maximum: 100 })),
    weatherCode: Nullable(Type.Integer({ minimum: 0, maximum: 999 })),
    condition: Type.String(),
    conditionIcon: Type.String(),
    precipitationProbability: Nullable(Type.Number({ minimum: 0, maximum: 100 })),
    uv: Nullable(Type.Number({ minimum: 0, maximum: 30 })),
  },
  { $id: "WeatherHourlyForecast", additionalProperties: false }
);

export type WeatherHourlyForecast = Static<typeof WeatherHourlyForecastSchema>;

export const WeatherResponseSchema = Type.Object(
  {
    // Legacy Web-compatible field names; unavailable values stay null, never zero.
    city: Type.String({ minLength: 1, maxLength: 200 }),
    temperature: Nullable(Type.Number({ minimum: -100, maximum: 100 })),
    condition: Type.String(),
    conditionIcon: Type.String(),
    weatherCode: Nullable(Type.Integer({ minimum: 0, maximum: 999 })),
    observedAt: Nullable(Type.String({ format: "date-time" })),
    /** Legacy field: forecast daily maximum, not the current UV reading. */
    uv: Nullable(Type.Number({ minimum: 0, maximum: 30 })),
    uvCurrent: Nullable(Type.Number({ minimum: 0, maximum: 30 })),
    /** Legacy field: daily maximum precipitation probability. */
    rainProbability: Nullable(Type.Number({ minimum: 0, maximum: 100 })),
    currentPrecipitationProbability: Nullable(Type.Number({ minimum: 0, maximum: 100 })),
    humidity: Nullable(Type.Number({ minimum: 0, maximum: 100 })),
    precipitation: Nullable(Type.Number({ minimum: 0 })),
    windSpeed: Nullable(Type.Number({ minimum: 0 })),
    airQuality: Nullable(Type.String({ maxLength: 80 })),
    airQualityIndex: Nullable(Type.Number({ minimum: 0, maximum: 1000 })),
    airQualityScale: Type.Literal("european_aqi"),
    airQualityCategory: Nullable(EuropeanAqiCategorySchema),
    outdoorAdvice: Type.String({ minLength: 1, maxLength: 200 }),
    hourlyForecast: Type.Array(WeatherHourlyForecastSchema, { maxItems: 8 }),
    timezone: Type.String({ minLength: 1, maxLength: 100 }),
    units: Type.Object(
      {
        temperature: Type.Literal("°C"),
        uv: Type.Literal("index"),
        rainProbability: Type.Literal("%"),
        humidity: Type.Literal("%"),
        precipitation: Type.Literal("mm"),
        windSpeed: Type.Literal("km/h"),
        airQuality: Type.Literal("European AQI points"),
      },
      { additionalProperties: false }
    ),
    sources: Type.Object(
      {
        location: Type.String({ minLength: 1, maxLength: 120 }),
        weather: Type.String({ minLength: 1, maxLength: 120 }),
        airQuality: Type.String({ minLength: 1, maxLength: 160 }),
        outdoorAdvice: Type.Literal("growdesk_weather_rules_v1"),
        attribution: Type.String({ minLength: 1, maxLength: 400 }),
      },
      { additionalProperties: false }
    ),
    fetchedAt: DateTimeString,
    isStale: Type.Boolean(),
    cacheState: Type.Union([
      Type.Literal("miss"),
      Type.Literal("hit"),
      Type.Literal("stale"),
      Type.Literal("unavailable"),
    ]),
    staleAgeSeconds: Nullable(Type.Integer({ minimum: 0 })),
    cacheMaxAgeSeconds: Type.Integer({ minimum: 1, maximum: 3600 }),
  },
  { $id: "WeatherResponse", additionalProperties: false }
);

export type WeatherResponse = Static<typeof WeatherResponseSchema>;

export const WeatherResponseEnvelopeSchema = SuccessEnvelope(WeatherResponseSchema, {
  $id: "WeatherResponseEnvelope",
});

export type WeatherResponseEnvelope = Static<typeof WeatherResponseEnvelopeSchema>;
