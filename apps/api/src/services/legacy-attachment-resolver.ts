import { BadRequestError, RecordNotFoundError, type PrismaClient } from "@growdesk/database";

/** A legacy URL is an identifier, never permission to read a local file. */
export function normalizedLegacyUploadPath(value: string): string {
  if (typeof value !== "string" || value.length > 1024 || !value.startsWith("/uploads/")
      || /[%\\?#]/.test(value)
      || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new BadRequestError("Invalid legacy attachment path");
  }
  const segments = value.slice("/uploads/".length).split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new BadRequestError("Invalid legacy attachment path");
  }
  return `public${value}`;
}

/** Re-read membership in the same query as the private mapping and object.
 * No caller-provided family/baby headers or cached claims authorize this read.
 * The content endpoint checks authorization again after the browser redirect.
 */
export async function resolveLegacyUpload(
  prisma: Pick<PrismaClient, "$queryRaw">,
  userId: string,
  pathname: string,
): Promise<{ id: string }> {
  const sourcePath = normalizedLegacyUploadPath(pathname);
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT a.id
    FROM public.legacy_idempotency_mappings m
    JOIN public.attachments a ON a.id = m.metadata->>'attachmentId'
    JOIN public.families f ON f.id = a.family_id AND f.deleted_at IS NULL
    JOIN public.users u ON u.id = ${userId} AND u.deleted_at IS NULL
    JOIN public.family_members fm ON fm.family_id = a.family_id AND fm.user_id = u.id
      AND fm.status = 'active' AND fm.deleted_at IS NULL
    WHERE m.target_entity_type = 'attachment_reference'
      AND m.mapping_version = 'attachment-reference-backfill-v1'
      AND m.status = 'mapped' AND m.metadata->>'storageState' = 'ready'
      AND m.metadata->>'sourcePath' = ${sourcePath}
      AND a.status = 'ready' AND a.deleted_at IS NULL
      AND (a.baby_id IS NULL OR EXISTS (
        SELECT 1 FROM public.baby_members bm
        JOIN public.babies b ON b.id = bm.baby_id AND b.family_id = bm.family_id
        WHERE bm.user_id = u.id AND bm.baby_id = a.baby_id AND bm.family_id = a.family_id
          AND bm.status = 'active' AND bm.deleted_at IS NULL AND b.deleted_at IS NULL
      ))
    ORDER BY a.id LIMIT 2
  `;
  // Ambiguous historical names are not resolved by guessing an object.
  // Neither absent, deleted nor forbidden paths reveal the owning tenant.
  if (rows.length !== 1 || !rows[0] || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(rows[0].id)) {
    throw new RecordNotFoundError("Attachment", "legacy");
  }
  return { id: rows[0].id };
}
