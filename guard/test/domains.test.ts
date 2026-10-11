import { expect, test } from "bun:test";
import { checkUrl, extractTargets, loadBlocklist, parseBlocklist } from "../src/domains";

const list = loadBlocklist();

test("blocked-domains.txt parses and covers every category", () => {
  expect(list.length).toBeGreaterThan(150);
  for (const r of ["no-money", "no-real-consequences", "no-contacting-as-leo"]) {
    expect(list.some((e) => e.rule === r)).toBeTrue();
  }
});

test("a host matches itself and subdomains, not lookalikes", () => {
  expect(checkUrl("https://ig.com", list)?.rule).toBe("no-money");
  expect(checkUrl("https://www.ig.com/uk", list)?.rule).toBe("no-money");
  expect(checkUrl("https://big.com", list)).toBeNull();
  expect(checkUrl("https://gov.uk.example.com", list)).toBeNull();
  expect(checkUrl("https://notgov.uk", list)).toBeNull();
});

test("path rules only block the matching paths", () => {
  expect(checkUrl("https://www.amazon.co.uk/dp/B000", list)).toBeNull();
  expect(checkUrl("https://www.amazon.co.uk/gp/cart/view.html", list)?.rule).toBe("no-money");
  expect(checkUrl("https://www.southampton.ac.uk/courses/fees/pay.page", list)?.rule).toBe("no-real-consequences");
  expect(checkUrl("https://www.southampton.ac.uk/courses/fees.page", list)).toBeNull();
  expect(checkUrl("https://moodle.ecs.soton.ac.uk/course/view.php?id=1", list)).toBeNull();
});

test("hosts are normalised", () => {
  expect(checkUrl("HTTPS://WWW.GOV.UK./", list)?.rule).toBe("no-real-consequences");
  expect(checkUrl("www.gov.uk", list)?.rule).toBe("no-real-consequences");
  expect(checkUrl("https://user:pw@www.gov.uk:443/x", list)?.rule).toBe("no-real-consequences");
});

test("extractTargets finds URLs and bare hosts in free text", () => {
  const hosts = extractTargets("curl https://a.example.com/x && wget b.example.org/y; echo file.txt").map((t) => t.host);
  expect(hosts).toContain("a.example.com");
  expect(hosts).toContain("b.example.org");
});

test("malformed lines are rejected", () => {
  expect(() => parseBlocklist("example.com no-such-rule")).toThrow();
  expect(() => parseBlocklist("* no-money")).toThrow();
});
