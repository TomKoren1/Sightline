/**
 * Lint rules, as a flat config.
 *
 * `npm run lint` used to be Prettier alone, which checks that the code is
 * *formatted* and nothing about whether it is *correct*. That left a strict
 * TypeScript monorepo with no linter at all: a floating promise, an unawaited
 * database write, or a `catch` that swallows an error would all pass review and
 * all pass CI. Those are the bugs that cost real time here - engineering log
 * #41 was a missing `await`, found by reading, not by a tool.
 *
 * Type-aware rules are on. They are the reason to bother: the rules that find
 * the mistakes above cannot work from syntax alone, they need to know that the
 * expression is a Promise. The cost is that every linted file must belong to
 * one of the projects listed below, which is also why `tsconfig.tools.json`
 * exists.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    // Build output, vendored code, and the one generated directory. Prettier
    // ignores the same set; see `.prettierignore` for why the Drizzle metadata
    // and the CloudFormation templates are left alone.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "apps/api/drizzle/meta/**",
      // The script that renders the handover PDFs. CommonJS, run by hand, and
      // belongs to no tsconfig - linting it would mean a project just for it.
      "docs/handover/render.cjs",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Every tsconfig in the repository. A file outside all of them is a
        // lint error rather than a silently unlinted file, which is the
        // failure mode this is guarding against in the first place.
        project: ["./apps/*/tsconfig.json", "./packages/*/tsconfig.json", "./tsconfig.tools.json"],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      /**
       * Unused variables are an error, with the conventional underscore escape.
       *
       * `argsIgnorePattern` matters for Express-shaped handlers, where the
       * signature is positional and an unused `next` is not a mistake.
       */
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      /**
       * Off: bracket notation on a dynamic bag is deliberate here.
       *
       * The rule cannot tell `properties["publiclyAccessible"]` - a key read
       * out of an AWS response bag typed `Record<string, unknown>` - from a
       * real property access. With `noUncheckedIndexedAccess` on, brackets are
       * the form that says "this key may not be there", which is the thing
       * worth saying. 106 of the first run's 213 errors were this, and every
       * one of them was an index signature.
       */
      "@typescript-eslint/dot-notation": "off",

      /**
       * `??` is preferred, except over a string, where `||` is usually the point.
       *
       * Every string case flagged here was a deliberate fallback chain:
       * `e.stderr || e.message || ""` wants an *empty* stderr to fall through
       * to the message, and `??` would keep the empty string and hide the only
       * text there was. ENOENT carries exactly that shape, which is the most
       * likely first failure of the setup script.
       */
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: true } },
      ],

      /**
       * A thrown non-Error loses the stack, and `catch` blocks here all read
       * `err.message`. Both halves are worth enforcing.
       */
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "error",

      /**
       * Warn, not error, on the `any` escapes.
       *
       * They are load-bearing at the AWS SDK and Neo4j boundaries, where the
       * response types are either enormous unions or genuinely dynamic. Making
       * these errors would mean either a suppression comment on every boundary
       * or a dishonest cast, and neither is an improvement. A warning keeps
       * them visible without making the gate meaningless.
       */
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
    },
  },

  {
    // Decorator-heavy Nest classes. A controller method's parameters are
    // injected by the decorators, so the class itself frequently has no
    // `this` - which is exactly what this rule objects to.
    files: ["apps/api/src/**/*.controller.ts", "apps/api/src/**/*.service.ts"],
    rules: { "@typescript-eslint/no-extraneous-class": "off" },
  },

  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // A stale closure over `scanning` was a real bug in the scan button;
      // this is the rule that would have caught it.
      "react-hooks/exhaustive-deps": "error",
    },
  },

  {
    /**
     * Tests may do things production code may not.
     *
     * A mock is a deliberate partial implementation, so asserting its shape is
     * the point rather than a smell - see the `MockLanguageModelV4` in
     * `agent/ledger.test.ts`, which implements only what the loop calls.
     */
    files: ["**/*.test.ts", "**/*.test.mjs"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-function": "off",
      /**
       * An `async` method with no `await` is honest in a mock: the interface it
       * stands in for returns a promise, so the signature has to match even
       * when the body resolves immediately.
       */
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },

  // Must stay last: it turns off the stylistic rules that would fight Prettier.
  prettier,
);
