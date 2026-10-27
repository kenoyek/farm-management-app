import { NextResponse } from "next/server";
import { ZodError } from "zod";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}
export async function jsonBody(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    fail(415, "Send JSON data.");
  const text = await request.text();
  if (Buffer.byteLength(text) > 256_000) fail(413, "Request is too large.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail(400, "Invalid JSON data.");
  }
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const expected =
    process.env.APP_ORIGIN ??
    `${url.protocol}//${request.headers.get("host") ?? url.host}`;
  if (!origin || origin !== expected)
    fail(403, "This request must come from the application.");
}
export function errorResponse(error: unknown) {
  if (error instanceof HttpError)
    return NextResponse.json(
      { error: error.message },
      { status: error.status },
    );
  if (error instanceof ZodError)
    return NextResponse.json(
      {
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      { status: 400 },
    );
  const code = (error as { code?: string }).code;
  if (code === "P0002")
    return NextResponse.json(
      { error: "The team member must create an account first." },
      { status: 400 },
    );
  if (code === "42501")
    return NextResponse.json(
      { error: "You do not have permission for this action." },
      { status: 403 },
    );
  if (code === "23505")
    return NextResponse.json(
      { error: "This record already exists." },
      { status: 409 },
    );
  if (code === "23503" || code === "23514")
    return NextResponse.json(
      { error: "The record violates a data constraint." },
      { status: 400 },
    );
  console.error("request_failed", {
    name: error instanceof Error ? error.name : "unknown",
    code,
  });
  return NextResponse.json(
    { error: "The operation could not be completed. Please try again." },
    { status: 500 },
  );
}
// Process-local rate limiting protects the development server. Production requires
// a shared edge/Redis limiter; this is explicitly tracked in deployment gates.
const attempts = new Map<string, { count: number; until: number }>();
export function rateLimit(key: string) {
  const now = Date.now();
  if (attempts.size > 2000)
    for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  const entry = attempts.get(key);
  if (entry && entry.until > now) {
    if (entry.count >= 20)
      fail(429, "Too many attempts. Try again in 15 minutes.");
    entry.count++;
  } else attempts.set(key, { count: 1, until: now + 15 * 60 * 1000 });
}
