import assert from "node:assert/strict";
import { test } from "node:test";
import { createRepo } from "../src/git/repos.js";
import {
  DEFAULT_LABELS,
  addLabel,
  listLabels,
  removeLabel,
  validLabelNames,
} from "../src/repo/labels.js";
import { uniqueName } from "./helpers.js";

test("new repos are seeded with the default labels", async () => {
  const repo = await createRepo("alice", uniqueName("lbl"));
  const names = listLabels(repo.slug).map((l) => l.name).sort();
  assert.deepEqual(names, DEFAULT_LABELS.map((l) => l.name).sort());
});

test("labels can be added and removed; names validated against the set", async () => {
  const repo = await createRepo("alice", uniqueName("lbl"));

  await addLabel(repo.slug, "urgent", "#ff0000");
  assert.ok(listLabels(repo.slug).some((l) => l.name === "urgent"));

  // adding a duplicate (case-insensitive) is a no-op
  const before = listLabels(repo.slug).length;
  await addLabel(repo.slug, "URGENT", "#00ff00");
  assert.equal(listLabels(repo.slug).length, before);

  // validLabelNames filters out unknown labels
  assert.deepEqual(validLabelNames(repo.slug, ["urgent", "nope", "bug"]).sort(), ["bug", "urgent"]);

  await removeLabel(repo.slug, "urgent");
  assert.ok(!listLabels(repo.slug).some((l) => l.name === "urgent"));
});
