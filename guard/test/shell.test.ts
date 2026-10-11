import { expect, test } from "bun:test";
import { SUBST } from "../src/paths";
import { parseShell, unwrap } from "../src/shell";

const words = (s: string) => parseShell(s).map((c) => c.words);

test("splits compound commands", () => {
  expect(words("a 1 && b 2 || c; d | e & f")).toEqual([["a", "1"], ["b", "2"], ["c"], ["d"], ["e"], ["f"]]);
});

test("handles quotes and escapes", () => {
  expect(words(`echo 'a b' "c \\"d\\"" e\\ f`)).toEqual([["echo", "a b", 'c "d"', "e f"]]);
});

test("finds commands inside substitutions, backticks and subshells", () => {
  expect(words("echo $(rm -rf x) `ls y` (cd z; pwd)")).toEqual([["rm", "-rf", "x"], ["ls", "y"], ["echo", SUBST, SUBST], ["cd", "z"], ["pwd"]]);
  expect(words(`echo "pre $(touch q) post"`)).toEqual([["touch", "q"], ["echo", `pre ${SUBST} post`]]);
});

test("records redirections", () => {
  const [c] = parseShell("cmd > out.txt 2>&1 >> log < in");
  expect(c!.words).toEqual(["cmd"]);
  expect(c!.redirects).toEqual([
    { op: ">", target: "out.txt" },
    { op: ">>", target: "log" },
    { op: "<", target: "in" },
  ]);
  expect(parseShell("x &> all")[0]!.redirects).toEqual([{ op: "&>", target: "all" }]);
});

test("captures heredoc bodies and keeps parsing after them", () => {
  const cmds = parseShell("cat > f <<'EOF'\nrm -rf /\nEOF\necho done");
  expect(cmds.map((c) => c.words)).toEqual([["cat"], ["echo", "done"]]);
  expect(cmds[0]!.heredocs).toEqual(["rm -rf /"]);
});

test("ignores comments", () => {
  expect(words("ls # rm -rf ~")).toEqual([["ls"]]);
});

test("unwrap strips assignments and wrappers", () => {
  expect(unwrap(["FOO=1", "env", "-i", "BAR=2", "nice", "-n", "5", "nohup", "timeout", "5", "/bin/rm", "x"])).toEqual(["/bin/rm", "x"]);
});
