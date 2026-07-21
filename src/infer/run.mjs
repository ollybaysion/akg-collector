// 테이블 하나를 추론한다: 프롬프트 → LLM → 파싱, 실패하면 교정해서 다시.
//
// 사내 LLM 이 형식을 못 지킬 수 있다고 가정한다. 그래서 실패를 예외로 끝내지 않고
// **모델에게 무엇이 틀렸는지 알려주고 다시 시킨다**(교정 루프). 그래도 안 되면
// 그 테이블은 추론 없이 팩트만으로 문서를 만든다 — 수집 전체를 멈추지 않는다.

import { buildInferPrompt } from "./prompt.mjs";
import { parseInference, InferParseError } from "./parse.mjs";

const CORRECTION =
  "출력 형식이 틀렸다. 설명·인사말·코드펜스 없이 JSON 객체 하나만 다시 출력하라.";

/**
 * @param {object} describe  describe_table 출력
 * @param {object} opts
 * @param {{complete: (messages: object[]) => Promise<string>, model?: string}} opts.client
 * @param {object[]} [opts.sampleRows]  기본 없음 — 개인정보가 LLM 으로 나간다
 * @param {number} [opts.maxAttempts]   파싱 실패 시 교정 재시도 포함 총 시도 (기본 2)
 * @returns {Promise<{inference: object|null, attempts: number, error: Error|null}>}
 */
export async function inferTable(describe, opts) {
  const { client, sampleRows, maxAttempts = 2 } = opts;
  const { messages } = buildInferPrompt(describe, { sampleRows });

  const conversation = [...messages];
  let attempts = 0;
  let lastError = null;

  while (attempts < maxAttempts) {
    attempts++;
    let raw;
    try {
      raw = await client.complete(conversation);
    } catch (err) {
      // 호출 자체가 실패한 건 교정으로 풀 수 있는 문제가 아니다 — 여기서 끝낸다.
      return { inference: null, attempts, error: err };
    }

    try {
      return { inference: parseInference(raw, describe), attempts, error: null };
    } catch (err) {
      if (!(err instanceof InferParseError)) throw err;
      lastError = err;
      conversation.push(
        { role: "assistant", content: raw },
        { role: "user", content: CORRECTION },
      );
    }
  }

  return { inference: null, attempts, error: lastError };
}
