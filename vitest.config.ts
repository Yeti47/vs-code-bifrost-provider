import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node'
	},
	resolve: {
		alias: {
			vscode: path.resolve(__dirname, 'test/mocks/vscode.ts')
		}
	}
});
