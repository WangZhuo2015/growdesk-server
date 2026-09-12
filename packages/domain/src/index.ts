export type FamilyRole = "admin" | "member" | "viewer";

export interface UserPrincipal {
  userId: string;
  username: string;
  sessionId: string;
  deviceLabel?: string;
  familyMemberships: Array<{
    familyId: string;
    role: FamilyRole;
  }>;
}

export interface SecurityPolicy {
  canWriteRecord(principal: UserPrincipal, familyId: string): boolean;
  canManageFamily(principal: UserPrincipal, familyId: string): boolean;
  canViewFamily(principal: UserPrincipal, familyId: string): boolean;
}

export const defaultSecurityPolicy: SecurityPolicy = {
  canWriteRecord(principal, familyId) {
    const mem = principal.familyMemberships.find((m) => m.familyId === familyId);
    return mem ? mem.role === "admin" || mem.role === "member" : false;
  },
  canManageFamily(principal, familyId) {
    const mem = principal.familyMemberships.find((m) => m.familyId === familyId);
    return mem ? mem.role === "admin" : false;
  },
  canViewFamily(principal, familyId) {
    return principal.familyMemberships.some((m) => m.familyId === familyId);
  },
};
