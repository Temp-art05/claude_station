import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "data/**", "server/drizzle/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // TypeScript already resolves globals; core no-undef only produces noise here.
    files: ["**/*.{ts,tsx,mjs}"],
    rules: { "no-undef": "off" },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    rules: {
      // Deliberate: SDK messages are `unknown` by design and get narrowed at use.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
