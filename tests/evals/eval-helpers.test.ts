import { describe, expect, test } from "bun:test";
import { buildEvalProcessEnv, shouldLoadDotEnv } from "./eval-helpers";

describe("eval helpers", () => {
  test("passes the selected eval model to chassis through CHASSIS_MODEL", () => {
    const previous = process.env.CHASSIS_MODEL;
    process.env.CHASSIS_MODEL = "ambient/model";

    try {
      const env = buildEvalProcessEnv("/tmp/chassis-eval-home-test", "selected/model");

      expect(env.CHASSIS_MODEL).toBe("selected/model");
      expect(env.HOME).toBe("/tmp/chassis-eval-home-test");
      expect(env.NO_COLOR).toBe("1");
    } finally {
      if (previous === undefined) {
        delete process.env.CHASSIS_MODEL;
      } else {
        process.env.CHASSIS_MODEL = previous;
      }
    }
  });

  test("does not load repository dotenv files in a hermetic run", () => {
    expect(shouldLoadDotEnv({ CHASSIS_E2E_DISABLE_DOTENV: "1" })).toBe(false);
    expect(shouldLoadDotEnv({})).toBe(true);
  });
});
