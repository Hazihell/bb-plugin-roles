// components/roles/RoleFormDialog.tsx — the create/edit form, in a
// controlled dialog. `target` null closes it; `{ mode: "create" }` or
// `{ mode: "edit", role }` opens it with a fresh form.
//
// While editing, candidate rows are checked against live provider models on
// a debounce (`checkModels`) so an unknown model shows a marker next to the
// row before save — `saveRole` itself never blocks on this check.
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginProvidersState } from "@get-bb/plugin-sdk/app";
import { useEffect, useState, type FormEvent } from "react";
import { cn } from "../../lib/utils";
import { reasoningLevelSchema, roleSchema, type Candidate, type PermissionMode, type Role } from "../../roles/schema";
import { rpcContract } from "../../roles/rpc";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";

export type RoleFormTarget = { mode: "create" } | { mode: "edit"; role: Role };

const REASONING_LEVELS = reasoningLevelSchema.options;
const PERMISSION_MODES: readonly PermissionMode[] = ["accept-edits", "auto", "full"];
const EMPTY_CANDIDATE: Candidate = { provider: "", model: "", reasoningLevel: "medium" };
const FIELD_CLASS =
  "flex w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export function RoleFormDialog({
  target,
  providers,
  onOpenChange,
  onSaved,
}: {
  target: RoleFormTarget | null;
  providers: PluginProvidersState["providers"];
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        {target !== null ? (
          <RoleForm
            key={target.mode === "edit" ? target.role.id : "__create__"}
            initial={target.mode === "edit" ? target.role : null}
            providers={providers}
            onCancel={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RoleForm({
  initial,
  providers,
  onCancel,
  onSaved,
}: {
  initial: Role | null;
  providers: PluginProvidersState["providers"];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [id, setId] = useState(initial?.id ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(initial?.permissionMode ?? "full");
  const [instruction, setInstruction] = useState(initial?.instruction ?? "");
  const [candidates, setCandidates] = useState<Candidate[]>(initial?.candidates ?? [EMPTY_CANDIDATE]);
  const [unknownIndices, setUnknownIndices] = useState<ReadonlySet<number>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Debounced live model check: only complete rows are worth asking about.
  useEffect(() => {
    const complete = candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.provider.trim() !== "" && candidate.model.trim() !== "");
    if (complete.length === 0) {
      setUnknownIndices(new Set());
      return;
    }
    const timer = setTimeout(() => {
      void rpc
        .call("checkModels", { candidates: complete.map((entry) => entry.candidate) })
        .then((results) => {
          const unknown = new Set<number>();
          results.forEach((result, position) => {
            if (!result.known) {
              const entry = complete[position];
              if (entry !== undefined) unknown.add(entry.index);
            }
          });
          setUnknownIndices(unknown);
        })
        .catch(() => {
          // Best-effort live hint; save-time warnings remain authoritative.
        });
    }, 400);
    return () => clearTimeout(timer);
  }, [candidates, rpc]);

  function updateCandidate(index: number, patch: Partial<Candidate>) {
    setCandidates((current) => current.map((candidate, i) => (i === index ? { ...candidate, ...patch } : candidate)));
  }

  function addCandidate() {
    setCandidates((current) => [...current, EMPTY_CANDIDATE]);
  }

  function removeCandidate(index: number) {
    setCandidates((current) => current.filter((_, i) => i !== index));
  }

  function moveCandidate(index: number, direction: -1 | 1) {
    setCandidates((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (moved === undefined) return current;
      next.splice(target, 0, moved);
      return next;
    });
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // Omit `instruction` entirely rather than setting it `undefined`: the
    // rpc wire format rejects `undefined` as a value, but an absent
    // optional key round-trips cleanly (and matches how a role with no
    // instruction is stored).
    const roleInput: Record<string, unknown> = {
      id: id.trim(),
      description: description.trim(),
      permissionMode,
      candidates,
    };
    if (instruction.trim() !== "") roleInput.instruction = instruction.trim();

    const parsed = roleSchema.safeParse(roleInput);
    if (!parsed.success) {
      setSaveError(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }
    setSaveError(null);
    setSaving(true);
    try {
      await rpc.call("saveRole", { role: parsed.data, mode: initial === null ? "create" : "update" });
      onSaved();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{initial === null ? "Add role" : `Edit ${initial.id}`}</DialogTitle>
      </DialogHeader>

      <div className="space-y-1.5">
        <label htmlFor="role-id" className="text-sm font-medium">
          Id
        </label>
        <Input
          id="role-id"
          value={id}
          onChange={(event) => setId(event.target.value)}
          readOnly={initial !== null}
          disabled={initial !== null}
          placeholder="builder"
          required
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="role-description" className="text-sm font-medium">
          Description
        </label>
        <Input
          id="role-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          required
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="role-permission-mode" className="text-sm font-medium">
          Permission mode
        </label>
        <select
          id="role-permission-mode"
          className={FIELD_CLASS}
          value={permissionMode}
          onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}
        >
          {PERMISSION_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="role-instruction" className="text-sm font-medium">
          Instruction
        </label>
        <textarea
          id="role-instruction"
          className={cn(FIELD_CLASS, "min-h-20 resize-y")}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
        />
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">Candidates</div>
        <p className="text-xs text-muted-foreground">Tried in order; move a row to change its fallback order.</p>
        <div className="space-y-2">
          {candidates.map((candidate, index) => (
            <CandidateRow
              key={index}
              candidate={candidate}
              index={index}
              total={candidates.length}
              providers={providers}
              unknown={unknownIndices.has(index)}
              onChange={(patch) => updateCandidate(index, patch)}
              onRemove={() => removeCandidate(index)}
              onMoveUp={() => moveCandidate(index, -1)}
              onMoveDown={() => moveCandidate(index, 1)}
            />
          ))}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={addCandidate}>
          <Icon name="Plus" aria-hidden />
          Add candidate
        </Button>
      </div>

      {saveError !== null ? <p className="text-sm text-destructive">{saveError}</p> : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

function CandidateRow({
  candidate,
  index,
  total,
  providers,
  unknown,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  candidate: Candidate;
  index: number;
  total: number;
  providers: PluginProvidersState["providers"];
  unknown: boolean;
  onChange: (patch: Partial<Candidate>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const datalistId = `role-form-providers-${index}`;
  return (
    <div className="flex items-start gap-1.5">
      {unknown ? (
        <Icon
          name="AlertTriangle"
          className="mt-2 size-3.5 shrink-0 text-amber-500"
          aria-label={`Candidate ${index + 1} has no matching live model`}
        />
      ) : (
        <span className="mt-2 size-3.5 shrink-0" aria-hidden />
      )}
      <Input
        aria-label={`Candidate ${index + 1} provider`}
        className="w-32"
        list={datalistId}
        value={candidate.provider}
        onChange={(event) => onChange({ provider: event.target.value })}
        placeholder="provider"
        required
      />
      <datalist id={datalistId}>
        {providers.map((provider) => (
          <option key={provider.id} value={provider.id}>
            {provider.displayName}
          </option>
        ))}
      </datalist>
      <Input
        aria-label={`Candidate ${index + 1} model`}
        className="flex-1"
        value={candidate.model}
        onChange={(event) => onChange({ model: event.target.value })}
        placeholder="model, may contain {level}"
        required
      />
      <select
        aria-label={`Candidate ${index + 1} reasoning level`}
        className={cn(FIELD_CLASS, "w-28")}
        value={candidate.reasoningLevel}
        onChange={(event) => onChange({ reasoningLevel: event.target.value as Candidate["reasoningLevel"] })}
      >
        {REASONING_LEVELS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Move candidate ${index + 1} up`}
        onClick={onMoveUp}
        disabled={index === 0}
      >
        <Icon name="ArrowUp" aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Move candidate ${index + 1} down`}
        onClick={onMoveDown}
        disabled={index === total - 1}
      >
        <Icon name="ArrowDown" aria-hidden />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Remove candidate ${index + 1}`}
        onClick={onRemove}
        disabled={total <= 1}
      >
        <Icon name="Trash2" aria-hidden />
      </Button>
    </div>
  );
}
