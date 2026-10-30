import Link from "next/link";
import { ArrowRight, GitMerge, LineChart, Sparkles } from "lucide-react";
import { Logo } from "@/components/layout/logo";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const FEATURES = [
  {
    icon: GitMerge,
    title: "Errors grouped into incidents",
    body: "Events are fingerprinted and clustered, so one regression is one incident, not five hundred alerts.",
  },
  {
    icon: LineChart,
    title: "Timelines and metrics",
    body: "See when an incident started, how fast it is growing, and which releases and routes it touches.",
  },
  {
    icon: Sparkles,
    title: "Evidence-backed hypotheses",
    body: "AI proposes likely causes and cites the exact events that support each one.",
  },
];

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 py-5">
        <Logo />
        <nav aria-label="Account" className="flex items-center gap-2">
          <Link href="/login" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Sign in
          </Link>
          <Link href="/signup" className={buttonVariants({ size: "sm" })}>
            Get started
          </Link>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4">
        <section className="py-16 md:py-24">
          <p className="mb-4 font-mono text-xs uppercase tracking-widest text-primary">Incident investigation</p>
          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight md:text-5xl">
            From stack trace to root-cause hypothesis in minutes.
          </h1>
          <p className="mt-5 max-w-xl text-base text-muted-foreground">
            Send application errors to TracePilot. It groups them into incidents, charts how they unfold, and
            suggests what broke, citing the events behind every claim.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/signup" className={cn(buttonVariants({ size: "lg" }))}>
              Create an account <ArrowRight className="size-4" aria-hidden />
            </Link>
            <Link href="/login" className={buttonVariants({ variant: "outline", size: "lg" })}>
              Sign in
            </Link>
          </div>
        </section>

        <section aria-labelledby="features" className="pb-20">
          <h2 id="features" className="sr-only">
            Features
          </h2>
          <ul className="grid gap-4 md:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <li key={title} className="rounded-lg border border-border bg-card p-5">
                <Icon className="mb-3 size-5 text-primary" aria-hidden />
                <h3 className="text-sm font-medium">{title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
