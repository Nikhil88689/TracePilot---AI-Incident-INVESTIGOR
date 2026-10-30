import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AppError from "./error";

describe("(app) error boundary", () => {
  it("shows a friendly message, a reference, retry and a way out, without leaking the error message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reset = vi.fn();
    const error = Object.assign(new Error("secret@example.com row data"), { digest: "abc123" });
    render(<AppError error={error} reset={reset} />);

    expect(screen.getByRole("alert")).toHaveTextContent("This page couldn't load");
    expect(screen.getByText("Reference: abc123")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("secret@example.com");
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/dashboard");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith("[app] render error", "abc123"); // digest only
    spy.mockRestore();
  });
});
