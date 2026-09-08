// components/roles/RoleFormDialog.tsx — the create/edit form, in a
// controlled dialog. `target` null closes it; `{ mode: "create" }` or
// `{ mode: "edit", role }` opens it with a fresh form.
//
// While editing, candidate rows are checked against live provider models on
// a debounce (`checkModels`) so an unknown model shows a marker next to the
// row before save — `saveRole` itself never blocks on this check.
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginProvidersState } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { cn } from "@/lib/utils";
import { reasoningLevelSchema, saveRoleInputSchema, type Candidate, type PermissionMode, type Role } from "../../roles/schema";
import type { rpcContract } from "../../roles/rpc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

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
  // Bumped on every check this effect starts; a response only applies if
  // it's still the latest one requested, so a stale reply that resolves
  // after a newer request can't clobber its result.
  const checkGenerationRef = useRef(0);

  // Debounced live model check: only complete rows are worth asking about.
  // The generation bumps synchronously the moment candidates change (not
  // after the debounce), so a request already in flight when the rows
  // change is invalidated right away instead of staying eligible to apply
  // for the rest of the 400ms window. It bumps again on cleanup so a
  // request whose response arrives after this effect run ends — including
  // on unmount — is also discarded.
  useEffect(() => {
    checkGenerationRef.current += 1;
    const complete = candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.provider.trim() !== "" && candidate.model.trim() !== "");
    if (complete.length === 0) {
      setUnknownIndices(new Set());
      return;
    }
    const timer = setTimeout(() => {
      const generation = ++checkGenerationRef.current;
      void rpc
        .call("checkModels", { candidates: complete.map((entry) => entry.candidate) })
        .then((results) => {
          if (checkGenerationRef.current !== generation) return;
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
    return () => {
      clearTimeout(timer);
      checkGenerationRef.current += 1;
    };
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
    // `null` is the wire's explicit "clear the instruction" signal — plain
    // `undefined` doesn't survive JSON.stringify, so a blank field has to
    // send `null` rather than simply omitting the key (see roles/rpc.ts).
    const trimmedInstruction = instruction.trim();
    const roleInput = {
      id: id.trim(),
      description: description.trim(),
      permissionMode,
      candidates,
      instruction: trimmedInstruction === "" ? null : trimmedInstruction,
    };

    const parsed = saveRoleInputSchema.safeParse(roleInput);
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
    <div className="flex flex-wrap items-start gap-1.5">
      {unknown ? (
        <Icon
          name="AlertTriangle"
          className="mt-2 size-3.5 shrink-0 text-amber-500"
          aria-label={`Candidate ${index + 1} has no matching live model`}
        />
      ) : (
        <span className="mt-2 size-3.5 shrink-0" aria-hidden />
      )}
      <div className="flex min-w-0 flex-[1_1_16rem] flex-wrap items-start gap-1.5">
        <Input
          aria-label={`Candidate ${index + 1} provider`}
          className="min-w-0 flex-[1_1_7rem]"
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
          className="min-w-0 flex-[2_1_9rem]"
          value={candidate.model}
          onChange={(event) => onChange({ model: event.target.value })}
          placeholder="model, may contain {level}"
          required
        />
        <select
          aria-label={`Candidate ${index + 1} reasoning level`}
          className={cn(FIELD_CLASS, "min-w-0 flex-[1_1_6rem]")}
          value={candidate.reasoningLevel}
          onChange={(event) => onChange({ reasoningLevel: event.target.value as Candidate["reasoningLevel"] })}
        >
          {REASONING_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
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
    </div>
  );
}
