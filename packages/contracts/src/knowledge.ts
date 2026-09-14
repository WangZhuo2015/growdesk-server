import { Type, type Static } from "@sinclair/typebox";

export const DevelopmentMilestoneSchema = Type.Object(
  {
    id: Type.String(),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    monthAge: Type.Integer({ minimum: 0 }),
    category: Type.String(),
    title: Type.String(),
    description: Type.String(),
  },
  { $id: "DevelopmentMilestone", additionalProperties: false }
);

export type DevelopmentMilestone = Static<typeof DevelopmentMilestoneSchema>;

export const MilestoneListResponseSchema = Type.Object(
  {
    data: Type.Array(DevelopmentMilestoneSchema),
    dataRelease: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { $id: "MilestoneListResponse", additionalProperties: false }
);

export type MilestoneListResponse = Static<typeof MilestoneListResponseSchema>;

export const ActivityRecommendationSchema = Type.Object(
  {
    id: Type.String(),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    monthAge: Type.Integer({ minimum: 0 }),
    title: Type.String(),
    content: Type.String(),
  },
  { $id: "ActivityRecommendation", additionalProperties: false }
);

export type ActivityRecommendation = Static<typeof ActivityRecommendationSchema>;

export const ActivityListResponseSchema = Type.Object(
  {
    data: Type.Array(ActivityRecommendationSchema),
  },
  { $id: "ActivityListResponse", additionalProperties: false }
);

export type ActivityListResponse = Static<typeof ActivityListResponseSchema>;

export const WarningSignSchema = Type.Object(
  {
    id: Type.String(),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    monthAge: Type.Integer({ minimum: 0 }),
    signText: Type.String(),
    actionAdvice: Type.String(),
  },
  { $id: "WarningSign", additionalProperties: false }
);

export type WarningSign = Static<typeof WarningSignSchema>;

export const WarningSignListResponseSchema = Type.Object(
  {
    data: Type.Array(WarningSignSchema),
  },
  { $id: "WarningSignListResponse", additionalProperties: false }
);

export type WarningSignListResponse = Static<typeof WarningSignListResponseSchema>;

export const BookStatusSchema = Type.Union([
  Type.Literal("unread"),
  Type.Literal("reading"),
  Type.Literal("finished"),
]);

export type BookStatus = Static<typeof BookStatusSchema>;

export const BookSchema = Type.Object(
  {
    id: Type.String(),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    version: Type.Optional(Type.String()),
    title: Type.String(),
    category: Type.String(),
    status: BookStatusSchema,
  },
  { $id: "Book", additionalProperties: false }
);

export type Book = Static<typeof BookSchema>;

export const BookListResponseSchema = Type.Object(
  {
    data: Type.Array(BookSchema),
  },
  { $id: "BookListResponse", additionalProperties: false }
);

export type BookListResponse = Static<typeof BookListResponseSchema>;

export const UpdateBookStatusRequestSchema = Type.Object(
  {
    status: Type.Optional(BookStatusSchema),
    isFavorite: Type.Optional(Type.Boolean()),
    readCount: Type.Optional(Type.Integer({ minimum: 0 })),
    familyId: Type.String({ minLength: 1 }),
    baseVersion: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
  },
  { $id: "UpdateBookStatusRequest", additionalProperties: false }
);

export type UpdateBookStatusRequest = Static<typeof UpdateBookStatusRequestSchema>;

export const UpdateBookStatusResponseSchema = Type.Object({
  data: Type.Object({ success: Type.Literal(true), book: Type.Optional(BookSchema) }, { additionalProperties: false }),
}, { $id: "UpdateBookStatusResponse", additionalProperties: false });
export type UpdateBookStatusResponse = Static<typeof UpdateBookStatusResponseSchema>;
