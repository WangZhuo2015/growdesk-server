import { weatherRoutes } from "./routes/weather-routes.js";
import { bookRoutes } from "./routes/book-routes.js";
import { knowledgeRoutes } from "./routes/knowledge-routes.js";
import Fastify from "fastify";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import {
  ApiErrorEnvelopeSchema,
  HealthLiveResponseSchema,
  HealthReadyResponseSchema,
  UserProfileSchema,
  SessionSummarySchema,
  AuthTokenPairSchema,
  RegisterResponseSchema,
  LoginResponseSchema,
  RefreshTokenResponseSchema,
  SessionListResponseSchema,
  RevokeSessionResponseSchema,
  SuccessStatusResponseSchema,
  CurrentUserResponseSchema,
  FamilySchema,
  FamilyMemberSchema,
  BabySchema,
  BabyMemberSchema,
  FamilyResponseSchema,
  FamilyListResponseSchema,
  FamilyMemberListResponseSchema,
  PreviewFamilyInviteResponseSchema,
  JoinFamilyResponseSchema,
  CreateFamilyInviteResponseSchema,
  RemoveFamilyMemberResponseSchema,
  BabyResponseSchema,
  BabyListResponseSchema,
  BabyMemberListResponseSchema,
  RemoveBabyMemberResponseSchema,
  RegenerateRecoveryCodesResponseSchema,
  FeedingRecordSchema,
  FeedingRecordResponseSchema,
  FeedingListResponseSchema,
  FormulaProductSchema,
  FormulaProductResponseSchema,
  FormulaProductListResponseSchema,
  DiaperRecordSchema,
  DiaperRecordResponseSchema,
  DiaperListResponseSchema,
  SleepRecordSchema,
  SleepRecordResponseSchema,
  SleepListResponseSchema,
  FoodRecordSchema,
  FoodRecordResponseSchema,
  FoodListResponseSchema,
  FoodLibraryItemSchema,
  FoodLibraryItemListResponseSchema,
  FoodGuidelinesResponseSchema,
  FoodPlanSchema,
  FoodPlanResponseSchema,
  SupplementRecordSchema,
  SupplementRecordResponseSchema,
  SupplementListResponseSchema,
  GrowthMeasurementSchema,
  GrowthMeasurementResponseSchema,
  GrowthMeasurementListResponseSchema,
  GrowthChartResponseSchema,
  TimelineEntrySchema,
  TimelineResponseSchema,
  DeleteRecordResponseSchema,
  AttachmentSchema,
  AttachmentResponseSchema,
  CreateAttachmentRequestSchema,
  CompleteAttachmentRequestSchema,
  UploadUrlResponseSchema,
  MedicalReportSchema,
  MedicalReportResponseSchema,
  MedicalReportListResponseSchema,
  CreateMedicalReportRequestSchema,
  UpdateMedicalReportRequestSchema,
  VaccineScheduleItemSchema,
  VaccineScheduleResponseSchema,
  VaccineRecordSchema,
  VaccineRecordResponseSchema,
  VaccineListResponseSchema,
  CreateVaccineRecordRequestSchema,
  RegisterPushDeviceRequestSchema,
  NotificationItemSchema,
  NotificationListResponseSchema,
  AiSessionSchema,
  AiSessionResponseSchema,
  AiSessionListResponseSchema,
  AiMessageSchema,
  AiMessageListResponseSchema,
  AiRunSchema,
  AiRunResponseSchema,
  AiRunConfirmResponseSchema,
  AiRunRetryResponseSchema,
  VoiceRunResponseSchema,
  DailySummaryRunResponseSchema,
  DailySummaryItemSchema,
  DailySummaryListResponseSchema,
  SyncCommandSchema,
  SyncCommandBatchRequestSchema,
  SyncCommandResultItemSchema,
  SyncCommandBatchResponseSchema,
  SyncChangeItemSchema,
  FamilyChangesResponseSchema,
  UserChangesResponseSchema,
  CreateSyncSnapshotResponseSchema,
  SyncSnapshotSchema,
  SyncSnapshotResponseSchema,
  type HealthLiveResponse,
  type HealthReadyResponse,
} from "@growdesk/contracts";
import {
  createDatabaseContext,
  type DatabaseContext,
} from "@growdesk/database";
import crypto from "node:crypto";
import {
  createReadinessDependencies,
  type ReadinessDependencies,
} from "./readiness.js";
import { authPlugin } from "./plugins/auth-plugin.js";
import { authRoutes } from "./routes/auth-routes.js";
import { familyRoutes } from "./routes/family-routes.js";
import { babyRoutes } from "./routes/baby-routes.js";
import { feedingRoutes } from "./routes/feeding-routes.js";
import { formulaProductRoutes } from "./routes/formula-product-routes.js";
import { diaperRoutes } from "./routes/diaper-routes.js";
import { sleepRoutes } from "./routes/sleep-routes.js";
import { foodRoutes } from "./routes/food-routes.js";
import { supplementRoutes } from "./routes/supplement-routes.js";
import { growthRoutes } from "./routes/growth-routes.js";
import { timelineRoutes } from "./routes/timeline-routes.js";
import { attachmentRoutes } from "./routes/attachment-routes.js";
import { medicalRoutes } from "./routes/medical-routes.js";
import { notificationRoutes } from "./routes/notification-routes.js";
import { aiRoutes } from "./routes/ai-routes.js";
import { syncRoutes } from "./routes/sync-routes.js";
import { AttachmentService } from "./services/attachment-service.js";
import { MedicalService } from "./services/medical-service.js";
import { VaccineService } from "./services/vaccine-service.js";
import { NotificationService } from "./services/notification-service.js";
import { AiService } from "./services/ai-service.js";
import { SyncService } from "./services/sync-service.js";
import { StorageDriver, AwsS3StorageDriver, MockStorageDriver } from "./storage/s3-storage-service.js";
import type { ReplayStore } from "./auth/replay-store.js";

