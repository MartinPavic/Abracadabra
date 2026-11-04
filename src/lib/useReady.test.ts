import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkReady, type ReadyItem } from "./api";
import { useReady } from "./useReady";

vi.mock("./api", () => ({ checkReady: vi.fn() }));

const items = (message: string): ReadyItem[] => [{ id: "token", ok: false, blocks: "run", message }];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useReady", () => {
  it("is null without a source and does not check", () => {
    const { result } = renderHook(() => useReady(null));
    expect(result.current).toBeNull();
    expect(checkReady).not.toHaveBeenCalled();
  });

  it("returns the items and re-checks when the window regains focus", async () => {
    vi.mocked(checkReady).mockResolvedValueOnce(items("first")).mockResolvedValueOnce([]);
    const { result } = renderHook(() => useReady("s1"));
    await waitFor(() => expect(result.current).toEqual(items("first")));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(result.current).toEqual([]));
    expect(checkReady).toHaveBeenCalledTimes(2);
  });

  it("is null when the check fails", async () => {
    vi.mocked(checkReady).mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useReady("s1"));
    await waitFor(() => expect(checkReady).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it("a failed check is not repeated on window focus", async () => {
    vi.mocked(checkReady).mockRejectedValue(new Error("denied"));
    const { result } = renderHook(() => useReady("s1"));
    await waitFor(() => expect(checkReady).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(checkReady).toHaveBeenCalledTimes(1);
    expect(result.current).toBeNull();
  });

  it("a failed check does not stop the check for a new source", async () => {
    vi.mocked(checkReady).mockRejectedValueOnce(new Error("denied")).mockResolvedValue(items("s2"));
    const { result, rerender } = renderHook(({ id }) => useReady(id), { initialProps: { id: "s1" } });
    await waitFor(() => expect(checkReady).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(checkReady).toHaveBeenCalledTimes(1);
    rerender({ id: "s2" });
    await waitFor(() => expect(result.current).toEqual(items("s2")));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(checkReady).toHaveBeenCalledTimes(3);
  });

  it("a successful check is repeated on window focus", async () => {
    vi.mocked(checkReady).mockResolvedValue([]);
    renderHook(() => useReady("s1"));
    await waitFor(() => expect(checkReady).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(checkReady).toHaveBeenCalledTimes(3);
  });

  it("ignores a response for a superseded source", async () => {
    let resolveOld: (value: ReadyItem[]) => void = () => undefined;
    vi.mocked(checkReady)
      .mockReturnValueOnce(new Promise((resolve) => (resolveOld = resolve)))
      .mockResolvedValueOnce(items("new"));
    const { result, rerender } = renderHook(({ id }) => useReady(id), { initialProps: { id: "old" } });
    rerender({ id: "new" });
    await waitFor(() => expect(result.current).toEqual(items("new")));
    await act(async () => resolveOld(items("old")));
    expect(result.current).toEqual(items("new"));
  });

  it("stops listening for focus after unmount", async () => {
    vi.mocked(checkReady).mockResolvedValue([]);
    const { unmount } = renderHook(() => useReady("s1"));
    await waitFor(() => expect(checkReady).toHaveBeenCalledTimes(1));
    unmount();
    window.dispatchEvent(new Event("focus"));
    expect(checkReady).toHaveBeenCalledTimes(1);
  });
});
