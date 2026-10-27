// Incident fixture: the responsive refactor mistakenly selects only desktop.
const attemptId=new URL(location.href).searchParams.get('attempt_id')??crypto.randomUUID();
window.faultlineAttemptId=attemptId;
const visibleButton=document.querySelector('[data-testid="pay"]');
visibleButton.id=matchMedia('(max-width: 600px)').matches?'pay-mobile':'pay-desktop';
const button=document.querySelector('#pay-desktop');
if(button)button.addEventListener('click',async()=>{
  const response=await fetch('/api/sandbox/order',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({attempt_id:attemptId})});
  const receipt=await response.json();
  document.querySelector('#status').textContent=receipt.completed?'Checkout complete':'Checkout failed';
});
else {
  console.error('PAY_BUTTON_HANDLER_MISSING');
  // Test-only diagnostic telemetry records the actual missing listener; no order is created.
  fetch('/api/sandbox/failure',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({attempt_id:attemptId,error_code:'PAY_BUTTON_HANDLER_MISSING'})});
}
