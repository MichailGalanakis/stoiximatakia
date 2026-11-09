import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export type AdminRole = 'viewer' | 'finance' | 'admin';
export interface AdminActor {
  name: string;
  role: AdminRole;
}

const RANK: Record<AdminRole, number> = { viewer: 0, finance: 1, admin: 2 };
export const hasRole = (actor: AdminActor, required: AdminRole) =>
  RANK[actor.role] >= RANK[required];
export const adminTokenHash = (token: string) =>
  createHash('sha256').update(`admin-token-v1\0${token}`).digest('hex');

/** Written inside the action's own transaction, so no action commits unaudited. */
export async function audit(
  c: PoolClient,
  actor: AdminActor,
  action: string,
  target: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await c.query(
    'INSERT INTO admin_audit_log(id,actor,role,action,target,details) VALUES($1,$2,$3,$4,$5,$6)',
    [
      randomUUID(),
      actor.name,
      actor.role,
      action,
      target,
      JSON.stringify(details),
    ],
  );
}
