import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCloudStore } from '../lib/cloud-store.js';
const source=new DatabaseSync('data/studio.sqlite',{readOnly:true});
if(source.prepare("SELECT count(*) AS n FROM posts WHERE status IN ('publishing','scheduled')").get().n)throw new Error('Cancel local schedules and finish/reconcile active publishing before migration.');
const target=await createCloudStore();
for(const table of ['posts','emails','events']){
  const rows=source.prepare('SELECT * FROM '+table).all();
  for(const row of rows){
    // Keep uploads idempotent across interrupted migrations.
    if(table==='posts' && row.image && row.status!=='deleted')await target.directory.write(row.image,await readFile(join('data','images',row.image)));
    const keys=Object.keys(row);
    await target.client.execute({sql:`INSERT OR IGNORE INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,args:keys.map(k=>row[k])});
  }
  console.log('Migrated '+rows.length+' '+table+' records.');
}
source.close();target.db.close();
console.log('Migration complete. Stop local auto-sync/publishing before enabling cloud cron.');
