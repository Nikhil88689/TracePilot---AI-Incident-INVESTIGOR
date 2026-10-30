"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2, Send, Sparkles } from "lucide-react";
import { CopyButton } from "@/components/common/copy-button";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiKeyManager } from "@/components/ingest/api-key-manager";
import { TestEventPanel } from "@/components/ingest/test-event-panel";
import type { ApiKeyRecord } from "@/lib/ingest/key-service";
import { SDK_INSTALL_COMMAND, curlCommand, samplePayload, sdkSnippet } from "@/lib/ingest-snippets";
import { createProjectAction } from "@/lib/projects/actions";
import {
  ENVIRONMENTS,
  ENVIRONMENT_LABELS,
  projectNameSchema,
  type Environment,
  type Project,
} from "@/lib/projects/schemas";
import { cn } from "@/lib/utils";

const STEPS = ["Project", "Details", "Install", "Finish"] as const;
type Step = 1 | 2 | 3 | 4;

type Props = { initialProject: Project | null; endpoint: string; initialKeys?: ApiKeyRecord[] };

function CodeBlock({ label, children }: { label: string; children: string }) {
  return (
    <div className="space-y-2">
      <pre
        tabIndex={0}
        aria-label={label}
        className="max-h-60 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed"
      >
        {children}
      </pre>
      <CopyButton value={children} />
    </div>
  );
}

