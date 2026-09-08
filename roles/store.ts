// roles/store.ts — the role cast persisted in this plugin's own SQLite
// database. Two tables: `roles` (ordered rows, one JSON blob each) and
// `roles_meta` (a single "seeded" flag so the seed cast is applied exactly
// once, ever — even across "delete everything" and reload).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { roleSchema, type Role } from "./schema";
import { seedRoles } from "./seed";

export interface RoleExport {
  version: 1;
  roles: Role[];
}

/** Validates a parsed `roles import` document before it reaches `importAll`. */
export const roleExportSchema = z.object({
  version: z.literal(1),
  roles: z.array(roleSchema),
});

export type RoleChangeListener = () => void;

export interface RoleStore {
  list(): Role[];
  get(id: string): Role | null;
  create(role: Role): Role;
  update(id: string, patch: Partial<Omit<Role, "id">>): Role;
  remove(id: string): boolean;
  exportAll(): RoleExport;
  importAll(doc: RoleExport): void;
  /** Registers a listener fired after any write; returns an unsubscribe. */
  onChange(listener: RoleChangeListener): () => void;
  /** Applies the seed cast exactly once per database, ever. Idempotent. */
  seedOnce(): void;
}

interface RoleRow {
  json: string;
}

export function createRoleStore(bb: BbPluginApi): RoleStore {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS roles (
       id TEXT PRIMARY KEY,
       position INTEGER NOT NULL,
       json TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS roles_meta (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`,
  ]);

  const listeners = new Set<RoleChangeListener>();
  function notify(): void {
    for (const listener of listeners) listener();
  }

  function rowToRole(row: RoleRow): Role {
    return roleSchema.parse(JSON.parse(row.json));
  }

  function list(): Role[] {
    const rows = db
      .prepare(`SELECT json FROM roles ORDER BY position ASC`)
      .all() as RoleRow[];
    return rows.map(rowToRole);
  }

  function get(id: string): Role | null {
    const row = db
      .prepare(`SELECT json FROM roles WHERE id = ?`)
      .get(id) as RoleRow | undefined;
    return row === undefined ? null : rowToRole(row);
  }

  function nextPosition(): number {
    const row = db
      .prepare(`SELECT COALESCE(MAX(position), -1) AS maxPosition FROM roles`)
      .get() as { maxPosition: number };
    return row.maxPosition + 1;
  }

  function create(role: Role): Role {
    const parsed = roleSchema.parse(role);
    db.prepare(`INSERT INTO roles (id, position, json) VALUES (?, ?, ?)`).run(
      parsed.id,
      nextPosition(),
      JSON.stringify(parsed),
    );
    notify();
    return parsed;
  }

  function update(id: string, patch: Partial<Omit<Role, "id">>): Role {
    const current = get(id);
    if (current === null) throw new Error(`No role with id "${id}"`);
    const next = roleSchema.parse({ ...current, ...patch, id });
    db.prepare(`UPDATE roles SET json = ? WHERE id = ?`).run(
      JSON.stringify(next),
      id,
    );
    notify();
    return next;
  }

  function remove(id: string): boolean {
    const result = db.prepare(`DELETE FROM roles WHERE id = ?`).run(id);
    if (result.changes > 0) notify();
    return result.changes > 0;
  }

  function exportAll(): RoleExport {
    return { version: 1, roles: list() };
  }

  function importAll(doc: RoleExport): void {
    const incoming = doc.roles.map((role) => roleSchema.parse(role));
    const upsert = db.transaction((roles: Role[]) => {
      for (const role of roles) {
        const existing = db
          .prepare(`SELECT position FROM roles WHERE id = ?`)
          .get(role.id) as { position: number } | undefined;
        const position = existing?.position ?? nextPosition();
        db.prepare(
          `INSERT INTO roles (id, position, json) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
        ).run(role.id, position, JSON.stringify(role));
      }
    });
    upsert(incoming);
    notify();
  }

  function onChange(listener: RoleChangeListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function isSeeded(): boolean {
    const row = db
      .prepare(`SELECT value FROM roles_meta WHERE key = 'seeded'`)
      .get() as { value: string } | undefined;
    return row !== undefined;
  }

  function seedOnce(): void {
    if (isSeeded()) return;
    const seed = db.transaction(() => {
      if (isSeeded()) return;
      seedRoles.forEach((role, index) => {
        const parsed = roleSchema.parse(role);
        db.prepare(
          `INSERT OR IGNORE INTO roles (id, position, json) VALUES (?, ?, ?)`,
        ).run(parsed.id, index, JSON.stringify(parsed));
      });
      db.prepare(
        `INSERT INTO roles_meta (key, value) VALUES ('seeded', '1')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run();
    });
    seed();
    notify();
  }

  return {
    list,
    get,
    create,
    update,
    remove,
    exportAll,
    importAll,
    onChange,
    seedOnce,
  };
}
