import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { app } from "../../src/index";
import { setupAuth, createTestLink, apiRequest, type JsonBody } from "../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function api(method: string, path: string, opts: { headers?: Record<string, string>; body?: JsonBody } = {}) {
  return apiRequest(app, method, path, opts);
}

let seq = 0;
/** Unique identifier fragment — team slugs and link slugs are globally unique. */
function uniq(prefix: string): string {
  seq++;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

type Team = { id: string; name: string; slug: string };

/** Create a team through the API and return it. */
async function createTeam(headers: Record<string, string>, name = "Test Team"): Promise<Team> {
  const res = await api("POST", "/api/teams", { headers, body: { name, slug: uniq("team") } });
  expect(res.status).toBe(201);
  const json = await res.json() as { data: Team };
  return json.data;
}

/** Add a member row directly, bypassing the invite flow. */
async function addMember(teamId: string, userId: string, role: "admin" | "member" = "member") {
  await env.DB
    .prepare(`INSERT OR REPLACE INTO team_members (teamId, userId, role, joinedAt) VALUES (?, ?, ?, ?)`)
    .bind(teamId, userId, role, Math.floor(Date.now() / 1000))
    .run();
}

/** Insert an invite row directly so its expiry can be set in the past. */
async function insertInvite(
  teamId: string,
  email: string,
  opts: { token?: string; expiresAt?: number; role?: "admin" | "member" } = {}
) {
  const id = crypto.randomUUID();
  const token = opts.token ?? crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = opts.expiresAt ?? now + 7 * 24 * 3600;
  await env.DB
    .prepare(
      `INSERT INTO team_invites (id, teamId, email, role, token, expiresAt, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, teamId, email.toLowerCase(), opts.role ?? "member", token, expiresAt, now)
    .run();
  return { id, token, expiresAt };
}

async function inviteCount(teamId: string, email?: string): Promise<number> {
  const stmt = email
    ? env.DB.prepare("SELECT count(*) AS c FROM team_invites WHERE teamId = ? AND email = ?").bind(teamId, email.toLowerCase())
    : env.DB.prepare("SELECT count(*) AS c FROM team_invites WHERE teamId = ?").bind(teamId);
  const row = await stmt.first<{ c: number }>();
  return row?.c ?? 0;
}

/** A fresh authenticated user with a unique email. */
function newUser(label: string) {
  return setupAuth(env, { email: `${uniq(label)}@example.com` });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Teams API", () => {
  describe("POST /api/teams", () => {
    it("creates a team with the creator as admin", async () => {
      const auth = await newUser("creator");
      const slug = uniq("team");
      const res = await api("POST", "/api/teams", { headers: auth.headers, body: { name: "Acme", slug } });
      expect(res.status).toBe(201);
      const json = await res.json() as { data: Team };
      expect(json.data).toMatchObject({ name: "Acme", slug });

      const list = await api("GET", "/api/teams", { headers: auth.headers });
      const teams = await list.json() as { data: { id: string; role: string; memberCount: number }[] };
      const created = teams.data.find(t => t.id === json.data.id);
      expect(created).toBeDefined();
      expect(created!.role).toBe("admin");
      expect(created!.memberCount).toBe(1);
    });

    it("rejects a missing name", async () => {
      const auth = await newUser("noname");
      const res = await api("POST", "/api/teams", { headers: auth.headers, body: { slug: uniq("team") } });
      expect(res.status).toBe(400);
    });

    it("rejects a duplicate slug with 409", async () => {
      const auth = await newUser("dupe");
      const slug = uniq("team");
      await api("POST", "/api/teams", { headers: auth.headers, body: { name: "First", slug } });
      const res = await api("POST", "/api/teams", { headers: auth.headers, body: { name: "Second", slug } });
      expect(res.status).toBe(409);
    });

    it("requires authentication", async () => {
      const res = await api("POST", "/api/teams", { body: { name: "x", slug: uniq("team") } });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/teams", () => {
    it("lists only teams the user belongs to", async () => {
      const owner = await newUser("owner");
      const stranger = await newUser("stranger");
      const team = await createTeam(owner.headers);

      const res = await api("GET", "/api/teams", { headers: stranger.headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { id: string }[] };
      expect(json.data.some(t => t.id === team.id)).toBe(false);
    });
  });

  describe("GET /api/teams/:id", () => {
    it("returns members for a member", async () => {
      const admin = await newUser("admin");
      const member = await newUser("member");
      const team = await createTeam(admin.headers);
      await addMember(team.id, member.user.id);

      const res = await api("GET", `/api/teams/${team.id}`, { headers: member.headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { members: { userId: string; role: string }[]; inviteCount: number } };
      expect(json.data.members).toHaveLength(2);
      expect(json.data.members.find(m => m.userId === admin.user.id)!.role).toBe("admin");
      expect(json.data.inviteCount).toBe(0);
    });

    it("returns 404 for a non-member", async () => {
      const admin = await newUser("admin");
      const stranger = await newUser("stranger");
      const team = await createTeam(admin.headers);

      const res = await api("GET", `/api/teams/${team.id}`, { headers: stranger.headers });
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/teams/:id", () => {
    it("renames the team for an admin", async () => {
      const admin = await newUser("admin");
      const team = await createTeam(admin.headers);

      const res = await api("PUT", `/api/teams/${team.id}`, { headers: admin.headers, body: { name: "Renamed" } });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { name: string } };
      expect(json.data.name).toBe("Renamed");
    });

    it("returns 403 for a non-admin member", async () => {
      const admin = await newUser("admin");
      const member = await newUser("member");
      const team = await createTeam(admin.headers);
      await addMember(team.id, member.user.id);

      const res = await api("PUT", `/api/teams/${team.id}`, { headers: member.headers, body: { name: "Nope" } });
      expect(res.status).toBe(403);
    });

    it("returns 404 for a non-member", async () => {
      const admin = await newUser("admin");
      const stranger = await newUser("stranger");
      const team = await createTeam(admin.headers);

      const res = await api("PUT", `/api/teams/${team.id}`, { headers: stranger.headers, body: { name: "Nope" } });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/teams/:id", () => {
    it("deletes the team for an admin and nulls the team's links", async () => {
      const admin = await newUser("admin");
      const team = await createTeam(admin.headers);
      const link = await createTestLink(env.DB, { userId: admin.user.id, slug: uniq("tl"), teamId: team.id });

      const res = await api("DELETE", `/api/teams/${team.id}`, { headers: admin.headers });
      expect(res.status).toBe(200);

      const row = await env.DB.prepare("SELECT teamId FROM links WHERE id = ?").bind(link.id).first<{ teamId: string | null }>();
      expect(row?.teamId).toBeNull();
    });

    it("returns 403 for a non-admin member", async () => {
      const admin = await newUser("admin");
      const member = await newUser("member");
      const team = await createTeam(admin.headers);
      await addMember(team.id, member.user.id);

      const res = await api("DELETE", `/api/teams/${team.id}`, { headers: member.headers });
      expect(res.status).toBe(403);
    });
  });

  describe("invites", () => {
    it("creates, lists and cancels an invite", async () => {
      const admin = await newUser("admin");
      const team = await createTeam(admin.headers);
      const email = `invitee-${uniq("i")}@example.com`;

      const created = await api("POST", `/api/teams/${team.id}/invite`, { headers: admin.headers, body: { email, role: "admin" } });
      expect(created.status).toBe(201);
      const createdJson = await created.json() as { data: { id: string; token: string; role: string; email: string } };
      expect(createdJson.data.role).toBe("admin");
      expect(createdJson.data.email).toBe(email.toLowerCase());

      const list = await api("GET", `/api/teams/${team.id}/invites`, { headers: admin.headers });
      expect(list.status).toBe(200);
      const listJson = await list.json() as { data: { id: string; token: string }[] };
      expect(listJson.data).toHaveLength(1);
      // The token is what the admin needs to re-copy the invite link.
      expect(listJson.data[0].token).toBe(createdJson.data.token);

      const cancelled = await api("DELETE", `/api/teams/${team.id}/invites/${createdJson.data.id}`, { headers: admin.headers });
      expect(cancelled.status).toBe(200);
      expect(await inviteCount(team.id)).toBe(0);
    });

    it("lowercases the invited email and rejects an invalid one", async () => {
      const admin = await newUser("admin");
      const team = await createTeam(admin.headers);

      const bad = await api("POST", `/api/teams/${team.id}/invite`, { headers: admin.headers, body: { email: "not-an-email" } });
      expect(bad.status).toBe(400);

      const res = await api("POST", `/api/teams/${team.id}/invite`, { headers: admin.headers, body: { email: "MiXeD@Example.com" } });
      const json = await res.json() as { data: { email: string } };
      expect(json.data.email).toBe("mixed@example.com");
    });

    it("rejects a duplicate pending invite with 409", async () => {
      const admin = await newUser("admin");
      const team = await createTeam(admin.headers);
      const email = `dup-${uniq("i")}@example.com`;

      await api("POST", `/api/teams/${team.id}/invite`, { headers: admin.headers, body: { email } });
      const res = await api("POST", `/api/teams/${team.id}/invite`, { headers: admin.headers, body: { email } });
      expect(res.status).toBe(409);
    });

    it("rejects inviting an existing member with 409", async () => {
      const admin = await newUser("admin");
      const member = await newUser("member");
      const team = await createTeam(admin.headers);
      await addMember(team.id, member.user.id);

      const res = await api("POST", `/api/teams/${team.id}/invite`, { headers: admin.headers, body: { email: member.user.email } });
      expect(res.status).toBe(409);
    });

    it("replaces an expired invite instead of returning 409 forever", async () => {
      const admin = await newUser("admin");
      const team = await createTeam(admin.headers);
      const email = `stale-${uniq("i")}@example.com`;
      const stale = await insertInvite(team.id, email, { expiresAt: Math.floor(Date.now() / 1000) - 60 });

      // The expired row is hidden from the list but still holds the unique (teamId, email) slot.
      const hidden = await api("GET", `/api/teams/${team.id}/invites`, { headers: admin.headers });
      expect((await hidden.json() as { data: unknown[] }).data).toHaveLength(0);

      const res = await api("POST", `/api/teams/${team.id}/invite`, { headers: admin.headers, body: { email } });
      expect(res.status).toBe(201);
      const json = await res.json() as { data: { id: string; token: string } };
      expect(json.data.id).not.toBe(stale.id);
      expect(await inviteCount(team.id, email)).toBe(1);

      const list = await api("GET", `/api/teams/${team.id}/invites`, { headers: admin.headers });
      const listJson = await list.json() as { data: { token: string }[] };
      expect(listJson.data.map(i => i.token)).toEqual([json.data.token]);
    });

    it("returns 404 when cancelling an invite from another team", async () => {
      const admin = await newUser("admin");
      const teamA = await createTeam(admin.headers);
      const teamB = await createTeam(admin.headers);
      const other = await insertInvite(teamB.id, `x-${uniq("i")}@example.com`);

      const res = await api("DELETE", `/api/teams/${teamA.id}/invites/${other.id}`, { headers: admin.headers });
      expect(res.status).toBe(404);
    });

    it("forbids a non-admin member from creating, listing or cancelling invites", async () => {
      const admin = await newUser("admin");
      const member = await newUser("member");
      const team = await createTeam(admin.headers);
      await addMember(team.id, member.user.id);
      const invite = await insertInvite(team.id, `x-${uniq("i")}@example.com`);

      const create = await api("POST", `/api/teams/${team.id}/invite`, { headers: member.headers, body: { email: "someone@example.com" } });
      expect(create.status).toBe(403);
      const list = await api("GET", `/api/teams/${team.id}/invites`, { headers: member.headers });
      expect(list.status).toBe(403);
      const cancel = await api("DELETE", `/api/teams/${team.id}/invites/${invite.id}`, { headers: member.headers });
      expect(cancel.status).toBe(403);
    });
  });

  describe("POST /api/teams/accept-invite", () => {
    it("adds the invited user and consumes the invite", async () => {
      const admin = await newUser("admin");
      const invitee = await newUser("invitee");
      const team = await createTeam(admin.headers);
      const invite = await insertInvite(team.id, invitee.user.email, { role: "admin" });

      const res = await api("POST", "/api/teams/accept-invite", { headers: invitee.headers, body: { token: invite.token } });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { teamId: string; team: { id: string } } };
      expect(json.data.teamId).toBe(team.id);
      expect(json.data.team.id).toBe(team.id);
      expect(await inviteCount(team.id)).toBe(0);

      const detail = await api("GET", `/api/teams/${team.id}`, { headers: invitee.headers });
      expect(detail.status).toBe(200);
      const detailJson = await detail.json() as { data: { members: { userId: string; role: string }[] } };
      expect(detailJson.data.members.find(m => m.userId === invitee.user.id)!.role).toBe("admin");
    });

    it("rejects an expired invite and deletes it", async () => {
      const admin = await newUser("admin");
      const invitee = await newUser("invitee");
      const team = await createTeam(admin.headers);
      const invite = await insertInvite(team.id, invitee.user.email, { expiresAt: Math.floor(Date.now() / 1000) - 60 });

      const res = await api("POST", "/api/teams/accept-invite", { headers: invitee.headers, body: { token: invite.token } });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toContain("expired");
      expect(await inviteCount(team.id)).toBe(0);
    });

    it("rejects an email mismatch with 403 and keeps the invite", async () => {
      const admin = await newUser("admin");
      const wrongUser = await newUser("wrong");
      const team = await createTeam(admin.headers);
      const invite = await insertInvite(team.id, `someone-else-${uniq("i")}@example.com`);

      const res = await api("POST", "/api/teams/accept-invite", { headers: wrongUser.headers, body: { token: invite.token } });
      expect(res.status).toBe(403);
      expect(await inviteCount(team.id)).toBe(1);
    });

    it("returns 404 for an unknown token and 400 for a missing one", async () => {
      const auth = await newUser("nobody");
      const missing = await api("POST", "/api/teams/accept-invite", { headers: auth.headers, body: {} });
      expect(missing.status).toBe(400);
      const unknown = await api("POST", "/api/teams/accept-invite", { headers: auth.headers, body: { token: "no-such-token" } });
      expect(unknown.status).toBe(404);
    });

    it("returns 409 when the user is already a member", async () => {
      const admin = await newUser("admin");
      const member = await newUser("member");
      const team = await createTeam(admin.headers);
      await addMember(team.id, member.user.id);
      const invite = await insertInvite(team.id, member.user.email);

      const res = await api("POST", "/api/teams/accept-invite", { headers: member.headers, body: { token: invite.token } });
      expect(res.status).toBe(409);
      expect(await inviteCount(team.id)).toBe(0);
    });
  });

  describe("membership", () => {
    it("lets a member leave", async () => {
      const admin = await newUser("admin");
      const member = await newUser("member");
      const team = await createTeam(admin.headers);
      await addMember(team.id, member.user.id);

      const res = await api("POST", `/api/teams/${team.id}/leave`, { headers: member.headers });
      expect(res.status).toBe(200);

      const after = await api("GET", `/api/teams/${team.id}`, { headers: member.headers });
      expect(after.status).toBe(404);
    });

    it("blocks the last admin from leaving", async () => {
      const admin = await newUser("admin");
      const member = await newUser("member");
      const team = await createTeam(admin.headers);
      await addMember(team.id, member.user.id);

      const res = await api("POST", `/api/teams/${team.id}/leave`, { headers: admin.headers });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toContain("last admin");
    });

    it("lets an admin leave once another admin exists", async () => {
      const admin = await newUser("admin");
      const second = await newUser("second");
      const team = await createTeam(admin.headers);
      await addMember(team.id, second.user.id, "admin");

      const res = await api("POST", `/api/teams/${team.id}/leave`, { headers: admin.headers });
      expect(res.status).toBe(200);
    });

    it("returns 404 when a non-member leaves", async () => {
      const admin = await newUser("admin");
      const stranger = await newUser("stranger");
      const team = await createTeam(admin.headers);

      const res = await api("POST", `/api/teams/${team.id}/leave`, { headers: stranger.headers });
      expect(res.status).toBe(404);
    });

    it("removes a member and cancels that member's outstanding invites", async () => {
      const admin = await newUser("admin");
      const member = await newUser("member");
      const team = await createTeam(admin.headers);
      await addMember(team.id, member.user.id);
      await insertInvite(team.id, member.user.email);

      const res = await api("DELETE", `/api/teams/${team.id}/members/${member.user.id}`, { headers: admin.headers });
      expect(res.status).toBe(200);
      expect(await inviteCount(team.id, member.user.email)).toBe(0);

      const after = await api("GET", `/api/teams/${team.id}`, { headers: member.headers });
      expect(after.status).toBe(404);
    });

    it("blocks removing the last admin and 404s an unknown member", async () => {
      const admin = await newUser("admin");
      const stranger = await newUser("stranger");
      const team = await createTeam(admin.headers);

      const self = await api("DELETE", `/api/teams/${team.id}/members/${admin.user.id}`, { headers: admin.headers });
      expect(self.status).toBe(400);

      const unknown = await api("DELETE", `/api/teams/${team.id}/members/${stranger.user.id}`, { headers: admin.headers });
      expect(unknown.status).toBe(404);
    });

    it("forbids a non-admin member from removing members", async () => {
      const admin = await newUser("admin");
      const member = await newUser("member");
      const team = await createTeam(admin.headers);
      await addMember(team.id, member.user.id);

      const res = await api("DELETE", `/api/teams/${team.id}/members/${admin.user.id}`, { headers: member.headers });
      expect(res.status).toBe(403);
    });

    it("promotes a member to admin", async () => {
      const admin = await newUser("admin");
      const member = await newUser("member");
      const team = await createTeam(admin.headers);
      await addMember(team.id, member.user.id);

      const res = await api("PATCH", `/api/teams/${team.id}/members/${member.user.id}`, { headers: admin.headers, body: { role: "admin" } });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { role: string; email: string } };
      expect(json.data.role).toBe("admin");
      expect(json.data.email).toBe(member.user.email);
    });

    it("blocks demoting the last admin", async () => {
      const admin = await newUser("admin");
      const member = await newUser("member");
      const team = await createTeam(admin.headers);
      await addMember(team.id, member.user.id);

      const res = await api("PATCH", `/api/teams/${team.id}/members/${admin.user.id}`, { headers: admin.headers, body: { role: "member" } });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toContain("last admin");
    });

    it("allows demotion once a second admin exists", async () => {
      const admin = await newUser("admin");
      const second = await newUser("second");
      const team = await createTeam(admin.headers);
      await addMember(team.id, second.user.id, "admin");

      const res = await api("PATCH", `/api/teams/${team.id}/members/${admin.user.id}`, { headers: admin.headers, body: { role: "member" } });
      expect(res.status).toBe(200);
      expect((await res.json() as { data: { role: string } }).data.role).toBe("member");
    });

    it("rejects an invalid role", async () => {
      const admin = await newUser("admin");
      const member = await newUser("member");
      const team = await createTeam(admin.headers);
      await addMember(team.id, member.user.id);

      const res = await api("PATCH", `/api/teams/${team.id}/members/${member.user.id}`, { headers: admin.headers, body: { role: "owner" } });
      expect(res.status).toBe(400);
    });
  });

  describe("team-scoped link access", () => {
    it("lets a team member read a link owned by another member", async () => {
      const owner = await newUser("owner");
      const member = await newUser("member");
      const team = await createTeam(owner.headers);
      await addMember(team.id, member.user.id);
      const link = await createTestLink(env.DB, { userId: owner.user.id, slug: uniq("team-link"), teamId: team.id });

      const res = await api("GET", `/api/links/${link.id}`, { headers: member.headers });
      expect(res.status).toBe(200);
      const json = await res.json() as { data: { id: string; teamId: string } };
      expect(json.data.id).toBe(link.id);
      expect(json.data.teamId).toBe(team.id);
    });

    it("hides a team link from a non-member", async () => {
      const owner = await newUser("owner");
      const stranger = await newUser("stranger");
      const team = await createTeam(owner.headers);
      const link = await createTestLink(env.DB, { userId: owner.user.id, slug: uniq("team-link"), teamId: team.id });

      const res = await api("GET", `/api/links/${link.id}`, { headers: stranger.headers });
      expect(res.status).toBe(404);
    });

    it("requires membership for ?teamId=", async () => {
      const owner = await newUser("owner");
      const stranger = await newUser("stranger");
      const member = await newUser("member");
      const team = await createTeam(owner.headers);
      await addMember(team.id, member.user.id);
      const link = await createTestLink(env.DB, { userId: owner.user.id, slug: uniq("team-link"), teamId: team.id });

      const denied = await api("GET", `/api/links?teamId=${team.id}`, { headers: stranger.headers });
      expect(denied.status).toBe(404);

      const allowed = await api("GET", `/api/links?teamId=${team.id}`, { headers: member.headers });
      expect(allowed.status).toBe(200);
      const json = await allowed.json() as { data: { id: string; teamName: string | null }[] };
      expect(json.data.map(l => l.id)).toContain(link.id);
      expect(json.data[0].teamName).toBe(team.name);
    });

    it("includes team links under scope=all but not by default", async () => {
      const owner = await newUser("owner");
      const member = await newUser("member");
      const team = await createTeam(owner.headers);
      await addMember(team.id, member.user.id);
      const teamLink = await createTestLink(env.DB, { userId: owner.user.id, slug: uniq("team-link"), teamId: team.id });
      const ownLink = await createTestLink(env.DB, { userId: member.user.id, slug: uniq("own-link") });

      const scoped = await api("GET", "/api/links?scope=all", { headers: member.headers });
      const scopedIds = (await scoped.json() as { data: { id: string }[] }).data.map(l => l.id);
      expect(scopedIds).toContain(teamLink.id);
      expect(scopedIds).toContain(ownLink.id);

      const personal = await api("GET", "/api/links", { headers: member.headers });
      const personalIds = (await personal.json() as { data: { id: string }[] }).data.map(l => l.id);
      expect(personalIds).toContain(ownLink.id);
      expect(personalIds).not.toContain(teamLink.id);
    });
  });
});
