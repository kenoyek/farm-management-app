"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
type Member = { id: string; email: string; role: string };
const roles = [
  "admin",
  "manager",
  "nutritionist",
  "inventory",
  "accounts",
  "worker",
  "auditor",
];
export default function Team({
  organizationId,
  canManage,
  onChanged,
}: {
  organizationId: string;
  canManage: boolean;
  onChanged: () => Promise<void>;
}) {
  const [members, setMembers] = useState<Member[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void api<Member[]>(`team?organizationId=${organizationId}`)
      .then((r) => {
        if (active) setMembers(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [organizationId]);
  async function change(userId: string, role: string | null) {
    setBusy(true);
    setError("");
    try {
      await api("team/change", { organizationId, userId, role });
      setMembers(await api<Member[]>(`team?organizationId=${organizationId}`));
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel module-panel">
      <div className="panel-heading">
        <h2>Organization team</h2>
        <span className="tag">{members.length} MEMBERS</span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Role</th>
              {canManage && <th>Access</th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td>{m.email}</td>
                <td>
                  {canManage && m.role !== "owner" ? (
                    <select
                      aria-label={`Role for ${m.email}`}
                      value={m.role}
                      disabled={busy}
                      onChange={(e) => void change(m.id, e.target.value)}
                    >
                      {roles.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  ) : (
                    m.role
                  )}
                </td>
                {canManage && (
                  <td>
                    {m.role === "owner" ? (
                      "Protected owner"
                    ) : (
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Remove ${m.email} from this organization?`,
                            )
                          )
                            void change(m.id, null);
                        }}
                      >
                        Remove access
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
