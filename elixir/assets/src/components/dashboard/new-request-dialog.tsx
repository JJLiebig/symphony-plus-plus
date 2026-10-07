import { CheckCircle2, Copy, Loader2, Plus, Send } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { uniqueNonEmpty } from "@/lib/collections";
import { formatStatus } from "@/lib/status-labels";
import type {
  ArchitectHandoff,
  ArchitectHandoffCopyResult,
  CopyArchitectHandoff,
  HandoffCopyState,
  WorkRequestCard,
  WorkRequestDetail,
} from "@/types/dashboard";

const BRANCH_INTAKE_OPTIONS = ["main", "beta", "dev", "beta/dev"];

export type NewRequestForm = {
  title: string;
  repo: string;
  base_branch: string;
  work_type: string;
  desired_dispatch_shape: string;
  human_description: string;
};

type NewRequestRepo = {
  repo: string;
  baseBranches: string[];
};

type NewRequestDialogState = {
  submitting: boolean;
  createdRequest: WorkRequestDetail | null;
  architectHandoff: ArchitectHandoff | null;
  handoffCopyState: HandoffCopyState;
  error: string | null;
};

type NewRequestDialogAction =
  | { type: "reset" }
  | { type: "startSubmit" }
  | { type: "created"; request: WorkRequestDetail }
  | { type: "failed"; error: string }
  | { type: "startCopy" }
  | { type: "copyResult"; result: ArchitectHandoffCopyResult };

type NewRequestFormAction =
  | { type: "patch"; patch: Partial<NewRequestForm> }
  | { type: "replace"; form: NewRequestForm }
  | { type: "selectRepo"; repo: string; repos: NewRequestRepo[] }
  | { type: "sync"; repos: NewRequestRepo[]; repoChoices: string[] };

const initialRequestForm: NewRequestForm = {
  title: "",
  repo: "symphony-plus-plus",
  base_branch: "main",
  work_type: "feature",
  desired_dispatch_shape: "architect_led_feature_branch",
  human_description: "",
};

const initialNewRequestDialogState: NewRequestDialogState = {
  submitting: false,
  createdRequest: null,
  architectHandoff: null,
  handoffCopyState: "idle",
  error: null,
};

function newRequestFormReducer(form: NewRequestForm, action: NewRequestFormAction): NewRequestForm {
  switch (action.type) {
    case "patch":
      return { ...form, ...action.patch };
    case "replace":
      return action.form;
    case "selectRepo":
      return {
        ...form,
        repo: action.repo,
        base_branch: baseBranchOptionsForRepo(action.repos, action.repo)[0] || initialRequestForm.base_branch,
      };
    case "sync":
      return syncNewRequestFormToRepos(form, action.repos, action.repoChoices);
  }
}

function newRequestDialogReducer(state: NewRequestDialogState, action: NewRequestDialogAction): NewRequestDialogState {
  switch (action.type) {
    case "reset":
      return initialNewRequestDialogState;
    case "startSubmit":
      return { ...state, submitting: true, error: null };
    case "created":
      return { ...state, submitting: false, createdRequest: action.request, architectHandoff: null, handoffCopyState: "idle", error: null };
    case "failed":
      return { ...state, submitting: false, handoffCopyState: "error", error: action.error };
    case "startCopy":
      return { ...state, handoffCopyState: "copying", error: null };
    case "copyResult":
      return {
        ...state,
        architectHandoff: action.result.handoff,
        handoffCopyState: action.result.copied ? "copied" : "error",
        error: action.result.copyError ? `Handoff is ready, but clipboard copy failed: ${action.result.copyError}` : null,
      };
  }
}

