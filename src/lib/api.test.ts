import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api, errorText, type SceneInspection } from "./api";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
}));

const invokeMock = vi.mocked(invoke);

const inspection: SceneInspection = {
  validation: { status: "valid" },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("errorText", () => {
  it("includes the Responses API error body for actionable HTTP failures", () => {
    expect(
      errorText({
        kind: "llm",
        message: "LLM endpoint returned HTTP 400",
        status: 400,
        body_excerpt: '{"error":{"message":"tools[0].strict is unsupported"}}',
      }),
    ).toBe(
      'LLM endpoint returned HTTP 400\n{"error":{"message":"tools[0].strict is unsupported"}}',
    );
  });
});

describe("api.inspectScene", () => {
  it("shares only identical concurrent requests", async () => {
    const firstRequest = deferred<SceneInspection>();
    const secondRequest = deferred<SceneInspection>();
    const thirdRequest = deferred<SceneInspection>();
    invokeMock
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise)
      .mockReturnValueOnce(thirdRequest.promise);

    const first = api.inspectScene("/project/a", "bc.yaml", 0);
    const duplicate = api.inspectScene("/project/a", "bc.yaml", 0);
    const differentTuple = api.inspectScene("/project/ab", "c.yaml", 0);
    const differentPath = api.inspectScene("/project/a", "other.yaml", 0);

    expect(duplicate).toBe(first);
    expect(differentTuple).not.toBe(first);
    expect(differentPath).not.toBe(first);
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "inspect_scene", {
      root: "/project/a",
      relPath: "bc.yaml",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "inspect_scene", {
      root: "/project/ab",
      relPath: "c.yaml",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "inspect_scene", {
      root: "/project/a",
      relPath: "other.yaml",
    });

    firstRequest.resolve(inspection);
    secondRequest.resolve(inspection);
    thirdRequest.resolve(inspection);
    await Promise.all([first, duplicate, differentTuple, differentPath]);
  });

  it("does not reuse an older in-flight project revision", async () => {
    const oldRequest = deferred<SceneInspection>();
    const newRequest = deferred<SceneInspection>();
    invokeMock.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);

    const oldRevision = api.inspectScene("/project/live", "scene.yaml", 7);
    const newRevision = api.inspectScene("/project/live", "scene.yaml", 8);

    expect(newRevision).not.toBe(oldRevision);
    expect(invokeMock).toHaveBeenCalledTimes(2);

    oldRequest.resolve({ ...inspection, parse_error: "old" });
    newRequest.resolve({ ...inspection, parse_error: null });
    await expect(oldRevision).resolves.toMatchObject({ parse_error: "old" });
    await expect(newRevision).resolves.toMatchObject({ parse_error: null });
  });

  it("invokes again after a request fulfills", async () => {
    invokeMock.mockResolvedValue(inspection);

    const first = api.inspectScene("/project/fulfilled", "scene.yaml", 0);
    await expect(first).resolves.toBe(inspection);
    const second = api.inspectScene("/project/fulfilled", "scene.yaml", 0);

    expect(second).not.toBe(first);
    await expect(second).resolves.toBe(inspection);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("invokes again after a request rejects", async () => {
    const failure = new Error("inspection failed");
    invokeMock.mockRejectedValueOnce(failure).mockResolvedValueOnce(inspection);

    await expect(api.inspectScene("/project/rejected", "scene.yaml", 0)).rejects.toBe(failure);
    await expect(api.inspectScene("/project/rejected", "scene.yaml", 0)).resolves.toBe(inspection);

    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
