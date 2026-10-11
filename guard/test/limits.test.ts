// One block per hard limit: every recorded hook input must be denied with
// that limit's rule id, and every allowed control must pass.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { formatReason } from "../src/rules";
import { loadCases, makeWorld, run } from "./helpers";

const w = makeWorld();
afterAll(() => rmSync(w.root, { recursive: true, force: true }));

for (const file of ["no-money", "no-real-consequences", "no-contacting-as-leo", "no-harm", "allowed"]) {
  describe(file, () => {
    for (const c of loadCases(`${file}.json`)) {
      test(c.name, () => {
        const d = run(w, c.input);
        if (c.expect === "allow") {
          expect(d ? formatReason(d) : null).toBeNull();
        } else {
          expect(d).not.toBeNull();
          expect(d!.rule).toBe(c.rule as any);
          const reason = formatReason(d!);
          expect(reason).toStartWith(`guard:${c.rule}: `);
          expect(reason).toContain("Safe alternative: ");
        }
      });
    }
  });
}

test("every limit has at least five denial fixtures", () => {
  for (const f of ["no-money", "no-real-consequences", "no-contacting-as-leo", "no-harm"]) {
    expect(loadCases(`${f}.json`).filter((c) => c.expect === "deny").length).toBeGreaterThanOrEqual(5);
  }
});
