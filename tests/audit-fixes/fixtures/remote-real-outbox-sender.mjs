import { DatabaseSync } from 'node:sqlite'
import { createHubIdentity } from '../../../src/main/services/cloud/hubIdentity.ts'
import { drainNetworkRevocations } from '../../../src/main/services/cloud/inProcessRevocationBridge.ts'
const db=new DatabaseSync(process.argv[2]),identity=createHubIdentity(db,{panels:['sales'],approvalPanels:['sales']})
identity.bootstrap('owner','owner-test-password','746392')
const login=identity.login('owner','owner-test-password')
process.on('message',async message=>{
  try {
    if(message.type==='send') {
      if(!identity.setPaused(login.token,'746392',true)) throw new Error('pause failed')
      const before=identity.pendingRevocations().length
      const result=await drainNetworkRevocations(identity,{key:Buffer.alloc(32,7),storeId:'test_store',epoch:'12345678-1234-4123-8123-123456789abc',port:message.port})
      process.send({type:'done',before,result,pending:identity.pendingRevocations().length,cursor:identity.networkRevocationCursor('12345678-1234-4123-8123-123456789abc')})
    } else if(message.type==='stop') {db.close();process.disconnect()}
  } catch(e) {process.send({type:'error',message:e.message})}
})
process.send({type:'ready'})
