import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { DraftController, EMPTY_DRAFT } from "../src/lib/draft-controller";
import type { DraftContent, SavedDraft } from "../src/lib/draft-schema";
function fixture() {
  let server: SavedDraft | null = null;
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
  const read = vi.fn(async () => ({
    actorId: "actor-a",
    draft: structuredClone(server),
  }));
  const write = vi.fn(async (revision: number, content: DraftContent) => {
    if (revision !== (server?.revision ?? 0))
      throw Object.assign(new Error("conflict"), { status: 409 });
    server = {
      id: "draft",
      revision: revision + 1,
      content: structuredClone(content),
      updated_at: new Date().toISOString(),
    };
    return structuredClone(server);
  });
  const restore = vi.fn();
  const deps = {
    organizationId: "org-a",
    read,
    write,
    storage: () => storage,
    restore,
    delay: 50,
  };
  return {
    controller: new DraftController(deps),
    deps,
    map,
    server: () => server,
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
it("does not create an empty draft and debounces edits to the latest content", async () => {
  const f = fixture();
  await f.controller.load();
  expect(f.deps.write).not.toHaveBeenCalled();
  f.controller.update({ ...EMPTY_DRAFT, name: "First" });
  f.controller.update({ ...EMPTY_DRAFT, name: "Latest" });
  await vi.advanceTimersByTimeAsync(60);
  expect(f.deps.write).toHaveBeenCalledTimes(1);
  expect(f.server()?.content.name).toBe("Latest");
  expect(f.controller.snapshot().dirty).toBe(false);
  expect(f.map.size).toBe(0);
});
it("serializes in-flight saves and saves edits made while an earlier request is pending", async () => {
  const f = fixture();
  await f.controller.load();
  const original = f.deps.write.getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  f.deps.write.mockImplementationOnce(async (...args) => {
    await gate;
    return original(...args);
  });
  f.controller.update({ ...EMPTY_DRAFT, name: "First" });
  const pending = f.controller.flush();
  await Promise.resolve();
  f.controller.update({ ...EMPTY_DRAFT, name: "Second" });
  await vi.advanceTimersByTimeAsync(60);
  expect(f.deps.write).toHaveBeenCalledTimes(1);
  release();
  await pending;
  await vi.advanceTimersByTimeAsync(60);
  expect(f.server()?.content.name).toBe("Second");
  expect(f.server()?.revision).toBe(2);
  expect(f.controller.snapshot().dirty).toBe(false);
});
it("recovers unsaved edits after a network failure and a new component mount", async () => {
  const f = fixture();
  await f.controller.load();
  f.deps.write.mockRejectedValueOnce(new Error("offline"));
  f.controller.update({ ...EMPTY_DRAFT, name: "Recovered", batchKg: -5 });
  await f.controller.flush();
  expect(f.controller.snapshot().error).toMatch(/not saved/);
  const recovered = new DraftController(f.deps);
  await recovered.load();
  expect(f.deps.restore).toHaveBeenLastCalledWith({
    ...EMPTY_DRAFT,
    name: "Recovered",
    batchKg: -5,
  });
  await recovered.flush();
  expect(f.server()?.content.name).toBe("Recovered");
  expect(f.map.size).toBe(0);
});
it("detects conflicts and keeps the original recovery revision across repeated reloads", async () => {
  const f = fixture();
  const otherMap = new Map<string, string>();
  const otherStorage = {
    getItem: (k: string) => otherMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      otherMap.set(k, v);
    },
    removeItem: (k: string) => {
      otherMap.delete(k);
    },
  };
  const otherDeps = { ...f.deps, storage: () => otherStorage };
  const other = new DraftController(otherDeps);
  await f.controller.load();
  await other.load();
  f.controller.update({ ...EMPTY_DRAFT, name: "Server version" });
  await f.controller.flush();
  other.update({ ...EMPTY_DRAFT, name: "Unsaved local version" });
  await other.flush();
  expect(other.snapshot().conflict).toBe(true);
  for (let i = 0; i < 2; i++) {
    const recovered = new DraftController(otherDeps);
    await recovered.load();
    expect(recovered.snapshot().conflict).toBe(true);
    expect(recovered.current().name).toBe("Unsaved local version");
    expect(JSON.parse([...otherMap.values()][0]).revision).toBe(0);
  }
  expect(f.server()?.content.name).toBe("Server version");
  await other.load(true);
  expect(other.current().name).toBe("Server version");
  expect(otherMap.size).toBe(0);
  expect(other.snapshot().conflict).toBe(false);
});
it("recognizes a lost successful response without overwriting or creating a new server revision", async () => {
  const f = fixture();
  await f.controller.load();
  const original = f.deps.write.getMockImplementation()!;
  f.deps.write.mockImplementationOnce(async (...args) => {
    await original(...args);
    throw new Error("response lost");
  });
  f.controller.update({ ...EMPTY_DRAFT, name: "Already saved" });
  await f.controller.flush();
  expect(f.controller.snapshot().dirty).toBe(true);
  await f.controller.flush();
  expect(f.server()?.revision).toBe(1);
  expect(f.controller.snapshot()).toMatchObject({
    dirty: false,
    error: "",
    conflict: false,
  });
});
it("does not restore another account’s recovery data", async () => {
  const f = fixture();
  await f.controller.load();
  f.controller.update({ ...EMPTY_DRAFT, name: "Private account A" });
  const restore = vi.fn();
  const other = new DraftController({
    ...f.deps,
    restore,
    read: async () => ({ actorId: "actor-b", draft: null }),
  });
  await other.load();
  expect(restore).toHaveBeenCalledWith(EMPTY_DRAFT);
  expect(other.snapshot().dirty).toBe(false);
});
it("continues server autosave if browser recovery storage is unavailable", async () => {
  const f = fixture();
  const controller = new DraftController({
    ...f.deps,
    storage: () => {
      throw new Error("storage disabled");
    },
  });
  await controller.load();
  controller.update({ ...EMPTY_DRAFT, name: "Server only" });
  await controller.flush();
  expect(f.server()?.content.name).toBe("Server only");
  expect(controller.snapshot().warning).toMatch(/recovery is unavailable/);
});
it("ignores an old load after disposal and flushes pending edits on navigation", async () => {
  const f = fixture();
  let finish!: () => void;
  f.deps.read.mockImplementationOnce(async () => {
    await new Promise<void>((r) => (finish = r));
    return { actorId: "actor-a", draft: null };
  });
  const pending = f.controller.load();
  f.controller.dispose();
  await f.controller.load();
  finish();
  await pending;
  expect(f.deps.restore).toHaveBeenCalledTimes(1);
  f.controller.update({ ...EMPTY_DRAFT, name: "Saved on navigation" });
  f.controller.dispose();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.server()?.content.name).toBe("Saved on navigation");
});
it("stops acknowledgement recovery if the signed-in account changes", async () => {
  const f = fixture();
  await f.controller.load();
  f.controller.update({ ...EMPTY_DRAFT, name: "Account A content" });
  f.deps.write.mockRejectedValueOnce(
    Object.assign(new Error("conflict"), { status: 409 }),
  );
  f.deps.read.mockResolvedValueOnce({ actorId: "account-b", draft: null });
  await f.controller.flush();
  expect(f.controller.snapshot().error).toMatch(/signed-in account changed/);
  expect(f.controller.snapshot().dirty).toBe(true);
  expect(f.map.size).toBe(1);
});
it("preserves a large but finite numeric editing state without applying recipe validation", async () => {
  const f = fixture();
  await f.controller.load();
  f.controller.update({ ...EMPTY_DRAFT, batchKg: 1e100 });
  await f.controller.flush();
  expect(f.server()?.content.batchKg).toBe(1e100);
  expect(f.controller.snapshot().error).toBe("");
});
