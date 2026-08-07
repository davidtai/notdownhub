import { describe, it, expect } from "vitest";
import {
  getRuns,
  getAttempts,
  getJobs,
  getTimeline,
  getAgents,
  removeAgent,
  getJobLogs,
  getConfig,
  getJoinInfo,
  getArtifacts,
  artifactDownloadUrl,
  getWorkflowDefinition,
  getRunLastActivity,
  deleteProjectRuns,
  probeDeleteProjectSupport,
} from "./api";
import { mockFetch, routes } from "../test/helpers";

describe("plain JSON getters", () => {
  it("hit their endpoints and return the parsed body", async () => {
    const fn = mockFetch(
      routes({
        "/workflow/runs?page=": [{ id: 1 }],
        "/attempts": [{ id: 2, attempt: 1 }],
        "/jobs": [{ jobId: "j1" }],
        "/Timeline/tl-1": [{ id: "r1" }],
      }),
    );
    expect(await getRuns()).toEqual([{ id: 1 }]);
    expect(await getAttempts(5)).toEqual([{ id: 2, attempt: 1 }]);
    expect(await getJobs(5, 1)).toEqual([{ jobId: "j1" }]);
    expect(await getTimeline("tl-1")).toEqual([{ id: "r1" }]);
    // getRuns accepts an explicit page too.
    await getRuns(2);
    expect(fn).toHaveBeenCalled();
  });

  it("throws with a helpful message on a non-OK response", async () => {
    mockFetch(() => ({ status: 500 }));
    await expect(getRuns()).rejects.toThrow(/500/);
  });
});

describe("getAgents", () => {
  it("unwraps a bare array", async () => {
    mockFetch(routes({ "/api/local/agents": [{ id: 1, name: "a" }] }));
    expect(await getAgents()).toEqual([{ id: 1, name: "a" }]);
  });

  it("unwraps an OData-ish { value } envelope", async () => {
    mockFetch(routes({ "/api/local/agents": { value: [{ id: 2 }] } }));
    expect(await getAgents()).toEqual([{ id: 2 }]);
  });

  it("treats a missing value as empty", async () => {
    mockFetch(routes({ "/api/local/agents": {} }));
    expect(await getAgents()).toEqual([]);
  });

  it("treats a null body as empty", async () => {
    mockFetch(routes({ "/api/local/agents": { body: null } }));
    expect(await getAgents()).toEqual([]);
  });
});

describe("removeAgent", () => {
  it("issues a DELETE to /_apis/v1/Agent/{poolId}/{agentId}", async () => {
    const fn = mockFetch(routes({ "/_apis/v1/Agent/1/7": { status: 204 } }));
    await removeAgent(1, 7);
    expect(fn).toHaveBeenCalledWith("/_apis/v1/Agent/1/7", { method: "DELETE" });
  });

  it("throws with the status on a non-OK response", async () => {
    mockFetch(routes({ "/_apis/v1/Agent/1/7": { status: 403 } }));
    await expect(removeAgent(1, 7)).rejects.toThrow(/403/);
  });
});

describe("getJobLogs", () => {
  it("returns retained lines on success", async () => {
    mockFetch(routes({ "/api/local/joblogs/": { retained: true, lines: ["a", "b"] } }));
    expect(await getJobLogs(1, "tl")).toEqual({ retained: true, lines: ["a", "b"] });
  });

  it("coerces a non-array lines field to empty and defaults retained", async () => {
    mockFetch(routes({ "/api/local/joblogs/": { lines: "nope" } }));
    expect(await getJobLogs(1, "tl")).toEqual({ retained: false, lines: [] });
  });

  it("reports not-retained on a non-OK response", async () => {
    mockFetch(routes({ "/api/local/joblogs/": { status: 404 } }));
    expect(await getJobLogs(1, "tl")).toEqual({ retained: false, lines: [] });
  });

  it("swallows a network error", async () => {
    mockFetch(routes({ "/api/local/joblogs/": { throw: true } }));
    expect(await getJobLogs(1, "tl")).toEqual({ retained: false, lines: [] });
  });
});

