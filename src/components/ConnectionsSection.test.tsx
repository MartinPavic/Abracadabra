import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppConfig, removeToken } from "../lib/api";
import { ConnectionsSection } from "./ConnectionsSection";

vi.mock("../lib/api", () => ({
  setToken: vi.fn().mockResolvedValue(undefined),
  removeToken: vi.fn().mockResolvedValue(undefined),
  testConnection: vi.fn(),
  describeError: String,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const source = { id: "s1", name: "Work GitLab", provider: "gitlab", baseUrl: "https://gl", projectFilter: null };
const config = { gitSources: [source] } as unknown as AppConfig;

describe("ConnectionsSection", () => {
  it("removing a source saves the config before removing the token", async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<ConnectionsSection config={config} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeToken).toHaveBeenCalledWith("s1"));
    expect(onChange).toHaveBeenCalledWith({ gitSources: [] });
    expect(onChange.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(removeToken).mock.invocationCallOrder[0],
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy());
  });
});
