// The pure part of the workflow lint (tools/workflow-lint.mjs): which runner a
// job gets when a third-party bot set it off. No I/O, so every rule has a
// test.
//
// The rule (lead 2026-10-27 11:40): renovate's and dependabot's code runs on
// GitHub's hosted runners or on `kosche-ci-ephemeral`, the ARC label whose pod
// runs one job and is deleted (kosche-hq/infra, arc.yaml), and on no other
// self-hosted runner: not kosche-ci, not a bay, not a Mac. A bot's job is
// one a bot's pull request or branch push can start; code on main got there
// through review and is not the bots' any more.
//
// It fails closed (lead 2026-10-27 14:0x): a job counts as reaching a
// persistent runner unless the lint proves it does not.
//
// - A workflow_run counts as a bot's whenever a bot's run can trigger it;
//   whether it then reads the triggering head is not something to guess.
// - A `runs-on:` or `if:` expression is evaluated for every bot and every
//   event that can carry a bot's code, over the set of values it can take.
//   Only what is fixed for every such run is known: the event's name, the
//   actor (the bot, also on a re-run) and, on a pull request, its author.
//   Everything else is UNKNOWN and takes every value: branch names and
//   refs (a bot picks them), organisation variables (anyone with admin sets
//   them), the fork flag, matrix values, functions. A runner that is
//   UNKNOWN fails, because the lint has to prove the runner and not guess it.
// - A job that calls a reusable workflow is the callee's jobs: a local
//   callee (`./.github/workflows/x.yml`) is read and checked with the
//   caller's events; a callee in another repository is refused, except this
//   repository's own on main, whose `workflow_call` workflows are checked
//   here as if any bot's event called them.

export const BOTS = ["dependabot[bot]", "renovate[bot]"];
export const EPHEMERAL = "kosche-ci-ephemeral";
const HOSTED = /^(ubuntu|macos|windows)-[\w.-]+$/;

const UNKNOWN = Symbol("unknown");

/** A label a bot's job may run on. */
export function allowedLabel(label) {
  return label === EPHEMERAL || HOSTED.test(label);
}

/**
 * The events of a workflow that can run a bot's code: every pull request,
 * and a push or workflow_run unless its `branches` names only main or master.
 * A reusable workflow (`workflow_call`) counts as both a pull request and a
 * push, since any caller may be a bot's. `on` may be a string, a list or a map; YAML 1.1 readers turn the key into
 * `true`, so the caller passes whichever it found.
 */
export function botEvents(on) {
  const map =
    typeof on === "string"
      ? { [on]: null }
      : Array.isArray(on)
        ? Object.fromEntries(on.map((e) => [e, null]))
        : on && typeof on === "object"
          ? on
          : {};
  const events = [];
  for (const [event, spec] of Object.entries(map)) {
    if (["pull_request", "pull_request_target", "merge_group"].includes(event)) {
      events.push(event);
    } else if (event === "workflow_call") {
      events.push("pull_request", "push");
    } else if (event === "push" || event === "workflow_run") {
      const branches = spec && typeof spec === "object" ? spec.branches : undefined;
      const tagsOnly =
        event === "push" && spec && typeof spec === "object" && spec.tags !== undefined && branches === undefined;
      const mainOnly =
        Array.isArray(branches) && branches.length > 0 && branches.every((b) => b === "main" || b === "master");
      if (!tagsOnly && !mainOnly) events.push(event);
    }
  }
  return uniq(events);
}

/**
 * The github context a bot's run has, for one event: only what is fixed for
 * every such run. A key that is not here is UNKNOWN when read.
 */
export function botContext(bot, event) {
  const user = { login: bot, type: "Bot" };
  return {
    actor: bot,
    event_name: event,
    event: event.startsWith("pull_request") ? { pull_request: { user } } : { pull_request: null },
  };
}

// --- expressions -----------------------------------------------------------

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:('(?:[^']|'')*')|(\|\||&&|==|!=|<=|>=|[!()<>,\[\].])|([A-Za-z_][\w-]*)|(\d+(?:\.\d+)?))/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) throw new Error(`cannot read the expression at "${src.slice(i)}"`);
    i = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ t: "str", v: m[1].slice(1, -1).replaceAll("''", "'") });
    else if (m[2] !== undefined) tokens.push({ t: "op", v: m[2] });
    else if (m[3] !== undefined) tokens.push({ t: "id", v: m[3] });
    else tokens.push({ t: "num", v: Number(m[4]) });
  }
  return tokens;
}

