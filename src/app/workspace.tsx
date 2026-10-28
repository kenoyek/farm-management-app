"use client";
import { useDialog } from "@/lib/use-dialog";
import Team from "./team";
import EggInventory from "./egg-inventory";
import Production from "./production";
import Projections from "./projections";
import FeedStudio from "./feed-studio";
import { api } from "@/lib/client";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Sprout,
  LayoutDashboard,
  Warehouse,
  FlaskConical,
  ChartNoAxesCombined,
  Settings,
  ClipboardList,
  LogOut,
  ArrowUpRight,
  Plus,
  MapPin,
  ChevronRight,
  Sun,
  Moon,
  ShieldCheck,
  Menu,
  X,
  Leaf,
  Check,
} from "lucide-react";
type Org = {
  id: string;
  name: string;
  role: string;
  currency: string;
  timezone: string;
};
type Farm = {
  id: string;
  name: string;
  location: string;
  kind: string;
  created_at: string;
};
type Activity = { action: string; created_at: string };
type Dashboard = {
  summary: {
    birds: number;
    fish: number;
    fish_biomass: string;
    feed_kg: string;
    eggs: number;
  };
  farms: Farm[];
  activity: Activity[];
  role: string;
};
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export default function Workspace() {
  const [user, setUser] = useState<{ email: string } | null>(null),
    [loading, setLoading] = useState(true),
    [organizations, setOrganizations] = useState<Org[]>([]),
    [orgId, setOrgId] = useState(""),
    [data, setData] = useState<Dashboard | null>(null);
  const [view, setView] = useState("Overview"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [register, setRegister] = useState(false),
    [modal, setModal] = useState<"farm" | "organization" | null>(null),
    [dark, setDark] = useState(false),
    [mobile, setMobile] = useState(false);
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [view]);
  const loadMe = useCallback(async () => {
    try {
      const r = await api<{ user: { email: string }; organizations: Org[] }>(
        "me",
      );
      setUser(r.user);
      setOrganizations(r.organizations);
      setOrgId((current) =>
        r.organizations.some((o) => o.id === current)
          ? current
          : (r.organizations[0]?.id ?? ""),
      );
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);
  const loadDashboard = useCallback(async () => {
    if (!orgId) {
      setData(null);
      return;
    }
    try {
      setData(await api<Dashboard>(`dashboard?organizationId=${orgId}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [orgId]);
  useEffect(() => {
    let active = true;
    void api<{ user: { email: string }; organizations: Org[] }>("me")
      .then((r) => {
        if (active) {
          setUser(r.user);
          setOrganizations(r.organizations);
          setOrgId(r.organizations[0]?.id ?? "");
        }
      })
      .catch(() => {
        if (active) setUser(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!orgId) return;
    let active = true;
    void api<Dashboard>(`dashboard?organizationId=${orgId}`)
      .then((r) => {
        if (active) setData(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [orgId, view]);
  async function submit(
    e: FormEvent<HTMLFormElement>,
    action: (f: FormData) => Promise<void>,
  ) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await action(new FormData(e.currentTarget));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const [teamVersion, setTeamVersion] = useState(0);
  useDialog(!!modal, () => {
    if (!busy) setModal(null);
  });
  const org = organizations.find((o) => o.id === orgId);
  const canManage = org && ["owner", "admin"].includes(org.role);
  if (loading)
    return (
      <main className="loading">
        <Sprout size={32} />
        <p>Opening your farm workspace…</p>
      </main>
    );
  if (!user)
    return (
      <div className="auth-page">
        <section className="auth-story">
          <Link className="brand" href="/">
            <span className="brand-mark">
              <Sprout />
            </span>
            farmstead<span className="brand-dot">.</span>
          </Link>
          <span className="eyebrow">GROW WITH CLARITY</span>
          <h1>
            Good farming.
            <br />
            Better decisions.
          </h1>
          <p>
            Your farms, feed and production records.
            <br />
            One connected place to manage what matters.
          </p>
          <div className="field-art" aria-hidden="true">
            <div />
            <div />
            <div />
            <Leaf size={120} />
          </div>
          <small>BUILT FOR THE WAY YOU FARM</small>
        </section>
        <main className="auth-form">
          <div className="auth-card">
            <span className="tag">
              <Sprout size={14} /> YOUR FARM, CONNECTED
            </span>
            <h2>{register ? "A fresh start for your farm" : "Welcome back"}</h2>
            <p className="muted">
              {register
                ? "Create your account, then set up your organization."
                : "Sign in to your farm workspace."}
            </p>
            <form
              onSubmit={(e) =>
                void submit(e, async (f) => {
                  await api(`auth/${register ? "register" : "login"}`, {
                    email: f.get("email"),
                    password: f.get("password"),
                  });
                  await loadMe();
                })
              }
            >
              <Field label="Email address">
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@yourfarm.com"
                  required
                  maxLength={254}
                />
              </Field>
              <Field label="Password">
                <input
                  name="password"
                  type="password"
                  autoComplete={register ? "new-password" : "current-password"}
                  minLength={12}
                  maxLength={128}
                  required
                  placeholder="At least 12 characters"
                />
              </Field>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary wide" disabled={busy}>
                {busy
                  ? "Please wait…"
                  : register
                    ? "Create account"
                    : "Sign in"}
                <ArrowUpRight size={17} />
              </button>
            </form>
            <p className="auth-switch">
              {register ? "Already have an account?" : "New to Farmstead?"}{" "}
              <button
                className="text-button"
                onClick={() => {
                  setRegister(!register);
                  setError("");
                }}
              >
                {register ? "Sign in" : "Create an account"}
              </button>
            </p>
            <div className="auth-note">
              <ShieldCheck size={16} /> Your farm records stay within your
              organization.
            </div>
          </div>
        </main>
      </div>
    );
  return (
    <div className={`app ${dark ? "dark" : ""}`}>
      <aside className={`sidebar ${mobile ? "open" : ""}`}>
        <Link className="brand" href="/">
          <span className="brand-mark">
            <Sprout />
          </span>
          farmstead<span className="brand-dot">.</span>
        </Link>
        <button
          className="mobile-close icon-button"
          aria-label="Close navigation"
          onClick={() => setMobile(false)}
        >
          <X />
        </button>
        <div className="workspace-label">WORKSPACE</div>
        <div className="org-picker">
          <span className="org-avatar">{org?.name.charAt(0) ?? "F"}</span>
          <div>
            <strong>{org?.name ?? "Your organization"}</strong>
            <small>{org?.role ?? "Let’s get started"}</small>
          </div>
        </div>
        {organizations.length > 1 && (
          <select
            aria-label="Active organization"
            value={orgId}
            onChange={(e) => {
              setOrgId(e.target.value);
              setData(null);
            }}
          >
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        )}
        <div className="workspace-label">FARM MANAGEMENT</div>
        <nav>
          {[
            [LayoutDashboard, "Overview"],
            [Warehouse, "My farms"],
            [ClipboardList, "Production"],
            [Warehouse, "Egg inventory"],
            [FlaskConical, "Feed studio"],
            [ChartNoAxesCombined, "Projections"],
            [Settings, "Settings"],
          ].map(([Icon, label]) => {
            const I = Icon as typeof Sprout;
            return (
              <button
                key={String(label)}
                className={view === label ? "nav-item active" : "nav-item"}
                onClick={() => {
                  setView(String(label));
                  setMobile(false);
                  setError("");
                }}
              >
                <I size={19} />
                {String(label)}
                {view === label && <span className="nav-dot" />}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="grow-card">
            <Leaf size={22} />
            <strong>Built on your records</strong>
            <p>Every insight starts with what happens on your farm.</p>
          </div>
          <button
            className="user-card"
            onClick={() =>
              void api("auth/logout", {})
                .then(() => {
                  setUser(null);
                  setData(null);
                  setOrgId("");
                  setError("");
                })
                .catch((e) => setError(e.message))
            }
          >
            <span className="user-avatar">{user.email[0].toUpperCase()}</span>
            <span>
              <strong>{user.email.split("@")[0]}</strong>
              <small>Sign out</small>
            </span>
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="main-wrap">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-toggle icon-button"
              aria-label="Open navigation"
              onClick={() => setMobile(true)}
            >
              <Menu />
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{view}</strong>
          </div>
          <div className="top-actions">
            <span className="today">
              {new Date().toLocaleDateString("en-NG", {
                day: "numeric",
                month: "short",
                year: "numeric",
                timeZone: org?.timezone ?? "Africa/Lagos",
              })}
            </span>
            <button
              className="icon-button"
              aria-label={dark ? "Use light mode" : "Use dark mode"}
              onClick={() => setDark(!dark)}
            >
              {dark ? <Sun size={19} /> : <Moon size={19} />}
            </button>
            <span className="user-avatar small">
              {user.email[0].toUpperCase()}
            </span>
          </div>
        </header>
        <main className="content">
          {error && (
            <div className="error" role="alert">
              {error}
              <button className="text-button" onClick={() => setError("")}>
                Dismiss
              </button>
            </div>
          )}
          {notice && (
            <div className="notice" role="status">
              <Check size={16} />
              {notice}
              <button className="text-button" onClick={() => setNotice("")}>
                Dismiss
              </button>
            </div>
          )}
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR FARM COMMAND CENTRE</div>
              <h1>
                {view === "Overview"
                  ? "A clearer view of your farm."
                  : view === "My farms"
                    ? "Room to grow."
                    : view === "Settings"
                      ? "Your workspace, your way."
                      : view === "Production"
                        ? "A record of every day."
                        : view === "Egg inventory"
                          ? "Every egg accounted for."
                          : view === "Feed studio"
                            ? "Better feed starts here."
                            : "Plan the season ahead."}
              </h1>
              <p className="muted">
                {view === "Overview"
                  ? "Keep your operations connected and your next step in focus."
                  : view === "My farms"
                    ? "Manage every location from one organization."
                    : view === "Settings"
                      ? "Organization details, access and account information."
                      : view === "Production"
                        ? "Track your flocks, batches and ponds with real daily records."
                        : view === "Egg inventory"
                          ? "Receive collections, reconcile physical stock and record egg sales."
                          : view === "Feed studio"
                            ? "Build a recipe with transparent nutrition and cost calculations."
                            : "Explore feed needs and egg production with explicit assumptions."}
              </p>
            </div>
            {(view === "Overview" || view === "My farms") && (
              <button
                className="primary"
                onClick={() => setModal(org ? "farm" : "organization")}
                disabled={!!org && !canManage}
              >
                <Plus size={17} />
                {org ? "Add farm" : "Create organization"}
              </button>
            )}
          </div>
          {!org ? (
            <section className="welcome panel">
              <div className="empty-icon">
                <Sprout size={30} />
              </div>
              <span className="eyebrow">START WITH YOUR ORGANIZATION</span>
              <h2>Make space for your farm.</h2>
              <p>
                Create an organization to keep your farms, team and records
                together.
                <br />
                You’ll be its first owner.
              </p>
              <button
                className="primary"
                onClick={() => setModal("organization")}
              >
                Set up organization
                <ArrowUpRight size={16} />
              </button>
            </section>
          ) : (
            <>
              {view === "Overview" && (
                <>
                  <section className="hero-panel">
                    <div>
                      <span className="tag light">
                        <span className="live-dot" /> YOUR OPERATIONS AT A
                        GLANCE
                      </span>
                      <h2>
                        Every good season
                        <br />
                        starts with a clear picture.
                      </h2>
                      <p>
                        {data?.farms.length
                          ? "Your farm directory is taking shape. Keep building the records behind your decisions."
                          : "Add your first farm to start building a reliable picture of your operations."}
                      </p>
                      <button
                        className="hero-link"
                        onClick={() => setView("My farms")}
                      >
                        Explore your farms
                        <ArrowUpRight size={17} />
                      </button>
                    </div>
                    <div className="hero-illustration" aria-hidden="true">
                      <Sprout size={108} />
                      <div className="orbit one" />
                      <div className="orbit two" />
                      <div className="sun-disc" />
                    </div>
                  </section>
                  <section className="stats-grid">
                    {[
                      {
                        label: "Recorded bird balance",
                        value: data?.summary?.birds.toLocaleString() ?? 0,
                        desc: "Latest opening count less recorded mortality; gaps may hide losses",
                        icon: Leaf,
                      },
                      {
                        label: "Fish biomass estimate",
                        value: `${Number(data?.summary?.fish_biomass ?? 0).toFixed(1)} kg`,
                        desc: "Latest sample or initial stocking weight",
                        icon: ChartNoAxesCombined,
                      },
                      {
                        label: "Saleable eggs recorded",
                        value: data?.summary?.eggs.toLocaleString() ?? 0,
                        desc: "All recorded collections less cracked eggs",
                        icon: Warehouse,
                      },
                      {
                        label: "Feed consumption recorded",
                        value: `${Number(data?.summary?.feed_kg ?? 0).toFixed(1)} kg`,
                        desc: "All daily records, not a forecast",
                        icon: FlaskConical,
                      },
                    ].map((s) => (
                      <article className="stat panel" key={s.label}>
                        <div className="stat-label">
                          {s.label}
                          <s.icon size={18} />
                        </div>
                        <strong>{s.value}</strong>
                        <small>{s.desc}</small>
                      </article>
                    ))}
                  </section>
                  <section className="overview-columns">
                    <div className="panel">
                      <div className="panel-heading">
                        <h2>
                          Your farms{" "}
                          <span className="count">
                            {data?.farms.length ?? 0}
                          </span>
                        </h2>
                        <button
                          className="text-button"
                          onClick={() => setView("My farms")}
                        >
                          View all
                          <ArrowUpRight size={14} />
                        </button>
                      </div>
                      {!data?.farms.length ? (
                        <div className="empty">
                          <Warehouse size={30} />
                          <h3>Your first farm belongs here</h3>
                          <p>Add its name, location and type to get started.</p>
                          <button
                            className="secondary"
                            disabled={!canManage}
                            onClick={() => setModal("farm")}
                          >
                            <Plus size={15} />
                            Add a farm
                          </button>
                        </div>
                      ) : (
                        data.farms
                          .slice(0, 4)
                          .map((f) => <FarmRow key={f.id} farm={f} />)
                      )}
                    </div>
                    <div className="panel">
                      <div className="panel-heading">
                        <h2>Recent activity</h2>
                        <span className="subtle-dot" />
                      </div>
                      <div className="activity-list">
                        {data?.activity.length ? (
                          data.activity.map((a, i) => (
                            <div className="activity" key={i}>
                              <span className="activity-icon">
                                <Check size={14} />
                              </span>
                              <div>
                                <strong>
                                  {a.action.replaceAll(".", " · ")}
                                </strong>
                                <small>
                                  {new Date(a.created_at).toLocaleString(
                                    "en-NG",
                                    { timeZone: org.timezone },
                                  )}
                                </small>
                              </div>
                            </div>
                          ))
                        ) : (
                          <p className="muted">
                            {org.role === "auditor"
                              ? "No recorded activity yet."
                              : "Activity is visible to owners, administrators and auditors."}
                          </p>
                        )}
                      </div>
                    </div>
                  </section>
                  <div className="record-note">
                    <ShieldCheck size={16} />
                    <span>
                      These figures come from your organization’s saved records.
                      No demonstration metrics.
                    </span>
                  </div>
                </>
              )}
              {view === "My farms" && (
                <section className="panel">
                  <div className="panel-heading">
                    <h2>Farm directory</h2>
                    <span className="tag">
                      {data?.farms.length ?? 0} locations
                    </span>
                  </div>
                  {!data?.farms.length ? (
                    <div className="empty">
                      <Warehouse size={36} />
                      <h3>A home for every operation</h3>
                      <p>Add your first farm to the directory.</p>
                      <button
                        className="primary"
                        disabled={!canManage}
                        onClick={() => setModal("farm")}
                      >
                        <Plus size={16} />
                        Add farm
                      </button>
                    </div>
                  ) : (
                    data.farms.map((f) => <FarmRow key={f.id} farm={f} />)
                  )}
                </section>
              )}
              {view === "Settings" && (
                <>
                  <Team
                    key={`${orgId}-${teamVersion}`}
                    organizationId={orgId}
                    canManage={!!canManage}
                    onChanged={loadMe}
                  />
                  <div className="settings-grid">
                    <section className="panel settings-panel">
                      <span className="eyebrow">ORGANIZATION</span>
                      <h2>{org.name}</h2>
                      <dl>
                        <dt>Currency</dt>
                        <dd>{org.currency}</dd>
                        <dt>Timezone</dt>
                        <dd>{org.timezone}</dd>
                        <dt>Your role</dt>
                        <dd>{org.role}</dd>
                        <dt>Account</dt>
                        <dd>{user.email}</dd>
                      </dl>
                      {canManage && (
                        <form
                          key={org.id}
                          onSubmit={(e) =>
                            void submit(e, async (f) => {
                              await api("organizations/settings", {
                                organizationId: orgId,
                                name: f.get("name"),
                                currency: f.get("currency"),
                                timezone: f.get("timezone"),
                              });
                              await loadMe();
                              setNotice("Organization settings updated.");
                            })
                          }
                        >
                          <Field label="Organization display name">
                            <input
                              name="name"
                              required
                              minLength={2}
                              maxLength={100}
                              defaultValue={org.name}
                            />
                          </Field>
                          <Field label="Currency">
                            <select name="currency" defaultValue={org.currency}>
                              {Intl.supportedValuesOf("currency").map((c) => (
                                <option key={c}>{c}</option>
                              ))}
                            </select>
                          </Field>
                          <Field label="Timezone">
                            <input
                              name="timezone"
                              required
                              defaultValue={org.timezone}
                              placeholder="Africa/Lagos"
                            />
                          </Field>
                          <button className="primary" disabled={busy}>
                            Update settings
                          </button>
                        </form>
                      )}
                      <button
                        className="secondary"
                        onClick={() => setModal("organization")}
                      >
                        <Plus size={16} />
                        Create another organization
                      </button>
                    </section>
                    <section className="panel settings-panel">
                      <ShieldCheck size={28} />
                      <h2>Access is scoped to your team</h2>
                      <p className="muted">
                        Organization membership controls access to records. Farm
                        registration is available to owners and administrators.
                      </p>
                      {canManage && (
                        <form
                          onSubmit={(e) =>
                            void submit(e, async (f) => {
                              await api("team", {
                                organizationId: orgId,
                                email: f.get("email"),
                                role: f.get("role"),
                              });
                              setNotice("Team member added.");
                              setTeamVersion((v) => v + 1);
                            })
                          }
                        >
                          <Field label="Add existing account by email">
                            <input
                              name="email"
                              type="email"
                              required
                              placeholder="colleague@yourfarm.com"
                            />
                          </Field>
                          <Field label="Role">
                            <select name="role">
                              {[
                                "admin",
                                "manager",
                                "nutritionist",
                                "inventory",
                                "accounts",
                                "worker",
                                "auditor",
                              ].map((r) => (
                                <option key={r}>{r}</option>
                              ))}
                            </select>
                          </Field>
                          <button className="primary" disabled={busy}>
                            Add team member
                          </button>
                          <p className="helper">
                            The person must create an account first. This grants
                            access; it sends no email.
                          </p>
                        </form>
                      )}
                    </section>
                  </div>
                </>
              )}
              {view === "Production" && (
                <Production
                  key={orgId}
                  organizationId={orgId}
                  role={org.role}
                  farms={data?.farms ?? []}
                />
              )}
              {view === "Egg inventory" && (
                <EggInventory
                  key={`${orgId}:${user.email}`}
                  organizationId={orgId}
                  role={org.role}
                  actor={user.email}
                  farms={data?.farms ?? []}
                />
              )}
              {view === "Feed studio" && (
                <FeedStudio
                  key={orgId}
                  organizationId={orgId}
                  role={org.role}
                />
              )}
              {view === "Projections" && (
                <Projections
                  key={orgId}
                  organizationId={orgId}
                  role={org.role}
                />
              )}
            </>
          )}
          <footer className="footer">
            <span>
              <Sprout size={13} />
              farmstead · Grow with clarity
            </span>
            <span>Made for the way you farm</span>
          </footer>
        </main>
      </div>
      {modal && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!busy) setModal(null);
          }}
        >
          <section
            className="modal panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-heading">
              <h2 id="modal-title">
                {modal === "farm" ? "Add a farm" : "Create organization"}
              </h2>
              <button
                className="icon-button"
                aria-label="Close dialog"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                <X size={20} />
              </button>
            </div>
            <form
              onSubmit={(e) =>
                void submit(e, async (f) => {
                  if (modal === "organization") {
                    const created = await api<{ id: string }>("organizations", {
                      name: f.get("name"),
                    });
                    await loadMe();
                    setOrgId(created.id);
                    setNotice("Organization created. You are its owner.");
                  } else {
                    await api("farms", {
                      organizationId: orgId,
                      name: f.get("name"),
                      location: f.get("location"),
                      kind: f.get("kind"),
                    });
                    await loadDashboard();
                    setNotice("Farm added to your directory.");
                  }
                  setModal(null);
                })
              }
            >
              <Field
                label={modal === "farm" ? "Farm name" : "Organization name"}
              >
                <input
                  name="name"
                  minLength={2}
                  maxLength={100}
                  required
                  autoFocus
                  placeholder={
                    modal === "farm"
                      ? "e.g. Green Valley Farm"
                      : "e.g. Green Valley Agriculture"
                  }
                />
              </Field>
              {modal === "farm" && (
                <>
                  <Field label="Location">
                    <input
                      name="location"
                      maxLength={200}
                      placeholder="e.g. Ibadan, Oyo State"
                    />
                  </Field>
                  <Field label="Operation type">
                    <select name="kind" defaultValue="mixed">
                      <option value="mixed">Mixed farming</option>
                      <option value="layers">Layers</option>
                      <option value="broilers">Broilers</option>
                      <option value="catfish">Catfish</option>
                      <option value="feed_mill">Feed mill</option>
                    </select>
                  </Field>
                </>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setModal(null)}
                >
                  Cancel
                </button>
                <button className="primary" disabled={busy}>
                  {busy
                    ? "Saving…"
                    : modal === "farm"
                      ? "Save farm"
                      : "Create organization"}
                  <ArrowUpRight size={16} />
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
function FarmRow({ farm }: { farm: Farm }) {
  return (
    <article className="farm-row">
      <span className="farm-icon">
        <Warehouse size={21} />
      </span>
      <div>
        <h3>{farm.name}</h3>
        <p>
          <MapPin size={12} />
          {farm.location || "Location not specified"}
        </p>
      </div>
      <span className="farm-type">{farm.kind.replace("_", " ")}</span>
    </article>
  );
}
