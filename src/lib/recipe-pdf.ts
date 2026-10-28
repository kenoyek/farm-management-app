import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldTask } from "node:timers/promises";
import {
  PDFDocument,
  PDFName,
  PDFHexString,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { fail } from "./http";
import {
  recipeSheets,
  type RecipeReport,
  type ReportCell,
} from "./recipe-reports";

export const pdfLimits = {
  bytes: 2 * 1024 * 1024,
  pages: 128,
  cells: 20000,
  characters: 500000,
  milliseconds: 10000,
};
let generating = 0;
let fonts: Promise<Buffer[]> | undefined;
const fontBytes = () =>
  (fonts ??= Promise.all(
    ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "LICENSE.txt"].map((name) =>
      readFile(join(process.cwd(), "assets/fonts", name)),
    ),
  ).catch((error) => {
    fonts = undefined;
    throw error;
  }));
const green = rgb(0.09, 0.25, 0.21),
  red = rgb(0.65, 0.13, 0.12),
  ink = rgb(0.12, 0.16, 0.15),
  muted = rgb(0.35, 0.4, 0.38),
  pale = rgb(0.94, 0.96, 0.95);
const width = 841.89,
  height = 595.28,
  margin = 32,
  inner = width - 2 * margin,
  bottom = 44,
  top = height - 100;

