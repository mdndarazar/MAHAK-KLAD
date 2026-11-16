import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { sendExperimentalRevocation } from '../../src/main/services/cloud/experimentalNetworkRevocation.ts'

test('sender rejects forged ACK from another process or listener',async()=>{
  const server=createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:1,signature:'0'.repeat(64),mac:'0'.repeat(64)}))})})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  try {
    await assert.rejects(sendExperimentalRevocation({key:Buffer.alloc(32,7),storeId:'test_store',epoch:'12345678-1234-4123-8123-123456789abc',port:server.address().port,prev:0,event:{id:1,kind:'ALL',memberId:null}}),/Invalid acknowledgement/)
  } finally {await new Promise(resolve=>server.close(resolve))}
})
