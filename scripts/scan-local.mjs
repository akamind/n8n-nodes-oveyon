import { analyzePackage, SOURCE_FILE_PATTERNS } from '../node_modules/@n8n/scan-community-package/scanner/scanner.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const [label, patterns] of [
	['source', SOURCE_FILE_PATTERNS],
	['compiled artifact', ['dist/**/*.js', 'package.json']],
]) {
	const result = await analyzePackage(root, patterns);
	console.log(`${label}: ${result.passed ? 'PASS' : 'FAIL'}`);
	if (!result.passed) {
		console.error(result.details ?? result.message);
		process.exitCode = 1;
	}
}
console.log('Local static scan only. Public provenance and repository checks run after publication.');
