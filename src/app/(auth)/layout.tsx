import { GitMerge, LineChart, Sparkles } from "lucide-react";
import { Logo } from "@/components/layout/logo";

const POINTS = [
  { icon: GitMerge, text: "Errors grouped into incidents, not alert floods." },
  { icon: LineChart, text: "Timelines and metrics that show how an incident unfolds." },
  { icon: Sparkles, text: "Hypotheses that cite the exact events behind them." },
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
      <aside className="hidden flex-col justify-between border-r border-sidebar-border bg-sidebar p-12 lg:flex">
        <Logo className="text-lg" />
        <div className="max-w-md">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">Incident investigation</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight">From stack trace to root-cause hypothesis.</h2>
          <ul className="mt-8 space-y-4">
            {POINTS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm text-muted-foreground">
                <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted-foreground">A portfolio project built with Next.js and Supabase.</p>
      </aside>

      <main id="main" className="flex flex-col items-center justify-center px-4 py-10 sm:px-8">
        <Logo className="mb-8 text-lg lg:hidden" />
        <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6 sm:p-8">{children}</div>
      </main>
    </div>
  );
}
