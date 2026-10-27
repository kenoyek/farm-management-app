"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { CatalogRow, SourceField } from "@/lib/workbook-catalog";
import type { Ingredient } from "@/lib/feed";
import type { AliasReview } from "@/lib/catalog-review";
import CatalogAliasReview from "./catalog-alias-review";
import SourceRecipeImport from "./source-recipe-import";
type StoredRow = CatalogRow & { id: string; alias_review?: AliasReview | null };
function normalized(field: SourceField) {
  const p = field.parsed;
  switch (p.kind) {
    case "missing":
      return "Missing";
    case "unsupported":
      return "Needs interpretation";
    case "range":
      return `${p.min}–${p.max} ${field.unit} (source range)`;
    case "scalar":
      return `${p.value} ${field.unit} (source value)`;
  }
}
export default function SourceCatalog({
  organizationId,
  canEdit,
  ingredients,
  canReview,
  onImported,
}: {
  organizationId: string;
  canEdit: boolean;
  ingredients: Ingredient[];
  canReview: boolean;
  onImported: () => Promise<void>;
}) {
  const [previewing, setPreviewing] = useState(false);
  const [rows, setRows] = useState<StoredRow[]>([]),
    [category, setCategory] = useState("requirement"),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [reviewFilter, setReviewFilter] = useState("all");
  useEffect(() => {
    let active = true;
    void api<StoredRow[]>(`imports/catalog?organizationId=${organizationId}`)
      .then((r) => {
        if (active) setRows(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [organizationId]);
  const visible = rows.filter(
    (r) =>
      r.category === category &&
      `${r.label} ${r.context}`.toLowerCase().includes(search.toLowerCase()) &&
      (category === "requirement" ||
        reviewFilter === "all" ||
        (reviewFilter === "not-reviewed"
          ? !r.alias_review
          : r.alias_review?.decision === reviewFilter)),
  );
  async function stage() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ count: number }>("imports/catalog", {
        organizationId,
        confirmed: true,
      });
      setPreviewing(false);
      setRows(await api(`imports/catalog?organizationId=${organizationId}`));
      setNotice(
        r.count
          ? `${r.count} source rows staged for review.`
          : "The source catalog is already up to date.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Source reference catalog{previewing ? " · preview" : ""}</h2>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            void api<{ catalog: CatalogRow[] }>("imports/preview")
              .then((r) => {
                setRows(
                  r.catalog.map((row, i) => ({ ...row, id: `preview-${i}` })),
                );
                setPreviewing(true);
              })
              .catch((e) => setError(e.message));
          }}
        >
          Preview source references
        </button>
        <button
          className="secondary"
          disabled={busy || !canEdit}
          onClick={() => void stage()}
        >
          Stage confirmed workbook references
        </button>
      </div>
      <p className="helper">
        Review source requirements, stage inclusion limits and broiler recipe
        mappings. Scalar requirements have no assumed minimum/maximum meaning.
        Nothing here becomes an approved specification or ingredient restriction
        automatically. Existing imports can be staged safely without
        duplication.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="editor-settings">
        <label>
          Reference category
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="requirement">Nutritional requirements</option>
            <option value="restriction">Ingredient inclusion limits</option>
            <option value="recipe">Broiler recipe mappings</option>
          </select>
        </label>
        <label>
          Search source labels
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="e.g. Layers, Salt"
          />
        </label>
        <div>
          <span className="tag">{visible.length} ROWS · UNVERIFIED</span>
        </div>
        {category !== "requirement" && (
          <label>
            Alias review status
            <select
              aria-label="Alias review status"
              value={reviewFilter}
              onChange={(e) => setReviewFilter(e.target.value)}
            >
              <option value="all">All source rows</option>
              <option value="not-reviewed">Not reviewed</option>
              <option value="mapped">Mapped</option>
              <option value="rejected">Rejected</option>
              <option value="unresolved">Unresolved</option>
            </select>
          </label>
        )}
      </div>
      {category === "recipe" && !previewing && (
        <SourceRecipeImport
          organizationId={organizationId}
          canEdit={canEdit}
          ingredients={ingredients}
          onImported={onImported}
        />
      )}
      {!rows.length ? (
        <div className="empty">
          <h3>No staged source references yet</h3>
          <p>
            Preview and confirm the supplied workbooks in Workbook import, then
            stage their source references.
          </p>
        </div>
      ) : (
        <div className="catalog-list">
          {visible.map((row) => (
            <details key={row.id} className="catalog-entry">
              <summary>
                <strong>{row.label}</strong>
                <span>{row.context}</span>
                <small>{row.issues.length} review notes</small>
                {row.category !== "requirement" && (
                  <span>
                    {row.alias_review
                      ? `${row.alias_review.decision} · v${row.alias_review.revision}`
                      : "Not reviewed"}
                  </span>
                )}
              </summary>
              <p className="helper">
                Feed Formula Calculator.xlsx · {row.sheet} · row{" "}
                {row.source_row} · SHA-256 {row.source_hash.slice(0, 16)}…
              </p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Source cell</th>
                      <th>Original value</th>
                      <th>Normalized candidate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(row.fields).map(([key, field]) => (
                      <tr key={key}>
                        <td>{key}</td>
                        <td>
                          {row.sheet}!{field.cell}
                        </td>
                        <td>
                          {field.raw === null ? "Blank" : String(field.raw)}
                        </td>
                        <td>{normalized(field)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="validation-issues">
                <ul>
                  {row.issues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              </div>
              {!previewing && row.category !== "requirement" && (
                <CatalogAliasReview
                  organizationId={organizationId}
                  row={row}
                  ingredients={ingredients}
                  canReview={canReview}
                  onSaved={(review) =>
                    setRows((current) =>
                      current.map((r) =>
                        r.id === row.id ? { ...r, alias_review: review } : r,
                      ),
                    )
                  }
                />
              )}
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