function truthy(v) {
  return v === UNKNOWN ? [true, false] : [v !== null && v !== false && v !== "" && v !== 0 && v !== undefined];
}

function uniq(values) {
  const seen = new Map();
  for (const v of values) seen.set(typeof v === "string" ? `s:${v}` : v, v);
  return [...seen.values()];
}

// GitHub's coercion for == and != when the types differ: null is 0, a
// boolean is 0 or 1, a string is its number ("" is 0, text is NaN), and an
// array or object is NaN. NaN equals nothing.
function toNumber(v) {
  if (v === null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v.trim() === "" ? 0 : Number(v);
  return NaN;
}

function equal(a, b) {
  if (a === UNKNOWN || b === UNKNOWN) return [true, false];
  if (typeof a === "string" && typeof b === "string") return [a.toLowerCase() === b.toLowerCase()];
  if (typeof a === typeof b && (a === null || typeof a !== "object")) return [a === b];
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") return [a === b];
  return [toNumber(a) === toNumber(b)];
}

function lookup(root, path) {
  let v = root;
  for (const key of path) {
    if (v === UNKNOWN) return UNKNOWN;
    if (v === null || v === undefined) return null;
    if (typeof v !== "object" || !(key in v)) return UNKNOWN;
    v = v[key];
  }
  return v === undefined ? null : v;
}

/**
 * Every value `src` (the inside of `${{ }}`) can take for a run whose github
 * context is `github`. Any other context (`vars`, `matrix`, `inputs`) is
 * UNKNOWN.
 */
export function evaluate(src, github) {
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p];
  const take = (v) => {
    const tok = tokens[p];
    if (!tok || tok.v !== v) throw new Error(`expected "${v}" in ${src}`);
    p++;
  };

  function or() {
    let left = and();
    while (peek()?.v === "||") {
      p++;
      const right = and();
      left = uniq(left.flatMap((a) => (a === UNKNOWN ? [UNKNOWN, ...right] : truthy(a)[0] ? [a] : right)));
    }
    return left;
  }
  function and() {
    let left = cmp();
    while (peek()?.v === "&&") {
      p++;
      const right = cmp();
      left = uniq(left.flatMap((a) => (a === UNKNOWN ? [UNKNOWN, ...right] : truthy(a)[0] ? right : [a])));
    }
    return left;
  }
  function cmp() {
    const left = unary();
    const op = peek()?.v;
    if (op === "==" || op === "!=") {
      p++;
      const right = unary();
      return uniq(
        left.flatMap((a) => right.flatMap((b) => equal(a, b).map((e) => (op === "==" ? e : !e)))),
      );
    }
    if (op === "<" || op === ">" || op === "<=" || op === ">=") {
      p++;
      unary();
      return [UNKNOWN];
    }
    return left;
  }
  function unary() {
    if (peek()?.v === "!") {
      p++;
      return uniq(unary().flatMap((v) => truthy(v).map((t) => !t)));
    }
    return primary();
  }
  function primary() {
    const tok = tokens[p++];
    if (!tok) throw new Error(`the expression ends early: ${src}`);
    if (tok.v === "(") {
      const v = or();
      take(")");
      return v;
    }
    if (tok.t === "str" || tok.t === "num") return [tok.v];
    if (tok.t !== "id") throw new Error(`unexpected "${tok.v}" in ${src}`);
    if (tok.v === "true") return [true];
    if (tok.v === "false") return [false];
    if (tok.v === "null") return [null];
    if (peek()?.v === "(") {
      p++;
      const args = [];
      while (peek()?.v !== ")") {
        args.push(or());
        if (peek()?.v === ",") p++;
        else break;
      }
      take(")");
      if (tok.v === "always" || tok.v === "success") return [true];
      return [UNKNOWN];
    }
    const path = [tok.v];
    while (peek()?.v === "." || peek()?.v === "[") {
      if (tokens[p++].v === ".") {
        const key = tokens[p++];
        if (!key || key.t !== "id") throw new Error(`expected a name after "." in ${src}`);
        path.push(key.v);
      } else {
        const key = tokens[p++];
        take("]");
        path.push(key && key.t === "str" ? key.v : "*");
      }
    }
    if (path[0] === "github" && !path.includes("*")) return [lookup(github, path.slice(1))];
    return [UNKNOWN];
  }

  const v = or();
  if (p !== tokens.length) throw new Error(`unexpected "${tokens[p].v}" in ${src}`);
  return v;
}

