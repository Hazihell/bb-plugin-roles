// roles/seed.ts — the seed cast committed in roles/cast.json. Loaded once by
// store.seedOnce() and never
// re-applied afterwards, so editing this file only affects new databases.
import cast from "./cast.json" with { type: "json" };
import { roleSchema, type Role } from "./schema";

export const seedRoles: Role[] = cast.roles.map((role) => roleSchema.parse(role));
