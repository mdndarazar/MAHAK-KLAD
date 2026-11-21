import { createHmac } from 'node:crypto'
/** Only the command signature, fence and transport metadata are authenticated. */
export function approvalEnvelopeMac(key:Uint8Array,storeId:string,epoch:string,id:number,fence:number,signature:string):string {
  return createHmac('sha256',Buffer.from(key)).update(JSON.stringify(['mahak-approval-ipc-v1',storeId,epoch,id,fence,signature])).digest('hex')
}
