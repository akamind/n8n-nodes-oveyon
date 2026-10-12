'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const pkg = require('../package.json');
const temporary = mkdtempSync(path.join(tmpdir(), 'oveyon-n8n-pack-'));
try {
	const config = path.join(temporary, 'npmrc');
	writeFileSync(config, '', { mode: 0o600 });
	const args = ['pack', '--dry-run', '--json', '--ignore-scripts', `--userconfig=${config}`];
	const result = process.env.npm_execpath
		? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' })
		: spawnSync('npm', args, { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	const files = JSON.parse(result.stdout)[0].files.map(file => file.path);
	for (const file of files) {
		assert.match(file, /^(?:dist\/|examples\/|README\.md$|LICENSE$|package\.json$)/);
		assert.doesNotMatch(file, /(?:node_modules|\.env|\.npmrc|\.map$|\.test\.)/);
	}
	for (const file of [...pkg.n8n.nodes, ...pkg.n8n.credentials, 'dist/nodes/Oveyon/Oveyon.node.json', 'dist/nodes/Oveyon/OveyonTrigger.node.json', 'dist/nodes/Oveyon/oveyon.svg', 'dist/credentials/icons/oveyon.svg', 'README.md', 'LICENSE']) assert.ok(files.includes(file), `Missing ${file}`);
	assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
	assert.equal(pkg.license, 'MIT');
	console.log(`Package inspection PASS: ${files.length} files, two nodes, two credentials, no runtime dependencies.`);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
