import { Database } from "lucide-react";

export function DatabaseSetupRequired() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-3 px-4 text-center">
      <Database className="size-8 text-warning" aria-hidden />
      <h1 className="text-lg font-semibold">Database setup required</h1>
      <p className="text-sm text-muted-foreground">
        The Supabase tables don&apos;t exist yet. In the Supabase SQL editor, run the files in{" "}
        <code className="font-mono text-foreground">supabase/migrations/</code> in filename order, then reload.
      </p>
    </div>
  );
}