describe("getConfig", () => {
  it("passes through provided fields", async () => {
    mockFetch(
      routes({
        "/api/local/config": {
          backend: "keychain",
          secrets: [{ scope: "global", name: "TOKEN" }],
          vars: [{ scope: "global", name: "X", value: "1" }],
        },
      }),
    );
    const cfg = await getConfig();
    expect(cfg.backend).toBe("keychain");
    expect(cfg.secrets).toHaveLength(1);
    expect(cfg.vars).toHaveLength(1);
  });

  it("supplies defaults for an empty payload", async () => {
    mockFetch(routes({ "/api/local/config": {} }));
    expect(await getConfig()).toEqual({ backend: "unknown", secrets: [], vars: [] });
  });
});

describe("getArtifacts", () => {
  it("returns a run's artifacts (bare array)", async () => {
    mockFetch(routes({ "/api/local/artifacts/4": [{ id: 5, name: "my-artifact", size: 158 }] }));
    expect(await getArtifacts(4)).toEqual([{ id: 5, name: "my-artifact", size: 158 }]);
  });

  it("unwraps an OData { value: [...] } envelope", async () => {
    mockFetch(routes({ "/api/local/artifacts/4": { body: { value: [{ id: 6, name: "a", size: 1 }] } } }));
    expect(await getArtifacts(4)).toEqual([{ id: 6, name: "a", size: 1 }]);
  });

  it("returns [] when the run has no artifacts or the endpoint errors", async () => {
    mockFetch(routes({ "/api/local/artifacts/9": [] }));
    expect(await getArtifacts(9)).toEqual([]);
    mockFetch(routes({ "/api/local/artifacts/9": { status: 403 } }));
    expect(await getArtifacts(9)).toEqual([]);
    mockFetch(routes({ "/api/local/artifacts/9": { throw: true } }));
    expect(await getArtifacts(9)).toEqual([]);
  });
});

describe("artifactDownloadUrl", () => {
  it("builds a same-origin URL with the name url-encoded", () => {
    expect(artifactDownloadUrl(4, "my-artifact")).toBe("/api/local/artifacts/4/my-artifact");
    expect(artifactDownloadUrl(4, "cover report/x")).toBe("/api/local/artifacts/4/cover%20report%2Fx");
  });
});

describe("getWorkflowDefinition", () => {
  it("returns the latest attempt's YAML and timeline id", async () => {
    mockFetch(
      routes({
        "/attempts": [
          { id: 1, attempt: 1, workflow: "old", timeLineId: "t1" },
          { id: 1, attempt: 2, workflow: "new", timeLineId: "t2" },
        ],
      }),
    );
    expect(await getWorkflowDefinition(1)).toEqual({ yaml: "new", timelineId: "t2" });
  });

  it("returns nulls when there are no attempts", async () => {
    mockFetch(routes({ "/attempts": [] }));
    expect(await getWorkflowDefinition(1)).toEqual({ yaml: null, timelineId: null });
  });

  it("returns nulls when the attempt carries no workflow/timeline", async () => {
    mockFetch(routes({ "/attempts": [{ id: 1, attempt: 1 }] }));
    expect(await getWorkflowDefinition(1)).toEqual({ yaml: null, timelineId: null });
  });

  it("swallows a fetch failure", async () => {
    mockFetch(() => ({ status: 500 }));
    expect(await getWorkflowDefinition(1)).toEqual({ yaml: null, timelineId: null });
  });
});

