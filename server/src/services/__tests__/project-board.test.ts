import { describe, expect, it } from "vitest";
import { moveOnBoard } from "@claude-station/shared";

const board = { active: ["a", "b", "c"], backlog: ["x", "y"] };

describe("moveOnBoard", () => {
  it("moves a card to another column at the given slot", () => {
    expect(moveOnBoard(board, "b", "backlog", 1)).toEqual({
      active: ["a", "c"],
      backlog: ["x", "b", "y"],
    });
  });

  it("appends when the slot is past the end of the column", () => {
    expect(moveOnBoard(board, "a", "backlog", 2)).toEqual({
      active: ["b", "c"],
      backlog: ["x", "y", "a"],
    });
  });

  it("reorders inside a column, downwards", () => {
    // Slot 3 is below "c" while "a" is still counted, so "a" lands last.
    expect(moveOnBoard(board, "a", "active", 3)).toEqual({
      active: ["b", "c", "a"],
      backlog: ["x", "y"],
    });
  });

  it("reorders inside a column, upwards", () => {
    expect(moveOnBoard(board, "c", "active", 0)).toEqual({
      active: ["c", "a", "b"],
      backlog: ["x", "y"],
    });
  });

  it("reports no move when the card lands where it already is", () => {
    expect(moveOnBoard(board, "b", "active", 1)).toBeNull();
    // Slot 2 is "below b, above c" — the same place once b is pulled out.
    expect(moveOnBoard(board, "b", "active", 2)).toBeNull();
  });

  it("reports no move for an id the board does not hold", () => {
    expect(moveOnBoard(board, "gone", "active", 0)).toBeNull();
  });

  it("leaves the board it was given untouched", () => {
    moveOnBoard(board, "a", "backlog", 0);
    expect(board).toEqual({ active: ["a", "b", "c"], backlog: ["x", "y"] });
  });
});
