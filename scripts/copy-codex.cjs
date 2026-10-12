'use strict';
const { copyFileSync } = require('node:fs');
const path = require('node:path');

for (const file of ['Oveyon.node.json', 'OveyonTrigger.node.json']) {
	copyFileSync(path.resolve(__dirname, '../nodes/Oveyon', file), path.resolve(__dirname, '../dist/nodes/Oveyon', file));
}
