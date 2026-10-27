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
// A workflow_run runs the default branch's workflow and checks out the
// default branch unless told otherwise, so it carries a bot's code only when
// it reads the triggering run's head (workflow_run.head_sha, head_branch,
// head_commit or pull_requests), which a checkout of that code needs.
//
// A `runs-on:` expression is evaluated for every bot and every event that can
// carry a bot's code, over the set of values it can take: an organisation
// variable may or may not be set, and anything the lint cannot know (a
// matrix value, an unknown context, an unknown function) is UNKNOWN, which
// fails, because the lint has to prove the runner and not guess it.

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
 * `on` may be a string, a list or a map; YAML 1.1 readers turn the key into
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
    } else if (event === "push" || event === "workflow_run") {
      const branches = spec && typeof spec === "object" ? spec.branches : undefined;
      const tagsOnly =
        event === "push" && spec && typeof spec === "object" && spec.tags !== undefined && branches === undefined;
      const mainOnly =
        Array.isArray(branches) && branches.length > 0 && branches.every((b) => b === "main" || b === "master");
      if (!tagsOnly && !mainOnly) events.push(event);
    }
  }
  return events;
}

/** The github context a bot's run has, for one event. */
export function botContext(bot, event) {
  const branch = `${bot.startsWith("renovate") ? "renovate" : "dependabot"}/npm/x`;
  const user = { login: bot, type: "Bot" };
  const pr = event.startsWith("pull_request")
    ? { user, head: { ref: branch, repo: { fork: false } }, base: { ref: "main" } }
    : null;
  return {
    actor: bot,
    triggering_actor: bot,
    event_name: event,
    ref: pr ? "refs/pull/1/merge" : `refs/heads/${branch}`,
    ref_name: pr ? "1/merge" : branch,
    head_ref: pr ? branch : "",
    event: { pull_request: pr, sender: user },
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

function equal(a, b) {
  if (a === UNKNOWN || b === UNKNOWN) return [true, false];
  if (typeof a === "string" && typeof b === "string") return [a.toLowerCase() === b.toLowerCase()];
  return [a === b];
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
 * context is `github`. `vars.*` is unset or set to a self-hosted label.
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
    if (path[0] === "github") return [lookup(github, path.slice(1))];
    if (path[0] === "vars" && path.length === 2) return [null, `vars.${path[1]}`];
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

/**
 * Every way a workflow lets a bot's job onto a runner it may not use, as
 * lines for a person. `workflow` is the parsed file, `on` its trigger map.
 */
export function lintWorkflow(workflow, on) {
  const problems = [];
  const jobs = workflow && typeof workflow === "object" && workflow.jobs && typeof workflow.jobs === "object" ? workflow.jobs : {};
  const readsHead = /workflow_run\.(head_sha|head_branch|head_commit|pull_requests)/.test(JSON.stringify(workflow));
  for (const event of botEvents(on).filter((e) => e !== "workflow_run" || readsHead)) {
    for (const bot of BOTS) {
      const github = botContext(bot, event);
      for (const [name, job] of Object.entries(jobs)) {
        if (!job || typeof job !== "object" || job.uses !== undefined) continue;
        try {
          if (job.if !== undefined) {
            const cond = typeof job.if === "string" && !job.if.includes("${{") ? `\${{ ${job.if} }}` : job.if;
            if (!values(cond, github).some((v) => truthy(v).includes(true))) continue;
          }
          const bad = uniq(values(job["runs-on"], github))
            .map(refuse)
            .filter((r) => r !== null);
          if (bad.length > 0) problems.push(`job ${name}, ${event} by ${bot}: runs on ${bad.join(" or ")}`);
        } catch (err) {
          problems.push(`job ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  return uniq(problems);
}