export function NewRequestDialog({
  canCopyArchitectHandoff,
  onCopyArchitectHandoff,
  onCreateRequest,
  onOpenChange,
  open,
  repos,
}: {
  canCopyArchitectHandoff: (request: WorkRequestCard) => boolean;
  onCopyArchitectHandoff: CopyArchitectHandoff;
  onCreateRequest: (form: NewRequestForm) => Promise<WorkRequestDetail>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  repos: NewRequestRepo[];
}) {
  const repoChoices = useMemo(() => repoOptions(repos), [repos]);
  const initialRepo = repoChoices[0] || initialRequestForm.repo;
  const [form, updateForm] = useReducer(newRequestFormReducer, { initialRepo, repos }, ({ initialRepo: repo, repos: initialRepos }) => ({
    ...initialRequestForm,
    repo,
    base_branch: baseBranchOptionsForRepo(initialRepos, repo)[0] || initialRequestForm.base_branch,
  }));
  const branchChoices = useMemo(() => baseBranchOptionsForRepo(repos, form.repo), [form.repo, repos]);
  const [dialogState, dispatchDialog] = useReducer(newRequestDialogReducer, initialNewRequestDialogState);
  const { architectHandoff, createdRequest, error, handoffCopyState, submitting } = dialogState;

  useEffect(() => {
    if (!open || createdRequest) return;

    updateForm({ type: "sync", repos, repoChoices });
  }, [createdRequest, open, repoChoices, repos]);

  async function copyCreatedHandoff() {
    if (!createdRequest) return;

    dispatchDialog({ type: "startCopy" });

    try {
      const result = await onCopyArchitectHandoff(createdRequest.work_request.id, architectHandoff);
      dispatchDialog({ type: "copyResult", result });
    } catch (caught) {
      dispatchDialog({ type: "failed", error: caught instanceof Error ? caught.message : "Architect handoff could not be copied" });
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    dispatchDialog({ type: "startSubmit" });

    try {
      const createdRequestDetail = await onCreateRequest(form);
      updateForm({ type: "replace", form: { ...initialRequestForm, repo: form.repo, base_branch: form.base_branch } });
      dispatchDialog({ type: "created", request: createdRequestDetail });
    } catch (caught) {
      dispatchDialog({ type: "failed", error: caught instanceof Error ? caught.message : "Request was not created" });
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (nextOpen && !createdRequest) {
      updateForm({ type: "sync", repos, repoChoices });
      dispatchDialog({ type: "reset" });
    } else if (!nextOpen) {
      dispatchDialog({ type: "reset" });
    }

    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          New Request
        </Button>
      </DialogTrigger>
      <DialogContent className="dashboard-dialog-content">
        <AnimatedDetailBody motionKey={createdRequest ? `created:${createdRequest.work_request.id}:${handoffCopyState}` : "new-request:form"}>
          {createdRequest ? (
            <div className="grid gap-5">
              <DialogHeader>
                <DialogTitle>Request Created</DialogTitle>
                <DialogDescription>Ready for an architecture agent</DialogDescription>
              </DialogHeader>
              <div className="handoff-success-panel" data-guidance-section>
                <div className="flex min-w-0 items-start gap-3">
                  <div className="handoff-success-icon">
                    <CheckCircle2 className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{createdRequest.work_request.title || createdRequest.work_request.id}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {createdRequest.work_request.repo_display?.trim() || createdRequest.work_request.repo?.trim() || "Unscoped"} / {createdRequest.work_request.base_branch || "main"}
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">
                  The request is in the ledger. Copy the architect handoff and paste it into the Codex session that will own this WorkRequest.
                </p>
              </div>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => dispatchDialog({ type: "reset" })}>
                  New Request
                </Button>
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  Close
                </Button>
                <Button
                  type="button"
                  onClick={() => void copyCreatedHandoff()}
                  disabled={handoffCopyState === "copying" || !canCopyArchitectHandoff(createdRequest.work_request)}
                >
                  {handoffCopyState === "copying" ? <Loader2 className="size-4 animate-spin" /> : handoffCopyState === "copied" ? <CheckCircle2 className="size-4" /> : <Copy className="size-4" />}
                  {handoffCopyState === "copied" ? "Copied Architect Handoff" : "Copy Architect Handoff"}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form onSubmit={submit} className="grid gap-5">
              <DialogHeader>
                <DialogTitle>New Request</DialogTitle>
                <DialogDescription>Architect-owned intake</DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Title">
                  <Input value={form.title} onChange={(event) => updateForm({ type: "patch", patch: { title: event.target.value } })} required />
                </Field>
                <Field label="Repository">
                  <Select
                    value={form.repo}
                    onValueChange={(value) =>
                      updateForm({
                        type: "selectRepo",
                        repo: value,
                        repos,
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {repoChoices.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Base Branch">
                  <Select value={form.base_branch} onValueChange={(value) => updateForm({ type: "patch", patch: { base_branch: value } })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {branchChoices.map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Work Type">
                  <Select value={form.work_type} onValueChange={(value) => updateForm({ type: "patch", patch: { work_type: value } })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["feature", "bugfix", "hotfix", "refactor", "investigation", "docs", "review"].map((value) => (
                        <SelectItem key={value} value={value}>
                          {formatStatus(value)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Delivery">
                  <Select value={form.desired_dispatch_shape} onValueChange={(value) => updateForm({ type: "patch", patch: { desired_dispatch_shape: value } })}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DISPATCH_SHAPES.map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field label="Description (Markdown)">
                <Textarea
                  value={form.human_description}
                  onChange={(event) => updateForm({ type: "patch", patch: { human_description: event.target.value } })}
                  placeholder="Problem, context, and expected outcome."
                  required
                />
              </Field>
              {error ? <p className="text-sm text-destructive">{error}</p> : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                  Create
                </Button>
              </DialogFooter>
            </form>
          )}
        </AnimatedDetailBody>
      </DialogContent>
    </Dialog>
  );
}

function AnimatedDetailBody({ motionKey, children }: { motionKey: string; children: ReactNode }) {
  const innerRef = useRef<HTMLDivElement>(null);
  const settleTimerRef = useRef<number | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  const clearSettleTimer = useCallback(() => {
    const settleTimer = settleTimerRef.current;
    if (settleTimer === null) return;

    window.clearTimeout(settleTimer);
    settleTimerRef.current = null;
  }, []);

  const measure = useCallback(() => {
    const node = innerRef.current;
    if (!node) return;

    const nextHeight = Math.ceil(node.getBoundingClientRect().height);
    if (nextHeight <= 0) return;

    setHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));

    clearSettleTimer();

    settleTimerRef.current = window.setTimeout(() => {
      setHeight(null);
      settleTimerRef.current = null;
    }, 340);
  }, [clearSettleTimer]);

  useLayoutEffect(() => {
    measure();
    const frame = window.requestAnimationFrame(measure);
    return () => window.cancelAnimationFrame(frame);
  }, [measure, motionKey]);

  useEffect(() => {
    const node = innerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    let animationFrame: number | null = null;

    const observer = new ResizeObserver(() => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }

      animationFrame = window.requestAnimationFrame(measure);
    });

    observer.observe(node);

    return () => {
      observer.disconnect();

      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = null;
      }

      clearSettleTimer();
    };
  }, [clearSettleTimer, measure]);

  return (
    <div className="detail-modal-size-frame" data-detail-motion-key={motionKey} style={height === null ? undefined : { height }}>
      <div ref={innerRef} className="detail-modal-size-inner">
        {children}
      </div>
    </div>
  );
}

// Existing intake shapes with operator-facing names: direct for small clear work, architect-led for larger features.
const DISPATCH_SHAPES = [
  ["single_package", "Direct delivery"],
  ["architect_led_feature_branch", "Architect-led"],
  ["direct_main_fix", "Direct main fix"],
  ["investigation_first", "Investigation first"],
] as const;

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function repoOptions(repos: NewRequestRepo[]) {
  const dashboardRepos = uniqueNonEmpty(repos.map((repo) => repo.repo));
  if (dashboardRepos.length > 0) {
    return dashboardRepos;
  }

  return uniqueNonEmpty([initialRequestForm.repo]);
}

function baseBranchOptionsForRepo(repos: NewRequestRepo[], repo: string) {
  const summary = repos.find((candidate) => candidate.repo === repo);
  const exposedBranches = uniqueNonEmpty(summary?.baseBranches || []);
  const branchOptions = BRANCH_INTAKE_OPTIONS.filter((branch) => exposedBranches.includes(branch));
  return branchOptions.length > 0 ? branchOptions : [initialRequestForm.base_branch];
}

function syncNewRequestFormToRepos(form: NewRequestForm, repos: NewRequestRepo[], repoChoices: string[]): NewRequestForm {
  const repo = repoChoices.includes(form.repo) ? form.repo : repoChoices[0] || initialRequestForm.repo;
  const branches = baseBranchOptionsForRepo(repos, repo);
  const baseBranch = branches.includes(form.base_branch) ? form.base_branch : branches[0] || initialRequestForm.base_branch;

  return repo === form.repo && baseBranch === form.base_branch ? form : { ...form, repo, base_branch: baseBranch };
}
