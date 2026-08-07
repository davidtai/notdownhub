import { test } from "node:test";
import assert from "node:assert/strict";
import { labelMatch, parseWorkflowInfo } from "../workflowinfo.js";

const FULL = `
name: CI
on:
  push:
    branches: [main, "release/*"]
  pull_request:
    branches: main
    types: [opened, synchronize]
  schedule:
    - cron: "0 0 * * *"
  workflow_dispatch:
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
  test:
    runs-on: [self-hosted, linux]
    steps: [{ run: "true" }]
  grouped:
    runs-on:
      group: big
      labels: [gpu]
    steps: [{ run: "true" }]
  dyn:
    runs-on: \${{ matrix.os }}
    steps: [{ run: "true" }]
`;

test("parseWorkflowInfo: name, event summaries, branch union, distinct runs-on across jobs", () => {
  const info = parseWorkflowInfo(FULL);
  assert.equal(info.ok, true);
  assert.equal(info.name, "CI");
  assert.equal(info.jobCount, 4);
  assert.deepEqual(info.events, [
    "push",
    "pull_request (opened, synchronize)",
    "schedule (0 0 * * *)",
    "workflow_dispatch",
  ]);
  assert.deepEqual(info.branches, ["main", "release/*"]);
  assert.deepEqual(info.runsOn, ["ubuntu-latest", "self-hosted", "linux", "gpu", "${{ matrix.os }}"]);
});

test("parseWorkflowInfo: scalar and list `on:` forms", () => {
  const scalar = parseWorkflowInfo("on: push\njobs: { a: { runs-on: x } }");
  assert.deepEqual(scalar.events, ["push"]);
  const list = parseWorkflowInfo("on: [push, pull_request]\njobs: { a: { runs-on: x } }");
  assert.deepEqual(list.events, ["push", "pull_request"]);
  assert.equal(list.name, null);
});

test("parseWorkflowInfo: YAML 1.1 boolean-coerced `on` key (true) is still read", () => {
  const info = parseWorkflowInfo("true: push\njobs: { a: { runs-on: x } }");
  assert.deepEqual(info.events, ["push"]);
});

test("parseWorkflowInfo: honest failures — bad YAML, non-map, no jobs, empty jobs", () => {
  assert.match(parseWorkflowInfo(": {[").error ?? "", /not valid YAML/);
  assert.match(parseWorkflowInfo("- just\n- a list").error ?? "", /top level/);
  assert.match(parseWorkflowInfo("name: X").error ?? "", /no jobs/);
  assert.match(parseWorkflowInfo("jobs: {}").error ?? "", /empty/);
  assert.equal(parseWorkflowInfo("jobs: {}").ok, false);
});

test("parseWorkflowInfo: tolerates a null job body and no on: block", () => {
  const info = parseWorkflowInfo("jobs:\n  a:\n");
  assert.equal(info.ok, true);
  assert.deepEqual(info.events, []);
  assert.deepEqual(info.runsOn, []);
});

test("labelMatch: fleet match, hosted default mapping, dynamic expressions, honest misses", () => {
  const fleet = ["self-hosted", "Linux", "X64"];
  assert.equal(labelMatch("linux", fleet), "match"); // case-insensitive
  assert.equal(labelMatch("ubuntu-latest", fleet), "hosted"); // default -P sends it to self-hosted
  assert.equal(labelMatch("ubuntu-latest", ["gpu"]), "none"); // no self-hosted runner at all
  assert.equal(labelMatch("${{ matrix.os }}", fleet), "dynamic");
  assert.equal(labelMatch("windows-2022", fleet), "none");
});
