"use client";

import "./globals.css";

/**
 * Last-resort boundary: it replaces the root layout, so it must render its own <html>/<body>. It uses the app's
 * dark tokens (globals.css) instead of Next's unstyled default, and deliberately depends on nothing else.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en" className="dark h-full">
      <body className="min-h-full bg-background text-foreground">
        <main role="alert" className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
          <h1 className="text-lg font-semibold">TracePilot hit an unexpected error</h1>
          <p className="text-sm text-muted-foreground">Reload to try again. If it keeps happening, the problem is on our side, not with your data.</p>
          {error.digest ? <p className="font-mono text-xs text-muted-foreground">Reference: {error.digest}</p> : null}
          <button type="button" onClick={reset} className="h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground">
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
