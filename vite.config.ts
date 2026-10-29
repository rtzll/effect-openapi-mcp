import { defineConfig } from "vite-plus";
import { recommended } from "@effect/tsgo/oxlint-presets";

export default defineConfig({
  lint: {
    extends: [recommended],
    plugins: ["typescript", "effecttsgo"],
    categories: {
      correctness: "error",
    },
    env: {
      node: true,
      browser: true,
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
    // Keep the previous recommended ESLint/TypeScript checks beyond correctness.
    rules: {
      // Effect 4's HTTP/platform/test APIs are intentionally pinned and tested.
      "effecttsgo/unstable-api-usage": "off",
      "typescript/ban-ts-comment": "error",
      "no-array-constructor": "error",
      "no-case-declarations": "error",
      "no-empty": "error",
      "typescript/no-empty-object-type": "error",
      "typescript/no-explicit-any": "error",
      "no-fallthrough": "error",
      "typescript/no-misused-promises": "error",
      "typescript/no-namespace": "error",
      "no-prototype-builtins": "error",
      "no-regex-spaces": "error",
      "typescript/no-require-imports": "error",
      "no-unexpected-multiline": "error",
      "typescript/no-unnecessary-type-assertion": "error",
      "typescript/no-unnecessary-type-constraint": "error",
      "typescript/no-unsafe-argument": "error",
      "typescript/no-unsafe-assignment": "error",
      "typescript/no-unsafe-call": "error",
      "typescript/no-unsafe-enum-comparison": "error",
      "typescript/no-unsafe-function-type": "error",
      "typescript/no-unsafe-member-access": "error",
      "typescript/no-unsafe-return": "error",
      "no-useless-assignment": "error",
      "no-var": "error",
      "typescript/only-throw-error": "error",
      "prefer-const": "error",
      "typescript/prefer-promise-reject-errors": "error",
      "prefer-rest-params": "error",
      "prefer-spread": "error",
      "preserve-caught-error": "error",
      "typescript/require-await": "error",
      "typescript/restrict-plus-operands": "error",
      "no-constant-binary-expression": [
        "error",
        {
          checkRelationalComparisons: false,
        },
      ],
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrors: "all",
        },
      ],
    },
    overrides: [
      {
        // This external consumer probe resolves the built package, unavailable before build.
        // Its public imports/types are verified by the separate package smoke test.
        files: ["scripts/package-import-probe.mjs"],
        rules: {
          "no-redeclare": "error",
          "no-undef": "error",
          "effecttsgo/any-unknown-in-error-context": "off",
          "typescript/await-thenable": "off",
          "typescript/no-array-delete": "off",
          "typescript/no-base-to-string": "off",
          "typescript/no-duplicate-type-constituents": "off",
          "typescript/no-floating-promises": "off",
          "typescript/no-for-in-array": "off",
          "typescript/no-implied-eval": "off",
          "typescript/no-misused-promises": "off",
          "typescript/no-redundant-type-constituents": "off",
          "typescript/no-unnecessary-type-assertion": "off",
          "typescript/no-unsafe-argument": "off",
          "typescript/no-unsafe-assignment": "off",
          "typescript/no-unsafe-call": "off",
          "typescript/no-unsafe-enum-comparison": "off",
          "typescript/no-unsafe-member-access": "off",
          "typescript/no-unsafe-return": "off",
          "typescript/no-unsafe-unary-minus": "off",
          "typescript/only-throw-error": "off",
          "typescript/prefer-promise-reject-errors": "off",
          "typescript/require-await": "off",
          "typescript/restrict-plus-operands": "off",
          "typescript/restrict-template-expressions": "off",
          "typescript/unbound-method": "off",
        },
      },
    ],
    ignorePatterns: ["node_modules/**", "fixtures/**", "dist/**"],
  },
  fmt: {
    printWidth: 80,
    sortPackageJson: false,
    ignorePatterns: ["pnpm-lock.yaml", "fixtures/", "dist/", "reports/"],
  },
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // Full API catalogs are expensive; bound contention for reliable deadlines.
    maxWorkers: 2,
  },
});
