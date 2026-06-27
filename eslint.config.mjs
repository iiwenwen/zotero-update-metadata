// @ts-check Let TS check this config file.

import zotero from "@zotero-plugin/eslint-config";

export default [
  {
    ignores: ["build/**", "logs/**", "dist/**", "node_modules/**", "**/*.bak"],
  },
  ...zotero({
    overrides: [
      {
        files: ["**/*.ts"],
        rules: {
          "@typescript-eslint/ban-ts-comment": [
            "warn",
            {
              "ts-expect-error": "allow-with-description",
              "ts-ignore": "allow-with-description",
              "ts-nocheck": "allow-with-description",
              "ts-check": "allow-with-description",
            },
          ],
          "@typescript-eslint/no-unused-vars": "off",
          "@typescript-eslint/no-explicit-any": "off",
          "@typescript-eslint/no-non-null-assertion": "off",
        },
      },
      {
        files: ["scripts/**/*.mjs"],
        languageOptions: {
          globals: {
            console: "readonly",
          },
        },
      },
    ],
  }),
];
