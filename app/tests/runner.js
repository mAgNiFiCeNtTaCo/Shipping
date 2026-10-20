// Tiny test runner for the browser suites.
// A suite is app/tests/<name>.test.js and exports `tests`: { "what it checks": async () => { ... } }.
// Throw (or use the helpers below) to fail. tools/test.py runs every suite in headless Edge.

export function ok(value, msg = "expected a truthy value") {
  if (!value) throw new Error(msg);
}

export function eq(actual, expected, msg = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ? msg + ": " : ""}expected ${e}, got ${a}`);
}

export function near(actual, expected, tol = 0.001, msg = "") {
  if (Math.abs(actual - expected) > tol) throw new Error(`${msg ? msg + ": " : ""}expected ~${expected}, got ${actual}`);
}

export async function throws(fn, msg = "expected an error") {
  try { await fn(); } catch { return; }
  throw new Error(msg);
}

export const SUITES = ["harness", "data", "render", "ui", "e2e"];

export async function runSuites(names, log) {
  let passed = 0, failed = 0;
  for (const name of names) {
    let mod;
    try {
      mod = await import(`./${name}.test.js`);
    } catch (e) {
      // A suite that doesn't exist yet is skipped; one that fails to load is a failure.
      if (String(e).match(/Failed to fetch|404|Importing a module script failed/i)) { log(`SKIP ${name}: no suite file yet`); continue; }
      failed++; log(`FAIL ${name}: suite did not load: ${e}`); continue;
    }
    for (const [title, fn] of Object.entries(mod.tests || {})) {
      try {
        await fn();
        passed++; log(`ok   ${name} > ${title}`);
      } catch (e) {
        failed++; log(`FAIL ${name} > ${title}: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
      }
    }
  }
  return { passed, failed };
}
