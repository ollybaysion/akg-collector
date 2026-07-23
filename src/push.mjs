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
// 호출자가 push 전에 docIdFor(table) 로 미리 client.getDoc 을 불러 스킵
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

// akg 의 본문 상한은 512 KiB. 여기서 400 KiB 로 자르는 건 헤드룸이다 — 직렬화
// 오버헤드와 서버측 차이를 재현할 게 아니라, 넘지 않는 게 목적이라서.
const CHUNK_BYTES = 400 * 1024;

/**
 * 크기로 자른다. 개수로 자르면 컬럼 수에 따라 어떤 배치는 상한을 넘고 어떤 배치는
 * 상한을 한참 밑돈다 — akg 실측으로 12컬럼 db-schema 는 200개가 약 282 KiB 였다.
 * 문서 하나가 혼자서도 상한을 넘으면 그건 청크로 풀 수 있는 문제가 아니므로
 * 자기 배치로 보내 서버가 413 으로 말하게 둔다.
 */
export function chunkBySize(docs, limit = CHUNK_BYTES) {
  const chunks = [];
  let current = [];
  let size = 2; // "[]"
  for (const doc of docs) {
    const bytes = Buffer.byteLength(JSON.stringify(doc)) + 1; // + 쉼표
    if (current.length && size + bytes > limit) {
      chunks.push(current);
      current = [];
      size = 2;
    }
    current.push(doc);
    size += bytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/**
 * N개를 배치로 올린다. 청크마다 1커밋.
 *
 * 배치는 전량 아니면 전무라, 이미 있는 id 가 하나라도 섞이면 그 청크 전체가
 * 409 로 아무것도 안 쓰인다. collect 단계에서 존재확인을 먼저 하므로 보통은 안
 * 생기지만, 재실행이나 다른 프로세스와 겹치면 생긴다 — 그 id 들을 빼고 한 번
 * 다시 보낸다. 두 번째도 409 면 남은 게 없다는 뜻이므로 스킵으로 접는다.
 *
 * @param {{createDocs: Function}} client
 * @param {object[]} docs  composeDbSchemaDoc() 출력들 (전부 같은 타입)
 * @returns {Promise<{created: string[], skipped: string[], commits: number}>}
 */
export async function pushDocs(client, docs, { runId } = {}) {
  const created = [];
  const skipped = [];
  let commits = 0;
  if (docs.length === 0) return { created, skipped, commits };

  const [type] = docs[0].schema.split("/");
  for (const chunk of chunkBySize(docs)) {
    let batch = chunk;
    for (let attempt = 0; attempt < 2 && batch.length; attempt++) {
      const result = await client.createDocs(type, batch, { runId });
      if (result.created) {
        created.push(...result.created);
        commits++;
        break;
      }
      const existing = new Set(result.alreadyExists);
      skipped.push(...batch.filter((d) => existing.has(d.id)).map((d) => d.id));
      batch = batch.filter((d) => !existing.has(d.id));
      // 두 번째 시도도 409 면 그 청크는 여기서 접는다: 남은 문서를 무한히
      // 다시 보내는 것보다, 다음 실행이 스킵으로 처리하는 편이 낫다.
      if (attempt === 1)
        skipped.push(...batch.map((d) => d.id));
    }
  }
  return { created, skipped, commits };
}