/** The values a field can take: a whole `${{ }}` is evaluated, plain text is itself. */
function values(field, github) {
  if (typeof field !== "string") return [field];
  const whole = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(field);
  if (whole && !whole[1].includes("}}")) return evaluate(whole[1], github);
  if (field.includes("${{")) return [UNKNOWN];
  return [field];
}

/** Why one possible `runs-on` value is not a bot's runner, or null when it is. */
function refuse(value) {
  if (value === UNKNOWN) return "a runner the lint cannot work out";
  if (typeof value === "string") return allowedLabel(value) ? null : `"${value}"`;
  if (Array.isArray(value)) {
    const bad = value.filter((l) => typeof l !== "string" || !allowedLabel(l));
    return bad.length === 0 && value.length > 0 ? null : `[${value.join(", ")}]`;
  }
  if (value && typeof value === "object") return value.group ? `the runner group "${value.group}"` : refuse(value.labels ?? null);
  return `${JSON.stringify(value)}`;
}

// The org's own reusable workflows: checked in this repository's CI under
// every bot event (botEvents counts workflow_call as both), so a call to one
// on main is proved there.
const OWN_CALLEE = /^kosche-hq\/\.github\/\.github\/workflows\/[\w.-]+\.ya?ml@main$/;

/** Every bot job's problems for one job map, following local callees. */
function lintJobs(jobs, github, event, bot, load, seen, prefix) {
  const problems = [];
  for (const [name, job] of Object.entries(jobs)) {
    const where = `${prefix}job ${name}`;
    if (!job || typeof job !== "object") continue;
    try {
      if (job.if !== undefined) {
        const cond = typeof job.if === "string" && !job.if.includes("${{") ? `\${{ ${job.if} }}` : job.if;
        if (!values(cond, github).some((v) => truthy(v).includes(true))) continue;
      }
      if (job.uses !== undefined) {
        problems.push(...lintCall(job.uses, where, github, event, bot, load, seen));
        continue;
      }
      const bad = uniq(values(job["runs-on"], github))
        .map(refuse)
        .filter((r) => r !== null);
      if (bad.length > 0) problems.push(`${where}, ${event} by ${bot}: runs on ${bad.join(" or ")}`);
    } catch (err) {
      problems.push(`${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return problems;
}

/** A job's call of a reusable workflow: the callee's jobs, or refused. */
function lintCall(uses, where, github, event, bot, load, seen) {
  if (typeof uses === "string" && OWN_CALLEE.test(uses)) return [];
  if (typeof uses !== "string" || !uses.startsWith("./")) {
    return [`${where}, ${event} by ${bot}: calls ${JSON.stringify(uses)}, whose runners the lint cannot see`];
  }
  if (seen.includes(uses)) return [];
  const callee = load(uses.slice(2));
  if (!callee || typeof callee !== "object") return [`${where}: cannot read the called workflow ${uses}`];
  const jobs = callee.jobs && typeof callee.jobs === "object" ? callee.jobs : {};
  return lintJobs(jobs, github, event, bot, load, [...seen, uses], `${where} > ${uses} `);
}

/**
 * Every way a workflow lets a bot's job onto a runner it may not use, as
 * lines for a person. `workflow` is the parsed file, `on` its trigger map,
 * and `load(path)` reads a workflow by its path from the repository root
 * (for a local reusable call), or returns null.
 */
export function lintWorkflow(workflow, on, load = () => null) {
  const problems = [];
  const jobs = workflow && typeof workflow === "object" && workflow.jobs && typeof workflow.jobs === "object" ? workflow.jobs : {};
  for (const event of botEvents(on)) {
    for (const bot of BOTS) {
      problems.push(...lintJobs(jobs, botContext(bot, event), event, bot, load, [], ""));
    }
  }
  return uniq(problems);
}
