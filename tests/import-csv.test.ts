import { it, expect, vi } from "vitest";
import { downloadCsv } from "../src/lib/client";
it("escapes quotes and neutralizes formula-like uploaded names in import reports", async () => {
  let blob: Blob | undefined;
  vi.stubGlobal("document", {
    createElement: () => ({ href: "", download: "", click: vi.fn() }),
  });
  vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
    blob = value as Blob;
    return "blob:fixture";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  try {
    downloadCsv("report.csv", [
      ["File", "  =1+1.xlsx"],
      ["Ingredient", "\t@SUM(1)"],
      ["Notes", 'Quoted "name", preserved'],
      ["Price", 230],
    ]);
    const csv = await blob!.text();
    expect(csv).toContain('"\'  =1+1.xlsx"');
    expect(csv).toContain('"\'\t@SUM(1)"');
    expect(csv).toContain('"Quoted ""name"", preserved"');
    expect(csv).toContain('"230"');
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
