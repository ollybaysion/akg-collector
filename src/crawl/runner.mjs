// 크롤러 구현 하나를 돌려 AKG 수집 계약(AKG 설계 §5.1) JSONL 을 낸다.
// 검증 · 상한 · 출력 · 실패 셈은 전부 여기서 한다. 구현은 list · fetch 만 맡는다.

export const FETCH_CONCURRENCY = 4;
export const TEXT_MAX_BYTES = 256 * 1024;
export const REF_MAX = 512;
export const TITLE_MAX = 200;
export const KEYWORD_MAX = 64;
export const MIME = "text/markdown";

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

function clean(value, max) {
  if (typeof value !== "string") return "";
  return Array.from(value.replace(CONTROL, "").trim()).slice(0, max).join("");
}

function iso(value) {
  if (typeof value !== "string" && !(value instanceof Date)) return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function cleanKeywords(list) {
  if (!Array.isArray(list)) return undefined;
  const out = [...new Set(list.map((k) => clean(k, KEYWORD_MAX)).filter(Boolean))];
  return out.length ? out : undefined;
}

function cleanUrl(value) {
  const url = clean(value, Infinity);
  return url && URL.canParse(url) ? url : undefined;
}

function toLine(ref, listed, item) {
  const line = {
    ref,
    title: clean(item.title, TITLE_MAX) || clean(listed.title, TITLE_MAX) || ref,
    mime: MIME,
    text: item.text,
  };
  const optional = {
    updatedAt: iso(item.updatedAt ?? listed.updatedAt),
    createdAt: iso(item.createdAt ?? listed.createdAt),
    keywords: cleanKeywords(item.keywords),
    sourceUrl: cleanUrl(item.sourceUrl ?? listed.sourceUrl),
  };
  for (const [key, value] of Object.entries(optional)) if (value !== undefined) line[key] = value;
  return line;
}

async function fetchOne(crawler, listed, ref) {
  try {
    const item = await crawler.fetch(listed);
    if (typeof item?.text !== "string") throw new Error("fetch 결과에 text 문자열이 없다");
    if (Buffer.byteLength(item.text, "utf8") > TEXT_MAX_BYTES) return { ref, oversize: true };
    return { ref, line: toLine(ref, listed, item) };
  } catch (error) {
    return { ref, error };
  }
}

/**
 * list 가 끝까지 돌면 마지막 줄에 완료 마커를 쓰고 그 값을 돌려준다.
 * list 가 던지면 마커 없이 그대로 던진다(AKG 는 마커 없는 출력으로 고아를 판정하지 않는다, CS2).
 * @param {{list: () => AsyncIterable<object>, fetch: (ref: object) => Promise<object>}} crawler
 * @param {{write: (line: string) => (void|Promise<void>), warn?: (msg: string) => void, concurrency?: number}} io
 */
export async function runCrawl(crawler, { write, warn = () => {}, concurrency = FETCH_CONCURRENCY }) {
  const done = { listed: 0, emitted: 0, oversize: [], failed: [], duplicate: [] };
  const seen = new Set();
  const inFlight = [];

  const emitHead = async () => {
    const result = await inFlight.shift();
    if (result.line) {
      await write(JSON.stringify(result.line));
      done.emitted++;
    } else if (result.oversize) {
      done.oversize.push(result.ref);
    } else {
      done.failed.push(result.ref);
      warn(`fetch 실패: ${result.ref} — ${result.error?.message ?? result.error}`);
    }
  };

  for await (const listed of crawler.list()) {
    done.listed++;
    const ref = clean(listed?.ref, REF_MAX);
    if (!ref) throw new Error(`list 의 ${done.listed} 번째 항목에 ref 가 없다`);
    if (seen.has(ref)) {
      done.duplicate.push(ref);
      continue;
    }
    seen.add(ref);
    inFlight.push(fetchOne(crawler, listed, ref));
    if (inFlight.length >= concurrency) await emitHead();
  }
  while (inFlight.length) await emitHead();

  await write(JSON.stringify({ done }));
  return done;
}
