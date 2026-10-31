'use strict';
// MessageChannel schedules a real task without the nested-timer minimum.
// Each caller owns one cancelable callback; release can remove it immediately.
const filmifyScheduleTask=(()=>{
  if(typeof MessageChannel==='undefined')return callback=>{const timer=setTimeout(callback,0);return ()=>clearTimeout(timer);};
  const channel=new MessageChannel(),pending=new Map();let next=0;
  channel.port1.onmessage=event=>{const callback=pending.get(event.data);if(callback){pending.delete(event.data);callback();}};
  return callback=>{const id=++next;pending.set(id,callback);channel.port2.postMessage(id);return ()=>pending.delete(id);};
})();
function filmifyYield() {
  return new Promise(resolve => {
    if (!document.hidden) { filmifyScheduleTask(resolve); return; }
    const resume = () => { if (!document.hidden) { document.removeEventListener('visibilitychange',resume); resolve(); } };
    document.addEventListener('visibilitychange',resume);
  });
}
// Cooperative CPU work: bounded chunks preserve the exact arithmetic order,
// yielding between chunks so paint/input can run, including on slow devices.
async function filmifyRunSteps(steps,cancelled) {
  let deadline=performance.now()+6;
  for (;;) {
    if (cancelled&&cancelled()) throw new Error('已取消');
    const step=steps.next();
    if (step.done) return step.value;
    if (performance.now()>=deadline) {
      await filmifyYield();
      deadline=performance.now()+6;
    }
  }
}
