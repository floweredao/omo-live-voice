import { expect, test } from "bun:test";
import { inventedOptions } from "../scripts/qa/checklist.ts";

const labels = ["첫 실제 선택지", "둘째 실제 선택지"];
const valid = `제목. 질문? 1번 ${labels[0]}. 2번 ${labels[1]}.`;

test("accepts only supplied labels with normalized punctuation and spacing", () => {
  // Given / When: the read-aloud script contains only the supplied alternatives.
  const result = inventedOptions(valid.replaceAll(" ", " \n "), labels);
  // Then: no invented alternative is found.
  expect(result).toEqual([]);
});

for (const extra of ["1. 빠른 빌드 먼저 만들고 나중에 다듬기. 2. 먼저 설계하고 만들기.", "1번 임의 선택지.", "일번 임의 선택지.", "9번 범위 밖 선택지."]) {
  test(`rejects invented numbered alternatives: ${extra}`, () => {
    // Given / When: all real labels remain present after invented alternatives.
    const result = inventedOptions(`질문? ${extra} ${valid}`, labels);
    // Then: inclusion of the real labels cannot hide invented options.
    expect(result.length).toBeGreaterThan(0);
  });
}

test("rejects invented alternatives among complete real labels", () => {
  // Given / When: an extra list entry appears between the actual alternatives.
  const result = inventedOptions(valid.replace("2번", "2. 먼저 설계하고 만들기. 2번"), labels);
  // Then: the interleaved option fails acceptance.
  expect(result).toEqual(["2. 먼저 설계하고 만들기."]);
});
