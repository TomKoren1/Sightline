/**
 * Type-aware rules are the reason to run a linter here: `no-misused-promises`
 * and `no-base-to-string` cannot work from syntax alone, and both found real
 * bugs (ADR-019). The cost is that every linted file must belong to one of the
 * projects listed below — which is why `tsconfig.tools.json` exists.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "apps/api/drizzle/meta/**",
      // CommonJS, run by hand, belongs to no tsconfig.
      "docs/handover/render.cjs",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // A file outside all of these is a lint error rather than a silently
        // unlinted file, which is the gap this is guarding.
        project: ["./apps/*/tsconfig.json", "./packages/*/tsconfig.json", "./tsconfig.tools.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        // `_next` in an Express-shaped handler is not a mistake.
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],

      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "error",

      // Off: cannot tell `properties["publiclyAccessible"]` — a key read out of
      // an AWS response bag — from a real property access. 106 of the first
      // run's 215 errors, every one an index signature.
      "@typescript-eslint/dot-notation": "off",

      // `e.stderr || e.message` wants an empty stderr to fall through; `??`
      // would keep "" and hide the only text there was. ENOENT has that shape.
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: true } },
      ],

      // Warn, not error: load-bearing at the AWS SDK and Neo4j boundaries,
      // where responses are genuinely dynamic. Errors would buy a suppression
      // comment on every boundary.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
    },
  },

  {
    // Nest injects controller and service parameters, so these classes often
    // have no `this` — which is what the rule objects to.
    files: ["apps/api/src/**/*.controller.ts", "apps/api/src/**/*.service.ts"],
    rules: { "@typescript-eslint/no-extraneous-class": "off" },
  },

  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "error",
    },
  },

  {
    // A mock is a deliberate partial implementation, and an `async` signature
    // satisfying an interface is not a missing `await`.
    files: ["**/*.test.ts", "**/*.test.mjs"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },

  // Must stay last: turns off the stylistic rules that fight Prettier.
  prettier,
);
