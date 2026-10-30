import { TriangleAlert } from "lucide-react";

export function ConfigRequired() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center gap-3 px-4 text-center">
      <TriangleAlert className="size-8 text-warning" aria-hidden />
      <h1 className="text-lg font-semibold">Supabase is not configured</h1>
      <p className="text-sm text-muted-foreground">
        Set <code className="font-mono text-foreground">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code className="font-mono text-foreground">NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>. Locally, copy{" "}
        <code className="font-mono text-foreground">.env.example</code> to{" "}
        <code className="font-mono text-foreground">.env.local</code> and restart the dev server. On Vercel, add them under
        Settings, Environment Variables for this environment, then <strong>redeploy</strong> (variables apply to new
        deployments only).
      </p>
    </div>
  );
}