// Text is drawn as text only: no HTML, links, JavaScript or external resources.
// Missing glyphs and invisible controls stay explicit instead of disappearing.
const characterSets = new WeakMap<object, Set<number>>();
export function pdfLiteral(
  value: ReportCell,
  font: Pick<PDFFont, "getCharacterSet">,
) {
  let supported = characterSets.get(font);
  if (!supported) {
    supported = new Set(font.getCharacterSet());
    characterSets.set(font, supported);
  }
  return Array.from(
    value === null ? "Unknown" : String(value).replace(/\r\n?/g, "\n"),
  )
    .map((c) => {
      const n = c.codePointAt(0)!;
      if (c === "\n") return c;
      if (n < 32 || n === 127 || /\p{Cf}/u.test(c) || !supported.has(n))
        return `[U+${n.toString(16).toUpperCase().padStart(4, "0")}]`;
      return c;
    })
    .join("");
}
export async function recipePdf(
  report: RecipeReport,
  organizationId: string,
  digest: string,
): Promise<Uint8Array> {
  const sheets = recipeSheets(report, organizationId, digest);
  const cells = sheets.flatMap((s) => s.rows.flat());
  if (
    cells.length > pdfLimits.cells ||
    Buffer.byteLength(JSON.stringify(sheets)) > pdfLimits.bytes ||
    cells.reduce<number>((n, c) => n + String(c ?? "").length, 0) >
      pdfLimits.characters
  )
    fail(
      422,
      "This PDF exceeds report limits. Use CSV or Excel for the complete evidence.",
    );
  if (generating >= 2) fail(429, "PDF generation is busy. Try again shortly.");
  generating++;
  const started = Date.now();
  try {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const bytes = await fontBytes();
    const regular = await doc.embedFont(bytes[0], { subset: true }),
      bold = await doc.embedFont(bytes[1], { subset: true });
    doc.setTitle("Farmstead saved mixing sheet");
    doc.setAuthor("Farmstead");
    doc.setCreator("Farmstead PDF report model 1");
    doc.setProducer("Farmstead / pdf-lib");
    doc.setSubject(`Saved version ${report.id}; snapshot SHA-256 ${digest}`);
    doc.catalog.set(
      PDFName.of("FarmsteadFontLicense"),
      PDFHexString.fromText(bytes[2].toString("utf8")),
    );
    const date = new Date(report.createdAt);
    doc.setCreationDate(date);
    doc.setModificationDate(date);
    let page: PDFPage,
      y = top,
      section = "Mixing sheet",
      continuation = "";
    const safe = (v: ReportCell, font = regular) => pdfLiteral(v, font);
    const check = () => {
      if (Date.now() - started > pdfLimits.milliseconds)
        fail(
          503,
          "PDF generation exceeded its time limit. Use CSV or Excel, or try again.",
        );
    };
    function newPage() {
      check();
      if (doc.getPageCount() >= pdfLimits.pages)
        fail(
          422,
          "This PDF exceeds 128 pages. Use CSV or Excel for the complete evidence.",
        );
      page = doc.addPage([width, height]);
      y = top;
      page.drawText("FARMSTEAD  /  SAVED MIXING SHEET", {
        x: margin,
        y: height - 32,
        size: 13,
        font: bold,
        color: green,
      });
      page.drawText(
        report.status === "approved"
          ? "APPROVED SAVED VERSION — HISTORICAL REVIEW ONLY"
          : `${report.status.toUpperCase()} — NOT APPROVED`,
        {
          x: margin,
          y: height - 51,
          size: 11,
          font: bold,
          color: report.status === "approved" ? green : red,
        },
      );
      page.drawText(
        "No current stock reservation or manufacturing release. Use the original saved batch and review evidence.",
        { x: margin, y: height - 66, size: 8, font: regular, color: ink },
      );
      page.drawText(
        `Version ${report.id}  /  ${section}${continuation ? " / " + continuation : ""}`,
        {
          x: margin,
          y: height - 81,
          size: 8,
          font: regular,
          color: muted,
        },
      );
    }
    const widthCache = new Map<string, number>();
    function wrap(text: string, maxWidth: number, font: PDFFont, size: number) {
      const lines: string[] = [];
      for (const paragraph of text.split("\n")) {
        let line = "",
          space = -1,
          w = 0;
        for (const c of paragraph) {
          const key = `${font.name}:${size}:${c}`;
          let cw = widthCache.get(key);
          if (cw === undefined) {
            cw = font.widthOfTextAtSize(c, size);
            widthCache.set(key, cw);
          }
          if (line && w + cw > maxWidth) {
            const split = space > 0 ? space : line.length;
            lines.push(line.slice(0, split));
            line = line.slice(split).replace(/^ /, "");
            w = font.widthOfTextAtSize(line, size);
            space = line.lastIndexOf(" ");
          }
          line += c;
          w += cw;
          if (c === " ") space = line.length - 1;
        }
        lines.push(line);
      }
      // Guard against contextual font advances exceeding the character estimate.
      return lines.flatMap((line) => {
        const out: string[] = [];
        while (line && font.widthOfTextAtSize(line, size) > maxWidth) {
          let n = Array.from(line).length - 1;
          const chars = Array.from(line);
          while (
            n > 1 &&
            font.widthOfTextAtSize(chars.slice(0, n).join(""), size) > maxWidth
          )
            n--;
          out.push(chars.slice(0, n).join(""));
          line = chars.slice(n).join("");
        }
        out.push(line);
        return out;
      });
    }
    function heading(title: string) {
      if (y < bottom + 90) newPage();
      page.drawText(safe(title, bold), {
        x: margin,
        y: y - 14,
        size: 12,
        font: bold,
        color: green,
      });
      y -= 25;
    }
    async function table(
      headers: string[],
      rows: ReportCell[][],
      weights: number[],
      size = 8.5,
    ) {
      const widths = weights.map(
          (w) => (w / weights.reduce((a, b) => a + b, 0)) * inner,
        ),
        leading = size + 3;
      const headerLines = headers.map((s, i) =>
        wrap(safe(s, bold), widths[i] - 12, bold, size),
      );
      const headerHeight =
        Math.max(...headerLines.map((a) => a.length)) * leading + 12;
      function draw(
        lines: string[][],
        offset: number,
        count: number,
        header: boolean,
      ) {
        const rowHeight = count * leading + 10;
        let x = margin;
        if (header)
          page.drawRectangle({
            x,
            y: y - rowHeight,
            width: inner,
            height: rowHeight,
            color: green,
          });
        else
          page.drawRectangle({
            x,
            y: y - rowHeight,
            width: inner,
            height: rowHeight,
            color: pale,
          });
        for (let i = 0; i < lines.length; i++) {
          for (let j = 0; j < count; j++) {
            const text = lines[i][offset + j];
            if (text)
              page.drawText(text, {
                x: x + 6,
                y: y - 7 - size - j * leading,
                size,
                font: header ? bold : regular,
                color: header ? rgb(1, 1, 1) : ink,
              });
          }
          x += widths[i];
        }
        y -= rowHeight + 1;
      }
      function header() {
        if (y < bottom + headerHeight + leading + 12) newPage();
        draw(
          headerLines,
          0,
          Math.max(...headerLines.map((a) => a.length)),
          true,
        );
      }
      header();
      for (const row of rows) {
        check();
        await yieldTask();
        const lines = headers.map((_, i) =>
          wrap(safe(row[i] ?? null), widths[i] - 12, regular, size),
        );
        const total = Math.max(...lines.map((a) => a.length));
        let offset = 0;
        if (
          total * leading + 11 <= top - bottom - headerHeight &&
          y - total * leading - 11 < bottom
        ) {
          newPage();
          header();
        }
        while (offset < total) {
          const count = Math.min(
            total - offset,
            Math.floor((y - bottom - 11) / leading),
          );
          if (count < 1) {
            newPage();
            header();
            continue;
          }
          draw(lines, offset, count, false);
          offset += count;
          if (offset < total) {
            newPage();
            header();
          }
        }
      }
      y -= 10;
    }
    async function record(
      title: string,
      labels: ReportCell[],
      values: ReportCell[],
    ) {
      continuation = title;
      heading(title);
      const rows: ReportCell[][] = [];
      for (let i = 0; i < labels.length; i += 2)
        rows.push([
          labels[i],
          values[i] ?? null,
          labels[i + 1] ?? "",
          i + 1 < labels.length ? (values[i + 1] ?? null) : "",
        ]);
      await table(
        ["Field", "Saved value", "Field", "Saved value"],
        rows,
        [125, 264, 125, 264],
      );
      continuation = "";
    }
    newPage();
    heading("Original saved batch quantities");
    const mixing = sheets[0];
    const metadata = mixing.rows.slice(1, 14).map((row) => [...row]);
    metadata[6][1] = report.batchKg;
    metadata[12][1] =
      "Saved values only. No current price conversion, stock issue or manufacturing release. Money retains saved decimal precision; missing values are labeled Unknown.";
    await table(
      [
        "Recipe",
        "Original batch kg",
        "Total inclusion %",
        "Saved NGN/kg",
        "Saved batch NGN",
      ],
      [
        [
          report.name,
          report.batchKg,
          report.totalPercent,
          report.costPerKg,
          report.batchCost,
        ],
      ],
      [300, 120, 100, 129, 129],
      9,
    );
    heading("Ingredient quantities");
    await table(
      [
        "Ingredient",
        "Reference UUID",
        "Rev.",
        "Inclusion %",
        "Batch kg",
        "NGN/kg",
        "Min %",
        "Max %",
        "Available kg",
      ],
      report.allocations.map((l, i) => {
        const r = [...mixing.rows[16 + i]];
        r[4] = l.kg;
        return r;
      }),
      [170, 178, 40, 65, 80, 72, 50, 50, 73],
    );
    if (report.issues.length) {
      heading("Saved review issues");
      await table(
        ["Issue recorded at save"],
        report.issues.map((s) => [s]),
        [1],
      );
    }
    heading("Reading this report");
    await table(
      ["Convention", "Meaning"],
      [
        [
          "Unknown",
          "A value was absent in the saved evidence. Unknown is not zero. No incomplete percentages are normalized.",
        ],
        [
          "Literal text",
          "User evidence is printed as text. Unsupported glyphs and invisible controls use explicit [U+XXXX] notation.",
        ],
        [
          "Traceability",
          "The snapshot SHA-256 identifies the same normalized saved evidence as CSV and Excel. PDF report model 1.",
        ],
      ],
      [190, 588],
    );
    newPage();
    heading("Saved snapshot details");
    await table(["Field", "Saved value"], metadata, [190, 588], 9);
    for (const sheet of sheets.slice(1)) {
      section = sheet.name;
      newPage();
      heading(sheet.name);
      if (sheet.name === "Nutrients")
        await table(
          sheet.rows[0] as string[],
          sheet.rows.slice(1),
          [245, 133, 133, 133, 134],
          9,
        );
      else if (sheet.name === "Reference audit") {
        for (let i = 1; i < sheet.rows.length; i++)
          await record(
            `Ingredient reference ${i}`,
            sheet.rows[0],
            sheet.rows[i],
          );
      } else if (sheet.name === "Specification") {
        await table(
          ["Specification field", "Saved reference"],
          sheet.rows.slice(1, 12),
          [190, 588],
        );
        const groupIndex = sheet.rows.findIndex(
          (r) => r[0] === "Processing group",
        );
        const rules = sheet.rows
          .slice(14, groupIndex < 0 ? undefined : groupIndex - 1)
          .filter((r) => r.length);
        for (let i = 0; i < rules.length; i++)
          await record(
            `Reviewed allowed reference ${i + 1}`,
            sheet.rows[13],
            rules[i],
          );
        if (groupIndex >= 0)
          for (const row of sheet.rows.slice(groupIndex + 1))
            await record(
              "Reviewed processing group",
              sheet.rows[groupIndex],
              row,
            );
      } else if (sheet.name === "Source recipe audit") {
        await table(
          ["Source evidence", "Saved value"],
          sheet.rows.slice(0, 4),
          [190, 588],
        );
        for (let i = 6; i < sheet.rows.length; i++)
          await record(
            `Original source row ${i - 5}`,
            sheet.rows[5],
            sheet.rows[i],
          );
      }
    }
    const pages = doc.getPages();
    pages.forEach((p, i) => {
      p.drawLine({
        start: { x: margin, y: 34 },
        end: { x: width - margin, y: 34 },
        thickness: 0.5,
        color: muted,
      });
      p.drawText(
        `Saved version ${report.id}  |  Page ${i + 1} of ${pages.length}`,
        { x: margin, y: 22, size: 8, font: regular, color: muted },
      );
      p.drawText(`Snapshot SHA-256: ${digest}`, {
        x: margin,
        y: 10,
        size: 8,
        font: regular,
        color: muted,
      });
    });
    check();
    const output = await doc.save();
    check();
    if (output.length > pdfLimits.bytes)
      fail(
        422,
        "This PDF exceeds 2 MiB. Use CSV or Excel for the complete evidence.",
      );
    return output;
  } finally {
    generating--;
  }
}
