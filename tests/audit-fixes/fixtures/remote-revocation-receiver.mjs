import { DatabaseSync } from 'node:sqlite'
import { startExperimentalRevocationReceiver } from '../../../src/main/services/cloud/experimentalNetworkRevocation.ts'
const db=new DatabaseSync(process.argv[2])
db.exec('CREATE TABLE IF NOT EXISTS cursor (id INTEGER NOT NULL, kind TEXT NOT NULL, memberId TEXT); CREATE TABLE IF NOT EXISTS nonce (value TEXT PRIMARY KEY)')
const ledger={
  load(){return db.prepare('SELECT id,kind,memberId FROM cursor').get() ?? null},
  hasNonce(nonce){return !!db.prepare('SELECT 1 FROM nonce WHERE value=?').get(nonce)},
  apply(entry){process.send?.({type:'applied',entry})},
  save(entry,nonce){db.exec('BEGIN IMMEDIATE');try{db.exec('DELETE FROM cursor');db.prepare('INSERT INTO cursor VALUES (?,?,?)').run(entry.id,entry.kind,entry.memberId);db.prepare('INSERT INTO nonce VALUES (?)').run(nonce);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}}
}
const receiver=await startExperimentalRevocationReceiver({key:Buffer.alloc(32,7),storeId:'test_store',epoch:'12345678-1234-4123-8123-123456789abc',ledger})
process.send?.({type:'ready',port:receiver.port})
process.on('message',async message=>{if(message==='stop'){await receiver.close();db.close();process.disconnect()}})
