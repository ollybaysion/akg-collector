// 테이블 하나를 처음부터 끝까지: 존재 확인(추론 전에 먼저) → describe → infer →
// compose → (apply 일 때만) push.
//
// push.mjs 의 pushDoc 도 자체적으로 존재확인을 한다 — 여기서 먼저 보는 이유는 그
// 확인을 infer 호출보다 앞으로 당겨서, 이미 문서가 있는 테이블에 LLM 비용을 쓰지
// 않기 위해서다(README "Phase 4 CLI 오케스트레이터가 wiring 한다"가 이거다).
//
// refreshFacts(#10)는 기존 문서를 스킵 대신 팩트 갱신으로 처리한다: describe 만
// 다시 돌려 akg `PUT /facts` 로 보낸다. 이 경로에 infer 가 없는 건 낭비 절약이
// 아니라 구조다 — 추론 결과는 슬롯인데, facts 경로로 온 슬롯 값은 서버가 전부
// scaffold 로 리셋한다(해석 주장은 propose 몫). 슬롯 보존도 서버 mergeFacts 책임.

import { docIdFor, composeDbSchemaDoc } from "./compose.mjs";
import { describeTable } from "./oracle/describe.mjs";
import { inferTable } from "./infer/run.mjs";
import { pushDoc } from "./push.mjs";

/**
 * @param {object} deps
 * @param {{run: Function}} deps.oracle
 * @param {{complete: Function, model: string}} deps.llm
 * @param {{getDoc: Function, createDoc: Function, putFacts: Function}} deps.akg
 * @param {() => string} deps.fetchedAt  ISO 문자열 — 호출자가 준다(결정적 테스트)
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.table
 * @param {boolean} opts.apply  false 면 push 없이 "생성될 문서"만 돌려준다
 * @param {boolean} [opts.refreshFacts]  기존 문서를 스킵 대신 팩트 갱신
 * @param {"full"|"pointer"|"none"} [opts.inject]
 * @returns {Promise<{id: string,
 *                     action: "skip"|"would_create"|"create"|"would_refresh"|"refresh",
 *                     doc?: object, rev?: string, orphans?: object[]}>}
 */
export async function collectTable(deps, opts) {
  const { owner, table, apply, refreshFacts, inject } = opts;
  const id = docIdFor(table);

  const existing = await deps.akg.getDoc("db-schema", id);
  if (existing && !refreshFacts) return { id, action: "skip" };

  if (existing) {
    // 팩트 갱신 — infer 없이 describe 만. compose 는 inference=null 로 팩트만 채운다.
    const describe = await describeTable(deps.oracle.run, owner, table);
    const doc = composeDbSchemaDoc(describe, null, {
      fetchedAt: deps.fetchedAt(),
      inject,
    });
    if (!apply) return { id, action: "would_refresh", doc };

    const result = await deps.akg.putFacts("db-schema", id, doc);
    return { id, action: "refresh", rev: result.rev, orphans: result.orphans };
  }

  const describe = await describeTable(deps.oracle.run, owner, table);
  const { inference } = await inferTable(describe, { client: deps.llm });
  const doc = composeDbSchemaDoc(describe, inference, {
    fetchedAt: deps.fetchedAt(),
    model: deps.llm.model,
    inject,
  });

  if (!apply) return { id, action: "would_create", doc };

  const result = await pushDoc(deps.akg, doc);
  return { id, action: result.skipped ? "skip" : "create", rev: result.rev };
}
