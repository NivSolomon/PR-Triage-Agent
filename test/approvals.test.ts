import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalError, ApprovalService, actionMarker } from "../src/approvals/service.js";
import { renderApprovalCard, renderOutcome } from "../src/approvals/render.js";
import { GitHubError } from "../src/github/client.js";
import { ActionRepository } from "../src/store/actions.js";
import { openDatabase } from "../src/store/db.js";

const APPROVER = "slack:U01";
const OUTSIDER = "slack:U02";

function setup(overrides: { postComment?: ReturnType<typeof vi.fn>; findComment?: ReturnType<typeof vi.fn> } = {}) {
  const github = {
    getPrSummary: vi.fn(async (n: number) => ({
      number: n,
      title: "Fix login",
      sourceUrl: `https://github.com/acme/app/pull/${n}`,
    })),
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

const proposal = {
  prNumber: 7,
  body: "CI is failing on unit tests; please fix before review.",
  reason: "unit check is red since yesterday",
  requestedBy: "slack:U03",
  via: "slack",
};

describe("propose", () => {
  it("stores a pending action and does NOT write to GitHub", async () => {
    const { service, github } = setup();
    const a = await service.propose(proposal);
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

  it("stores nothing when the PR does not exist", async () => {
    const { service, github } = setup();
    github.getPrSummary.mockRejectedValueOnce(new GitHubError("Not found", 404));
    await expect(service.propose(proposal)).rejects.toThrow(GitHubError);
    expect(service.listPending()).toHaveLength(0);
  });

  it("caps how many actions can wait for approval", async () => {
    const { service } = setup();
    for (let i = 0; i < 20; i += 1) await service.propose(proposal);
    await expect(service.propose(proposal)).rejects.toMatchObject({ code: "too_many_pending" });
  });
});

describe("approve", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it("posts exactly the stored text (plus marker) once approved by an approver", async () => {
    const a = await ctx.service.propose(proposal);
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
    const a = await ctx.service.propose(proposal);
    await expect(ctx.service.approve(a.id, OUTSIDER)).rejects.toMatchObject({
      code: "not_authorized",
    });
    expect(ctx.github.postComment).not.toHaveBeenCalled();
    expect(ctx.service.get(a.id)?.status).toBe("pending");
  });

  it("runs only once when approved twice at the same time", async () => {
    const a = await ctx.service.propose(proposal);
    const results = await Promise.allSettled([
      ctx.service.approve(a.id, APPROVER),
      ctx.service.approve(a.id, APPROVER),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(ctx.github.postComment).toHaveBeenCalledTimes(1);
  });

  it("does not run an expired action", async () => {
    const a = await ctx.service.propose(proposal);
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
    const a = await service.propose(proposal);
    const rejected = await service.reject(a.id, APPROVER);
    expect(rejected.status).toBe("rejected");
    await expect(service.approve(a.id, APPROVER)).rejects.toMatchObject({ code: "not_pending" });
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("is also limited to approvers", async () => {
    const { service } = setup();
    const a = await service.propose(proposal);
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
    const a = await service.propose(proposal);
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
    const a = await service.propose(proposal);
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
    const a = await service.propose(proposal);
    const done = await service.approve(a.id, APPROVER);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/No matching comment/);
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
    const a = await service.propose(proposal);
    const done = await service.approve(a.id, APPROVER);
    expect(done.status).toBe("uncertain");
    expect(renderOutcome(done)).toMatch(/check/i);
  });
});

describe("approval card", () => {
  it("shows the approver what, where, the exact text, why, who and when", async () => {
    const { service } = setup();
    const a = await service.propose(proposal);
    const card = renderApprovalCard(a);
    expect(card).toContain("pull request #7");
    expect(card).toContain("https://github.com/acme/app/pull/7");
    expect(card).toContain(`> ${proposal.body}`);
    expect(card).toContain(proposal.reason);
    expect(card).toContain("slack:U03");
    expect(card).toContain("Expires");
  });
});

describe("approve with an edit by the approver", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  const posted = (): string => (ctx.github.postComment.mock.calls[0] as [number, string])[1];

  it("posts the approver's corrected text, not the draft, and keeps the draft for the record", async () => {
    const a = await ctx.service.propose(proposal);
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
    const a = await ctx.service.propose(proposal);
    const done = await ctx.service.approve(a.id, APPROVER, { editedBody: `  ${proposal.body}\n` });
    expect(done.originalBody).toBeNull();
    expect(posted().startsWith(proposal.body)).toBe(true);
  });

  it("only an approver can edit: anyone else changes nothing and nothing is posted", async () => {
    const a = await ctx.service.propose(proposal);
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
    const a = await ctx.service.propose(proposal);
    await expect(ctx.service.approve(a.id, APPROVER, { editedBody: "   " })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(ctx.service.approve(a.id, APPROVER, { editedBody: "x".repeat(2001) })).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(ctx.github.postComment).not.toHaveBeenCalled();
    expect(ctx.service.get(a.id)).toMatchObject({ status: "pending", body: proposal.body, originalBody: null });
    expect((await ctx.service.approve(a.id, APPROVER)).status).toBe("executed");
  });

  it("two approvers racing with different texts: exactly one comment, and it is the winner's text", async () => {
    const a = await ctx.service.propose(proposal);
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
    const a = await ctx.service.propose(proposal);
    await ctx.service.approve(a.id, APPROVER);
    await expect(ctx.service.approve(a.id, APPROVER, { editedBody: "Too late" })).rejects.toMatchObject({
      code: "not_pending",
    });
    expect(ctx.service.get(a.id)).toMatchObject({ body: proposal.body, originalBody: null });
    expect(ctx.github.postComment).toHaveBeenCalledTimes(1);
  });

  it("an edit cannot revive an expired request", async () => {
    const a = await ctx.service.propose(proposal);
    ctx.advance(61_000);
    await expect(ctx.service.approve(a.id, APPROVER, { editedBody: "Late edit" })).rejects.toMatchObject({
      code: "not_pending",
    });
    expect(ctx.service.get(a.id)?.body).toBe(proposal.body);
    expect(ctx.github.postComment).not.toHaveBeenCalled();
  });

  it("the card and the outcome tell the truth about an edit", async () => {
    const a = await ctx.service.propose(proposal);
    const done = await ctx.service.approve(a.id, APPROVER, { editedBody: "Better wording" });
    expect(renderOutcome(done)).toMatch(/Posted your edited comment/);
    const card = renderApprovalCard(done);
    expect(card).toContain("Edited by the approver");
    expect(card).toContain(`| ${proposal.body}`);
    // An unedited one says nothing about edits.
    const b = await ctx.service.propose(proposal);
    const plain = await ctx.service.approve(b.id, APPROVER);
    expect(renderApprovalCard(plain)).not.toContain("Edited by the approver");
    expect(renderOutcome(plain)).toMatch(/Posted the comment/);
  });

  it("an edited comment that fails to post keeps both texts on the record", async () => {
    const failing = setup({ postComment: vi.fn(async () => { throw new GitHubError("Forbidden", 403); }) });
    const a = await failing.service.propose(proposal);
    const done = await failing.service.approve(a.id, APPROVER, { editedBody: "Edited but refused" });
    expect(done.status).toBe("failed");
    expect(done).toMatchObject({ body: "Edited but refused", originalBody: proposal.body });
  });
});