"use client";
import { useState, type FormEvent } from "react";
import { api, downloadJson } from "@/lib/client";
import type { AliasReview } from "@/lib/catalog-review";
import type { Ingredient } from "@/lib/feed";
import type { CatalogRow } from "@/lib/workbook-catalog";

type StoredRow = CatalogRow & { id: string; alias_review?: AliasReview | null };
const referenceLabel = (i: Ingredient) =>
  `${i.name} · v${i.revision ?? 1} · ${i.id} · ${i.review_status}`;

export default function CatalogAliasReview({
  organizationId,
  row,
  ingredients,
  canReview,
  onSaved,
}: {
  organizationId: string;
  row: StoredRow;
  ingredients: Ingredient[];
  canReview: boolean;
  onSaved: (review: AliasReview | null) => void;
}) {
  const [history, setHistory] = useState<AliasReview[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [decision, setDecision] =
    useState<AliasReview["decision"]>("unresolved");
  const [ingredientId, setIngredientId] = useState("");
  const [evidence, setEvidence] = useState("");
  const [revision, setRevision] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  const current = row.alias_review;
  const target = ingredients.find((i) => i.id === current?.ingredient_id);
  const endpoint = `imports/catalog/${row.id}/reviews`;
  async function load(edit: boolean) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await api<{ reviews: AliasReview[] }>(
        `${endpoint}?organizationId=${organizationId}`,
      );
      setHistory(data.reviews);
      const latest = data.reviews[0] ?? null;
      onSaved(latest);
      if (edit) {
        setDecision(latest?.decision ?? "unresolved");
        setIngredientId(latest?.ingredient_id ?? "");
        setEvidence(latest?.evidence ?? "");
        setRevision(latest?.revision ?? 0);
        setConfirmed(false);
        setConflict(false);
        setEditing(true);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await api<AliasReview>(endpoint, {
        organizationId,
        expectedRevision: revision,
        decision,
        ingredientId: decision === "mapped" ? ingredientId : null,
        evidence,
        confirmed,
      });
      onSaved(saved);
      setHistory([saved, ...(history ?? [])].slice(0, 100));
      setEditing(false);
      setConfirmed(false);
      setNotice(
        "Alias decision saved. Scientific approval and saved recipes are unchanged.",
      );
    } catch (e) {
      if ((e as { status?: number }).status === 409) setConflict(true);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="alias-review"
      aria-label={`Alias review for ${row.label}`}
    >
      <h3>Ingredient identity review</h3>
      <p className="helper">
        {current
          ? `${current.decision} · review v${current.revision}`
          : "Not reviewed"}
        {target && (
          <>
            {" "}
            · {referenceLabel(target)}
            {ingredients.some((i) => i.parent_id === target.id)
              ? " · historical reference; replacement needs a new review"
              : ""}
          </>
        )}
      </p>
      <p className="helper">
        This decision applies only to this source row and context. It does not
        approve nutrient values, apply inclusion limits, or change a recipe.
        Ingredient revisions need an explicit new mapping review.
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
      <div className="button-row">
        <button
          className="secondary"
          disabled={busy || editing}
          onClick={() => void load(false)}
        >
          View review history
        </button>
        {canReview && !editing && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void load(true)}
          >
            Review mapping
          </button>
        )}
        {history && (
          <button
            className="text-button"
            disabled={busy || editing}
            onClick={() =>
              downloadJson(`source-alias-${row.id}.json`, {
                modelVersion: 1,
                organizationId,
                source: row,
                reviews: history,
                historyLimit: 100,
                notice:
                  "Identity reconciliation only; not scientific approval or manufacturing authorization.",
              })
            }
          >
            Download review evidence
          </button>
        )}
      </div>
      {!canReview && (
        <p className="helper">
          An assigned nutritionist can record or revise a decision.
        </p>
      )}
      {editing && (
        <form onSubmit={save} aria-label={`Review mapping for ${row.label}`}>
          <fieldset className="draft-editor" disabled={busy}>
            <div className="editor-settings">
              <label>
                Alias decision
                <select
                  aria-label="Alias decision"
                  value={decision}
                  onChange={(e) => {
                    setDecision(e.target.value as AliasReview["decision"]);
                    setIngredientId("");
                    setConfirmed(false);
                  }}
                >
                  <option value="unresolved">
                    Unresolved — more evidence needed
                  </option>
                  <option value="mapped">
                    Map to an exact ingredient reference
                  </option>
                  <option value="rejected">Reject this source mapping</option>
                </select>
              </label>
              {decision === "mapped" && (
                <label>
                  Exact ingredient reference
                  <select
                    aria-label="Exact ingredient reference"
                    required
                    value={ingredientId}
                    onChange={(e) => {
                      setIngredientId(e.target.value);
                      setConfirmed(false);
                    }}
                  >
                    <option value="">
                      Select a reference; no automatic name matching
                    </option>
                    {ingredients.map((i) => (
                      <option key={i.id} value={i.id}>
                        {referenceLabel(i)}
                        {ingredients.some((next) => next.parent_id === i.id)
                          ? " · historical"
                          : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <label>
              Identity review evidence
              <textarea
                aria-label="Identity review evidence"
                required
                minLength={10}
                maxLength={2000}
                value={evidence}
                onChange={(e) => {
                  setEvidence(e.target.value);
                  setConfirmed(false);
                }}
                placeholder="Record product/source identity evidence, or explain why the match is rejected or unresolved."
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                required
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I reviewed this source label and evidence. This is not nutritional
              approval.
            </label>
            <p className="helper">
              Based on review v{revision}. Saving appends a new decision and
              retains previous reviews.
            </p>
            <div className="button-row">
              <button className="primary" disabled={conflict || !confirmed}>
                {busy ? "Saving…" : "Save alias decision"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditing(false);
                  setConflict(false);
                  setError("");
                }}
              >
                Cancel review
              </button>
              {conflict && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void load(true)}
                >
                  Reload latest review (discard edits)
                </button>
              )}
            </div>
          </fieldset>
        </form>
      )}
      {history && (
        <div className="alias-history">
          <p className="helper">
            Latest 100 decisions, newest first. Source warnings remain part of
            the evidence.
          </p>
          {!history.length && (
            <p className="helper">No recorded alias decisions.</p>
          )}
          {history.map((review) => (
            <article key={review.id}>
              <strong>
                v{review.revision} · {review.decision}
              </strong>
              <p className="helper">
                {review.ingredient_id
                  ? ingredients.find((i) => i.id === review.ingredient_id)
                    ? referenceLabel(
                        ingredients.find((i) => i.id === review.ingredient_id)!,
                      )
                    : review.ingredient_id
                  : "No ingredient mapping"}
              </p>
              <p className="source-cell">{review.evidence}</p>
              <small>
                Reviewer {review.reviewer_id} ·{" "}
                {new Date(review.created_at).toLocaleString("en-NG")} · Decision{" "}
                {review.id}
              </small>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
