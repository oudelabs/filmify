'use strict';
function filmifyYield() {
  return new Promise(resolve => {
    if (!document.hidden) { setTimeout(resolve,0); return; }
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
