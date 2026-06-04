import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG } from "../src/types.js";
describe("scaffold", () => { it("loads defaults", () => { expect(DEFAULT_CONFIG.defaultLifetime).toBe("use-once"); }); });
