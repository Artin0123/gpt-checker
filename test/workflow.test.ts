import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import yml from "../.github/workflows/hi.yml?raw";

describe("hi.yml", () => {
  it("GHA 用的 tsx 版本與 package.json 一致", () => {
    expect(yml).toContain(`npx --yes tsx@${pkg.devDependencies.tsx} scripts/gha-run.ts`);
  });
});
