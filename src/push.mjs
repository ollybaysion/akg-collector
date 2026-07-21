// ⑤ push — akg 에 신규 db-schema 문서를 올린다.
//
// compose.mjs 의 "병합 없음" 정책과 짝이다: 이미 문서가 있으면 통째로 스킵하고,
// PUT 은 아예 하지 않는다. GET(존재확인) 과 POST(생성) 사이에 다른 프로세스가
// 먼저 만들면 createDoc 이 409 를 알려주는데, 그 경쟁도 스킵으로 접는다 — 결과는
// "이미 있음"으로 같다.
//
// 재개(resume)는 여기 별도 상태가 없다: 스킵 정책 자체가 재개다. 전체 파이프라인을
// 처음부터 다시 돌려도 이미 push 된 테이블은 그대로 스킵된다. 다만 그건 describe·
// infer 까지 다시 하고 나서야 걸러진다는 뜻이라 — infer 호출(비용)까지 건너뛰려면
// 호출자가 push 전에 docIdFor(owner, table) 로 미리 client.getDoc 을 불러 스킵
// 여부를 먼저 볼 수 있다(Phase 4 CLI 오케스트레이터가 이걸 wiring 한다).

/**
 * @param {{getDoc: Function, createDoc: Function}} client  createAkgClient() 인스턴스
 * @param {object} doc  composeDbSchemaDoc() 출력
 * @returns {Promise<{id: string, skipped: boolean, reason?: string, rev?: string}>}
 */
export async function pushDoc(client, doc) {
  const [type] = doc.schema.split("/");

  const existing = await client.getDoc(type, doc.id);
  if (existing) return { id: doc.id, skipped: true, reason: "already_exists" };

  const result = await client.createDoc(type, doc);
  if (result.alreadyExists)
    return { id: doc.id, skipped: true, reason: "already_exists" };

  return { id: doc.id, skipped: false, rev: result.rev };
}
