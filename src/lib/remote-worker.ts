import { boundedBody, fail, HttpError } from "./http";

type Operation = "optimize" | "inspect" | "export";
const limits = {
  optimize: { input: 256 * 1024, output: 256 * 1024, timeout: 25000 },
  inspect: { input: 2 * 1024 * 1024, output: 4 * 1024 * 1024, timeout: 20000 },
  export: { input: 2 * 1024 * 1024, output: 2 * 1024 * 1024, timeout: 20000 },
};

// Returns null for the existing local Python path. Remote configuration fails
// closed: never silently fall back to an unavailable interpreter on Vercel.
export async function remoteWorker(
  operation: Operation,
  input: Buffer,
): Promise<Buffer | null> {
  const base = process.env.FARM_WORKER_URL;
  if (!base) {
    if (process.env.VERCEL)
      fail(503, "The Python worker has not been configured for this preview.");
    return null;
  }
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    fail(503, "The Python worker configuration is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail(
      503,
      "The Python worker requires an HTTPS origin without credentials or query parameters.",
    );
  const secret = process.env.FARM_WORKER_SECRET;
  if (!secret || secret.length < 32)
    fail(503, "The Python worker authentication is not configured.");
  if (input.length > limits[operation].input)
    fail(413, "Worker request is too large.");
  url.pathname = "/api/worker";
  url.searchParams.set("operation", operation);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/octet-stream",
  };
  if (process.env.FARM_WORKER_BYPASS_SECRET)
    headers["x-vercel-protection-bypass"] =
      process.env.FARM_WORKER_BYPASS_SECRET;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: new Uint8Array(input),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(limits[operation].timeout),
    });
    let bytes: Buffer;
    try {
      bytes = await boundedBody(response, limits[operation].output);
    } catch (error) {
      if (error instanceof HttpError && error.status === 413)
        fail(503, "Python worker response exceeded limits.");
      throw error;
    }
    if (!response.ok) {
      let message = "The Python worker could not complete the request.";
      // Only inspector validation errors may carry a controlled source message.
      if (operation === "inspect" && response.status === 422) {
        try {
          const error = JSON.parse(bytes.toString("utf8"));
          if (typeof error.error === "string" && error.error.length <= 400)
            message = error.error;
        } catch {}
      }
      fail(
        response.status === 429 ? 429 : response.status === 422 ? 422 : 503,
        message,
      );
    }
    const expectedType =
      operation === "export"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/json";
    if (!response.headers.get("content-type")?.startsWith(expectedType))
      fail(503, "The Python worker returned an invalid response.");
    return bytes;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    fail(
      503,
      "The Python worker is unavailable or timed out. Try again shortly.",
    );
  }
}
