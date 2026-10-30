import { LogOut } from "lucide-react";
import { ConfigRequired } from "@/components/layout/config-required";
import { Logo } from "@/components/layout/logo";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/auth/actions";
import { requireUser } from "@/lib/auth/session";
import { isSupabaseConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  if (!isSupabaseConfigured()) return <ConfigRequired />;
  const user = await requireUser();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-14 items-center justify-between border-b border-border px-4 md:px-6">
        <Logo href="/onboarding" />
        <div className="flex items-center gap-3">
          <span className="hidden max-w-[16rem] truncate text-sm text-muted-foreground sm:inline" title={user.email}>
            {user.email}
          </span>
          <form action={signOut}>
            <Button type="submit" variant="outline" size="sm">
              <LogOut aria-hidden /> Sign out
            </Button>
          </form>
        </div>
      </header>
      <main id="main" className="flex-1 px-4 py-8 md:py-12">
        {children}
      </main>
    </div>
  );
}
