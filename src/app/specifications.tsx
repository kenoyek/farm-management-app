"use client";
import { nutrientLabels } from "@/lib/nutrients";
import { useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api, downloadJson } from "@/lib/client";
import { useDialog } from "@/lib/use-dialog";
import { nutrientKeys, type Ingredient } from "@/lib/feed";
import type { RequirementProfile } from "@/lib/profile-rules";

const labels = nutrientLabels;
const ingredientLabel = (i: Ingredient) =>
  `${i.name} · v${i.revision ?? 1} · ${i.id.slice(0, 8)}`;

export function ProfileRules({
  profile,
  ingredients,
}: {
  profile: RequirementProfile;
  ingredients: Ingredient[];
}) {
  return profile.ingredient_rules.length ? (
    <div className="profile-rules">
      <p className="helper">
        Only these exact ingredient revisions are allowed by {profile.name} v
        {profile.revision}. A positive minimum requires inclusion; a zero
        maximum excludes the reference. Scenario bounds and availability can
        only tighten these limits.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Allowed reference</th>
              <th>Min %</th>
              <th>Max %</th>
              <th>Review evidence</th>
            </tr>
          </thead>
          <tbody>
            {profile.ingredient_rules.map((r) => {
              const i = ingredients.find((i) => i.id === r.ingredientId);
              return (
                <tr key={r.ingredientId}>
                  <td>{i ? ingredientLabel(i) : r.ingredientId}</td>
                  <td>{r.min}</td>
                  <td>{r.max}</td>
                  <td className="source-cell">{r.source}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  ) : (
    <p className="helper">
      This profile has no ingredient-specific allowed list. Reviewed ingredient
      limits and species/stage/basis checks still apply.
    </p>
  );
}

export default function Specifications({
  organizationId,
  profiles,
  ingredients,
  nutritionist,
  refresh,
}: {
  organizationId: string;
  profiles: RequirementProfile[];
  ingredients: Ingredient[];
  nutritionist: boolean;
  refresh: () => Promise<void>;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [editing, setEditing] = useState<RequirementProfile | null | undefined>(
    undefined,
  );
  const [notice, setNotice] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const current = (p: RequirementProfile) =>
    !profiles.some((next) => next.parent_id === p.id);
  return (
    <>
      <section className="panel">
        <div className="panel-heading">
          <h2>Reviewed specifications</h2>
          <div className="button-row">
            <button
              className="secondary"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                setLoadError("");
                void refresh()
                  .catch((e) => setLoadError((e as Error).message))
                  .finally(() => setRefreshing(false));
              }}
            >
              {refreshing ? "Refreshing…" : "Refresh specifications"}
            </button>
            {nutritionist && (
              <button
                className="primary"
                onClick={() => {
                  setNotice("");
                  setEditing(null);
                }}
              >
                <Plus size={15} />
                Add specification
              </button>
            )}
          </div>
        </div>
        <p className="helper">
          Nutritionists register reviewed species/stage requirements and
          optional ingredient rules. Revisions preserve previous profiles,
          recipe approvals and solver snapshots. No workbook value is approved
          automatically.
        </p>
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {loadError && (
          <p className="error" role="alert">
            {loadError}
          </p>
        )}
        <label className="history-toggle">
          <input
            type="checkbox"
            checked={showHistory}
            onChange={(e) => setShowHistory(e.target.checked)}
          />
          Show historical specification revisions
        </label>
        {profiles
          .filter((p) => showHistory || current(p))
          .map((p) => (
            <details className="specification-card" key={p.id}>
              <summary>
                {p.name} · v{p.revision} · {p.stage}
                {!current(p) ? " · historical" : ""}
              </summary>
              <p className="helper">
                {p.species} · {p.basis} · {p.energy_system} ·{" "}
                {p.phosphorus_basis} phosphorus. Reviewed{" "}
                {new Date(p.created_at).toLocaleDateString("en-NG")} · Reviewer{" "}
                {p.reviewer_id}
              </p>
              <p className="source-reference">{p.source}</p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Nutrient</th>
                      <th>Minimum</th>
                      <th>Maximum</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nutrientKeys.map((k) => (
                      <tr key={k}>
                        <td>{labels[k]}</td>
                        <td>{p.limits[k]?.min ?? "—"}</td>
                        <td>{p.limits[k]?.max ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ProfileRules profile={p} ingredients={ingredients} />
              <div className="button-row">
                <button
                  className="secondary"
                  onClick={() =>
                    downloadJson("farmstead-specification.json", p)
                  }
                >
                  Download specification JSON
                </button>
                {nutritionist && (
                  <button
                    className="secondary"
                    disabled={!current(p)}
                    onClick={() => {
                      setNotice("");
                      setEditing(p);
                    }}
                  >
                    Revise specification
                  </button>
                )}
              </div>
            </details>
          ))}
        {!profiles.length && (
          <div className="empty">
            No reviewed specifications yet. An assigned nutritionist can
            register one using qualified reference evidence.
          </div>
        )}
      </section>
      {editing !== undefined && (
        <ProfileEditor
          key={editing?.id ?? "new"}
          organizationId={organizationId}
          previous={editing}
          ingredients={ingredients}
          close={() => setEditing(undefined)}
          saved={async () => {
            await refresh();
            setEditing(undefined);
            setNotice(
              editing
                ? "New specification revision registered. Historical profiles and recipes are preserved."
                : "Reviewed specification registered.",
            );
          }}
        />
      )}
    </>
  );
}

function ProfileEditor({
  organizationId,
  previous,
  ingredients,
  close,
  saved,
}: {
  organizationId: string;
  previous: RequirementProfile | null;
  ingredients: Ingredient[];
  close: () => void;
  saved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rules, setRules] = useState(() =>
    (previous?.ingredient_rules ?? []).map((r) => ({
      key: r.ingredientId,
      ...r,
    })),
  );
  useDialog(true, () => {
    if (!busy) close();
  });
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const limits = Object.fromEntries(
      nutrientKeys
        .map((k) => [
          k,
          Object.fromEntries(
            ["min", "max"]
              .filter((b) => f.get(`${k}.${b}`) !== "")
              .map((b) => [b, Number(f.get(`${k}.${b}`))]),
          ),
        ])
        .filter(([, v]) => Object.keys(v).length),
    );
    setBusy(true);
    setError("");
    try {
      await api("profiles", {
        organizationId,
        parentId: previous?.id ?? null,
        name: f.get("name"),
        species: f.get("species"),
        stage: f.get("stage"),
        source: f.get("source"),
        basis: f.get("basis"),
        energySystem: f.get("energySystem"),
        phosphorusBasis: f.get("phosphorusBasis"),
        limits,
        ingredientRules: rules.map((r) => ({
          ingredientId: f.get(`${r.key}.ingredientId`),
          min: Number(f.get(`${r.key}.min`)),
          max: Number(f.get(`${r.key}.max`)),
          source: f.get(`${r.key}.source`),
        })),
      });
      await saved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        className="modal panel wide-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-title"
      >
        <div className="panel-heading">
          <h2 id="profile-title">
            {previous
              ? `Revise specification · v${previous.revision + 1}`
              : "Reviewed nutritional specification"}
          </h2>
          <button className="text-button" disabled={busy} onClick={close}>
            Close
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <fieldset className="draft-editor" disabled={busy}>
            <div className="form-grid">
              <label>
                Profile name
                <input
                  name="name"
                  required
                  minLength={2}
                  maxLength={100}
                  defaultValue={previous?.name}
                />
              </label>
              <label>
                Species
                <select
                  name="species"
                  defaultValue={previous?.species ?? "poultry"}
                >
                  <option value="poultry">Poultry</option>
                  <option value="catfish">Catfish</option>
                </select>
              </label>
              <label>
                Production stage
                <input
                  name="stage"
                  required
                  minLength={2}
                  maxLength={100}
                  placeholder="e.g. broiler-starter"
                  defaultValue={previous?.stage}
                />
              </label>
              <label>
                Phosphorus basis
                <select
                  name="phosphorusBasis"
                  defaultValue={previous?.phosphorus_basis ?? "total"}
                >
                  <option value="total">Total</option>
                  <option value="available">Available</option>
                  <option value="digestible">Digestible</option>
                </select>
              </label>
              <label>
                Nutrient basis
                <select name="basis" defaultValue={previous?.basis ?? "as-fed"}>
                  <option value="as-fed">As-fed</option>
                  <option value="dry-matter">Dry matter</option>
                </select>
              </label>
              <label>
                Energy system
                <select
                  name="energySystem"
                  defaultValue={previous?.energy_system ?? "ME"}
                >
                  <option value="ME">ME</option>
                  <option value="DE">DE</option>
                </select>
              </label>
            </div>
            <p className="helper">
              Crude fat, crude fibre, moisture and ash are optional assessed
              requirements. Blank bounds add no constraint. Moisture uses as-fed
              percentages only; no dry-matter/moisture complement is inferred.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Nutrient</th>
                    <th>Minimum</th>
                    <th>Maximum</th>
                  </tr>
                </thead>
                <tbody>
                  {nutrientKeys.map((k) => (
                    <tr key={k}>
                      <td>{labels[k]}</td>
                      {(["min", "max"] as const).map((b) => (
                        <td key={b}>
                          <input
                            aria-label={`${k} ${b}`}
                            name={`${k}.${b}`}
                            type="number"
                            min="0"
                            max={k === "energy" ? undefined : 100}
                            step="any"
                            defaultValue={previous?.limits[k]?.[b] ?? ""}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label className="field">
              Reviewed source reference
              <textarea
                name="source"
                required
                minLength={10}
                maxLength={2000}
                defaultValue={previous?.source}
              />
            </label>
            <p className="helper">
              Specify an explicit limit for every nutrient except optional dry
              matter. Scientific review must cover the species, stage, nutrient
              bases and source evidence.
            </p>
            <h3>Ingredient rules</h3>
            <p className="helper">
              With any rules present, only listed ingredient revisions are
              allowed. Add every permitted reference, including those with
              0–100% bounds. Use a positive minimum to require an ingredient,
              equal bounds for a fixed inclusion, or maximum 0 to exclude it.
              These rules do not replace processing or laboratory evidence.
            </p>
            {rules.map((r, index) => (
              <div className="ingredient-rule-editor" key={r.key}>
                <div className="form-grid">
                  <label>
                    Rule {index + 1} ingredient
                    <select
                      name={`${r.key}.ingredientId`}
                      required
                      defaultValue={r.ingredientId}
                    >
                      <option value="">Choose exact approved reference</option>
                      {ingredients
                        .filter((i) => i.review_status === "approved")
                        .map((i) => (
                          <option key={i.id} value={i.id}>
                            {ingredientLabel(i)}
                            {ingredients.some((next) => next.parent_id === i.id)
                              ? " · historical"
                              : ""}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Rule {index + 1} minimum %
                    <input
                      name={`${r.key}.min`}
                      type="number"
                      min="0"
                      max="100"
                      step="any"
                      required
                      defaultValue={r.min}
                    />
                  </label>
                  <label>
                    Rule {index + 1} maximum %
                    <input
                      name={`${r.key}.max`}
                      type="number"
                      min="0"
                      max="100"
                      step="any"
                      required
                      defaultValue={r.max}
                    />
                  </label>
                </div>
                <label className="field">
                  Rule {index + 1} review evidence
                  <textarea
                    name={`${r.key}.source`}
                    required
                    minLength={10}
                    maxLength={2000}
                    defaultValue={r.source}
                  />
                </label>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`Remove rule ${index + 1}`}
                  onClick={() =>
                    setRules((rs) => rs.filter((row) => row.key !== r.key))
                  }
                >
                  <Trash2 size={14} />
                  Remove rule
                </button>
              </div>
            ))}
            <button
              className="secondary"
              type="button"
              disabled={rules.length >= 100}
              onClick={() =>
                setRules((rs) => [
                  ...rs,
                  {
                    key: crypto.randomUUID(),
                    ingredientId: "",
                    min: 0,
                    max: 100,
                    source: "",
                  },
                ])
              }
            >
              <Plus size={14} />
              Add ingredient rule
            </button>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <label className="history-toggle">
              <input type="checkbox" required />I reviewed these requirements
              and ingredient rules against the cited evidence.
            </label>
            <button className="primary" disabled={busy}>
              {busy
                ? "Registering…"
                : previous
                  ? "Register reviewed revision"
                  : "Register reviewed profile"}
            </button>
          </fieldset>
        </form>
      </section>
    </div>
  );
}