describe("getRunLastActivity", () => {
  it("returns the widest finish across the latest attempt's job timelines", async () => {
    mockFetch((url) => {
      if (/attempt\/\d+\/jobs/.test(url)) return { body: [{ jobId: "j1", timeLineId: "job-1" }] };
      if (/\/attempts/.test(url)) return { body: [{ id: 1, attempt: 1, timeLineId: "t" }] };
      if (/Timeline\/job-1/.test(url))
        return { body: [{ type: "Job", startTime: "2020-01-01T00:00:00Z", finishTime: "2020-01-01T00:00:05Z" }] };
      return undefined;
    });
    expect(await getRunLastActivity(1)).toBe("2020-01-01T00:00:05.000Z");
  });

  it("returns null when there are no attempts", async () => {
    mockFetch(routes({ "/attempts": [] }));
    expect(await getRunLastActivity(1)).toBeNull();
  });

  it("tolerates a timeline fetch failing (per-job catch)", async () => {
    mockFetch((url) => {
      if (/attempt\/\d+\/jobs/.test(url)) return { body: [{ jobId: "j1", timeLineId: "job-1" }] };
      if (/\/attempts/.test(url)) return { body: [{ id: 1, attempt: 1, timeLineId: "t" }] };
      if (/Timeline\//.test(url)) return { throw: true };
      return undefined;
    });
    // No timeline records → no span → null, not a throw.
    expect(await getRunLastActivity(1)).toBeNull();
  });

  it("swallows an attempts fetch failure", async () => {
    mockFetch(() => ({ status: 500 }));
    expect(await getRunLastActivity(1)).toBeNull();
  });
});

describe("probeDeleteProjectSupport", () => {
  it("is true when the OPTIONS probe resolves with a non-404 status (backend present)", async () => {
    const fn = mockFetch(routes({ "/api/local/runs": { status: 204 } }));
    expect(await probeDeleteProjectSupport()).toBe(true);
    expect(fn).toHaveBeenCalledWith(
      "/api/local/runs",
      expect.objectContaining({ method: "OPTIONS" }),
    );
  });

  it("treats a 405 (route exists, method not allowed) as present", async () => {
    mockFetch(routes({ "/api/local/runs": { status: 405 } }));
    expect(await probeDeleteProjectSupport()).toBe(true);
  });

  it("is false when the route 404s (backend absent, pre-#60)", async () => {
    mockFetch(routes({ "/api/local/runs": { status: 404 } }));
    expect(await probeDeleteProjectSupport()).toBe(false);
  });

  it("is false on a network error", async () => {
    mockFetch(routes({ "/api/local/runs": { throw: true } }));
    expect(await probeDeleteProjectSupport()).toBe(false);
  });
});

describe("deleteProjectRuns", () => {
  it("issues a DELETE against the project runs endpoint and reports ok", async () => {
    const fn = mockFetch(routes({ "/api/local/runs": { status: 200 } }));
    expect(await deleteProjectRuns("acme/widget")).toEqual({ ok: true, status: 200 });
    // owner/repo is URL-encoded in the query.
    expect(fn).toHaveBeenCalledWith(
      "/api/local/runs?project=acme%2Fwidget",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("reports the status when the endpoint is absent (404, pre-#60)", async () => {
    mockFetch(routes({ "/api/local/runs": { status: 404 } }));
    expect(await deleteProjectRuns("x/y")).toEqual({ ok: false, status: 404 });
  });

  it("returns status 0 on a network error", async () => {
    mockFetch(routes({ "/api/local/runs": { throw: true } }));
    expect(await deleteProjectRuns("x/y")).toEqual({ ok: false, status: 0 });
  });
});

describe("getJoinInfo", () => {
  it("returns info to an authorized caller", async () => {
    mockFetch(
      routes({
        "/api/local/join-info": { host: "h", port: 4949, token: "t", authEnabled: true },
      }),
    );
    const r = await getJoinInfo();
    expect(r).toEqual({ ok: true, info: { host: "h", port: 4949, token: "t", authEnabled: true } });
  });

  it("returns the status when the hub declines (403)", async () => {
    mockFetch(routes({ "/api/local/join-info": { status: 403 } }));
    expect(await getJoinInfo()).toEqual({ ok: false, status: 403 });
  });

  it("returns status 0 on a network error", async () => {
    mockFetch(routes({ "/api/local/join-info": { throw: true } }));
    expect(await getJoinInfo()).toEqual({ ok: false, status: 0 });
  });
});
