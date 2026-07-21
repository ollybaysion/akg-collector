import { test } from "node:test";
import assert from "node:assert/strict";
import { pushDoc } from "../src/push.mjs";

const DOC = { schema: "db-schema/v1", id: "testuser.fdc_sensor", body: {} };

/** 호출을 기록하면서 미리 정한 결과를 돌려주는 가짜 akg 클라이언트. */
function fakeClient({ existing = null, createResult } = {}) {
  const calls = [];
  return {
    calls,
    async getDoc(type, id) {
      calls.push({ op: "getDoc", type, id });
      return existing;
    },
    async createDoc(type, doc) {
      calls.push({ op: "createDoc", type, doc });
      return createResult ?? { alreadyExists: false, rev: "r1" };
    },
  };
}

test("존재하지 않으면 생성하고 rev 를 돌려준다", async () => {
  const client = fakeClient({ existing: null });
  const out = await pushDoc(client, DOC);

  assert.deepEqual(out, { id: "testuser.fdc_sensor", skipped: false, rev: "r1" });
  assert.deepEqual(
    client.calls.map((c) => c.op),
    ["getDoc", "createDoc"],
  );
  assert.equal(client.calls[0].type, "db-schema");
  assert.equal(client.calls[1].type, "db-schema");
});

test("이미 있으면 생성을 건너뛴다 — createDoc 을 부르지 않는다", async () => {
  const client = fakeClient({ existing: { id: "testuser.fdc_sensor" } });
  const out = await pushDoc(client, DOC);

  assert.deepEqual(out, {
    id: "testuser.fdc_sensor",
    skipped: true,
    reason: "already_exists",
  });
  assert.deepEqual(
    client.calls.map((c) => c.op),
    ["getDoc"],
  );
});

test("GET 사이 경쟁으로 생성 시점에 이미 생겼으면(409) 그것도 스킵으로 접는다", async () => {
  const client = fakeClient({
    existing: null,
    createResult: { alreadyExists: true },
  });
  const out = await pushDoc(client, DOC);

  assert.deepEqual(out, {
    id: "testuser.fdc_sensor",
    skipped: true,
    reason: "already_exists",
  });
});
