import type { Metadata } from "next";
import { Sparkles } from "lucide-react";
import { EmptyState } from "@/components/common/empty-state";
import { PageHeader } from "@/components/common/page-header";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "AI Investigations" };

export default function InvestigationsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Investigations"
        description="Evidence-backed hypotheses generated for your incidents."
      />
      <Card>
        <EmptyState
          icon={Sparkles}
          title="Investigations start from an incident"
          description="Open any incident and choose Investigate with AI. The analysis and its evidence appear on that incident's page."
        />
      </Card>
    </div>
  );
}
