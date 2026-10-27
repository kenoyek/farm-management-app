"use client";
import SourceCatalog from "./source-catalog";
import { useDialog } from "@/lib/use-dialog";
import { useEffect, useState, type FormEvent } from "react";
import {
  FlaskConical,
  Plus,
  Trash2,
  Download,
  ArrowDownToLine,
  CheckCircle2,
} from "lucide-react";
import { api, downloadCsv } from "@/lib/client";
import {
  nutrientKeys,
  type Ingredient,
  type FormulaLine,
  type Limits,
  type Nutrients,
  type compliance,
} from "@/lib/feed";
type Result = {
  totalPercent: number;
  nutrients: Nutrients;
  costPerKg: string | null;
  batchCost: string | null;
  bag25: string | null;
  bag50: string | null;
  issues: string[];
  releaseEligible: boolean;
  quantities: { name: string; kg: number; percent: number }[];
  compliance: ReturnType<typeof compliance>;
};
type Profile = { id: string; name: string; limits: Limits };
type Recipe = {
  id: string;
  name: string;
  batch_kg: string;
  status: string;
  lines: FormulaLine[];
  profile_id: string | null;
  created_at: string;
  result: Result;
};
type FeedData = {
  ingredients: Ingredient[];
  profiles: Profile[];
  formulas: Recipe[];
  imports: { id: string }[];
};
type Preview = {
  workbooks: {
    file: string;
    hash: string;
    sheets: { name: string; rows: number; formulas: number }[];
  }[];
  ingredients: Ingredient[];
  issues: string[];
};
const labels = {
  energy: "Energy (kcal/kg)",
  protein: "Crude protein (%)",
  dryMatter: "Dry matter (%)",
  calcium: "Calcium (%)",
  phosphorus: "Phosphorus (%)",
  methionine: "Methionine (%)",
  lysine: "Lysine (%)",
};
export default function FeedStudio({
  organizationId,
  role,
}: {
  organizationId: string;
  role: string;
}) {
  const [data, setData] = useState<FeedData>({
      ingredients: [],
      profiles: [],
      formulas: [],
      imports: [],
    }),
    [tab, setTab] = useState("Formulator"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<Preview | null>(null),
    [ingredientModal, setIngredientModal] = useState(false),
    [profileModal, setProfileModal] = useState(false);
  const [editing, setEditing] = useState<Ingredient | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [lines, setLines] = useState<FormulaLine[]>([]),
    [name, setName] = useState("My feed recipe"),
    [batchKg, setBatchKg] = useState(1000),
    [profileId, setProfileId] = useState(""),
    [parentId, setParentId] = useState<string | null>(null),
    [result, setResult] = useState<Result | null>(null),
    [status, setStatus] = useState("draft");
  useDialog(ingredientModal || profileModal, () => {
    if (!busy) {
      setIngredientModal(false);
      setProfileModal(false);
    }
  });
  const canEdit = ["owner", "admin", "nutritionist"].includes(role);
  const nutritionist = role === "nutritionist";
  const currentIngredients = data.ingredients.filter(
    (i) => !data.ingredients.some((next) => next.parent_id === i.id),
  );
  const visibleIngredients = showHistory
    ? data.ingredients
    : currentIngredients;
  useEffect(() => {
    let active = true;
    void api<FeedData>(`feed?organizationId=${organizationId}`)
      .then((r) => {
        if (active) setData(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [organizationId]);
  const refresh = async () =>
    setData(await api<FeedData>(`feed?organizationId=${organizationId}`));
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const payload = {
    organizationId,
    name,
    batchKg,
    profileId: profileId || null,
    parentId,
    lines,
    status,
  };
  const money = (n: string | null) =>
    n === null
      ? "Incomplete"
      : new Intl.NumberFormat("en-NG", {
          style: "currency",
          currency: "NGN",
          maximumFractionDigits: 2,
        }).format(Number(n));
  function changed(next: FormulaLine[]) {
    setLines(next);
    setResult(null);
  }
  async function addIngredient(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await run(async () => {
      const values = Object.fromEntries(
        nutrientKeys.map((k) => [k, f.get(k) === "" ? null : Number(f.get(k))]),
      );
      await api("ingredients", {
        organizationId,
        parentId: editing?.id ?? null,
        name: f.get("name"),
        source: f.get("source"),
        price: f.get("price") === "" ? null : Number(f.get("price")),
        basis: f.get("basis") || null,
        energySystem: f.get("energySystem") || null,
        reviewStatus: f.get("reviewStatus"),
        inclusionMin: Number(f.get("inclusionMin")),
        inclusionMax: Number(f.get("inclusionMax")),
        species: f.get("species"),
        stages: String(f.get("stages") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        phosphorusBasis: f.get("phosphorusBasis"),
        quotedOn: f.get("quotedOn") || null,
        nutrients: values,
      });
      await refresh();
      setIngredientModal(false);
      setNotice(
        editing
          ? "Ingredient revision saved. Historical references and recipe snapshots are unchanged."
          : "Ingredient reference saved as a new record.",
      );
      setEditing(null);
    });
  }
  return (
    <section className="module">
      <div className="module-tabs">
        {[
          "Formulator",
          "Ingredients",
          "Source catalog",
          "Recipe library",
          "Workbook import",
        ].map((t) => (
          <button
            className={tab === t ? "selected" : ""}
            key={t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
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
      {tab === "Formulator" && (
        <>
          <div className="panel module-panel">
            <div className="panel-heading">
              <h2>
                <FlaskConical size={17} /> Feed formulation studio
              </h2>
              <span className="tag">
                {result?.releaseEligible
                  ? "Eligible for nutritionist review"
                  : "DRAFT · NOT RELEASED"}
              </span>
            </div>
            <div className="editor-settings">
              <label>
                Recipe name
                <input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setResult(null);
                  }}
                  maxLength={100}
                />
              </label>
              <label>
                Batch weight (kg)
                <input
                  type="number"
                  min="1"
                  value={batchKg}
                  onChange={(e) => {
                    setBatchKg(Number(e.target.value));
                    setResult(null);
                  }}
                />
              </label>
              <label>
                Nutritional specification
                <select
                  value={profileId}
                  onChange={(e) => {
                    setProfileId(e.target.value);
                    setResult(null);
                  }}
                >
                  <option value="">No reviewed profile selected</option>
                  {data.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Ingredient</th>
                    <th>Inclusion %</th>
                    <th>Min %</th>
                    <th>Max %</th>
                    <th>Available kg</th>
                    <th>Batch kg</th>
                    <th>Reference</th>
                    <th>
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => {
                    const ing = data.ingredients.find(
                      (d) => d.id === l.ingredientId,
                    );
                    return (
                      <tr key={i}>
                        <td>
                          <select
                            aria-label={`Ingredient ${i + 1}`}
                            value={l.ingredientId}
                            onChange={(e) =>
                              changed(
                                lines.map((v, j) =>
                                  j === i
                                    ? { ...v, ingredientId: e.target.value }
                                    : v,
                                ),
                              )
                            }
                          >
                            <option value="">Select ingredient</option>
                            {data.ingredients
                              .filter(
                                (d) =>
                                  currentIngredients.some(
                                    (i) => i.id === d.id,
                                  ) || d.id === l.ingredientId,
                              )
                              .map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name}
                                  {(d.revision ?? 1) > 1
                                    ? ` · v${d.revision}`
                                    : ""}
                                  {data.ingredients.some(
                                    (next) => next.parent_id === d.id,
                                  )
                                    ? " · historical"
                                    : ""}
                                </option>
                              ))}
                          </select>
                        </td>
                        {(["percent", "min", "max"] as const).map((k) => (
                          <td key={k}>
                            <input
                              aria-label={`${k} ingredient ${i + 1}`}
                              type="number"
                              min="0"
                              max="100"
                              step="0.01"
                              value={l[k] ?? (k === "max" ? 100 : 0)}
                              onChange={(e) =>
                                changed(
                                  lines.map((v, j) =>
                                    j === i
                                      ? { ...v, [k]: Number(e.target.value) }
                                      : v,
                                  ),
                                )
                              }
                            />
                          </td>
                        ))}
                        <td>
                          <input
                            aria-label={`Available kg ingredient ${i + 1}`}
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="Not constrained"
                            value={l.availableKg ?? ""}
                            onChange={(e) =>
                              changed(
                                lines.map((v, j) =>
                                  j === i
                                    ? {
                                        ...v,
                                        availableKg:
                                          e.target.value === ""
                                            ? undefined
                                            : Number(e.target.value),
                                      }
                                    : v,
                                ),
                              )
                            }
                          />
                        </td>
                        <td>{((l.percent * batchKg) / 100).toFixed(2)}</td>
                        <td>
                          <span
                            className={`status ${ing?.review_status === "approved" ? "good" : ""}`}
                          >
                            {ing?.review_status ?? "Select"}
                          </span>
                        </td>
                        <td>
                          <button
                            className="icon-button"
                            aria-label={`Remove ingredient ${i + 1}`}
                            onClick={() =>
                              changed(lines.filter((_, j) => i !== j))
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total inclusion</td>
                    <td>
                      {lines.reduce((s, l) => s + l.percent, 0).toFixed(2)}%
                    </td>
                    <td colSpan={6}>Must equal 100% for a complete formula</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="editor-actions">
              <button
                className="secondary"
                disabled={!data.ingredients.length}
                onClick={() =>
                  changed([
                    ...lines,
                    {
                      ingredientId:
                        currentIngredients.find(
                          (i) => !lines.some((l) => l.ingredientId === i.id),
                        )?.id ?? "",
                      percent: 0,
                      min: 0,
                      max: 100,
                    },
                  ])
                }
              >
                <Plus size={15} />
                Add ingredient
              </button>
              <div>
                <button
                  className="secondary"
                  disabled={busy || !lines.length}
                  onClick={() =>
                    void run(async () =>
                      setResult(
                        await api<Result>("formulas/calculate", payload),
                      ),
                    )
                  }
                >
                  Calculate
                </button>
                <button
                  className="primary"
                  disabled={busy || !lines.length || !canEdit}
                  onClick={() =>
                    void run(async () => {
                      setResult(await api<Result>("formulas/save", payload));
                      await refresh();
                      setNotice("Immutable recipe version saved.");
                    })
                  }
                >
                  Save version
                </button>
              </div>
            </div>
            {!data.ingredients.length && (
              <div className="empty">
                <p>
                  Import the workbook references or add an ingredient to begin.
                </p>
                <button
                  className="text-button"
                  onClick={() => setTab("Workbook import")}
                >
                  Review source workbooks
                  <ArrowDownToLine size={14} />
                </button>
              </div>
            )}
            <div className="editor-actions border-top">
              <label>
                Save status
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  <option value="draft">Draft</option>
                  <option value="pending-review">Pending review</option>
                  {nutritionist && (
                    <>
                      <option value="approved">Approved</option>
                      <option value="rejected">Rejected</option>
                    </>
                  )}
                </select>
              </label>
              <button
                className="secondary"
                disabled={busy || !canEdit || !profileId || !lines.length}
                onClick={() =>
                  void run(async () => {
                    const r = await api<{
                      status: string;
                      message: string;
                      lines?: FormulaLine[];
                      calculation?: Result;
                      compliance?: Result["compliance"];
                    }>("formulas/optimize", payload);
                    if (r.status === "optimal" && r.lines && r.calculation) {
                      setLines(r.lines);
                      setResult({
                        ...r.calculation,
                        compliance: r.compliance ?? [],
                      });
                      setNotice(
                        "HiGHS found an optimum. Review the formulation before approval.",
                      );
                    } else setError(`${r.status}: ${r.message}`);
                  })
                }
              >
                Find least-cost formula
              </button>
            </div>
            <p className="helper">
              Optimization requires reviewed ingredients, compatible units and a
              nutritionist-reviewed specification. Constraints are never
              automatically relaxed. Minimum and maximum columns constrain the
              solver.
            </p>
          </div>
          {result && (
            <>
              <div className="stats-grid feed-stats">
                {[
                  ["Cost per kg", result.costPerKg],
                  ["Batch cost", result.batchCost],
                  ["25 kg bag", result.bag25],
                  ["50 kg bag", result.bag50],
                ].map(([label, v]) => (
                  <article className="stat panel" key={label}>
                    <div className="stat-label">{label}</div>
                    <strong>{money(v)}</strong>
                  </article>
                ))}
              </div>
              <div className="panel">
                <div className="panel-heading">
                  <h2>Nutrient results</h2>
                  <button
                    className="text-button"
                    onClick={() =>
                      downloadCsv("feed-mixing-sheet.csv", [
                        ["Recipe", name],
                        ["Batch kg", batchKg],
                        [
                          "Status",
                          "Draft; approval must be checked against saved version",
                        ],
                        ["Ingredient", "Percent", "kg"],
                        ...result.quantities.map((q) => [
                          q.name,
                          q.percent,
                          q.kg,
                        ]),
                        [],
                        ["Nutrient", "Actual"],
                        ...nutrientKeys.map((k) => [
                          labels[k],
                          result.nutrients[k],
                        ]),
                        [],
                        ["Cost/kg", result.costPerKg],
                      ])
                    }
                  >
                    <Download size={14} />
                    Mixing CSV
                  </button>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Nutrient</th>
                        <th>Actual</th>
                        <th>Minimum</th>
                        <th>Maximum</th>
                        <th>Specification check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nutrientKeys.map((k) => {
                        const c = result.compliance?.find(
                          (c) => c.nutrient === k,
                        );
                        return (
                          <tr key={k}>
                            <td>{labels[k]}</td>
                            <td>
                              {result.nutrients[k]?.toFixed(4) ?? "Unknown"}
                            </td>
                            <td>{c?.min ?? "—"}</td>
                            <td>{c?.max ?? "—"}</td>
                            <td>
                              <span
                                className={`status ${c?.status === "pass" ? "good" : ""}`}
                              >
                                {c?.status ?? "No specification"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {result.issues.length > 0 && (
                  <div className="validation-issues">
                    <strong>Review before use</strong>
                    <ul>
                      {result.issues.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
      {tab === "Source catalog" && (
        <SourceCatalog organizationId={organizationId} canEdit={canEdit} />
      )}
      {tab === "Ingredients" && (
        <section className="panel">
          <div className="panel-heading">
            <h2>
              Ingredient references{" "}
              <span className="count">{data.ingredients.length}</span>
            </h2>
            <div className="button-row">
              {nutritionist && (
                <button
                  className="secondary"
                  onClick={() => setProfileModal(true)}
                >
                  Add specification
                </button>
              )}
              <button
                className="primary"
                disabled={!canEdit}
                onClick={() => {
                  setEditing(null);
                  setIngredientModal(true);
                }}
              >
                <Plus size={14} />
                Add ingredient
              </button>
            </div>
          </div>
          <p className="helper">
            Missing nutrients stay unknown. Approved data requires a
            nutritionist, a source, an explicit nutrient basis and energy
            system. Historical source prices are not current quotations. Create
            new references for corrected or updated data.
          </p>
          <label className="history-toggle">
            <input
              type="checkbox"
              checked={showHistory}
              onChange={(e) => setShowHistory(e.target.checked)}
            />
            Show historical ingredient revisions
          </label>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Ingredient</th>
                  <th>₦ / kg</th>
                  <th>Energy</th>
                  <th>Protein %</th>
                  <th>Reference status</th>
                  <th>Source</th>
                  <th>Revision</th>
                  <th>Review</th>
                </tr>
              </thead>
              <tbody>
                {visibleIngredients.map((i) => (
                  <tr key={i.id}>
                    <td>{i.name}</td>
                    <td>{i.price ?? "Missing"}</td>
                    <td>{i.nutrients.energy ?? "Missing"}</td>
                    <td>{i.nutrients.protein ?? "Missing"}</td>
                    <td>
                      <span
                        className={`status ${i.review_status === "approved" ? "good" : ""}`}
                      >
                        {i.review_status}
                      </span>
                    </td>
                    <td className="source-cell">{i.source}</td>
                    <td>
                      v{i.revision ?? 1}
                      {data.ingredients.some((next) => next.parent_id === i.id)
                        ? " · historical"
                        : " · current"}
                    </td>
                    <td>
                      <button
                        className="text-button"
                        disabled={
                          !canEdit ||
                          data.ingredients.some(
                            (next) => next.parent_id === i.id,
                          )
                        }
                        onClick={() => {
                          setEditing(i);
                          setIngredientModal(true);
                        }}
                      >
                        Revise reference
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.ingredients.length && (
            <div className="empty">No ingredient references yet.</div>
          )}
        </section>
      )}
      {tab === "Recipe library" && (
        <section className="panel">
          <div className="panel-heading">
            <h2>Saved formula versions</h2>
            <span className="tag">HISTORY PRESERVED</span>
          </div>
          {data.formulas.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Recipe</th>
                    <th>Status</th>
                    <th>Batch kg</th>
                    <th>₦ / kg</th>
                    <th>Saved</th>
                    <th>Version</th>
                  </tr>
                </thead>
                <tbody>
                  {data.formulas.map((f) => (
                    <tr key={f.id}>
                      <td>{f.name}</td>
                      <td>
                        <span
                          className={`status ${f.status === "approved" ? "good" : ""}`}
                        >
                          {f.status}
                        </span>
                      </td>
                      <td>{f.batch_kg}</td>
                      <td>{f.result.costPerKg ?? "Unknown"}</td>
                      <td>
                        {new Date(f.created_at).toLocaleDateString("en-NG")}
                      </td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => {
                            setName(f.name);
                            setLines(f.lines);
                            setBatchKg(Number(f.batch_kg));
                            setProfileId(f.profile_id ?? "");
                            setParentId(f.id);
                            setStatus("draft");
                            setResult(f.result);
                            setTab("Formulator");
                          }}
                        >
                          Clone & edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">
              <FlaskConical size={30} />
              <h3>Your recipe library starts with one formula</h3>
              <p>
                Save a formulation to keep its inputs, reference snapshot and
                calculated results.
              </p>
            </div>
          )}
        </section>
      )}
      {tab === "Workbook import" && (
        <section className="panel">
          <div className="panel-heading">
            <h2>Source workbook migration</h2>
            <span className="tag">PREVIEW BEFORE IMPORT</span>
          </div>
          <div className="module-padding">
            <p className="muted">
              Review the three supplied workbooks and their data-quality issues.
              Confirmation preserves all original cells and cached formulas,
              then adds 32 unverified ingredient references. No recipe aliases
              or scientific corrections are applied automatically.
            </p>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  setPreview(await api<Preview>("imports/preview")),
                )
              }
            >
              <ArrowDownToLine size={15} />
              Inspect supplied workbooks
            </button>
            {preview && (
              <>
                <div className="import-cards">
                  {preview.workbooks.map((w) => (
                    <article key={w.file}>
                      <CheckCircle2 size={18} />
                      <h3>{w.file}</h3>
                      <p>
                        {w.sheets
                          .map(
                            (s) =>
                              `${s.name}: ${s.rows} rows, ${s.formulas} formulas`,
                          )
                          .join(" · ")}
                      </p>
                      <small>SHA-256 {w.hash.slice(0, 16)}…</small>
                    </article>
                  ))}
                </div>
                <div className="validation-issues">
                  <strong>Import issues requiring review</strong>
                  <ul>
                    {preview.issues.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
                <p className="helper">
                  {preview.ingredients.length} ingredient rows · 7 worksheets ·
                  no source formulas executed
                </p>
                <button
                  className="primary"
                  disabled={busy || !canEdit || data.imports.length > 0}
                  onClick={() =>
                    void run(async () => {
                      const r = await api<{ count: number }>(
                        "imports/confirm",
                        { organizationId, confirmed: true },
                      );
                      await refresh();
                      setNotice(
                        `${r.count} unverified ingredient references imported with raw workbook audit.`,
                      );
                      setTab("Ingredients");
                    })
                  }
                >
                  {data.imports.length
                    ? "Workbooks already imported"
                    : "Confirm import as unverified data"}
                </button>
              </>
            )}
          </div>
        </section>
      )}
      {ingredientModal && (
        <div className="modal-backdrop">
          <section
            className="modal panel wide-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ingredient-title"
          >
            <div className="panel-heading">
              <h2 id="ingredient-title">
                {editing
                  ? `Revise ${editing.name} · v${(editing.revision ?? 1) + 1}`
                  : "New ingredient reference"}
              </h2>
              <button
                className="text-button"
                onClick={() => setIngredientModal(false)}
              >
                Close
              </button>
            </div>
            <form
              key={editing?.id ?? "new"}
              onSubmit={(e) => void addIngredient(e)}
            >
              <div className="form-grid">
                <label>
                  Name
                  <input
                    name="name"
                    defaultValue={editing?.name ?? ""}
                    required
                    minLength={2}
                    maxLength={100}
                  />
                </label>
                <label>
                  Price per kg (₦)
                  <input
                    type="number"
                    name="price"
                    defaultValue={editing?.price ?? ""}
                    step="0.0001"
                    min="0"
                  />
                </label>
                <label>
                  Nutrient basis
                  <select name="basis" defaultValue={editing?.basis ?? ""}>
                    <option value="">Unknown</option>
                    <option value="as-fed">As-fed</option>
                    <option value="dry-matter">Dry matter</option>
                  </select>
                </label>
                <label>
                  Energy system
                  <select
                    name="energySystem"
                    defaultValue={editing?.energy_system ?? ""}
                  >
                    <option value="">Unknown</option>
                    <option value="ME">Metabolizable energy (ME)</option>
                    <option value="DE">Digestible energy (DE)</option>
                  </select>
                </label>
                <label>
                  Species
                  <select
                    name="species"
                    defaultValue={editing?.species ?? "unknown"}
                  >
                    <option value="unknown">Unverified species</option>
                    <option value="poultry">Poultry</option>
                    <option value="catfish">Catfish</option>
                  </select>
                </label>
                <label>
                  Applicable stages (comma separated)
                  <input
                    name="stages"
                    defaultValue={editing?.stages?.join(", ") ?? ""}
                    placeholder="e.g. broiler-starter, broiler-finisher"
                  />
                </label>
                <label>
                  Phosphorus basis
                  <select
                    name="phosphorusBasis"
                    defaultValue={editing?.phosphorus_basis ?? "unknown"}
                  >
                    <option value="unknown">Unknown</option>
                    <option value="total">Total</option>
                    <option value="available">Available</option>
                    <option value="digestible">Digestible</option>
                  </select>
                </label>
                <label>
                  Price quotation date
                  <input
                    name="quotedOn"
                    defaultValue={editing?.quoted_on?.slice(0, 10) ?? ""}
                    type="date"
                    max={new Date().toISOString().slice(0, 10)}
                  />
                </label>
                <label>
                  Reviewed minimum inclusion %
                  <input
                    name="inclusionMin"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    required
                    defaultValue={editing?.inclusion_min ?? 0}
                  />
                </label>
                <label>
                  Reviewed maximum inclusion %
                  <input
                    name="inclusionMax"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    required
                    defaultValue={editing?.inclusion_max ?? 100}
                  />
                </label>
                {nutrientKeys.map((k) => (
                  <label key={k}>
                    {labels[k]}
                    <input
                      name={k}
                      defaultValue={editing?.nutrients[k] ?? ""}
                      type="number"
                      step="0.0001"
                      min="0"
                      max={k === "energy" ? undefined : 100}
                    />
                  </label>
                ))}
              </div>
              <label className="field">
                Source and verification reference
                <textarea
                  name="source"
                  defaultValue={editing?.source ?? ""}
                  required
                  minLength={3}
                  maxLength={2000}
                  placeholder="Publication/product laboratory certificate, date, unit and species context"
                />
              </label>
              <label className="field">
                Review status
                <select name="reviewStatus">
                  <option value="unverified">Unverified</option>
                  {nutritionist && (
                    <option value="approved">
                      I have verified the source, nutrient basis and species
                      suitability
                    </option>
                  )}
                </select>
              </label>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary" disabled={busy}>
                {editing ? "Save reference revision" : "Save new reference"}
              </button>
            </form>
          </section>
        </div>
      )}
      {profileModal && (
        <div className="modal-backdrop">
          <section
            className="modal panel wide-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-title"
          >
            <div className="panel-heading">
              <h2 id="profile-title">Reviewed nutritional specification</h2>
              <button
                className="text-button"
                onClick={() => setProfileModal(false)}
              >
                Close
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void run(async () => {
                  const limits = Object.fromEntries(
                    nutrientKeys
                      .map((k) => [
                        k,
                        Object.fromEntries(
                          ["min", "max"]
                            .filter((bound) => f.get(`${k}.${bound}`) !== "")
                            .map((bound) => [
                              bound,
                              Number(f.get(`${k}.${bound}`)),
                            ]),
                        ),
                      ])
                      .filter(([, v]) => Object.keys(v).length),
                  );
                  await api("profiles", {
                    organizationId,
                    name: f.get("name"),
                    species: f.get("species"),
                    stage: f.get("stage"),
                    source: f.get("source"),
                    basis: f.get("basis"),
                    energySystem: f.get("energySystem"),
                    phosphorusBasis: f.get("phosphorusBasis"),
                    limits,
                  });
                  await refresh();
                  setProfileModal(false);
                  setNotice("Reviewed specification registered.");
                });
              }}
            >
              <div className="form-grid">
                <label>
                  Profile name
                  <input name="name" required minLength={2} />
                </label>
                <label>
                  Species
                  <select name="species">
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
                    placeholder="e.g. broiler-starter"
                  />
                </label>
                <label>
                  Phosphorus basis
                  <select name="phosphorusBasis">
                    <option value="total">Total</option>
                    <option value="available">Available</option>
                    <option value="digestible">Digestible</option>
                  </select>
                </label>
                <label>
                  Nutrient basis
                  <select name="basis">
                    <option value="as-fed">As-fed</option>
                    <option value="dry-matter">Dry matter</option>
                  </select>
                </label>
                <label>
                  Energy system
                  <select name="energySystem">
                    <option value="ME">ME</option>
                    <option value="DE">DE</option>
                  </select>
                </label>
              </div>
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
                        {["min", "max"].map((b) => (
                          <td key={b}>
                            <input
                              aria-label={`${k} ${b}`}
                              name={`${k}.${b}`}
                              type="number"
                              min="0"
                              step="0.0001"
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
                />
              </label>
              <p className="helper">
                Specify an explicit limit for every nutrient except optional dry
                matter. Approve only species- and stage-appropriate, compatible
                reference data.
              </p>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary" disabled={busy}>
                Register reviewed profile
              </button>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
