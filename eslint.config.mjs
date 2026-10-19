import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "submodules/**",
      "docs/**",
      "**/artifacts/**",
      "**/snapshots/**",
    ],
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      // Existing public and test APIs use explicit any; changing those types is a separate task.
      "@typescript-eslint/no-explicit-any": "off",
      // Provider/filesystem errors are deliberately sanitized; raw causes may expose secrets.
      "preserve-caught-error": "off",
      // Allow mixed mutable declarations and callbacks wired before their value is assigned.
      "prefer-const": ["error", { destructuring: "all", ignoreReadBeforeAssign: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    files: ["**/*.{ts,tsx,js,jsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" },
  },
  prettier,
);
