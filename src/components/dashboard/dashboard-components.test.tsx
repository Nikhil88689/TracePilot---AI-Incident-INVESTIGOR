import { render, screen } from "@testing-library/react";
import { Activity } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import type { ErrorRatePoint } from "@/lib/dashboard/types";
import { ErrorRateChart } from "./error-rate-chart";
import { MetricCard } from "./metric-card";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const point = (hour: number, events: number, errors: number): ErrorRatePoint => ({
  time: new Date(Date.UTC(2026, 5, 1, hour)).toISOString(),
  events,
  errors,
  rate: events === 0 ? null : Math.round((errors / events) * 1000) / 10,
});

describe("ErrorRateChart", () => {
  it("summarises average and peak for assistive tech, ignoring empty buckets", () => {
    render(<ErrorRateChart range="24h" data={[point(0, 10, 0), point(1, 10, 5), point(2, 0, 0)]} />);
    const label = screen.getByRole("img").getAttribute("aria-label")!;
    expect(label).toContain("Average 25");
    expect(label).toContain("peaking at 50");
    expect(label).toContain("1 interval has no events");
  });

  it("does not crash or invent data when there are no events at all", () => {
    render(<ErrorRateChart range="1h" data={[point(0, 0, 0), point(1, 0, 0)]} />);
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "No error rate data: no events in this window.");
  });

  it("does not crash on an empty series", () => {
    render(<ErrorRateChart range="7d" data={[]} />);
    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "No error rate data: no events in this window.");
  });

  it("lists deployments in the accessible summary", () => {
    render(<ErrorRateChart range="24h" data={[point(0, 10, 1), point(1, 10, 2)]} deployments={[{ id: "d1", version: "2.14.0", deployedAt: "2026-06-01T00:30:00.000Z", description: null }]} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Deployments: 2.14.0");
  });
});

describe("MetricCard", () => {
  const props = { label: "Total events", value: "228", icon: Activity, tone: "neutral" as const, comparison: "vs previous 24 hours" };

  it("shows the change when there is one", () => {
    render(<MetricCard {...props} changePercent={58.3} />);
    expect(screen.getAllByText(/58\.3%/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/No comparison/)).not.toBeInTheDocument();
  });

  it("shows the reason instead of a made-up trend", () => {
    render(<MetricCard {...props} changePercent={null} trendNote="No comparison yet: TracePilot has no data from before the previous period." />);
    expect(screen.getByText(/no data from before the previous period/)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("falls back to a generic note, and renders detail and a drill-down link", () => {
    render(<MetricCard {...props} changePercent={null} detail="84 errors of 228 events" href="/events?since=24h" />);
    expect(screen.getByText("No comparison available.")).toBeInTheDocument();
    expect(screen.getByText("84 errors of 228 events")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /228 Total events, view the underlying list/ })).toHaveAttribute("href", "/events?since=24h");
  });
});
