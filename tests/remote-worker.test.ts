import { afterEach, expect, it, vi } from "vitest";
import { remoteWorker } from "../src/lib/remote-worker";
import { applicationOrigin, checkOrigin } from "../src/lib/http";
const fixtureSecret = "test-only-worker-secret-0000000000000000";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("uses HTTPS and exact current-host origin checks on Vercel preview aliases", () => {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("APP_ORIGIN", undefined);
  const request = new Request("http://internal.test/api/auth/login", {
    headers: { host: "preview.example", origin: "https://preview.example" },
  });
  expect(applicationOrigin(request)).toBe("https://preview.example");
  expect(() => checkOrigin(request)).not.toThrow();
  expect(() =>
    checkOrigin(
      new Request(request.url, {
        headers: { host: "preview.example", origin: "https://other.example" },
      }),
    ),
  ).toThrow();
  vi.stubEnv("APP_ORIGIN", "https://farm.example");
  expect(applicationOrigin(request)).toBe("https://farm.example");
  expect(() => checkOrigin(request)).toThrow();
});
function configure() {
  vi.stubEnv("FARM_WORKER_URL", "https://worker.example");
  vi.stubEnv("FARM_WORKER_SECRET", fixtureSecret);
}
it("retains local workers and fails closed when a Vercel worker is absent", async () => {
  vi.stubEnv("FARM_WORKER_URL", "");
  vi.stubEnv("VERCEL", "");
  expect(await remoteWorker("optimize", Buffer.from("{}"))).toBeNull();
  vi.stubEnv("VERCEL", "1");
  await expect(
    remoteWorker("optimize", Buffer.from("{}")),
  ).rejects.toMatchObject({ status: 503 });
});
it("uses the fixed operation endpoint with authenticated binary transport and no redirects", async () => {
  configure();
  vi.stubEnv("FARM_WORKER_BYPASS_SECRET", "test-only-bypass");
  const fetch = vi.fn().mockResolvedValue(
    new Response('{"status":"optimal"}', {
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(
    (await remoteWorker("optimize", Buffer.from("payload")))!.toString(),
  ).toBe('{"status":"optimal"}');
  const [url, request] = fetch.mock.calls[0];
  expect(String(url)).toBe(
    "https://worker.example/api/worker?operation=optimize",
  );
  expect(request.redirect).toBe("error");
  expect(request.cache).toBe("no-store");
  expect(request.headers.Authorization).toBe(`Bearer ${fixtureSecret}`);
  expect(request.headers["x-vercel-protection-bypass"]).toBe(
    "test-only-bypass",
  );
  expect(Buffer.from(request.body).toString()).toBe("payload");
});
it("refuses insecure or ambiguous worker URLs and missing secrets before sending anything", async () => {
  configure();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  for (const url of [
    "http://worker.example",
    "https://user:password@worker.example",
    "https://worker.example?token=secret",
    "not-a-url",
  ]) {
    vi.stubEnv("FARM_WORKER_URL", url);
    await expect(
      remoteWorker("inspect", Buffer.from("x")),
    ).rejects.toMatchObject({ status: 503 });
  }
  vi.stubEnv("FARM_WORKER_URL", "https://worker.example");
  vi.stubEnv("FARM_WORKER_SECRET", "");
  await expect(remoteWorker("inspect", Buffer.from("x"))).rejects.toMatchObject(
    { status: 503 },
  );
  expect(fetch).not.toHaveBeenCalled();
});
it("preserves controlled inspector errors but hides service errors and HTML protection pages", async () => {
  configure();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  fetch.mockResolvedValueOnce(
    new Response('{"error":"Invalid or unsupported workbook."}', {
      status: 422,
    }),
  );
  await expect(
    remoteWorker("inspect", Buffer.from("bad")),
  ).rejects.toMatchObject({
    status: 422,
    message: "Invalid or unsupported workbook.",
  });
  fetch.mockResolvedValueOnce(
    new Response("private service trace", { status: 500 }),
  );
  await expect(
    remoteWorker("optimize", Buffer.from("{}")),
  ).rejects.toMatchObject({
    status: 503,
    message: "The Python worker could not complete the request.",
  });
  fetch.mockResolvedValueOnce(
    new Response("Login page", { headers: { "content-type": "text/html" } }),
  );
  await expect(
    remoteWorker("optimize", Buffer.from("{}")),
  ).rejects.toMatchObject({ status: 503 });
});
it("bounds inputs and streamed outputs and reports network failures without local fallback", async () => {
  configure();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    remoteWorker("optimize", Buffer.alloc(256 * 1024 + 1)),
  ).rejects.toMatchObject({ status: 413 });
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValueOnce(
    new Response(Buffer.alloc(256 * 1024 + 1), {
      headers: { "content-type": "application/json" },
    }),
  );
  await expect(
    remoteWorker("optimize", Buffer.from("{}")),
  ).rejects.toMatchObject({ status: 503 });
  fetch.mockRejectedValueOnce(new Error("network error with internal details"));
  await expect(
    remoteWorker("optimize", Buffer.from("{}")),
  ).rejects.toMatchObject({
    status: 503,
    message:
      "The Python worker is unavailable or timed out. Try again shortly.",
  });
});
