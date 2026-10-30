"use client";

import { useState, useTransition } from "react";
import { KeyRound, Loader2, TriangleAlert } from "lucide-react";
import { CopyButton } from "@/components/common/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createApiKeyAction, revokeApiKeyAction } from "@/lib/ingest/key-actions";
import type { ApiKeyRecord } from "@/lib/ingest/key-service";

type Props = { projectId: string; initialKeys: ApiKeyRecord[] };

function formatDate(iso: string | null): string {
  return iso ? `${new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC` : "Never";
}

export function ApiKeyManager({ projectId, initialKeys }: Props) {
  const [keys, setKeys] = useState(initialKeys);
  const [name, setName] = useState("Production server");
  const [nameError, setNameError] = useState<string>();
  const [error, setError] = useState<string>();
  // Plaintext lives only in this component's memory, only until the user dismisses it.
  const [revealed, setRevealed] = useState<string | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiKeyRecord | null>(null);
  const [creating, startCreate] = useTransition();
  const [revoking, startRevoke] = useTransition();

  function create() {
    setError(undefined);
    setNameError(undefined);
    startCreate(async () => {
      const result = await createApiKeyAction({ projectId, name });
      if (result.status === "success") {
        setKeys((prev) => [result.record, ...prev]);
        setRevealed(result.key);
      } else {
        setNameError(result.fieldErrors?.name);
        setError(result.fieldErrors?.name ? undefined : result.message);
      }
    });
  }

  function revoke() {
    if (!toRevoke) return;
    const target = toRevoke;
    startRevoke(async () => {
      const result = await revokeApiKeyAction({ keyId: target.id });
      if (result.status === "success") {
        setKeys((prev) => prev.map((k) => (k.id === target.id ? { ...k, revoked_at: result.revokedAt } : k)));
        setToRevoke(null);
      } else {
        setError(result.message);
        setToRevoke(null);
      }
    });
  }

  return (
    <div className="space-y-4">
      {revealed ? (
        <div role="alert" className="space-y-3 rounded-md border border-warning/40 bg-warning/10 p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-warning">
            <TriangleAlert className="size-4" aria-hidden /> Copy your API key now. It won&apos;t be shown again.
          </p>
          <div className="flex gap-2">
            <Input readOnly aria-label="New API key" value={revealed} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <CopyButton value={revealed} />
          </div>
          <p className="text-xs text-muted-foreground">
            Store it as <code className="font-mono">TRACEPILOT_API_KEY</code> on your server. Only a hash is kept on our
            side, so a lost key can&apos;t be recovered, only replaced.
          </p>
          <Button variant="outline" size="sm" onClick={() => setRevealed(null)}>
            I&apos;ve saved it
          </Button>
        </div>
      ) : null}

      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <div className="flex-1 space-y-1.5">
          <Label htmlFor={`key-name-${projectId}`}>New key name</Label>
          <Input
            id={`key-name-${projectId}`}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={Boolean(nameError)}
            aria-describedby={nameError ? `key-name-error-${projectId}` : undefined}
          />
          {nameError ? (
            <p id={`key-name-error-${projectId}`} className="text-xs text-destructive">
              {nameError}
            </p>
          ) : null}
        </div>
        <Button type="submit" disabled={creating}>
          {creating ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
          {creating ? "Creating…" : "Create API key"}
        </Button>
      </form>

      {error ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">No API keys yet. Create one to start sending events.</p>
      ) : (
        <ul aria-label="API keys" className="divide-y divide-border rounded-md border border-border">
          {keys.map((k) => {
            const revoked = k.revoked_at !== null;
            return (
              <li key={k.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{k.name}</span>
                    <Badge variant="outline" className={revoked ? "text-muted-foreground" : "border-success/30 bg-success/10 text-success"}>
                      {revoked ? "Revoked" : "Active"}
                    </Badge>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <code className="font-mono">{k.key_prefix}…</code> · Created{" "}
                    <time dateTime={k.created_at} suppressHydrationWarning>{formatDate(k.created_at)}</time> · Last used{" "}
                    <time suppressHydrationWarning>{formatDate(k.last_used_at)}</time>
                  </p>
                </div>
                {revoked ? null : (
                  <Button variant="outline" size="sm" onClick={() => setToRevoke(k)} aria-label={`Revoke key ${k.name}`}>
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={toRevoke !== null} onOpenChange={(open) => !open && setToRevoke(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Revoke this key?</DialogTitle>
            <DialogDescription>
              Applications using <span className="font-mono text-foreground">{toRevoke?.key_prefix}…</span> will
              immediately stop being able to send events. This can&apos;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToRevoke(null)} disabled={revoking}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={revoke} disabled={revoking}>
              {revoking ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Revoke key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
