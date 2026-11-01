import { describe, expect, test } from "bun:test";
import { orderedMatch } from "../bridge/question-transcript.ts";

describe("question transcript acceptance", () => {
  const header = ["제목", "질문 전체"];
  const labels = ["첫 선택지 전체입니다", "둘째 선택지 전체입니다"];
  const text = "제목. 질문 전체? 1번 첫 선택지 전체입니다. 2번 둘째 선택지 전체입니다.";

  test("matches complete normalized labels despite repeated speech between labels", () => {
    // Given: the first full label is repeated before the second option.
    const repeated = text.replace("2번", "1번 첫 선택지 전체입니다. 2번");
    // When: whitespace and punctuation also differ.
    const result = orderedMatch(repeated.replaceAll(" ", " \n "), header, labels);
    // Then: repetitions are recorded, not failures.
    expect(result.missing).toBeNull();
    expect(result.positions).toHaveLength(4);
    expect(result.repetitions).toEqual([{ fragment: `1번 ${labels[0]}`, extraOccurrences: 1 }]);
  });

  test("allows a repeated ending between a marker and its complete label", () => {
    // Given / When: speech repeats the preceding ending after the next number.
    const result = orderedMatch(text.replace("2번", "2번 전체입니다."), header, labels);
    // Then: both full labels still exist in source order.
    expect(result.missing).toBeNull();
  });

  for (const fragment of [...header, ...labels]) {
    test(`rejects omission from required fragment ${fragment}`, () => {
      // Given / When: one character is omitted, not just punctuation or whitespace.
      const result = orderedMatch(text.replace(fragment, fragment.slice(0, -1)), header, labels);
      // Then: even a near-complete fragment must fail.
      expect(result.missing).not.toBeNull();
    });
  }

  test("rejects reordered labels and incorrect option numbers", () => {
    // Given / When: all words exist, but the numbering/order is wrong.
    const swapped = orderedMatch(`제목 질문 전체 2번 ${labels[1]} 1번 ${labels[0]}`, header, labels);
    const wrongNumber = orderedMatch(text.replace("2번", "3번"), header, labels);
    // Then: neither is accepted as a complete ordered question.
    expect(swapped.missing).not.toBeNull();
    expect(wrongNumber.missing).not.toBeNull();
  });

  test("does not borrow an omitted label from a later option", () => {
    // Given / When: label 1 appears only inside the next numbered option.
    const result = orderedMatch(`제목 질문 전체 1번 누락 2번 ${labels[0]} ${labels[1]}`, header, labels);
    // Then: label 1 remains missing.
    expect(result.missing).toBe(`1번 ${labels[0]}`);
  });
});
