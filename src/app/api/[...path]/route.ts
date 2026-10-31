import { productionApi } from "@/lib/production-api";
import { financialJournalApi } from "@/lib/financial-journal-api";
import { feedApi } from "@/lib/feed-api";
import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { pool, tenant, audit } from "@/lib/db";
import {
  cookieName,
  createSession,
  sessionUser,
  hashPassword,
  verifyPassword,
  tokenHash,
  dummyPassword,
} from "@/lib/auth";
import { credentials, orgInput, farmInput, id } from "@/lib/validation";
import {
  checkOrigin,
  errorResponse,
  fail,
  jsonBody,
  rateLimit,
  applicationOrigin,
} from "@/lib/http";
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
async function handler(request: NextRequest) {
  try {
    const path = request.nextUrl.pathname.slice(5);
    const method = request.method;
    if (method !== "GET") checkOrigin(request);
    if (path === "auth/register" || path === "auth/login") {
      if (method !== "POST") fail(405, "Method not allowed.");
      rateLimit("auth-global");
      const input = credentials.parse(await jsonBody(request));
      rateLimit(`email:${input.email}`);
      let user: { id: string; email: string };
      if (path === "auth/register") {
        const hash = await hashPassword(input.password);
        const r = await pool.query(
          "INSERT INTO users(email,password_hash) VALUES($1,$2) ON CONFLICT(email) DO NOTHING RETURNING id,email",
          [input.email, hash],
        );
        if (!r.rows[0])
          fail(400, "Unable to create this account. Try signing in.");
        user = r.rows[0];
      } else {
        const r = await pool.query(
          "SELECT id,email,password_hash FROM users WHERE email=$1",
          [input.email],
        );
        const valid = await verifyPassword(
          input.password,
          r.rows[0]?.password_hash ?? dummyPassword,
        );
        if (!valid || !r.rows[0]) fail(401, "Email or password is incorrect.");
        user = r.rows[0];
      }
      const token = await createSession(user.id);
      const response = NextResponse.json({
        user: { id: user.id, email: user.email },
      });
      response.cookies.set(cookieName, token, {
        httpOnly: true,
        sameSite: "lax",
        secure: new URL(applicationOrigin(request)).protocol === "https:",
        path: "/",
        maxAge: 604800,
      });
      return response;
    }
    const token = request.cookies.get(cookieName)?.value;
    const user = await sessionUser(token);
    if (!user) fail(401, "Please sign in to continue.");
    const financial = await financialJournalApi(request, user, path);
    if (financial) return financial;
    if (path === "auth/logout" && method === "POST") {
      await pool.query("DELETE FROM sessions WHERE token_hash=$1", [
        tokenHash(token!),
      ]);
      const response = NextResponse.json({ ok: true });
      response.cookies.delete(cookieName);
      return response;
    }
    if (path === "me" && method === "GET") {
      return NextResponse.json(
        await tenant(user.id, async (c) => ({
          user,
          organizations: (
            await c.query(
              "SELECT o.*,m.role FROM organizations o JOIN memberships m ON m.organization_id=o.id WHERE m.user_id=$1 ORDER BY o.created_at",
              [user.id],
            )
          ).rows,
        })),
      );
    }
    if (path === "organizations" && method === "POST") {
      const input = orgInput.parse(await jsonBody(request));
      return NextResponse.json(
        await tenant(user.id, async (c) => {
          const r = await c.query("SELECT create_organization($1) AS id", [
            input.name,
          ]);
          return r.rows[0];
        }),
        { status: 201 },
      );
    }
    if (path === "organizations/settings" && method === "POST") {
      const input = z
        .object({
          organizationId: id,
          name: z.string().trim().min(2).max(100),
          currency: z
            .string()
            .refine((v) => Intl.supportedValuesOf("currency").includes(v)),
          timezone: z
            .string()
            .refine(
              (v) =>
                v === "UTC" || Intl.supportedValuesOf("timeZone").includes(v),
            ),
        })
        .parse(await jsonBody(request));
      return NextResponse.json(
        await tenant(user.id, async (c) => {
          const r = await c.query(
            "UPDATE organizations SET name=$2,currency=$3,timezone=$4 WHERE id=$1 RETURNING id",
            [input.organizationId, input.name, input.currency, input.timezone],
          );
          if (!r.rowCount)
            fail(403, "Only an owner or administrator can update settings.");
          await audit(
            c,
            input.organizationId,
            "organization.settings_changed",
            input.organizationId,
          );
          return { ok: true };
        }),
      );
    }
    if (path === "farms" && method === "POST") {
      const input = farmInput.parse(await jsonBody(request));
      return NextResponse.json(
        await tenant(user.id, async (c) => {
          const r = await c.query(
            "INSERT INTO farms(organization_id,name,location,kind) VALUES($1,$2,$3,$4) RETURNING *",
            [input.organizationId, input.name, input.location, input.kind],
          );
          await audit(c, input.organizationId, "farm.created", r.rows[0].id);
          return r.rows[0];
        }),
        { status: 201 },
      );
    }
    if (path === "dashboard" && method === "GET") {
      const org = id.parse(request.nextUrl.searchParams.get("organizationId"));
      return NextResponse.json(
        await tenant(user.id, async (c) => {
          const membership = await c.query(
            "SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2",
            [org, user.id],
          );
          if (!membership.rowCount) fail(404, "Organization not found.");
          const farms = (
            await c.query(
              "SELECT * FROM farms WHERE organization_id=$1 ORDER BY created_at DESC",
              [org],
            )
          ).rows;
          const activity = (
            await c.query(
              "SELECT action,object_id,created_at FROM audit_logs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 12",
              [org],
            )
          ).rows;
          const summary = (
            await c.query(
              `WITH unit_totals AS (
 SELECT u.kind,(SELECT recorded_balance FROM production_population_balances b WHERE b.id=u.id) AS live,
 coalesce(sum(r.feed_kg),0) AS feed,coalesce(sum(r.eggs-r.cracked),0) AS eggs,
 coalesce((SELECT average_weight_g FROM effective_daily_records d WHERE d.unit_id=u.id AND d.average_weight_g IS NOT NULL ORDER BY recorded_on DESC LIMIT 1),u.initial_weight_g) AS weight
 FROM production_units u LEFT JOIN effective_daily_records r ON r.unit_id=u.id
 WHERE u.organization_id=$1 GROUP BY u.id
 ) SELECT coalesce(sum(live) FILTER(WHERE kind<>'catfish'),0)::int AS birds,
 coalesce(sum(live) FILTER(WHERE kind='catfish'),0)::int AS fish,
 coalesce(sum(live*weight/1000) FILTER(WHERE kind='catfish'),0)::text AS fish_biomass,
 coalesce(sum(feed),0)::text AS feed_kg,coalesce(sum(eggs),0)::int AS eggs FROM unit_totals`,
              [org],
            )
          ).rows[0];
          return { farms, activity, summary, role: membership.rows[0].role };
        }),
      );
    }
    const productionResponse = await productionApi(request, user, path);
    if (productionResponse) return productionResponse;
    const feedResponse = await feedApi(request, user, path);
    if (feedResponse) return feedResponse;
    fail(404, "This endpoint does not exist.");
  } catch (error) {
    return errorResponse(error);
  }
}
export const GET = handler;
export const POST = handler;
