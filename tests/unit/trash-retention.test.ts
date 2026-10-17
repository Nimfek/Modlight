import { describe, it, expect } from "vitest";
import {
  TRASH_RETENTION_DAYS,
  TRASH_RETENTION_MS,
  trashDaysLeft,
} from "@/lib/maintenance/trash";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-30T12:00:00.000Z");

describe("trash retention window", () => {
  it("is the 30 days the UI promises", () => {
    // The copy in messages/{en,pl}/dashboard.json interpolates this constant.
    expect(TRASH_RETENTION_DAYS).toBe(30);
    expect(TRASH_RETENTION_MS).toBe(30 * DAY);
  });
});

describe("trashDaysLeft", () => {
  it("gives a freshly trashed file the full window", () => {
    expect(trashDaysLeft(new Date(NOW), NOW)).toBe(30);
  });

  it("counts down as the item ages", () => {
    expect(trashDaysLeft(new Date(NOW - 1 * DAY), NOW)).toBe(29);
    expect(trashDaysLeft(new Date(NOW - 29 * DAY), NOW)).toBe(1);
  });

  it("rounds up, so 'less than a day left' never reads as 0 days", () => {
    expect(trashDaysLeft(new Date(NOW - 29.5 * DAY), NOW)).toBe(1);
  });

  it("clamps at 0 once the item is due — never a negative countdown", () => {
    expect(trashDaysLeft(new Date(NOW - 30 * DAY), NOW)).toBe(0);
    expect(trashDaysLeft(new Date(NOW - 400 * DAY), NOW)).toBe(0);
  });

  it("accepts the ISO strings that cross the server/client boundary", () => {
    expect(trashDaysLeft(new Date(NOW - 10 * DAY).toISOString(), NOW)).toBe(20);
  });

  it("returns null for a file that isn't in the trash", () => {
    expect(trashDaysLeft(null, NOW)).toBeNull();
  });

  it("returns null rather than NaN for an unparseable stamp", () => {
    expect(trashDaysLeft("not a date", NOW)).toBeNull();
  });
});
