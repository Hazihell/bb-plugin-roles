// components/roles/RolesSettingsSection.tsx — the plugin's settingsSection
// component (registered in app.tsx). Lists the role cast, and hosts the
// create/edit form and the delete confirmation as controlled dialogs.
//
// Data flow: `listRoles` on mount, on every "roles-changed" realtime signal
// (fired by the server for a write from either this page or the CLI —
// roles/rpc.ts, server.ts), and again on each reconnect (the signal itself
// is ephemeral and isn't replayed, so a write missed while disconnected
// needs this reconciliation pass). After each list load, one batched
// `checkModels` call marks candidates whose live model is unknown; the form
// re-checks its own in-progress candidates separately (RoleFormDialog).
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginProvidersState } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { DeleteRoleDialog } from "./DeleteRoleDialog";
import { RoleFormDialog, type RoleFormTarget } from "./RoleFormDialog";
import { rpcContract } from "../../roles/rpc";
import type { Role } from "../../roles/schema";

const EMPTY_UNKNOWN = new Set<number>();

export function RolesSettingsSection({ providers }: { providers: PluginProvidersState["providers"] }) {
  const rpc = useRpc<typeof rpcContract>();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unknownByRole, setUnknownByRole] = useState<Map<string, Set<number>>>(new Map());
  const [formTarget, setFormTarget] = useState<RoleFormTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Role | null>(null);
  // Bumped on every list load; a `checkModels` response only applies if
  // it's still the latest one requested, so a stale reply that resolves
  // after a newer list load can't overwrite its markers.
  const checkGenerationRef = useRef(0);

  const checkAllModels = useCallback(
    async (list: readonly Role[]) => {
      const generation = ++checkGenerationRef.current;
      const flat = list.flatMap((role) =>
        role.candidates.map((candidate, index) => ({ roleId: role.id, index, candidate })),
      );
      if (flat.length === 0) {
        setUnknownByRole(new Map());
        return;
      }
      try {
        const results = await rpc.call("checkModels", { candidates: flat.map((entry) => entry.candidate) });
        if (checkGenerationRef.current !== generation) return;
        const next = new Map<string, Set<number>>();
        results.forEach((result, position) => {
          if (result.known) return;
          const entry = flat[position];
          if (entry === undefined) return;
          const set = next.get(entry.roleId) ?? new Set<number>();
          set.add(entry.index);
          next.set(entry.roleId, set);
        });
        setUnknownByRole(next);
      } catch {
        // Best-effort live hint; a save-time warning is still authoritative.
        if (checkGenerationRef.current === generation) setUnknownByRole(new Map());
      }
    },
    [rpc],
  );

  const refetch = useCallback(async () => {
    try {
      const list = await rpc.call("listRoles");
      setRoles(list);
      setLoadError(null);
      void checkAllModels(list);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [rpc, checkAllModels]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useRealtime("roles-changed", () => {
    void refetch();
  });

  // Plugin signals aren't replayed, so a reconnect has to reconcile durable
  // server state itself — but only past the first connection, which the
  // mount effect above already covers.
  const connectionState = useRealtimeConnectionState();
  const hasConnectedOnceRef = useRef(false);
  useEffect(() => {
    if (connectionState !== "connected") return;
    if (!hasConnectedOnceRef.current) {
      hasConnectedOnceRef.current = true;
      return;
    }
    void refetch();
  }, [connectionState, refetch]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        The quota skip threshold above applies to every role's candidates.
      </p>
      {loadError !== null ? (
        <p className="text-sm text-destructive">Failed to load roles: {loadError}</p>
      ) : null}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Roles</h3>
        <Button size="sm" onClick={() => setFormTarget({ mode: "create" })}>
          <Icon name="Plus" aria-hidden />
          Add role
        </Button>
      </div>
      <div className="space-y-3">
        {roles === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : roles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No roles yet.</p>
        ) : (
          roles.map((role) => (
            <RoleCard
              key={role.id}
              role={role}
              unknownIndices={unknownByRole.get(role.id) ?? EMPTY_UNKNOWN}
              onEdit={() => setFormTarget({ mode: "edit", role })}
              onDelete={() => setPendingDelete(role)}
            />
          ))
        )}
      </div>
      <RoleFormDialog
        target={formTarget}
        providers={providers}
        onOpenChange={(open) => {
          if (!open) setFormTarget(null);
        }}
        onSaved={() => setFormTarget(null)}
      />
      <DeleteRoleDialog
        role={pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onDeleted={() => setPendingDelete(null)}
      />
    </div>
  );
}

function RoleCard({
  role,
  unknownIndices,
  onEdit,
  onDelete,
}: {
  role: Role;
  unknownIndices: ReadonlySet<number>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 p-4 pb-2">
        <div>
          <div className="font-medium">{role.id}</div>
          <div className="text-sm text-muted-foreground">{role.description}</div>
        </div>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" aria-label={`Edit ${role.id}`} onClick={onEdit}>
            <Icon name="Edit" aria-hidden />
          </Button>
          <Button variant="ghost" size="icon" aria-label={`Delete ${role.id}`} onClick={onDelete}>
            <Icon name="Trash2" aria-hidden />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className="text-xs text-muted-foreground">{role.permissionMode}</div>
        <ul className="mt-2 space-y-1">
          {role.candidates.map((candidate, index) => (
            <li key={index} className="flex items-center gap-1.5 text-sm">
              {unknownIndices.has(index) ? (
                <Icon
                  name="AlertTriangle"
                  className="size-3.5 shrink-0 text-amber-500"
                  aria-label={`Unknown model for candidate ${index + 1}`}
                />
              ) : null}
              <span>
                {candidate.provider} · {candidate.model} · {candidate.reasoningLevel}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
