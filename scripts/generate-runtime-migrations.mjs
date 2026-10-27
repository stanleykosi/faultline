import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';

const directory = 'packages/database/migrations';
const files = (await fs.readdir(directory)).filter(name => /^\d{4}-[a-z0-9-]+\.sql$/.test(name)).sort();
if (!files.length || !files.every((name, index) => Number(name.slice(0, 4)) === index + 1)) {
  throw new Error('Runtime migration manifest requires a contiguous reviewed migration sequence.');
}
const migrations = [];
for (const file of files) {
  const location = directory + '/' + file, stat = await fs.lstat(location);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Runtime migrations must be regular files.');
  const sql = await fs.readFile(location, 'utf8');
  migrations.push({id: file.slice(0, -4), checksum: createHash('sha256').update(sql).digest('hex'), supabaseChecksum: createHash('sha256').update(sql.replace(/\bauth\b/g, 'faultline_identity')).digest('hex')});
}
await fs.writeFile('packages/database/src/runtime-migrations.ts', '// Generated from reviewed SQL files by scripts/generate-runtime-migrations.mjs.\nexport const runtimeMigrations = ' + JSON.stringify(migrations, null, 2) + ' as const;\n');
console.log('Generated runtime compatibility manifest for ' + migrations.length + ' migrations.');
