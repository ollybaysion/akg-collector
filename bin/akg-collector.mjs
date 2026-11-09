#!/usr/bin/env node
// akg-collector CLI 진입점. 실 Oracle·LLM·akg 클라이언트를 만드는 건 여기뿐이다 —
// src/cli.mjs 는 이 파일이 주입하는 클라이언트만 알고, 실 네트워크·비밀값·환경변수는
// 전혀 모른다.
//
// 커맨드마다 실제로 쓰는 클라이언트가 다르다(src/cli.mjs 의 COMMAND_DEPS) — 그래서
// discover·describe 는 Oracle 접속 정보만 있으면 돈다. LLM·akg 설정은 그게 실제로
// 필요한 infer/push/run 에서만 요구한다.
//
// 드라이버 import 는 전부 동적이다(정적 import 였다면 `oracledb` 가 안 깔려 있을 때
// --owner 도 안 준 채 그냥 실행해도 usage 대신 모듈 못 찾는 스택트레이스가 떴을 것).
// 그래서 커맨드 자체가 잘못됐거나 환경변수가 비어 있으면 드라이버를 건드리기 전에
// 먼저 걸러진다.
//
// crawl 은 원천만 읽는다. 그래서 buildDeps 앞에서 src/crawl/cli.mjs 로 보낸다.

import { runCli, CliError, COMMANDS } from "../src/cli.mjs";

const NEEDS_LLM = new Set(["infer", "push", "run"]);
const NEEDS_AKG = new Set(["push", "run"]);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new CliError(`환경변수 ${name} 이 필요합니다`);
  return value;
}

/** 필요한 환경변수부터 전부 확인한 다음에야 드라이버를 import 한다 — 그래서
 * "설정 하나 빠짐" 과 "패키지 설치 안 됨" 이 서로 다른 메시지로 나온다. */
async function buildDeps(command) {
  const oracleConfig = {
    user: requireEnv("ORACLE_USER"),
    password: requireEnv("ORACLE_PASSWORD"),
    connectString: requireEnv("ORACLE_CONNECT_STRING"),
  };
  const llmConfig = NEEDS_LLM.has(command)
    ? {
        baseUrl: requireEnv("AKG_LLM_URL"),
        apiKey: process.env.AKG_LLM_KEY,
        model: process.env.AKG_LLM_MODEL ?? "inhouse-llm",
      }
    : null;
  const akgConfig = NEEDS_AKG.has(command)
    ? { baseUrl: requireEnv("AKG_BASE_URL"), token: requireEnv("AKG_EDITOR_TOKEN") }
    : null;

  const { createOraclePool } = await import("../src/oracle/pool.mjs");
  const oracle = await createOraclePool(oracleConfig);
  const deps = {
    oracle,
    fetchedAt: () => new Date().toISOString(),
    log: (line) => console.log(line),
  };

  if (llmConfig) {
    const { createOpenAiClient } = await import("../src/llm/openai.mjs");
    deps.llm = createOpenAiClient(llmConfig);
  }
  if (akgConfig) {
    const { createAkgClient } = await import("../src/akg/client.mjs");
    deps.akg = createAkgClient(akgConfig);
  }
  return deps;
}

function writeStdout(line) {
  return new Promise((done) => {
    if (process.stdout.write(`${line}\n`)) done();
    else process.stdout.once("drain", done);
  });
}

async function main() {
  const [command] = process.argv.slice(2);
  if (command === "crawl") {
    const { runCrawlCli } = await import("../src/crawl/cli.mjs");
    process.exitCode = await runCrawlCli(process.argv.slice(3), {
      write: writeStdout,
      warn: (msg) => console.error(msg),
    });
    return;
  }
  if (!COMMANDS.includes(command)) {
    console.error(`사용법: akg-collector <${[...COMMANDS, "crawl"].join("|")}> [옵션]`);
    process.exitCode = 1;
    return;
  }

  let deps;
  try {
    deps = await buildDeps(command);
  } catch (err) {
    if (err instanceof CliError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  try {
    await runCli(process.argv.slice(2), deps);
  } catch (err) {
    if (err instanceof CliError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    await deps.oracle.close();
  }
}

main();
