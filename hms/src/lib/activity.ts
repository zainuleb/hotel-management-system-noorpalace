import type { Request } from 'express';
import { all, run } from '../db/index.js';
import { nowTs } from './dates.js';

/**
 * Audit trail. The proposal asks for "who created/edited/cancelled a booking or
 * bill", so every state change calls this. Reads are not logged — that would
 * bury the entries that matter.
 */
export function logActivity(
  req: Request | null,
  action: string,
  entity: string,
  entityId: string | number,
  detail = '',
): void {
  run(
    `INSERT INTO activity_log (user_id, username, action, entity, entity_id, detail, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    req?.user?.id ?? null,
    req?.user?.username ?? 'system',
    action,
    entity,
    String(entityId),
    detail,
    nowTs(),
  );
}

export interface ActivityRow {
  id: number;
  username: string;
  action: string;
  entity: string;
  entity_id: string;
  detail: string;
  created_at: string;
}

export function recentActivity(limit = 100, entity?: string, entityId?: string | number): ActivityRow[] {
  if (entity && entityId !== undefined) {
    return all<ActivityRow>(
      `SELECT id, username, action, entity, entity_id, detail, created_at
         FROM activity_log WHERE entity = ? AND entity_id = ?
        ORDER BY id DESC LIMIT ?`,
      entity,
      String(entityId),
      limit,
    );
  }
  return all<ActivityRow>(
    `SELECT id, username, action, entity, entity_id, detail, created_at
       FROM activity_log ORDER BY id DESC LIMIT ?`,
    limit,
  );
}
