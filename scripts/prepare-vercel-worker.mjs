import { mkdir, cp, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
const output = resolve(".local/vercel-worker");
await mkdir(output, { recursive: true, mode: 0o700 });
await cp("deployment/python-worker", output, { recursive: true });
await mkdir(resolve(output, "workers"), { recursive: true });
for (const script of ["optimize.py", "inspect_upload.py", "export_recipe.py"])
  await copyFile(
    resolve("scripts", script),
    resolve(output, "workers", script),
  );
console.log(
  "Prepared .local/vercel-worker from the current, unchanged Python workers.",
);
