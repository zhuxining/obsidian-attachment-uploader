import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    sortImports: true,
    sortTailwindcss: true,
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
    plugins: ["react", "import", "promise", "vitest", "node"],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  run: {
    tasks: {
      ci: "tsc -noEmit -skipLibCheck && node --no-warnings esbuild.config.mjs production",
    },
  },
});
