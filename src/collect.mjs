// 테이블 하나를 처음부터 끝까지: 존재 확인(추론 전에 먼저) → describe → infer →
// compose → (apply 일 때만) push.
//
// push.mjs 의 pushDoc 도 자체적으로 존재확인을 한다 — 여기서 먼저 보는 이유는 그
// 확인을 infer 호출보다 앞으로 당겨서, 이미 문서가 있는 테이블에 LLM 비용을 쓰지
// 않기 위해서다(README "Phase 4 CLI 오케스트레이터가 wiring 한다"가 이거다).

import { docIdFor, composeDbSchemaDoc } from "./compose.mjs";
import { describeTable } from "./oracle/describe.mjs";
import { inferTable } from "./infer/run.mjs";
import { pushDoc } from "./push.mjs";

/**
 * @param {object} deps
 * @param {{run: Function}} deps.oracle
 * @param {{complete: Function, model: string}} deps.llm
 * @param {{getDoc: Function, createDoc: Function}} deps.akg
 * @param {() => string} deps.fetchedAt  ISO 문자열 — 호출자가 준다(결정적 테스트)
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.table
 * @param {boolean} opts.apply  false 면 push 없이 "생성될 문서"만 돌려준다
 * @param {"full"|"pointer"|"none"} [opts.inject]
 * @returns {Promise<{id: string, action: "skip"|"would_create"|"create",
 *                     doc?: object, rev?: string}>}
 */
export async function collectTable(deps, opts) {
  const { owner, table, apply, inject } = opts;
  const id = docIdFor(owner, table);

  const existing = await deps.akg.getDoc("db-schema", id);
  if (existing) return { id, action: "skip" };

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
