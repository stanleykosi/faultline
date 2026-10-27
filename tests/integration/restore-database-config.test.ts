import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createIsolatedDatabaseSql} from '../../tools/ops/restore.js';

test('isolated restore creates a database with the signed source encoding and locale', () => {
  assert.equal(
    createIsolatedDatabaseSql('faultline_restore_1791904293614_7389be3d', {encoding: 'UTF8', collation: 'C', ctype: 'C'}),
    'CREATE DATABASE "faultline_restore_1791904293614_7389be3d" TEMPLATE template0 ENCODING \'UTF8\' LC_COLLATE \'C\' LC_CTYPE \'C\''
  );
  assert.match(createIsolatedDatabaseSql('faultline_restore_1791904293614_7389be3d', {encoding: 'WIN1252', collation: 'English_United States.1252', ctype: 'English_United States.1252'}), /LC_COLLATE 'English_United States\.1252'/);
});

test('isolated restore refuses malformed database identities and locale SQL', () => {
  const database = 'faultline_restore_1791904293614_7389be3d';
  const configuration = {encoding: 'UTF8', collation: 'C', ctype: 'C'};
  for (const name of ['faultline', 'faultline_restore_1_bad', 'faultline_restore_1791904293614_7389be3d; DROP DATABASE faultline']) {
    assert.throws(() => createIsolatedDatabaseSql(name, configuration));
  }
  for (const locale of ["C'; DROP DATABASE faultline; --", 'C\\u0000']) {
    assert.throws(() => createIsolatedDatabaseSql(database, {...configuration, collation: locale}));
  }
});
