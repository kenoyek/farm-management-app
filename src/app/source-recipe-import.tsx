"use client";
import { useState } from "react";
import { api, downloadJson } from "@/lib/client";
import type { SourceRecipePreview } from "@/lib/source-recipe-api";
import type { Ingredient } from "@/lib/feed";

export default function SourceRecipeImport({
  organizationId,
  canEdit,
  ingredients,
  onImported,
}: {
  organizationId: string;
  canEdit: boolean;
  ingredients: Ingredient[];
  onImported: () => Promise<void>;
}) {
  const [sheet, setSheet] = useState("Broiler Starter"),
    [name, setName] = useState("Imported broiler starter draft"),
    [batch, setBatch] = useState("1000");
  const [preview, setPreview] = useState<SourceRecipePreview | null>(null),
    [busy, setBusy] = useState(false),
    [ack, setAck] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [savedId, setSavedId] = useState("");
  function invalidate() {
    setPreview(null);
    setAck(false);
    setNotice("");
    setError("");
    setSavedId("");
  }
  async function inspect() {
    setBusy(true);
    setError("");
    setNotice("");
    setAck(false);
    setSavedId("");
    setPreview(null);
    try {
      setPreview(
        await api("imports/recipes/preview", {
          organizationId,
          sheet,
          name,
          batchKg: Number(batch),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ id: string; reused: boolean }>(
        "imports/recipes/confirm",
        {
          organizationId,
          sheet,
          name,
          batchKg: Number(batch),
          previewDigest: preview.previewDigest,
          confirmed: true,
          omitUnspecified: ack,
        },
      );
      setSavedId(r.id);
      setNotice(
        r.reused
          ? "This preview already has a saved draft; no duplicate was created."
          : "Source recipe saved as an immutable draft. Open Recipe library to inspect or clone it for further review.",
      );
      await onImported().catch(() =>
        setError(
          "The draft was saved. Refresh Feed studio to update the recipe list.",
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="alias-review"
      aria-label="Reviewed source recipe import"
    >
      <h3>Import a reviewed source recipe as a draft</h3>
      <p className="helper">
        Each populated allocation needs an explicit mapped alias review,
        including exact name matches. Unspecified inclusions stay unknown. No
        cached spreadsheet nutrient totals or source restrictions are applied.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice} {savedId}
        </p>
      )}
      <fieldset className="draft-editor" disabled={busy}>
        <div className="editor-settings">
          <label>
            Source recipe sheet
            <select
              aria-label="Source recipe sheet"
              value={sheet}
              onChange={(e) => {
                invalidate();
                setSheet(e.target.value);
              }}
            >
              <option>Broiler Starter</option>
              <option>Broiler Finisher</option>
            </select>
          </label>
          <label>
            Imported recipe name
            <input
              maxLength={100}
              value={name}
              onChange={(e) => {
                invalidate();
                setName(e.target.value);
              }}
            />
          </label>
          <label>
            Imported batch weight (kg)
            <input
              type="number"
              min="0.000001"
              max="100000000"
              step="any"
              value={batch}
              onChange={(e) => {
                invalidate();
                setBatch(e.target.value);
              }}
            />
          </label>
        </div>
        <div className="button-row">
          <button className="secondary" onClick={() => void inspect()}>
            Preview recipe import
          </button>
          {preview && (
            <button
              className="text-button"
              onClick={() =>
                downloadJson("source-recipe-preview.json", preview)
              }
            >
              Download source recipe preview
            </button>
          )}
        </div>
        {preview && (
          <>
            <p className="helper">
              Explicit source allocations total {preview.totalPercent}%.{" "}
              {preview.unspecifiedCount} rows have unspecified inclusions and
              will be omitted only with your acknowledgement. They are not zero.
            </p>
            <p className="source-reference">
              Source SHA-256 {preview.sourceHash}
            </p>
            {preview.blockers.length > 0 && (
              <div className="validation-issues">
                <strong>Resolve before importing</strong>
                <ul>
                  {preview.blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Source row / label</th>
                    <th>Original inclusion</th>
                    <th>Exact reviewed reference</th>
                    <th>Review</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => {
                    const value = row.fields.inclusion.parsed;
                    const mapped = ingredients.find(
                      (i) => i.id === row.alias_review?.ingredient_id,
                    );
                    return (
                      <tr key={row.id}>
                        <td>
                          {row.sheet}!{row.fields.inclusion.cell} · {row.label}
                        </td>
                        <td>
                          {value.kind === "missing"
                            ? "Unspecified; omitted"
                            : `${row.fields.inclusion.raw} %`}
                        </td>
                        <td>
                          {mapped
                            ? `${mapped.name} · v${mapped.revision ?? 1} · ${mapped.id}`
                            : (row.alias_review?.ingredient_id ??
                              "No mapped reference")}
                        </td>
                        <td>
                          {row.alias_review
                            ? `${row.alias_review.decision} · review v${row.alias_review.revision}`
                            : "Not reviewed"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {preview.calculation && (
              <div className="validation-issues">
                <strong>Draft calculation review</strong>
                <ul>
                  {preview.calculation.issues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={ack}
                disabled={!canEdit}
                onChange={(e) => setAck(e.target.checked)}
              />
              I reviewed the unspecified rows and agree to omit them without
              treating blanks as zero. This import is a draft, not nutritional
              approval.
            </label>
            <button
              className="primary"
              disabled={
                !canEdit ||
                !ack ||
                preview.blockers.length > 0 ||
                !preview.calculation ||
                !!savedId
              }
              onClick={() => void confirm()}
            >
              Import reviewed source as draft
            </button>
          </>
        )}
      </fieldset>
    </section>
  );
}
