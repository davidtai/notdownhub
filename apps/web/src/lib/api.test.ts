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
