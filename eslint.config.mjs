import obsidian from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default [
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
		},
		plugins: { obsidianmd: obsidian, "@typescript-eslint": tseslint.plugin },
		rules: {
			"obsidianmd/no-unsupported-api": "error",
			"obsidianmd/no-global-this": "error",
			"obsidianmd/prefer-window-timers": "error",
			"obsidianmd/prefer-create-el": "error",
			"@typescript-eslint/only-throw-error": "error",
			"@typescript-eslint/no-unsafe-return": "error",
		},
	},
];
