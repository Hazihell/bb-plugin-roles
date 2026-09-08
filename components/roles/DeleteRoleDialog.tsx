// components/roles/DeleteRoleDialog.tsx — the delete confirmation. `role`
// non-null is "open"; RolesSettingsSection owns the state.
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { rpcContract } from "../../roles/rpc";
import type { Role } from "../../roles/schema";

export function DeleteRoleDialog({
  role,
  onOpenChange,
  onDeleted,
}: {
  role: Role | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    if (role === null) return;
    setDeleting(true);
    setError(null);
    try {
      await rpc.call("deleteRole", { id: role.id });
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog
      open={role !== null}
      onOpenChange={(open) => {
        if (!open) setError(null);
        onOpenChange(open);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete role{role !== null ? ` "${role.id}"` : ""}?</DialogTitle>
          <DialogDescription>This can't be undone.</DialogDescription>
        </DialogHeader>
        {error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
