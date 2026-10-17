import { describe, it, expect } from "vitest";
import { storageKeyFor, publicUrl, rawUrl, downloadUrl, deleteUrl, extOf } from "@/lib/media/urls";

describe("url helpers", () => {
  it("storageKeyFor", () => {
    expect(storageKeyFor("u", "c", "png")).toBe("u/c.png");
    expect(storageKeyFor("u", "c", "")).toBe("u/c");
  });

  it("extOf", () => {
    expect(extOf("photo.PNG")).toBe("png");
    expect(extOf("archive.tar.gz")).toBe("gz");
    expect(extOf("noext")).toBe("");
  });

  it("public/raw/download/delete urls (the scheme ShareX configs expect)", () => {
    expect(publicUrl("ToqOse", "abc12", "png")).toMatch(/\/ToqOse\/abc12\.png$/);
    expect(rawUrl("ToqOse", "abc12", "png")).toMatch(/\/ToqOse\/abc12\/raw\.png$/);
    expect(downloadUrl("ToqOse", "abc12")).toMatch(/\/ToqOse\/abc12\/download$/);
    expect(deleteUrl("ToqOse", "abc12", "tok")).toMatch(/\/ToqOse\/abc12\/delete\/tok$/);
  });
});
