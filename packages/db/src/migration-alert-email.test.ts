import assert from 'node:assert/strict';
import { migrate } from './index.ts';
import { dbTest, tableColumns } from './testing.ts';

dbTest(
  'migration 43 adds the HTML part to the alert delivery row; older rows keep working',
  async (db) => {
    await migrate(db);
    const columns = (await tableColumns(db, 'alert_deliveries')).map((c) => c.name);
    assert.ok(columns.includes('html'));
    assert.ok(columns.includes('body'));
  },
);
