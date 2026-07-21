// discover/describe/infer/push/run 다섯 커맨드의 오케스트레이션.
//
// Oracle·LLM·akg 클라이언트는 전부 주입받는다(bin/akg-collector.mjs 가 실 드라이버로
// 만들어 넘긴다) — 이 파일은 실 네트워크·DB 를 몰라도 테스트된다. 어떤 클라이언트가
// 실제로 필요한지는 커맨드마다 달라서(discover/describe 는 llm·akg 를 아예 안 씀)
// 그 판단도 bin 쪽 몫이다 — 여기선 넘어온 걸 쓸 뿐이다.

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { discoverTables } from "./oracle/discover.mjs";
import { describeTable } from "./oracle/describe.mjs";
import { inferTable } from "./infer/run.mjs";
import { collectTable } from "./collect.mjs";
import { pushDocs } from "./push.mjs";

class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliError";
  }
}

const COMMANDS = ["discover", "describe", "infer", "push", "run"];

// 커맨드마다 실제로 만지는 deps 만 — bin 쪽이 이걸 보고 어떤 클라이언트를 만들지,
// 어떤 환경변수를 요구할지 정한다.
const COMMAND_DEPS = {
  discover: ["oracle"],
  describe: ["oracle"],
  infer: ["oracle", "llm"],
  push: ["oracle", "llm", "akg"],
  run: ["oracle", "llm", "akg"],
};

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      owner: { type: "string" },
      table: { type: "string" },
      tables: { type: "string" }, // "T1,T2,T3" — 지정하면 discover 를 건너뛴다
      "tables-file": { type: "string" }, // 한 줄에 테이블 하나, # 로 시작하면 주석
      like: { type: "string" },
      push: { type: "boolean", default: false },
      inject: { type: "string", default: "pointer" },
      // 배치 커밋 메시지에 실린다 — akg 감사 화면에서 어느 실행이 이 문서들을
      // 만들었는지 보인다. 안 주면 bin 쪽이 시각으로 하나 만들어 넣는다.
      "run-id": { type: "string" },
    },
    allowPositionals: true,
  });
  return values;
}

function requireOwner(opts) {
  if (!opts.owner) throw new CliError("--owner 가 필요합니다");
}

function requireOwnerTable(opts) {
  requireOwner(opts);
  if (!opts.table) throw new CliError("--table 이 필요합니다");
}

/** 한 줄에 테이블 하나. 빈 줄과 `#` 주석은 건너뛴다. */
function readTableListFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new CliError(`--tables-file 을 읽지 못했습니다: ${path} (${err.message})`);
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function formatResult(result) {
  if (result.action === "skip") return `${result.id} → 스킵 (이미 있음)`;
  if (result.action === "would_create") return `(dry-run) ${result.id} → 생성될 예정`;
  return `${result.id} → 생성됨 (rev ${result.rev})`;
}

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @param {object} deps
 * @param {{run: Function}} [deps.oracle]
 * @param {{complete: Function, model: string}} [deps.llm]
 * @param {{getDoc: Function, createDoc: Function}} [deps.akg]
 * @param {() => string} [deps.fetchedAt]  ISO 문자열 — 호출자가 준다(결정적 테스트)
 * @param {(line: string) => void} [deps.log]
 * @returns {Promise<object>}  커맨드별 결과(테스트용) — log 는 사람이 보는 출력
 */
export async function runCli(argv, deps) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command))
    throw new CliError(
      `알 수 없는 커맨드: ${command ?? "(없음)"} — ${COMMANDS.join("/")} 중 하나`,
    );

  for (const needed of COMMAND_DEPS[command])
    if (!deps[needed]) throw new CliError(`${command} 커맨드에는 ${needed} 클라이언트가 필요합니다`);

  const opts = parseOptions(rest);
  const log = deps.log ?? (() => {});

  if (command === "discover") {
    requireOwner(opts);
    const tables = await discoverTables(deps.oracle.run, { owner: opts.owner, like: opts.like });
    tables.forEach((t) => log(t));
    return { command, tables };
  }

  if (command === "describe") {
    requireOwnerTable(opts);
    const describe = await describeTable(deps.oracle.run, opts.owner, opts.table);
    log(JSON.stringify(describe, null, 2));
    return { command, describe };
  }

  if (command === "infer") {
    requireOwnerTable(opts);
    const describe = await describeTable(deps.oracle.run, opts.owner, opts.table);
    const { inference, attempts, error } = await inferTable(describe, { client: deps.llm });
    log(JSON.stringify({ inference, attempts, error: error?.message ?? null }, null, 2));
    return { command, inference, attempts, error };
  }

  if (command === "push") {
    requireOwnerTable(opts);
    const result = await collectTable(deps, {
      owner: opts.owner,
      table: opts.table,
      apply: opts.push,
      inject: opts.inject,
    });
    log(formatResult(result));
    return { command, result };
  }

  // run — --tables/--tables-file 로 명시하면 discover 를 건너뛴다(스키마 전체를
  // 훑지 않는다). 부트스트랩 대상이 수백 개면 --tables-file 쪽이 현실적이다.
  requireOwner(opts);
  if (opts.tables && opts["tables-file"])
    throw new CliError("--tables 와 --tables-file 은 같이 쓸 수 없습니다");

  const tables = opts["tables-file"]
    ? readTableListFile(opts["tables-file"])
    : opts.tables
      ? opts.tables.split(",").map((t) => t.trim()).filter(Boolean)
      : await discoverTables(deps.oracle.run, { owner: opts.owner, like: opts.like });

  // compose 를 전부 끝낸 뒤에 한꺼번에 올린다(#6). 테이블마다 POST 하면 테이블
  // 수만큼 커밋이 생기고, 그만큼 감사 로그가 부트스트랩 한 번으로 뒤덮인다.
  // collectTable 은 apply:false 로 부르고 push 는 여기서 배치로 한다.
  const results = [];
  for (const table of tables) {
    const result = await collectTable(deps, {
      owner: opts.owner,
      table,
      apply: false,
      inject: opts.inject,
    });
    results.push(result);
    if (!opts.push || result.action === "skip") log(formatResult(result));
  }

  if (!opts.push) {
    const wouldCreate = results.filter((r) => r.action === "would_create").length;
    const skip = results.filter((r) => r.action === "skip").length;
    log(`${wouldCreate}개 생성될 예정, ${skip}개 스킵. 실제로 하려면 --push.`);
    return { command, results };
  }

  const pending = results.filter((r) => r.action === "would_create");
  const runId = opts["run-id"] ?? deps.runId?.();
  const pushed = await pushDocs(
    deps.akg,
    pending.map((r) => r.doc),
    { runId },
  );
  const createdSet = new Set(pushed.created);
  for (const r of results) {
    if (r.action !== "would_create") continue;
    r.action = createdSet.has(r.id) ? "create" : "skip";
  }
  for (const id of pushed.created) log(`${id} → 생성됨 (비활성)`);
  for (const id of pushed.skipped) log(`${id} → 스킵 (이미 있음)`);
  log(
    `${pushed.created.length}개 생성(커밋 ${pushed.commits}개), ${
      results.filter((r) => r.action === "skip").length
    }개 스킵. 전부 비활성 — 주입하려면 akg 대시보드에서 활성화하세요.`,
  );
  return { command, results, push: pushed };
}

export { CliError, COMMANDS };