export interface ApiAppOptions {
  readonly logger?: boolean;
  readonly databaseUrl?: string;
  readonly redisUrl?: string;
  readonly readiness?: ReadinessDependencies;
  readonly databaseContext?: DatabaseContext;
  readonly replayStore?: ReplayStore;
  readonly jwtSecret?: string;
  readonly storageDriver?: StorageDriver;
}

/**
 * Build the HTTP application.
 * Registers health liveness/readiness, and when database context/URL is provided,
 * mounts the authentication plugin and routes.
 */
export function buildApiApp(options: ApiAppOptions = {}) {
  const readiness = options.readiness ?? createReadinessDependencies({
    DATABASE_URL: options.databaseUrl,
    REDIS_URL: options.redisUrl,
  });

  let ownsDatabaseContext = false;
  let databaseContext = options.databaseContext;
  if (!databaseContext && options.databaseUrl) {
    databaseContext = createDatabaseContext({ url: options.databaseUrl });
    ownsDatabaseContext = true;
  }

  const app = Fastify({
    logger: options.logger ?? false,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Register shared schemas
  app.addSchema(ApiErrorEnvelopeSchema);
  app.addSchema(HealthLiveResponseSchema);
  app.addSchema(HealthReadyResponseSchema);
  app.addSchema(UserProfileSchema);
  app.addSchema(SessionSummarySchema);
  app.addSchema(AuthTokenPairSchema);
  app.addSchema(RegisterResponseSchema);
  app.addSchema(LoginResponseSchema);
  app.addSchema(RefreshTokenResponseSchema);
  app.addSchema(SessionListResponseSchema);
  app.addSchema(RevokeSessionResponseSchema);
  app.addSchema(SuccessStatusResponseSchema);
  app.addSchema(CurrentUserResponseSchema);
  app.addSchema(FamilySchema);
  app.addSchema(FamilyMemberSchema);
  app.addSchema(BabySchema);
  app.addSchema(BabyMemberSchema);
  app.addSchema(FamilyResponseSchema);
  app.addSchema(FamilyListResponseSchema);
  app.addSchema(FamilyMemberListResponseSchema);
  app.addSchema(PreviewFamilyInviteResponseSchema);
  app.addSchema(JoinFamilyResponseSchema);
  app.addSchema(CreateFamilyInviteResponseSchema);
  app.addSchema(RemoveFamilyMemberResponseSchema);
  app.addSchema(BabyResponseSchema);
  app.addSchema(BabyListResponseSchema);
  app.addSchema(BabyMemberListResponseSchema);
  app.addSchema(RemoveBabyMemberResponseSchema);
  app.addSchema(RegenerateRecoveryCodesResponseSchema);
  app.addSchema(FeedingRecordSchema);
  app.addSchema(FeedingRecordResponseSchema);
  app.addSchema(FeedingListResponseSchema);
  app.addSchema(FormulaProductSchema);
  app.addSchema(FormulaProductResponseSchema);
  app.addSchema(FormulaProductListResponseSchema);
  app.addSchema(DiaperRecordSchema);
  app.addSchema(DiaperRecordResponseSchema);
  app.addSchema(DiaperListResponseSchema);
  app.addSchema(SleepRecordSchema);
  app.addSchema(SleepRecordResponseSchema);
  app.addSchema(SleepListResponseSchema);
  app.addSchema(FoodRecordSchema);
  app.addSchema(FoodRecordResponseSchema);
  app.addSchema(FoodListResponseSchema);
  app.addSchema(FoodLibraryItemSchema);
  app.addSchema(FoodLibraryItemListResponseSchema);
  app.addSchema(FoodGuidelinesResponseSchema);
  app.addSchema(FoodPlanSchema);
  app.addSchema(FoodPlanResponseSchema);
  app.addSchema(SupplementRecordSchema);
  app.addSchema(SupplementRecordResponseSchema);
  app.addSchema(SupplementListResponseSchema);
  app.addSchema(GrowthMeasurementSchema);
  app.addSchema(GrowthMeasurementResponseSchema);
  app.addSchema(GrowthMeasurementListResponseSchema);
  app.addSchema(GrowthChartResponseSchema);
  app.addSchema(TimelineEntrySchema);
  app.addSchema(TimelineResponseSchema);
  app.addSchema(DeleteRecordResponseSchema);
  app.addSchema(AttachmentSchema);
  app.addSchema(AttachmentResponseSchema);
  app.addSchema(CreateAttachmentRequestSchema);
  app.addSchema(CompleteAttachmentRequestSchema);
  app.addSchema(UploadUrlResponseSchema);
  app.addSchema(MedicalReportSchema);
  app.addSchema(MedicalReportResponseSchema);
  app.addSchema(MedicalReportListResponseSchema);
  app.addSchema(CreateMedicalReportRequestSchema);
  app.addSchema(UpdateMedicalReportRequestSchema);
  app.addSchema(VaccineScheduleItemSchema);
  app.addSchema(VaccineScheduleResponseSchema);
  app.addSchema(VaccineRecordSchema);
  app.addSchema(VaccineRecordResponseSchema);
  app.addSchema(VaccineListResponseSchema);
  app.addSchema(CreateVaccineRecordRequestSchema);
  app.addSchema(RegisterPushDeviceRequestSchema);
  app.addSchema(NotificationItemSchema);
  app.addSchema(NotificationListResponseSchema);
  app.addSchema(AiSessionSchema);
  app.addSchema(AiSessionResponseSchema);
  app.addSchema(AiSessionListResponseSchema);
  app.addSchema(AiMessageSchema);
  app.addSchema(AiMessageListResponseSchema);
  app.addSchema(AiRunSchema);
  app.addSchema(AiRunResponseSchema);
  app.addSchema(AiRunConfirmResponseSchema);
  app.addSchema(AiRunRetryResponseSchema);
  app.addSchema(VoiceRunResponseSchema);
  app.addSchema(DailySummaryRunResponseSchema);
  app.addSchema(DailySummaryItemSchema);
  app.addSchema(DailySummaryListResponseSchema);
  app.addSchema(SyncCommandSchema);
  app.addSchema(SyncCommandBatchRequestSchema);
  app.addSchema(SyncCommandResultItemSchema);
  app.addSchema(SyncCommandBatchResponseSchema);
  app.addSchema(SyncChangeItemSchema);
  app.addSchema(FamilyChangesResponseSchema);
  app.addSchema(UserChangesResponseSchema);
  app.addSchema(CreateSyncSnapshotResponseSchema);
  app.addSchema(SyncSnapshotSchema);
  app.addSchema(SyncSnapshotResponseSchema);

  // Standard API Error Envelope Handler
  app.setErrorHandler((error: unknown, request, reply) => {
    const err = error as { statusCode?: number; code?: string; message?: string };
    const statusCode = err.statusCode ?? 500;
    const code = err.code ?? (
      statusCode === 400 ? "BAD_REQUEST" :
      statusCode === 401 ? "UNAUTHORIZED" :
      statusCode === 403 ? "FORBIDDEN" :
      statusCode === 404 ? "NOT_FOUND" :
      statusCode === 409 ? "CONFLICT" :
      "INTERNAL_ERROR"
    );
    const message = err.message ?? "An unexpected error occurred";
    const requestId = (request.id as string) || crypto.randomUUID();

    reply.status(statusCode).send({
      error: {
        code,
        message,
        requestId,
      },
    });
  });

  // Health routes
  app.get(
    "/health/live",
    {
      schema: {
        operationId: "getHealthLive",
        response: {
          200: HealthLiveResponseSchema,
        },
      },
    },
    async (): Promise<HealthLiveResponse> => ({
      status: "ok",
      service: "growdesk-api",
    }),
  );

  app.get(
    "/health/ready",
    {
      schema: {
        operationId: "getHealthReady",
        response: {
          200: HealthReadyResponseSchema,
          503: HealthReadyResponseSchema,
        },
      },
    },
    async (_request, reply): Promise<HealthReadyResponse> => {
      let result = { postgres: false, redis: false };
      try {
        result = await readiness.check();
      } catch {
        // Readiness fails closed without returning driver details.
      }
      const ready = result.postgres && result.redis;
      if (!ready) reply.code(503);
      return {
        status: ready ? "ok" : "unavailable",
        service: "growdesk-api",
        stage: "foundation",
        dependencies: {
          postgres: result.postgres ? "ok" : "unavailable",
          redis: result.redis ? "ok" : "unavailable",
        },
      };
    },
  );

  // If database context is configured, register auth plugin and routes
  if (databaseContext) {
    app.register(authPlugin, {
      prisma: databaseContext.prisma,
      jwtSecret: options.jwtSecret,
    });

    app.register(authRoutes, {
      prisma: databaseContext.prisma,
      pool: databaseContext.pool,
      replayStore: options.replayStore,
      jwtSecret: options.jwtSecret,
    });

    app.register(knowledgeRoutes);
    app.register(weatherRoutes);
    app.register(bookRoutes, { prisma: databaseContext.prisma });

    app.register(familyRoutes, {
      prisma: databaseContext.prisma,
    });

    app.register(babyRoutes, {
      prisma: databaseContext.prisma,
    });

    app.register(feedingRoutes, {
      prisma: databaseContext.prisma,
    });

    app.register(formulaProductRoutes, {
      prisma: databaseContext.prisma,
    });

    app.register(diaperRoutes, {
      prisma: databaseContext.prisma,
    });

    app.register(sleepRoutes, {
      prisma: databaseContext.prisma,
    });

    app.register(foodRoutes, {
      prisma: databaseContext.prisma,
    });

    app.register(supplementRoutes, {
      prisma: databaseContext.prisma,
    });

    app.register(growthRoutes, {
      prisma: databaseContext.prisma,
    });

    app.register(timelineRoutes, {
      prisma: databaseContext.prisma,
    });

    const storageDriver = options.storageDriver ?? (
      process.env.S3_BUCKET
        ? new AwsS3StorageDriver({
            bucket: process.env.S3_BUCKET,
            endpoint: process.env.S3_ENDPOINT,
            region: process.env.S3_REGION,
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          })
        : new MockStorageDriver()
    );

    const attachmentService = new AttachmentService(databaseContext.prisma, storageDriver);
    const medicalService = new MedicalService(databaseContext.prisma);
    const vaccineService = new VaccineService(databaseContext.prisma);
    const notificationService = new NotificationService(databaseContext.prisma);
    const aiService = new AiService(databaseContext.prisma, databaseContext.pool);
    const syncService = new SyncService(databaseContext.prisma);

    app.register(attachmentRoutes, {
      attachmentService,
    });

    app.register(medicalRoutes, {
      medicalService,
      vaccineService,
    });

    app.register(notificationRoutes, {
      notificationService,
    });

    app.register(aiRoutes, {
      aiService,
    });

    app.register(syncRoutes, {
      syncService,
    });
  }

  app.addHook("onClose", async () => {
    await readiness.close();
    if (ownsDatabaseContext && databaseContext) {
      await databaseContext.close();
    }
  });

  return app;
}