export function OnboardingWizard({ initialProject, endpoint, initialKeys = [] }: Props) {
  const [step, setStep] = useState<Step>(initialProject ? 3 : 1);
  const [project, setProject] = useState<Project | null>(initialProject);
  const [name, setName] = useState(initialProject?.name ?? "");
  const [environment, setEnvironment] = useState<Environment>(initialProject?.environment ?? "production");
  const [nameError, setNameError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [pending, startTransition] = useTransition();
  // One id per "create this project" intent: retries and double-clicks cannot create two rows.
  const [requestId] = useState(() => crypto.randomUUID());
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Move focus to the step heading so keyboard and screen-reader users land on the new content.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const locked = project !== null;
  const goTo = (next: Step) => setStep(next);

  function continueFromName() {
    const parsed = projectNameSchema.safeParse(name);
    if (!parsed.success) {
      setNameError(parsed.error.issues[0]?.message);
      return;
    }
    setNameError(undefined);
    setName(parsed.data);
    goTo(2);
  }

  function create() {
    setFormError(undefined);
    startTransition(async () => {
      const result = await createProjectAction({ name, environment, requestId });
      if (result.status === "success") {
        setProject(result.project);
        goTo(3);
        return;
      }
      if (result.status === "error") {
        if (result.fieldErrors?.name) {
          setNameError(result.fieldErrors.name);
          goTo(1);
        } else {
          setFormError(result.fieldErrors?.environment ?? result.message);
        }
      }
    });
  }

  const curl = curlCommand(endpoint, samplePayload({ name: project?.name ?? name, environment: project?.environment ?? environment }));

  return (
    <div className="mx-auto w-full max-w-2xl">
      <nav aria-label="Onboarding progress" className="mb-8">
        <ol className="flex items-center">
          {STEPS.map((label, index) => {
            const number = (index + 1) as Step;
            const done = number < step;
            const current = number === step;
            return (
              <li key={label} className={cn("flex items-center", index < STEPS.length - 1 && "flex-1")}>
                <span className="flex items-center gap-2" aria-current={current ? "step" : undefined}>
                  <span
                    className={cn(
                      "flex size-7 items-center justify-center rounded-full border text-xs font-medium tabular-nums",
                      done && "border-primary bg-primary text-primary-foreground",
                      current && "border-primary text-foreground",
                      !done && !current && "border-border text-muted-foreground",
                    )}
                  >
                    {done ? <Check className="size-3.5" aria-hidden /> : number}
                  </span>
                  <span className={cn("hidden text-sm sm:inline", current ? "font-medium" : "text-muted-foreground")}>
                    {label}
                  </span>
                  <span className="sr-only">
                    {done ? "(completed)" : current ? "(current step)" : "(upcoming)"}
                  </span>
                </span>
                {index < STEPS.length - 1 ? (
                  <span aria-hidden className={cn("mx-3 h-px flex-1", done ? "bg-primary" : "bg-border")} />
                ) : null}
              </li>
            );
          })}
        </ol>
      </nav>

      <section className="rounded-lg border border-border bg-card p-6 sm:p-8" aria-labelledby="step-heading">
        {step === 1 ? (
          <div className="space-y-5">
            <div>
              <h1 id="step-heading" ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">
                Create your first project
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                A project represents one application you want to monitor. Errors sent to it are grouped into incidents.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-name">Project name</Label>
              <Input
                id="project-name"
                value={name}
                disabled={locked}
                maxLength={80}
                placeholder="e.g. checkout-web"
                autoComplete="off"
                aria-invalid={Boolean(nameError)}
                aria-describedby={nameError ? "project-name-error" : locked ? "project-locked" : undefined}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError(undefined);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (locked) goTo(2);
                    else continueFromName();
                  }
                }}
              />
              {nameError ? (
                <p id="project-name-error" role="alert" className="text-xs text-destructive">
                  {nameError}
                </p>
              ) : null}
              {locked ? (
                <p id="project-locked" className="text-xs text-muted-foreground">
                  This project has been created. Rename it later in Project Settings.
                </p>
              ) : null}
            </div>
            <div className="flex justify-end">
              <Button onClick={locked ? () => goTo(2) : continueFromName}>
                Continue <ArrowRight aria-hidden />
              </Button>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="space-y-5">
            <div>
              <h1 id="step-heading" ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">
                Choose an environment
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Creating <span className="font-mono text-foreground">{name.trim() || "your project"}</span>. Use a
                separate project per environment to keep incidents apart.
              </p>
            </div>

            <fieldset disabled={locked || pending} className="space-y-2">
              <legend className="sr-only">Environment</legend>
              {ENVIRONMENTS.map((value) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 transition-colors hover:bg-accent has-[:checked]:border-primary has-[:checked]:bg-primary/10 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                    (locked || pending) && "cursor-not-allowed opacity-70",
                  )}
                >
                  <input
                    type="radio"
                    name="environment"
                    value={value}
                    checked={environment === value}
                    onChange={() => setEnvironment(value)}
                    className="mt-1 accent-[var(--primary)]"
                  />
                  <span>
                    <span className="block text-sm font-medium">{ENVIRONMENT_LABELS[value].label}</span>
                    <span className="block text-xs text-muted-foreground">{ENVIRONMENT_LABELS[value].hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {formError ? (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {formError}
              </p>
            ) : null}

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => goTo(1)} disabled={pending}>
                <ArrowLeft aria-hidden /> Back
              </Button>
              {locked ? (
                <Button onClick={() => goTo(3)}>
                  Continue <ArrowRight aria-hidden />
                </Button>
              ) : (
                <Button onClick={create} disabled={pending}>
                  {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                  {pending ? "Creating…" : "Create project"}
                </Button>
              )}
            </div>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="space-y-5">
            <div>
              <h1 id="step-heading" ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">
                Send events from your app
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                <span className="font-mono text-foreground">{project?.name}</span> is ready. Create an API key, then
                report errors with the Node.js SDK or plain HTTP.
              </p>
            </div>

            <div className="space-y-2">
              <h2 className="text-sm font-medium">1. Create an API key</h2>
              {project ? <ApiKeyManager projectId={project.id} initialKeys={initialKeys} /> : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="endpoint">2. Ingestion endpoint</Label>
              <div className="flex gap-2">
                <Input id="endpoint" readOnly value={endpoint} className="font-mono text-xs" />
                <CopyButton value={endpoint} />
              </div>
            </div>

            <div className="space-y-2">
              <h2 className="text-sm font-medium">3. Report errors from Node.js</h2>
              <p className="text-xs text-muted-foreground">
                The SDK isn&apos;t published to npm. Install it from the repository&apos;s <code className="font-mono">sdk/</code>{" "}
                folder:
              </p>
              <CodeBlock label="SDK install command">{SDK_INSTALL_COMMAND}</CodeBlock>
              <CodeBlock label="SDK usage example">{sdkSnippet(endpoint)}</CodeBlock>
              <p className="text-xs text-muted-foreground">Prefer plain HTTP? Use curl:</p>
              <CodeBlock label="curl example">{curl}</CodeBlock>
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => goTo(2)}>
                <ArrowLeft aria-hidden /> Back
              </Button>
              <Button onClick={() => goTo(4)}>
                Continue <ArrowRight aria-hidden />
              </Button>
            </div>
          </div>
        ) : null}

        {step === 4 ? (
          <div className="space-y-5">
            <div>
              <h1 id="step-heading" ref={headingRef} tabIndex={-1} className="text-xl font-semibold tracking-tight outline-none">
                You&apos;re all set
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">Pick how you&apos;d like to get started.</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-3 rounded-md border border-border p-4">
                <Send className="size-5 text-primary" aria-hidden />
                <h2 className="text-sm font-medium">Send a test event</h2>
                <p className="text-xs text-muted-foreground">
                  Sends a sample error through the real ingestion API and shows the incident it lands in.
                </p>
                {project ? <TestEventPanel projects={[project]} idPrefix="onboarding-test-event" /> : null}
              </div>
              <div className="space-y-3 rounded-md border border-border p-4">
                <Sparkles className="size-5 text-primary" aria-hidden />
                <h2 className="text-sm font-medium">See your incidents</h2>
                <p className="text-xs text-muted-foreground">Events from your application are grouped into incidents here, with timelines and stack traces.</p>
                <Link href="/incidents" className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Open incidents
                </Link>
              </div>
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => goTo(3)}>
                <ArrowLeft aria-hidden /> Back
              </Button>
              <Link href="/dashboard" className={buttonVariants()}>
                Go to dashboard <ArrowRight aria-hidden />
              </Link>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
