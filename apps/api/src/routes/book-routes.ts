import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import type { PrismaClient } from "@growdesk/database";
import { BookListResponseSchema, UpdateBookStatusRequestSchema, UpdateBookStatusResponseSchema, type UpdateBookStatusRequest } from "@growdesk/contracts";
import { ApiError } from "../services/family-baby-service.js";
import { books } from "../knowledge/books-data.js";

export const bookRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (app, { prisma }) => {
  app.get<{ Querystring: { familyId: string } }>("/api/v1/books", { preHandler: [app.authenticate], schema: {
    querystring: Type.Object({ familyId: Type.String({ minLength: 1 }) }, { additionalProperties: false }), response: { 200: BookListResponseSchema },
  } }, async request => {
    const { familyId } = request.query;
    if (!request.principal!.familyMemberships.some(m => m.familyId === familyId && m.status === "active")) throw new ApiError(403, "FAMILY_ACCESS_DENIED", "Family access denied");
    const statuses = await prisma.familyBookStatus.findMany({ where: { familyId } });
    return { data: books.map(book => {
      const state = statuses.find(s => s.bookId === book.id);
      return { id: book.id, title: book.title, category: String((book.categories as string[])[0] ?? ""), status: state?.status ?? "unread", version: String(state?.version ?? 0), details: { ...book, isFavorite: state?.isFavorite ?? false, readCount: state?.readCount ?? 0, version: String(state?.version ?? 0) } };
    }) };
  });
  app.patch<{ Params: { id: string }; Body: UpdateBookStatusRequest }>("/api/v1/books/:id", { preHandler: [app.authenticate], schema: { body: UpdateBookStatusRequestSchema, response: { 200: UpdateBookStatusResponseSchema } } }, async request => {
    const { familyId, baseVersion, ...patch } = request.body;
    const bookId = request.params.id;
    if (!books.some(b => b.id === bookId)) throw new ApiError(404, "BOOK_NOT_FOUND", "Book not found");
    if (patch.status === undefined && patch.isFavorite === undefined && patch.readCount === undefined) throw new ApiError(400, "EMPTY_UPDATE", "No reading status supplied");
    const state = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT family_id FROM public.family_sync_states WHERE family_id = ${familyId} FOR UPDATE`;
      const member = await tx.familyMember.findUnique({ where: { uq_family_members_family_user: { familyId, userId: request.principal!.userId } } });
      if (!member || member.deletedAt || member.status !== "active" || member.role === "viewer") throw new ApiError(403, "FAMILY_ACCESS_DENIED", "Family write access denied");
      const where = { uq_family_book_status: { familyId, bookId } };
      const previous = await tx.familyBookStatus.findUnique({ where });
      if (baseVersion !== undefined && Number(baseVersion) !== (previous?.version ?? 0)) throw new ApiError(409, "VERSION_CONFLICT", "Reading status changed; reload before saving");
      const status = patch.status ?? (patch.readCount !== undefined ? (patch.readCount > 0 ? "finished" : "unread") : previous?.status ?? "unread");
      const updated = await tx.familyBookStatus.upsert({ where,
        create: { id: randomUUID(), familyId, bookId, ...patch, status },
        update: { ...patch, status, version: { increment: 1 } },
      });
      const sync = await tx.familySyncState.update({ where: { familyId }, data: { cursor: { increment: 1 } } });
      await tx.familyChange.create({ data: { familyId, cursor: sync.cursor, entityType: "book_status", entityId: updated.id, version: updated.version, op: "upsert", payload: { bookId, status: updated.status, readCount: updated.readCount, isFavorite: updated.isFavorite } } });
      return updated;
    });
    const book = books.find(b => b.id === bookId)!;
    return { data: { success: true, book: { id: bookId, title: book.title, category: String((book.categories as string[])[0] ?? ""), status: state.status, version: String(state.version), details: { ...book, isFavorite: state.isFavorite, readCount: state.readCount, status: state.status, version: String(state.version) } } } };
  });
};
