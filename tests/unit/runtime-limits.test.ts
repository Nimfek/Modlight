import { describe, it, expect } from "vitest";
import { parseCpuMax, parseMemoryMax } from "@/lib/runtime/limits";

describe("reading the cgroup", () => {
  it("reads the quota the production container really has", () => {
    // Measured: `cat /sys/fs/cgroup/cpu.max` inside modlight -> "200000 100000",
    // against an `os.cpus().length` of 6 (the host).
    expect(parseCpuMax("200000 100000")).toBe(2);
    expect(parseCpuMax("50000 100000")).toBe(0.5);
    expect(parseMemoryMax("2147483648")).toBe(2 * 1024 * 1024 * 1024);
  });

  it("says 'no cap' rather than guessing when there is none", () => {
    expect(parseCpuMax("max 100000")).toBeNull();
    expect(parseMemoryMax("max")).toBeNull();
    expect(parseCpuMax(null)).toBeNull();
    expect(parseMemoryMax(undefined)).toBeNull();
    expect(parseCpuMax("")).toBeNull();
    expect(parseCpuMax("garbage")).toBeNull();
    expect(parseMemoryMax("-1")).toBeNull();
    expect(parseCpuMax("0 100000")).toBeNull();
  });

  it("tolerates the trailing newline the kernel writes", () => {
    expect(parseCpuMax("200000 100000\n")).toBe(2);
    expect(parseMemoryMax("2147483648\n")).toBe(2147483648);
  });
});
