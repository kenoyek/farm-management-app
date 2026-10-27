export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  body?: unknown,
  options?: { keepalive?: boolean },
): Promise<T> {
  const r = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    keepalive: options?.keepalive,
  });
  const value = await r.json();
  if (!r.ok)
    throw new ApiError(r.status, value.error ?? "Something went wrong.");
  return value as T;
}
export function downloadCsv(name: string, rows: (string | number | null)[][]) {
  const csv = rows
    .map((row) =>
      row
        .map((value) => {
          let s = value === null ? "" : String(value);
          if (/^(?:\s*[=+\-@]|[\t\r\n])/.test(s)) s = "'" + s;
          return '"' + s.replaceAll('"', '""') + '"';
        })
        .join(","),
    )
    .join("\r\n");
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8;" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
