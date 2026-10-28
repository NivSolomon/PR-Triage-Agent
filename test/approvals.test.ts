import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalError, ApprovalService, actionMarker } from "../src/approvals/service.js";
import { renderApprovalCard, renderOutcome } from "../src/approvals/render.js";
import { GitHubError } from "../src/github/client.js";
import type { ActionRecord } from "../src/store/actions.js";
import { ActionRepository } from "../src/store/actions.js";
import { openDatabase } from "../src/store/db.js";

// Tests for ApprovalService: a comment is only proposed first, and posted to GitHub
// only after an approver approves it. GitHub is faked; the DB is in memory.

const APPROVER = "slack:U01"; // the only identity isApprover() accepts
const OUTSIDER = "slack:U02"; // a valid user who may not decide

// Builds the service with a fake GitHub and a controllable clock (advance(ms) moves time forward).
function setup(overrides: { postComment?: ReturnType<typeof vi.fn>; findComment?: ReturnType<typeof vi.fn>; onRetired?: (records: ActionRecord[]) => void } = {}) {
  const github = {
    getPrSummary: vi.fn(
      async (
        n: number,
      ): Promise<{
        number: number;
        title: string;
        sourceUrl: string;
        state?: "open" | "closed";
        merged?: boolean;
        locked?: boolean;
      }> => ({
        number: n,
        title: "Fix login",
        sourceUrl: `https://github.com/acme/app/pull/${n}`,
        state: "open",
        locked: false,
      }),
    ),
    postComment:
      overrides.postComment ??
      vi.fn(async () => ({ id: 1, url: "https://github.com/acme/app/pull/7#issuecomment-1" })),
    findCommentWithMarker: overrides.findComment ?? vi.fn(async () => null),
  };
  let clock = new Date("2026-10-20T10:00:00Z");
  let counter = 0;
  const repo = new ActionRepository(openDatabase(":memory:"));
  const service = new ApprovalService({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    github: github as any,
    repo,
    isApprover: (id) => id === APPROVER,
    now: () => clock,
    newId: () => `id-${++counter}`,
    ttlMs: 60_000,
    onRetired: overrides.onRetired,
  });
  return {
    github,
    repo,
    service,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

// A valid proposal; tests override single fields.
const proposal = {
  prNumber: 7,
  body: "CI is failing on unit tests; please fix before review.",
  reason: "unit check is red since yesterday",
  requestedBy: "slack:U03",
  via: "slack",
};

// Proposes and returns just the stored record.
const rec = async (s: ApprovalService, over: Partial<typeof proposal> = {}) =>
  (await s.propose({ ...proposal, ...over })).record;

describe("propose", () => {
  it("stores a pending action and does NOT write to GitHub", async () => {
    const { service, github } = setup();
    const a = await rec(service);
    expect(a.status).toBe("pending");
    expect(a.prTitle).toBe("Fix login");
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("rejects empty and oversized comments", async () => {
    const { service } = setup();
    await expect(service.propose({ ...proposal, body: "  " })).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(service.propose({ ...proposal, body: "x".repeat(2001) })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("strips HTML comments so they cannot hide the audit footer", async () => {
    const { service } = setup();
    const a = await rec(service, { body: "Please fix CI. <!-- hidden -->Still visible." });
    expect(a.body).toBe("Please fix CI. Still visible.");
    await expect(service.propose({ ...proposal, body: "<!-- only a comment" })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("stores nothing when the PR does not exist", async () => {
    const { service, github } = setup();
    github.getPrSummary.mockRejectedValueOnce(new GitHubError("Not found", 404));
    await expect(service.propose(proposal)).rejects.toThrow(GitHubError);
    expect(service.listPending()).toHaveLength(0);
  });

  it("caps how many actions can wait for approval", async () => {
    const { service } = setup();
    for (let i = 0; i < 20; i += 1) await rec(service, { prNumber: i + 1, requestedBy: `slack:U${i}` });
    await expect(service.propose(proposal)).rejects.toMatchObject({ code: "too_many_pending" });
  });

  it("a second comment from the same person on the same PR withdraws the first draft", async () => {
    const { service, github } = setup();
    const first = await rec(service, { body: "Great job on this pull request." });
    const second = await service.propose({ ...proposal, body: "Well Done!" });
    expect(second.replaced).toHaveLength(1);
    expect(second.replaced[0]?.id).toBe(first.id);
    expect(service.get(first.id)?.status).toBe("superseded");
    expect(second.record.status).toBe("pending");
    expect(service.listPending()).toHaveLength(1);
    expect(service.listPending()[0]?.body).toBe("Well Done!");
    await expect(service.approve(first.id, APPROVER)).rejects.toMatchObject({ code: "not_pending" });
    expect(github.postComment).not.toHaveBeenCalled();
    const posted = await service.approve(second.record.id, APPROVER);
    expect(posted.status).toBe("executed");
    expect(github.postComment).toHaveBeenCalledTimes(1);
    expect(String(github.postComment.mock.calls[0]?.[1])).toContain("Well Done!");
    expect(renderOutcome(service.get(first.id)!)).toMatch(/replaced by a newer request/i);
  });

  it("does not withdraw someone else's pending comment on the same PR", async () => {
    const { service } = setup();
    const mine = await rec(service, { requestedBy: "web:lee" });
    const theirs = await rec(service, { requestedBy: "web:dana", body: "Please add tests." });
    expect(service.get(mine.id)?.status).toBe("pending");
    expect(service.get(theirs.id)?.status).toBe("pending");
    expect(service.listPending()).toHaveLength(2);
  });

  it("does not withdraw the same person's pending comment on a different PR", async () => {
    const { service } = setup();
    const a = await rec(service, { prNumber: 4 });
    const b = await rec(service, { prNumber: 7, body: "Well Done!" });
    expect(service.get(a.id)?.status).toBe("pending");
    expect(service.get(b.id)?.status).toBe("pending");
  });
});

describe("approve", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("posts exactly the stored text (plus marker) once approved by an approver", async () => {
    const a = await rec(ctx.service);
    const done = await ctx.service.approve(a.id, APPROVER);

    expect(done.status).toBe("executed");
    expect(done.decidedBy).toBe(APPROVER);
    expect(done.resultUrl).toContain("issuecomment");
    expect(ctx.github.postComment).toHaveBeenCalledTimes(1);
    const [pr, text] = ctx.github.postComment.mock.calls[0] as [number, string];
    expect(pr).toBe(7);
    expect(text.startsWith(proposal.body)).toBe(true);
    expect(text).toContain(actionMarker(a.id));
  });

  it("refuses anyone who is not an approver, and posts nothing", async () => {
    const a = await rec(ctx.service);
    await expect(ctx.service.approve(a.id, OUTSIDER)).rejects.toMatchObject({
      code: "not_authorized",
    });
    expect(ctx.github.postComment).not.toHaveBeenCalled();
    expect(ctx.service.get(a.id)?.status).toBe("pending");
  });

  it("runs only once when approved twice at the same time", async () => {
    const a = await rec(ctx.service);
    const results = await Promise.allSettled([
      ctx.service.approve(a.id, APPROVER),
      ctx.service.approve(a.id, APPROVER),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(ctx.github.postComment).toHaveBeenCalledTimes(1);
  });

  it("does not run an expired action", async () => {
    const a = await rec(ctx.service);
    ctx.advance(61_000);
    await expect(ctx.service.approve(a.id, APPROVER)).rejects.toBeInstanceOf(ApprovalError);
    expect(ctx.github.postComment).not.toHaveBeenCalled();
  });

  it("reports an unknown id", async () => {
    await expect(ctx.service.approve("nope", APPROVER)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("reject", () => {
  it("prevents any later approval", async () => {
    const { service, github } = setup();
    const a = await rec(service);
    const rejected = await service.reject(a.id, APPROVER);
    expect(rejected.status).toBe("rejected");
    await expect(service.approve(a.id, APPROVER)).rejects.toMatchObject({ code: "not_pending" });
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("is also limited to approvers", async () => {
    const { service } = setup();
    const a = await rec(service);
    await expect(service.reject(a.id, OUTSIDER)).rejects.toMatchObject({ code: "not_authorized" });
  });
});

describe("failure halfway through an approved action", () => {
  it("marks a definite refusal (4xx) as failed and says nothing was posted", async () => {
    const { service, github } = setup({
      postComment: vi.fn(async () => {
        throw new GitHubError("GitHub refused the request (403).", 403);
      }),
    });
    const a = await rec(service);
    const done = await service.approve(a.id, APPROVER);
    expect(done.status).toBe("failed");
    expect(github.findCommentWithMarker).not.toHaveBeenCalled();
    expect(renderOutcome(done)).toMatch(/was not posted/);
  });

  it("detects that the comment DID land when the response was lost (no duplicate)", async () => {
    const { service, github } = setup({
      postComment: vi.fn(async () => {
        throw new GitHubError("Could not reach GitHub: timeout");
      }),
      findComment: vi.fn(async () => ({ id: 9, url: "https://github.com/acme/app/pull/7#issuecomment-9" })),
    });
    const a = await rec(service);
    const done = await service.approve(a.id, APPROVER);
    expect(done.status).toBe("executed");
    expect(done.resultUrl).toContain("issuecomment-9");
    expect(github.postComment).toHaveBeenCalledTimes(1);
    expect(github.findCommentWithMarker).toHaveBeenCalledWith(7, actionMarker(a.id), a.createdAt);
  });

  it("marks failed when the response was lost and no comment exists", async () => {
    const { service } = setup({
      postComment: vi.fn(async () => {
        throw new GitHubError("GitHub returned HTTP 502.", 502);
      }),
    });
    const a = await rec(service);
    const done = await service.approve(a.id, APPROVER);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/No matching comment/);
  });

  it("looks up the marker when the POST succeeded but the reply could not be parsed (no duplicate)", async () => {
    const { service, github } = setup({
      postComment: vi.fn(async () => {
        throw new Error("Unexpected end of JSON input");
      }),
      findComment: vi.fn(async () => ({ id: 9, url: "https://github.com/acme/app/pull/7#issuecomment-9" })),
    });
    const a = await rec(service);
    const done = await service.approve(a.id, APPROVER);
    expect(done.status).toBe("executed");
    expect(done.resultUrl).toContain("issuecomment-9");
    expect(github.postComment).toHaveBeenCalledTimes(1);
    expect(github.findCommentWithMarker).toHaveBeenCalledWith(7, actionMarker(a.id), a.createdAt);
  });

  it("marks uncertain when the response was lost and the follow-up lookup also fails", async () => {
    const { service } = setup({
      postComment: vi.fn(async () => {
        throw new GitHubError("Could not reach GitHub: timeout");
      }),
      findComment: vi.fn(async () => {
        throw new GitHubError("Could not reach GitHub: timeout");
      }),
    });
    const a = await rec(service);
    const done = await service.approve(a.id, APPROVER);
    expect(done.status).toBe("uncertain");
    expect(renderOutcome(done)).toMatch(/check/i);
  });

  it("refuses a new proposal on a PR that still has an unconfirmed post", async () => {
    const { service, github } = setup({
      postComment: vi.fn(async () => {
        throw new GitHubError("Could not reach GitHub: timeout");
      }),
      findComment: vi.fn(async () => {
        throw new GitHubError("Could not reach GitHub: timeout");
      }),
    });
    const a = await rec(service);
    expect((await service.approve(a.id, APPROVER)).status).toBe("uncertain");
    await expect(service.propose({ ...proposal, body: "Trying again" })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });
});

describe("approval card", () => {
  it("shows the approver what, where, the exact text, why, who and when", async () => {
    const { service } = setup();
    const a = await rec(service);
    const card = renderApprovalCard(a);
    expect(card).toContain("pull request #7");
    expect(card).toContain("https://github.com/acme/app/pull/7");
    expect(card).toContain(`> ${proposal.body}`);
    expect(card).toContain(proposal.reason);
    expect(card).toContain("slack:U03");
    expect(card).toContain("Expires");
  });

  it("warns when the draft @-mentions someone, and ignores an email address", async () => {
    const { service } = setup();
    const mentioned = (
      await service.propose({ ...proposal, body: "Please look at this @octocat" })
    ).record;
    expect(renderApprovalCard(mentioned)).toMatch(/@-mentions someone/);
    const emailed = (await service.propose({ ...proposal, prNumber: 8, body: "Write to dev@example.com" })).record;
    expect(renderApprovalCard(emailed)).not.toMatch(/@-mentions someone/);
  });
});

describe("approve with an edit by the approver", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  const posted = (): string => (ctx.github.postComment.mock.calls[0] as [number, string])[1];

  it("posts the approver's corrected text, not the draft, and keeps the draft for the record", async () => {
    const a = await rec(ctx.service);
    const done = await ctx.service.approve(a.id, APPROVER, { editedBody: "  Please re-run the unit tests.  " });

    expect(done.status).toBe("executed");
    expect(ctx.github.postComment).toHaveBeenCalledTimes(1);
    expect(posted().startsWith("Please re-run the unit tests.")).toBe(true);
    expect(posted()).not.toContain(proposal.body);
    expect(posted()).toContain(actionMarker(a.id));
    expect(done.body).toBe("Please re-run the unit tests.");
    expect(done.originalBody).toBe(proposal.body);
    expect(done.decidedBy).toBe(APPROVER);
  });

  it("is not an edit when the text is unchanged: no original is recorded", async () => {
    const a = await rec(ctx.service);
    const done = await ctx.service.approve(a.id, APPROVER, { editedBody: `  ${proposal.body}\n` });
    expect(done.originalBody).toBeNull();
    expect(posted().startsWith(proposal.body)).toBe(true);
  });

  it("only an approver can edit: anyone else changes nothing and nothing is posted", async () => {
    const a = await rec(ctx.service);
    await expect(ctx.service.approve(a.id, OUTSIDER, { editedBody: "Sneaky text" })).rejects.toMatchObject({
      code: "not_authorized",
    });
    const after = ctx.service.get(a.id);
    expect(after?.status).toBe("pending");
    expect(after?.body).toBe(proposal.body);
    expect(after?.originalBody).toBeNull();
    expect(ctx.github.postComment).not.toHaveBeenCalled();
  });

  it("refuses an empty or oversized edit, posts nothing, and the request stays pending and approvable", async () => {
    const a = await rec(ctx.service);
    await expect(ctx.service.approve(a.id, APPROVER, { editedBody: "   " })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(ctx.service.approve(a.id, APPROVER, { editedBody: "x".repeat(2001) })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(ctx.github.postComment).not.toHaveBeenCalled();
    expect(ctx.service.get(a.id)).toMatchObject({ status: "pending", body: proposal.body, originalBody: null });
    expect((await ctx.service.approve(a.id, APPROVER)).status).toBe("executed");
  });

  it("two approvers racing with different texts: exactly one comment, and it is the winner's text", async () => {
    const a = await rec(ctx.service);
    const results = await Promise.allSettled([
      ctx.service.approve(a.id, APPROVER, { editedBody: "Text from first" }),
      ctx.service.approve(a.id, APPROVER, { editedBody: "Text from second" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(ctx.github.postComment).toHaveBeenCalledTimes(1);
    const final = ctx.service.get(a.id);
    expect(final?.body).toMatch(/^Text from (first|second)$/);
    expect(posted().startsWith(final?.body ?? "?")).toBe(true);
    expect(final?.originalBody).toBe(proposal.body);
  });

  it("an edit cannot rewrite a request that was already decided", async () => {
    const a = await rec(ctx.service);
    await ctx.service.approve(a.id, APPROVER);
    await expect(ctx.service.approve(a.id, APPROVER, { editedBody: "Too late" })).rejects.toMatchObject({
      code: "not_pending",
    });
    expect(ctx.service.get(a.id)).toMatchObject({ body: proposal.body, originalBody: null });
    expect(ctx.github.postComment).toHaveBeenCalledTimes(1);
  });

  it("an edit cannot revive an expired request", async () => {
    const a = await rec(ctx.service);
    ctx.advance(61_000);
    await expect(ctx.service.approve(a.id, APPROVER, { editedBody: "Late edit" })).rejects.toMatchObject({
      code: "not_pending",
    });
    expect(ctx.service.get(a.id)?.body).toBe(proposal.body);
    expect(ctx.github.postComment).not.toHaveBeenCalled();
  });

  it("the card and the outcome tell the truth about an edit", async () => {
    const a = await rec(ctx.service);
    const done = await ctx.service.approve(a.id, APPROVER, { editedBody: "Better wording" });
    expect(renderOutcome(done)).toMatch(/Posted your edited comment/);
    const card = renderApprovalCard(done);
    expect(card).toContain("Edited by the approver");
    expect(card).toContain(`| ${proposal.body}`);
    // An unedited one says nothing about edits.
    const b = await rec(ctx.service);
    const plain = await ctx.service.approve(b.id, APPROVER);
    expect(renderApprovalCard(plain)).not.toContain("Edited by the approver");
    expect(renderOutcome(plain)).toMatch(/Posted the comment/);
  });

  it("an edited comment that fails to post keeps both texts on the record", async () => {
    const failing = setup({ postComment: vi.fn(async () => { throw new GitHubError("Forbidden", 403); }) });
    const a = await rec(failing.service);
    const done = await failing.service.approve(a.id, APPROVER, { editedBody: "Edited but refused" });
    expect(done.status).toBe("failed");
    expect(done).toMatchObject({ body: "Edited but refused", originalBody: proposal.body });
  });
});

describe("approve when the pull request is no longer open", () => {
  it("does not post on a closed or locked PR, and the request is marked failed", async () => {
    const { service, github } = setup();
    const a = await rec(service);
    github.getPrSummary.mockResolvedValue({
      number: 7,
      title: "Fix login",
      sourceUrl: "https://github.com/acme/app/pull/7",
      state: "closed",
      locked: false,
    });
    const done = await service.approve(a.id, APPROVER);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/is closed/);
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("does not post on a locked PR", async () => {
    const { service, github } = setup();
    const a = await rec(service);
    github.getPrSummary.mockResolvedValue({
      number: 7,
      title: "Fix login",
      sourceUrl: "https://github.com/acme/app/pull/7",
      state: "open",
      locked: true,
    });
    const done = await service.approve(a.id, APPROVER);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/locked/);
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("withdraws a pending request when the pull request is later closed, without waiting for an approver", async () => {
    const onRetired = vi.fn();
    const { service, github } = setup({ onRetired });
    const a = await rec(service);
    expect(service.listPending()).toHaveLength(1);
    github.getPrSummary.mockResolvedValue({
      number: 7,
      title: "Fix login",
      sourceUrl: "https://github.com/acme/app/pull/7",
      state: "closed",
      merged: true,
      locked: false,
    });
    const dropped = await service.dropStalePending();
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.status).toBe("failed");
    expect(dropped[0]?.error).toMatch(/is merged/);
    expect(service.listPending()).toHaveLength(0);
    expect(onRetired).toHaveBeenCalledWith([expect.objectContaining({ id: a.id, status: "failed" })]);
    expect(renderOutcome(service.get(a.id)!)).toMatch(/is merged/);
    expect(renderOutcome(service.get(a.id)!)).not.toMatch(/Approved, but/);
  });

  it("leaves a pending request alone while the pull request is still open", async () => {
    const { service, github } = setup();
    await rec(service);
    const dropped = await service.dropStalePending();
    expect(dropped).toHaveLength(0);
    expect(service.listPending()).toHaveLength(1);
    expect(github.getPrSummary).toHaveBeenCalled();
  });

  it("refuses to create a request on a closed PR", async () => {
    const { service, github } = setup();
    github.getPrSummary.mockResolvedValue({
      number: 7,
      title: "Fix login",
      sourceUrl: "https://github.com/acme/app/pull/7",
      state: "closed",
      locked: false,
    });
    await expect(service.propose(proposal)).rejects.toMatchObject({ code: "invalid_input" });
    expect(service.listPending()).toHaveLength(0);
  });
});

describe("recover interrupted posts after a crash", () => {
  it("marks executed when the marker is already on the PR, and never posts again", async () => {
    const { service, github, repo } = setup({
      findComment: vi.fn(async () => ({ id: 9, url: "https://github.com/acme/app/pull/7#issuecomment-9" })),
    });
    const a = await rec(service);
    expect(repo.claimForExecution(a.id, APPROVER, "2026-10-20T10:00:00Z")).toBe(true);
    const recovered = await service.recoverInterrupted();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.status).toBe("executed");
    expect(recovered[0]?.resultUrl).toContain("issuecomment-9");
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("marks failed when nothing was posted", async () => {
    const { service, repo } = setup();
    const a = await rec(service);
    repo.claimForExecution(a.id, APPROVER, "2026-10-20T10:00:00Z");
    const recovered = await service.recoverInterrupted();
    expect(recovered[0]?.status).toBe("failed");
    expect(recovered[0]?.error).toMatch(/Process restarted/);
  });

  it("marks uncertain when the marker lookup also fails", async () => {
    const { service, repo } = setup({
      findComment: vi.fn(async () => {
        throw new GitHubError("Could not reach GitHub: timeout");
      }),
    });
    const a = await rec(service);
    repo.claimForExecution(a.id, APPROVER, "2026-10-20T10:00:00Z");
    const recovered = await service.recoverInterrupted();
    expect(recovered[0]?.status).toBe("uncertain");
  });
});

describe("listRecent", () => {
  it("always includes pending requests even when later history would fill the cap", async () => {
    const { service } = setup();
    const old = await rec(service, { prNumber: 99, requestedBy: "slack:U99" });
    for (let i = 0; i < 20; i += 1) {
      const a = await rec(service, { prNumber: i + 1, requestedBy: `slack:U${i}` });
      await service.approve(a.id, APPROVER);
    }
    const recent = service.listRecent(20);
    expect(recent.some((a) => a.id === old.id && a.status === "pending")).toBe(true);
    expect(recent.filter((a) => a.status === "pending")).toHaveLength(1);
  });
});

describe("onRetired", () => {
  it("notifies when a request is rejected, replaced, or expires, so Slack cards can be updated", async () => {
    const onRetired = vi.fn();
    const github = {
      getPrSummary: vi.fn(async (n: number) => ({
        number: n,
        title: "Fix login",
        sourceUrl: `https://github.com/acme/app/pull/${n}`,
      })),
      postComment: vi.fn(async () => ({ id: 1, url: "https://github.com/acme/app/pull/7#issuecomment-1" })),
      findCommentWithMarker: vi.fn(async () => null),
    };
    let clock = new Date("2026-10-20T10:00:00Z");
    let counter = 0;
    const service = new ApprovalService({
      github: github as never,
      repo: new ActionRepository(openDatabase(":memory:")),
      isApprover: (id) => id === APPROVER,
      now: () => clock,
      newId: () => `id-${++counter}`,
      ttlMs: 60_000,
      onRetired,
    });
    const first = (await service.propose(proposal)).record;
    await service.reject(first.id, APPROVER);
    expect(onRetired).toHaveBeenCalled();
    expect(onRetired.mock.calls.at(-1)?.[0][0]).toMatchObject({ id: first.id, status: "rejected" });

    const a = (await service.propose(proposal)).record;
    const second = await service.propose({ ...proposal, body: "Well Done!" });
    expect(onRetired.mock.calls.at(-1)?.[0][0]).toMatchObject({ id: a.id, status: "superseded" });
    await service.reject(second.record.id, APPROVER);

    const expiring = (await service.propose({ ...proposal, prNumber: 9 })).record;
    clock = new Date(clock.getTime() + 61_000);
    expect(service.listPending().map((x) => x.id)).not.toContain(expiring.id);
    const last = onRetired.mock.calls.at(-1)?.[0] as Array<{ id: string; status: string }>;
    expect(last).toEqual([expect.objectContaining({ id: expiring.id, status: "expired" })]);
  });

  it("notifies when a comment is posted, so every Slack copy of the card can be closed", async () => {
    const onRetired = vi.fn();
    const github = {
      getPrSummary: vi.fn(async (n: number) => ({
        number: n,
        title: "Fix login",
        sourceUrl: `https://github.com/acme/app/pull/${n}`,
      })),
      postComment: vi.fn(async () => ({ id: 1, url: "https://github.com/acme/app/pull/7#issuecomment-1" })),
      findCommentWithMarker: vi.fn(async () => null),
    };
    const service = new ApprovalService({
      github: github as never,
      repo: new ActionRepository(openDatabase(":memory:")),
      isApprover: (id) => id === APPROVER,
      newId: () => "id-posted",
      onRetired,
    });
    const a = (await service.propose(proposal)).record;
    await service.approve(a.id, APPROVER);
    expect(onRetired.mock.calls.at(-1)?.[0][0]).toMatchObject({ id: a.id, status: "executed" });
  });
});