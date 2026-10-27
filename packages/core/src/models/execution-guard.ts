/** Share a full in-flight authority check between the timer and transport.
 * Checks are never cached after completion. Stop drains locks before publication. */
export function createExecutionGuard(assertCurrent:()=>Promise<void>,onFailure:(reason:unknown)=>void){
 let pending:Promise<void>|undefined,stopped=false,failed=false;
 function check():Promise<void>{
  if(pending)return pending;
  const active=Promise.resolve().then(assertCurrent);pending=active;
  void active.finally(()=>{if(pending===active)pending=undefined;}).catch(()=>{});
  return active;
 }
 function poll(){if(stopped)return;void check().catch(error=>{if(!stopped&&!failed){failed=true;onFailure(error);}});}
 async function stop(){stopped=true;await pending?.catch(()=>{});}
 return {check,poll,stop};
}
