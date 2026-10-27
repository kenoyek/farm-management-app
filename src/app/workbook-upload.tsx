"use client";
import { nutrientLabels } from "@/lib/nutrients";
import { useEffect, useState, type FormEvent } from "react";
import { api, downloadCsv, ApiError } from "@/lib/client";
import {
  importFields,
  columnName,
  type UploadMapping,
  type ImportPreview,
} from "@/lib/upload-model";
type Summary = {
  id: string;
  filename: string;
  sha256: string;
  state: "uploaded" | "previewed" | "confirmed";
  revision: number;
  created_at: string;
};
type Sheet = {
  name: string;
  rows: number;
  columns: number;
  samples: { row: number; values: Record<string, string> }[];
};
type Detail = Summary & {
  inspection: { sheets: Sheet[] };
  mapping: UploadMapping | null;
  preview: ImportPreview | null;
  suggestedMapping: UploadMapping;
  suggestedMappings: Record<string, UploadMapping>;
};
const labels: Record<(typeof importFields)[number], string> = {
  name: "Ingredient name",
  price: "Purchase price",
  ...(Object.fromEntries(
    Object.entries(nutrientLabels).map(([key, label]) => [
      key,
      label.replace(/\s+\([^)]*\)$/, ""),
    ]),
  ) as Record<keyof typeof nutrientLabels, string>),
};
export default function WorkbookUpload({
  organizationId,
  canEdit,
  onImported,
}: {
  organizationId: string;
  canEdit: boolean;
  onImported: (count: number) => Promise<void>;
}) {
  const [rowFilter, setRowFilter] = useState("all");
  const [uploads, setUploads] = useState<Summary[]>([]),
    [job, setJob] = useState<Detail | null>(null),
    [mapping, setMapping] = useState<UploadMapping | null>(null),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(0);
  useEffect(() => {
    let active = true;
    void api<Summary[]>(`workbook-uploads?organizationId=${organizationId}`)
      .then((r) => {
        if (active) setUploads(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [organizationId]);
  async function load(id: string) {
    const r = await api<Detail>(
      `workbook-uploads/${id}?organizationId=${organizationId}`,
    );
    setJob(r);
    setMapping(r.mapping ?? r.suggestedMapping);
    setPreview(r.preview);
    setRowFilter("all");
    setPage(0);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    form.set("organizationId", organizationId);
    await run(async () => {
      const r = await fetch("/api/workbook-uploads", {
        method: "POST",
        body: form,
      });
      const value = await r.json();
      if (!r.ok) throw new ApiError(r.status, value.error ?? "Upload failed.");
      await load(value.id);
      setUploads(
        await api(`workbook-uploads?organizationId=${organizationId}`),
      );
    });
  }
  function change(next: UploadMapping) {
    setMapping(next);
    setPreview(null);
    setRowFilter("all");
    setPage(0);
  }
  const sheet = job?.inspection.sheets.find((s) => s.name === mapping?.sheet);
  const previewRows =
    preview?.rows.filter(
      (r) => rowFilter === "all" || r.status === rowFilter,
    ) ?? [];
  const link = job
    ? `/api/workbook-uploads/${job.id}/download?organizationId=${organizationId}`
    : "";
  return (
    <section className="panel module-panel">
      <div className="panel-heading">
        <h2>Upload an ingredient workbook</h2>
        <span className="tag">MAP · PREVIEW · CONFIRM</span>
      </div>
      <div className="module-padding">
        <p className="muted">
          Upload an .xlsx file up to 2 MB. Select the ingredient worksheet, map
          columns and units, then review every row before importing unverified
          references. Formula cells need values supplied in the source workbook.
        </p>
        <form className="upload-form" onSubmit={(e) => void upload(e)}>
          <label>
            Ingredient workbook (.xlsx)
            <input
              name="file"
              type="file"
              accept=".xlsx"
              required
              disabled={busy || !canEdit}
            />
          </label>
          <button className="primary" disabled={busy || !canEdit}>
            {busy ? "Please wait…" : "Upload and inspect"}
          </button>
        </form>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {uploads.length > 0 && (
          <label className="field">
            Uploaded workbook history (latest 100)
            <select
              value={job?.id ?? ""}
              disabled={busy}
              onChange={(e) => {
                if (e.target.value) void run(() => load(e.target.value));
              }}
            >
              <option value="">Choose an uploaded workbook</option>
              {uploads.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.filename} · {u.state} · {u.sha256.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        )}
        {job && mapping && (
          <>
            <div className="upload-summary">
              <strong>{job.filename}</strong>
              <span className="status">{job.state}</span>
              <small>SHA-256 {job.sha256}</small>
              <a className="text-button" href={link}>
                Download original workbook
              </a>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  if (
                    !preview ||
                    window.confirm(
                      "Reload the saved mapping and preview for this workbook?",
                    )
                  )
                    void run(() => load(job.id));
                }}
              >
                Reload upload
              </button>
            </div>
            <fieldset
              className="draft-editor"
              disabled={busy || !canEdit || job.state === "confirmed"}
            >
              <div className="form-grid">
                <label>
                  Ingredient worksheet
                  <select
                    value={mapping.sheet}
                    onChange={(e) =>
                      change(job.suggestedMappings[e.target.value])
                    }
                  >
                    {job.inspection.sheets.map((s) => (
                      <option key={s.name}>{s.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  First data row
                  <input
                    type="number"
                    min="1"
                    max="5000"
                    value={mapping.firstRow}
                    onChange={(e) =>
                      change({ ...mapping, firstRow: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Last data row
                  <input
                    type="number"
                    min="1"
                    max="5000"
                    value={mapping.lastRow}
                    onChange={(e) =>
                      change({ ...mapping, lastRow: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  Concentration units
                  <select
                    value={mapping.concentrationUnit}
                    onChange={(e) =>
                      change({
                        ...mapping,
                        concentrationUnit: e.target
                          .value as UploadMapping["concentrationUnit"],
                      })
                    }
                  >
                    <option value="percent">Percent (e.g. 45 = 45%)</option>
                    <option value="g/kg">g/kg (e.g. 450 = 45%)</option>
                    <option value="fraction">Fraction (e.g. 0.45 = 45%)</option>
                  </select>
                </label>
                <label>
                  Energy units
                  <select
                    value={mapping.energyUnit}
                    onChange={(e) =>
                      change({
                        ...mapping,
                        energyUnit: e.target
                          .value as UploadMapping["energyUnit"],
                      })
                    }
                  >
                    <option value="kcal/kg">kcal/kg</option>
                    <option value="MJ/kg">MJ/kg</option>
                  </select>
                </label>
                <label>
                  Price units
                  <select
                    value={mapping.priceUnit}
                    onChange={(e) =>
                      change({
                        ...mapping,
                        priceUnit: e.target.value as UploadMapping["priceUnit"],
                      })
                    }
                  >
                    <option value="NGN/kg">NGN per kg</option>
                    <option value="NGN/bag">NGN per bag</option>
                  </select>
                </label>
                {mapping.priceUnit === "NGN/bag" && (
                  <label>
                    Bag weight (kg)
                    <input
                      type="number"
                      min="0.001"
                      step="0.001"
                      value={mapping.bagKg}
                      onChange={(e) =>
                        change({ ...mapping, bagKg: Number(e.target.value) })
                      }
                    />
                  </label>
                )}
                {importFields.map((key) => (
                  <label key={key}>
                    {labels[key]} column
                    <select
                      value={mapping.columns[key] ?? ""}
                      onChange={(e) =>
                        change({
                          ...mapping,
                          columns: {
                            ...mapping.columns,
                            [key]: e.target.value,
                          },
                        })
                      }
                    >
                      <option value="">
                        {key === "name"
                          ? "Choose a column"
                          : "Not mapped · unknown"}
                      </option>
                      {Array.from({ length: sheet?.columns ?? 0 }, (_, i) =>
                        columnName(i + 1),
                      ).map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <p className="helper">
                The concentration unit applies to all mapped concentration
                columns. Standardize mixed-unit columns before uploading. Energy
                and phosphorus bases, species, stage and inclusion restrictions
                still require nutritionist review. Bag prices convert to NGN/kg
                rounded to four decimal places.
              </p>
              <button
                className="secondary"
                onClick={() =>
                  void run(async () => {
                    const r = await api<{
                      preview: ImportPreview;
                      revision: number;
                      mapping: UploadMapping;
                    }>(
                      `workbook-uploads/${job.id}/preview?organizationId=${organizationId}`,
                      { expectedRevision: job.revision, mapping },
                    );
                    setPreview(r.preview);
                    setRowFilter("all");
                    setJob({
                      ...job,
                      state: "previewed",
                      revision: r.revision,
                      mapping: r.mapping,
                      preview: r.preview,
                    });
                    setPage(0);
                  })
                }
              >
                Preview mapped rows
              </button>
            </fieldset>
            {sheet && (
              <details className="catalog-entry">
                <summary>Worksheet sample · first 10 populated rows</summary>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Row</th>
                        {Array.from({ length: sheet.columns }, (_, i) => (
                          <th key={i}>{columnName(i + 1)}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sheet.samples.map((r) => (
                        <tr key={r.row}>
                          <td>{r.row}</td>
                          {Array.from({ length: sheet.columns }, (_, i) => (
                            <td className="source-cell" key={i}>
                              {r.values[columnName(i + 1)] ?? ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
            {preview && (
              <>
                <div className="comparison" role="status">
                  <strong>
                    {preview.validCount} valid rows · {preview.errorCount} row
                    errors · {preview.blankCount} blank rows ·{" "}
                    {preview.warningCount} review notes
                  </strong>
                  <p>
                    Rows with errors must be resolved before confirmation. Blank
                    rows are skipped; missing nutrients and prices stay unknown.
                    Existing references are never overwritten or matched by
                    ingredient name.
                  </p>
                </div>
                <div className="editor-actions">
                  <button
                    className="text-button"
                    onClick={() =>
                      downloadCsv("workbook-import-report.csv", [
                        ["File", job.filename],
                        ["SHA-256", job.sha256],
                        ["Sheet", mapping.sheet],
                        [
                          "Row",
                          "Ingredient",
                          "Status",
                          "Price NGN/kg",
                          "Review notes",
                        ],
                        ...preview.rows.map((r) => [
                          r.row,
                          r.name,
                          r.status,
                          r.price,
                          r.issues.join(" | "),
                        ]),
                      ])
                    }
                  >
                    Download import report CSV
                  </button>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !canEdit ||
                      job.state !== "previewed" ||
                      preview.errorCount > 0 ||
                      !preview.validCount
                    }
                    onClick={() =>
                      void run(async () => {
                        const r = await api<{ count: number }>(
                          `workbook-uploads/${job.id}/confirm?organizationId=${organizationId}`,
                          { expectedRevision: job.revision, confirmed: true },
                        );
                        await load(job.id);
                        setUploads(
                          await api(
                            `workbook-uploads?organizationId=${organizationId}`,
                          ),
                        );
                        await onImported(r.count);
                      })
                    }
                  >
                    {job.state === "confirmed"
                      ? "Import confirmed"
                      : `Confirm ${preview.validCount} unverified ingredient references`}
                  </button>
                </div>
                <label className="field">
                  Preview row filter
                  <select
                    value={rowFilter}
                    onChange={(e) => {
                      setRowFilter(e.target.value);
                      setPage(0);
                    }}
                  >
                    <option value="all">All rows</option>
                    <option value="error">Rows with errors</option>
                    <option value="valid">Valid rows</option>
                    <option value="blank">Blank rows</option>
                  </select>
                </label>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Source row</th>
                        <th>Ingredient</th>
                        <th>Status</th>
                        <th>NGN/kg</th>
                        <th>Protein %</th>
                        <th>Energy kcal/kg</th>
                        <th>Review notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.slice(page * 50, page * 50 + 50).map((r) => (
                        <tr key={r.row}>
                          <td>
                            {mapping.sheet}!{r.sourceCells.name ?? r.row}
                          </td>
                          <td>{r.name || "—"}</td>
                          <td>
                            <span
                              className={`status ${r.status === "valid" ? "good" : ""}`}
                            >
                              {r.status}
                            </span>
                          </td>
                          <td>{r.price ?? "Unknown"}</td>
                          <td>{r.nutrients.protein ?? "Unknown"}</td>
                          <td>{r.nutrients.energy?.toFixed(2) ?? "Unknown"}</td>
                          <td className="source-cell">{r.issues.join(" ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {previewRows.length > 50 && (
                  <div className="editor-actions">
                    <button
                      className="secondary"
                      disabled={page === 0}
                      onClick={() => setPage(page - 1)}
                    >
                      Previous rows
                    </button>
                    <span>
                      Page {page + 1} of {Math.ceil(previewRows.length / 50)}
                    </span>
                    <button
                      className="secondary"
                      disabled={(page + 1) * 50 >= previewRows.length}
                      onClick={() => setPage(page + 1)}
                    >
                      Next rows
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
