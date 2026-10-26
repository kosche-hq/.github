// The pure part of the scorecard (tools/scorecard.mjs): judging a measurement
// against a gate's budget, applying written exceptions, and comparing with a
// baseline. No I/O, so every rule has a test.

/** Lower is better for every numeric budget in standard/gates.json. */
export function judge(gate, value) {
  if (value === null || value === undefined) return "unmeasured";
  if (typeof gate.budget === "number")
    return Number(value) <= gate.budget ? "pass" : "fail";
  if (typeof gate.budget === "string" && typeof value === "boolean")
    return value ? "pass" : "fail";
  return "unmeasured";
}

/** Gates whose bigger number is better (a score or a level). */
const HIGHER_IS_BETTER = new Set(["lighthouse", "sbom", "provenance"]);

export function judgeFor(gate, value) {
  if (value === null || value === undefined) return "unmeasured";
  if (typeof gate.budget === "number" && HIGHER_IS_BETTER.has(gate.id)) {
    return Number(value) >= gate.budget ? "pass" : "fail";
  }
  return judge(gate, value);
}

/**
 * A written exception waives a gate while it has a reason and has not
 * expired (YYYY-MM-DD, compared as a date). Anything else is a problem the
 * scorecard reports instead of honouring.
 */
export function exceptionFor(exceptions, id, today) {
  const e = exceptions?.gates?.[id];
  if (e === undefined) return { waived: false };
  if (typeof e.reason !== "string" || e.reason.trim() === "")
    return { waived: false, problem: `${id}: exception has no reason` };
  if (typeof e.expires !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires))
    return { waived: false, problem: `${id}: exception has no expiry date` };
  if (e.expires < today)
    return {
      waived: false,
      problem: `${id}: exception expired on ${e.expires}`,
    };
  return { waived: true, reason: e.reason, expires: e.expires };
}

/**
 * Regressions against a baseline: a gate that passed and now fails, or a
 * numeric value that got worse, in the direction that gate counts as worse.
 * An unmeasured gate never regresses (it is not known).
 */
export function regressions(baseline, results, gates) {
  const byId = new Map(gates.map((g) => [g.id, g]));
  const before = new Map((baseline?.results ?? []).map((r) => [r.id, r]));
  const out = [];
  for (const r of results) {
    const b = before.get(r.id);
    if (!b || r.status === "unmeasured" || r.status === "waived") continue;
    if (b.status === "pass" && r.status === "fail") {
      out.push(`${r.id}: passed, now fails (${String(r.value)})`);
      continue;
    }
    const gate = byId.get(r.id);
    if (typeof r.value === "number" && typeof b.value === "number" && gate) {
      const worse = HIGHER_IS_BETTER.has(gate.id)
        ? r.value < b.value
        : r.value > b.value;
      if (worse) out.push(`${r.id}: ${String(b.value)} -> ${String(r.value)}`);
    }
  }
  return out;
}

/** Whether a gate applies to a repository of these kinds. */
export function applies(gate, kinds) {
  return gate.applies === "all" || kinds.includes(gate.applies);
}

/** One markdown table for the job summary. */
export function table(results) {
  const rows = results.map(
    (r) =>
      `| ${r.id} | ${r.status} | ${r.value ?? ""} | ${typeof r.budget === "object" ? JSON.stringify(r.budget) : r.budget} | ${r.note ?? ""} |`,
  );
  return (
    [
      "| gate | status | value | budget | note |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
    ].join("\n") + "\n"
  );
}
