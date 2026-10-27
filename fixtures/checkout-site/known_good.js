// Known-good fixture: attach handler to the visible checkout button.
const attemptId=new URL(location.href).searchParams.get('attempt_id')??crypto.randomUUID();
window.faultlineAttemptId=attemptId;
const visibleButton=document.querySelector('[data-testid="pay"]');
visibleButton.id=matchMedia('(max-width: 600px)').matches?'pay-mobile':'pay-desktop';
const button=document.querySelector('[data-testid="pay"]');
button.addEventListener('click',async()=>{
  const response=await fetch('/api/sandbox/order',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({attempt_id:attemptId})});
  const receipt=await response.json();
  document.querySelector('#status').textContent=receipt.completed?'Checkout complete':'Checkout failed';
});
