import Link from "next/link";
import { CopyButton } from "@/components/common/copy-button";
import { StackTrace } from "@/components/incidents/stack-trace";
import type { EventDetail } from "@/lib/incidents/types";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

type Props = {
  event: EventDetail;
  /** Show the incident link (hidden on the incident's own page and in the evidence panel). */
  showIncident?: boolean;
  linkQuery?: string;
};

/** Everything stored about one event: message, ids, timestamp, attributes, stack trace. */
export function EventDetailPanel({ event, showIncident = true, linkQuery = "" }: Props) {
  const iso = new Date(event.occurredAt).toISOString();
  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-1 text-xs font-medium text-muted-foreground">Message</h3>
        <p className="text-sm break-words whitespace-pre-wrap">{event.message}</p>
      </div>

      <dl className="grid gap-3 sm:grid-cols-2">
        <Field label="Event ID">
          <span className="mr-2 font-mono text-xs break-all">{event.externalEventId}</span>
          <CopyButton value={event.externalEventId} label="Copy ID" />
        </Field>
        <Field label="Timestamp (UTC)">
          <time dateTime={event.occurredAt} className="mr-2 font-mono text-xs">
            {iso}
          </time>
          <CopyButton value={iso} label="Copy timestamp" />
        </Field>
        <Field label="Type">
          <span className="font-mono text-xs">{event.eventType}</span>
        </Field>
        <Field label="Project">{event.projectName}</Field>
        {event.endpoint ? (
          <Field label="Endpoint">
            <span className="font-mono text-xs">{event.endpoint}</span>
          </Field>
        ) : null}
        {showIncident ? (
          <Field label="Incident">
            {event.incidentId ? (
              <Link href={`/incidents/${event.incidentId}${linkQuery}`} className="underline-offset-4 hover:underline">
                {event.incidentTitle ?? "View incident"}
              </Link>
            ) : (
              <span className="text-muted-foreground">Not linked to an incident</span>
            )}
          </Field>
        ) : null}
      </dl>

      {Object.keys(event.attributes).length > 0 ? (
        <div>
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">Attributes</h3>
          <pre tabIndex={0} aria-label="Event attributes" className="max-h-64 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed">
            {JSON.stringify(event.attributes, null, 2)}
          </pre>
        </div>
      ) : null}

      <StackTrace trace={event.stackTrace} defaultOpen />
    </div>
  );
}
