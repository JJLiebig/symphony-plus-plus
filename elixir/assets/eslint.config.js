import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

const sourceFileGlobs = ["**/*.{js,jsx,ts,tsx}"];
const testFileGlobs = [
  "**/*.{test,spec}.{js,jsx,ts,tsx}",
  "**/*_test.{js,jsx,ts,tsx}",
  "**/__tests__/**/*.{js,jsx,ts,tsx}",
];

const productionCodeQualityRules = {
  complexity: ["error", 12],
  "max-lines": ["error", { max: 600 }],
};

const testCodeQualityRules = {
  complexity: ["error", 16],
  "max-lines": ["error", { max: 900 }],
};

export default tseslint.config(
  {
    ignores: ["dist", "node_modules", "../priv/static"],
  },
  {
    files: sourceFileGlobs,
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      sourceType: "module",
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: sourceFileGlobs,
    rules: productionCodeQualityRules,
  },
  {
    files: testFileGlobs,
    rules: testCodeQualityRules,
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs["recommended-latest"].rules,
      "react-hooks/refs": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-refresh/only-export-components": "off",
    },
  },
);
