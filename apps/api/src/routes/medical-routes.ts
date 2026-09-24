import { readRecordVersion } from "./record-version.js";
import { Type } from "@sinclair/typebox";
import { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { MedicalService } from "../services/medical-service.js";
import { VaccineService } from "../services/vaccine-service.js";
import {
  CreateMedicalReportRequest,
  UpdateMedicalReportRequest,
  CreateVaccineRecordRequest,
  CreateMedicalReportRequestSchema,
  UpdateMedicalReportRequestSchema,
  CreateVaccineRecordRequestSchema,
  MedicalReportResponseSchema,
  MedicalReportListResponseSchema,
  VaccineScheduleResponseSchema,
  VaccineRecordResponseSchema,
  VaccineListResponseSchema,
  VaccineCatalogResponseSchema,
  VaccineSelectionListResponseSchema,
  UpsertVaccineSelectionRequestSchema,
  VaccineSelectionSchema,
  type UpsertVaccineSelectionRequest,
  DeleteRecordResponseSchema,
  ApiErrorEnvelopeSchema,
} from "@growdesk/contracts";

export interface MedicalRoutesOptions {
  medicalService: MedicalService;
  vaccineService: VaccineService;
}

export const medicalRoutes: FastifyPluginAsync<MedicalRoutesOptions> = async (
  fastify: FastifyInstance,
  opts: MedicalRoutesOptions
) => {
  const { medicalService, vaccineService } = opts;

  // 1. Vaccine Schedule (Public/Authenticated)
  const getSchedule = async (_request: FastifyRequest, reply: FastifyReply) => {
    const items = await vaccineService.getVaccineSchedule();
    return reply.status(200).send({ data: items });
  };

  fastify.get(
    "/api/v1/vaccines/schedule",
    {
      schema: {
        response: {
          200: VaccineScheduleResponseSchema,
        },
      },
    },
    getSchedule
  );

  fastify.get(
    "/api/v1/babies/:babyId/vaccines/schedule",
    {
      schema: {
        response: {
          200: VaccineScheduleResponseSchema,
        },
      },
    },
    getSchedule
  );

  fastify.get(
    "/api/v1/vaccines/catalog",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: VaccineCatalogResponseSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (_request, reply) => reply.status(200).send(await vaccineService.getVaccineCatalog()),
  );

  // 2. Baby Medical Reports
  const listReports = async (
    request: FastifyRequest<{
      Params: { babyId: string };
      Querystring: { limit?: number; cursor?: string };
    }>,
    reply: FastifyReply
  ) => {
    const principal = request.principal!;
    const result = await medicalService.listMedicalReports(
      principal,
      request.params.babyId,
      request.query
    );
    return reply.status(200).send(result);
  };

  fastify.get<{
    Params: { babyId: string };
    Querystring: { limit?: number; cursor?: string };
  }>(
    "/api/v1/babies/:babyId/medical/reports",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: MedicalReportListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    listReports
  );

  fastify.get<{
    Params: { babyId: string };
    Querystring: { limit?: number; cursor?: string };
  }>(
    "/api/v1/babies/:babyId/medical-reports",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: MedicalReportListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    listReports
  );

  const createReport = async (
    request: FastifyRequest<{
      Params: { babyId: string };
      Body: CreateMedicalReportRequest;
      Headers: { "idempotency-key"?: string };
    }>,
    reply: FastifyReply
  ) => {
    const principal = request.principal!;
    const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
    const report = await medicalService.createMedicalReport(
      principal,
      request.params.babyId,
      request.body,
      idempotencyKey
    );
    return reply.status(201).send({ data: report });
  };

  fastify.post<{
    Params: { babyId: string };
    Body: CreateMedicalReportRequest;
    Headers: { "idempotency-key"?: string };
  }>(
    "/api/v1/babies/:babyId/medical/reports",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: CreateMedicalReportRequestSchema,
        response: {
          201: MedicalReportResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    createReport
  );

  fastify.post<{
    Params: { babyId: string };
    Body: CreateMedicalReportRequest;
    Headers: { "idempotency-key"?: string };
  }>(
    "/api/v1/babies/:babyId/medical-reports",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: CreateMedicalReportRequestSchema,
        response: {
          201: MedicalReportResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    createReport
  );

  const getReport = async (
    request: FastifyRequest<{
      Params: { babyId: string; reportId?: string; id?: string };
    }>,
    reply: FastifyReply
  ) => {
    const principal = request.principal!;
    const reportId = request.params.reportId || request.params.id!;
    const report = await medicalService.getMedicalReport(
      principal,
      request.params.babyId,
      reportId
    );
    return reply.status(200).send({ data: report });
  };

  fastify.get<{
    Params: { babyId: string; reportId: string };
  }>(
    "/api/v1/babies/:babyId/medical/reports/:reportId",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: MedicalReportResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    getReport
  );

  fastify.get<{
    Params: { babyId: string; id: string };
  }>(
    "/api/v1/babies/:babyId/medical-reports/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: MedicalReportResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    getReport
  );

  const updateReport = async (
    request: FastifyRequest<{
      Params: { babyId: string; reportId?: string; id?: string };
      Body: UpdateMedicalReportRequest;
    }>,
    reply: FastifyReply
  ) => {
    const principal = request.principal!;
    const reportId = request.params.reportId || request.params.id!;
    const report = await medicalService.updateMedicalReport(
      principal,
      request.params.babyId,
      reportId,
      request.body
    );
    return reply.status(200).send({ data: report });
  };

  const createUpdateOptions = () => ({
    preHandler: [fastify.authenticate],
    schema: {
      body: UpdateMedicalReportRequestSchema,
      response: {
        200: MedicalReportResponseSchema,
        400: ApiErrorEnvelopeSchema,
        401: ApiErrorEnvelopeSchema,
        403: ApiErrorEnvelopeSchema,
        404: ApiErrorEnvelopeSchema,
        409: ApiErrorEnvelopeSchema,
      },
    },
  });

  fastify.put<{ Params: { babyId: string; reportId: string }; Body: UpdateMedicalReportRequest }>(
    "/api/v1/babies/:babyId/medical/reports/:reportId",
    createUpdateOptions(),
    updateReport
  );
  fastify.patch<{ Params: { babyId: string; reportId: string }; Body: UpdateMedicalReportRequest }>(
    "/api/v1/babies/:babyId/medical/reports/:reportId",
    createUpdateOptions(),
    updateReport
  );
  fastify.put<{ Params: { babyId: string; id: string }; Body: UpdateMedicalReportRequest }>(
    "/api/v1/babies/:babyId/medical-reports/:id",
    createUpdateOptions(),
    updateReport
  );
  fastify.patch<{ Params: { babyId: string; id: string }; Body: UpdateMedicalReportRequest }>(
    "/api/v1/babies/:babyId/medical-reports/:id",
    createUpdateOptions(),
    updateReport
  );

  const deleteReport = async (
    request: FastifyRequest<{
      Params: { babyId: string; reportId?: string; id?: string };
    }>,
    reply: FastifyReply
  ) => {
    const principal = request.principal!;
    const reportId = request.params.reportId || request.params.id!;
    const result = await medicalService.deleteMedicalReport(
      principal,
      request.params.babyId,
      reportId,
      readRecordVersion((request.body as { baseVersion?: unknown } | undefined)?.baseVersion ?? (request.query as { baseVersion?: unknown }).baseVersion)
    );
    return reply.status(200).send(result);
  };

  const createDeleteReportOptions = () => ({
    preHandler: [fastify.authenticate],
    schema: {
      response: {
        200: DeleteRecordResponseSchema,
        401: ApiErrorEnvelopeSchema,
        403: ApiErrorEnvelopeSchema,
        404: ApiErrorEnvelopeSchema,
      },
    },
  });

  fastify.delete<{ Params: { babyId: string; reportId: string } }>(
    "/api/v1/babies/:babyId/medical/reports/:reportId",
    createDeleteReportOptions(),
    deleteReport
  );
  fastify.delete<{ Params: { babyId: string; id: string } }>(
    "/api/v1/babies/:babyId/medical-reports/:id",
    createDeleteReportOptions(),
    deleteReport
  );

  // 3. Baby Vaccine Records
  fastify.get<{
    Params: { babyId: string };
  }>(
    "/api/v1/babies/:babyId/vaccines/records",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: VaccineListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const records = await vaccineService.listVaccineRecords(
        principal,
        request.params.babyId
      );
      return reply.status(200).send({ data: records });
    }
  );

  fastify.post<{
    Params: { babyId: string };
    Body: CreateVaccineRecordRequest;
    Headers: { "idempotency-key"?: string };
  }>(
    "/api/v1/babies/:babyId/vaccines/records",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: CreateVaccineRecordRequestSchema,
        response: {
          201: VaccineRecordResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const record = await vaccineService.createVaccineRecord(
        principal,
        request.params.babyId,
        request.body,
        idempotencyKey
      );
      return reply.status(201).send({ data: record });
    }
  );

  const deleteVaccine = async (
    request: FastifyRequest<{
      Params: { babyId: string; recordId?: string; id?: string };
    }>,
    reply: FastifyReply
  ) => {
    const principal = request.principal!;
    const recordId = request.params.recordId || request.params.id!;
    const result = await vaccineService.deleteVaccineRecord(
      principal,
      request.params.babyId,
      recordId
    );
    return reply.status(200).send(result);
  };

  const createDeleteVaccineOptions = () => ({
    preHandler: [fastify.authenticate],
    schema: {
      response: {
        200: DeleteRecordResponseSchema,
        401: ApiErrorEnvelopeSchema,
        403: ApiErrorEnvelopeSchema,
        404: ApiErrorEnvelopeSchema,
      },
    },
  });

  fastify.delete<{ Params: { babyId: string; recordId: string } }>(
    "/api/v1/babies/:babyId/vaccines/records/:recordId",
    createDeleteVaccineOptions(),
    deleteVaccine
  );

  fastify.get<{ Params: { babyId: string } }>(
    "/api/v1/babies/:babyId/vaccines/selections",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: VaccineSelectionListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => reply.status(200).send({ data: await vaccineService.listVaccineSelections(request.principal!, request.params.babyId) }),
  );

  fastify.put<{ Params: { babyId: string }; Body: UpsertVaccineSelectionRequest }>(
    "/api/v1/babies/:babyId/vaccines/selections",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: UpsertVaccineSelectionRequestSchema,
        response: {
          200: Type.Object({ data: VaccineSelectionSchema }),
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => reply.status(200).send({ data: await vaccineService.upsertVaccineSelection(request.principal!, request.params.babyId, request.body) }),
  );
};
