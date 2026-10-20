import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalError, ApprovalService, actionMarker } from "../src/approvals/service.js";
import { renderApprovalCard, renderOutcome } from "../src/approvals/render.js";
import { GitHubError } from "../src/github/client.js";
import { ActionRepository } from "../src/store/actions.js";
import { openDatabase } from "../src/store/db.js";

const APPROVER = "telegram:1";
const OUTSIDER = "telegram:2";

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
  requestedBy: "telegram:3",
  via: "telegram",
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
    expect(renderOutcome(done)).toMatch(/NOT posted/);
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
    expect(card).toContain("telegram:3");
    expect(card).toContain("Expires");
  });
});
