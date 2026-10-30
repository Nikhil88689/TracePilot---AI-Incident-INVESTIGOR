import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/actions", () => ({
  signIn: vi.fn(),
  signUp: vi.fn(),
  requestPasswordReset: vi.fn(),
  updatePassword: vi.fn(),
}));

import { ForgotPasswordForm } from "./forgot-password-form";
import { LoginForm } from "./login-form";
import { SignupForm } from "./signup-form";

describe("LoginForm", () => {
  it("renders labelled fields, a reset link, and a full-width submit", () => {
    render(<LoginForm />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveAttribute("href", "/forgot-password");
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveClass("w-full");
  });

  it("toggles password visibility with an accessible control", async () => {
    render(<LoginForm />);
    const toggle = screen.getByRole("button", { name: "Show password" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows a notice passed in from the URL", () => {
    render(<LoginForm notice={{ status: "success", message: "Password updated." }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Password updated.");
  });

  it("carries the safe next path in a hidden field", () => {
    const { container } = render(<LoginForm next="/incidents" />);
    expect(container.querySelector('input[name="next"]')).toHaveValue("/incidents");
  });
});

describe("SignupForm", () => {
  it("shows password requirements and updates them as the user types", async () => {
    render(<SignupForm />);
    const list = screen.getByRole("list", { name: "Password requirements" });
    expect(list).toHaveTextContent("At least 8 characters (not met)");

    await userEvent.type(screen.getByLabelText("Password"), "abcdefg1");
    expect(list).toHaveTextContent("At least 8 characters (met)");
    expect(list).toHaveTextContent("At least one number (met)");
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription(/At least 8 characters/);
  });

  it("collects full name, email and password, and links to terms and privacy", () => {
    render(<SignupForm />);
    expect(screen.getByLabelText("Full name")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Privacy notice" })).toHaveAttribute("href", "/privacy");
  });
});

describe("ForgotPasswordForm", () => {
  it("asks only for an email", () => {
    render(<ForgotPasswordForm />);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeInTheDocument();
  });
});
